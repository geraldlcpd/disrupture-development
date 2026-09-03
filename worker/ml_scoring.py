"""
Batch ML inference for the ingestion worker.

Runs after each rule-based scoring cycle, precomputes zone risk and open-alert
resolution predictions, and writes results to ml_prediction_cache so Vercel
(and the backend in local dev) can serve them without running sklearn.

Reuses ml-service feature engineering and model classes; models are read from
frontend/api/ml_models/ (same artifacts committed by the training workflow).
"""
from __future__ import annotations

import json
import logging
import socket
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import text

from worker.config import DATABASE_URL, ML_MODELS_DIR, ML_SCORING_ENABLED

logger = logging.getLogger("worker.ml_scoring")

REPO_ROOT = Path(__file__).resolve().parent.parent
ML_SERVICE_DIR = REPO_ROOT / "ml-service"

# Match frontend/api/_cache_helpers.py — worker refreshes every ~15 min.
CACHE_TTL_SECONDS = 900

_risk_predictor = None
_resolution_predictor = None
_ml_service_configured = False


def _resolve_models_dir() -> Path:
    models_dir = Path(ML_MODELS_DIR)
    if not models_dir.is_absolute():
        models_dir = (REPO_ROOT / models_dir).resolve()
    return models_dir


def _configure_ml_service() -> None:
    """Point ml-service at worker DATABASE_URL and bundled model artifacts."""
    global _ml_service_configured
    if _ml_service_configured:
        return

    if str(ML_SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(ML_SERVICE_DIR))

    import config as ml_config  # noqa: WPS433 — ml-service on sys.path

    models_dir = _resolve_models_dir()
    ml_config.DATABASE_URL = DATABASE_URL
    ml_config.MODEL_DIR = models_dir
    ml_config.MODEL_PATH = models_dir / "risk_predictor.joblib"
    ml_config.RESOLUTION_MODEL_PATH = models_dir / "resolution_predictor.joblib"

    _ml_service_configured = True


def _get_risk_predictor():
    global _risk_predictor
    _configure_ml_service()
    import config as ml_config
    from model import RiskPredictor

    if _risk_predictor is None:
        if not ml_config.MODEL_PATH.exists():
            raise FileNotFoundError(f"Risk model not found at {ml_config.MODEL_PATH}")
        _risk_predictor = RiskPredictor.load(ml_config.MODEL_PATH)
    return _risk_predictor


def _get_resolution_predictor():
    global _resolution_predictor
    _configure_ml_service()
    import config as ml_config
    from resolution_model import ResolutionPredictor

    if _resolution_predictor is None:
        if not ml_config.RESOLUTION_MODEL_PATH.exists():
            raise FileNotFoundError(
                f"Resolution model not found at {ml_config.RESOLUTION_MODEL_PATH}"
            )
        _resolution_predictor = ResolutionPredictor.load(ml_config.RESOLUTION_MODEL_PATH)
    return _resolution_predictor


def _set_cached(db, cache_key: str, result: dict) -> None:
    """Upsert one prediction row; failures must not break the scoring cycle."""
    to_store = {k: v for k, v in result.items() if k != "_cache_hit"}
    try:
        db.execute(
            text(
                """INSERT INTO ml_prediction_cache (cache_key, result_json, computed_at)
                   VALUES (:key, :payload, now())
                   ON CONFLICT (cache_key) DO UPDATE
                   SET result_json = EXCLUDED.result_json,
                       computed_at = EXCLUDED.computed_at"""
            ),
            {"key": cache_key, "payload": json.dumps(to_store, default=str)},
        )
        db.commit()
    except Exception as e:
        logger.warning("[ML] Cache write failed for %s: %s", cache_key, e)
        try:
            db.rollback()
        except Exception:
            pass


