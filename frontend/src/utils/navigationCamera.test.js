import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  headingDeltaDeg,
  lookAheadCenter,
  shouldApplyCameraUpdate,
  zoomForSpeed,
} from './navigationCamera.js';

describe('zoomForSpeed', () => {
  it('zooms in when stopped or approaching a maneuver', () => {
    assert.equal(zoomForSpeed(0), 18);
    assert.equal(zoomForSpeed(50, { maneuverWithinM: 80 }), 18);
  });

  it('steps out as speed rises', () => {
    assert.equal(zoomForSpeed(20), 17);
    assert.equal(zoomForSpeed(45), 16);
    assert.equal(zoomForSpeed(90), 15);
  });
});

describe('lookAheadCenter', () => {
  it('shifts the center along heading so the puck sits lower on a north-up map', () => {
    const origin = { lat: -6.2, lon: 106.8, headingDeg: 90, zoom: 17 };
    const ahead = lookAheadCenter(origin);
    assert.ok(ahead.lon > origin.lon, 'eastbound look-ahead should increase lon');
    assert.ok(Math.abs(ahead.lat - origin.lat) < 0.001);
  });
});

describe('shouldApplyCameraUpdate', () => {
  it('applies the first frame and zoom changes', () => {
    assert.equal(shouldApplyCameraUpdate(null, { lat: -6.2, lon: 106.8, heading: 0, zoom: 17 }), true);
    assert.equal(
      shouldApplyCameraUpdate(
        { lat: -6.2, lon: 106.8, heading: 0, zoom: 17 },
        { lat: -6.2, lon: 106.8, heading: 0, zoom: 18 }
      ),
      true
    );
  });

  it('skips tiny jitter under the move/heading thresholds', () => {
    const prev = { lat: -6.2, lon: 106.8, heading: 90, zoom: 17 };
    const next = { lat: -6.2, lon: 106.800001, heading: 91, zoom: 17 };
    assert.equal(shouldApplyCameraUpdate(prev, next), false);
  });
});

describe('headingDeltaDeg', () => {
  it('wraps across 0°', () => {
    assert.ok(headingDeltaDeg(350, 10) < 25);
  });
});
