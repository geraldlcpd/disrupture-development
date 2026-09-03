/**
 * filterPredictionsNearPoint.js
 *
 * Filters active disruption predictions to those within a given radius of a
 * point (e.g. a navigate destination), sorted nearest-first.
 */
import { calculateDistanceKm } from './haversine.js';

export function getPredictionZoneCenter(prediction) {
  const zone = prediction?.zone ?? {};
  if (typeof zone.latitude === 'number' && typeof zone.longitude === 'number') {
    return { lat: zone.latitude, lon: zone.longitude };
  }

  const geometry = zone?.geometry;
  const coordinates = geometry?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length > 0) {
    const firstRing = Array.isArray(coordinates[0]) ? coordinates[0] : coordinates;
    const firstPoint = Array.isArray(firstRing[0]) ? firstRing[0] : null;
    if (Array.isArray(firstPoint) && firstPoint.length >= 2) {
      const [lon, lat] = firstPoint;
      return { lat, lon };
    }
  }

  return null;
}

export function filterPredictionsNearPoint(predictions, lat, lon, radiusKm) {
  if (!Array.isArray(predictions) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return [];
  }

  return predictions
    .map((pred) => {
      const center = getPredictionZoneCenter(pred);
      if (!center) return null;
      const distanceKm = calculateDistanceKm(lat, lon, center.lat, center.lon);
      if (distanceKm > radiusKm) return null;
      return { ...pred, distanceKm };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}
