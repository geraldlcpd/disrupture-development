import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteIndex, pointAtDistance } from './routeGeometry.js';
import {
  applyFetchedVariant,
  applyLocationTick,
  applyRerouteFailure,
  applyRerouteSuccess,
  applyVariantSwitch,
  ARRIVE_M,
  createNavigationSession,
  inspectVariantSwitch,
  MAX_REROUTES_PER_SESSION,
  NEARBY_INTERVAL_MS,
  NEARBY_MOVE_M,
  OFF_ROUTE_HOLD_MS,
  OFF_ROUTE_M,
  rerouteLimitReached,
  shouldAutoReroute,
} from './navigationSession.js';

function eastingCoords(lon0 = 106.8, lon1 = 106.80904, lat = -6.2) {
  const coords = [];
  for (let i = 0; i < 21; i += 1) {
    coords.push([lon0 + (lon1 - lon0) * (i / 20), lat]);
  }
  return coords;
}

function makeRoute({ coords = eastingCoords(), travelTimeSec = 120, key = 'main' } = {}) {
  const idx = buildRouteIndex(coords);
  return {
    durationMin: Math.ceil(travelTimeSec / 60),
    distanceKm: Number((idx.lengthM / 1000).toFixed(1)),
    travelTimeSec,
    lengthMeters: idx.lengthM,
    geometry: { type: 'LineString', coordinates: coords },
    maneuvers: [
      { index: 0, maneuver: 'DEPART', street: 'Start', offsetM: 0, pointIndex: 0, roadNumbers: [], text: 'Depart', exitNumber: null },
      { index: 1, maneuver: 'TURN_RIGHT', street: 'Jalan Thamrin', offsetM: idx.lengthM * 0.4, pointIndex: 8, roadNumbers: [], text: 'Turn right', exitNumber: null },
      { index: 2, maneuver: 'ARRIVE', street: '', offsetM: idx.lengthM, pointIndex: 20, roadNumbers: [], text: 'Arrive', exitNumber: null },
    ],
    viaLabel: key,
  };
}

function locAt(routeIndex, fraction, extra = {}) {
  const p = pointAtDistance(routeIndex, routeIndex.lengthM * fraction);
  return {
    lat: p.lat,
    lon: p.lon,
    accuracy: 8,
    heading: 90,
    speedKmh: 36,
    timestamp: extra.timestamp ?? 0,
    ...extra,
  };
}

describe('createNavigationSession', () => {
  it('starts navigating on the requested variant', () => {
    const safer = makeRoute({ key: 'safer' });
    const faster = makeRoute({ coords: eastingCoords(106.8, 106.808), key: 'faster' });
    const session = createNavigationSession({
      destination: { lat: -6.2, lon: 106.809 },
      activeKey: 'safer',
      routes: { safer, faster },
      now: 0,
    });
    assert.equal(session.status, 'navigating');
    assert.equal(session.activeKey, 'safer');
    assert.equal(session.currentManeuver.maneuver, 'TURN_RIGHT');
    assert.ok(session.routeIndex.lengthM > 900);
  });
});

describe('applyLocationTick', () => {
  const safer = makeRoute();
  const base = createNavigationSession({
    destination: { lat: -6.2, lon: 106.809 },
    routes: { safer, faster: makeRoute({ coords: eastingCoords(106.8, 106.8075) }) },
    now: 0,
  });

  it('advances remaining distance and maneuver cursor', () => {
    const mid = locAt(base.routeIndex, 0.5, { timestamp: 1000 });
    const next = applyLocationTick(base, mid, { now: 1000 });
    assert.ok(next.distanceAlongM > base.routeIndex.lengthM * 0.4);
    assert.ok(next.remainingDistanceKm < base.remainingDistanceKm);
    assert.equal(next.currentManeuver.maneuver, 'ARRIVE');
    assert.equal(next.status, 'navigating');
  });

  it('marks arrived within 60 m of the destination', () => {
    const nearEnd = locAt(base.routeIndex, 1, { timestamp: 2000 });
    const next = applyLocationTick(base, nearEnd, { now: 2000 });
    assert.equal(next.status, 'arrived');
    assert.ok(next.distToDestM <= ARRIVE_M + 1);
  });

  it('enters off_route after a 150 m lateral offset', () => {
    const mid = locAt(base.routeIndex, 0.4);
    const latOffset = (OFF_ROUTE_M + 40) / 111320;
    const next = applyLocationTick(base, { ...mid, lat: mid.lat + latOffset }, { now: 5000 });
    assert.equal(next.status, 'off_route');
    assert.equal(next.offRouteSince, 5000);
    assert.equal(shouldAutoReroute(next, 5000 + OFF_ROUTE_HOLD_MS - 1), false);
    assert.equal(shouldAutoReroute(next, 5000 + OFF_ROUTE_HOLD_MS), true);
  });

  it('refreshes nearby disruption on first tick and after 500 m', () => {
    const zonePoint = pointAtDistance(base.routeIndex, base.routeIndex.lengthM * 0.7);
    const predictions = [{
      id: 'flood-1',
      disruption_type: 'flood',
      risk_level: 'High',
      zone: { latitude: zonePoint.lat, longitude: zonePoint.lon, radius_m: 120, name: 'Flood' },
    }];
    const first = applyLocationTick(base, locAt(base.routeIndex, 0.1), { predictions, now: 1 });
    assert.equal(first.nearbyDisruption.prediction.id, 'flood-1');
    assert.ok(first.nearbyDisruption.aheadM > 0);

    const noRefresh = applyLocationTick(first, locAt(base.routeIndex, 0.12), { predictions, now: 2 });
    assert.equal(noRefresh.lastNearbyAt, 1);

    const moved = applyLocationTick(first, locAt(base.routeIndex, 0.1 + (NEARBY_MOVE_M + 20) / first.routeIndex.lengthM), {
      predictions,
      now: 3,
    });
    assert.equal(moved.lastNearbyAt, 3);

    const timed = applyLocationTick(first, locAt(base.routeIndex, 0.12), {
      predictions,
      now: 1 + NEARBY_INTERVAL_MS,
    });
    assert.equal(timed.lastNearbyAt, 1 + NEARBY_INTERVAL_MS);
  });
});

