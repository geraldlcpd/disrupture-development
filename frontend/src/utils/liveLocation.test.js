import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptFix,
  headingFromFixes,
  impliedSpeedKmh,
  shouldPersistLocation,
} from './liveLocation.js';

function fix({ lat = -6.2, lon = 106.8, accuracy = 10, heading = null, speed = null, timestamp = 0 } = {}) {
  return { lat, lon, accuracy, heading, speed, timestamp };
}

describe('acceptFix', () => {
  it('rejects invalid coordinates', () => {
    const result = acceptFix(null, fix({ lat: NaN }));
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'invalid');
  });

  it('rejects low-accuracy fixes while navigating', () => {
    const result = acceptFix(null, fix({ accuracy: 140 }), { navigating: true });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'accuracy');
  });

  it('allows low-accuracy fixes when not navigating', () => {
    const result = acceptFix(null, fix({ accuracy: 140 }), { navigating: false });
    assert.equal(result.accepted, true);
  });

  it('rejects teleport jumps faster than 200 km/h', () => {
    const prev = fix({ lat: -6.2, lon: 106.8, timestamp: 0 });
    const next = fix({ lat: -6.3, lon: 106.9, timestamp: 1000 });
    const result = acceptFix(prev, next, { navigating: true });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'jump');
  });

  it('fills heading from consecutive fixes when device heading is null', () => {
    const prev = fix({ lat: -6.2, lon: 106.8, timestamp: 0, heading: null });
    const next = fix({ lat: -6.2, lon: 106.8015, timestamp: 8000, heading: null, speed: 10 });
    const result = acceptFix(prev, next);
    assert.equal(result.accepted, true);
    assert.ok(Math.abs(result.fix.heading - 90) < 8, `heading=${result.fix.heading}`);
    assert.ok(result.fix.speedKmh > 30);
  });
});

describe('impliedSpeedKmh / headingFromFixes / persist', () => {
  it('computes speed from displacement and time', () => {
    const prev = fix({ timestamp: 0 });
    const next = fix({ lon: 106.801, timestamp: 10000 });
    const kmh = impliedSpeedKmh(prev, next);
    assert.ok(kmh > 0 && kmh < 80, `kmh=${kmh}`);
  });

  it('keeps previous heading when movement is tiny', () => {
    const prev = fix({ heading: 45 });
    const next = fix({ lon: 106.800001, heading: null });
    assert.equal(headingFromFixes(prev, next), 45);
  });

  it('throttles IndexedDB writes', () => {
    assert.equal(shouldPersistLocation(0, 1000, 5000), false);
    assert.equal(shouldPersistLocation(0, 6000, 5000), true);
    assert.equal(shouldPersistLocation(null, 10), true);
  });
});
