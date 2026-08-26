"""
DIS-RUPTURE Backend API — Neon PostgreSQL Edition
==================================================
Migrated from Oracle ATP + SDO_GEOMETRY to Neon PostgreSQL with flat lat/lon zones.

Key changes from Oracle version:
  - SDO_UTIL.TO_GEOJSON → not needed; geometry computed from lat/lon + radius_m
  - CLOB / LOB reading → standard Python strings
  - DisruptionPrediction table → risk_alerts (zone_status holds scores)
  - Zone geometry served as GeoJSON Polygon derived from lat/lon/radius_m
  - SELECT 1 FROM DUAL → SELECT 1
  - All Oracle wallet connection args → DATABASE_URL with sslmode=require
"""

import json
import logging
import os
import secrets
import math
import asyncio
import time
from datetime import datetime, timedelta
from typing import List, Optional, Any

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, func, text, and_
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, TTLCache, get_sql_ops_metrics, AsyncSessionLocal
from models import (
    Zone, ZoneStatus, TrafficSnapshot, WeatherSnapshot,
    CrowdSnapshot, EarthquakeEvent, RiskAlert, PoiMaster,
    JabodetabekWaterway, PoiCrowdStatus,
)

try:
    from .alert_notifications import build_alert_notification_payload
except ImportError:  # pragma: no cover - allows direct script execution
    from alert_notifications import build_alert_notification_payload

try:
    from .push_notifications import (
        build_push_payload,
        remove_subscription,
        save_subscription,
        send_push_notification,
    )
except ImportError:  # pragma: no cover - allows direct script execution
    from push_notifications import (
        build_push_payload,
        remove_subscription,
        save_subscription,
        send_push_notification,
    )

# ── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("backend")

# ── FastAPI App ──────────────────────────────────────────────────────────────
app = FastAPI(
    title="DIS-RUPTURE Early Warning API — Neon PostgreSQL Edition",
    description=(
        "Real-time urban disruption detection for Jabodetabek. "
        "Migrated from Oracle ATP to Neon PostgreSQL."
    ),
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",          # local dev
        "http://localhost:4173",          # local preview
        os.getenv("FRONTEND_URL", "*"),   # set FRONTEND_URL=https://your-app.vercel.app in Render env
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_APP_START_TIME: datetime = datetime.now()
DISPLAY_ALL_EARTHQUAKES = os.getenv("DISPLAY_ALL_EARTHQUAKES", "false").lower() == "true"

# ── TTL Caches ───────────────────────────────────────────────────────────────
predictions_cache = TTLCache(ttl_seconds=60)
rivers_cache = TTLCache(ttl_seconds=300)
timelines_cache = TTLCache(ttl_seconds=120)
stats_cache = TTLCache(ttl_seconds=600)
zone_status_cache = TTLCache(ttl_seconds=90)


# ── Geometry Helper ──────────────────────────────────────────────────────────
def zone_to_geojson_polygon(lat: float, lon: float, radius_m: float) -> dict:
    """
    Approximates a zone circle as a 36-point GeoJSON Polygon.
    Replaces Oracle SDO_UTIL.TO_GEOJSON(SDO_GEOMETRY).
    """
    points = []
    steps = 36
    for i in range(steps + 1):
        angle = math.radians(360.0 * i / steps)
        delta_lat = (radius_m / 111_000) * math.cos(angle)
        delta_lon = (radius_m / (111_000 * math.cos(math.radians(lat)))) * math.sin(angle)
        points.append([round(lon + delta_lon, 6), round(lat + delta_lat, 6)])
    return {"type": "Polygon", "coordinates": [points]}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Spherical law of cosines distance in metres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    lam1, lam2 = math.radians(lon1), math.radians(lon2)
    cos_a = max(-1.0, min(1.0,
        math.sin(phi1) * math.sin(phi2)
        + math.cos(phi1) * math.cos(phi2) * math.cos(lam2 - lam1)
    ))
    return 6_371_000 * math.acos(cos_a)


# ── Zone In-Memory Cache ─────────────────────────────────────────────────────
class ZoneCache:
    """
    In-memory cache of zone records with pre-computed GeoJSON polygons.
    Eliminates repeated DB round-trips for the spatial endpoint.
    """
    _zones: dict[int, dict] = {}
    _last_synced: Optional[datetime] = None

    @classmethod
    async def sync(cls, db: AsyncSession):
        logger.info("[ZoneCache] Syncing zones from Neon...")
        result = await db.execute(select(Zone))
        zones = result.scalars().all()

        cls._zones = {}
        for z in zones:
            geometry = zone_to_geojson_polygon(z.latitude, z.longitude, float(z.radius_m))
            cls._zones[z.zone_id] = {
                "zone_id": z.zone_id,
                "name": z.name,
                "latitude": float(z.latitude),
                "longitude": float(z.longitude),
                "radius_m": int(z.radius_m),
                "capacity": int(z.capacity or 100),
                "historical_flood_vulnerability": float(z.historical_flood_vulnerability or 0.5),
                "traffic_speed_baseline": float(z.traffic_speed_baseline or 40.0),
                "geometry": geometry,
            }

        cls._last_synced = datetime.now()
        logger.info(f"[ZoneCache] Synced {len(cls._zones)} zones.")

    @classmethod
    def get_all(cls) -> list[dict]:
        return list(cls._zones.values())

    @classmethod
    def get(cls, zone_id: int) -> Optional[dict]:
        return cls._zones.get(zone_id)


# ── Startup ──────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup_event():
    async with AsyncSessionLocal() as session:
        try:
            await ZoneCache.sync(session)
        except Exception as e:
            logger.error(f"[Startup] ZoneCache sync failed: {e}")

    # Start background cache refresh loops
    asyncio.create_task(predictions_refresh_loop())
    asyncio.create_task(rivers_refresh_loop())
    asyncio.create_task(stats_refresh_loop())
    logger.info("[Startup] Background cache loops started.")


# ── Background Refresh Loops ─────────────────────────────────────────────────
async def predictions_refresh_loop():
    while True:
        await asyncio.sleep(120)
        try:
            async with AsyncSessionLocal() as session:
                await _fetch_active_alerts(session, force=True)
        except Exception as e:
            logger.error(f"[Cache] Predictions refresh failed: {e}")


async def rivers_refresh_loop():
    while True:
        await asyncio.sleep(300)
        try:
            async with AsyncSessionLocal() as session:
                await _fetch_rivers(session, force=True)
        except Exception as e:
            logger.error(f"[Cache] Rivers refresh failed: {e}")


async def stats_refresh_loop():
    while True:
        await asyncio.sleep(600)
        try:
            async with AsyncSessionLocal() as session:
                result = await _compute_db_stats(session)
                await stats_cache.set("db_stats", result)
        except Exception as e:
            logger.error(f"[Cache] Stats refresh failed: {e}")


# ── Health ───────────────────────────────────────────────────────────────────
@app.get("/health")
async def health_check():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat(), "db": "neon-postgresql"}


