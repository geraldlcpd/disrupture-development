/**
 * DIS-RUPTURE Service Worker
 * Combines:
 *   1. Workbox precaching (injected by vite-plugin-pwa at build time)
 *   2. Runtime caching strategies (API, fonts, external assets)
 *   3. Push notification handlers (alert notifications from backend)
 */

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

// ── 1. Precaching ─────────────────────────────────────────────────
// vite-plugin-pwa injects the manifest here at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── 2. Runtime Caching ────────────────────────────────────────────
// CARTO map tiles are NOT intercepted here — Leaflet loads them as <img>
// subresources. SW CacheFirst on cross-origin tiles causes net::ERR_FAILED
// (opaque response / request-mode mismatch). Browser HTTP cache handles tiles.

// Vercel API endpoints — Network First, 8s timeout, 5min cache
// Always try live data first; fall back to cached alerts if offline
registerRoute(
  ({ url }) =>
    url.hostname === 'taichi-no-kaze.vercel.app' &&
    url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'api-cache',
    networkTimeoutSeconds: 8,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 5 * 60, // 5 minutes
      }),
    ],
  })
);

// Google Fonts — Cache First, 1 year
registerRoute(
  ({ url }) =>
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// External tile providers (OpenStreetMap fallback, Leaflet CDN)
registerRoute(
  ({ url }) =>
    url.hostname.endsWith('.openstreetmap.org') ||
    url.hostname === 'unpkg.com',
  new StaleWhileRevalidate({
    cacheName: 'external-assets',
    plugins: [
      new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 24 * 60 * 60 }),
    ],
  })
);

// ── 3. Push Notification Handlers & On-Device Geofence ────────────
import { resolveNotificationBody } from './utils/geofenceNotification';

const DB_NAME = 'disrupture_location_db';
const DB_VERSION = 2;
const LOCATION_STORE = 'user_location';
const PREFERENCES_STORE = 'user_preferences';
const LOCATION_KEY = 'latest';
const PREFERENCES_KEY = 'notification';

function openDisruptureDB() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => resolve(null);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(LOCATION_STORE)) {
        db.createObjectStore(LOCATION_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PREFERENCES_STORE)) {
        db.createObjectStore(PREFERENCES_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
  });
}

