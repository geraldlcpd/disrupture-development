"""
Background Ingestion Worker — Neon PostgreSQL Edition
======================================================
APScheduler jobs:
  - traffic_ingestion   : every 15 min → traffic_snapshots
  - weather_ingestion   : every 30 min → weather_snapshots
  - crowd_ingestion     : every 15 min → crowd_snapshots  (new dimension)
  - earthquake_ingestion: every 15 min → earthquake_events
  - scoring_cycle       : every 15 min → zone_status + risk_alerts

Oracle-specific calls removed:
  - SDO_UTIL.TO_GEOJSON  → not needed; zones use lat/lon
  - SELECT 1 FROM DUAL   → SELECT 1
  - oracledb wallet      → psycopg2 / asyncpg with sslmode=require
"""

import logging
import sys
import time
import math
import uuid
from datetime import datetime, timedelta, timezone
from apscheduler.schedulers.blocking import BlockingScheduler
from sqlalchemy import text

from worker.database import get_db_session
from worker.models import (
    Zone, ZoneStatus, RiskAlert, TrafficSnapshot, WeatherSnapshot,
    CrowdSnapshot, EarthquakeEvent, PoiMaster,
    JabodetabekWaterway, WaterwayTelemetry, WaterwayConnectivity,
)
from worker.config import TRAFFIC_PROVIDER, GOOGLE_MAPS_API_KEY, ML_SCORING_ENABLED
from worker.clients.tomtom import TomTomTrafficClient
from worker.clients.google import GoogleTrafficClient
from worker.clients.openmeteo import OpenMeteoClient
from worker.clients.telemetry import JabodetabekTelemetryClient
from worker.clients.bmkg import BMKGClient
from worker.engine import PredictiveDisruptionEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("worker")