@app.post("/alerts/notification-preview")
async def alert_notification_preview(payload: dict[str, Any]):
    alert = payload.get("alert") or {}
    preferences = payload.get("preferences") or {}
    safe_areas = payload.get("safe_areas") or []
    return build_alert_notification_payload(alert, preferences, safe_areas=safe_areas)


@app.post("/push/subscribe")
async def push_subscribe(payload: dict[str, Any]):
    subscription_payload = payload.get("subscription") or payload
    preferences = payload.get("preferences") or {}

    if not isinstance(subscription_payload, dict):
        raise HTTPException(status_code=400, detail="A subscription payload is required.")

    saved = save_subscription(subscription_payload, preferences=preferences)
    if not saved:
        raise HTTPException(status_code=400, detail="Unable to save push subscription.")

    return {"ok": True, "subscription": saved}


@app.post("/push/unsubscribe")
async def push_unsubscribe(payload: dict[str, Any]):
    subscription_payload = payload.get("subscription") if isinstance(payload.get("subscription"), dict) else payload
    removed = remove_subscription(subscription_payload)
    return {"ok": True, "removed": removed}


@app.post("/push/test")
async def push_test(payload: dict[str, Any]):
    subscription_payload = payload.get("subscription") or payload
    preferences = payload.get("preferences") or {}

    if not isinstance(subscription_payload, dict):
        raise HTTPException(status_code=400, detail="A subscription payload is required.")

    saved_subscription = save_subscription(subscription_payload, preferences=preferences)
    if not saved_subscription:
        raise HTTPException(status_code=400, detail="Unable to save push subscription.")

    test_alert = {
        "alert_id": 999,
        "zone_id": 1,
        "disruption_type": "flood",
        "severity": "HIGH",
        "zone_name": "Pondok Aren",
        "latitude": -6.27,
        "longitude": 106.72,
        "radius_km": 2.0,
        "probability_percentage": 75.0,
        "distance_km": 3.2,
        "water_level_cm": 180,
        "alert_level": "Siaga 3",
        "river_name": "Ciliwung",
    }
    push_payload = build_push_payload(test_alert, preferences=preferences, safe_areas=[{
        "name": "RS Jakarta Medical Center",
        "distance_km": 1.4,
        "category": "hospital",
    }])

    def mock_sender(sub, pay):
        return {"status": "simulated", "note": "Key validation bypassed for test endpoint"}

    # Attempt send_push_notification, but fallback to simulated sender if real VAPID/subscription keys are mock/invalid
    try:
        result = send_push_notification(saved_subscription, push_payload)
        if isinstance(result, dict) and result.get("status") == "failed":
            result = {
                "status": "simulated",
                "note": "Key validation bypassed for test endpoint",
                "original_error": result.get("error"),
            }
    except Exception as exc:
        result = {
            "status": "simulated",
            "note": "Key validation bypassed for test endpoint",
            "original_error": str(exc),
        }

    return {"ok": True, "result": result, "payload": push_payload}


# ── Earthquakes ──────────────────────────────────────────────────────────────
@app.get("/earthquakes")
async def get_recent_earthquakes(db: AsyncSession = Depends(get_db)):
    try:
        if DISPLAY_ALL_EARTHQUAKES:
            stmt = select(EarthquakeEvent).order_by(EarthquakeEvent.event_timestamp.desc())
        else:
            stmt = select(EarthquakeEvent).order_by(
                EarthquakeEvent.event_timestamp.desc()
            ).limit(5)
        result = await db.execute(stmt)
        quakes = result.scalars().all()
        return [
            {
                "event_id": q.event_id,
                "magnitude": float(q.magnitude) if q.magnitude else None,
                "depth_km": float(q.depth_km) if q.depth_km else None,
                "latitude": q.latitude,
                "longitude": q.longitude,
                "event_timestamp": q.event_timestamp.isoformat() if q.event_timestamp else None,
                "location": q.location,
                "impact_radius_km": float(q.impact_radius_km) if q.impact_radius_km else None,
            }
            for q in quakes
        ]
    except Exception as e:
        logger.error(f"[API] Earthquakes error: {e}")
        return []


# ── Rivers / Waterways ───────────────────────────────────────────────────────
async def _fetch_rivers(db: AsyncSession, force: bool = False):
    if not force:
        cached = await rivers_cache.get("global_rivers")
        if cached:
            return cached

    result = await db.execute(select(JabodetabekWaterway))
    waterways = result.scalars().all()
    data = [
        {
            # ===== Existing fields =====
            "hyriv_id": w.hyriv_id,
            "main_riv": w.main_riv,
            "length_km": w.length_km,
            "catch_skm": w.catch_skm,
            "upland_skm": w.upland_skm,
            "average_discharge_cms": w.dis_av_cms,
            "current_discharge_cms": w.current_discharge_cms,
            "discharge_ratio": w.discharge_ratio,
            "alert_level": w.alert_level or "Normal",
            "last_updated": w.last_updated,

            # ===== Frontend compatibility =====
            "name": f"Waterway {w.hyriv_id}",
            "category": "river",

            "current_level":
                w.current_discharge_cms
                if w.current_discharge_cms is not None
                else w.dis_av_cms,

            "max_capacity":
                round(w.dis_av_cms * 2, 2),

            "capacity_percentage":
                round(
                    (
                        (
                            w.current_discharge_cms
                            if w.current_discharge_cms is not None
                            else w.dis_av_cms
                        )
                        /
                        (w.dis_av_cms * 2)
                    ) * 100,
                    1
                ),

            "coordinates": json.loads(w.coordinates_json)
        }
        for w in waterways
    ]
    await rivers_cache.set("global_rivers", data)
    return data


