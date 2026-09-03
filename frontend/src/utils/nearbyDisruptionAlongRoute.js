/**
 * Finds disruption zones that the remaining route actually passes through,
 * ordered by along-route distance ahead of the driver.
 */

import { getPredictionZoneCenter } from './filterPredictionsNearPoint.js';
import { projectOntoRoute } from './routeGeometry.js';

const DEFAULT_CORRIDOR_M = 300;

export function findNearbyDisruptionsAlongRoute({
  predictions,
  routeIndex,
  distanceAlongM = 0,
  corridorM = DEFAULT_CORRIDOR_M,
} = {}) {
  if (!Array.isArray(predictions) || !routeIndex || routeIndex.segmentCount < 1) {
    return [];
  }

  const driverM = Number.isFinite(distanceAlongM) ? distanceAlongM : 0;

  return predictions
    .map((prediction) => {
      const center = getPredictionZoneCenter(prediction);
      if (!center) return null;

      const proj = projectOntoRoute(center.lat, center.lon, routeIndex);
      if (!Number.isFinite(proj.offRouteM)) return null;

      const radiusM = Number.isFinite(prediction.zone?.radius_m)
        ? prediction.zone.radius_m
        : 1000;
      const entryM = proj.distanceAlongM - radiusM;
      const aheadM = entryM - driverM;

      return {
        prediction,
        offRouteM: proj.offRouteM,
        radiusM,
        entryM,
        aheadM,
        distanceAlongM: proj.distanceAlongM,
      };
    })
    .filter((item) => {
      if (!item) return false;
      const intersectsCorridor = item.offRouteM <= item.radiusM + corridorM;
      const stillAheadOrInside = item.aheadM > -item.radiusM;
      return intersectsCorridor && stillAheadOrInside;
    })
    .sort((a, b) => a.aheadM - b.aheadM);
}
