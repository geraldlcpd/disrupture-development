const RECENT_LS_KEY = 'disruptureNavigateRecent';
const MAX_RECENT = 5;

function isValidPlace(place) {
  return (
    place &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lon) &&
    typeof place.name === 'string' &&
    place.name.length > 0
  );
}

function placeKey(place) {
  if (place.id) return String(place.id);
  return `${place.lat.toFixed(5)},${place.lon.toFixed(5)}`;
}

function normalizePlace(place) {
  return {
    id: place.id || placeKey(place),
    name: place.name,
    address: place.address || '',
    lat: place.lat,
    lon: place.lon,
  };
}

export function getRecentDestinations() {
  try {
    const raw = window.localStorage.getItem(RECENT_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPlace).slice(0, MAX_RECENT).map(normalizePlace);
  } catch {
    return [];
  }
}

export function addRecentDestination(place) {
  if (!isValidPlace(place)) return getRecentDestinations();
  const entry = normalizePlace(place);
  const key = placeKey(entry);
  const existing = getRecentDestinations().filter((p) => placeKey(p) !== key);
  const next = [entry, ...existing].slice(0, MAX_RECENT);
  try {
    window.localStorage.setItem(RECENT_LS_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota errors */
  }
  return next;
}
