/**
 * Pure navigation session state machine. React hooks wrap this; tests call it directly.
 */

import { findNearbyDisruptionsAlongRoute } from './nearbyDisruptionAlongRoute.js';
import {
  bearingAlongRoute,
  buildRouteIndex,
  distanceMeters,
  projectOntoRoute,
} from './routeGeometry.js';
import { circleToBbox } from './tomtomRoute.js';

export const OFF_ROUTE_M = 150;
export const OFF_ROUTE_HOLD_MS = 10_000;
export const REROUTE_MIN_INTERVAL_MS = 60_000;
export const MAX_REROUTES_PER_SESSION = 8;
export const ARRIVE_M = 60;
export const NEARBY_INTERVAL_MS = 20_000;
export const NEARBY_MOVE_M = 500;
export const SWITCH_OFF_ROUTE_M = 150;
export const MANEUVER_PASS_M = 20;

function routeCoordinates(route) {
  return route?.geometry?.coordinates ?? [];
}

function pickInitialRoute(routes, activeKey) {
  if (activeKey && routes?.[activeKey]) return { key: activeKey, route: routes[activeKey] };
  if (routes?.safer) return { key: 'safer', route: routes.safer };
  if (routes?.faster) return { key: 'faster', route: routes.faster };
  return { key: activeKey || 'faster', route: null };
}

function wrapRoute(route, stale = false) {
  return route ? { route, stale: Boolean(stale) } : null;
}

export function buildAvoidRects(threatZones, limit = 10) {
  return (threatZones ?? [])
    .filter((z) => Number.isFinite(z.lat) && Number.isFinite(z.lon))
    .slice(0, limit)
    .map((z) => circleToBbox(z.lat, z.lon, z.radius_m ?? 1000));
}

function upcomingManeuverIndex(maneuvers, distanceAlongM) {
  if (!maneuvers?.length) return 0;
  const idx = maneuvers.findIndex((m) => (m.offsetM ?? 0) > distanceAlongM + MANEUVER_PASS_M);
  if (idx === -1) return maneuvers.length - 1;
  return idx;
}

function locationFromSnap(proj, location, heading) {
  if (Number.isFinite(proj?.snappedLat)) {
    return { lat: proj.snappedLat, lon: proj.snappedLon, heading };
  }
  if (location) return { lat: location.lat, lon: location.lon, heading: location.heading ?? heading };
  return { lat: null, lon: null, heading };
}

function deriveProgress(route, routeIndex, maneuvers, location, proj, now) {
  const distanceAlongM = proj?.distanceAlongM ?? 0;
  const remainingM = Math.max(0, (routeIndex?.lengthM ?? 0) - distanceAlongM);
  const travelTimeSec = route?.travelTimeSec ?? (route?.durationMin ?? 0) * 60;
  const fraction = routeIndex?.lengthM > 0 ? remainingM / routeIndex.lengthM : 0;
  let remainingDurationSec = travelTimeSec * fraction;
  const speedKmh = Number.isFinite(location?.speedKmh) ? location.speedKmh : 0;
  if (speedKmh > 5 && remainingM > 0) {
    const fromSpeedSec = remainingM / (speedKmh / 3.6);
    remainingDurationSec = remainingDurationSec * 0.6 + fromSpeedSec * 0.4;
  }

  const manIdx = upcomingManeuverIndex(maneuvers, distanceAlongM);
  const currentManeuver = maneuvers[manIdx] ?? null;
  const nextManeuver = maneuvers[manIdx + 1] ?? null;
  const distanceToManeuverM = currentManeuver
    ? Math.max(0, (currentManeuver.offsetM ?? 0) - distanceAlongM)
    : remainingM;

  const heading = Number.isFinite(location?.heading)
    ? location.heading
    : bearingAlongRoute(routeIndex, distanceAlongM);

  const last = routeIndex?.coordinates?.[routeIndex.coordinates.length - 1];
  const destLat = last?.[1];
  const destLon = last?.[0];
  const distToDestM = location && Number.isFinite(destLat)
    ? distanceMeters(location.lat, location.lon, destLat, destLon)
    : remainingM;

  return {
    snapped: locationFromSnap(proj, location, heading),
    offRouteM: proj?.offRouteM ?? Infinity,
    segmentIndex: proj?.segmentIndex ?? 0,
    distanceAlongM,
    heading,
    speedKmh,
    currentManeuverIndex: manIdx,
    currentManeuver,
    nextManeuver,
    distanceToManeuverM,
    remainingDistanceKm: remainingM / 1000,
    remainingDurationSec,
    remainingDurationMin: Math.ceil(remainingDurationSec / 60),
    etaClock: now + remainingDurationSec * 1000,
    distToDestM,
  };
}