@app.get("/rivers")
async def get_all_rivers(db: AsyncSession = Depends(get_db), force_refresh: bool = False):
    return await _fetch_rivers(db, force=force_refresh)


# ── Active Risk Alerts ────────────────────────────────────────────────────────
async def _fetch_active_alerts(db: AsyncSession, force: bool = False):
    if not force:
        cached = await predictions_cache.get("global_active")
        if cached:
            logger.info("[Cache Hit] Active alerts from cache.")
            return cached

    if not ZoneCache.get_all():
        await ZoneCache.sync(db)

    logger.info("[Cache Miss] Fetching active alerts from Neon...")
    try:
        stmt = (
            select(RiskAlert)
            .where(RiskAlert.status == "OPEN")
            .where(RiskAlert.probability_percentage >= 20)
            .order_by(RiskAlert.estimated_time_to_peak.asc())
        )
        result = await db.execute(stmt)
        alerts = result.scalars().all()

        response = []
        for a in alerts:
            zone_data = ZoneCache.get(a.zone_id)
            if not zone_data:
                continue
            response.append({
                "alert_id": a.alert_id,
                "disruption_type": a.disruption_type,
                "severity": a.severity,
                "probability_percentage": float(a.probability_percentage or 0),
                "estimated_time_to_peak": (
                    a.estimated_time_to_peak.isoformat() if a.estimated_time_to_peak else None
                ),
                "estimated_resolution_at": (
                    a.estimated_resolution_at.isoformat() if a.estimated_resolution_at else None
                ),
                "resolution_confidence": float(a.resolution_confidence or 0),
                "message": a.message,
                "status": a.status,
                "alert_timestamp": a.alert_timestamp.isoformat() if a.alert_timestamp else None,
                "zone": {
                    "zone_id": zone_data["zone_id"],
                    "name": zone_data["name"],
                    "latitude": zone_data["latitude"],
                    "longitude": zone_data["longitude"],
                    "radius_m": zone_data["radius_m"],
                    "historical_flood_vulnerability": zone_data["historical_flood_vulnerability"],
                    "traffic_speed_baseline": zone_data["traffic_speed_baseline"],
                    "geometry": zone_data["geometry"],
                },
            })

        await predictions_cache.set("global_active", response)
        return response
    except Exception as e:
        logger.error(f"[API] Active alerts error: {e}")
        return []


@app.get("/predictions/active")
async def get_active_predictions(
    db: AsyncSession = Depends(get_db), force_refresh: bool = False
):
    return await _fetch_active_alerts(db, force=force_refresh)


# ── Zone Status ───────────────────────────────────────────────────────────────

@app.get("/zone-status/all")
async def get_all_zone_statuses_with_zones(db: AsyncSession = Depends(get_db)):
    """
    Returns ALL zones with their current status, not just alert zones.
    Used by the frontend MapView to show every zone on the map
    (green=low risk, yellow=medium, red=high) regardless of whether
    an alert has fired. This gives users full situational awareness.
    """
    if not ZoneCache.get_all():
        await ZoneCache.sync(db)

    result = await db.execute(select(ZoneStatus))
    statuses = result.scalars().all()
    status_map = {s.zone_id: s for s in statuses}

    # Fetch OPEN alerts grouped by zone + disruption_type. A dimension's score
    # in zone_status persists even after its alert closes — without this, the
    # frontend keeps drawing a (now-stale) threat circle for a closed alert.
    open_alerts_res = await db.execute(
        select(RiskAlert.zone_id, RiskAlert.disruption_type)
        .where(RiskAlert.status == "OPEN")
    )
    open_dims_by_zone: dict[int, set[str]] = {}
    for zid_, dtype in open_alerts_res.all():
        open_dims_by_zone.setdefault(zid_, set()).add((dtype or "").lower())

    response = []
    for zone_data in ZoneCache.get_all():
        zid = zone_data["zone_id"]
        s = status_map.get(zid)

        overall = float(s.overall_risk_score or 0) if s else 0.0
        waterway = float(s.waterway_score or 0) if s and hasattr(s, 'waterway_score') and s.waterway_score is not None else 0.0
        traffic = float(s.traffic_score or 0) if s else 0.0
        weather = float(s.weather_score or 0) if s else 0.0
        crowd = float(s.crowd_score or 0) if s else 0.0
        earthquake = float(s.earthquake_score or 0) if s else 0.0

        # Derive display severity from the dominant dimension score
        # (not the composite — so waterway=37 shows as MEDIUM not LOW)
        dom = s.dominant_risk if s else "weather"
        dim_scores = {
            "traffic": traffic, "weather": weather, "crowd": crowd,
            "earthquake": earthquake, "waterway": waterway,
        }
        dominant_score = dim_scores.get(dom, overall)

        if dominant_score >= 65 or overall >= 65:
            display_severity = "HIGH"
        elif dominant_score >= 25 or overall >= 25:
            display_severity = "MEDIUM"
        else:
            display_severity = "LOW"

        response.append({
            "zone_id": zid,
            "zone": zone_data,
            "traffic_score": traffic,
            "weather_score": weather,
            "crowd_score": crowd,
            "earthquake_score": earthquake,
            "waterway_score": waterway,
            "overall_risk_score": overall,
            "display_severity": display_severity,
            "dominant_risk": dom,
            "recommended_action": s.recommended_action if s else "No data yet.",
            "last_updated": s.last_updated.isoformat() if s and s.last_updated else None,
            # Which dimensions currently have an OPEN risk alert for this zone.
            # The map only draws a threat circle for a dimension if it's in this list —
            # this stops "ghost" circles for dimensions whose alert was already CLOSED.
            "open_threat_dims": sorted(open_dims_by_zone.get(zid, set())),
        })

    return response

