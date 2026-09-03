"""
Ingestion Worker — HTTP-triggered Edition
==========================================
Replaces the old always-on `APScheduler.BlockingScheduler` loop (worker/main.py)
with thin HTTP endpoints that run a single ingestion job per call.

Why: free-tier hosts (Render, Cloud Run, etc.) don't let you run an infinite
background process for free — but they're happy to handle a short HTTP
request. An external scheduler (GitHub Actions cron) hits these endpoints
every 15-30 minutes instead of an in-process loop hitting them itself.

Each endpoint is protected by a shared secret (CRON_SECRET) so randos on the
internet can't trigger your ingestion jobs / burn your TomTom API quota.

Local/manual use is unaffected — `worker/main.py` (the BlockingScheduler
version) still works exactly as before if you ever want to run this as one
continuous process (e.g. on a VM).
"""

import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException

load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env", override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("worker.app")

CRON_SECRET = os.getenv("CRON_SECRET", "")
if not CRON_SECRET:
    logger.warning(
        "CRON_SECRET is not set — ingestion endpoints will be UNPROTECTED. "
        "Set CRON_SECRET in worker/.env (local) and in your host's env vars (production)."
    )

# Reuse the existing job implementations untouched.
from worker.main import IngestionWorker, wait_for_db_ready  # noqa: E402

app = FastAPI(title="DIS-RUPTURE Ingestion Worker (HTTP-triggered)")

_worker: IngestionWorker | None = None


@app.on_event("startup")
def _startup():
    global _worker
    wait_for_db_ready()
    _worker = IngestionWorker()
    logger.info("Worker ready. Waiting for scheduled HTTP triggers.")


def _check_secret(x_cron_secret: str | None):
    if CRON_SECRET and x_cron_secret != CRON_SECRET:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Cron-Secret header")


@app.get("/health")
def health():
    """Unauthenticated — used for host health checks / keep-alive pings."""
    return {"status": "ok"}


def _run(job_name: str, fn, x_cron_secret: str | None):
    _check_secret(x_cron_secret)
    if _worker is None:
        raise HTTPException(status_code=503, detail="Worker not initialized yet")
    try:
        fn()
        return {"status": "ok", "job": job_name}
    except Exception as e:
        logger.exception(f"[{job_name}] failed")
        raise HTTPException(status_code=500, detail=f"{job_name} failed: {e}")


@app.post("/run/traffic")
def run_traffic(x_cron_secret: str | None = Header(default=None)):
    return _run("traffic_ingestion", _worker.run_traffic_ingestion, x_cron_secret)


@app.post("/run/weather")
def run_weather(x_cron_secret: str | None = Header(default=None)):
    return _run("weather_ingestion", _worker.run_weather_ingestion, x_cron_secret)


@app.post("/run/crowd")
def run_crowd(x_cron_secret: str | None = Header(default=None)):
    return _run("crowd_ingestion", _worker.run_crowd_ingestion, x_cron_secret)


@app.post("/run/earthquake")
def run_earthquake(x_cron_secret: str | None = Header(default=None)):
    return _run("earthquake_ingestion", _worker.run_earthquake_ingestion, x_cron_secret)


@app.post("/run/waterway-telemetry")
def run_waterway_telemetry(x_cron_secret: str | None = Header(default=None)):
    return _run(
        "waterway_telemetry", _worker.run_waterway_telemetry_ingestion, x_cron_secret
    )


@app.post("/run/scoring")
def run_scoring(x_cron_secret: str | None = Header(default=None)):
    return _run("scoring_cycle", _worker.run_scoring_cycle, x_cron_secret)


@app.post("/run/ml-scoring")
def run_ml_scoring(x_cron_secret: str | None = Header(default=None)):
    """ML-only batch scoring — skips ingestion; useful for manual cache refresh."""
    _check_secret(x_cron_secret)
    if _worker is None:
        raise HTTPException(status_code=503, detail="Worker not initialized yet")
    from worker.database import get_db_session
    from worker.ml_scoring import run_ml_batch_scoring

    db = get_db_session()
    try:
        summary = run_ml_batch_scoring(db)
        return {"status": "ok", "job": "ml_scoring", **summary}
    except Exception as e:
        logger.exception("[ml_scoring] failed")
        raise HTTPException(status_code=500, detail=f"ml_scoring failed: {e}") from e
    finally:
        db.close()


@app.post("/run/all")
def run_all(x_cron_secret: str | None = Header(default=None)):
    """Convenience: runs the full sweep in one call (used for manual testing)."""
    return _run("execute_all", _worker.execute_all, x_cron_secret)