function attachRoute(state, route, now, location) {
  const routeIndex = buildRouteIndex(routeCoordinates(route));
  const maneuvers = route?.maneuvers ?? [];
  const proj = location
    ? projectOntoRoute(location.lat, location.lon, routeIndex)
    : {
      snappedLat: routeIndex.coordinates[0]?.[1] ?? null,
      snappedLon: routeIndex.coordinates[0]?.[0] ?? null,
      segmentIndex: 0,
      distanceAlongM: 0,
      offRouteM: 0,
    };
  const progress = deriveProgress(route, routeIndex, maneuvers, location, proj, now);
  return {
    ...state,
    route,
    routeIndex,
    maneuvers,
    hintIndex: proj.segmentIndex ?? 0,
    lastNearbyAt: 0,
    lastNearbyAtM: progress.distanceAlongM,
    nearbyDisruption: state.nearbyDisruption ?? null,
    ...progress,
  };
}

export function createNavigationSession({
  destination = null,
  activeKey = 'safer',
  routes = {},
  threatZones = [],
  now = Date.now(),
} = {}) {
  const picked = pickInitialRoute(routes, activeKey);
  const wrapped = {
    safer: wrapRoute(routes.safer),
    faster: wrapRoute(routes.faster),
  };
  const base = {
    destination,
    activeKey: picked.key,
    routes: wrapped,
    threatZones,
    status: picked.route ? 'navigating' : 'off_route',
    rerouteCount: 0,
    lastRerouteAt: 0,
    offRouteSince: null,
    nearbyDisruption: null,
    createdAt: now,
  };
  if (!picked.route) return base;
  return attachRoute(base, picked.route, now, null);
}

function shouldRefreshNearby(state, distanceAlongM, now) {
  if (!state.lastNearbyAt) return true;
  if (now - state.lastNearbyAt >= NEARBY_INTERVAL_MS) return true;
  if (Math.abs(distanceAlongM - state.lastNearbyAtM) >= NEARBY_MOVE_M) return true;
  return false;
}

export function applyLocationTick(state, location, { predictions = [], now = Date.now() } = {}) {
  if (!state?.routeIndex || !location || state.status === 'arrived') return state;

  const proj = projectOntoRoute(
    location.lat,
    location.lon,
    state.routeIndex,
    state.hintIndex
  );
  const progress = deriveProgress(
    state.route,
    state.routeIndex,
    state.maneuvers,
    location,
    proj,
    now
  );

  const arrived = progress.remainingDistanceKm * 1000 <= ARRIVE_M || progress.distToDestM <= ARRIVE_M;
  if (arrived) {
    return {
      ...state,
      ...progress,
      hintIndex: proj.segmentIndex,
      status: 'arrived',
      offRouteSince: null,
    };
  }

  let status = state.status;
  let offRouteSince = state.offRouteSince;
  if (status !== 'rerouting') {
    if (progress.offRouteM > OFF_ROUTE_M) {
      if (!offRouteSince) offRouteSince = now;
      status = 'off_route';
    } else {
      offRouteSince = null;
      status = 'navigating';
    }
  }

  let { nearbyDisruption, lastNearbyAt, lastNearbyAtM } = state;
  if (shouldRefreshNearby(state, progress.distanceAlongM, now)) {
    const list = findNearbyDisruptionsAlongRoute({
      predictions,
      routeIndex: state.routeIndex,
      distanceAlongM: progress.distanceAlongM,
    });
    nearbyDisruption = list[0] ?? null;
    lastNearbyAt = now;
    lastNearbyAtM = progress.distanceAlongM;
  }

  return {
    ...state,
    ...progress,
    hintIndex: proj.segmentIndex,
    status,
    offRouteSince,
    nearbyDisruption,
    lastNearbyAt,
    lastNearbyAtM,
  };
}