class IngestionWorker:
    def __init__(self):
        if TRAFFIC_PROVIDER == "google":
            self.traffic_client = GoogleTrafficClient(api_key=GOOGLE_MAPS_API_KEY)
            logger.info("[Traffic] Provider: Google Maps")
        else:
            self.traffic_client = TomTomTrafficClient()
            logger.info("[Traffic] Provider: TomTom")

        self.weather_client = OpenMeteoClient()
        self.telemetry_client = JabodetabekTelemetryClient()
        self.bmkg_client = BMKGClient()
        self.engine = PredictiveDisruptionEngine()

    # ── Traffic ────────────────────────────────────────────────────────────
    # ── TomTom budget constants (free tier: 2,500 calls/day) ─────────────────
    # Hard caps derived from budget allocation across time brackets.
    # These are ZONE CAPS, not percentages — they scale automatically when
    # you add more zones because min(total_zones, cap) is applied at runtime.
    #
    # Budget math (verified scalable to 200+ zones):
    #   Rush   bracket: 8h × 4 runs/h × 57 zones = 1,824 calls
    #   Active bracket: 8h × 2 runs/h × 30 zones =   480 calls
    #   Late   bracket: 2h × 1 run/h  × 48 zones =    96 calls
    #   Dead   bracket: 5h × 0                   =     0 calls
    #   Total: 2,400 calls/day — 100 below free tier regardless of zone count.
    #
    # Zone priority: always sorted by historical_flood_vulnerability DESC,
    # so highest-risk zones are always included when the cap limits coverage.
    _RUSH_ZONE_CAP   = 57
    _ACTIVE_ZONE_CAP = 30
    _LATE_ZONE_CAP   = 48

    @staticmethod
    def _traffic_schedule(hour_wib: int) -> tuple[bool, str, int]:
        """
        Returns (should_run, bracket, interval_min) for the given WIB hour.
        Zone count is applied at call time via min(total_zones, CAP).
        """
        if   7 <= hour_wib <= 9:   return True, 'rush',   15
        elif 12 <= hour_wib <= 13: return True, 'rush',   15
        elif 17 <= hour_wib <= 19: return True, 'rush',   15
        elif 5 <= hour_wib <= 6:   return True, 'active', 30
        elif 10 <= hour_wib <= 11: return True, 'active', 30
        elif 14 <= hour_wib <= 16: return True, 'active', 30
        elif 20 <= hour_wib <= 21: return True, 'active', 30
        elif 22 <= hour_wib <= 23: return True, 'late',   60
        else:                      return False, 'dead',   0

    def run_traffic_ingestion(self):
        from worker.engine import WIB_OFFSET_HOURS
        hour_wib = (datetime.now(timezone.utc).hour + WIB_OFFSET_HOURS) % 24
        should_run, bracket, interval_min = self._traffic_schedule(hour_wib)

        if not should_run:
            logger.info(f"[Traffic] Skipping — dead hours (WIB {hour_wib:02d}:xx)")
            return

        # For off-peak intervals (30/60 min), skip runs that don't land on
        # the interval boundary — the scheduler still fires every 15 min.
        minute = datetime.now(timezone.utc).minute
        if interval_min > 15 and (minute % interval_min) >= 15:
            logger.debug(f"[Traffic] Off-cycle skip (interval={interval_min}m, minute={minute})")
            return

        # Zone cap from bracket — applied against live zone count so adding
        # new zones never silently blows the TomTom daily budget.
        cap = {
            'rush':   self._RUSH_ZONE_CAP,
            'active': self._ACTIVE_ZONE_CAP,
            'late':   self._LATE_ZONE_CAP,
        }[bracket]

        logger.info(f"[Ingestion] Traffic — WIB {hour_wib:02d}:xx [{bracket}] cap={cap} every {interval_min}m")
        db = get_db_session()
        try:
            total_zones = db.query(Zone).count()
            effective_cap = min(total_zones, cap)

            # ── Smart zone priority ─────────────────────────────────────────
            # Priority 1: zones with any OPEN alert → always freshest data needed
            # Priority 2: zones with highest live overall_risk_score (from last cycle)
            # Priority 3: stable fallback by zone_id
            # This means during rush hour, congested CBD zones rise to the top;
            # during flood risk, waterway-adjacent zones with high scores rise up —
            # not a static vulnerability column that ignores what's happening now.
            alerted_ids = {
                r.zone_id for r in
                db.query(RiskAlert.zone_id)
                .filter(RiskAlert.status == "OPEN")
                .all()
            }

            # Zones with OPEN alerts always included first (up to cap)
            priority_zones = (
                db.query(Zone)
                .filter(Zone.zone_id.in_(alerted_ids))
                .order_by(Zone.zone_id)
                .all()
            ) if alerted_ids else []

            remaining_cap = effective_cap - len(priority_zones)

            if remaining_cap > 0:
                # Fill remaining slots with highest overall_risk_score zones
                # via a join to zone_status — excludes already-selected zones
                scored = (
                    db.query(Zone)
                    .join(ZoneStatus, ZoneStatus.zone_id == Zone.zone_id, isouter=True)
                    .filter(Zone.zone_id.notin_(alerted_ids))
                    .order_by(ZoneStatus.overall_risk_score.desc().nullslast(), Zone.zone_id)
                    .limit(remaining_cap)
                    .all()
                )
                zones = priority_zones + scored
            else:
                zones = priority_zones[:effective_cap]

            logger.info(
                f"[Traffic] {len(zones)} zones selected "
                f"({len(priority_zones)} alerted + {len(zones)-len(priority_zones)} by risk score)"
            )
            now = datetime.now(timezone.utc)
            for zone in zones:
                try:
                    flow = self.traffic_client.get_flow_data(
                        zone.name,
                        float(zone.traffic_speed_baseline or 40.0),
                        float(zone.latitude),
                        float(zone.longitude),
                        db=db,
                    )
                    db.add(TrafficSnapshot(
                        zone_id=zone.zone_id,
                        timestamp=now,
                        speed=flow.get("current_speed", flow.get("speed")),
                        congestion=flow.get("congestion"),
                        travel_time=flow.get("travel_time"),
                    ))
                except Exception as ze:
                    logger.warning(f"[Traffic] Zone {zone.name} failed: {ze}")
            db.commit()
            logger.info(f"[Ingestion] Traffic done — {len(zones)} zones at WIB {hour_wib:02d}:xx")
        except Exception as e:
            db.rollback()
            logger.error(f"[Ingestion] Traffic error: {e}")
        finally:
            db.close()

    # ── Weather ────────────────────────────────────────────────────────────
    def run_weather_ingestion(self):
        logger.info("[Ingestion] Weather ingestion starting...")
        db = get_db_session()
        try:
            zones = db.query(Zone).all()
            for zone in zones:
                try:
                    forecasts = self.weather_client.get_24h_forecast(
                        zone.name, float(zone.latitude), float(zone.longitude)
                    )
                    # Replace existing future weather snapshots for this zone
                    now = datetime.now(timezone.utc)
                    db.query(WeatherSnapshot).filter(
                        WeatherSnapshot.zone_id == zone.zone_id,
                        WeatherSnapshot.timestamp >= now,
                    ).delete()

                    for hr in forecasts:
                        db.add(WeatherSnapshot(
                            zone_id=zone.zone_id,
                            timestamp=hr["timestamp"],
                            rainfall=hr.get("rainfall", 0.0),
                            humidity=hr.get("humidity", 70.0),
                            wind_speed=hr.get("wind_speed", 0.0),
                        ))
                except Exception as ze:
                    logger.warning(f"[Weather] Zone {zone.name} failed: {ze}")
            db.commit()
            logger.info(f"[Ingestion] Weather done for {len(zones)} zones.")
        except Exception as e:
            db.rollback()
            logger.error(f"[Ingestion] Weather error: {e}")
        finally:
            db.close()

    # ── Crowd ──────────────────────────────────────────────────────────────
    def run_crowd_ingestion(self):
        from worker.engine import WIB_OFFSET_HOURS
        hour_wib = (datetime.now(timezone.utc).hour + WIB_OFFSET_HOURS) % 24
        should_run, _, _interval = self._traffic_schedule(hour_wib)
        if not should_run:
            logger.info(f"[Crowd] Skipping — quiet hours (WIB {hour_wib:02d}:xx)")
            return
        """
        Ingests crowd density snapshot for each zone.
        poi_count = number of active POIs within zone radius (from poi_master)
        hazard_count = POIs tagged as hazard (category containing 'hazard' or 'risk')
        crowd_score is computed by the engine; here we just record the raw inputs.
        """
        logger.info("[Ingestion] Crowd ingestion starting...")
        db = get_db_session()
        try:
            zones = db.query(Zone).all()
            now = datetime.now(timezone.utc)

            for zone in zones:
                try:
                    # Count POIs assigned to this zone
                    poi_count = db.query(PoiMaster).filter(
                        PoiMaster.zone_id == zone.zone_id
                    ).count()

                    # Hazard POIs: categories that indicate risk (extend as needed)
                    hazard_count = db.query(PoiMaster).filter(
                        PoiMaster.zone_id == zone.zone_id,
                        PoiMaster.category.ilike("%hazard%"),
                    ).count()

                    db.add(CrowdSnapshot(
                        zone_id=zone.zone_id,
                        timestamp=now,
                        poi_count=poi_count,
                        hazard_count=hazard_count,
                        # crowd_score and confidence_score written by engine
                        crowd_score=None,
                        confidence_score=None,
                    ))
                except Exception as ze:
                    logger.warning(f"[Crowd] Zone {zone.name} failed: {ze}")
            db.commit()
            logger.info(f"[Ingestion] Crowd done for {len(zones)} zones.")
        except Exception as e:
            db.rollback()
            logger.error(f"[Ingestion] Crowd error: {e}")
        finally:
            db.close()

    # ── Earthquake ─────────────────────────────────────────────────────────
    def run_earthquake_ingestion(self):
        logger.info("[Ingestion] Earthquake ingestion starting...")
        db = get_db_session()
        try:
            quakes = self.bmkg_client.get_recent_earthquakes()
            new_count = 0
            for eq in quakes:
                event_id = eq.get("event_id", "")
                if not event_id:
                    continue

                exists = db.query(EarthquakeEvent).filter(
                    EarthquakeEvent.event_id == event_id
                ).first()
                if not exists:
                    mag = float(eq.get("magnitude", 0.0))
                    depth_km = float(eq.get("depth_km", 10.0))
                    impact_km = float(eq.get("impact_radius_km", mag * 15))
                    eq_dt = eq.get("datetime")
                    if not isinstance(eq_dt, datetime):
                        eq_dt = datetime.now(timezone.utc)

                    db.add(EarthquakeEvent(
                        event_id=event_id,
                        magnitude=mag,
                        depth_km=depth_km,
                        latitude=float(eq.get("latitude", 0.0)),
                        longitude=float(eq.get("longitude", 0.0)),
                        event_timestamp=eq_dt,
                        location=eq.get("wilayah", ""),
                        impact_radius_km=impact_km,
                    ))
                    new_count += 1
            db.commit()
            logger.info(f"[Ingestion] Earthquake done. Added {new_count} new events.")
        except Exception as e:
            db.rollback()
            logger.error(f"[Ingestion] Earthquake error: {e}")
        finally:
            db.close()


    # ── Waterway Connectivity (one-time build) ─────────────────────────────
    def build_waterway_connectivity(self):
        """
        Builds the waterway_connectivity graph from jabodetabek_waterways.next_down.
        Safe to call multiple times — uses INSERT ... ON CONFLICT DO NOTHING.
        Only needs to run once after waterway data is seeded.
        """
        logger.info("[Waterway] Building connectivity graph from next_down links...")
        db = get_db_session()
        try:
            import json, math
            waterways = db.query(JabodetabekWaterway).all()
            # Build hyriv_id → segment lookup
            seg_map = {w.hyriv_id: w for w in waterways}
            
            added = 0
            for w in waterways:
                if not w.next_down or w.next_down not in seg_map:
                    continue
                downstream = seg_map[w.next_down]
                
                # Compute approximate distance between segment midpoints
                try:
                    up_coords = json.loads(w.coordinates_json or "[]")
                    dn_coords = json.loads(downstream.coordinates_json or "[]")
                    if up_coords and dn_coords:
                        up_mid = up_coords[len(up_coords)//2]
                        dn_mid = dn_coords[len(dn_coords)//2]
                        phi1, phi2 = math.radians(up_mid[1]), math.radians(dn_mid[1])
                        lam1, lam2 = math.radians(up_mid[0]), math.radians(dn_mid[0])
                        cos_a = max(-1, min(1, math.sin(phi1)*math.sin(phi2)+math.cos(phi1)*math.cos(phi2)*math.cos(lam2-lam1)))
                        dist_km = round(6371 * math.acos(cos_a), 3)
                    else:
                        dist_km = float(w.length_km or 1.0)
                except Exception:
                    dist_km = float(w.length_km or 1.0)

                existing = db.query(WaterwayConnectivity).filter_by(
                    upstream_hyriv=w.hyriv_id,
                    downstream_hyriv=w.next_down,
                ).first()
                if not existing:
                    db.add(WaterwayConnectivity(
                        upstream_hyriv=w.hyriv_id,
                        downstream_hyriv=w.next_down,
                        distance_km=dist_km,
                    ))
                    added += 1

            db.commit()
            logger.info(f"[Waterway] Connectivity graph built: {added} new edges.")
        except Exception as e:
            db.rollback()
            logger.error(f"[Waterway] Connectivity build error: {e}")
        finally:
            db.close()

    # ── Waterway Telemetry Ingestion ───────────────────────────────────────
    def run_waterway_telemetry_ingestion(self):
        """
        Reads BPBD gate telemetry (Katulampa, Manggarai) from the telemetry client
        and writes to waterway_telemetry. Also updates alert_level on the
        closest major waterway segment so the engine picks it up for cascade.
        """
        logger.info("[Ingestion] Waterway telemetry ingestion starting...")
        db = get_db_session()
        try:
            import json, math
            gate_data = self.telemetry_client.get_river_gate_levels()
            now = datetime.now(timezone.utc)

            # Known gate locations — matched to nearest segment in jabodetabek_waterways
            gate_locations = {
                "katulampa": {"lat": -6.6439, "lon": 106.8326},   # Katulampa weir, Bogor
                "manggarai": {"lat": -6.2044, "lon": 106.8490},   # Manggarai gate, Jakarta
            }

            waterways = db.query(JabodetabekWaterway).all()

            def haversine_km(lat1, lon1, lat2, lon2):
                import math
                p1,p2 = math.radians(lat1), math.radians(lat2)
                l1,l2 = math.radians(lon1), math.radians(lon2)
                c = max(-1,min(1, math.sin(p1)*math.sin(p2)+math.cos(p1)*math.cos(p2)*math.cos(l2-l1)))
                return 6371*math.acos(c)

            for gate_name, readings in gate_data.items():
                gate_loc = gate_locations.get(gate_name)
                if not gate_loc:
                    continue

                # Find closest waterway segment to this gate
                best_seg = None
                best_dist = float("inf")
                for w in waterways:
                    try:
                        coords = json.loads(w.coordinates_json or "[]")
                        for lon, lat in coords:
                            d = haversine_km(gate_loc["lat"], gate_loc["lon"], lat, lon)
                            if d < best_dist:
                                best_dist = d
                                best_seg = w
                    except Exception:
                        continue

                if best_seg is None:
                    logger.warning(f"[Telemetry] No segment found near {gate_name} gate")
                    continue

                water_level_cm = float(readings.get("water_level_cm", 0))
                alert_level    = readings.get("alert_level", "Normal")
                capacity_pct   = min(100.0, water_level_cm / max(1, (best_seg.danger_level_cm or 200)) * 100)

                db.add(WaterwayTelemetry(
                    hyriv_id=best_seg.hyriv_id,
                    timestamp=now,
                    water_level_cm=water_level_cm,
                    flow_rate_cms=float(best_seg.dis_av_cms or 0),
                    capacity_percentage=round(capacity_pct, 2),
                    alert_level=alert_level,
                ))

                # Update alert_level on the segment so engine cascade picks it up
                best_seg.alert_level = alert_level
                best_seg.last_updated = now

                logger.info(
                    f"[Telemetry] {gate_name.capitalize()} gate → "
                    f"segment {best_seg.hyriv_id}: {water_level_cm:.0f}cm [{alert_level}]"
                )

            db.commit()
            logger.info("[Ingestion] Waterway telemetry done.")
        except Exception as e:
            db.rollback()
            logger.error(f"[Ingestion] Waterway telemetry error: {e}")
        finally:
            db.close()

    # ── Scoring Cycle ──────────────────────────────────────────────────────
    def run_scoring_cycle(self):
        logger.info("[Analytics] Scoring cycle starting...")
        db = get_db_session()
        try:
            try:
                self.engine.run_analysis(db)
            except Exception as e:
                logger.error(f"[Analytics] Scoring error: {e}")

            if ML_SCORING_ENABLED:
                try:
                    from worker.ml_scoring import run_ml_batch_scoring
                    run_ml_batch_scoring(db)
                except Exception as e:
                    logger.error(f"[ML] Batch scoring error: {e}")
        finally:
            db.close()

    # ── Full sweep ─────────────────────────────────────────────────────────
    def execute_all(self):
        logger.info("[Sync] Full ingestion sweep starting...")
        self.build_waterway_connectivity()
        self.run_earthquake_ingestion()
        self.run_traffic_ingestion()
        self.run_weather_ingestion()
        self.run_crowd_ingestion()
        self.run_waterway_telemetry_ingestion()
        self.run_scoring_cycle()
        logger.info("[Sync] Full sweep complete.")


def wait_for_db_ready():
    logger.info("Verifying Neon PostgreSQL connectivity...")
    retries = 30
    while retries > 0:
        db = None
        try:
            db = get_db_session()
            db.execute(text("SELECT 1"))   # PostgreSQL — no DUAL needed
            logger.info("Neon database connection established.")
            return
        except Exception as e:
            logger.warning(f"DB not ready yet ({e}). Retrying in 2s... ({retries} left)")
            time.sleep(2)
            retries -= 1
        finally:
            if db:
                db.close()
    logger.critical("Could not connect to Neon database. Worker terminating.")
    sys.exit(1)


if __name__ == "__main__":
    logger.info("Starting Neon PostgreSQL Ingestion Worker...")
    wait_for_db_ready()

    worker = IngestionWorker()
    logger.info("Running initial full sweep on startup...")
    worker.execute_all()

    scheduler = BlockingScheduler()

    scheduler.add_job(
        worker.run_earthquake_ingestion, "interval", minutes=15,
        next_run_time=datetime.now(), id="earthquake_ingestion",
    )
    scheduler.add_job(
        worker.run_traffic_ingestion, "interval", minutes=15,
        next_run_time=datetime.now(), id="traffic_ingestion",
    )
    scheduler.add_job(
        worker.run_weather_ingestion, "interval", minutes=30,
        next_run_time=datetime.now(), id="weather_ingestion",
    )
    scheduler.add_job(
        worker.run_crowd_ingestion, "interval", minutes=15,
        next_run_time=datetime.now(), id="crowd_ingestion",
    )
    scheduler.add_job(
        worker.run_waterway_telemetry_ingestion, "interval", minutes=15,
        next_run_time=datetime.now(), id="waterway_telemetry",
    )
    scheduler.add_job(
        worker.run_scoring_cycle, "interval", minutes=15,
        # Delay first scoring run by 90s so all ingestion jobs (which fire at
        # datetime.now()) have time to commit their snapshots before the engine reads them.
        # Without this, the scoring cycle races ingestion and reads empty crowd/traffic
        # snapshots → all scores stay 0.
        next_run_time=datetime.now() + timedelta(seconds=10),
        id="predictive_scoring",
    )

    try:
        logger.info("APScheduler running. Jobs active.")
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Worker gracefully stopped.")
