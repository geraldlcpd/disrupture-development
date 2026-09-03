import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingAlongRoute,
  bearingBetween,
  buildRouteIndex,
  pointAtDistance,
  projectOntoRoute,
  splitRouteAtDistance,
} from './routeGeometry.js';

/** ~1 km east along lat -6.2 starting at lon 106.8 */
function eastingRoute(points = 11) {
  const lat = -6.2;
  const lon0 = 106.8;
  const lon1 = 106.80904; // ≈ 1 km at this latitude
  const coords = [];
  for (let i = 0; i < points; i += 1) {
    const t = i / (points - 1);
    coords.push([lon0 + (lon1 - lon0) * t, lat]);
  }
  return coords;
}

describe('buildRouteIndex', () => {
  it('returns empty-safe index for invalid input', () => {
    const idx = buildRouteIndex(null);
    assert.equal(idx.segmentCount, 0);
    assert.equal(idx.lengthM, 0);
  });

  it('accumulates length close to 1 km for an easting line', () => {
    const idx = buildRouteIndex(eastingRoute());
    assert.equal(idx.segmentCount, 10);
    assert.ok(idx.lengthM > 950 && idx.lengthM < 1050, `lengthM=${idx.lengthM}`);
  });
});

describe('projectOntoRoute', () => {
  const idx = buildRouteIndex(eastingRoute());

  it('snaps a point on the line with near-zero off-route distance', () => {
    const mid = pointAtDistance(idx, idx.lengthM / 2);
    const proj = projectOntoRoute(mid.lat, mid.lon, idx);
    assert.ok(proj.offRouteM < 2, `offRouteM=${proj.offRouteM}`);
    assert.ok(Math.abs(proj.distanceAlongM - idx.lengthM / 2) < 5);
  });

  it('reports ~100 m off-route for a point north of the midpoint', () => {
    const mid = pointAtDistance(idx, idx.lengthM / 2);
    const latOffset = 100 / 111320;
    const proj = projectOntoRoute(mid.lat + latOffset, mid.lon, idx);
    assert.ok(proj.offRouteM > 80 && proj.offRouteM < 120, `offRouteM=${proj.offRouteM}`);
    assert.ok(Math.abs(proj.distanceAlongM - idx.lengthM / 2) < 15);
  });

  it('uses hintIndex window then falls back to full search when far off', () => {
    const start = idx.coordinates[0];
    const end = idx.coordinates[idx.coordinates.length - 1];
    const nearEnd = projectOntoRoute(end[1], end[0], idx, 0, 1);
    assert.ok(
      Math.abs(nearEnd.distanceAlongM - idx.lengthM) < 20,
      `distanceAlongM=${nearEnd.distanceAlongM} lengthM=${idx.lengthM}`
    );
    const nearStart = projectOntoRoute(start[1], start[0], idx);
    assert.ok(nearStart.distanceAlongM < 20);
  });

  it('returns Infinity off-route for an empty index', () => {
    const proj = projectOntoRoute(-6.2, 106.8, buildRouteIndex([]));
    assert.equal(proj.offRouteM, Infinity);
  });
});

describe('bearingBetween / bearingAlongRoute', () => {
  it('returns ~90° for due east', () => {
    const b = bearingBetween(-6.2, 106.8, -6.2, 106.81);
    assert.ok(Math.abs(b - 90) < 2, `bearing=${b}`);
  });

  it('returns ~0° for due north', () => {
    const b = bearingBetween(-6.2, 106.8, -6.19, 106.8);
    assert.ok(b < 2 || b > 358, `bearing=${b}`);
  });

  it('follows the route heading at the start of an easting line', () => {
    const idx = buildRouteIndex(eastingRoute());
    const b = bearingAlongRoute(idx, 0);
    assert.ok(Math.abs(b - 90) < 5, `bearing=${b}`);
  });
});

describe('splitRouteAtDistance', () => {
  it('splits so remaining starts at the snap point and ends at destination', () => {
    const idx = buildRouteIndex(eastingRoute());
    const { traveled, remaining } = splitRouteAtDistance(idx, idx.lengthM / 2);
    assert.ok(traveled.length >= 2);
    assert.ok(remaining.length >= 2);
    const lastTraveled = traveled[traveled.length - 1];
    const firstRemaining = remaining[0];
    assert.equal(lastTraveled[0], firstRemaining[0]);
    assert.equal(lastTraveled[1], firstRemaining[1]);
    const dest = idx.coordinates[idx.coordinates.length - 1];
    assert.deepEqual(remaining[remaining.length - 1], dest);
  });

  it('puts everything in remaining at distance 0', () => {
    const idx = buildRouteIndex(eastingRoute());
    const { remaining } = splitRouteAtDistance(idx, 0);
    assert.deepEqual(remaining[remaining.length - 1], idx.coordinates[idx.coordinates.length - 1]);
  });
});