export function shouldAutoReroute(state, now = Date.now()) {
  if (!state || state.status === 'arrived' || state.status === 'rerouting') return false;
  if ((state.rerouteCount ?? 0) >= MAX_REROUTES_PER_SESSION) return false;
  if (!state.offRouteSince) return false;
  if (now - state.offRouteSince < OFF_ROUTE_HOLD_MS) return false;
  if (state.lastRerouteAt && now - state.lastRerouteAt < REROUTE_MIN_INTERVAL_MS) return false;
  return true;
}

export function rerouteLimitReached(state) {
  return (state?.rerouteCount ?? 0) >= MAX_REROUTES_PER_SESSION;
}

export function markRerouting(state) {
  if (!state) return state;
  return { ...state, status: 'rerouting' };
}

function locationHint(state) {
  if (Number.isFinite(state?.snapped?.lat)) {
    return {
      lat: state.snapped.lat,
      lon: state.snapped.lon,
      heading: state.heading,
      speedKmh: state.speedKmh,
    };
  }
  return null;
}

export function applyRerouteSuccess(state, newRoute, now = Date.now(), location = null) {
  const otherKey = state.activeKey === 'safer' ? 'faster' : 'safer';
  const routes = {
    ...state.routes,
    [state.activeKey]: wrapRoute(newRoute, false),
    [otherKey]: state.routes[otherKey]
      ? { ...state.routes[otherKey], stale: true }
      : null,
  };
  return attachRoute({
    ...state,
    routes,
    status: 'navigating',
    rerouteCount: (state.rerouteCount ?? 0) + 1,
    lastRerouteAt: now,
    offRouteSince: null,
    nearbyDisruption: null,
  }, newRoute, now, location || locationHint(state));
}

export function applyRerouteFailure(state, now = Date.now()) {
  if (!state) return state;
  return {
    ...state,
    status: 'off_route',
    lastRerouteAt: now,
    rerouteCount: (state.rerouteCount ?? 0) + 1,
  };
}

export function inspectVariantSwitch(state, key, location) {
  const entry = state?.routes?.[key];
  if (!key || key === state.activeKey) {
    return { needsFetch: false, reason: 'same' };
  }
  if (!entry?.route) {
    return { needsFetch: true, reason: 'missing' };
  }
  if (entry.stale) {
    return { needsFetch: true, reason: 'stale' };
  }
  if (!location) {
    return { needsFetch: false, reason: 'ok' };
  }
  const idx = buildRouteIndex(routeCoordinates(entry.route));
  const proj = projectOntoRoute(location.lat, location.lon, idx);
  if (proj.offRouteM > SWITCH_OFF_ROUTE_M) {
    return { needsFetch: true, reason: 'diverged' };
  }
  return { needsFetch: false, reason: 'ok' };
}

export function applyVariantSwitch(state, key, now = Date.now(), location = null) {
  const entry = state.routes[key];
  if (!entry?.route) return state;
  return attachRoute({
    ...state,
    activeKey: key,
    status: 'navigating',
    offRouteSince: null,
    nearbyDisruption: null,
  }, entry.route, now, location || locationHint(state));
}

export function applyFetchedVariant(state, key, route, now = Date.now(), location = null) {
  const routes = {
    ...state.routes,
    [key]: wrapRoute(route, false),
  };
  return attachRoute({
    ...state,
    routes,
    activeKey: key,
    status: 'navigating',
    offRouteSince: null,
    nearbyDisruption: null,
  }, route, now, location || locationHint(state));
}
