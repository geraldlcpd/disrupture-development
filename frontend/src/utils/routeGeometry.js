/**
 * Polyline geometry for live navigation: cumulative distance, snap-to-route,
 * heading, and traveled/remaining splits.
 *
 * Coordinates follow GeoJSON / TomTom order: [lon, lat].
 */

import { calculateDistanceKm } from './haversine.js';

const METERS_PER_DEG_LAT = 111_320;
const DEFAULT_SEARCH_WINDOW = 80;
const FULL_SEARCH_OFF_ROUTE_M = 200;

export function distanceMeters(lat1, lon1, lat2, lon2) {
  return calculateDistanceKm(lat1, lon1, lat2, lon2) * 1000;
}

function toXY(lat, lon, lat0) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  return {
    x: lon * METERS_PER_DEG_LAT * (Math.abs(cos) < 1e-9 ? 1e-9 : cos),
    y: lat * METERS_PER_DEG_LAT,
  };
}

function fromXY(x, y, lat0) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const safeCos = Math.abs(cos) < 1e-9 ? 1e-9 : cos;
  return {
    lat: y / METERS_PER_DEG_LAT,
    lon: x / (METERS_PER_DEG_LAT * safeCos),
  };
}

function projectPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    const dist = Math.hypot(px - ax, py - ay);
    return { t: 0, x: ax, y: ay, dist };
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { t, x, y, dist: Math.hypot(px - x, py - y) };
}

function isValidCoord(coord) {
  return (
    Array.isArray(coord)
    && coord.length >= 2
    && Number.isFinite(coord[0])
    && Number.isFinite(coord[1])
  );
}

export function buildRouteIndex(coordinates) {
  const coords = Array.isArray(coordinates) ? coordinates.filter(isValidCoord) : [];
  const cumulativeM = [0];
  for (let i = 1; i < coords.length; i += 1) {
    const [lon0, lat0] = coords[i - 1];
    const [lon1, lat1] = coords[i];
    cumulativeM.push(cumulativeM[i - 1] + distanceMeters(lat0, lon0, lat1, lon1));
  }
  return {
    coordinates: coords,
    cumulativeM,
    lengthM: cumulativeM[cumulativeM.length - 1] ?? 0,
    segmentCount: Math.max(0, coords.length - 1),
  };
}

function emptyProjection() {
  return {
    snappedLat: null,
    snappedLon: null,
    segmentIndex: 0,
    t: 0,
    distanceAlongM: 0,
    offRouteM: Infinity,
  };
}

function searchRange(routeIndex, hintIndex, windowSize) {
  const n = routeIndex.segmentCount;
  if (n <= 0) return { start: 0, end: -1 };
  if (!Number.isFinite(hintIndex)) return { start: 0, end: n - 1 };
  const clamped = Math.max(0, Math.min(n - 1, Math.round(hintIndex)));
  return {
    start: Math.max(0, clamped - windowSize),
    end: Math.min(n - 1, clamped + windowSize),
  };
}

function projectInRange(lat, lon, routeIndex, start, end) {
  let best = emptyProjection();
  const coords = routeIndex.coordinates;
  for (let i = start; i <= end; i += 1) {
    const [lonA, latA] = coords[i];
    const [lonB, latB] = coords[i + 1];
    const lat0 = (latA + latB) / 2;
    const p = toXY(lat, lon, lat0);
    const a = toXY(latA, lonA, lat0);
    const b = toXY(latB, lonB, lat0);
    const proj = projectPointOnSegment(p.x, p.y, a.x, a.y, b.x, b.y);
    if (proj.dist < best.offRouteM) {
      const snapped = fromXY(proj.x, proj.y, lat0);
      const segLen = routeIndex.cumulativeM[i + 1] - routeIndex.cumulativeM[i];
      best = {
        snappedLat: snapped.lat,
        snappedLon: snapped.lon,
        segmentIndex: i,
        t: proj.t,
        distanceAlongM: routeIndex.cumulativeM[i] + proj.t * segLen,
        offRouteM: proj.dist,
      };
    }
  }
  return best;
}

