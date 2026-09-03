import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractManeuvers, parseTomtomRoute } from './tomtomRoute.js';

const sampleResponse = {
  routes: [
    {
      summary: { lengthInMeters: 2450, travelTimeInSeconds: 380 },
      legs: [
        {
          points: [
            { latitude: -6.2, longitude: 106.8 },
            { latitude: -6.201, longitude: 106.805 },
            { latitude: -6.202, longitude: 106.81 },
          ],
        },
      ],
      guidance: {
        instructions: [
          {
            maneuver: 'DEPART',
            street: 'Jalan Sudirman',
            roadNumbers: ['JKT-1'],
            combinedMessage: 'Depart Jalan Sudirman',
            routeOffsetInMeters: 0,
            pointIndex: 0,
          },
          {
            maneuver: 'TURN_RIGHT',
            street: 'Jalan Thamrin',
            message: 'Turn right onto Jalan Thamrin',
            routeOffsetInMeters: 1200,
            pointIndex: 1,
            exitNumber: null,
          },
          {
            instructionType: 'ARRIVE',
            street: '',
            routeOffsetInMeters: 2450,
            pointIndex: 2,
          },
        ],
      },
      sections: [],
    },
  ],
};

describe('parseTomtomRoute', () => {
  it('keeps existing fields and adds travelTimeSec, lengthMeters, maneuvers', () => {
    const parsed = parseTomtomRoute(sampleResponse);
    assert.equal(parsed.durationMin, 7);
    assert.equal(parsed.distanceKm, 2.5);
    assert.equal(parsed.travelTimeSec, 380);
    assert.equal(parsed.lengthMeters, 2450);
    assert.equal(parsed.geometry.type, 'LineString');
    assert.deepEqual(parsed.geometry.coordinates[0], [106.8, -6.2]);
    assert.equal(parsed.maneuvers.length, 3);
    assert.equal(parsed.maneuvers[1].maneuver, 'TURN_RIGHT');
    assert.equal(parsed.maneuvers[1].offsetM, 1200);
    assert.equal(parsed.maneuvers[1].street, 'Jalan Thamrin');
    assert.equal(parsed.maneuvers[2].maneuver, 'ARRIVE');
  });

  it('returns null when routes are missing', () => {
    assert.equal(parseTomtomRoute({}), null);
  });
});

describe('extractManeuvers', () => {
  it('returns an empty list when guidance is absent', () => {
    assert.deepEqual(extractManeuvers({}), []);
  });
});
