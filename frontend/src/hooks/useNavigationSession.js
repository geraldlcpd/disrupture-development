import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTomtomRoute } from '../utils/tomtomRoute.js';
import {
  applyFetchedVariant,
  applyLocationTick,
  applyRerouteFailure,
  applyRerouteSuccess,
  applyVariantSwitch,
  buildAvoidRects,
  createNavigationSession,
  inspectVariantSwitch,
  markRerouting,
  shouldAutoReroute,
} from '../utils/navigationSession.js';

/**
 * Live navigation session. Mount only while the user is in Start Driving.
 * Session identity is created when `enabled` becomes true so later GPS ticks
 * do not reset progress.
 */
export function useNavigationSession({
  enabled = false,
  destination = null,
  routes = null,
  activeKey = 'safer',
  location = null,
  predictions = [],
  threatZones = [],
  apiKey = '',
} = {}) {
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  sessionRef.current = session;
  const initRef = useRef({ destination, activeKey, routes, threatZones });
  initRef.current = { destination, activeKey, routes, threatZones };
  const rerouteLockRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      rerouteLockRef.current = false;
      setSession(null);
      return undefined;
    }
    const init = initRef.current;
    if (!init.routes) return undefined;
    setSession(createNavigationSession({
      destination: init.destination,
      activeKey: init.activeKey,
      routes: init.routes,
      threatZones: init.threatZones,
    }));
    return undefined;
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !location) return;
    setSession((current) => (
      current ? applyLocationTick(current, location, { predictions, now: Date.now() }) : current
    ));
  }, [enabled, location, predictions]);

  useEffect(() => {
    const current = sessionRef.current;
    if (!enabled || !current || !location || !apiKey || !destination) return undefined;
    if (rerouteLockRef.current) return undefined;
    if (!shouldAutoReroute(current)) return undefined;

    let cancelled = false;
    rerouteLockRef.current = true;
    setSession((s) => (s ? markRerouting(s) : s));

    const origin = { lat: location.lat, lon: location.lon };
    const dest = { lat: destination.lat, lon: destination.lon };
    const avoidRects = current.activeKey === 'safer' ? buildAvoidRects(threatZones) : [];

    fetchTomtomRoute({
      apiKey,
      origin,
      dest,
      avoidRects,
      travelMode: 'car',
    })
      .then((route) => {
        if (cancelled) return;
        setSession((s) => (s ? applyRerouteSuccess(s, route, Date.now(), location) : s));
      })
      .catch(() => {
        if (cancelled) return;
        setSession((s) => (s ? applyRerouteFailure(s, Date.now()) : s));
      })
      .finally(() => {
        rerouteLockRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    apiKey,
    destination,
    location,
    threatZones,
    session?.status,
    session?.offRouteSince,
    session?.rerouteCount,
  ]);

  const switchVariant = useCallback(async (key) => {
    const current = sessionRef.current;
    if (!current || !key || key === current.activeKey) return current;

    const inspection = inspectVariantSwitch(current, key, location);
    if (!inspection.needsFetch) {
      const next = applyVariantSwitch(current, key, Date.now(), location);
      setSession(next);
      return next;
    }

    if (!apiKey || !destination || !location) {
      return current;
    }

    const origin = { lat: location.lat, lon: location.lon };
    const dest = { lat: destination.lat, lon: destination.lon };
    const avoidRects = key === 'safer' ? buildAvoidRects(threatZones) : [];
    const route = await fetchTomtomRoute({
      apiKey,
      origin,
      dest,
      avoidRects,
      travelMode: 'car',
    });
    const next = applyFetchedVariant(current, key, route, Date.now(), location);
    setSession(next);
    return next;
  }, [apiKey, destination, location, threatZones]);

  return { session, switchVariant };
}
