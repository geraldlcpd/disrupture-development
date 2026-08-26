import React, { useState, useEffect, useMemo, useRef } from 'react';
import AlertCard from './AlertCard';
import { ResolutionBadgeCompact } from './ResolutionBadge';
import { MlResolutionBadgeCompact } from './MlResolutionBadge';
import { getApiUrl } from '../utils/getApiUrl';
import { calculateDistanceKm } from '../utils/haversine';
import BmkgEarthquakeList from './BmkgEarthquakeList';
import { useMlResolution } from '../hooks/useMlResolution';
import { 
  ResponsiveContainer, 
  ComposedChart, 
  BarChart,
  Area, 
  Bar, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip as ChartTooltip, 
  Legend, 
  LineChart,
  ReferenceLine
} from 'recharts';
import { MapPin, CloudRain, TrendingDown, Users, Bell, ShoppingBag, Train, Building, Store, Layers, Info, X, BarChart3, Clock3, Sparkles } from 'lucide-react';
import ForecastHelpContent from './ForecastHelpContent';

export default function Sidebar({ 
  predictions = [], 
  selectedPrediction, 
  onSelectPrediction,
  timelineData,
  timelineLoading,
  selectedHours = 12,
  setSelectedHours,
  earthquakes = [],
  selectedEarthquake = null,
  onSelectEarthquake,
  allZones = [],
  nearMeFilterActive = false,
  nearMeRadius = 5,
  onClearNearMeFilter,
  onGetEvacuation,
  showEvacuationPanel = false,
  evacuationPanelNode = null,
  theme = 'light',
  defaultSeverityFilter = 'all',
  severityFilterRevision = 0,
}) {
  const isLight = theme === 'light';
  const [poiFilter, setPoiFilter] = useState('all');
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [showPredictionHelp, setShowPredictionHelp] = useState(false);
  const [showForecastHelp, setShowForecastHelp] = useState(false);
  const [showBaselineHelp, setShowBaselineHelp] = useState(false);
  const [showZoneDetails, setShowZoneDetails] = useState(false);
  const [helpTab, setHelpTab] = useState('read');
  const baselineHelpRef = useRef(null);
  const { prediction: mlPrediction } = useMlResolution(selectedPrediction?.id);

  useEffect(() => {
    setShowZoneDetails(false);
    setShowBaselineHelp(false);
  }, [selectedPrediction?.id]);

  useEffect(() => {
    if (!showBaselineHelp) return undefined;
    const onDocClick = (e) => {
      if (baselineHelpRef.current && !baselineHelpRef.current.contains(e.target)) {
        setShowBaselineHelp(false);
      }
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setShowBaselineHelp(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showBaselineHelp]);

  useEffect(() => {
    if (severityFilterRevision > 0) {
      setSeverityFilter(defaultSeverityFilter);
    }
  }, [severityFilterRevision, defaultSeverityFilter]);

  // LOW tier: zones monitored with no OPEN alert
  const activeZoneIds = new Set(
    predictions.map(p => p.zone?.zone_id ?? p.zone?.id).filter(Boolean)
  );
  const lowZones = allZones.filter(zs =>
    !activeZoneIds.has(zs.zone_id) && zs.zone &&
    (zs.overall_risk_score > 0 || zs.traffic_score > 0 || zs.crowd_score > 0)
  );
  const showingLowTier = severityFilter === 'Low';

  // Fetch global POIs for Nearby Infrastructure section
  const [globalPois, setGlobalPois] = useState([]);
  useEffect(() => {
    fetch(`${getApiUrl()}/pois`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setGlobalPois(data))
      .catch(() => {});
  }, []);

  // Filter POIs near the selected zone (within zone radius + 500m buffer)
  const nearbyPois = useMemo(() => {
    if (!selectedPrediction?.zone || globalPois.length === 0) return [];
    const z = selectedPrediction.zone;
    const lat = z.latitude ?? z.geometry?.coordinates?.[0]?.[0]?.[1];
    const lon = z.longitude ?? z.geometry?.coordinates?.[0]?.[0]?.[0];
    if (!lat || !lon) return [];
    const radiusKm = ((z.radius_m ?? 1000) + 500) / 1000;
    return globalPois.filter(poi =>
      calculateDistanceKm(lat, lon, poi.lat, poi.lon) <= radiusKm
    );
  }, [selectedPrediction, globalPois]);

  // Dashboard tab state


  // Severity breakdown chart data
  const breakdownData = (() => {
    const types = ['traffic', 'crowd', 'waterway', 'weather', 'earthquake'];
    const byType = {};
    types.forEach(t => { byType[t] = { type: t.charAt(0).toUpperCase() + t.slice(1), HIGH: 0, MEDIUM: 0 }; });
    predictions.forEach(p => {
      const t = (p.disruption_type || '').toLowerCase();
      if (byType[t]) {
        const sev = (p.risk_level || p.severity || '').toUpperCase();
        if (sev === 'HIGH' || sev === 'MEDIUM') byType[t][sev]++;
      }
    });
    return types.filter(t => byType[t].HIGH + byType[t].MEDIUM > 0).map(t => byType[t]);
  })();


  
  const formatTime = (timeStr) => {
    if (!timeStr) return '';
    let normalizedStr = timeStr;
    if (!timeStr.endsWith('Z') && !timeStr.includes('+') && !timeStr.includes('-T') && !timeStr.match(/-\d{2}:\d{2}$/)) {
      normalizedStr = timeStr + 'Z';
    }
    const date = new Date(normalizedStr);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const getRiskColor = (risk) => {
    switch (risk) {
      case 'Critical': return 'bg-red-500/20 text-red-400 border-red-500/30';
      case 'High': return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
      case 'Medium': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      case 'Low':
      default: return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
    }
  };

  const getPoiIcon = (category) => {
    switch (category) {
      case 'hospital':        return <span className="text-base">🏥</span>;
      case 'police':          return <span className="text-base">🚔</span>;
      case 'university':      return <span className="text-base">🎓</span>;
      case 'mall':            return <ShoppingBag className="w-4 h-4 text-pink-400" />;
      case 'market':          return <Store className="w-4 h-4 text-amber-400" />;
      case 'station':         return <Train className="w-4 h-4 text-blue-400" />;
      case 'unique_building': return <Building className="w-4 h-4 text-purple-400" />;
      case 'small_business':  return <Store className="w-4 h-4 text-amber-400" />;
      default:                return <MapPin className="w-4 h-4 text-indigo-400" />;
    }
  };

  const filteredPois = (poiFilter === 'all'
    ? nearbyPois
    : nearbyPois.filter(poi => poi.category === poiFilter)
  );

  const now = new Date();
  const sixHoursFromNow = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  
  const PREVIEW_COUNT = 5;
  const filteredByType = showingLowTier
    ? []
    : predictions.filter(pred => {
        if (severityFilter === 'all') return true;
        return pred.risk_level.toLowerCase() === severityFilter.toLowerCase();
      });
  const displayedWarnings = showAllWarnings
    ? filteredByType
    : filteredByType.slice(0, PREVIEW_COUNT);

  const nowLabel = timelineData?.timeline?.[0] ? formatTime(timelineData.timeline[0].timestamp) : null;

  const formatHoursLabel = (hours) => {
    if (hours == null || Number.isNaN(hours)) return 'Unknown';
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    if (hours < 2) return `${hours.toFixed(1)} hour`;
    return `${hours.toFixed(1)} hours`;
  };

  const getMinutesRemaining = (estimate) => {
    if (!estimate) return null;
    const diff = Math.round((new Date(estimate) - new Date()) / 60000);
    return diff > 0 ? diff : 0;
  };

  const selectedAlertComparison = useMemo(() => {
    if (!selectedPrediction) {
      return {
        isExample: true,
        rows: [
          { label: 'Standard estimate', valueLabel: '2.7 hours remaining', confidence: '65% confidence', percent: 70, tint: 'bg-indigo-500' },
          { label: 'AI prediction', valueLabel: '2.0 hours remaining', confidence: '47% confidence', percent: 50, tint: 'bg-cyan-500' },
        ],
      };
    }

    const standardHours = selectedPrediction.estimated_resolution_at
      ? Math.max(0.1, getMinutesRemaining(selectedPrediction.estimated_resolution_at) / 60)
      : null;
    const mlHours = mlPrediction?.estimated_resolution_at
      ? Math.max(0.1, getMinutesRemaining(mlPrediction.estimated_resolution_at) / 60)
      : null;

    const rows = [];
    if (standardHours != null) {
      rows.push({
        label: 'Standard estimate',
        valueLabel: `${formatHoursLabel(standardHours)} remaining`,
        confidence: `${Math.round(selectedPrediction.resolution_confidence || selectedPrediction.probability_percentage || 0)}% confidence`,
        percent: Math.min(100, Math.max(20, Math.round(standardHours / 3 * 100))),
        tint: 'bg-indigo-500',
      });
    }
    if (mlHours != null) {
      rows.push({
        label: 'AI prediction',
        valueLabel: `${formatHoursLabel(mlHours)} remaining`,
        confidence: `${Math.round(mlPrediction?.resolution_confidence || 0)}% confidence`,
        percent: Math.min(100, Math.max(20, Math.round(mlHours / 3 * 100))),
        tint: 'bg-cyan-500',
      });
    }

    return { isExample: false, rows: rows.length > 0 ? rows : [
      { label: 'Standard estimate', valueLabel: 'Estimate pending', confidence: 'Waiting for fresh telemetry', percent: 25, tint: 'bg-indigo-500' },
    ]};
  }, [selectedPrediction, mlPrediction]);

  const confidenceBreakdown = useMemo(() => {
    const buckets = [
      { label: 'High confidence', min: 70, count: 0, accent: 'bg-emerald-500' },
      { label: 'Medium confidence', min: 40, count: 0, accent: 'bg-amber-500' },
      { label: 'Low confidence', min: 0, count: 0, accent: 'bg-rose-500' },
    ];

    predictions.forEach((prediction) => {
      const value = Number(prediction.probability_percentage ?? 0);
      if (value >= 70) buckets[0].count += 1;
      else if (value >= 40) buckets[1].count += 1;
      else buckets[2].count += 1;
    });

    return buckets;
  }, [predictions]);

  const clearTimeTimeline = useMemo(() => {
    const buckets = [
      { label: '0-15 min', count: 0 },
      { label: '15-30 min', count: 0 },
      { label: '30-60 min', count: 0 },
      { label: '60+ min', count: 0 },
    ];

    predictions.forEach((prediction) => {
      const estimate = selectedPrediction?.id === prediction.id && mlPrediction?.estimated_resolution_at
        ? mlPrediction.estimated_resolution_at
        : prediction.estimated_resolution_at;
      const minutes = getMinutesRemaining(estimate);
      if (minutes == null) return;
      if (minutes <= 15) buckets[0].count += 1;
      else if (minutes <= 30) buckets[1].count += 1;
      else if (minutes <= 60) buckets[2].count += 1;
      else buckets[3].count += 1;
    });

    return buckets.filter((bucket) => bucket.count > 0);
  }, [predictions, mlPrediction, selectedPrediction]);

  return (
    <div className="w-full flex flex-col h-full bg-brand-elevated border-l border-slate-800 overflow-hidden">

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Selected Zone Analytical Projections */}
      {selectedPrediction && (
        <div className="flex flex-col space-y-6 pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center space-x-2 text-indigo-400 font-semibold mb-1">
              <MapPin className="w-4 h-4" />
              <span className="text-xs uppercase tracking-wider">Selected Zone Analysis</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-100">{selectedPrediction?.zone?.name ?? 'Unknown Zone'}</h1>
              {selectedPrediction?.risk_level && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${getRiskColor(selectedPrediction.risk_level)}`}>
                  {selectedPrediction.risk_level}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4">
              <div className="bg-slate-900/40 border border-slate-800/80 rounded-lg p-2.5 flex flex-col justify-center">
                <span className="text-[10px] text-slate-400">Predicted Disruption</span>
                <span className="font-semibold text-sm text-slate-200">{selectedPrediction.disruption_type}</span>
              </div>
              <div className="bg-slate-900/40 border border-slate-800/80 rounded-lg p-2.5 flex flex-col justify-center">
                <span className="text-[10px] text-slate-400">Peak around</span>
                <span className="font-semibold text-sm text-indigo-400">{formatTime(selectedPrediction.estimated_time_to_peak)}</span>
              </div>
            </div>
            {selectedPrediction?.estimated_resolution_at && (
              <div className="mt-3 bg-slate-900/40 border border-slate-800/80 rounded-lg p-2.5">
                <span className="text-[10px] text-slate-400 block mb-1">Resolution Estimate</span>
                <ResolutionBadgeCompact
                  estimated_resolution_at={selectedPrediction.estimated_resolution_at}
                  resolution_confidence={selectedPrediction.resolution_confidence}
                  theme={theme}
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowZoneDetails((v) => !v)}
              className="mt-3 w-full py-2 rounded-lg border border-slate-700 text-xs font-semibold text-indigo-400"
            >
              {showZoneDetails ? 'Hide details' : 'More details'}
            </button>
          </div>

          {showZoneDetails && (
          <>
          <MlResolutionBadgeCompact alertId={selectedPrediction.id} theme={theme} />

          <div className="bg-slate-900/40 border border-slate-800/80 rounded-lg p-2.5 text-center">
            <div ref={baselineHelpRef} className="relative flex items-center justify-center space-x-1.5">
              <p className="text-[10px] text-slate-400">Baseline Speed</p>
              <button
                type="button"
                onClick={() => setShowBaselineHelp((v) => !v)}
                aria-expanded={showBaselineHelp}
                className="text-slate-400 hover:text-indigo-400 focus:outline-none transition-colors p-0.5 rounded-full"
                title="What is baseline speed?"
                aria-label="What is baseline speed?"
              >
                <Info className="w-3 h-3" />
              </button>
              {showBaselineHelp && (
                <div
                  role="dialog"
                  aria-labelledby="baseline-speed-help-title"
                  className={`absolute z-[2000] top-full right-0 mt-1.5 w-72 rounded-xl border border-t-2 border-t-indigo-500 p-3 text-left shadow-xl ${
                    isLight
                      ? 'bg-white border-slate-200 text-slate-900'
                      : 'bg-slate-900 border-slate-700 text-slate-100'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center space-x-1.5 min-w-0">
                      <Info className="w-4 h-4 text-indigo-500 shrink-0" />
                      <h3
                        id="baseline-speed-help-title"
                        className={`text-xs font-bold ${
                          isLight ? 'text-slate-900' : 'text-slate-100'
                        }`}
                      >
                        What is Baseline Speed?
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowBaselineHelp(false)}
                      className={`shrink-0 rounded-full border p-1 transition ${
                        isLight
                          ? 'border-slate-300/80 text-slate-600 hover:border-indigo-500/60 hover:text-indigo-600'
                          : 'border-slate-700 text-slate-300 hover:border-indigo-500/60 hover:text-indigo-400'
                      }`}
                      aria-label="Close baseline speed explanation"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p
                    className={`mt-2 text-xs leading-relaxed ${
                      isLight ? 'text-slate-700' : 'text-slate-300'
                    }`}
                  >
                    Baseline speed is how fast traffic usually moves in this area on a normal day. If traffic is much slower than that now, congestion may be building.
                  </p>
                </div>
              )}
            </div>
            <p className="text-lg font-bold text-slate-200">
              {selectedPrediction?.zone?.traffic_speed_baseline ?? 'N/A'}{' '}
              <span className="text-xs font-normal">km/h</span>
            </p>
          </div>

          {/* Dynamic Infrastructure POI Section */}
          <div className="space-y-3 pt-2 border-t border-slate-800/50">
            <h3 className="text-sm font-semibold text-slate-300 flex items-center space-x-2">
              <Layers className="w-4 h-4 text-indigo-400" />
              <span>Nearby Infrastructure & POIs</span>
            </h3>
            
            {/* Category Filter Tabs */}
            <div className="flex flex-wrap gap-1.5 pb-2">
              {[
                { id: 'all', label: 'All' },
                { id: 'hospital', label: '🏥 Hospital' },
                { id: 'police', label: '🚔 Police' },
                { id: 'university', label: '🎓 University' },
                { id: 'mall', label: '🏬 Mall' },
                { id: 'station', label: '🚉 Station' },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setPoiFilter(tab.id)}
                  className={`text-[10px] px-2 py-1 rounded font-medium border transition-all duration-200 ${
                    poiFilter === tab.id
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 font-bold'
                      : 'border-slate-300 dark:border-slate-800 bg-slate-100 dark:bg-slate-900/30 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* POI Scroll Container */}
            <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
              {filteredPois.length > 0 ? (
                filteredPois.map((poi, idx) => (
                  <div key={idx} className="p-2.5 rounded-lg bg-slate-900/40 border border-slate-800/60 text-xs">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center space-x-2 min-w-0">
                        {getPoiIcon(poi.category)}
                        <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">{poi.name}</span>
                      </div>
                      <span className="text-[9px] uppercase font-bold tracking-widest text-slate-500 bg-slate-950/60 px-1.5 py-0.5 rounded shrink-0 ml-2">
                        {poi.category.replace('_', ' ')}
                      </span>
                    </div>
                    {poi.crowd_score != null ? (
                      <div>
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-[9px] text-slate-500 font-semibold">👥 Crowd</span>
                          <span className={`text-[9px] font-bold ${
                            poi.crowd_score >= 65 ? 'text-red-400' :
                            poi.crowd_score >= 35 ? 'text-amber-400' : 'text-emerald-400'
                          }`}>
                            {poi.crowd_score >= 65 ? 'High' : poi.crowd_score >= 35 ? 'Moderate' : 'Low'}
                            <span className="font-normal text-slate-500 ml-1">({Math.round(poi.crowd_score)})</span>
                          </span>
                        </div>
                        <div className="w-full bg-slate-800 rounded-full h-1 overflow-hidden">
                          <div
                            className={`h-1 rounded-full transition-all ${
                              poi.crowd_score >= 65 ? 'bg-red-500' :
                              poi.crowd_score >= 35 ? 'bg-amber-400' : 'bg-emerald-400'
                            }`}
                            style={{ width: `${Math.min(100, poi.crowd_score)}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <span className="text-[9px] text-slate-600">No crowd data</span>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-center py-4 text-[11px] text-slate-500 border border-dashed border-slate-800 rounded-lg">
                  No matching facilities found in this geofence.
                </div>
              )}
            </div>
          </div>

          {/* Dynamic Weather & Speed Projections */}
          <div className="flex-1 flex flex-col space-y-4 pt-2 border-t border-slate-800/50">
            <div className="flex justify-between items-center gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-300 flex items-center space-x-2">
                  <CloudRain className="w-4 h-4 text-sky-400" />
                  <span>{selectedHours}-Hour Forecast Projections</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setShowForecastHelp(true)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-slate-600 transition hover:border-indigo-500/60 hover:text-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:text-indigo-400"
                  aria-label="Forecast graph help"
                  title="Forecast graph help"
                >
                  <Info className="h-4 w-4" />
                </button>
              </div>

              <div className="flex bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-800/60 rounded-lg p-0.5 space-x-0.5">
                {[3, 6, 12, 24].map(h => {
                  const isActive = selectedHours === h;
                  return (
                    <button
                      key={h}
                      onClick={() => setSelectedHours(h)}
                      className={`text-[9px] px-2 py-0.5 rounded font-semibold transition-all duration-200 ${
                        isActive
                          ? 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-500 dark:text-indigo-400 font-bold'
                          : 'border border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                      }`}
                    >
                      {h}h
                    </button>
                  );
                })}
              </div>
            </div>

            {timelineLoading ? (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-xs">
                Analyzing spatial indexes and streaming API updates...
              </div>
            ) : timelineData && timelineData.timeline && timelineData.timeline.length > 0 ? (
              <div className="space-y-6 flex-1">
                {/* Weather Chart */}
                <div className="h-44 w-full bg-slate-950/40 border border-slate-900 rounded-xl p-3 flex flex-col">
                  <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider mb-2">Rainfall &amp; Humidity Forecast</span>
                  <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart 
                        data={timelineData.timeline.filter(d => d.humidity != null || d.rainfall != null).map(d => ({
                          time: formatTime(d.timestamp),
                          probability: d.humidity ?? null,
                          rain: d.rainfall ?? null
                        }))}
                        margin={{ top: 5, right: 5, left: -25, bottom: 0 }}
                      >
                        <XAxis dataKey="time" stroke="#475569" fontSize={9} />
                        <YAxis yAxisId="left" stroke="#38bdf8" fontSize={9} unit="%" domain={[0, 100]} />
                        <YAxis yAxisId="right" orientation="right" stroke="#6636f1" fontSize={9} unit="mm" />
                        <ChartTooltip 
                          contentStyle={{ backgroundColor: '#151d30', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '8px' }}
                          labelStyle={{ color: '#e2e8f0', fontSize: '11px', fontWeight: 'bold' }}
                          itemStyle={{ fontSize: '10px' }}
                        />
                        <Area yAxisId="left" type="monotone" dataKey="probability" fill="#38bdf8" stroke="#38bdf8" fillOpacity={0.15} name="Humidity (%)" />
                        <Bar yAxisId="right" dataKey="rain" fill="#6366f1" radius={[2, 2, 0, 0]} name="Rain (mm)" />
                        {nowLabel && (
                          <ReferenceLine 
                            yAxisId="left"
                            x={nowLabel} 
                            stroke="#ef4444" 
                            strokeWidth={1.5}
                            strokeDasharray="3 3" 
                            label={{ value: 'NOW', position: 'insideTopLeft', fill: '#f87171', fontSize: 8, fontWeight: 'bold' }} 
                          />
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Speed Drop Chart */}
                <div className="h-44 w-full bg-slate-950/40 border border-slate-900 rounded-xl p-3 flex flex-col">
                  <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider mb-2 flex items-center justify-between">
                    <span>Traffic speed</span>
                    <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
                  </span>
                  <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart 
                        data={(() => {
                          const pts = (timelineData?.timeline || []).filter(d => d.speed != null);
                          return pts.map(d => ({
                            time: formatTime(d.timestamp),
                            speed: d.speed,
                          }));
                        })()}
                        margin={{ top: 5, right: 5, left: -25, bottom: 0 }}
                      >
                        <XAxis dataKey="time" stroke="#475569" fontSize={9} />
                        <YAxis stroke="#94a3b8" fontSize={9} unit="km/h" />
                        <ChartTooltip 
                          contentStyle={{ backgroundColor: '#151d30', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '8px' }}
                          labelStyle={{ color: '#e2e8f0', fontSize: '11px', fontWeight: 'bold' }}
                          itemStyle={{ fontSize: '10px' }}
                        />
                        {(timelineData?.timeline || []).filter(d => d.speed != null).length >= 2 ? (
                          <>
                            <Line type="monotone" dataKey="speed" stroke="#f43f5e" strokeWidth={2.5} dot={false} activeDot={false} name="Expected Speed" />
                            <ReferenceLine y={selectedPrediction?.zone?.traffic_speed_baseline ?? 40} stroke="#64748b" strokeWidth={1.5} strokeDasharray="4 4" label={{ value: 'Baseline', position: 'insideBottomRight', fill: '#64748b', fontSize: 8 }} />
                          </>
                        ) : (
                          <text x="50%" y="50%" textAnchor="middle" fill="#475569" fontSize={11}>No traffic snapshot data</text>
                        )}
                        {nowLabel && (
                          <ReferenceLine 
                            x={nowLabel} 
                            stroke="#ef4444" 
                            strokeWidth={1.5}
                            strokeDasharray="3 3" 
                            label={{ value: 'NOW', position: 'insideTopLeft', fill: '#f87171', fontSize: 8, fontWeight: 'bold' }} 
                          />
                        )}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">
                Select a polygon zone on the map to visualize predictions.
              </div>
            )}
          </div>
          </>
          )}
        </div>
      )}

      {/* Active Notifications Block */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center space-x-2 text-slate-800 dark:text-slate-100 font-bold text-lg min-w-0">
            <Bell className="w-5 h-5 text-indigo-400 shrink-0" />
            <h2 className="truncate">Nearby alerts</h2>
          </div>
          <button
            type="button"
            onClick={() => setShowPredictionHelp(true)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-300 dark:border-slate-700/80 bg-slate-100 dark:bg-slate-900/50 text-slate-600 dark:text-slate-300 transition hover:border-indigo-500/60 hover:text-indigo-500 dark:hover:text-indigo-400"
            title="How to read predictions"
            aria-label="How to read predictions"
          >
            <Info className="h-4 w-4" />
          </button>
        </div>

        {/* Evacuation guidance button — shown when active threats exist */}
        {predictions.length > 0 && !showEvacuationPanel && onGetEvacuation && (() => {
          const _sev = (predictions[0]?.severity)?.toUpperCase();
          const _isMed = _sev === 'MEDIUM';
          return (
            <div className="mb-3">
              <button
                data-tour="evacuation-trigger-desktop"
                onClick={onGetEvacuation}
                className={`w-full py-2.5 rounded-xl active:scale-95 font-bold text-sm transition-all flex items-center justify-center gap-2 ${
                  _isMed
                    ? 'bg-amber-500 hover:bg-amber-400 text-white shadow-lg shadow-amber-900/20'
                    : 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-900/30'
                }`}
              >
                <span>{_isMed ? '⚠️' : '🚨'}</span>
                <span className="flex flex-col items-center">
                      {_isMed ? 'See guidance' : 'Safe route'}
                  {_isMed && (
                    <span className="text-[10px] font-normal opacity-80">
                      Conditions developing — tap for guidance
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })()}

        {/* Evacuation panel rendered inside sidebar */}
        {showEvacuationPanel && evacuationPanelNode && (
          <div className="mb-3 rounded-xl border border-slate-700 overflow-hidden">
            {evacuationPanelNode}
          </div>
        )}

        {nearMeFilterActive && (
          <div className="glass-panel px-3 py-2.5 rounded-xl border border-indigo-500/20 text-indigo-400 text-xs flex items-center justify-between animate-pulse mb-3 mt-1 shrink-0 select-none">
            <div className="flex items-center space-x-1.5 font-semibold">
              <span>📍 Within {nearMeRadius} km of my location</span>
            </div>
            <button 
              onClick={onClearNearMeFilter}
              className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 hover:bg-indigo-500/20 transition-all"
            >
              Reset
            </button>
          </div>
        )}

        {/* Severity Filter Tabs */}
        <div className="flex flex-wrap gap-1 mb-4 pb-2 border-b border-slate-800/40">
          {[
            { id: 'all', label: 'All' },
            { id: 'Critical', label: 'Critical', color: 'border-red-500/20 text-red-400 bg-red-500/5' },
            { id: 'High', label: 'High', color: 'border-orange-500/20 text-orange-400 bg-orange-500/5' },
            { id: 'Medium', label: 'Medium', color: 'border-yellow-500/20 text-yellow-400 bg-yellow-500/5' },
          ].map(tab => {
            const isActive = severityFilter === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setSeverityFilter(tab.id)}
                className={`text-[9px] px-2 py-0.5 rounded font-semibold border transition-all duration-200 ${
                  isActive
                    ? tab.id === 'all'
                      ? 'border-indigo-500 bg-indigo-500/10 text-indigo-500'
                      : tab.color + ' font-bold scale-105'
                    : (isLight
                      ? 'border-slate-300 bg-slate-100 text-slate-700 hover:text-slate-900'
                      : 'border-slate-800 bg-slate-900/30 text-slate-400 hover:text-slate-200')
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        
        <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
          {showingLowTier ? (
            lowZones.length === 0 ? (
              <div className="text-center py-6 border border-dashed border-slate-800 rounded-xl">
                <p className="text-xs text-slate-600 dark:text-slate-500 font-medium">All zones have active alerts or no data yet.</p>
              </div>
            ) : (
              lowZones.map(zs => (
                <div key={zs.zone_id} className="p-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-bold text-emerald-400">{zs.zone?.name ?? `Zone ${zs.zone_id}`}</p>
                    <p className="text-[10px] text-slate-600 dark:text-slate-500 mt-0.5">No active alerts — being monitored</p>
                    {zs.overall_risk_score > 0 && (
                      <p className="text-[10px] text-slate-600 dark:text-slate-500">Risk score: {Number(zs.overall_risk_score).toFixed(1)}</p>
                    )}
                  </div>
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-bold border border-emerald-500/20 text-emerald-400 bg-emerald-500/5 shrink-0">LOW</span>
                </div>
              ))
            )
          ) : displayedWarnings.length === 0 ? (
            <div className="text-center py-6 border border-dashed border-slate-800 rounded-xl">
              <p className="text-xs text-slate-600 dark:text-slate-500 font-medium">No warnings match this filter.</p>
            </div>
          ) : (
            displayedWarnings.map(pred => (
              <AlertCard
                key={pred.id}
                prediction={pred}
                theme={theme}
                selected={selectedPrediction?.id === pred.id}
                onClick={() => onSelectPrediction(pred)}
                showSafeRoute={Boolean(onGetEvacuation)}
                safeRouteVariant={onGetEvacuation ? 'link' : 'hidden'}
                onSafeRoute={() => onGetEvacuation?.()}
              />
            ))
          )}
        </div>

        {filteredByType.length > PREVIEW_COUNT && !showAllWarnings && (
          <button 
            onClick={() => setShowAllWarnings(true)}
            className="w-full text-center text-[11px] text-indigo-400 hover:text-indigo-300 font-semibold py-2 mt-3 bg-slate-900/40 border border-slate-800/80 rounded-xl hover:bg-slate-900/70 transition-all duration-200"
          >
            See More
          </button>
        )}
        {showAllWarnings && filteredByType.length > PREVIEW_COUNT && (
          <button 
            onClick={() => setShowAllWarnings(false)}
            className="w-full text-center text-[11px] text-indigo-400 hover:text-indigo-300 font-semibold py-2 mt-3 bg-slate-900/40 border border-slate-800/80 rounded-xl hover:bg-slate-900/70 transition-all duration-200"
          >
            See Less
          </button>
        )}
      </div>

      {showPredictionHelp && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-3 sm:p-4"
          onClick={() => setShowPredictionHelp(false)}
        >
          <div
            className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-2xl dark:border-slate-700 dark:bg-slate-900/95"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 px-4 py-4 dark:border-slate-700/70">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">Prediction & AI Transparency</h3>
                <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">Understand warning cards, clear-time estimates, and prediction confidence.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowPredictionHelp(false)}
                className="rounded-full border border-slate-300/80 p-2 text-slate-600 transition hover:border-indigo-500/60 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-300"
                aria-label="Close help modal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="border-b border-slate-200/70 px-4 py-3 dark:border-slate-700/70">
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'read', label: 'How to Read' },
                  { id: 'works', label: 'How Prediction Works' },
                ].map((tab) => {
                  const active = helpTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setHelpTab(tab.id)}
                      className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${active ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'}`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="max-h-[calc(90vh-170px)] overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
              {helpTab === 'read' ? (
                <div className="space-y-6 text-sm leading-6 text-slate-700 dark:text-slate-300">
                  <section className="space-y-3">
                    <h4 className="text-base font-semibold text-slate-900 dark:text-slate-100">How to read a warning card</h4>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Threat</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">The type of disruption detected, such as traffic, crowd, weather, flood/river, or earthquake.</p>
                      </div>
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Severity</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Low = being monitored, no action needed. Medium = use caution. High = avoid the area if possible. Critical = follow emergency guidance immediately.</p>
                      </div>
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Peak</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">The time when the disruption is expected to be strongest, busiest, or most severe.</p>
                      </div>
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Confidence Level</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Higher confidence means the warning is more stable. Lower confidence means the warning may change when new data arrives.</p>
                      </div>
                    </div>
                  </section>

                  <section className="space-y-3">
                    <h4 className="text-base font-semibold text-slate-900 dark:text-slate-100">Clear-time estimates</h4>
                    <div className="space-y-2">
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Standard estimate</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">The rule-based clear-time estimate from the current risk level and thresholds.</p>
                      </div>
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">AI prediction</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">The model-based clear-time estimate from historical patterns and live signals.</p>
                      </div>
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Estimate confidence</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">How reliable the clear-time estimate is. It is different from the warning confidence.</p>
                      </div>
                      <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-800/70">
                        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Remaining time</p>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Remaining time means the approximate time from now until the predicted clear time.</p>
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-800/70">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Example</p>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">If a crowd warning says Peak 17:40, the area may be most crowded around 17:40. If the AI prediction says 20.24 WIB with 65% confidence, the model estimates the disruption may reduce around 20.24 WIB, but the time can still change as new data arrives.</p>
                  </section>

                  <section className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-800/70">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-indigo-500" />
                      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Selected alert comparison</h4>
                    </div>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Time remaining from now is shown here so you can compare the rule-based estimate with the AI prediction.</p>
                    {selectedAlertComparison.rows.length > 0 ? (
                      <div className="mt-3 space-y-3">
                        {selectedAlertComparison.rows.map((row) => (
                          <div key={row.label}>
                            <div className="flex items-center justify-between gap-2 text-sm">
                              <span className="font-medium text-slate-800 dark:text-slate-200">{row.label}</span>
                              <span className="text-slate-600 dark:text-slate-300">{row.valueLabel}</span>
                            </div>
                            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                              <div className={`h-2 rounded-full ${row.tint}`} style={{ width: `${Math.max(12, row.percent)}%` }} />
                            </div>
                            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{row.confidence}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">No selected alert is available yet. The chart will appear once a warning is chosen.</p>
                    )}
                  </section>
                </div>
              ) : (
                <div className="space-y-6 text-sm leading-6 text-slate-700 dark:text-slate-300">
                  <section className="space-y-3">
                    <h4 className="text-base font-semibold text-slate-900 dark:text-slate-100">How prediction works</h4>
                    <p className="text-sm text-slate-600 dark:text-slate-300">DIS-RUPTURE combines rule-based scoring, machine-learning recovery estimates, live telemetry, and historical disruption patterns to build a practical warning feed.</p>
                  </section>

                  <section className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-800/70">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Signals used</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {['Traffic score', 'Weather score', 'Crowd score', 'Earthquake score', 'Waterway/flood score', 'Overall risk score', 'Historical snapshots', 'Zone status'].map((chip) => (
                        <span key={chip} className="rounded-full border border-slate-300/80 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200">
                          {chip}
                        </span>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-800/70">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">How confidence is decided</p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg border border-emerald-200/80 bg-emerald-50/80 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/20">
                        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Higher confidence usually means</p>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
                          <li>Data is complete</li>
                          <li>Recent telemetry is stable</li>
                          <li>Similar past cases exist</li>
                          <li>Signals agree with each other</li>
                        </ul>
                      </div>
                      <div className="rounded-lg border border-amber-200/80 bg-amber-50/80 p-3 dark:border-amber-900/50 dark:bg-amber-950/20">
                        <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">Lower confidence usually means</p>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
                          <li>Data is missing</li>
                          <li>Conditions are changing quickly</li>
                          <li>The disruption is unusual</li>
                          <li>Flood or earthquake conditions are uncertain</li>
                        </ul>
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-800/70">
                    <div className="flex items-center gap-2">
                      <Clock3 className="h-4 w-4 text-indigo-500" />
                      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Estimated Clear Time Timeline</h4>
                    </div>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">This timeline groups active warnings by how soon they are estimated to clear. It uses the AI prediction when available, otherwise it uses the standard clear-time estimate.</p>
                    <div className="mt-3 space-y-2">
                      {clearTimeTimeline.length > 0 ? clearTimeTimeline.map((bucket) => (
                        <div key={bucket.label} className="flex items-center justify-between rounded-lg border border-slate-200/80 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
                          <span className="font-medium text-slate-700 dark:text-slate-200">{bucket.label}</span>
                          <span className="text-slate-500 dark:text-slate-400">{bucket.count} warning{bucket.count === 1 ? '' : 's'}</span>
                        </div>
                      )) : (
                        <p className="text-sm text-slate-500 dark:text-slate-400">No clear-time estimates are available yet.</p>
                      )}
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-800/70">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-indigo-500" />
                      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Confidence Breakdown</h4>
                    </div>
                    <div className="mt-3 space-y-3">
                      {confidenceBreakdown.map((bucket) => (
                        <div key={bucket.label}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-200">{bucket.label}</span>
                            <span className="text-slate-500 dark:text-slate-400">{bucket.count}</span>
                          </div>
                          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                            <div className={`h-2 rounded-full ${bucket.accent}`} style={{ width: `${Math.max(10, bucket.count * 12)}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-xl border border-indigo-200/80 bg-indigo-50/80 p-4 dark:border-indigo-900/50 dark:bg-indigo-950/20">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Limitations</p>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Predictions are estimates and may change when new telemetry arrives. During emergencies, follow BMKG, BPBD, and local authority instructions.</p>
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showForecastHelp && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-3 sm:p-4"
          onClick={() => setShowForecastHelp(false)}
        >
          <div
            className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-2xl dark:border-slate-700 dark:bg-slate-900/95"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 px-4 py-4 dark:border-slate-700/70">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">What Do These Graphs Mean?</h3>
                <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">These graphs help explain what may happen in this area during the next few hours.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowForecastHelp(false)}
                className="rounded-full border border-slate-300/80 p-2 text-slate-600 transition hover:border-indigo-500/60 hover:text-indigo-500 dark:border-slate-700 dark:text-slate-300"
                aria-label="Close forecast help"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[calc(90vh-170px)] overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 space-y-5 text-sm leading-6 text-slate-700 dark:text-slate-300">
              <ForecastHelpContent theme={theme} />
            </div>
          </div>
        </div>
      )}

      <BmkgEarthquakeList
        earthquakes={earthquakes}
        selectedEarthquake={selectedEarthquake}
        onSelectEarthquake={onSelectEarthquake}
        theme={theme}
        maxHeightClass="max-h-60"
      />



      </div>
    </div>
  );
}
