import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteIndex, pointAtDistance } from './routeGeometry.js';
import { findNearbyDisruptionsAlongRoute } from './nearbyDisruptionAlongRoute.js';

function eastingRoute() {
  const lat = -6.2;
  const lon0 = 106.8;
  const lon1 = 106.80904;
  const coords = [];
  for (let i = 0; i < 11; i += 1) {
    const t = i / 10;
    coords.push([lon0 + (lon1 - lon0) * t, lat]);
  }
  return buildRouteIndex(coords);
}

function predictionAt(lat, lon, { radiusM = 200, id = 1, type = 'flood' } = {}) {
  return {
    id,
    disruption_type: type,
    risk_level: 'High',
    zone: { latitude: lat, longitude: lon, radius_m: radiusM, name: `Zone ${id}` },
  };
}

describe('findNearbyDisruptionsAlongRoute', () => {
  const route = eastingRoute();

  it('returns empty for missing inputs', () => {
    assert.deepEqual(findNearbyDisruptionsAlongRoute({}), []);
    assert.deepEqual(findNearbyDisruptionsAlongRoute({ predictions: [], routeIndex: route }), []);
  });

  it('keeps a zone on the remaining route and sorts nearest-ahead first', () => {
    const far = pointAtDistance(route, route.lengthM * 0.8);
    const near = pointAtDistance(route, route.lengthM * 0.4);
    const behind = pointAtDistance(route, route.lengthM * 0.1);

    const results = findNearbyDisruptionsAlongRoute({
      predictions: [
        predictionAt(far.lat, far.lon, { id: 'far', radiusM: 150 }),
        predictionAt(near.lat, near.lon, { id: 'near', radiusM: 150 }),
        predictionAt(behind.lat, behind.lon, { id: 'behind', radiusM: 80 }),
      ],
      routeIndex: route,
      distanceAlongM: route.lengthM * 0.25,
      corridorM: 50,
    });

    assert.equal(results[0].prediction.id, 'near');
    assert.ok(results.some((r) => r.prediction.id === 'far'));
    assert.ok(!results.some((r) => r.prediction.id === 'behind'));
    assert.ok(results[0].aheadM < results[1].aheadM);
  });

  it('drops a zone whose centre is far off the corridor', () => {
    const mid = pointAtDistance(route, route.lengthM / 2);
    const latOffset = 2000 / 111320;
    const results = findNearbyDisruptionsAlongRoute({
      predictions: [predictionAt(mid.lat + latOffset, mid.lon, { id: 'off', radiusM: 100 })],
      routeIndex: route,
      distanceAlongM: 0,
      corridorM: 300,
    });
    assert.equal(results.length, 0);
  });

  it('includes a zone the driver is already inside (aheadM can be negative)', () => {
    const here = pointAtDistance(route, route.lengthM * 0.5);
    const results = findNearbyDisruptionsAlongRoute({
      predictions: [predictionAt(here.lat, here.lon, { id: 'inside', radiusM: 400 })],
      routeIndex: route,
      distanceAlongM: route.lengthM * 0.5,
      corridorM: 50,
    });
    assert.equal(results.length, 1);
    assert.ok(results[0].aheadM <= 0);
    assert.ok(results[0].aheadM > -400);
  });

  it('skips predictions without a resolvable centre', () => {
    const results = findNearbyDisruptionsAlongRoute({
      predictions: [{ id: 'broken', zone: {} }],
      routeIndex: route,
      distanceAlongM: 0,
    });
    assert.equal(results.length, 0);
  });
});