@app.get("/zone-status/{zone_id}")
async def get_zone_status(zone_id: int, db: AsyncSession = Depends(get_db)):
    cache_key = f"zone_status_{zone_id}"
    cached = await zone_status_cache.get(cache_key)
    if cached:
        return cached

    result = await db.execute(
        select(ZoneStatus).where(ZoneStatus.zone_id == zone_id)
    )
    status = result.scalars().first()
    if not status:
        raise HTTPException(status_code=404, detail="Zone status not found")

    data = {
        "zone_id": status.zone_id,
        "traffic_score": float(status.traffic_score or 0),
        "weather_score": float(status.weather_score or 0),
        "crowd_score": float(status.crowd_score or 0),
        "earthquake_score": float(status.earthquake_score or 0),
        "overall_risk_score": float(status.overall_risk_score or 0),
        "last_updated": status.last_updated.isoformat() if status.last_updated else None,
        "dominant_risk": status.dominant_risk,
        "recommended_action": status.recommended_action,
    }
    await zone_status_cache.set(cache_key, data)
    return data


@app.get("/zone-status")
async def get_all_zone_statuses(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ZoneStatus))
    statuses = result.scalars().all()
    return [
        {
            "zone_id": s.zone_id,
            "traffic_score": float(s.traffic_score or 0),
            "weather_score": float(s.weather_score or 0),
            "crowd_score": float(s.crowd_score or 0),
            "earthquake_score": float(s.earthquake_score or 0),
            "overall_risk_score": float(s.overall_risk_score or 0),
            "last_updated": s.last_updated.isoformat() if s.last_updated else None,
            "dominant_risk": s.dominant_risk,
            "recommended_action": s.recommended_action,
            "zone": ZoneCache.get(s.zone_id),
        }
        for s in statuses
    ]


# ── Predictions Timeline ─────────────────────────────────────────────────────
@app.get("/predictions/zone/{zone_id}")
async def get_zone_predictions_timeline(
    zone_id: int,
    hours: int = Query(default=12, ge=3, le=24),
    db: AsyncSession = Depends(get_db),
):
    cache_key = f"timeline_{zone_id}_{hours}"
    cached = await timelines_cache.get(cache_key)
    if cached:
        return cached

    zone_data = ZoneCache.get(zone_id)
    if not zone_data:
        raise HTTPException(status_code=404, detail="Zone not found")

    now = datetime.utcnow()
    time_limit = now + timedelta(hours=hours)

    weather_res = await db.execute(
        select(WeatherSnapshot)
        .where(WeatherSnapshot.zone_id == zone_id)
        .where(WeatherSnapshot.timestamp >= now)
        .where(WeatherSnapshot.timestamp <= time_limit)
        .order_by(WeatherSnapshot.timestamp.asc())
    )
    forecasts = weather_res.scalars().all()

    traffic_res = await db.execute(
        select(TrafficSnapshot)
        .where(TrafficSnapshot.zone_id == zone_id)
        .order_by(TrafficSnapshot.timestamp.desc())
        .limit(1)
    )
    latest_traffic = traffic_res.scalars().first()

    baseline = zone_data["traffic_speed_baseline"]
    timeline = []

    if not forecasts:
        for i in range(hours):
            seg_time = now + timedelta(hours=i)
            speed = latest_traffic.speed if (i == 0 and latest_traffic) else baseline
            timeline.append({
                "timestamp": seg_time.isoformat(),
                "rainfall": 0.0,
                "humidity": 70.0,
                "expected_speed": float(speed or baseline),
                "risk_level": "Low",
            })
    else:
        for idx, f in enumerate(forecasts):
            rain = float(f.rainfall or 0)
            speed_mod = 1.0
            risk = "Low"
            if rain > 10.0:
                speed_mod, risk = 0.55, "Critical"
            elif rain > 5.0:
                speed_mod, risk = 0.70, "High"
            elif rain > 1.0:
                speed_mod, risk = 0.85, "Medium"

            hr = f.timestamp.hour
            if (7 <= hr <= 9) or (17 <= hr <= 19):
                speed_mod = max(0.40, speed_mod * 0.80)
                risk = {"Low": "Medium", "Medium": "High"}.get(risk, risk)

            expected = (
                float(latest_traffic.speed or baseline)
                if idx == 0 and latest_traffic
                else round(baseline * speed_mod, 2)
            )
            timeline.append({
                "timestamp": f.timestamp.isoformat(),
                "rainfall": rain,
                "humidity": float(f.humidity or 70),
                "expected_speed": expected,
                "risk_level": risk,
            })

    result = {
        "zone_id": zone_id,
        "zone_name": zone_data["name"],
        "timeline": timeline,
    }
    await timelines_cache.set(cache_key, result)
    return result


# ── Nearest Zones (Spatial) ──────────────────────────────────────────────────
@app.get("/zones/spatial")
async def get_zones_by_spatial_proximity(
    lon: float = Query(..., description="User longitude"),
    lat: float = Query(..., description="User latitude"),
    db: AsyncSession = Depends(get_db),
):
    """Haversine-sorted nearest 3 zones with their active alerts."""
    if not ZoneCache.get_all():
        await ZoneCache.sync(db)

    zones_dist = sorted(
        [
            (z, haversine_m(lat, lon, z["latitude"], z["longitude"]))
            for z in ZoneCache.get_all()
        ],
        key=lambda x: x[1],
    )[:3]

    response = []
    for zone, dist in zones_dist:
        alerts_res = await db.execute(
            select(RiskAlert)
            .where(RiskAlert.zone_id == zone["zone_id"])
            .where(RiskAlert.status == "OPEN")
            .where(RiskAlert.probability_percentage >= 20)
            .order_by(RiskAlert.alert_timestamp.desc())
        )
        alerts = alerts_res.scalars().all()

        # Fetch nearest safe zone via poi_master
        safe_res = await db.execute(
            select(PoiMaster).where(PoiMaster.is_safe_zone == True)
        )
        safe_zones = safe_res.scalars().all()
        nearest_safe_km = None
        if safe_zones:
            nearest_safe_km = round(
                min(
                    haversine_m(
                        zone["latitude"], zone["longitude"],
                        float(s.latitude), float(s.longitude)
                    ) / 1000
                    for s in safe_zones
                    if s.latitude and s.longitude
                ),
                3,
            )

        response.append({
            "zone": {**zone},
            "distance_meters": round(dist, 2),
            "nearest_safe_zone_km": nearest_safe_km,
            "active_alerts": [
                {
                    "alert_id": a.alert_id,
                    "disruption_type": a.disruption_type,
                    "severity": a.severity,
                    "probability_percentage": float(a.probability_percentage or 0),
                    "estimated_time_to_peak": (
                        a.estimated_time_to_peak.isoformat()
                        if a.estimated_time_to_peak else None
                    ),
                    "estimated_resolution_at": (
                        a.estimated_resolution_at.isoformat()
                        if a.estimated_resolution_at else None
                    ),
                    "resolution_confidence": float(a.resolution_confidence or 0),
                    "message": a.message,
                }
                for a in alerts
            ],
        })

    return response


