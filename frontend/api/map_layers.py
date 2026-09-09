"""
Combines earthquakes.py + rivers.py into one Vercel Function — both were
simple read-only "return all rows" endpoints with no params, so merging
them costs nothing functionally and frees a function slot for ml_predict.py
(see vercel.json: /api/earthquakes and /api/rivers both rewrite here now,
so no frontend fetch call sites needed to change).
"""
from http.server import BaseHTTPRequestHandler
import sys, os, json
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, os.path.dirname(__file__))
from _helpers import get_conn, send_json, send_cors_preflight


class handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args): pass

    def do_OPTIONS(self):
        send_cors_preflight(self)

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        layer = (qs.get('type', [None])[0] or '').lower()

        if not layer:
            if 'rivers' in parsed.path:
                layer = 'rivers'
            elif 'earthquakes' in parsed.path:
                layer = 'earthquakes'

        if layer == 'earthquakes':
            self._handle_earthquakes()
        elif layer == 'rivers':
            self._handle_rivers()
        else:
            send_json(self, {"error": "Unknown or missing layer type. Expected ?type=earthquakes or ?type=rivers."}, 400)

    def _handle_earthquakes(self):
        try:
            conn = get_conn()
            cur = conn.cursor()
            display_all = os.environ.get("DISPLAY_ALL_EARTHQUAKES", "false").lower() == "true"
            limit = "" if display_all else "LIMIT 5"
            cur.execute(f"""
                SELECT event_id, magnitude, depth_km, latitude, longitude,
                       event_timestamp, location, impact_radius_km
                FROM earthquake_events ORDER BY event_timestamp DESC {limit}
            """)
            rows = cur.fetchall()
            cur.close(); conn.close()
            result = []
            for q in rows:
                result.append({
                    "event_id": q["event_id"],
                    "magnitude": float(q["magnitude"]) if q["magnitude"] else None,
                    "depth_km": float(q["depth_km"]) if q["depth_km"] else None,
                    "latitude": float(q["latitude"]) if q["latitude"] else None,
                    "longitude": float(q["longitude"]) if q["longitude"] else None,
                    "event_timestamp": q["event_timestamp"].isoformat() if q["event_timestamp"] else None,
                    "location": q["location"],
                    "wilayah": q["location"],
                    "potensi": "Tidak berpotensi tsunami",
                    "depth": f"{q['depth_km']} km" if q["depth_km"] else None,
                    "datetime": q["event_timestamp"].isoformat() if q["event_timestamp"] else None,
                    "impact_radius_km": float(q["impact_radius_km"]) if q["impact_radius_km"] else None,
                })
            send_json(self, result)
        except Exception as e:
            send_json(self, {"error": "Internal server error"}, 500)
            print(f"[map_layers/earthquakes] Error: {e}")

    def _handle_rivers(self):
        try:
            conn = get_conn()
            cur = conn.cursor()
            cur.execute("""
                SELECT hyriv_id, name, main_riv, length_km, dis_av_cms,
                       current_discharge_cms, discharge_ratio, alert_level,
                       last_updated, coordinates_json
                FROM jabodetabek_waterways
            """)
            rows = cur.fetchall()
            cur.close(); conn.close()
            result = []
            for w in rows:
                dis_av = float(w["dis_av_cms"] or 1)
                current = float(w["current_discharge_cms"]) if w["current_discharge_cms"] is not None else dis_av
                cap_pct = round((current / (dis_av * 2)) * 100, 1) if dis_av > 0 else 0
                coords = []
                if w["coordinates_json"]:
                    try: coords = json.loads(w["coordinates_json"])
                    except: pass
                result.append({
                    "hyriv_id": w["hyriv_id"], "main_riv": w["main_riv"],
                    "average_discharge_cms": dis_av, "current_discharge_cms": current,
                    "alert_level": w["alert_level"] or "Normal",
                    "last_updated": w["last_updated"].isoformat() if w["last_updated"] else None,
                    "name": (w["name"] or "").strip() or f"Waterway {w['hyriv_id']}",
                    "category": "river",
                    "current_level": current, "max_capacity": round(dis_av * 2, 2),
                    "capacity_percentage": cap_pct, "coordinates": coords,
                })
            send_json(self, result)
        except Exception as e:
            send_json(self, {"error": "Internal server error"}, 500)
            print(f"[map_layers/rivers] Error: {e}")
