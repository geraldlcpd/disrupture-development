/**
 * Shared TomTom helpers used by evacuation and Navigate.
 */

import { calculateDistanceKm } from './haversine.js';

export const NAVIGATE_SEARCH_RADIUS_KM = 100;
export const NAVIGATE_SEARCH_LIMIT = 10;
export const TOMTOM_SEARCH_MIN_INTERVAL_MS = 1000;

let lastTomtomSearchCallAt = 0;

const MAJOR_SECTION_TYPES = new Set([
  'motorway',
  'MOTORWAY',
  'toll',
  'TOLL',
  'tollRoad',
  'TOLL_ROAD',
  'importantRoadStretch',
  'IMPORTANT_ROAD_STRETCH',
]);

const SKIP_STREET_PATTERNS = [/^continue/i, /^take the/i, /^roundabout/i];

const MAJOR_STREET_PATTERNS = [/\btol\b/i, /\braya\b/i, /\bhighway\b/i, /\bfreeway\b/i, /\bmotorway\b/i];

const MAX_VIA_ROADS = 3;

export function circleToBbox(lat, lon, radiusM) {
  const latDelta = radiusM / 111320;
  const lonDelta = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    southWestCorner: { latitude: lat - latDelta, longitude: lon - lonDelta },
    northEastCorner: { latitude: lat + latDelta, longitude: lon + lonDelta },
  };
}

export function extractManeuvers(route) {
  return (route?.guidance?.instructions ?? []).map((ins, i) => ({
    index: i,
    maneuver: ins.maneuver ?? ins.instructionType ?? '',
    street: ins.street ?? '',
    roadNumbers: ins.roadNumbers ?? [],
    text: ins.combinedMessage ?? ins.message ?? '',
    offsetM: ins.routeOffsetInMeters ?? 0,
    pointIndex: ins.pointIndex ?? 0,
    exitNumber: ins.exitNumber ?? null,
  }));
}

export function parseTomtomRoute(data) {
  const route = data.routes?.[0];
  if (!route) return null;
  const summary = route.summary ?? {};
  const coordinates = (route.legs ?? []).flatMap((leg) =>
    (leg.points ?? []).map((p) => [p.longitude, p.latitude])
  );
  const viaRoads = extractMajorViaRoads(route);
  const travelTimeSec = summary.travelTimeInSeconds ?? 0;
  const lengthMeters = summary.lengthInMeters ?? 0;
  return {
    durationMin: Math.ceil(travelTimeSec / 60),
    distanceKm: Number((lengthMeters / 1000).toFixed(1)),
    travelTimeSec,
    lengthMeters,
    geometry: { type: 'LineString', coordinates },
    viaRoads,
    viaLabel: formatViaLabel(viaRoads),
    maneuvers: extractManeuvers(route),
  };
}

function parseTomtomRoutingError(data, status) {
  const code =
    data?.detailedError?.innerError?.code ??
    data?.detailedError?.code ??
    data?.errorText;
  if (code === 'MAP_MATCHING_FAILURE') {
    return 'This place is not reachable by car from your location.';
  }
  if (code === 'NO_ROUTE_FOUND') {
    return 'No drivable route found to this place.';
  }
  if (code === 'NO_RANGE_FOUND') {
    return 'This place is outside the reachable driving area.';
  }
  const message = data?.detailedError?.message ?? data?.errorText;
  if (message) return message;
  return `TomTom routing failed (${status})`;
}

export async function fetchTomtomRoute({
  apiKey,
  origin,
  dest,
  avoidRects = [],
  travelMode = 'car',
}) {
  const originStr = `${origin.lat},${origin.lon}`;
  const destStr = `${dest.lat},${dest.lon}`;
  const url =
    `https://api.tomtom.com/routing/1/calculateRoute/${originStr}:${destStr}/json` +
    `?key=${apiKey}` +
    `&travelMode=${travelMode}` +
    `&instructionsType=text` +
    `&language=en-GB` +
    `&sectionType=motorway` +
    `&sectionType=toll` +
    `&sectionType=importantRoadStretch`;

  const body = avoidRects.length
    ? JSON.stringify({ avoidAreas: { rectangles: avoidRects } })
    : null;

  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(parseTomtomRoutingError(data, res.status));
  }
  const parsed = parseTomtomRoute(data);
  if (!parsed || parsed.geometry.coordinates.length < 2) {
    throw new Error('No route returned by TomTom.');
  }
  return parsed;
}

