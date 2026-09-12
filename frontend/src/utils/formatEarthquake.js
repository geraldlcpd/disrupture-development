const NAIVE_AS_UTC = import.meta.env.VITE_EARTHQUAKE_NAIVE_AS_UTC === 'true';

/**
 * Parse earthquake timestamps from API payloads.
 * Timezone-less strings are ambiguous: USGS/mock store UTC-naive, real BMKG stores WIB-naive.
 */
export function parseEarthquakeInstant(value, eventId = '') {
  if (!value) return null;
  const s = String(value).trim();
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const id = String(eventId || '');

  if (NAIVE_AS_UTC || id.startsWith('USGS-')) {
    const d = new Date(`${normalized}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(`${normalized}+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format earthquake event timestamps for display (WIB).
 * Returns a readable fallback when the value is missing or invalid.
 */
export function formatEarthquakeWhen(value, { eventId } = {}) {
  const d = parseEarthquakeInstant(value, eventId);
  if (!d) return 'Time unavailable';
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

/** English timestamp for BMKG cards (Jakarta time). */
export function formatEarthquakeWhenEn(value, { eventId } = {}) {
  const d = parseEarthquakeInstant(value, eventId);
  if (!d) return 'Time unavailable';
  return d.toLocaleString('en-US', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}
/**
 * Classify BMKG Potensi text into tsunami risk levels.
 * @returns {'none' | 'watch' | 'high' | 'unknown'}
 */
export function getTsunamiRisk(potensi) {
  const text = String(potensi || '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('tidak berpotensi')) return 'none';
  if (
    (text.includes('sangat besar') || text.includes('besar')) &&
    (text.includes('berpotensi') || text.includes('tsunami'))
  ) {
    return 'high';
  }
  if (text.includes('berpotensi') || text.includes('tsunami')) return 'watch';
  return 'unknown';
}

const TSUNAMI_RISK_LABELS = {
  none: 'No tsunami',
  watch: 'Tsunami watch',
  high: 'High tsunami risk',
  unknown: 'Status unavailable',
};

export function getTsunamiRiskLabel(level) {
  return TSUNAMI_RISK_LABELS[level] ?? TSUNAMI_RISK_LABELS.unknown;
}

const TOOLTIP_MAX_LEN = 220;

function truncateTooltip(text) {
  if (!text || text.length <= TOOLTIP_MAX_LEN) return text;
  return `${text.slice(0, TOOLTIP_MAX_LEN - 1)}…`;
}

/** English tooltip body for tsunami chip. */
export function translatePotensiToEnglish(potensi) {
  const raw = String(potensi || '').trim();
  const level = getTsunamiRisk(potensi);

  if (!raw) {
    return 'Tsunami status unavailable for this event.';
  }

  if (level === 'none') {
    return 'No tsunami potential (BMKG).';
  }

  if (level === 'high') {
    return truncateTooltip(`High tsunami potential (BMKG): ${raw}`);
  }

  if (level === 'watch') {
    return truncateTooltip(`Tsunami potential (BMKG): ${raw}`);
  }

  return truncateTooltip(`BMKG tsunami note: ${raw}`);
}

/** Tailwind border-l-4 accent classes for earthquake cards by tsunami risk. */
export function getTsunamiRiskBorderClass(level, isLight) {
  switch (level) {
    case 'none':
      return isLight ? 'border-l-emerald-500' : 'border-l-emerald-500/80';
    case 'watch':
      return isLight ? 'border-l-amber-500' : 'border-l-amber-400';
    case 'high':
      return 'border-l-red-500';
    default:
      return isLight ? 'border-l-slate-300' : 'border-l-slate-600';
  }
}

/** Impact radius in meters for map rings and camera fit. */
export function getEarthquakeImpactRadiusMeters(eq) {
  const impactKm = Number(eq?.impact_radius_km);
  if (Number.isFinite(impactKm) && impactKm > 0) {
    return impactKm * 1000;
  }
  const mag = Number(eq?.magnitude);
  if (Number.isFinite(mag) && mag > 0) {
    return mag * 5000;
  }
  return 25000;
}

/** Leaflet-ready [lat, lon] or null when coordinates are missing. */
export function getEarthquakeLatLng(eq) {
  const lat = Number(eq?.latitude);
  const lon = Number(eq?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lat, lon];
}

/**
 * Normalize API earthquake payloads to the shape expected by Sidebar/MapView.
 */
export function normalizeEarthquake(eq) {
  const lat = eq?.latitude != null ? Number(eq.latitude) : null;
  const lon = eq?.longitude != null ? Number(eq.longitude) : null;
  return {
    ...eq,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lon) ? lon : null,
    datetime: eq.event_timestamp ?? eq.datetime ?? null,
    wilayah: eq.location ?? eq.wilayah ?? 'Unknown region',
    depth: eq.depth_km != null ? `${eq.depth_km} km` : (eq.depth ?? '—'),
    magnitude: eq.magnitude ?? 0,
    potensi: eq.potensi ?? eq.Potensi ?? null,
  };
}
