/**
 * Follow-camera helpers for live navigation (north-up Leaflet).
 */

import { distanceMeters } from './routeGeometry.js';

export function zoomForSpeed(speedKmh, { maneuverWithinM } = {}) {
  if (Number.isFinite(maneuverWithinM) && maneuverWithinM < 200) return 18;
  if (!Number.isFinite(speedKmh) || speedKmh < 8) return 18;
  if (speedKmh < 30) return 17;
  if (speedKmh < 60) return 16;
  return 15;
}

const LOOK_AHEAD_M = { 18: 40, 17: 80, 16: 140, 15: 220 };

export function lookAheadCenter({ lat, lon, headingDeg = 0, zoom = 17 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat, lon };
  const metres = LOOK_AHEAD_M[zoom] ?? 80;
  const rad = ((Number.isFinite(headingDeg) ? headingDeg : 0) * Math.PI) / 180;
  const dLat = (metres * Math.cos(rad)) / 111320;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLon = (metres * Math.sin(rad)) / (111320 * (Math.abs(cosLat) < 1e-9 ? 1e-9 : cosLat));
  return { lat: lat + dLat, lon: lon + dLon };
}

export function headingDeltaDeg(a, b) {
  const d = Math.abs((Number(a) || 0) - (Number(b) || 0)) % 360;
  return d > 180 ? 360 - d : d;
}

export function shouldApplyCameraUpdate(prev, next, { minMoveM = 4, minHeadingDeg = 8 } = {}) {
  if (!prev) return true;
  if (prev.zoom !== next.zoom) return true;
  if (!Number.isFinite(prev.lat) || !Number.isFinite(next.lat)) return true;
  if (distanceMeters(prev.lat, prev.lon, next.lat, next.lon) >= minMoveM) return true;
  return headingDeltaDeg(prev.heading, next.heading) >= minHeadingDeg;
}
