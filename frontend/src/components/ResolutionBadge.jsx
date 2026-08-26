/**
 * ResolutionBadge.jsx
 * ───────────────────────────────────────────────────────────────────────────
 * Shared component used in three places:
 *   1. Sidebar alert card       → compact inline variant
 *   2. Map zone popup           → compact inline variant
 *   3. Evacuation panel         → expanded variant with confidence bar
 *
 * i18n note: all strings are in this file for easy extraction later.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { formatRemainingTimeLabel } from '../utils/remainingTime';

/**
 * Format an ISO timestamp as "HH:MM WIB" in Jakarta local time.
 */
function formatWIB(isoString) {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' WIB';
  } catch {
    return null;
  }
}

/**
 * Format as "Today HH:MM" or "Tomorrow HH:MM" for clarity.
 */
function formatRelativeWIB(isoString) {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    const now = new Date();
    const jakartaOffset = 7 * 60; // WIB = UTC+7
    const dateWIB = new Date(date.getTime() + (jakartaOffset - date.getTimezoneOffset()) * 60000);
    const nowWIB  = new Date(now.getTime()  + (jakartaOffset - now.getTimezoneOffset())  * 60000);

    const sameDay = dateWIB.toDateString() === nowWIB.toDateString();
    const time = date.toLocaleTimeString('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return sameDay ? `${time} Jakarta time` : `Tomorrow ${time} Jakarta time`;
  } catch {
    return formatWIB(isoString);
  }
}

/**
 * Confidence colour — green >75, amber 50-75, red <50.
 */
function confColor(pct, isLight = true) {
  if (pct >= 75) return { text: isLight ? 'text-emerald-600' : 'text-emerald-400', bar: 'bg-emerald-400' };
  if (pct >= 50) return { text: isLight ? 'text-amber-600' : 'text-amber-400', bar: 'bg-amber-400' };
  return            { text: isLight ? 'text-red-600' : 'text-red-400', bar: 'bg-red-400' };
}

/**
 * Compact variant — one line, used in sidebar card and map popup.
 */
export function ResolutionBadgeCompact({ estimated_resolution_at, resolution_confidence, theme = 'light' }) {
  const time = formatRelativeWIB(estimated_resolution_at);
  const conf = Math.round(resolution_confidence || 0);
  if (!time || conf === 0) return null;

  const isLight = theme === 'light';
  const { text } = confColor(conf, isLight);
  const uncertain = conf < 60;
  const remainingLabel = formatRemainingTimeLabel(estimated_resolution_at);
  const mutedText = isLight ? 'text-slate-700' : 'text-slate-300';

  return (
    <div className={`flex items-center gap-1.5 text-xs font-medium ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
      <span>🕐</span>
      <span>
        {uncertain ? (
          <>
            <span className={`font-bold ${text}`}>Clear time not confirmed yet</span>
            {remainingLabel && <span className={`ml-1 ${mutedText}`}>· {remainingLabel}</span>}
          </>
        ) : (
          <>
            <span>Clears around</span>{' '}
            <span className={`font-bold ${text}`}>{time}</span>
            {remainingLabel && <span className={`ml-1 ${mutedText}`}>· {remainingLabel}</span>}
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Expanded variant — used in evacuation panel, shows confidence bar.
 */
export function ResolutionBadgeExpanded({ estimated_resolution_at, resolution_confidence, disruption_type, theme = 'light' }) {
  const time = formatRelativeWIB(estimated_resolution_at);
  const conf = Math.round(resolution_confidence || 0);
  if (!time || conf === 0) return null;

  const isLight = theme === 'light';
  const { text, bar } = confColor(conf, isLight);
  const remainingLabel = formatRemainingTimeLabel(estimated_resolution_at);
  const muted = isLight ? 'text-slate-700' : 'text-slate-300';

  const disclaimer = {
    traffic:    'Based on historical rush hour patterns for this zone.',
    weather:    'Based on Open-Meteo hourly precipitation forecast.',
    crowd:      'Based on typical crowd dispersal times for this hour.',
    earthquake: 'Based on Omori-Utsu aftershock decay model.',
    waterway:   'Based on gate level readings and downstream travel time.',
    flood:      'Based on Katulampa gate readings + 8–12h Jakarta travel time.',
  }[disruption_type?.toLowerCase()] ?? 'Based on current data and historical patterns.';

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-slate-800/60'}`}>
      <div className="flex items-center gap-2">
        <span className="text-base">🕐</span>
        <div>
          <p className={`text-xs font-semibold uppercase tracking-wide ${muted}`}>
            Estimated Resolution
          </p>
          <p className={`font-bold text-sm ${text}`}>
            {conf < 60 ? 'Clear time not confirmed yet' : time}
          </p>
          {remainingLabel && (
            <p className={`mt-1 text-[11px] font-medium ${isLight ? 'text-slate-700' : 'text-slate-200'}`}>
              {remainingLabel}
            </p>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between text-xs mb-1">
          <span className={muted}>Prediction reliability</span>
          <span className={`font-bold ${text}`}>{conf}%</span>
        </div>
        <div className={`w-full h-1.5 rounded-full overflow-hidden ${isLight ? 'bg-slate-200' : 'bg-slate-700'}`}>
          <div
            className={`h-full rounded-full ${bar} transition-all duration-700`}
            style={{ width: `${conf}%` }}
          />
        </div>
        {conf < 60 && (
          <p className={`text-[11px] mt-1 italic ${muted}`}>
            Prediction reliability is low — we have hidden the specific time to avoid giving a misleading estimate.
          </p>
        )}
      </div>

      <p className={`text-xs leading-relaxed ${muted}`}>{disclaimer}</p>
    </div>
  );
}
