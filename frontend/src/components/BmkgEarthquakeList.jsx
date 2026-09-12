import { Layers } from 'lucide-react';
import { formatEarthquakeWhenEn } from '../utils/formatEarthquake';

function isSameEarthquake(a, b) {
  if (!a || !b) return false;
  return a.datetime === b.datetime && a.latitude === b.latitude;
}

export default function BmkgEarthquakeList({
  earthquakes = [],
  selectedEarthquake = null,
  onSelectEarthquake,
  onViewOnMap,
  theme = 'light',
  maxHeightClass = '',
  showHeader = true,
  touchFriendly = false,
}) {
  const isLight = theme === 'light';

  const handleView = (eq, isSelected) => {
    const next = isSelected ? null : eq;
    if (onViewOnMap && next) {
      onViewOnMap(next);
      return;
    }
    onSelectEarthquake?.(next);
  };

  return (
    <div className={showHeader ? `pt-4 border-t ${isLight ? 'border-slate-200' : 'border-slate-800/80'}` : ''}>
      {showHeader && (
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center space-x-2 text-slate-800 dark:text-slate-100 font-bold text-lg min-w-0">
            <Layers className="w-5 h-5 text-red-500 animate-pulse shrink-0" />
            <h2 className="truncate">BMKG Live Earthquakes</h2>
          </div>
          <span className={`text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded shrink-0 ${
            isLight
              ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
              : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
          }`}>
            {earthquakes.length} {earthquakes.length === 1 ? 'event' : 'events'}
          </span>
        </div>
      )}

      <div className={`space-y-2.5 overflow-y-auto pr-1 ${maxHeightClass}`}>
        {earthquakes.length === 0 ? (
          <div className={`text-center py-6 border border-dashed rounded-xl ${
            isLight ? 'border-slate-300' : 'border-slate-800'
          }`}>
            <p className={`text-xs font-medium ${isLight ? 'text-slate-600' : 'text-slate-500'}`}>
              No recent earthquakes recorded.
            </p>
          </div>
        ) : (
          earthquakes.map((eq, idx) => {
            const isMajor = eq.magnitude >= 6.0;
            const isSelected = isSameEarthquake(selectedEarthquake, eq);
            const magnitudeBorder = isMajor
              ? 'border-l-red-500'
              : isLight
                ? 'border-l-orange-400'
                : 'border-l-orange-500/80';

            return (
              <div
                key={eq.event_id || eq.id || idx}
                className={`p-3 rounded-lg border border-l-4 text-xs space-y-1.5 transition-all duration-200 ${magnitudeBorder} ${
                  isSelected
                    ? 'border-red-500 bg-red-500/10 shadow-[0_0_12px_rgba(239,68,68,0.25)]'
                    : isLight
                      ? 'border-slate-200 bg-white hover:border-slate-300'
                      : 'border-slate-800 bg-slate-900/30 hover:border-slate-700/80'
                }`}
              >
                <div className="flex justify-between items-start gap-2">
                  <span className={`font-semibold line-clamp-2 min-w-0 flex-1 ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                    {eq.wilayah}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded border ${
                      isMajor
                        ? 'bg-red-500/20 text-red-400 border-red-500/30 animate-pulse'
                        : 'bg-orange-500/20 text-orange-400 border-orange-500/30'
                    }`}>
                      M {eq.magnitude.toFixed(1)}
                    </span>
                  </div>
                </div>

                <div className={`flex justify-between items-center gap-2 pt-1 border-t ${
                  isLight ? 'border-slate-200' : 'border-slate-800/20'
                }`}>
                  <span className={`text-[10px] font-medium min-w-0 truncate ${isLight ? 'text-slate-600' : 'text-slate-500'}`}>
                    {formatEarthquakeWhenEn(eq.datetime, { eventId: eq.event_id })}
                    <span className="mx-1">·</span>
                    Depth: {eq.depth}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleView(eq, isSelected)}
                    className={`rounded font-extrabold tracking-wider uppercase transition-all duration-200 shrink-0 ${
                      touchFriendly ? 'min-h-[44px] px-3 py-2 text-[10px]' : 'px-2 py-0.5 text-[9px]'
                    } ${
                      isSelected
                        ? 'bg-red-600 text-white shadow-glow animate-pulse'
                        : isLight
                          ? 'bg-slate-800 text-white hover:bg-slate-700'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    {isSelected ? 'Viewing' : 'View'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
