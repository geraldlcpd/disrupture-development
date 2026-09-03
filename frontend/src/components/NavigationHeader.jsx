import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  formatDistanceM,
  formatDisruptionType,
  maneuverIcon,
  riskChipClass,
} from '../utils/navUi.js';

export default function NavigationHeader({
  session,
  theme = 'light',
  isMobile = true,
  belowAppHeader = false,
  onExit,
  onSelectNearby,
}) {
  const isLight = theme === 'light';
  const [confirmExit, setConfirmExit] = useState(false);

  useEffect(() => {
    if (!confirmExit) return undefined;
    const t = setTimeout(() => setConfirmExit(false), 3000);
    return () => clearTimeout(t);
  }, [confirmExit]);

  const status = session?.status;
  const ManeuverIcon = maneuverIcon(session?.currentManeuver?.maneuver);
  const nearby = session?.nearbyDisruption;
  const nearbyPred = nearby?.prediction;
  const risk = nearbyPred?.risk_level || nearbyPred?.severity || 'Medium';
  const landscape = isMobile && typeof window !== 'undefined' && window.innerHeight < 500;

  const panel = isLight
    ? 'bg-white/95 border-slate-200 text-slate-900'
    : 'bg-slate-950/95 border-slate-700 text-white';

  const handleExit = () => {
    if (!confirmExit) {
      setConfirmExit(true);
      return;
    }
    onExit?.();
  };

  let body;
  if (status === 'arrived') {
    body = (
      <p className="text-lg font-extrabold leading-tight">You have arrived</p>
    );
  } else if (status === 'rerouting') {
    body = (
      <p className="text-lg font-extrabold leading-tight text-amber-400">Rerouting…</p>
    );
  } else if (status === 'off_route') {
    body = (
      <p className="text-lg font-extrabold leading-tight text-orange-400">Off route</p>
    );
  } else {
    body = (
      <div className={`flex items-center gap-3 min-w-0 ${landscape ? '' : ''}`}>
        <ManeuverIcon className="w-9 h-9 shrink-0" strokeWidth={2.4} />
        <div className="min-w-0">
          <p className="text-[1.35rem] font-extrabold leading-none tabular-nums">
            {formatDistanceM(session?.distanceToManeuverM)}
          </p>
          <p className="text-sm font-semibold truncate mt-0.5">
            {session?.currentManeuver?.street
              || session?.currentManeuver?.text
              || 'Continue'}
          </p>
          {!landscape && session?.nextManeuver && (
            <p className={`text-[11px] truncate ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
              then {session.nextManeuver.street || session.nextManeuver.text || 'continue'}
            </p>
          )}
        </div>
      </div>
    );
  }

  const nearbyLabel = nearbyPred
    ? nearby.aheadM <= 0
      ? `Entering ${formatDisruptionType(nearbyPred.disruption_type)} zone`
      : `${formatDisruptionType(nearbyPred.disruption_type)} · ${formatDistanceM(nearby.aheadM)} ahead`
    : null;

  return (
    <header
      className={`pointer-events-auto rounded-b-2xl border-b shadow-lg ${panel}`}
      style={
        belowAppHeader
          ? undefined
          : { paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }
      }
    >
      <div className="flex items-start gap-2 px-3 pb-2 pt-1">
        <div className="min-w-0 flex-1">{body}</div>
        <button
          type="button"
          onClick={handleExit}
          aria-label={confirmExit ? 'Confirm exit navigation' : 'Exit navigation'}
          className={`shrink-0 min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center text-xs font-bold ${
            confirmExit
              ? 'bg-red-600 text-white px-3'
              : isLight
                ? 'bg-slate-100 text-slate-700'
                : 'bg-slate-800 text-slate-100'
          }`}
        >
          {confirmExit ? 'Exit?' : <X className="w-5 h-5" />}
        </button>
      </div>
      {nearbyLabel && status !== 'arrived' && (
        <button
          type="button"
          onClick={() => nearbyPred && onSelectNearby?.(nearbyPred)}
          className={`mx-3 mb-2 w-[calc(100%-1.5rem)] rounded-lg px-3 py-1.5 text-left text-xs font-bold ${riskChipClass(risk, isLight)}`}
        >
          {nearbyLabel}
          {nearbyPred?.zone?.name ? ` · ${nearbyPred.zone.name}` : ''}
        </button>
      )}
    </header>
  );
}
