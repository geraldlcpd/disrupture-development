/**
 * GPS fix sanitising for live navigation: jump/accuracy filters and heading fallback.
 */

import { bearingBetween, distanceMeters } from './routeGeometry.js';

export const MAX_ACCURACY_M = 100;
export const MAX_IMPLIED_SPEED_KMH = 200;
export const MIN_HEADING_MOVE_M = 3;
export const LOCATION_PERSIST_INTERVAL_MS = 5000;

export function geolocationToFix(position) {
  const coords = position?.coords ?? {};
  return {
    lat: coords.latitude,
    lon: coords.longitude,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
    heading: Number.isFinite(coords.heading) ? coords.heading : null,
    speed: Number.isFinite(coords.speed) ? coords.speed : null,
    timestamp: Number.isFinite(position?.timestamp) ? position.timestamp : Date.now(),
  };
}

export function impliedSpeedKmh(prev, next) {
  if (!prev || !next) return 0;
  const dtSec = (next.timestamp - prev.timestamp) / 1000;
  if (dtSec <= 0) return Number.POSITIVE_INFINITY;
  const metres = distanceMeters(prev.lat, prev.lon, next.lat, next.lon);
  return (metres / dtSec) * 3.6;
}

export function headingFromFixes(prev, next) {
  if (!prev || !next) return next?.heading ?? null;
  const metres = distanceMeters(prev.lat, prev.lon, next.lat, next.lon);
  if (metres < MIN_HEADING_MOVE_M) return Number.isFinite(prev.heading) ? prev.heading : (next.heading ?? null);
  return bearingBetween(prev.lat, prev.lon, next.lat, next.lon);
}

export function acceptFix(prev, candidate, { navigating = true } = {}) {
  if (!Number.isFinite(candidate?.lat) || !Number.isFinite(candidate?.lon)) {
    return { accepted: false, reason: 'invalid' };
  }
  if (
    navigating
    && Number.isFinite(candidate.accuracy)
    && candidate.accuracy > MAX_ACCURACY_M
  ) {
    return { accepted: false, reason: 'accuracy' };
  }
  if (prev && impliedSpeedKmh(prev, candidate) > MAX_IMPLIED_SPEED_KMH) {
    return { accepted: false, reason: 'jump' };
  }

  const heading = Number.isFinite(candidate.heading)
    ? candidate.heading
    : headingFromFixes(prev, candidate);
  const implied = impliedSpeedKmh(prev, candidate);
  const speedKmh = Number.isFinite(candidate.speed)
    ? candidate.speed * 3.6
    : (Number.isFinite(implied) && implied !== Number.POSITIVE_INFINITY ? implied : 0);

  return {
    accepted: true,
    reason: null,
    fix: {
      ...candidate,
      heading,
      speedKmh,
    },
  };
}

export function shouldPersistLocation(lastPersistedAt, now, minIntervalMs = LOCATION_PERSIST_INTERVAL_MS) {
  if (lastPersistedAt == null) return true;
  return now - lastPersistedAt >= minIntervalMs;
}