export function projectOntoRoute(lat, lon, routeIndex, hintIndex, windowSize = DEFAULT_SEARCH_WINDOW) {
  if (!routeIndex || routeIndex.segmentCount < 1 || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return emptyProjection();
  }

  const windowed = searchRange(routeIndex, hintIndex, windowSize);
  let best = projectInRange(lat, lon, routeIndex, windowed.start, windowed.end);

  const needsFullSearch =
    Number.isFinite(hintIndex)
    && (best.offRouteM > FULL_SEARCH_OFF_ROUTE_M || !Number.isFinite(best.offRouteM));
  if (needsFullSearch) {
    const full = projectInRange(lat, lon, routeIndex, 0, routeIndex.segmentCount - 1);
    if (full.offRouteM < best.offRouteM) best = full;
  }

  return best;
}

export function bearingBetween(lat1, lon1, lat2, lon2) {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLam = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

export function pointAtDistance(routeIndex, distanceAlongM) {
  if (!routeIndex || routeIndex.coordinates.length === 0) {
    return { lon: null, lat: null, segmentIndex: 0 };
  }
  const coords = routeIndex.coordinates;
  if (routeIndex.segmentCount < 1) {
    const [lon, lat] = coords[0];
    return { lon, lat, segmentIndex: 0 };
  }

  const target = Math.max(0, Math.min(routeIndex.lengthM, distanceAlongM ?? 0));
  let i = 0;
  while (i < routeIndex.segmentCount - 1 && routeIndex.cumulativeM[i + 1] < target) {
    i += 1;
  }
  const startM = routeIndex.cumulativeM[i];
  const endM = routeIndex.cumulativeM[i + 1];
  const segLen = endM - startM;
  const t = segLen > 1e-6 ? (target - startM) / segLen : 0;
  const [lonA, latA] = coords[i];
  const [lonB, latB] = coords[i + 1];
  return {
    lon: lonA + (lonB - lonA) * t,
    lat: latA + (latB - latA) * t,
    segmentIndex: i,
  };
}

export function bearingAlongRoute(routeIndex, distanceAlongM, lookAheadM = 20) {
  if (!routeIndex || routeIndex.segmentCount < 1) return 0;
  const from = pointAtDistance(routeIndex, distanceAlongM);
  const to = pointAtDistance(routeIndex, (distanceAlongM ?? 0) + lookAheadM);
  if (!Number.isFinite(from.lat) || !Number.isFinite(to.lat)) return 0;
  if (from.lat === to.lat && from.lon === to.lon) {
    const last = routeIndex.coordinates[routeIndex.coordinates.length - 1];
    const prev = routeIndex.coordinates[Math.max(0, routeIndex.coordinates.length - 2)];
    return bearingBetween(prev[1], prev[0], last[1], last[0]);
  }
  return bearingBetween(from.lat, from.lon, to.lat, to.lon);
}

export function splitRouteAtDistance(routeIndex, distanceAlongM) {
  if (!routeIndex || routeIndex.coordinates.length === 0) {
    return { traveled: [], remaining: [] };
  }
  const coords = routeIndex.coordinates;
  if (routeIndex.segmentCount < 1) {
    return { traveled: [coords[0]], remaining: [coords[0]] };
  }

  const target = Math.max(0, Math.min(routeIndex.lengthM, distanceAlongM ?? 0));
  const split = pointAtDistance(routeIndex, target);
  const splitCoord = [split.lon, split.lat];

  const traveled = [];
  for (let i = 0; i <= split.segmentIndex; i += 1) {
    traveled.push(coords[i]);
  }
  traveled.push(splitCoord);

  const remaining = [splitCoord];
  for (let i = split.segmentIndex + 1; i < coords.length; i += 1) {
    remaining.push(coords[i]);
  }

  return { traveled, remaining };
}
