/**
 * Desk-test GPS: replay a route polyline at a configurable speed.
 * Browser helper uses setInterval; tests use stepGpsSimulator without timers.
 */

import { bearingAlongRoute, buildRouteIndex, pointAtDistance } from './routeGeometry.js';

export function createGpsSimulatorState({
  coordinates,
  speedKmh = 40,
  now = 0,
} = {}) {
  const routeIndex = buildRouteIndex(coordinates);
  return {
    routeIndex,
    speedKmh,
    distanceM: 0,
    now,
    offRouteLatOffset: 0,
    offRouteLonOffset: 0,
  };
}

export function gpsSimulatorFix(state) {
  const point = pointAtDistance(state.routeIndex, state.distanceM);
  const heading = bearingAlongRoute(state.routeIndex, state.distanceM);
  return {
    lat: point.lat + (state.offRouteLatOffset || 0),
    lon: point.lon + (state.offRouteLonOffset || 0),
    accuracy: 8,
    heading,
    speed: (state.speedKmh || 0) / 3.6,
    speedKmh: state.speedKmh || 0,
    timestamp: state.now,
  };
}

export function stepGpsSimulator(state, dtSec = 0.25) {
  const speedMs = (state.speedKmh || 0) / 3.6;
  const distanceM = Math.min(
    state.routeIndex.lengthM,
    state.distanceM + speedMs * dtSec
  );
  const next = {
    ...state,
    distanceM,
    now: state.now + dtSec * 1000,
  };
  return { state: next, fix: gpsSimulatorFix(next), arrived: distanceM >= state.routeIndex.lengthM };
}

export function offsetGpsSimulator(state, { latOffset = 0, lonOffset = 0 } = {}) {
  return {
    ...state,
    offRouteLatOffset: latOffset,
    offRouteLonOffset: lonOffset,
  };
}

export function createGpsSimulator({
  coordinates,
  speedKmh = 40,
  intervalMs = 250,
  onFix,
} = {}) {
  let sim = createGpsSimulatorState({ coordinates, speedKmh, now: Date.now() });
  let timer = null;

  const emit = () => {
    onFix?.(gpsSimulatorFix(sim));
  };

  const tick = () => {
    const stepped = stepGpsSimulator(sim, intervalMs / 1000);
    sim = stepped.state;
    emit();
    if (stepped.arrived) stop();
  };

  function start() {
    if (timer != null) return;
    emit();
    timer = setInterval(tick, intervalMs);
  }

  function stop() {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function setSpeed(nextKmh) {
    sim = { ...sim, speedKmh: nextKmh };
  }

  function jumpOffRoute(latOffsetM) {
    const latOffset = (latOffsetM || 0) / 111320;
    sim = offsetGpsSimulator(sim, { latOffset });
    emit();
  }

  return {
    start,
    stop,
    setSpeed,
    jumpOffRoute,
    getDistanceM: () => sim.distanceM,
    getState: () => sim,
  };
}