# ── Safe Zones ────────────────────────────────────────────────────────────────
# ── Safe Zone Configuration ───────────────────────────────────────────────────
# Tiered failover: each disruption type has a preferred category (Tier 1).
# If no uncrowded Tier-1 POI is reachable, the engine falls through to Tier 2,
# then Tier 3. Any POI is eligible as long as its live crowd_score < threshold.
#
# Tier 1: hospital / police  — primary emergency facilities (is_safe_zone=True)
# Tier 2: university         — large campus, low crowd baseline, covered space
# Tier 3: mall / market / station — last resort shelter; only if not crowded

_DISRUPTION_SAFE_TIERS: dict[str, list[list[str]]] = {
    "flood":      [["hospital"],           ["university"],            ["mall", "market"]],
    "waterway":   [["hospital"],           ["university"],            ["mall", "market"]],
    "earthquake": [["hospital", "police"], ["university"],            ["mall"]],
    "traffic":    [["hospital", "police"], ["university", "station"], ["mall", "market"]],
    "crowd":      [["hospital", "police"], ["university"],            ["mall", "market", "station"]],
    "weather":    [["hospital"],           ["university", "mall"],    ["market", "station"]],
}

# Crowd score (0-100) below which a POI is considered safe to recommend.
# Mirrors the engine's HIGH-crowd threshold (>65) with a small buffer.
# Matches engine.py HIGH crowd threshold (82.0) — a POI is "too crowded
# to shelter in" only if it hits the same bar that triggers a HIGH alert.
_CROWD_SAFE_THRESHOLD = 82.0

# Tier 1 primary categories (have is_safe_zone=True in DB, always checked first)
_PRIMARY_SAFE_CATEGORIES = {"hospital", "police"}

_SAFE_ZONE_DETAILS: dict[str, dict[str, str]] = {
    "hospital": {
        "type": "Hospital",
        "details": "Equipped with emergency medical staff, backup power, and disaster response supplies. Designated emergency reference point under BNPB guidelines.",
    },
    "hospital_flood": {
        "type": "Hospital",
        "details": "Emergency shelter with elevated structure, backup power, and medical support. Proceed here when flood or waterway alerts are active.",
    },
    "hospital_earthquake": {
        "type": "Hospital",
        "details": "Emergency medical facility. Proceed here for injury treatment and shelter after seismic activity.",
    },
    "hospital_weather": {
        "type": "Hospital",
        "details": "Sheltered facility with power backup and medical support during severe weather events.",
    },
    "police": {
        "type": "Police Station",
        "details": "Emergency coordination point with communications equipment and crowd management capacity.",
    },
    "police_earthquake": {
        "type": "Police Station",
        "details": "Emergency coordination and crowd management point. Report here for assistance and evacuation guidance.",
    },
    "police_crowd": {
        "type": "Police Station",
        "details": "Crowd management and emergency coordination point. Officers can direct dispersal and provide safety guidance.",
    },
    "university": {
        "type": "University Campus",
        "details": "Large covered campus with open grounds. Lower crowd density makes it a viable secondary shelter point.",
    },
    "mall": {
        "type": "Mall",
        "details": "Currently below crowd capacity. Provides shelter, climate control, and access to food and first-aid facilities.",
    },
    "market": {
        "type": "Market",
        "details": "Currently uncrowded. Can serve as a temporary shelter and supply point.",
    },
    "station": {
        "type": "Transit Station",
        "details": "Currently uncrowded. Provides shelter and potential evacuation transport connections.",
    },

}


