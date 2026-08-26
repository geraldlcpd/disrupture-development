import { useState } from 'react';
import { ResolutionBadgeCompact } from './ResolutionBadge';
import { MlRiskBadgeCompact } from './MlRiskBadge';
import { MlResolutionBadgeCompact } from './MlResolutionBadge';

const TYPE_LABEL = {
  traffic: 'Traffic',
  weather: 'Weather',
  flood: 'Flood',
  waterway: 'Flood',
  crowd: 'Crowd',
  earthquake: 'Earthquake',
};

function typeLabel(disruptionType) {
  const key = String(disruptionType || '').toLowerCase();
  return TYPE_LABEL[key] || (disruptionType || 'Alert');
}

function riskColor(risk, isLight) {
  switch (risk) {
    case 'Critical':
      return 'text-red-500 border-red-500/20 bg-red-500/5';
    case 'High':
      return 'text-orange-500 border-orange-500/20 bg-orange-500/5';
    case 'Medium':
      return isLight
        ? 'text-yellow-700 border-yellow-600/30 bg-yellow-500/10'
        : 'text-yellow-300 border-yellow-500/20 bg-yellow-500/5';
    default:
      return isLight
        ? 'text-emerald-600 border-emerald-500/20 bg-emerald-500/5'
        : 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5';
  }
}

export default function AlertCard({
  prediction,
  theme = 'light',
  selected = false,
  onClick,
  onSafeRoute,
  showSafeRoute = false,
  safeRouteVariant = 'hidden',
}) {
  const [showDetails, setShowDetails] = useState(false);
  const isLight = theme === 'light';
  if (!prediction) return null;

  const zoneName = prediction.zone?.name ?? 'Unknown area';
  const risk = prediction.risk_level || prediction.severity || 'Medium';

  const routeVariant = safeRouteVariant !== 'hidden'
    ? safeRouteVariant
    : showSafeRoute
      ? 'primary'
      : 'hidden';

  const showPrimaryRoute = routeVariant === 'primary' && onSafeRoute;
  const showLinkRoute = routeVariant === 'link' && onSafeRoute && showDetails;

  return (
    <div
      onClick={onClick}
      className={`p-3 rounded-xl border cursor-pointer transition-all duration-200 ${
        selected
          ? isLight
            ? 'border-indigo-500 bg-indigo-50'
            : 'border-indigo-500 bg-indigo-500/10'
          : isLight
            ? 'border-slate-200 bg-white hover:bg-slate-50'
            : 'border-slate-800 bg-slate-900/50 hover:bg-slate-900'
      }`}
    >
      <p className={`font-semibold text-sm leading-snug ${isLight ? 'text-slate-900' : 'text-slate-200'}`}>
        {zoneName}
      </p>

      <div className="mt-1 flex items-center justify-between gap-2">
        <p className={`text-xs min-w-0 truncate ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
          {typeLabel(prediction.disruption_type)}
        </p>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border shrink-0 ${riskColor(risk, isLight)}`}>
          {risk}
        </span>
      </div>

      {prediction.estimated_resolution_at && (
        <div className={`mt-1.5 line-clamp-2 ${showDetails ? 'line-clamp-none' : ''}`}>
          <ResolutionBadgeCompact
            estimated_resolution_at={prediction.estimated_resolution_at}
            resolution_confidence={prediction.resolution_confidence}
            theme={theme}
          />
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowDetails((v) => !v);
          }}
          className={`text-[11px] font-semibold shrink-0 ${isLight ? 'text-indigo-600' : 'text-indigo-400'}`}
        >
          {showDetails ? 'Hide details' : 'More details'}
        </button>
        {showPrimaryRoute && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSafeRoute(prediction);
            }}
            className="text-[11px] font-bold px-2 py-1 rounded-lg bg-red-600 text-white shrink-0"
          >
            Safe route
          </button>
        )}
      </div>

      {showDetails && (
        <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800/60 space-y-1.5">
          {prediction.estimated_time_to_peak && (
            <p className={`text-[11px] ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
              Peak around {String(prediction.estimated_time_to_peak).slice(11, 16) || prediction.estimated_time_to_peak}
            </p>
          )}
          {prediction.probability_percentage != null && (
            <p className={`text-[11px] ${isLight ? 'text-slate-600' : 'text-slate-400'}`}>
              Warning confidence {prediction.probability_percentage}%
            </p>
          )}
          {prediction.id && <MlResolutionBadgeCompact alertId={prediction.id} theme={theme} />}
          <MlRiskBadgeCompact zoneId={prediction.zone?.zone_id ?? prediction.zone?.id} theme={theme} />
          {showLinkRoute && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSafeRoute(prediction);
              }}
              className={`text-[11px] font-semibold ${isLight ? 'text-indigo-600' : 'text-indigo-400'}`}
            >
              Get safe route →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
