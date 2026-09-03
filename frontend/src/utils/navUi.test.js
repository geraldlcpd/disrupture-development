import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDistanceM, maneuverIcon } from './navUi.js';
import { ArrowUp, CornerUpRight, Flag } from 'lucide-react';

describe('formatDistanceM', () => {
  it('uses Now / metres / km bands', () => {
    assert.equal(formatDistanceM(12), 'Now');
    assert.equal(formatDistanceM(240), '240 m');
    assert.equal(formatDistanceM(2400), '2.4 km');
  });
});

describe('maneuverIcon', () => {
  it('maps common TomTom codes', () => {
    assert.equal(maneuverIcon('TURN_RIGHT'), CornerUpRight);
    assert.equal(maneuverIcon('ARRIVE'), Flag);
    assert.equal(maneuverIcon('DEPART'), ArrowUp);
  });
});