function delay(ms, signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForTomtomSearchSlot(signal) {
  const waitMs = Math.max(0, lastTomtomSearchCallAt + TOMTOM_SEARCH_MIN_INTERVAL_MS - Date.now());
  await delay(waitMs, signal);
  lastTomtomSearchCallAt = Date.now();
}

export async function searchTomtomPlaces({
  apiKey,
  query,
  lat,
  lon,
  radiusKm,
  limit = NAVIGATE_SEARCH_LIMIT,
}, { signal } = {}) {
  await waitForTomtomSearchSlot(signal);
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const params = new URLSearchParams({
    key: apiKey,
    typeahead: 'true',
    limit: String(limit),
    countrySet: 'ID',
    language: 'en-GB',
  });
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', String(lat));
    params.set('lon', String(lon));
    if (Number.isFinite(radiusKm) && radiusKm > 0) {
      params.set('radius', String(Math.round(radiusKm * 1000)));
    }
  }
  const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TomTom search failed (${res.status})`);
  const data = await res.json();
  const originLat = lat;
  const originLon = lon;

  return (data.results ?? [])
    .map((r) => {
      const placeLat = r.position?.lat;
      const placeLon = r.position?.lon;
      const distanceKm = Number.isFinite(r.dist)
        ? Number((r.dist / 1000).toFixed(1))
        : Number.isFinite(originLat) && Number.isFinite(originLon) && Number.isFinite(placeLat) && Number.isFinite(placeLon)
          ? Number(calculateDistanceKm(originLat, originLon, placeLat, placeLon).toFixed(1))
          : null;
      return {
        id: r.id,
        name: r.poi?.name || r.address?.freeformAddress || 'Place',
        address: r.address?.freeformAddress || '',
        lat: placeLat,
        lon: placeLon,
        distanceKm,
      };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .filter((p) => {
      if (!Number.isFinite(radiusKm) || radiusKm <= 0) return true;
      if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return true;
      return calculateDistanceKm(originLat, originLon, p.lat, p.lon) <= radiusKm;
    })
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}

async function probeReachabilityViaMatrix({ apiKey, origin, places }) {
  const url = `https://api.tomtom.com/routing/matrix/2?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origins: [{ point: { latitude: origin.lat, longitude: origin.lon } }],
      destinations: places.map((p) => ({ point: { latitude: p.lat, longitude: p.lon } })),
      options: { travelMode: 'car', routeType: 'fastest' },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const reachable = new Set();
  for (const cell of data.data ?? []) {
    if (cell.routeSummary?.travelTimeInSeconds > 0) {
      reachable.add(cell.destinationIndex);
    }
  }
  return places.filter((_, idx) => reachable.has(idx));
}

async function probeReachabilityViaRoutes({ apiKey, origin, places }) {
  const checks = await Promise.allSettled(
    places.map((place) =>
      fetchTomtomRoute({
        apiKey,
        origin,
        dest: { lat: place.lat, lon: place.lon },
        travelMode: 'car',
      })
    )
  );
  return places.filter((_, idx) => checks[idx].status === 'fulfilled');
}

export async function filterCarReachablePlaces({ apiKey, origin, places }) {
  if (!places.length || !origin) return [];
  const matrixResult = await probeReachabilityViaMatrix({ apiKey, origin, places });
  if (matrixResult !== null) return matrixResult;
  return probeReachabilityViaRoutes({ apiKey, origin, places });
}

function normalizeRoadName(name) {
  return String(name || '').trim();
}

function isValidRoadName(name) {
  if (!name || name.length < 3) return false;
  return !SKIP_STREET_PATTERNS.some((pattern) => pattern.test(name));
}

export function extractMajorViaRoads(route) {
  const instructions = route.guidance?.instructions ?? [];
  const sections = route.sections ?? [];
  const majorPointIndices = new Set();

  for (const section of sections) {
    if (!MAJOR_SECTION_TYPES.has(section.sectionType)) continue;
    const start = section.startPointIndex ?? 0;
    const end = section.endPointIndex ?? start;
    for (let i = start; i <= end; i += 1) majorPointIndices.add(i);
  }

  const seen = new Set();
  const roads = [];

  const addRoad = (name) => {
    const normalized = normalizeRoadName(name);
    if (!isValidRoadName(normalized)) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roads.push(normalized);
  };

  for (const instruction of instructions) {
    const onMajorSection = majorPointIndices.has(instruction.pointIndex);
    const hasRoadNumbers = (instruction.roadNumbers ?? []).length > 0;

    if (onMajorSection || hasRoadNumbers) {
      if (instruction.street) addRoad(instruction.street);
      for (const roadNumber of instruction.roadNumbers ?? []) addRoad(roadNumber);
    } else if (instruction.street && MAJOR_STREET_PATTERNS.some((pattern) => pattern.test(instruction.street))) {
      addRoad(instruction.street);
    }
  }

  for (const section of sections) {
    if (!MAJOR_SECTION_TYPES.has(section.sectionType)) continue;
    for (const roadNumber of section.roadNumbers ?? []) {
      const text = typeof roadNumber === 'string' ? roadNumber : roadNumber?.text;
      if (text) addRoad(text);
    }
  }

  return roads.slice(0, MAX_VIA_ROADS);
}

export function formatViaLabel(roads) {
  if (!roads?.length) return null;
  return `Via ${roads.join(', ')}`;
}
