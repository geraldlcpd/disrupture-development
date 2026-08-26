"""
test_push_direct.py — sends a real test push notification directly,
bypassing the entire worker ingestion / scoring cycle / alert system.

Usage:
    cd worker
    DATABASE_URL="postgresql://..." \\
    VAPID_PRIVATE_KEY="..." \\
    VAPID_SUBJECT="mailto:you@email.com" \\
    python3 test_push_direct.py

Optional: pass --endpoint-contains "e1VO" to target only one specific
subscription (useful when you have multiple test devices and only want
to ping one), otherwise sends to ALL subscriptions in the table.
"""
import os
import sys
import json
import argparse

import psycopg2
import psycopg2.extras

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(__file__))
# Load worker/.env if present
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from push_sender import _matches_preferences  # reuse real preference logic


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint-contains", default=None,
                         help="Only send to subscriptions whose endpoint contains this substring")
    parser.add_argument("--severity", default="HIGH", choices=["MEDIUM", "HIGH", "CRITICAL"])
    parser.add_argument("--disruption-type", default="crowd",
                         choices=["traffic", "crowd", "weather", "waterway", "earthquake"])
    parser.add_argument("--lat", type=float, default=-6.2,
                         help="Fake alert zone latitude — set this near your device's real location to test the 'should show' path, or far away to test the 'should suppress' path")
    parser.add_argument("--lng", type=float, default=106.8,
                         help="Fake alert zone longitude")
    parser.add_argument("--radius-km", type=float, default=5.0,
                         help="threshold_km sent in the payload")
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    vapid_private_key = os.environ.get("VAPID_PRIVATE_KEY")
    vapid_subject = os.environ.get("VAPID_SUBJECT", "mailto:test@example.com")

    if not db_url:
        print("❌ DATABASE_URL not set")
        sys.exit(1)
    if not vapid_private_key:
        print("❌ VAPID_PRIVATE_KEY not set")
        sys.exit(1)

    import ssl
    import urllib3
    import requests
    
    # Disable SSL verification warnings and force requests to bypass SSL verification
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    ssl._create_default_https_context = ssl._create_unverified_context
    os.environ["PYTHONHTTPSVERIFY"] = "0"
    
    # Monkey patch requests Session to force verify=False in pywebpush
    orig_request = requests.Session.request
    def unverified_request(self, *args, **kwargs):
        kwargs["verify"] = False
        return orig_request(self, *args, **kwargs)
    requests.Session.request = unverified_request

    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        print("❌ Run: pip install pywebpush --break-system-packages")
        sys.exit(1)

    # Disable SSL cert verification for PostgreSQL (allow self-signed certs)
    ssl_mode = "prefer" if "localhost" in db_url or "127.0.0.1" in db_url else "require"
    conn = psycopg2.connect(db_url, sslmode=ssl_mode, cursor_factory=psycopg2.extras.RealDictCursor)
    cur = conn.cursor()
    cur.execute("""
        SELECT id, endpoint, p256dh, auth, preferences
        FROM push_subscriptions
        WHERE p256dh IS NOT NULL AND p256dh != ''
          AND auth IS NOT NULL AND auth != ''
        ORDER BY id ASC
    """)
    subs = cur.fetchall()
    cur.close()
    conn.close()

    if args.endpoint_contains:
        subs = [s for s in subs if args.endpoint_contains in s["endpoint"]]

    print(f"Found {len(subs)} valid subscription(s) to test")
    print(f"Fake alert zone: ({args.lat}, {args.lng}), threshold_km={args.radius_km}")
    print("Note: whether this actually appears on each device depends on that")
    print("device's own service worker comparing this against its last saved")
    print("location in IndexedDB \u2014 that decision happens client-side and is")
    print("NOT visible in this script's output.\n")

    if not subs:
        print("No subscriptions match. Nothing to send.")
        return

    # Fake alert dict — same shape push_sender.py expects, no DB writes involved
    test_alert = {
        "alert_id": None,
        "zone_id": 0,
        "zone_name": "Test Zone (manual push test)",
        "disruption_type": args.disruption_type,
        "severity": args.severity,
        "probability_percentage": 75.0,
        "message": f"This is a manual test push \u2014 {args.severity} {args.disruption_type} at Test Zone.",
        "zone_lat": args.lat,
        "zone_lng": args.lng,
        "threshold_km": args.radius_km,
    }

    payload = {
        "title": f"DIS-RUPTURE Test \u2014 {args.severity} Alert",
        "body": test_alert["message"],
        "alert_id": test_alert["alert_id"],
        "zone_id": test_alert["zone_id"],
        "zone_name": test_alert["zone_name"],
        "severity": test_alert["severity"],
        "disruption_type": test_alert["disruption_type"],
        "zone_lat": test_alert["zone_lat"],
        "zone_lng": test_alert["zone_lng"],
        "threshold_km": test_alert["threshold_km"],
        "url": "/",
        "map_link": "/",
        "icon": "/icons/icon-192.png",
        "badge": "/icons/icon-192.png",
        "tag": "test-push",
    }

    sent, skipped, failed = 0, 0, 0

    for sub in subs:
        sub_id = sub.get("id", "?")
        endpoint = sub.get("endpoint", "")
        prefs = {}
        try:
            raw = sub.get("preferences")
            prefs = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:
            prefs = {}

        if not _matches_preferences(test_alert, prefs):
            print(f"⏭️  [ID {sub_id}] Skipped (preferences don't match):\n   {endpoint}\n")
            skipped += 1
            continue

        try:
            webpush(
                subscription_info={
                    "endpoint": endpoint,
                    "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
                },
                data=json.dumps(payload),
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": vapid_subject},
                ttl=300,
            )
            print(f"✅ [ID {sub_id}] Sent:\n   {endpoint}\n")
            sent += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", "?") if hasattr(e, "response") else "?"
            body = getattr(e.response, "text", "") if hasattr(e, "response") else ""
            print(f"❌ [ID {sub_id}] Failed ({status}):\n   {endpoint}")
            if body:
                print(f"   Response: {body.strip()}")
            print()
            failed += 1
        except Exception as e:
            print(f"❌ [ID {sub_id}] Error:\n   {endpoint}\n   Details: {e}\n")
            failed += 1

    print(f"\n--- Summary ---")
    print(f"Sent: {sent} | Skipped (prefs): {skipped} | Failed: {failed}")


if __name__ == "__main__":
    main()