// Reads a single key from a named store and ALWAYS closes the DB connection
// afterward. Leaving IndexedDB connections open across push events was the
// root cause of "push works once, then silently nothing forever" on
// Android: an unclosed handle from a previous push can block or stall the
// next indexedDB.open() call, which prevents this function from ever
// resolving, which prevents showNotification() from ever being called.
// Chrome on Android silently penalizes origins that repeatedly fail to
// show a notification for a push event, with no error surfaced back to
// the server — so a leaked connection here is invisible everywhere except
// as "notifications just stopped."
function readFromStore(storeName, key) {
  return new Promise(async (resolve) => {
    const db = await openDisruptureDB();
    if (!db) {
      resolve(null);
      return;
    }
    if (!db.objectStoreNames.contains(storeName)) {
      db.close();
      resolve(null);
      return;
    }
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      db.close();
      resolve(getReq.result || null);
    };
    getReq.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}

function readLocationFromIDB() {
  return readFromStore(LOCATION_STORE, LOCATION_KEY);
}

function readPreferencesFromIDB() {
  return readFromStore(PREFERENCES_STORE, PREFERENCES_KEY);
}

// DEBUG-SW-IDB-LOC-001 — start (remove this entire block when done debugging)
const DEBUG_SW_GEOFENCE = true;

function debugSwGeofence(event, { cachedLocation, prefs, payload, body, reason }) {
  if (!DEBUG_SW_GEOFENCE) return;

  const now = Date.now();
  const ts = cachedLocation?.timestamp;
  const ageMin = ts ? Math.round((now - Number(ts)) / 60000) : null;

  console.log('[DEBUG-SW-IDB-LOC-001] IDB location read', {
    event,
    found: Boolean(cachedLocation),
    hasCoords: cachedLocation ? Number.isFinite(Number(cachedLocation.lat)) && Number.isFinite(Number(cachedLocation.lng)) : false,
    ageMinutes: ageMin,
  });

  console.log('[DEBUG-SW-IDB-LOC-001] IDB prefs read', {
    event,
    found: Boolean(prefs),
    radiusKm: prefs?.radiusKm ?? 5,
    enabled: prefs?.enabled ?? null,
  });

  console.log('[DEBUG-SW-IDB-LOC-001] geofence decision', { event, reason, bodyPreview: body?.slice(0, 80) ?? null });
}
// DEBUG-SW-IDB-LOC-001 — end

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      // CRITICAL: Chrome enforces that every 'push' event results in a
      // call to showNotification(). If our geofence/IndexedDB logic
      // throws anywhere and this whole handler rejects without ever
      // calling showNotification(), Chrome treats it as a contract
      // violation. On Android this is enforced strictly — repeated
      // violations cause Chrome to silently degrade or suppress future
      // push delivery for this origin, with NO error ever surfaced back
      // to the server. Fix: wrap everything in try/catch and fail OPEN
      // (show a generic notification) rather than fail silently.
      let payload = {};
      try {
        payload = event.data?.json?.() || {};
      } catch (error) {
        payload = {};
      }

      const title = payload.title || 'DIS-RUPTURE Alert';
      let body = payload.body || payload.message || 'A disruption alert was detected nearby.';
      let shouldShow = true;
      let useFallbackTag = false;

      try {
        const [cachedLocation, prefs] = await Promise.all([
          readLocationFromIDB(),
          readPreferencesFromIDB(),
        ]);

        // resolveNotificationBody() now genuinely suppresses (shouldShow:
        // false) when the user is outside their configured radius from
        // the alert zone. Any unexpected error below still fails OPEN
        // (shows unfiltered) — better to over-notify on a bug than to
        // silently drop a real alert.
        const resolved = resolveNotificationBody({ payload, cachedLocation, prefs });
        body = resolved.body;
        shouldShow = resolved.shouldShow;
        useFallbackTag = Boolean(resolved.useFallbackTag);

        debugSwGeofence('push', { cachedLocation, prefs, payload, body, reason: resolved.reason });
      } catch (geofenceError) {
        // Geofence logic broke for any reason — fail OPEN (show the
        // notification anyway) rather than fail silently. A shown
        // notification the user didn't strictly need is far better
        // than an origin that Chrome quietly stops delivering to.
        console.log('[SW Geofence] Error during proximity check — showing notification without filtering:', geofenceError);
        shouldShow = true;
      }

      if (!shouldShow) {
        return;
      }

      const options = {
        body,
        icon:  payload.icon  || '/icons/icon-192.png',
        badge: payload.badge || '/icons/icon-192.png',
        // When we have no location to filter by, every fallback
        // notification carries the same generic message — give them a
        // SHARED, fixed tag so Android/Chrome replaces the existing
        // notification instead of stacking a new card each time. Real,
        // location-filtered alerts keep their per-zone/per-type tag so
        // genuinely different alerts still show as separate cards.
        tag: useFallbackTag ? 'dis-rupture-fallback' : (payload.tag || 'dis-rupture-alert'),
        renotify: true,
        data: {
          url: payload.url || payload.map_link || '/',
        },
      };

      try {
        await self.registration.showNotification(title, options);
      } catch (showError) {
        // Last-resort fallback — even a bare-minimum notification
        // satisfies Chrome's per-push contract.
        console.log('[SW Push] showNotification failed, retrying minimal:', showError);
        await self.registration.showNotification(title, { body });
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';
  const url = new URL(targetUrl, self.location.origin).toString();

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (clientList) => {
        // Prefer an already-open window over opening a new one, but
        // ALWAYS navigate it to the deep-link URL first — matching only
        // on exact URL string (old behavior) meant an app already open
        // at "/" would never match "/?alert_id=123&zone_id=45", silently
        // falling through to openWindow(), which on an already-running
        // PWA often just refocuses the existing window WITHOUT applying
        // the new URL — the tap would appear to "do nothing" beyond
        // bringing the app to the front at whatever page it was already on.
        const existingClient = clientList.find((c) => 'focus' in c);

        if (existingClient) {
          try {
            if ('navigate' in existingClient) {
              await existingClient.navigate(url);
            }
          } catch (navError) {
            // navigate() can be blocked/unsupported in some browsers —
            // fall through to focus() below regardless so the tap still
            // does SOMETHING visible even if the deep link didn't apply.
            console.log('[SW] client.navigate failed:', navError);
          }
          return existingClient.focus();
        }

        if (clients.openWindow) {
          return clients.openWindow(url);
        }
        return Promise.resolve();
      })
  );
});

// ── 4. Auto-update: skip waiting so new SW activates immediately ──
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
