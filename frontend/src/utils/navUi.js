import {
  ArrowUp,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Merge,
  RotateCcw,
  RotateCw,
  Split,
} from 'lucide-react';

export function maneuverIcon(code) {
  const c = String(code || '').toUpperCase();
  if (c.includes('UTURN') && c.includes('LEFT')) return RotateCcw;
  if (c.includes('UTURN') || (c.includes('U_TURN'))) return RotateCw;
  if (c.includes('ROUNDABOUT')) return RotateCw;
  if (c.includes('KEEP_LEFT') || c.includes('BEAR_LEFT') || (c.includes('LEFT') && !c.includes('RIGHT'))) {
    return c.includes('SHARP') ? CornerUpLeft : CornerUpLeft;
  }
  if (c.includes('RIGHT')) return CornerUpRight;
  if (c.includes('MERGE')) return Merge;
  if (c.includes('EXIT') || c.includes('FORK') || c.includes('RAMP')) return Split;
  if (c.includes('ARRIVE') || c.includes('DESTINATION')) return Flag;
  return ArrowUp;
}

export function formatDistanceM(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 30) return 'Now';
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export function formatEtaClock(timestamp) {
  if (!Number.isFinite(timestamp)) return '—';
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDisruptionType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'flood' || t === 'flooding' || t === 'waterway') return 'Flood';
  if (t === 'crowd' || t === 'crowding') return 'Crowd';
  if (t === 'weather') return 'Weather';
  if (t === 'earthquake') return 'Earthquake';
  if (t === 'traffic') return 'Traffic';
  if (!t) return 'Alert';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function riskChipClass(risk, isLight) {
  switch (risk) {
    case 'Critical':
      return 'bg-red-600 text-white';
    case 'High':
      return 'bg-orange-500 text-white';
    case 'Medium':
      return isLight ? 'bg-yellow-400 text-yellow-950' : 'bg-yellow-500/80 text-yellow-950';
    default:
      return isLight ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-500/20 text-emerald-200';
  }
}
