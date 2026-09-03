"""
Combines the two ML prediction endpoints into one Vercel Function to stay
within the Hobby plan's 12-function limit.

  GET /api/predict/zone/:zoneId       -> rewrites to ?type=zone&zoneId=...
  GET /api/predict/resolution/:alertId -> rewrites to ?type=resolution&alertId=...

CACHE-ONLY: reads precomputed rows from ml_prediction_cache (written by the
local worker's batch ML scoring). No sklearn inference on Vercel — on cache
miss returns 503 so the UI hides ML badges until the worker refreshes the cache.
"""
from http.server import BaseHTTPRequestHandler
import sys, os
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, os.path.dirname(__file__))
from _helpers import get_conn, send_json, send_cors_preflight
from _cache_helpers import get_cached

MAX_BATCH_SIZE = 50

_CACHE_MISS_BODY = {
    "error": "ML prediction not cached yet. Run the local worker scoring cycle.",
}


class handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args): pass

    def do_OPTIONS(self):
        send_cors_preflight(self)

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        prediction_type = (qs.get('type', [None])[0] or '').lower()

        if not prediction_type:
            if '/resolution/' in parsed.path:
                prediction_type = 'resolution'
            elif '/zone/' in parsed.path:
                prediction_type = 'zone'

        if prediction_type == 'zone':
            self._handle_zone(qs, parsed)
        elif prediction_type == 'resolution':
            self._handle_resolution(qs, parsed)
        elif prediction_type == 'batch':
            self._handle_batch(qs)
        else:
            send_json(self, {"error": "Unknown or missing prediction type. Expected ?type=zone, ?type=resolution, or ?type=batch."}, 400)

    def _handle_zone(self, qs, parsed):
        try:
            zone_id = qs.get('zoneId', qs.get('zone_id', [None]))[0]
            if not zone_id:
                parts = parsed.path.rstrip('/').split('/')
                zone_id = parts[-1] if parts[-1].isdigit() else None
            if not zone_id:
                send_json(self, {"error": "zone_id required"}, 400)
                return
            zone_id = int(zone_id)
            cache_key = f"zone:{zone_id}"

            conn = get_conn()
            cur = conn.cursor()
            try:
                cached = get_cached(cur, cache_key)
            finally:
                cur.close()
                conn.close()

            if cached is not None:
                send_json(self, cached)
                return

            send_json(self, {**_CACHE_MISS_BODY, "zone_id": zone_id}, 503)

        except ValueError as e:
            send_json(self, {"error": str(e)}, 404)
        except Exception as e:
            send_json(self, {"error": "Internal server error"}, 500)
            print(f"[ml_predict/zone] Error: {e}")

    def _handle_resolution(self, qs, parsed):
        try:
            alert_id = qs.get('alertId', qs.get('alert_id', [None]))[0]
            if not alert_id:
                parts = parsed.path.rstrip('/').split('/')
                alert_id = parts[-1] if parts[-1].isdigit() else None
            if not alert_id:
                send_json(self, {"error": "alert_id required"}, 400)
                return
            alert_id = int(alert_id)
            cache_key = f"resolution:{alert_id}"

            conn = get_conn()
            cur = conn.cursor()
            try:
                cached = get_cached(cur, cache_key)
            finally:
                cur.close()
                conn.close()

            if cached is not None:
                send_json(self, cached)
                return

            send_json(self, {**_CACHE_MISS_BODY, "alert_id": alert_id}, 503)

        except ValueError as e:
            send_json(self, {"error": str(e)}, 404)
        except Exception as e:
            send_json(self, {"error": "Internal server error"}, 500)
            print(f"[ml_predict/resolution] Error: {e}")

    def _handle_batch(self, qs):
        zone_ids_raw = qs.get('zoneIds', [''])[0]
        alert_ids_raw = qs.get('alertIds', [''])[0]
        zone_ids = [int(z) for z in zone_ids_raw.split(',') if z.strip().isdigit()][:MAX_BATCH_SIZE]
        alert_ids = [int(a) for a in alert_ids_raw.split(',') if a.strip().isdigit()][:MAX_BATCH_SIZE]

        if not zone_ids and not alert_ids:
            send_json(self, {"error": "Provide at least one of zoneIds or alertIds (comma-separated)"}, 400)
            return

        zones_result = {}
        resolutions_result = {}

        conn = get_conn()
        cur = conn.cursor()
        try:
            for zone_id in zone_ids:
                cache_key = f"zone:{zone_id}"
                cached = get_cached(cur, cache_key)
                if cached is not None:
                    zones_result[str(zone_id)] = cached
                else:
                    zones_result[str(zone_id)] = {**_CACHE_MISS_BODY, "zone_id": zone_id}

            for alert_id in alert_ids:
                cache_key = f"resolution:{alert_id}"
                cached = get_cached(cur, cache_key)
                if cached is not None:
                    resolutions_result[str(alert_id)] = cached
                else:
                    resolutions_result[str(alert_id)] = {**_CACHE_MISS_BODY, "alert_id": alert_id}
        finally:
            cur.close()
            conn.close()

        send_json(self, {"zones": zones_result, "resolutions": resolutions_result})