describe('reroute and variant switch', () => {
  const safer = makeRoute({ key: 'safer' });
  const fasterCoords = eastingCoords(106.8, 106.808, -6.201);
  const faster = makeRoute({ coords: fasterCoords, key: 'faster', travelTimeSec: 90 });
  const session = createNavigationSession({
    destination: { lat: -6.2, lon: 106.809 },
    activeKey: 'safer',
    routes: { safer, faster },
    now: 0,
  });

  it('marks the other variant stale after a successful reroute', () => {
    const rerouted = makeRoute({ coords: eastingCoords(106.8, 106.8095), key: 'safer-new' });
    const next = applyRerouteSuccess(session, rerouted, 70_000, locAt(session.routeIndex, 0.3));
    assert.equal(next.status, 'navigating');
    assert.equal(next.rerouteCount, 1);
    assert.equal(next.routes.faster.stale, true);
    assert.equal(next.routes.safer.stale, false);
    assert.equal(inspectVariantSwitch(next, 'faster', locAt(next.routeIndex, 0.3)).reason, 'stale');
  });

  it('switches instantly when the alternate is fresh and nearby', () => {
    const location = locAt(session.routeIndex, 0.2);
    const inspection = inspectVariantSwitch(session, 'faster', location);
    assert.equal(inspection.needsFetch, false);
    const next = applyVariantSwitch(session, 'faster', 1000, location);
    assert.equal(next.activeKey, 'faster');
    assert.equal(next.route.viaLabel, 'faster');
  });

  it('requests a fetch when the alternate has already diverged', () => {
    const farFaster = makeRoute({
      coords: eastingCoords(106.82, 106.83, -6.25),
      key: 'far',
    });
    const diverged = createNavigationSession({
      destination: { lat: -6.25, lon: 106.83 },
      activeKey: 'safer',
      routes: { safer, faster: farFaster },
      now: 0,
    });
    const location = locAt(diverged.routeIndex, 0.5);
    const inspection = inspectVariantSwitch(diverged, 'faster', location);
    assert.equal(inspection.reason, 'diverged');
    assert.equal(inspection.needsFetch, true);
  });

  it('applies a fetched variant and clears stale', () => {
    const stale = applyRerouteSuccess(session, makeRoute({ key: 'safer-2' }), 80_000, locAt(session.routeIndex, 0.2));
    const fetched = makeRoute({ coords: eastingCoords(106.8, 106.807), key: 'faster-new' });
    const next = applyFetchedVariant(stale, 'faster', fetched, 81_000, locAt(stale.routeIndex, 0.2));
    assert.equal(next.activeKey, 'faster');
    assert.equal(next.routes.faster.stale, false);
  });

  it('throttles auto-reroute after a failed attempt', () => {
    const off = applyLocationTick(session, {
      ...locAt(session.routeIndex, 0.3),
      lat: locAt(session.routeIndex, 0.3).lat + 0.003,
    }, { now: 1000 });
    const failed = applyRerouteFailure(off, 12_000);
    assert.equal(failed.rerouteCount, 1);
    assert.equal(shouldAutoReroute(failed, 12_000 + 1000), false);
  });

  it('stops auto-reroute after the session cap', () => {
    const capped = { ...session, rerouteCount: MAX_REROUTES_PER_SESSION, offRouteSince: 0, status: 'off_route' };
    assert.equal(rerouteLimitReached(capped), true);
    assert.equal(shouldAutoReroute(capped, 120_000), false);
  });
});