def run_ml_batch_scoring(db) -> dict:
    """
    Batch-predict all zones and open alerts; write results to ml_prediction_cache.

    Returns a summary dict with counts and elapsed seconds.
    """
    if not ML_SCORING_ENABLED:
        logger.info("[ML] Batch scoring skipped (ML_SCORING_ENABLED=false)")
        return {"skipped": True, "reason": "ML_SCORING_ENABLED=false"}

    started = time.perf_counter()
    logger.info("[ML] Batch scoring starting...")

    models_dir = _resolve_models_dir()
    risk_path = models_dir / "risk_predictor.joblib"
    resolution_path = models_dir / "resolution_predictor.joblib"
    if not risk_path.exists() and not resolution_path.exists():
        logger.warning(
            "[ML] No model artifacts in %s — skipping batch scoring", models_dir
        )
        return {"skipped": True, "reason": "no_models"}

    _configure_ml_service()
    from features import build_live_features
    from resolution_features import build_live_features_for_alert

    zone_rows = db.execute(text("SELECT zone_id FROM zones ORDER BY zone_id")).fetchall()
    zone_ids = [row[0] for row in zone_rows]

    alert_rows = db.execute(
        text(
            "SELECT alert_id FROM risk_alerts WHERE resolved_at IS NULL ORDER BY alert_id"
        )
    ).fetchall()
    alert_ids = [row[0] for row in alert_rows]

    zones_ok = zones_skipped = 0
    alerts_ok = alerts_skipped = 0
    hostname = socket.gethostname()

    risk_predictor = None
    if risk_path.exists():
        try:
            risk_predictor = _get_risk_predictor()
            logger.info("[ML] Loaded risk model from %s", risk_path)
        except Exception as e:
            logger.warning("[ML] Could not load risk model: %s", e)
    else:
        logger.warning("[ML] Risk model missing at %s — zone predictions skipped", risk_path)

    resolution_predictor = None
    if resolution_path.exists():
        try:
            resolution_predictor = _get_resolution_predictor()
            logger.info("[ML] Loaded resolution model from %s", resolution_path)
        except Exception as e:
            logger.warning("[ML] Could not load resolution model: %s", e)
    else:
        logger.warning(
            "[ML] Resolution model missing at %s — alert predictions skipped", resolution_path
        )

    for zone_id in zone_ids:
        if risk_predictor is None:
            zones_skipped += 1
            continue
        try:
            features = build_live_features(zone_id)
            result = risk_predictor.predict(features)
            result["zone_id"] = zone_id
            result["_source"] = "worker"
            result["_computed_by"] = hostname
            _set_cached(db, f"zone:{zone_id}", result)
            zones_ok += 1
        except Exception as e:
            zones_skipped += 1
            logger.debug("[ML] Zone %s prediction failed: %s", zone_id, e)

    now = datetime.now(timezone.utc)
    for alert_id in alert_ids:
        if resolution_predictor is None:
            alerts_skipped += 1
            continue
        try:
            features = build_live_features_for_alert(alert_id)
            result = resolution_predictor.predict(features)
            result["alert_id"] = alert_id
            result["estimated_resolution_at"] = (
                now + timedelta(hours=result["hours_remaining_median"])
            ).isoformat()
            result["_source"] = "worker"
            result["_computed_by"] = hostname
            _set_cached(db, f"resolution:{alert_id}", result)
            alerts_ok += 1
        except Exception as e:
            alerts_skipped += 1
            logger.debug("[ML] Alert %s prediction failed: %s", alert_id, e)

    elapsed = round(time.perf_counter() - started, 2)
    logger.info(
        "[ML] Batch scoring complete: %d zones (%d skipped), %d alerts (%d skipped) in %.2fs",
        zones_ok,
        zones_skipped,
        alerts_ok,
        alerts_skipped,
        elapsed,
    )
    return {
        "zones_ok": zones_ok,
        "zones_skipped": zones_skipped,
        "alerts_ok": alerts_ok,
        "alerts_skipped": alerts_skipped,
        "elapsed_seconds": elapsed,
    }


def main() -> None:
    """ML-only entry point for launch_service/run_ml_cycle.bat."""
    from worker.main import wait_for_db_ready
    from worker.database import get_db_session

    wait_for_db_ready()
    db = get_db_session()
    try:
        summary = run_ml_batch_scoring(db)
        print(f"[ML] Done: {summary}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
