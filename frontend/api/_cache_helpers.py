"""
Shared short-TTL cache for final ML prediction results, backed by Postgres
(ml_prediction_cache table — see db-migration/002_add_ml_prediction_cache.sql)
rather than an in-process dict.

Why a DB table instead of a plain in-memory cache: Vercel can run multiple
concurrent instances of the same function, and each cold start gets a fresh
process with empty memory. An in-memory cache only helps if the *same* warm
instance happens to handle a later request — and /api/ml_predict runs cold
most of the time in practice (observed ~40 invocations per 12 hours), so an
in-memory-only cache would rarely even get the chance to be hit. A shared
table sidesteps this: cold or warm, whichever instance handles the request,
the cached result is either there or it isn't.

Caching the FINAL response (not intermediate features) means a cache hit
skips everything expensive — the feature-building queries, model loading,
AND inference — replacing all of it with one indexed row lookup.
"""
import json
from datetime import datetime, timezone

# 15 minutes — matches the worker's ~15-minute ingestion/scoring cycle so a
# successful local batch keeps Vercel on the cache-only fast path until the
# next worker refresh.
CACHE_TTL_SECONDS = 900


def get_cached(cur, cache_key: str):
    """Returns the cached result dict if present and still fresh, else None.
    Any failure here (e.g. table doesn't exist yet, migration not applied)
    is treated as a cache miss rather than an error — caching is purely an
    optimization and must never be able to break the actual response."""
    try:
        cur.execute(
            "SELECT result_json, computed_at FROM ml_prediction_cache WHERE cache_key = %s",
            (cache_key,),
        )
        row = cur.fetchone()
    except Exception as e:
        print(f"[cache] Read failed for {cache_key} (treating as miss): {e}")
        return None

    if not row:
        return None

    computed_at = row["computed_at"]
    if computed_at.tzinfo is None:
        computed_at = computed_at.replace(tzinfo=timezone.utc)
    age_seconds = (datetime.now(timezone.utc) - computed_at).total_seconds()
    if age_seconds > CACHE_TTL_SECONDS:
        return None

    try:
        result = json.loads(row["result_json"])
    except (TypeError, ValueError):
        return None

    result["_cache_hit"] = True  # visible in the response for easy verification while testing
    return result


def set_cached(cur, conn, cache_key: str, result: dict):
    """Upserts the result into the cache and commits. Wrapped defensively —
    a cache WRITE failure must never break the response the user is about
    to receive; the prediction was already computed successfully by the
    time this is called."""
    try:
        # Store a copy without the diagnostic flag, so a value that was
        # itself served from cache doesn't get re-cached with a stale marker.
        to_store = {k: v for k, v in result.items() if k != "_cache_hit"}
        cur.execute(
            """INSERT INTO ml_prediction_cache (cache_key, result_json, computed_at)
               VALUES (%s, %s, now())
               ON CONFLICT (cache_key) DO UPDATE
               SET result_json = EXCLUDED.result_json, computed_at = EXCLUDED.computed_at""",
            (cache_key, json.dumps(to_store, default=str)),
        )
        conn.commit()
    except Exception as e:
        print(f"[cache] Write failed for {cache_key} (result still returned to caller): {e}")
        try:
            conn.rollback()
        except Exception:
            pass