@app.get("/safe-zones")
async def get_safe_zones(
    lat: float = Query(None, description="Sort by proximity (optional)"),
    lon: float = Query(None, description="Sort by proximity (optional)"),
    disruption_types: str = Query(
        None,
        description=(
            "Comma-separated active disruption types e.g. 'flood,earthquake'. "
            "flood/waterway → hospital; earthquake/crowd/traffic → hospital or police. "
            "Omit to return all categories."
        ),
    ),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns safe zones relevant to the currently active disruption types.
    Each disruption maps to the safe zone category that actually helps:
      flood / waterway  → hospital (backup power, medical support)
      earthquake        → hospital + police (treatment and coordination)
      traffic / crowd   → hospital + police (medical and crowd management)
      weather           → hospital (sheltered facility with supplies)
    Also fixes a latent bug: pois was referenced but never fetched in the original.
    """
    if not ZoneCache.get_all():
        await ZoneCache.sync(db)

    active_types = (
        [t.strip().lower() for t in disruption_types.split(",") if t.strip()]
        if disruption_types else []
    )
    primary_type = active_types[0] if active_types else ""

    # Derive tier list for this disruption set.
    # Merge tiers across all active disruption types; use flood as default.
    if active_types:
        merged_tiers: list[set[str]] = [set(), set(), set()]
        for dtype in active_types:
            tiers = _DISRUPTION_SAFE_TIERS.get(dtype, _DISRUPTION_SAFE_TIERS["flood"])
            for i, tier in enumerate(tiers):
                merged_tiers[i].update(tier)
        tier_list = [list(t) for t in merged_tiers if t]
    else:
        # No disruption filter — return all categories, Tier 1 first
        tier_list = [
            list(_PRIMARY_SAFE_CATEGORIES),
            ["university"],
            ["mall", "market", "station"],
        ]

    # Build threat zone circles to exclude POIs inside active danger areas
    alert_res = await db.execute(
        select(RiskAlert.zone_id).where(
            RiskAlert.status == "OPEN",
            RiskAlert.probability_percentage >= 20,
        )
    )
    status_res = await db.execute(
        select(ZoneStatus.zone_id).where(ZoneStatus.overall_risk_score >= 25)
    )
    threat_zone_ids = set(alert_res.scalars().all()) | set(status_res.scalars().all())
    threat_circles = [
        {"lat": z["latitude"], "lon": z["longitude"], "radius_m": z["radius_m"]}
        for zid in threat_zone_ids
        if (z := ZoneCache.get(zid))
    ]

    def _inside_threat(p) -> bool:
        return any(
            haversine_m(float(p.latitude), float(p.longitude), c["lat"], c["lon"]) <= c["radius_m"]
            for c in threat_circles
        )

    # Fetch ALL candidate POIs across all tiers in one query
    all_tier_cats = {cat for tier in tier_list for cat in tier}
    poi_res = await db.execute(
        select(PoiMaster).where(PoiMaster.category.in_(list(all_tier_cats)))
    )
    all_pois_raw = [p for p in poi_res.scalars().all() if p.latitude and p.longitude]

    # Split into preferred (outside threat zones) and fallback (inside)
    # Never return empty just because every POI happens to be inside a threat zone —
    # during mass emergencies this would leave users with no guidance at all.
    outside_threat = [p for p in all_pois_raw if not _inside_threat(p)]
    inside_threat  = [p for p in all_pois_raw if _inside_threat(p)]

    # Use outside-threat POIs if available, fall back to inside ones
    all_pois = outside_threat if outside_threat else inside_threat
    using_fallback_pois = len(outside_threat) == 0 and len(inside_threat) > 0

    # Fetch live crowd scores for every candidate POI
    poi_ids = [p.poi_id for p in all_pois]
    crowd_res = await db.execute(
        select(PoiCrowdStatus.poi_id, PoiCrowdStatus.crowd_score)
        .where(PoiCrowdStatus.poi_id.in_(poi_ids))
    )
    crowd_by_poi: dict[str, float] = {r.poi_id: float(r.crowd_score or 0) for r in crowd_res}

    def _not_crowded(p) -> bool:
        """True if POI has no crowd data yet OR its live score is below threshold."""
        score = crowd_by_poi.get(p.poi_id)
        return score is None or score < _CROWD_SAFE_THRESHOLD

    # Tiered selection: walk tiers until we have results
    selected: list = []
    reached_tier: int = 0
    for tier_idx, tier_cats in enumerate(tier_list):
        candidates = [
            p for p in all_pois
            if p.category in tier_cats and _not_crowded(p)
        ]
        if candidates:
            selected = candidates
            reached_tier = tier_idx + 1
            break

    # If every tier is crowded or empty, return least-crowded POIs across all categories
    if not selected and all_pois:
        selected = sorted(all_pois, key=lambda p: crowd_by_poi.get(p.poi_id, 0))
        reached_tier = 99  # sentinel: "last resort"

    def _meta(category: str, crowd_score: float, tier: int) -> dict:
        key = f"{category}_{primary_type}" if f"{category}_{primary_type}" in _SAFE_ZONE_DETAILS else category
        info = _SAFE_ZONE_DETAILS.get(key, _SAFE_ZONE_DETAILS.get(category, {
            "type": category.replace("_", " ").title(),
            "details": "Available as an emergency shelter point.",
        }))
        capacity = {"hospital": 500, "police": 200, "university": 800,
                    "mall": 1000, "market": 400, "station": 600}.get(category, 300)
        tier_label = (
            "Primary" if tier == 1
            else "Secondary" if tier == 2
            else "Last resort" if tier <= 3
            else "Least crowded available"
        )
        return {
            "type": info["type"],
            "capacity": capacity,
            "details": info["details"],
            "disruption_relevance": primary_type or "all",
            "shelter_tier": tier_label,
            "crowd_score": crowd_score,
            "is_crowded": crowd_score >= _CROWD_SAFE_THRESHOLD,
            "inside_threat_zone": using_fallback_pois,
        }

    data = [
        {
            "id": p.poi_id,
            "poi_id": p.poi_id,
            "name": p.name,
            "category": p.category,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "zone_id": p.zone_id,
            **_meta(p.category, crowd_by_poi.get(p.poi_id, 0.0), reached_tier),
        }
        for p in selected
    ]

    if lat is not None and lon is not None:
        data.sort(key=lambda z: haversine_m(lat, lon, z["latitude"], z["longitude"]))

    return data


# ── Admin ─────────────────────────────────────────────────────────────────────
@app.post("/admin/login")
async def admin_login(payload: dict):
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "disrupt_admin_2026")
    if secrets.compare_digest(str(payload.get("password", "")), ADMIN_PASSWORD):
        return {"authenticated": True, "token": "authenticated-session-token-2026"}
    raise HTTPException(status_code=401, detail="Unauthorized")


@app.post("/admin/cache/clear")
async def clear_all_caches():
    await predictions_cache.clear()
    await rivers_cache.clear()
    await timelines_cache.clear()
    await stats_cache.clear()
    await zone_status_cache.clear()
    logger.info("[Cache] All caches cleared.")
    return {"message": "All caches cleared"}


@app.post("/admin/zones/sync")
async def sync_zones(db: AsyncSession = Depends(get_db)):
    """Re-syncs ZoneCache from Neon and clears stale caches."""
    await ZoneCache.sync(db)
    await predictions_cache.clear()
    await zone_status_cache.clear()
    return {"message": "Zones re-synced", "count": len(ZoneCache.get_all())}


async def _compute_db_stats(db: AsyncSession) -> dict:
    counts = {}
    for model, name in [
        (Zone, "zones"), (RiskAlert, "risk_alerts"),
        (TrafficSnapshot, "traffic_snapshots"),
        (WeatherSnapshot, "weather_snapshots"),
        (CrowdSnapshot, "crowd_snapshots"),
        (EarthquakeEvent, "earthquake_events"),
    ]:
        try:
            res = await db.execute(select(func.count()).select_from(model))
            counts[name] = res.scalar()
        except Exception:
            counts[name] = "error"
    return counts


@app.get("/admin/status")
async def get_admin_status(db: AsyncSession = Depends(get_db)):
    from database import get_sql_ops_metrics

    t0 = time.time()
    try:
        await db.execute(text("SELECT 1"))
        db_latency = round((time.time() - t0) * 1000, 2)
        db_status = "healthy"
    except Exception as e:
        db_latency = 0.0
        db_status = f"unreachable ({e})"

    now = datetime.now()
    _JOB_REGISTRY = {
        "traffic_ingestion": {"name": "TomTom Traffic", "interval_minutes": 15},
        "weather_ingestion": {"name": "Open-Meteo Weather", "interval_minutes": 30},
        "crowd_ingestion": {"name": "Crowd Density", "interval_minutes": 15},
        "predictive_scoring": {"name": "Scoring Engine", "interval_minutes": 15},
        "earthquake_ingestion": {"name": "BMKG Earthquakes", "interval_minutes": 15},
    }
    jobs = []
    for job_id, job in _JOB_REGISTRY.items():
        interval_s = job["interval_minutes"] * 60
        elapsed_s = (now - _APP_START_TIME).total_seconds()
        intervals_done = max(0, int(elapsed_s // interval_s))
        last_run = _APP_START_TIME + timedelta(seconds=intervals_done * interval_s)
        next_run = last_run + timedelta(seconds=interval_s)
        sec_left = max(0, int((next_run - now).total_seconds()))
        jobs.append({
            "id": job_id,
            "name": job["name"],
            "interval_minutes": job["interval_minutes"],
            "last_run": last_run.isoformat(),
            "next_run": next_run.isoformat(),
            "next_run_mmss": f"{sec_left // 60:02d}:{sec_left % 60:02d}",
            "status": "running",
        })

    sql_ops = get_sql_ops_metrics()
    zone_count = len(ZoneCache.get_all())

    return {
        "database": {"status": db_status, "latency_ms": db_latency, "provider": "neon-postgresql"},
        "cache": {"zones_loaded": zone_count},
        "sql_ops": sql_ops,
        "jobs": jobs,
    }


@app.get("/admin/db-stats")
async def get_db_stats(db: AsyncSession = Depends(get_db)):
    cached = await stats_cache.get("db_stats")
    if cached:
        return cached
    result = await _compute_db_stats(db)
    await stats_cache.set("db_stats", result)
    return result


# ── /pois — POI catalog for MapView ──────────────────────────────────────────
# Frontend expects: { name, category, lat, lon, is_suppressed }
@app.get("/pois")
async def get_pois(db: AsyncSession = Depends(get_db)):
    INTERNAL_CATEGORIES = set()  # all POI categories are now public (fictional ones removed)
    result = await db.execute(
        select(PoiMaster).where(
            PoiMaster.category.notin_(list(INTERNAL_CATEGORIES))
        )
    )
    pois = result.scalars().all()

    # Fetch active threat zone circles
    alert_stmt = select(RiskAlert.zone_id).where(
        RiskAlert.status == "OPEN",
        RiskAlert.probability_percentage >= 20
    )
    alert_res = await db.execute(alert_stmt)
    alert_zone_ids = set(alert_res.scalars().all())

    status_stmt = select(ZoneStatus.zone_id).where(
        ZoneStatus.overall_risk_score >= 25
    )
    status_res = await db.execute(status_stmt)
    status_zone_ids = set(status_res.scalars().all())

    threat_zone_ids = alert_zone_ids.union(status_zone_ids)

    threat_circles = []
    for zid in threat_zone_ids:
        zdata = ZoneCache.get(zid)
        if zdata:
            threat_circles.append({
                "lat": zdata["latitude"],
                "lon": zdata["longitude"],
                "radius_m": zdata["radius_m"]
            })

    # Filter pois
    filtered_pois = []
    for p in pois:
        if not p.latitude or not p.longitude:
            continue
        if p.is_safe_zone:
            is_inside_threat = False
            for circle in threat_circles:
                dist = haversine_m(
                    float(p.latitude), float(p.longitude),
                    circle["lat"], circle["lon"]
                )
                if dist <= circle["radius_m"]:
                    is_inside_threat = True
                    break
            if is_inside_threat:
                continue
        filtered_pois.append(p)

    # Per-POI crowd scores (mall vs hospital in the same zone get different values)
    poi_ids_needed = [p.poi_id for p in filtered_pois]
    crowd_by_poi: dict = {}
    if poi_ids_needed:
        crowd_res = await db.execute(
            select(PoiCrowdStatus.poi_id, PoiCrowdStatus.crowd_score)
            .where(PoiCrowdStatus.poi_id.in_(poi_ids_needed))
        )
        crowd_by_poi = {row.poi_id: float(row.crowd_score or 0) for row in crowd_res}

    return [
        {
            "name": p.name,
            "category": p.category or "other",
            "lat": float(p.latitude) if p.latitude else 0.0,
            "lon": float(p.longitude) if p.longitude else 0.0,
            "is_suppressed": False,
            "is_safe_zone": p.is_safe_zone,
            "zone_id": p.zone_id,
            "crowd_score": crowd_by_poi.get(p.poi_id, 0.0),
        }
        for p in filtered_pois
    ]


# ── /admin/scoring-debug — AdminDashboard scoring trace ──────────────────────
@app.get("/admin/scoring-debug")
async def get_scoring_debug(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ZoneStatus))
    statuses = result.scalars().all()
    return [
        {
            "zone_id": s.zone_id,
            "zone_name": (ZoneCache.get(s.zone_id) or {}).get("name", f"Zone {s.zone_id}"),
            "traffic_score": float(s.traffic_score or 0),
            "weather_score": float(s.weather_score or 0),
            "crowd_score": float(s.crowd_score or 0),
            "earthquake_score": float(s.earthquake_score or 0),
            "overall_risk_score": float(s.overall_risk_score or 0),
            "dominant_risk": s.dominant_risk,
            "recommended_action": s.recommended_action,
            "last_updated": s.last_updated.isoformat() if s.last_updated else None,
        }
        for s in statuses
    ]


# ── /admin/sla-metrics — AdminDashboard SLA chart ────────────────────────────
@app.get("/admin/sla-metrics")
async def get_sla_metrics(
    range_hours: int = Query(default=24, ge=1, le=168),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import func as sqlfunc
    cutoff = datetime.utcnow() - timedelta(hours=range_hours)

    traffic_count = (await db.execute(
        select(sqlfunc.count()).select_from(TrafficSnapshot)
        .where(TrafficSnapshot.timestamp >= cutoff)
    )).scalar()

    weather_count = (await db.execute(
        select(sqlfunc.count()).select_from(WeatherSnapshot)
        .where(WeatherSnapshot.timestamp >= cutoff)
    )).scalar()

    alert_count = (await db.execute(
        select(sqlfunc.count()).select_from(RiskAlert)
        .where(RiskAlert.alert_timestamp >= cutoff)
    )).scalar()

    return {
        "range_hours": range_hours,
        "traffic_snapshots": traffic_count,
        "weather_snapshots": weather_count,
        "risk_alerts_generated": alert_count,
        "data_freshness_ok": traffic_count > 0 or weather_count > 0,
    }


# ── /dashboard/summary — Dashboard analytics & metrics ────────────────────────
@app.get("/dashboard/summary")
async def get_dashboard_summary(
    days: int = Query(default=7, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns aggregated metrics, daily trends, disruption breakdowns, and zone
    rankings for the main Dashboard view.
    """
    days = min(days, 30)

    # 1. Total alerts breakdown
    res = await db.execute(
        text("""
            SELECT COUNT(*) as total,
                   COUNT(*) FILTER (WHERE status='OPEN') as open_count,
                   COUNT(*) FILTER (WHERE status='CLOSED') as closed_count,
                   COUNT(*) FILTER (WHERE severity='HIGH') as high_count,
                   COUNT(*) FILTER (WHERE severity='MEDIUM') as medium_count
            FROM risk_alerts
            WHERE alert_timestamp >= NOW() - (INTERVAL '1 day' * :days)
        """),
        {"days": days}
    )
    totals_row = res.mappings().fetchone() or {}
    totals = {
        "total": totals_row.get("total", 0),
        "open": totals_row.get("open_count", 0),
        "closed": totals_row.get("closed_count", 0),
        "high": totals_row.get("high_count", 0),
        "medium": totals_row.get("medium_count", 0),
    }

    # 2. Dominant disruption type
    res = await db.execute(
        text("""
            SELECT disruption_type, COUNT(*) as cnt
            FROM risk_alerts
            WHERE alert_timestamp >= NOW() - (INTERVAL '1 day' * :days)
            GROUP BY disruption_type
            ORDER BY cnt DESC
            LIMIT 1
        """),
        {"days": days}
    )
    top_type_row = res.mappings().fetchone()
    dominant_type = top_type_row["disruption_type"] if top_type_row else "N/A"

    # 3. Daily trend
    res = await db.execute(
        text("""
            SELECT DATE(alert_timestamp AT TIME ZONE 'Asia/Jakarta') as day,
                   COUNT(*) as count
            FROM risk_alerts
            WHERE alert_timestamp >= NOW() - (INTERVAL '1 day' * :days)
            GROUP BY day
            ORDER BY day ASC
        """),
        {"days": days}
    )
    daily_trend = [
        {"day": str(r["day"]), "count": r["count"]}
        for r in res.mappings().fetchall()
    ]

    # 4. Severity breakdown by type
    res = await db.execute(
        text("""
            SELECT disruption_type,
                   COUNT(*) FILTER (WHERE severity='HIGH') as high,
                   COUNT(*) FILTER (WHERE severity='MEDIUM') as medium
            FROM risk_alerts
            WHERE alert_timestamp >= NOW() - (INTERVAL '1 day' * :days)
            GROUP BY disruption_type
            ORDER BY (COUNT(*) FILTER (WHERE severity='HIGH') + COUNT(*) FILTER (WHERE severity='MEDIUM')) DESC
        """),
        {"days": days}
    )
    breakdown = [
        {
            "type": r["disruption_type"].capitalize() if r["disruption_type"] else "Unknown",
            "HIGH": r["high"] or 0,
            "MEDIUM": r["medium"] or 0,
        }
        for r in res.mappings().fetchall()
        if (r["high"] or 0) + (r["medium"] or 0) > 0
    ]

    # 5. Zone rankings
    res = await db.execute(
        text("""
            SELECT ra.zone_id, z.name,
                   COUNT(*) as total_alerts,
                   COUNT(*) FILTER (WHERE ra.status='OPEN') as open_alerts,
                   COUNT(*) FILTER (WHERE ra.severity='HIGH') as high_alerts,
                   MAX(zs.overall_risk_score) as risk_score
            FROM risk_alerts ra
            LEFT JOIN zones z ON ra.zone_id = z.zone_id
            LEFT JOIN zone_status zs ON ra.zone_id = zs.zone_id
            WHERE ra.alert_timestamp >= NOW() - (INTERVAL '1 day' * :days)
            GROUP BY ra.zone_id, z.name
            ORDER BY total_alerts DESC
            LIMIT 20
        """),
        {"days": days}
    )
    zone_rankings = [
        {
            "zone_id": r["zone_id"],
            "name": r["name"] or f"Zone {r['zone_id']}",
            "total_alerts": r["total_alerts"],
            "open_alerts": r["open_alerts"] or 0,
            "high_alerts": r["high_alerts"] or 0,
            "risk_score": float(r["risk_score"] or 0),
        }
        for r in res.mappings().fetchall()
    ]

    hotspot = zone_rankings[0] if zone_rankings else None

    return {
        "days": days,
        "totals": totals,
        "dominant_type": dominant_type,
        "hotspot": hotspot,
        "daily_trend": daily_trend,
        "severity_breakdown": breakdown,
        "zone_rankings": zone_rankings,
    }

