import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGpsSimulatorState,
  gpsSimulatorFix,
  offsetGpsSimulator,
  stepGpsSimulator,
} from './gpsSimulator.js';

function eastingCoords() {
  const lat = -6.2;
  const lon0 = 106.8;
  const lon1 = 106.80904;
  const coords = [];
  for (let i = 0; i < 11; i += 1) {
    coords.push([lon0 + (lon1 - lon0) * (i / 10), lat]);
  }
  return coords;
}

describe('gpsSimulator', () => {
  it('advances along the route at the configured speed', () => {
    let sim = createGpsSimulatorState({ coordinates: eastingCoords(), speedKmh: 36, now: 0 });
    const start = gpsSimulatorFix(sim);
    const stepped = stepGpsSimulator(sim, 10);
    sim = stepped.state;
    const next = stepped.fix;
    assert.ok(sim.distanceM > 90 && sim.distanceM < 110, `distanceM=${sim.distanceM}`);
    assert.ok(next.lon > start.lon);
    assert.equal(stepped.arrived, false);
  });

  it('marks arrived at the end of the polyline', () => {
    let sim = createGpsSimulatorState({ coordinates: eastingCoords(), speedKmh: 3600, now: 0 });
    const stepped = stepGpsSimulator(sim, 10);
    assert.equal(stepped.arrived, true);
    assert.ok(Math.abs(stepped.state.distanceM - sim.routeIndex.lengthM) < 1);
  });

  it('can offset the fix off the route', () => {
    const sim = offsetGpsSimulator(
      createGpsSimulatorState({ coordinates: eastingCoords(), speedKmh: 0, now: 0 }),
      { latOffset: 0.002 }
    );
    const onRoute = gpsSimulatorFix(createGpsSimulatorState({ coordinates: eastingCoords() }));
    const off = gpsSimulatorFix(sim);
    assert.ok(off.lat > onRoute.lat);
  });
});
