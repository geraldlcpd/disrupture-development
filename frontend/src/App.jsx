import React, { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { usePredictions } from './hooks/usePredictions';
import Sidebar from './components/Sidebar';
import BottomSheet from './components/BottomSheet';
import EvacuationPanel from './components/EvacuationPanel';
import MetricsGrid from './components/MetricsGrid';
import AdminDashboard from './components/AdminDashboard';
import { Shield, RefreshCw, AlertTriangle, Cpu, Sun, Moon, X, Settings, Bell, Locate, Activity, Phone, MoreHorizontal, Navigation } from 'lucide-react';
import { getApiUrl } from './utils/getApiUrl';
import FirstTimeTour from './components/FirstTimeTour';
import StackLoadingScreen from './components/StackLoadingScreen';
import NearestAlertToast from './components/NearestAlertToast';
import Dashboard from './components/Dashboard';
import NotificationPreferences from './components/NotificationPreferences';
import EmergencyHelpModal from './components/EmergencyHelpModal';
import AlertCard from './components/AlertCard';
import BmkgEarthquakeList from './components/BmkgEarthquakeList';
import AreaSearchInput from './components/AreaSearchInput';
import LocationOffChip from './components/LocationOffChip';
import NavigatePanel, { NavigateRouteBar } from './components/NavigatePanel';
import PersonaPicker from './components/PersonaPicker';
import PersonaApplyConfirmModal from './components/PersonaApplyConfirmModal';
import {
  buildLayerState,
  buildNotificationTypesFromPreset,
  getBootRestoreState,
  getPersonaPreset,
  personaToSidebarSeverity,
} from './constants/personaPresets';
import { getPersona, savePersona } from './utils/personaPreferences';
import { isOnboardingTourDone, markOnboardingTourDone } from './utils/onboardingPreferences';
import { calculateDistanceKm } from './utils/haversine';
import { normalizeEarthquake } from './utils/formatEarthquake';
import {
  getExistingPushSubscription,
  registerServiceWorker,
  subscribeToPush,
  unsubscribeFromPush,
} from './utils/pushNotifications';
import { saveUserLocation } from './utils/idbLocation';
import { saveNotificationPreferences } from './utils/idbPreferences';
import { getGeolocationErrorMessage } from './utils/geolocationMessage';

const MapView = lazy(() => import('./components/MapView'));

const AREA_SEARCH_KEY = 'disruptionAreaSearch';
const OJEK_GO_HINT_KEY = 'disruptureOjekGoHintDismissed';
const LOCATION_PROMPT_SKIPPED_KEY = 'disruptionLocationPromptSkipped';

function getMobileMapStatus({ nearMeFilterActive, userLocation, nearbyPredictions, predictions, nearMeRadius }) {
  if (!nearMeFilterActive || !userLocation) return null;
  // Count every active alert in range, not just High/Critical. Medium crowd/traffic
  // still draws a circle on the map — calling that "all clear" is misleading.
  if (nearbyPredictions.length === 0) {
    if (predictions.length === 0) {
      return { tone: 'clear', title: 'All clear', detail: 'No active disruptions in Jabodetabek' };
    }
    return { tone: 'clear', title: "You're in the clear", detail: `No alerts within ${nearMeRadius} km` };
  }
  const n = nearbyPredictions.length;
  return { tone: 'alert', title: `${n} alert${n === 1 ? '' : 's'} nearby`, detail: `Within ${nearMeRadius} km of you` };
}

const MOBILE_NAV_BOTTOM = 'calc(4rem + env(safe-area-inset-bottom, 0px))';
const MOBILE_LOCATE_ABOVE_CTA = 'calc(4rem + 3.75rem + env(safe-area-inset-bottom, 0px))';

function MapViewGate({ ready, theme, children }) {
  if (!ready) {
    return (
      <div
        className="w-full h-full"
        style={{ background: theme === 'light' ? '#f8fafc' : '#020617' }}
      />
    );
  }
  return <Suspense fallback={<div className="w-full h-full" />}>{children}</Suspense>;
}

const API_URL = getApiUrl();
const NOTIFICATION_PREFERENCES_KEY = 'notificationPreferences';
const DEFAULT_NOTIFICATION_PREFERENCES = {
  enabled: false,
  radiusKm: 5,
  types: {
    traffic: true,
    weather: true,
    flood: true,
    crowd: true,
    earthquake: true,
  },
};

function readPersistedRadiusKm(defaultKm = 5) {
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_PREFERENCES_KEY);
    if (!raw) return defaultKm;
    const parsed = JSON.parse(raw);
    const km = Number(parsed?.radiusKm);
    return Number.isFinite(km) && km > 0 ? km : defaultKm;
  } catch {
    return defaultKm;
  }
}

function getPredictionZoneCenter(prediction) {
  const zone = prediction?.zone ?? {};
  if (typeof zone.latitude === 'number' && typeof zone.longitude === 'number') {
    return { lat: zone.latitude, lon: zone.longitude };
  }

  const geometry = zone?.geometry;
  const coordinates = geometry?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length > 0) {
    const firstRing = Array.isArray(coordinates[0]) ? coordinates[0] : coordinates;
    const firstPoint = Array.isArray(firstRing[0]) ? firstRing[0] : null;
    if (Array.isArray(firstPoint) && firstPoint.length >= 2) {
      const [lon, lat] = firstPoint;
      return { lat, lon };
    }
  }

  return null;
}

function formatDisruptionType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'flood' || t === 'flooding' || t === 'waterway') return 'Flood';
  if (t === 'crowd' || t === 'crowding') return 'Crowd';
  if (t === 'weather') return 'Weather';
  if (t === 'earthquake') return 'Earthquake';
  if (t === 'traffic') return 'Traffic';
  if (!t) return 'Alert';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function getPredictionKey(prediction) {
  const zone = prediction?.zone ?? {};
  const ids = [prediction?.id, prediction?.alert_id, zone?.id, zone?.zone_id];
  const key = ids.find((value) => value !== undefined && value !== null && value !== '');
  return key ? String(key) : 'unknown';
}

export default function App() {
  const { predictions, loading, error, isFallback, refresh } = usePredictions();

  const handleRouteReady = (geoJSON, destination) => {
    setEvacuationRoute(geoJSON);
    setEvacuationDestination(destination ?? null);
  };
  const [selectedPrediction, setSelectedPrediction] = useState(null);
  const [bottomSheetExpanded, setBottomSheetExpanded] = useState(true);
  const [timelineData, setTimelineData] = useState(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileTab, setMobileTab] = useState('map'); // 'map', 'navigate', 'feed', 'settings'
  const [nearestToastPlayKey, setNearestToastPlayKey] = useState(0);
  const [nearestToastConsumed, setNearestToastConsumed] = useState(false);
  const [nearestToastReady, setNearestToastReady] = useState(false);
  const [mapHeight, setMapHeight] = useState(0);
  const [mapWidth, setMapWidth] = useState(0);
  const [mapKey, setMapKey] = useState('mobile-0');
  const [selectedHours, setSelectedHours] = useState(12);

  // User location state
  const [userLocation, setUserLocation] = useState(null); // { lat, lon, accuracy }
  const [locationError, setLocationError] = useState(null);
  const [locating, setLocating] = useState(false);
  const [areaSearchQuery, setAreaSearchQuery] = useState(() => {
    try {
      return window.localStorage.getItem(AREA_SEARCH_KEY) || '';
    } catch {
      return '';
    }
  });
  const [locationPromptSkipped, setLocationPromptSkipped] = useState(() => {
    try {
      return window.localStorage.getItem(LOCATION_PROMPT_SKIPPED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [showAreaSearch, setShowAreaSearch] = useState(false);
  const [showLocationPrompt, setShowLocationPrompt] = useState(false);

  // Waterway Dynamic Buffer Overlay parameters
  const [waterwayThreshold, setWaterwayThreshold] = useState(75); // capacity percentage threshold
  const [waterwayBuffer, setWaterwayBuffer] = useState(150); // safety buffer meters

  // Proximity "Near Me" Spatial Filter states
  const [nearMeFilterActive, setNearMeFilterActive] = useState(false);
  const [showEvacuation, setShowEvacuation] = useState(false);
  const [evacuationRoute, setEvacuationRoute] = useState(null); // GeoJSON LineString
  const [evacuationDestination, setEvacuationDestination] = useState(null); // { lat, lon, name, ... }
  const [navigateRoutes, setNavigateRoutes] = useState(null); // { destination, safer, faster, saferError }
  const [selectedNavigateRoute, setSelectedNavigateRoute] = useState('safer');
  const [showDesktopNavigate, setShowDesktopNavigate] = useState(false);
  const [allZones, setAllZones] = useState([]); // all zone_status for LOW tier
  const [showDashboard, setShowDashboard] = useState(false);
  const [safePois, setSafePois] = useState([]);

  // Fetch safe POIs when disruptions are active in user radius
  useEffect(() => {
    if (!showEvacuation) return;
    // Use the selected prediction's disruption type, not just predictions[0]
    const dtype = selectedPrediction?.disruption_type ?? predictions?.[0]?.disruption_type ?? '';
    const params = new URLSearchParams();
    if (dtype) params.set('disruption_types', dtype);
    // For crowd disruptions, pass the alert score as the crowd threshold
    // so we surface POIs that are genuinely quieter than the affected zone
    if (dtype === 'crowd' && selectedPrediction?.probability_percentage) {
      params.set('crowd_score_threshold', String(selectedPrediction.probability_percentage));
    }
    const qs = params.toString() ? `?${params.toString()}` : '';
    fetch(`${API_URL}/safe-zones${qs}`)
      .then(r => r.json())
      .then(d => setSafePois(Array.isArray(d) ? d : (d.safe_zones ?? [])))
      .catch(() => setSafePois([]));
  }, [showEvacuation, predictions, selectedPrediction, API_URL]);
  const [nearMeRadius, setNearMeRadius] = useState(() => readPersistedRadiusKm());

  const nearbyPredictions = useMemo(() => {
    if (!nearMeFilterActive || !userLocation) return predictions;
    return predictions.filter((pred) => {
      const center = getPredictionZoneCenter(pred);
      if (!center) {
        const geometry = pred.zone?.geometry;
        if (!geometry?.coordinates?.length) return false;
        const coords = geometry.coordinates[0];
        const sumLon = coords.reduce((sum, c) => sum + c[0], 0);
        const sumLat = coords.reduce((sum, c) => sum + c[1], 0);
        const distance = calculateDistanceKm(
          userLocation.lat,
          userLocation.lon,
          sumLat / coords.length,
          sumLon / coords.length
        );
        return distance <= nearMeRadius;
      }
      const distance = calculateDistanceKm(userLocation.lat, userLocation.lon, center.lat, center.lon);
      return distance <= nearMeRadius;
    });
  }, [predictions, nearMeFilterActive, nearMeRadius, userLocation]);

  const filteredPredictions = nearbyPredictions;

  // Severity filter state for mobile view tab
  const [mobileSeverityFilter, setMobileSeverityFilter] = useState('all');
  const mobileFilteredPredictions = useMemo(() => {
    if (mobileSeverityFilter === 'all') return filteredPredictions;
    if (mobileSeverityFilter === 'high_plus') {
      return filteredPredictions.filter(pred => {
        const sev = (pred.risk_level || pred.severity || '').toLowerCase();
        return sev === 'critical' || sev === 'high';
      });
    }
    if (mobileSeverityFilter === 'medium_plus') {
      return filteredPredictions.filter(pred => {
        const sev = (pred.risk_level || pred.severity || '').toLowerCase();
        return sev === 'critical' || sev === 'high' || sev === 'medium';
      });
    }
    return filteredPredictions.filter(pred =>
      pred.risk_level?.toLowerCase() === mobileSeverityFilter.toLowerCase()
    );
  }, [filteredPredictions, mobileSeverityFilter]);

  const mobileMapStatus = useMemo(
    () => getMobileMapStatus({ nearMeFilterActive, userLocation, nearbyPredictions, predictions, nearMeRadius }),
    [nearMeFilterActive, userLocation, nearbyPredictions, predictions, nearMeRadius]
  );

  const nearestAlertToasts = useMemo(() => {
    if (!userLocation) return [];
    return predictions
      .map((prediction) => {
        const center = getPredictionZoneCenter(prediction);
        if (!center) return null;
        const km = calculateDistanceKm(
          userLocation.lat,
          userLocation.lon,
          center.lat,
          center.lon
        );
        if (!Number.isFinite(km)) return null;
        const zoneName = prediction.zone?.name || 'this area';
        return {
          id: getPredictionKey(prediction),
          km,
          prediction,
          message: `${formatDisruptionType(prediction.disruption_type)} at ${zoneName}, ${km.toFixed(1)} km from you`,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.km - b.km)
      .slice(0, 3);
  }, [predictions, userLocation]);

  const threatZones = useMemo(
    () => predictions.map((p) => {
      const c = getPredictionZoneCenter(p);
      if (!c) return null;
      return {
        lat: c.lat,
        lon: c.lon,
        radius_m: p.zone?.radius_m ?? 1000,
        name: p.zone?.name,
      };
    }).filter(Boolean),
    [predictions]
  );

  const routeFitPadding = useMemo(
    () => (showEvacuation ? [72, 220] : [60, 60]),
    [showEvacuation]
  );

  const handleNavigateRoutesReady = (payload) => {
    setNavigateRoutes(payload);
    setSelectedNavigateRoute(payload.safer ? 'safer' : 'faster');
    setMobileTab('map');
    setShowDesktopNavigate(false);
  };

  // Earthquake states
  const [earthquakes, setEarthquakes] = useState([]);
  const [selectedEarthquake, setSelectedEarthquake] = useState(null);
  const fetchEarthquakes = async () => {
    try {
      const response = await fetch(`${API_URL}/earthquakes`);
      if (response.ok) {
        const data = await response.json();
        setEarthquakes(data.map(normalizeEarthquake));
      }
    } catch (err) {
      console.warn("[API] Could not retrieve earthquakes telemetry.", err);
    }
  };

  useEffect(() => {
    fetchEarthquakes();
    const interval = setInterval(fetchEarthquakes, 30000);
    return () => clearInterval(interval);
  }, []);

  const handlePollTelemetry = () => {
    refresh();
    fetchEarthquakes();
    setNearestToastConsumed(false);
    setNearestToastPlayKey((key) => key + 1);
  };

  useEffect(() => {
    if (isMobile && mobileTab !== 'map') {
      setNearestToastConsumed(true);
    }
  }, [mobileTab, isMobile]);

  // Fetch all zone statuses — used by Sidebar LOW tier
  useEffect(() => {
    const fetchAllZones = async () => {
      try {
        const res = await fetch(`${API_URL}/zone-status/all`);
        if (res.ok) setAllZones(await res.json());
      } catch (e) { console.warn('[App] allZones fetch failed:', e); }
    };
    fetchAllZones();
    const id = setInterval(fetchAllZones, 60000);
    return () => clearInterval(id);
  }, [API_URL]);


  const locateUser = () => {
    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported by this browser.');
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setUserLocation({ lat: latitude, lon: longitude, accuracy });
        saveUserLocation({ lat: latitude, lng: longitude, timestamp: Date.now() });
        setNearMeFilterActive(true);
        setLocating(false);
        setShowLocationPrompt(false);
      },
      (err) => {
        setLocationError(getGeolocationErrorMessage(err));
        setLocating(false);
        setShowAreaSearch(true);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };
  
  // Navigation state: 'map' (default geofence dashboard) or 'admin' (metrics command panel)
  const [view, setView] = useState(() => {
    return window.location.pathname === '/admin' ? 'admin' : 'map';
  });

  // Stack splash on every cold start; first-run tour only after splash
  // (unless the user skips straight to the map).
  const [showStackSplash, setShowStackSplash] = useState(true);
  const [skippedToMap, setSkippedToMap] = useState(false);
  const [minSplashElapsed, setMinSplashElapsed] = useState(false);
  const [zonesLoaded, setZonesLoaded] = useState(0);
  const [showFirstRunTour, setShowFirstRunTour] = useState(() => !isOnboardingTourDone());
  const [persona, setPersona] = useState(null);
  const [personaResolved, setPersonaResolved] = useState(false);
  const [showPersonaChangePicker, setShowPersonaChangePicker] = useState(false);
  const [personaApplyConfirm, setPersonaApplyConfirm] = useState(null);
  const [mapLayerPreset, setMapLayerPreset] = useState(null);
  const [sidebarDefaultSeverity, setSidebarDefaultSeverity] = useState('all');
  const [sidebarSeverityRevision, setSidebarSeverityRevision] = useState(0);
  const [showOjekGoHint, setShowOjekGoHint] = useState(false);
  const [dbStatus, setDbStatus] = useState("connecting");

  // Manual replay of the tour after the app has already loaded (via the
  // "Guide" button in the header) — separate from the startup sequence.
  const [showTourReplay, setShowTourReplay] = useState(false);
  const [dbLatency, setDbLatency] = useState(0);
  const [realDbEmpty, setRealDbEmpty] = useState(true);
  const [allowFallbackBypass, setAllowFallbackBypass] = useState(false);

  const mapUiReady = !showStackSplash && personaResolved && persona && (!showFirstRunTour || skippedToMap);

  const mapOverlay = useMemo(() => {
    const onMapTab = isMobile && mobileTab === 'map';
    const showLargeLocationPrompt = onMapTab && mapUiReady
      && !userLocation && !locating && (!locationPromptSkipped || showLocationPrompt);
    const showLocationOffChip = onMapTab && mapUiReady
      && !userLocation && !locating && locationPromptSkipped && !showLocationPrompt;
    const showNearMeStatusChip = onMapTab && mobileMapStatus && !showLargeLocationPrompt;
    const showOjekHintNow = onMapTab && showOjekGoHint && persona === 'ojek'
      && userLocation && !showLargeLocationPrompt;
    const showMapBottomEvacuationCta = onMapTab
      && filteredPredictions.length > 0 && !showEvacuation;
    const showLocateFab = onMapTab && !showMapBottomEvacuationCta;

    return {
      showLargeLocationPrompt,
      showLocationOffChip,
      showNearMeStatusChip,
      showOjekHintNow,
      showMapBottomEvacuationCta,
      showLocateFab,
    };
  }, [
    isMobile,
    mobileTab,
    mapUiReady,
    userLocation,
    locating,
    locationPromptSkipped,
    showLocationPrompt,
    mobileMapStatus,
    showOjekGoHint,
    persona,
    filteredPredictions.length,
    showEvacuation,
  ]);

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'feed' || tab === 'alerts') setMobileTab('feed');
    else if (tab === 'settings') setMobileTab('settings');
    else if (tab === 'navigate' || tab === 'go') setMobileTab('navigate');
  }, []);

  useEffect(() => {
    if (!userLocation || !mapUiReady) {
      setNearestToastReady(false);
      return undefined;
    }
    if (isMobile && mapOverlay.showLargeLocationPrompt) {
      setNearestToastReady(false);
      return undefined;
    }
    const timer = setTimeout(() => setNearestToastReady(true), 2500);
    return () => clearTimeout(timer);
  }, [userLocation, mapUiReady, isMobile, mapOverlay.showLargeLocationPrompt]);

  useEffect(() => {
    const timer = setTimeout(() => setMinSplashElapsed(true), 700);
    return () => clearTimeout(timer);
  }, []);

  // Trigger automatic bypass of loading screen after 30 seconds max if database is still unseeded
  useEffect(() => {
    const timer = setTimeout(() => {
      setAllowFallbackBypass(true);
    }, 30000); // 30 seconds max
    return () => clearTimeout(timer);
  }, []);

  // Poll system diagnostics — faster while the stack splash is visible
  useEffect(() => {
    const checkDiagnostics = async () => {
      try {
        const res = await fetch(`${API_URL}/admin/status`);
        if (res.ok) {
          const data = await res.json();
          setDbStatus(data.database?.status ?? 'connecting');
          setDbLatency(data.database?.latency_ms ?? 0);
          setZonesLoaded(Number(data.cache?.zones_loaded ?? 0));
        } else {
          setDbStatus('unreachable');
        }
      } catch {
        setDbStatus('unreachable');
      }
    };
    checkDiagnostics();
    const interval = setInterval(checkDiagnostics, showStackSplash ? 2000 : 10000);
    return () => clearInterval(interval);
  }, [API_URL, showStackSplash]);

  // Track if actual db predictions are seeded
  useEffect(() => {
    if (!loading && predictions.length > 0) {
      setRealDbEmpty(isFallback);
    }
  }, [loading, predictions, isFallback]);

  const isAppReady = !loading && (!isFallback || allowFallbackBypass || dbStatus === 'healthy');

  const stackChecks = {
    api: dbStatus === 'unreachable' ? 'fail' : dbStatus === 'connecting' ? 'pending' : 'ok',
    database: String(dbStatus).startsWith('healthy')
      ? 'ok'
      : dbStatus === 'unreachable'
        ? 'fail'
        : 'pending',
    zones: zonesLoaded > 0 || allZones.length > 0
      ? 'ok'
      : dbStatus === 'unreachable'
        ? 'fail'
        : 'pending',
    alerts: !loading ? 'ok' : allowFallbackBypass ? 'fail' : 'pending',
  };

  useEffect(() => {
    if (!showStackSplash || !minSplashElapsed) return;
    if (isAppReady || allowFallbackBypass) {
      setShowStackSplash(false);
    }
  }, [showStackSplash, minSplashElapsed, isAppReady, allowFallbackBypass]);

  const applyPersonaPreset = useCallback((id) => {
    const preset = getPersonaPreset(id);
    setPersona(id);
    setNearMeRadius(preset.radiusKm);
    setNearMeFilterActive((prev) => prev || Boolean(userLocation));
    setMobileSeverityFilter(preset.severityFilter);
    setSidebarDefaultSeverity(personaToSidebarSeverity(id));
    setSidebarSeverityRevision((n) => n + 1);
    setMapLayerPreset(buildLayerState(preset));
    setNotificationPreferences((prev) => {
      const next = {
        ...prev,
        radiusKm: preset.radiusKm,
        types: buildNotificationTypesFromPreset(preset),
      };
      try {
        window.localStorage.setItem(NOTIFICATION_PREFERENCES_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    savePersona(id);
    document.documentElement.classList.toggle('persona-ojek', id === 'ojek');
    if (id === 'ojek') {
      try {
        if (window.localStorage.getItem(OJEK_GO_HINT_KEY) !== '1') {
          setShowOjekGoHint(true);
        }
      } catch {
        /* ignore */
      }
    } else {
      setShowOjekGoHint(false);
    }
  }, [userLocation]);

  const handleNearMeRadiusChange = useCallback((km) => {
    const value = Number(km);
    if (!Number.isFinite(value)) return;
    setNearMeRadius(value);
    setNotificationPreferences((prev) => ({ ...prev, radiusKm: value }));
  }, []);

  const restorePersonaDefaultsOnBoot = useCallback((id) => {
    const { layers, severityFilter, sidebarSeverity } = getBootRestoreState(id);
    setMapLayerPreset(layers);
    setMobileSeverityFilter(severityFilter);
    setSidebarDefaultSeverity(sidebarSeverity);
    setSidebarSeverityRevision((n) => n + 1);
  }, []);

  const handlePersonaSelect = useCallback((id, fromSettings = false) => {
    if (fromSettings && persona && id !== persona) {
      const label = getPersonaPreset(id).shortLabel;
      setPersonaApplyConfirm({ id, label });
      return;
    }
    applyPersonaPreset(id);
    setShowPersonaChangePicker(false);
  }, [applyPersonaPreset, persona]);

  const handlePersonaApplyConfirm = useCallback((applySettings) => {
    if (!personaApplyConfirm) return;
    const { id } = personaApplyConfirm;
    if (applySettings) {
      applyPersonaPreset(id);
    } else {
      setPersona(id);
      savePersona(id);
      document.documentElement.classList.toggle('persona-ojek', id === 'ojek');
    }
    setPersonaApplyConfirm(null);
    setShowPersonaChangePicker(false);
  }, [personaApplyConfirm, applyPersonaPreset]);

  const dismissPersonaApplyConfirm = useCallback(() => {
    setPersonaApplyConfirm(null);
  }, []);

  const handlePersonaSkip = useCallback(() => {
    applyPersonaPreset('kantor');
  }, [applyPersonaPreset]);

  const dismissOjekGoHint = useCallback(() => {
    setShowOjekGoHint(false);
    try {
      window.localStorage.setItem(OJEK_GO_HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getPersona().then((id) => {
      if (cancelled) return;
      if (id) {
        setPersona(id);
        document.documentElement.classList.toggle('persona-ojek', id === 'ojek');
        restorePersonaDefaultsOnBoot(id);
      }
      setPersonaResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, [restorePersonaDefaultsOnBoot]);

  const showStartupPersonaPicker = personaResolved && !persona && !showStackSplash;

  const handleSkipSplash = () => {
    markOnboardingTourDone();
    setShowFirstRunTour(false);
    setShowStackSplash(false);
    setSkippedToMap(true);
  };

  const handleLaunchComplete = () => {
    markOnboardingTourDone();
    setShowFirstRunTour(false);
    locateUser();
  };

  useEffect(() => {
    try {
      if (isOnboardingTourDone()) locateUser();
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  // Listen for browser history back/forward events
  useEffect(() => {
    const handlePopState = () => {
      setView(window.location.pathname === '/admin' ? 'admin' : 'map');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Theme state: default is 'light', saved in localStorage
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('theme') || 'light';
  });

  const [notificationPreferences, setNotificationPreferences] = useState(() => {
    try {
      const raw = window.localStorage.getItem(NOTIFICATION_PREFERENCES_KEY);
      if (!raw) return DEFAULT_NOTIFICATION_PREFERENCES;
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...parsed,
        types: {
          ...DEFAULT_NOTIFICATION_PREFERENCES.types,
          ...(parsed.types || {}),
        },
      };
    } catch {
      return DEFAULT_NOTIFICATION_PREFERENCES;
    }
  });
  const [showNotificationPreferences, setShowNotificationPreferences] = useState(false);
  const [alertPreview, setAlertPreview] = useState(null);
  const [alertPreviewLoading, setAlertPreviewLoading] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return window.Notification.permission;
  });
  const [notificationMessage, setNotificationMessage] = useState('');
  const [pushSubscriptionActive, setPushSubscriptionActive] = useState(false);
  const [pushStatus, setPushStatus] = useState('idle');
  const [pushStatusMessage, setPushStatusMessage] = useState('');
  const [pendingDeepLink, setPendingDeepLink] = useState(null);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showEmergencyHelp, setShowEmergencyHelp] = useState(false);
  const [dismissedAutoEvacuationKeys, setDismissedAutoEvacuationKeys] = useState(() => new Set());
  const [activeAutoEvacuationKey, setActiveAutoEvacuationKey] = useState(null);
  const [evacuationTargetPrediction, setEvacuationTargetPrediction] = useState(null);
  // A zone is considered "far" from the user if it's more than this many km
  // away and they're not inside its geofence — beyond this, showing it as
  // the default evacuation target would be actively misleading.
  const FAR_ZONE_THRESHOLD_KM = 15;
  const [evacuationZoneIsNearby, setEvacuationZoneIsNearby] = useState(true);
  const [evacuationWasAutoSelected, setEvacuationWasAutoSelected] = useState(false);

  useEffect(() => {
    let active = true;

    const syncPushStatus = async () => {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        if (active) {
          setPushStatus('unsupported');
          setPushStatusMessage('Browser notifications are not supported on this device.');
        }
        return;
      }

      try {
        const registration = await registerServiceWorker();
        if (!active) return;

        if (!registration) {
          setPushStatus('unsupported');
          setPushStatusMessage('The service worker could not be registered.');
          return;
        }

        const existingSubscription = await getExistingPushSubscription();
        if (!active) return;

        if (existingSubscription) {
          setPushSubscriptionActive(true);
          setPushStatus('active');
          setPushStatusMessage('Push alerts are enabled and your browser subscription is active.');
        } else {
          setPushSubscriptionActive(false);
          setPushStatus(notificationPreferences.enabled ? 'ready' : 'idle');
          setPushStatusMessage(notificationPreferences.enabled
            ? 'Browser permission is on, but the push subscription has not been set up yet.'
            : 'Push subscriptions are not active yet.');
        }
      } catch (error) {
        if (active) {
          setPushStatus('failed');
          setPushStatusMessage(error.message || 'Push setup could not be completed.');
        }
      }
    };

    syncPushStatus();
    return () => {
      active = false;
    };
  }, [notificationPreferences.enabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const alertId = params.get('alert_id');
    const zoneId = params.get('zone_id');
    if (!alertId && !zoneId) {
      setPendingDeepLink(null);
      return;
    }
    setPendingDeepLink({ alertId, zoneId });
  }, []);

  useEffect(() => {
    if (!pendingDeepLink || loading) return;

    const targetAlertId = pendingDeepLink.alertId;
    const targetZoneId = pendingDeepLink.zoneId;
    const match = predictions.find((prediction) => {
      const candidateIds = [
        prediction?.zone?.id,
        prediction?.zone?.zone_id,
        prediction?.id,
        prediction?.alert_id,
      ];
      const zoneMatches = targetZoneId
        ? candidateIds.some((id) => String(id) === String(targetZoneId))
        : false;
      const alertMatches = targetAlertId
        ? [prediction?.id, prediction?.alert_id].some((id) => String(id) === String(targetAlertId))
        : false;

      return zoneMatches || alertMatches;
    });

    if (match) {
      setBottomSheetExpanded(true);
      setSelectedPrediction(match);
      setView('map');
      setMobileTab('map');
      setPendingDeepLink(null);
      return;
    }

    setPendingDeepLink(null);
  }, [pendingDeepLink, predictions, loading]);

  useEffect(() => {
    if (!userLocation || showEvacuation || !predictions?.length) return;

    const matchedPrediction = predictions.find((prediction) => {
      const key = getPredictionKey(prediction);
      if (dismissedAutoEvacuationKeys.has(key)) return false;

      const zoneCenter = getPredictionZoneCenter(prediction);
      if (!zoneCenter) return false;

      const distanceKm = calculateDistanceKm(
        userLocation.lat,
        userLocation.lon,
        zoneCenter.lat,
        zoneCenter.lon,
      );
      const disruptionType = String(prediction?.disruption_type || '').toLowerCase();
      const riskLevel = String(
        prediction?.risk_level || prediction?.severity || prediction?.alert_level || ''
      ).toLowerCase();
      const isFloodLike = disruptionType.includes('flood') || disruptionType.includes('river') || disruptionType.includes('waterway');
      const isHighRisk =
        riskLevel.includes('high') ||
        riskLevel.includes('critical') ||
        riskLevel.includes('siaga 3') ||
        prediction?.probability_percentage >= 80;

      if (isFloodLike && isHighRisk && distanceKm <= 1) {
        return true;
      }

      const impactRadiusKm = Number(
        prediction?.impact_radius_km ??
          prediction?.zone?.impact_radius_km ??
          (prediction?.zone?.radius_m ? prediction.zone.radius_m / 1000 : 0)
      );

      return disruptionType.includes('earthquake') && impactRadiusKm > 0 && distanceKm <= impactRadiusKm;
    });

    if (matchedPrediction) {
      setActiveAutoEvacuationKey(getPredictionKey(matchedPrediction));
      setShowEvacuation(true);
    }
  }, [userLocation, predictions, showEvacuation, dismissedAutoEvacuationKeys]);

  // Sync theme selection to document element classes
  useEffect(() => {
    localStorage.setItem('theme', theme);
    const root = document.documentElement;
    if (theme === 'light') {
      root.classList.add('light-mode');
      root.classList.remove('dark-mode');
    } else {
      root.classList.add('dark-mode');
      root.classList.remove('light-mode');
    }
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(NOTIFICATION_PREFERENCES_KEY, JSON.stringify(notificationPreferences));
    } catch {
      // ignore storage failures
    }
    saveNotificationPreferences(notificationPreferences);
  }, [notificationPreferences]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotificationPermission('unsupported');
      return;
    }
    setNotificationPermission(window.Notification.permission);
    if (notificationPreferences.enabled && window.Notification.permission !== 'granted') {
      setNotificationMessage('Saved locally. Allow browser notifications to receive alerts.');
      setPushStatus('pending');
      setPushStatusMessage('Enable browser permission to complete push setup.');
    }
  }, [notificationPreferences.enabled]);

  useEffect(() => {
    if (!showNotificationPreferences) {
      setAlertPreview(null);
      return;
    }

    const selectedType = Object.entries(notificationPreferences.types).find(([, enabled]) => enabled)?.[0] || 'traffic';
    const previewAlert = {
      alert_id: 999,
      disruption_type: selectedType,
      severity: 'HIGH',
      zone_name: 'Pondok Aren',
      distance_km: 3.2,
      current_speed: 18,
      normal_speed: 42,
      congestion_level: 'heavy',
      weather_type: 'Heavy rain',
      rainfall_intensity_mm: 16,
      wind_speed_kmh: 27,
      humidity_pct: 82,
      weather_risk_level: 'MEDIUM',
      water_level_cm: 180,
      river_name: 'Ciliwung',
      alert_level: 'Siaga 3',
      magnitude: 4.8,
      location: 'Pondok Aren',
      impact_radius_km: 8,
      event_time: '2026-07-10T12:30:00Z',
    };

    let active = true;
    setAlertPreviewLoading(true);
    fetch(`${API_URL}/alerts/notification-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alert: previewAlert,
        preferences: notificationPreferences,
        safe_areas: [{ name: 'RS Jakarta Medical Center', distance_km: 1.4, category: 'hospital' }],
      }),
    })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (active) setAlertPreview(data);
      })
      .catch(() => {
        if (active) setAlertPreview(null);
      })
      .finally(() => {
        if (active) setAlertPreviewLoading(false);
      });

    return () => {
      active = false;
    };
  }, [showNotificationPreferences, notificationPreferences.enabled, notificationPreferences.radiusKm, notificationPreferences.types, API_URL]);

  const handleNotificationToggle = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotificationMessage('This browser does not support web notifications.');
      setNotificationPermission('unsupported');
      setNotificationPreferences(prev => ({ ...prev, enabled: false }));
      setPushStatus('unsupported');
      setPushStatusMessage('Browser notifications are not supported on this device.');
      return;
    }

    if (notificationPreferences.enabled) {
      try {
        await saveNotificationPreferences({ ...notificationPreferences, enabled: false });
        const unsubscribed = await unsubscribeFromPush(API_URL);
        setPushSubscriptionActive(false);
        setPushStatus(unsubscribed ? 'inactive' : 'failed');
        setPushStatusMessage(unsubscribed ? 'Push alerts turned off for this browser.' : 'Unable to disable push alerts right now.');
      } catch (error) {
        setPushStatus('failed');
        setPushStatusMessage(error.message || 'Unable to disable push alerts right now.');
      }

      setNotificationPreferences(prev => ({ ...prev, enabled: false }));
      setNotificationMessage('Push alerts turned off for this browser.');
      return;
    }

    if (window.Notification.permission === 'denied') {
      setNotificationPreferences(prev => ({ ...prev, enabled: false }));
      setNotificationPermission('denied');
      setNotificationMessage('Browser notifications are blocked. Please allow them in your browser settings.');
      setPushStatus('blocked');
      setPushStatusMessage('Browser notifications are blocked. Please allow them in your browser settings.');
      return;
    }

    try {
      const permission = window.Notification.permission === 'granted' ? 'granted' : await window.Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === 'granted') {
        try {
          await saveNotificationPreferences({ ...notificationPreferences, enabled: true });
          const subscription = await subscribeToPush(
            import.meta.env.VITE_VAPID_PUBLIC_KEY || '',
            API_URL,
            { ...notificationPreferences, enabled: true },
          );
          setPushSubscriptionActive(Boolean(subscription));
          setPushStatus('active');
          setPushStatusMessage('Push alerts are enabled and your browser subscription is active.');
          setNotificationPreferences(prev => ({ ...prev, enabled: true }));
          setNotificationMessage('Notifications enabled. Browser alerts can now appear when available.');
        } catch (error) {
          const message = error?.message || '';
          const missingVapidKey = /VAPID public key/i.test(message);
          setPushSubscriptionActive(false);
          setPushStatus('failed');
          setPushStatusMessage(
            missingVapidKey
              ? 'Push setup is missing VITE_VAPID_PUBLIC_KEY, so browser alerts cannot be enabled.'
              : message || 'Unable to enable push alerts right now.'
          );
          setNotificationPreferences(prev => ({ ...prev, enabled: false }));
          setNotificationMessage(
            missingVapidKey
              ? 'Push alerts could not be enabled because the VAPID public key is missing.'
              : 'Unable to enable push alerts right now.'
          );
        }
      } else {
        setNotificationPreferences(prev => ({ ...prev, enabled: false }));
        setNotificationMessage('Notification permission was not granted.');
        setPushStatus('pending');
        setPushStatusMessage('Browser permission is still required to receive push alerts.');
      }
    } catch {
      setNotificationPreferences(prev => ({ ...prev, enabled: false }));
      setNotificationMessage('Unable to request notification permission right now.');
      setPushStatus('failed');
      setPushStatusMessage('Unable to request notification permission right now.');
    }
  };

  const handleStartupNotificationRequest = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    try {
      const permission = window.Notification.permission === 'granted'
        ? 'granted'
        : await window.Notification.requestPermission();
      setNotificationPermission(permission);
    } catch {
      /* ignore */
    }
  };

  const saveAreaSearch = (value) => {
    setAreaSearchQuery(value);
    try {
      window.localStorage.setItem(AREA_SEARCH_KEY, value);
    } catch {
      /* ignore */
    }
  };

  const skipLocationPrompt = () => {
    setLocationPromptSkipped(true);
    setShowLocationPrompt(false);
    try {
      window.localStorage.setItem(LOCATION_PROMPT_SKIPPED_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  const handleMyLocationClick = () => {
    if (userLocation) {
      locateUser();
      return;
    }
    if (locationPromptSkipped || locationError) {
      setShowLocationPrompt(true);
      setShowAreaSearch(true);
      return;
    }
    locateUser();
  };

  const openEvacuationPanel = (prediction = null) => {
    let targetPrediction = prediction;
    let isNearby = true; // assume nearby unless we compute otherwise below

    // If no specific prediction was tapped (e.g. opened from a generic
    // "Get Evacuation Guidance" entry point) and the user has location
    // enabled, find the alert whose zone the user is ACTUALLY inside or
    // nearest to — rather than defaulting to filteredPredictions[0], which
    // is sorted by severity/time and can point to a completely unrelated
    // zone the user isn't anywhere near. This prevents showing guidance
    // for a threat in a different part of Jabodetabek than where the user is.
    if (!targetPrediction && userLocation && filteredPredictions?.length > 0) {
      const withDistance = filteredPredictions
        .map(p => {
          const zLat = p.zone?.latitude;
          const zLon = p.zone?.longitude;
          if (zLat == null || zLon == null) return null;
          const distanceKm = calculateDistanceKm(userLocation.lat, userLocation.lon, zLat, zLon);
          const radiusKm = (p.zone?.radius_m ?? 1000) / 1000;
          return { prediction: p, distanceKm, insideZone: distanceKm <= radiusKm };
        })
        .filter(Boolean);

      // Prefer a zone the user is literally inside; otherwise nearest zone.
      const inside = withDistance.filter(w => w.insideZone);
      const pool = inside.length > 0 ? inside : withDistance;
      pool.sort((a, b) => a.distanceKm - b.distanceKm);

      const best = pool[0];
      targetPrediction = best?.prediction ?? filteredPredictions[0] ?? null;
      // Nearby = user is inside the zone OR within the "far" threshold of it.
      // If there's truly no nearby threat, this will be false and the panel
      // shows an explicit "no threat near you" notice instead of silently
      // presenting an unrelated distant zone as if it were relevant.
      isNearby = best ? (best.insideZone || best.distanceKm <= FAR_ZONE_THRESHOLD_KM) : false;
    } else if (!targetPrediction) {
      targetPrediction = filteredPredictions?.[0] ?? null;
      isNearby = !userLocation; // no location = can't judge, don't show a false warning
    } else if (userLocation && targetPrediction?.zone?.latitude != null) {
      // A specific prediction WAS passed (e.g. user tapped a zone directly) —
      // still compute nearby-ness so a manually-selected distant zone can
      // also get the "just for reference" framing if relevant.
      const d = calculateDistanceKm(
        userLocation.lat, userLocation.lon,
        targetPrediction.zone.latitude, targetPrediction.zone.longitude
      );
      const r = (targetPrediction.zone.radius_m ?? 1000) / 1000;
      isNearby = d <= r || d <= FAR_ZONE_THRESHOLD_KM;
    }

    setActiveAutoEvacuationKey(getPredictionKey(targetPrediction));
    setEvacuationTargetPrediction(targetPrediction);
    setEvacuationZoneIsNearby(isNearby);
    // Track whether this pick was auto-selected (no specific zone tapped) —
    // used below to know if we should re-run nearest-zone logic once
    // userLocation becomes available (e.g. permission was granted AFTER
    // the button was first tapped, so this initial pick used no location).
    setEvacuationWasAutoSelected(!prediction);
    setShowEvacuation(true);
  };

  // Re-run nearest-zone selection once userLocation becomes available,
  // if the panel is already open AND the current target was auto-picked
  // without location data (i.e. user tapped the button, THEN granted
  // location permission — the initial pick shouldn't be the final answer).
  useEffect(() => {
    if (!showEvacuation || !evacuationWasAutoSelected || !userLocation) return;
    if (!filteredPredictions?.length) return;

    const withDistance = filteredPredictions
      .map(p => {
        const zLat = p.zone?.latitude;
        const zLon = p.zone?.longitude;
        if (zLat == null || zLon == null) return null;
        const distanceKm = calculateDistanceKm(userLocation.lat, userLocation.lon, zLat, zLon);
        const radiusKm = (p.zone?.radius_m ?? 1000) / 1000;
        return { prediction: p, distanceKm, insideZone: distanceKm <= radiusKm };
      })
      .filter(Boolean);

    const inside = withDistance.filter(w => w.insideZone);
    const pool = inside.length > 0 ? inside : withDistance;
    pool.sort((a, b) => a.distanceKm - b.distanceKm);
    const best = pool[0];
    if (!best) return;

    setEvacuationTargetPrediction(best.prediction);
    setActiveAutoEvacuationKey(getPredictionKey(best.prediction));
    setEvacuationZoneIsNearby(best.insideZone || best.distanceKm <= FAR_ZONE_THRESHOLD_KM);
    setEvacuationWasAutoSelected(false); // done — don't keep recalculating on every location ping
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLocation, showEvacuation, evacuationWasAutoSelected]);

  // Keep the evacuation panel following the currently selected zone WHILE
  // it's open. Without this, selecting a different zone/card after already
  // opening the panel silently did nothing — the panel stayed frozen on
  // whichever zone it was originally opened for, since the "Get Evacuation
  // Guidance" button (the only thing that used to update the target) is
  // hidden once the panel is showing.
  useEffect(() => {
    if (showEvacuation && selectedPrediction) {
      setEvacuationTargetPrediction(selectedPrediction);
      setActiveAutoEvacuationKey(getPredictionKey(selectedPrediction));
    }
  }, [selectedPrediction, showEvacuation]);

  const closeEvacuationPanel = () => {
    setShowEvacuation(false);
    setEvacuationRoute(null);
    setEvacuationDestination(null);
    setEvacuationTargetPrediction(null);
    if (activeAutoEvacuationKey) {
      setDismissedAutoEvacuationKeys(prev => new Set(prev).add(activeAutoEvacuationKey));
      setActiveAutoEvacuationKey(null);
    }
  };

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  // 1. Detect screen size dynamically for responsive switching
  useEffect(() => {
    const NAV_HEIGHT = 64; // 4rem bottom nav
    const updateDimensions = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) {
        const w = window.innerWidth;
        const h = window.innerHeight - NAV_HEIGHT;
        setMapWidth(w);
        setMapHeight(h);
        // Force new MapContainer instance on resize/orientation so Leaflet
        // measures fresh dimensions — prevents stale offset cache
        setMapKey(`mobile-${w}x${h}`);
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    const onOrient = () => setTimeout(updateDimensions, 350);
    window.addEventListener('orientationchange', onOrient);
    return () => {
      window.removeEventListener('resize', updateDimensions);
      window.removeEventListener('orientationchange', onOrient);
    };
  }, []);

  // 2. Clear selected prediction if it was an active warning and is no longer in the updated active list
  useEffect(() => {
    if (selectedPrediction && selectedPrediction.id && predictions.length > 0) {
      const stillActive = predictions.some(p => p.id === selectedPrediction.id);
      if (!stillActive) {
        setSelectedPrediction(null);
        setTimelineData(null);
      }
    }
  }, [predictions, selectedPrediction]);

  // 3. Fetch timeline forecast for the selected zone geofence
  const fetchTimeline = async (zoneId, hoursRange = selectedHours) => {
    setTimelineLoading(true);
    try {
      const response = await fetch(`${API_URL}/predictions/zone/${zoneId}?hours=${hoursRange}`);
      if (response.ok) {
        const data = await response.json();
        setTimelineData(data);
      } else {
        throw new Error("Timeline API error");
      }
    } catch (err) {
      console.warn("[API] Could not retrieve timeline. Synthesizing high-fidelity local dataset.");
      
      // Fallback timeline dataset in case backend is loading/offline
      const now = new Date();
      const syntheticTimeline = [];
      const zone =
        predictions.find((p) => p.zone.id === zoneId)?.zone
        ?? allZones.find((z) => (z.zone?.zone_id ?? z.zone_id) === zoneId)?.zone;
      const baseline = zone ? zone.traffic_speed_baseline : 35.0;

      // Generate 3 hours of past traffic control data
      for (let i = -3; i < 0; i++) {
        const time = new Date(now.getTime() + i * 3600000);
        // Realistic historic speed fluctuation around the baseline
        const speed = parseFloat((baseline * (0.95 + Math.random() * 0.1)).toFixed(1));
        syntheticTimeline.push({
          timestamp: time.toISOString(),
          precipitation_probability: 0.0,
          rain_accumulation: 0.0,
          expected_speed: speed,
          risk_level: "Low"
        });
      }

      for (let i = 0; i < hoursRange; i++) {
        const time = new Date(now.getTime() + i * 3600000);
        const hour = time.getHours();
        
        // Simulating heavy rains in late afternoon
        const isRainHour = hour >= 14 && hour <= 17;
        const prob = isRainHour ? 90.0 : 15.0;
        const rain = isRainHour ? (hour === 15 ? 12.5 : 6.0) : 0.0;
        
        // Compute speed drop
        let speedMod = 1.0;
        if (rain > 10.0) speedMod = 0.5;
        else if (rain > 5.0) speedMod = 0.7;
        
        // Rush hour congestion
        const isRush = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);
        if (isRush) speedMod = speedMod * 0.75;
        
        syntheticTimeline.push({
          timestamp: time.toISOString(),
          precipitation_probability: prob,
          rain_accumulation: rain,
          expected_speed: parseFloat((baseline * speedMod).toFixed(1)),
          risk_level: rain > 10.0 ? "Critical" : (rain > 5.0 ? "High" : (prob > 50.0 ? "Medium" : "Low"))
        });
      }
      
      setTimelineData({
        zone_id: zoneId,
        zone_name: zone?.name || "Unknown Zone",
        timeline: syntheticTimeline
      });
    } finally {
      setTimelineLoading(false);
    }
  };

  // Re-fetch timeline when selected hours changes
  useEffect(() => {
    if (selectedPrediction) {
      fetchTimeline(selectedPrediction.zone.id, selectedHours);
    }
  }, [selectedHours]);

  // 4. Handle zone selection action
  const handleSelectZone = (prediction, { expanded = true } = {}) => {
    setBottomSheetExpanded(expanded);
    setSelectedPrediction(prediction);
    fetchTimeline(prediction.zone.id, selectedHours);
  };

  const handleAreaZoneSelected = (zoneStatusEntry) => {
    const zone = zoneStatusEntry?.zone;
    if (!zone) return;

    const zoneId = zone.zone_id ?? zone.id;
    const activePred = predictions.find(
      (p) => p.zone?.id === zoneId || p.zone?.zone_id === zoneId
    );

    const prediction = activePred ?? {
      zone: { ...zone, id: zoneId },
      risk_level: zoneStatusEntry.display_severity ?? 'Low',
      disruption_type: zoneStatusEntry.dominant_risk ?? 'weather',
      probability_percentage: zoneStatusEntry.overall_risk_score ?? 0,
    };

    handleSelectZone(prediction, { expanded: false });
    saveAreaSearch(zone.name ?? '');
    skipLocationPrompt();
    setShowAreaSearch(false);
    setShowLocationPrompt(false);
  };

  return (
    <div className={`flex flex-col h-screen h-[100dvh] w-screen overflow-hidden font-sans ${theme === 'light' ? 'light-mode' : 'bg-brand-dark text-slate-100'}`}>
      {!showStackSplash && userLocation && mapUiReady && nearestToastReady && (
        <NearestAlertToast
          items={nearestAlertToasts}
          theme={theme}
          playKey={nearestToastPlayKey}
          active={!nearestToastConsumed && !mapOverlay.showLargeLocationPrompt}
          visible={!isMobile || mobileTab === 'map'}
          offsetBelowChip={isMobile && mapOverlay.showNearMeStatusChip}
          onSelect={(prediction) => handleSelectZone(prediction, { expanded: false })}
          onFinished={() => setNearestToastConsumed(true)}
        />
      )}

      {showStackSplash && (
        <StackLoadingScreen
          checks={stackChecks}
          timedOut={allowFallbackBypass}
          theme={theme}
          onSkip={handleSkipSplash}
        />
      )}

      {/* Premium Header */}
      <header className="relative h-16 shrink-0 bg-brand-elevated border-b border-slate-800/80 px-6 flex items-center justify-between z-[2500]">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shadow-glow-orange animate-pulse">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h1 className={`text-sm md:text-base font-extrabold tracking-wide uppercase ${
              theme === 'light'
                ? 'text-slate-900'
                : 'bg-gradient-to-r from-slate-100 via-indigo-200 to-indigo-400 bg-clip-text text-transparent'
            }`}>
              DIS-RUPTURE
            </h1>
            <p className="text-[11px] text-slate-400 font-medium tracking-widest uppercase">
              Alerts near you
            </p>
          </div>
        </div>

        {/* Fallback status is shown only under Settings → For developers */}
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowEmergencyHelp(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 active:scale-95 text-white border border-red-500 shadow-lg shadow-red-900/30 text-xs font-bold transition-all"
            title="Call emergency services"
          >
            <Phone className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Need Help?</span>
            <span className="sm:hidden">Help</span>
          </button>
          {!isMobile && (
            // Desktop Header Controls
            <>
              {/* Theme Toggle Button */}
              <button 
                onClick={toggleTheme}
                className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-slate-100 hover:border-slate-700 transition-all flex items-center justify-center"
                title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}
              >
                {theme === 'light' ? (
                  <Moon className="w-4 h-4 text-indigo-400" />
                ) : (
                  <Sun className="w-4 h-4 text-amber-400" />
                )}
              </button>

              <button
                type="button"
                data-tour="dashboard-trigger"
                onClick={() => setShowDashboard(true)}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-slate-100 hover:border-slate-700 transition-all text-xs font-semibold"
                title="Overview"
              >
                <Activity className="w-4 h-4" />
                <span className="hidden sm:inline">Overview</span>
              </button>

              <button
                type="button"
                data-tour="notifications-trigger"
                onClick={() => setShowNotificationPreferences(true)}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-slate-100 hover:border-slate-700 transition-all text-xs font-semibold"
                title="Alert notifications"
              >
                <Bell className="w-4 h-4" />
                <span className="hidden sm:inline">Alerts</span>
              </button>

              <button
                type="button"
                onClick={() => setShowDesktopNavigate((open) => !open)}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border transition-all text-xs font-semibold ${
                  showDesktopNavigate
                    ? 'bg-indigo-600 border-indigo-500 text-white hover:bg-indigo-500'
                    : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-slate-100 hover:border-slate-700'
                }`}
                title="Navigate"
              >
                <Navigation className="w-4 h-4" />
                <span className="hidden sm:inline">Navigate</span>
              </button>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowMoreMenu((v) => !v)}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:text-slate-100 hover:border-slate-700 transition-all text-xs font-semibold"
                  title="More"
                >
                  <MoreHorizontal className="w-4 h-4" />
                  <span className="hidden sm:inline">More</span>
                </button>
                {showMoreMenu && (
                  <div className={`absolute right-0 mt-2 w-44 rounded-xl border shadow-xl z-[2000] py-1 ${
                    theme === 'light'
                      ? 'border-slate-200 bg-white'
                      : 'border-slate-800 bg-slate-950'
                  }`}>
                    <button
                      type="button"
                      className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                        theme === 'light'
                          ? 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                          : 'text-slate-200 hover:bg-slate-800'
                      }`}
                      onClick={() => { setShowPersonaChangePicker(true); setShowMoreMenu(false); }}
                    >
                      How I use this app
                    </button>
                    <button
                      type="button"
                      className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                        theme === 'light'
                          ? 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                          : 'text-slate-200 hover:bg-slate-800'
                      }`}
                      onClick={() => { setShowTourReplay(true); setShowMoreMenu(false); }}
                    >
                      Guide
                    </button>
                    <button
                      type="button"
                      className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                        theme === 'light'
                          ? 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                          : 'text-slate-200 hover:bg-slate-800'
                      }`}
                      onClick={() => { setShowAboutModal(true); setShowMoreMenu(false); }}
                    >
                      About
                    </button>
                    <button
                      type="button"
                      className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                        theme === 'light'
                          ? 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                          : 'text-slate-200 hover:bg-slate-800'
                      }`}
                      onClick={() => { handlePollTelemetry(); setShowMoreMenu(false); }}
                    >
                      Refresh data
                    </button>
                  </div>
                )}
              </div>

              {/* Use My Location */}
              <button
                onClick={locateUser}
                title="Use My Location"
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white border border-indigo-500 transition-all text-xs font-semibold disabled:bg-indigo-600/50 disabled:cursor-not-allowed"
                disabled={locating}
              >
                <Locate className={`w-3.5 h-3.5 ${locating ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{locating ? 'Locating…' : 'My Location'}</span>
              </button>
            </>
          )}
        </div>
      </header>
      {!isMobile && locationError && (
        <div
          className={`shrink-0 px-6 py-3 border-b space-y-2 ${
            theme === 'light'
              ? 'border-slate-200 bg-slate-50 text-slate-800'
              : 'border-slate-800 bg-slate-900/80 text-slate-100'
          }`}
        >
          <p className={`text-xs ${theme === 'light' ? 'text-amber-800' : 'text-amber-400'}`}>
            {locationError}
          </p>
          <AreaSearchInput
            allZones={allZones}
            value={areaSearchQuery}
            onChange={saveAreaSearch}
            onZoneSelected={handleAreaZoneSelected}
            theme={theme}
          />
        </div>
      )}
      {/* Notification Preferences Modal */}
      {showNotificationPreferences && (
        <div
          className="fixed inset-0 z-[3000] overflow-y-auto bg-black/40 backdrop-blur-sm p-3 sm:p-4 md:p-6"
          onClick={() => setShowNotificationPreferences(false)}
        >
          <div className="mx-auto flex min-h-full w-full max-w-lg items-center justify-center py-4 sm:items-start sm:justify-end sm:py-6">
            <div
              className={`w-full max-h-[90vh] overflow-hidden rounded-[28px] border shadow-2xl ${theme === 'dark' ? 'border-slate-800 bg-slate-950/95 text-slate-100' : 'border-slate-200 bg-white/95 text-slate-900'}`}
              onClick={(e) => e.stopPropagation()}
            >
              <NotificationPreferences
                preferences={notificationPreferences}
                onToggleEnabled={handleNotificationToggle}
                onRadiusChange={(value) => setNotificationPreferences(prev => ({ ...prev, radiusKm: value }))}
                onToggleType={(type) => setNotificationPreferences(prev => ({
                  ...prev,
                  types: {
                    ...prev.types,
                    [type]: !prev.types[type],
                  },
                }))}
                onClose={() => setShowNotificationPreferences(false)}
                permissionStatus={notificationPermission}
                message={notificationMessage}
                messageTone={notificationMessage.includes('blocked') || notificationMessage.includes('not granted') || notificationMessage.includes('does not support') ? 'error' : notificationMessage.includes('enabled') || notificationMessage.includes('can now appear') ? 'success' : 'info'}
                pushStatus={pushStatus}
                pushStatusMessage={pushStatusMessage}
                pushSubscriptionActive={pushSubscriptionActive}
                previewPayload={alertPreview}
                previewLoading={alertPreviewLoading}
                theme={theme}
              />
            </div>
          </div>
        </div>
      )}

      {/* Main Layout Area */}
      {view === 'admin' ? (
        <AdminDashboard onBack={() => {
          window.history.pushState({}, '', '/');
          setView('map');
        }} theme={theme} />
      ) : isMobile ? (
        // Mobile Layout: Pinned content container + fixed bottom nav bar
        <main className="flex-1 flex flex-col relative w-full min-h-0">
          
          {/* Active View Selector */}
          {mobileTab === 'map' && (
            <div className="relative flex flex-col w-full" style={{ height: mapHeight }}>
              {mapOverlay.showNearMeStatusChip && (
                <div className="absolute top-3 left-3 right-16 z-[1200] pointer-events-none">
                  <div className={`mobile-map-status inline-flex max-w-full rounded-xl px-3 py-2 border backdrop-blur-md shadow-lg ${
                    mobileMapStatus.tone === 'clear'
                      ? theme === 'light'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                        : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : theme === 'light'
                        ? 'bg-white/95 border-slate-200 text-slate-900'
                        : 'bg-slate-900/95 border-slate-700 text-slate-100'
                  }`}>
                    <div className="min-w-0">
                      <div className="text-xs font-bold truncate">{mobileMapStatus.title}</div>
                      <div className={`text-[11px] truncate ${
                        mobileMapStatus.tone === 'clear'
                          ? theme === 'light' ? 'text-emerald-700' : 'text-emerald-300/90'
                          : theme === 'light' ? 'text-slate-500' : 'text-slate-400'
                      }`}>
                        {mobileMapStatus.detail}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {mapOverlay.showOjekHintNow && (
                <div className="absolute top-[4.5rem] left-3 right-3 z-[1195] pointer-events-auto">
                  <div className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs shadow-lg ${
                    theme === 'light'
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-900'
                      : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-100'
                  }`}>
                    <span>Use <strong>Go</strong> to plan a safer route.</span>
                    <button
                      type="button"
                      onClick={dismissOjekGoHint}
                      className={`shrink-0 font-bold ${theme === 'light' ? 'text-indigo-600' : 'text-indigo-300'}`}
                    >
                      OK
                    </button>
                  </div>
                </div>
              )}

              {mapOverlay.showLocationOffChip && (
                <div className="absolute top-3 left-3 right-16 z-[1200] pointer-events-auto">
                  <LocationOffChip
                    theme={theme}
                    locating={locating}
                    onUseLocation={locateUser}
                    onSearchArea={() => {
                      setShowLocationPrompt(true);
                      setShowAreaSearch(true);
                    }}
                  />
                </div>
              )}

              {mapOverlay.showLargeLocationPrompt && (
                <div className="absolute top-36 left-3 right-3 z-[1050] pointer-events-auto">
                  <div className={`rounded-xl border p-3 space-y-2 shadow-lg ${
                    theme === 'light'
                      ? 'border-slate-200 bg-white/95 text-slate-900'
                      : 'border-indigo-500/30 bg-slate-900/95 text-slate-100'
                  }`}>
                    <p className={`text-xs font-semibold ${theme === 'light' ? 'text-slate-800' : 'text-slate-200'}`}>
                      Turn on location to see alerts near you
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={locateUser}
                        className="flex-1 min-h-[44px] py-2.5 rounded-lg bg-indigo-600 text-white text-xs font-bold"
                      >
                        Use my location
                      </button>
                      <button
                        type="button"
                        onClick={skipLocationPrompt}
                        className={`min-h-[44px] px-3 py-2.5 rounded-lg border text-xs font-bold ${
                          theme === 'light'
                            ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                            : 'border-slate-600 text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        Skip
                      </button>
                    </div>
                    {locationError && (
                      <p className={`text-[11px] ${theme === 'light' ? 'text-amber-700' : 'text-amber-400'}`}>
                        Location blocked. Search a monitored area instead:
                      </p>
                    )}
                    {(showAreaSearch || locationError) ? (
                      <AreaSearchInput
                        allZones={allZones}
                        value={areaSearchQuery}
                        onChange={saveAreaSearch}
                        onZoneSelected={handleAreaZoneSelected}
                        theme={theme}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setShowAreaSearch(true)}
                        className={`w-full text-[11px] font-semibold py-1 ${
                          theme === 'light' ? 'text-indigo-600 hover:text-indigo-700' : 'text-indigo-300 hover:text-indigo-200'
                        }`}
                      >
                        Search by area name instead
                      </button>
                    )}
                  </div>
                </div>
              )}

              {mapOverlay.showLocateFab && (
                <button
                  type="button"
                  onClick={handleMyLocationClick}
                  disabled={locating}
                  className="absolute right-3 z-[1160] flex items-center gap-1.5 px-3 py-2.5 rounded-full bg-indigo-600 text-white text-xs font-bold shadow-lg disabled:bg-indigo-600/50 disabled:cursor-not-allowed"
                  style={{
                    bottom: showEvacuation
                      ? '44vh'
                      : MOBILE_NAV_BOTTOM,
                  }}
                >
                  <Locate className={`w-4 h-4 ${locating ? 'animate-spin' : ''}`} />
                  {locating ? 'Locating…' : 'My location'}
                </button>
              )}

              {/* Interactive Leaflet Map — explicit pixel height prevents Leaflet offset bug */}
              <div data-tour="map-container" style={{ width: mapWidth || '100%', height: mapHeight || '100%', touchAction: 'none', WebkitUserSelect: 'none', userSelect: 'none', flexShrink: 0 }}>
                <MapViewGate ready={!showStackSplash} theme={theme}>
                  <MapView 
                    key={mapKey}
                    predictions={predictions} 
                    selectedZone={selectedPrediction}
                    onSelectZone={handleSelectZone}
                    theme={theme}
                    userLocation={userLocation}
                    waterwayThreshold={waterwayThreshold}
                    setWaterwayThreshold={setWaterwayThreshold}
                    waterwayBuffer={waterwayBuffer}
                    setWaterwayBuffer={setWaterwayBuffer}
                    earthquakes={earthquakes}
                    selectedEarthquake={selectedEarthquake}
                    onClearSelectedEarthquake={() => setSelectedEarthquake(null)}
                    nearMeFilterActive={nearMeFilterActive}
                    setNearMeFilterActive={setNearMeFilterActive}
                    nearMeRadius={nearMeRadius}
                    setNearMeRadius={handleNearMeRadiusChange}
                    evacuationRoute={evacuationRoute}
                    routeDestination={navigateRoutes?.destination ?? evacuationDestination}
                    navigateSaferRoute={navigateRoutes?.safer?.geometry}
                    navigateFasterRoute={navigateRoutes?.faster?.geometry}
                    selectedNavigateRoute={selectedNavigateRoute}
                    suppressMapControls={showNotificationPreferences}
                    isMobile={isMobile}
                    mapVisible={mobileTab === 'map'}
                    layerPreset={mapLayerPreset}
                    routeFitPadding={routeFitPadding}
                  />
                </MapViewGate>
              </div>
              {navigateRoutes && mobileTab === 'map' && (
                <div className="absolute left-3 right-3 z-[1260]" style={{ bottom: MOBILE_NAV_BOTTOM }}>
                  <NavigateRouteBar
                    destination={navigateRoutes.destination}
                    safer={navigateRoutes.safer}
                    faster={navigateRoutes.faster}
                    selected={selectedNavigateRoute}
                    onSelect={setSelectedNavigateRoute}
                    onClear={() => setNavigateRoutes(null)}
                    theme={theme}
                  />
                </div>
              )}

              {/* Swipeable Drawer */}
              <BottomSheet 
                selectedPrediction={selectedPrediction}
                onClose={() => setSelectedPrediction(null)}
                timelineData={timelineData}
                timelineLoading={timelineLoading}
                selectedHours={selectedHours}
                setSelectedHours={setSelectedHours}
                theme={theme}
                defaultExpanded={bottomSheetExpanded}
              />

              {/* Evacuation guidance trigger */}
              {mapOverlay.showMapBottomEvacuationCta && (
                <div
                  className="absolute left-0 right-0 z-[1150] px-3 py-2 pointer-events-none"
                  style={{ bottom: MOBILE_NAV_BOTTOM }}
                >
                  {(() => {
                    const _p = selectedPrediction || filteredPredictions[0];
                    const _sev = _p?.severity?.toUpperCase();
                    const _isMed = _sev === 'MEDIUM';
                    return (
                      <button
                        data-tour="evacuation-trigger-mobile"
                        onClick={() => openEvacuationPanel(selectedPrediction || null)}
                        className={`pointer-events-auto w-full min-h-[44px] py-3 rounded-xl active:scale-95 font-bold text-sm transition-all flex items-center justify-center gap-2 ${
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
                    );
                  })()}
                </div>
              )}

              {/* Evacuation panel */}
              {showEvacuation && (
                <div
                  className={`absolute left-0 right-0 z-[1700] overflow-hidden rounded-t-2xl border-t shadow-2xl ${
                    theme === 'light'
                      ? 'border-slate-200 bg-white'
                      : 'border-slate-700 bg-brand-elevated'
                  }`}
                  style={{ bottom: MOBILE_NAV_BOTTOM, maxHeight: '42vh' }}
                >
                  <EvacuationPanel
                    compact
                    theme={theme}
                    userLocation={userLocation}
                    predictions={filteredPredictions}
                    safePois={safePois}
                    activeThreatZones={filteredPredictions.map(p => ({
                      lat: p.zone?.latitude ?? p.zone?.geometry?.[0]?.[0],
                      lon: p.zone?.longitude ?? p.zone?.geometry?.[0]?.[1],
                      radius_m: p.zone?.radius_m ?? 1000,
                      name: p.zone?.name ?? 'threat zone',
                    }))}
                    tomtomApiKey={import.meta.env.VITE_TOMTOM_API_KEY}
                    onRouteReady={handleRouteReady}
                    onClose={closeEvacuationPanel}
                    onRequestLocation={locateUser}
                    activePrediction={evacuationTargetPrediction ?? filteredPredictions[0] ?? null}
                    zoneIsNearby={evacuationZoneIsNearby}
                    allZones={allZones}
                  />
                </div>
              )}
            </div>
          )}

          {mobileTab === 'navigate' && (
            <div style={{ height: 'calc(100dvh - 8rem)' }}>
              <NavigatePanel
                userLocation={userLocation}
                onRequestLocation={locateUser}
                threatZones={threatZones}
                allZones={allZones}
                theme={theme}
                onRoutesReady={handleNavigateRoutesReady}
              />
            </div>
          )}

          {mobileTab === 'feed' && (
            <div
              data-tour="sidebar-filters"
              className={`overflow-y-auto p-4 space-y-4 scrollbar-thin ${
                theme === 'light' ? 'bg-slate-50 text-slate-900' : 'bg-brand-dark text-slate-100'
              }`}
              style={{ height: 'calc(100dvh - 8rem)', paddingBottom: '1.5rem' }}
            >
              <div className={`flex items-center justify-between pb-2 border-b ${
                theme === 'light' ? 'border-slate-200' : 'border-slate-800'
              }`}>
                <div className="flex items-center space-x-2">
                  <Bell className="w-5 h-5 text-indigo-400" />
                  <h2 className={`text-base font-bold ${theme === 'light' ? 'text-slate-900' : 'text-slate-200'}`}>
                    Nearby alerts
                  </h2>
                </div>
                <span className="text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  {filteredPredictions.length} alerts
                </span>
              </div>

              {/* Evacuation button — mobile feed tab */}
              {filteredPredictions.length > 0 && !showEvacuation && (() => {
                const _p = selectedPrediction || filteredPredictions[0];
                const _sev = _p?.severity?.toUpperCase();
                const _isMed = _sev === 'MEDIUM';
                return (
                  <button
                    onClick={() => { openEvacuationPanel(selectedPrediction || null); setMobileTab('map'); }}
                    className={`w-full py-3 rounded-xl active:scale-95 font-bold text-sm transition-all flex items-center justify-center gap-2 ${
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
                );
              })()}
              
              {/* Severity Filter Tabs — 3 large toggles */}
              <div className={`grid grid-cols-3 gap-2 pb-2 border-b ${
                theme === 'light' ? 'border-slate-200/80' : 'border-slate-800/40'
              }`}>
                {[
                  { id: 'all', label: 'All' },
                  { id: 'high_plus', label: 'High+' },
                  { id: 'medium_plus', label: 'Medium+' },
                ].map(tab => {
                  const isActive = mobileSeverityFilter === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setMobileSeverityFilter(tab.id)}
                      className={`min-h-[44px] text-xs px-2 py-2 rounded-lg font-semibold border transition-all duration-200 ${
                        isActive
                          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 font-bold'
                          : theme === 'light'
                            ? 'border-slate-300 bg-slate-100 text-slate-600 hover:text-slate-900'
                            : 'border-slate-800 bg-slate-900/30 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {nearMeFilterActive && userLocation && (
                <div className="glass-panel px-3 py-2.5 rounded-xl border border-indigo-500/20 text-indigo-400 text-xs flex items-center justify-between shrink-0">
                  <div className="flex items-center space-x-1.5 font-semibold">
                    <span>Within {nearMeRadius} km of my location</span>
                  </div>
                  <button 
                    onClick={() => setNearMeFilterActive(false)}
                    className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/10 hover:bg-indigo-500/20 transition-all"
                  >
                    Show all
                  </button>
                </div>
              )}
              
              <div className="space-y-3">
                {mobileFilteredPredictions.length === 0 ? (
                  <div className="text-center py-12 rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
                    <div className="text-3xl mb-2">✅</div>
                    <p className="text-sm font-bold text-emerald-400">
                      {nearMeFilterActive && userLocation
                        ? `All clear within ${nearMeRadius} km`
                        : predictions.length === 0
                          ? 'All clear — no active disruptions'
                          : 'No alerts match this filter'}
                    </p>
                    <p className="text-xs text-emerald-300/80 mt-1 px-4">
                      {nearMeFilterActive && userLocation && predictions.length > 0
                        ? 'Active disruptions exist elsewhere in Jabodetabek.'
                        : 'Check the map for your area status.'}
                    </p>
                  </div>
                ) : (
                  mobileFilteredPredictions.map(pred => (
                    <AlertCard
                      key={pred.id}
                      prediction={pred}
                      theme={theme}
                      selected={selectedPrediction?.id === pred.id}
                      onClick={() => {
                        handleSelectZone(pred, { expanded: false });
                        setMobileTab('map');
                      }}
                      safeRouteVariant="link"
                      onSafeRoute={() => {
                        openEvacuationPanel(pred);
                        setMobileTab('map');
                      }}
                    />
                  ))
                )}
              </div>

              {nearMeFilterActive && userLocation && (
                <button
                  type="button"
                  onClick={() => setNearMeFilterActive(false)}
                  className={`w-full min-h-[44px] py-2.5 mt-2 rounded-xl border text-xs font-semibold ${
                    theme === 'light'
                      ? 'border-slate-300 text-slate-600 hover:bg-slate-100'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800/50'
                  }`}
                >
                  See all of Jabodetabek
                </button>
              )}

              <BmkgEarthquakeList
                earthquakes={earthquakes}
                selectedEarthquake={selectedEarthquake}
                onSelectEarthquake={setSelectedEarthquake}
                theme={theme}
                touchFriendly
                onViewOnMap={(eq) => {
                  setSelectedEarthquake(eq);
                  setMobileTab('map');
                }}
              />
            </div>
          )}

          {mobileTab === 'settings' && (
            <div
              className={`overflow-y-auto p-5 space-y-6 scrollbar-thin ${
                theme === 'light' ? 'bg-slate-50 text-slate-900' : 'bg-brand-dark text-slate-100'
              }`}
              style={{ height: 'calc(100dvh - 8rem)', paddingBottom: '1.5rem' }}
            >
              <div className={`flex items-center space-x-2 pb-2 border-b ${theme === 'light' ? 'border-slate-200' : 'border-slate-800'}`}>
                <Settings className="w-5 h-5 text-indigo-400" />
                <h2 className={`text-base font-bold ${theme === 'light' ? 'text-slate-900' : 'text-slate-200'}`}>Settings</h2>
              </div>

              {/* Theme Toggle Selection Block */}
              <div className={`rounded-xl p-4 space-y-3 border ${
                theme === 'light' ? 'bg-white border-slate-200' : 'bg-slate-900/40 border-slate-800/80'
              }`}>
                <h3 className={`text-xs uppercase font-extrabold tracking-wider ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>
                  User Interface Theme
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => setTheme('light')}
                    className={`flex items-center justify-center space-x-2 py-2.5 rounded-lg border text-xs font-semibold transition-all ${
                      theme === 'light' 
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-600' 
                        : 'border-slate-700 bg-slate-800/60 text-slate-300'
                    }`}
                  >
                    <Sun className="w-4 h-4" />
                    <span>Light Mode</span>
                  </button>
                  <button 
                    onClick={() => setTheme('dark')}
                    className={`flex items-center justify-center space-x-2 py-2.5 rounded-lg border text-xs font-semibold transition-all ${
                      theme === 'dark' 
                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400' 
                        : theme === 'light'
                          ? 'border-slate-300 bg-slate-100 text-slate-700'
                          : 'border-slate-800 bg-slate-900/60 text-slate-400'
                    }`}
                  >
                    <Moon className="w-4 h-4" />
                    <span>Dark Mode</span>
                  </button>
                </div>
              </div>

              <div className={`rounded-xl p-4 space-y-3 border ${
                theme === 'light' ? 'bg-white border-slate-200' : 'bg-slate-900/40 border-slate-800/80'
              }`}>
                <h3 className={`text-xs uppercase font-extrabold tracking-wider ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>
                  How I use this app
                </h3>
                <p className={`text-sm ${theme === 'light' ? 'text-slate-700' : 'text-slate-300'}`}>
                  {persona ? getPersonaPreset(persona).label : 'Not set yet'}
                </p>
                <button
                  type="button"
                  onClick={() => setShowPersonaChangePicker(true)}
                  className="w-full min-h-[44px] rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold"
                >
                  Change profile
                </button>
              </div>

              <NotificationPreferences
                preferences={notificationPreferences}
                onToggleEnabled={handleNotificationToggle}
                onRadiusChange={(value) => setNotificationPreferences(prev => ({ ...prev, radiusKm: value }))}
                onToggleType={(type) => setNotificationPreferences(prev => ({
                  ...prev,
                  types: {
                    ...prev.types,
                    [type]: !prev.types[type],
                  },
                }))}
                isEmbedded
                permissionStatus={notificationPermission}
                message={notificationMessage}
                messageTone={notificationMessage.includes('blocked') || notificationMessage.includes('not granted') || notificationMessage.includes('does not support') ? 'error' : notificationMessage.includes('enabled') || notificationMessage.includes('can now appear') ? 'success' : 'info'}
                pushStatus={pushStatus}
                pushStatusMessage={pushStatusMessage}
                pushSubscriptionActive={pushSubscriptionActive}
                previewPayload={alertPreview}
                previewLoading={alertPreviewLoading}
                theme={theme}
              />

              {/* Telemetry Operations Block */}
              <div className={`rounded-xl p-4 space-y-3 border ${
                theme === 'light' ? 'bg-white border-slate-200' : 'bg-slate-900/40 border-slate-800/80'
              }`}>
                <h3 className={`text-xs uppercase font-extrabold tracking-wider ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>
                  Data
                </h3>
                <button 
                  onClick={handlePollTelemetry}
                  className="w-full flex items-center justify-center space-x-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all active:scale-[0.98]"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowDashboard(true)}
                  className={`w-full flex items-center justify-center space-x-2 py-2.5 rounded-lg border text-xs font-bold transition-all ${
                    theme === 'light'
                      ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-800'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-100'
                  }`}
                >
                  <Activity className="w-4 h-4" />
                  <span>Overview</span>
                </button>

                {/* Use My Location — mobile */}
                <button
                  onClick={() => { locateUser(); setMobileTab('map'); }}
                  disabled={locating}
                  className={`w-full flex items-center justify-center space-x-2 py-2.5 rounded-lg border text-xs font-bold transition-all active:scale-[0.98] disabled:cursor-not-allowed ${
                    theme === 'light'
                      ? 'bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-800 disabled:bg-slate-200/80'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-100 disabled:bg-slate-800/50'
                  }`}
                >
                  <Locate className={`w-4 h-4 ${locating ? 'animate-spin' : ''}`} />
                  <span>{locating ? 'Locating…' : 'Use My Location'}</span>
                </button>
                {locationError && (
                  <p className="text-xs text-red-400 text-center">{locationError}</p>
                )}
              </div>
              
              {/* System Status Metrics */}
              <details className={`rounded-xl p-4 text-xs border ${
                theme === 'light' ? 'bg-white border-slate-200' : 'bg-slate-900/40 border-slate-800/80'
              }`}>
                <summary className={`text-xs uppercase font-extrabold tracking-wider cursor-pointer ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>
                  For developers
                </summary>
                <div className="mt-3 space-y-2">
                <div className={`flex justify-between py-1 border-b ${theme === 'light' ? 'border-slate-200' : 'border-slate-800/40'}`}>
                  <span className={theme === 'light' ? 'text-slate-500' : 'text-slate-400'}>Database Status:</span>
                  <span className="font-semibold text-emerald-500">Connected</span>
                </div>
                <div className={`flex justify-between py-1 border-b ${theme === 'light' ? 'border-slate-200' : 'border-slate-800/40'}`}>
                  <span className={theme === 'light' ? 'text-slate-500' : 'text-slate-400'}>Zoning Engine:</span>
                  <span className="font-semibold text-indigo-500">Active</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className={theme === 'light' ? 'text-slate-500' : 'text-slate-400'}>Simulated Feeds:</span>
                  <span className={isFallback ? 'font-semibold text-amber-500' : 'font-semibold text-emerald-500'}>
                    {isFallback ? 'Active' : 'Offline (Prod mode)'}
                  </span>
                </div>
                </div>
              </details>
            </div>
          )}

          {/* Fixed Mobile Bottom Navigation Bar */}
          <div 
            className="fixed bottom-0 left-0 right-0 w-full border-t border-slate-800/80 bg-brand-elevated/95 backdrop-blur-md flex items-center justify-around select-none shadow-[0_-4px_16px_rgba(0,0,0,0.4)]"
            style={{ 
              zIndex: 1500,
              paddingBottom: 'env(safe-area-inset-bottom, 0px)', 
              height: 'calc(4rem + env(safe-area-inset-bottom, 0px))' 
            }}
          >
            <button 
              onClick={() => setMobileTab('map')}
              className={`flex flex-col items-center justify-center space-y-1 py-1 w-1/4 transition-all ${
                mobileTab === 'map' ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-300'
              }`}
            >
              <Shield className="w-5 h-5" />
              <span className="text-[11px] font-bold tracking-wider uppercase">Map</span>
            </button>
            <button 
              onClick={() => setMobileTab('navigate')}
              className={`flex flex-col items-center justify-center space-y-1 py-1 w-1/4 transition-all ${
                mobileTab === 'navigate' ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-300'
              }`}
            >
              <Navigation className="w-5 h-5" />
              <span className="text-[11px] font-bold tracking-wider uppercase">Go</span>
            </button>
            <button 
              onClick={() => setMobileTab('feed')}
              className={`flex flex-col items-center justify-center space-y-1 py-1 w-1/4 transition-all relative ${
                mobileTab === 'feed' ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-300'
              }`}
            >
              <Bell className="w-5 h-5" />
              <span className="text-[11px] font-bold tracking-wider uppercase">Alerts</span>
              {filteredPredictions.length > 0 && (
                <span className="absolute top-1 right-[18%] w-2 h-2 bg-red-500 rounded-full animate-ping" />
              )}
            </button>
            <button 
              onClick={() => setMobileTab('settings')}
              className={`flex flex-col items-center justify-center space-y-1 py-1 w-1/4 transition-all ${
                mobileTab === 'settings' ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-300'
              }`}
            >
              <Settings className="w-5 h-5" />
              <span className="text-[11px] font-bold tracking-wider uppercase">Settings</span>
            </button>
          </div>
        </main>
      ) : (
        // Desktop Layout: Split view layout
        <main className="flex-1 flex min-h-0 w-full">
          {/* Left panel: Map + KPIs */}
          <div className="flex-1 flex flex-col min-w-0 relative">
            {showDesktopNavigate && (
              <div className="absolute inset-y-0 left-0 z-[1300] w-[min(22rem,100%)] shadow-2xl">
                <NavigatePanel
                  userLocation={userLocation}
                  onRequestLocation={locateUser}
                  threatZones={threatZones}
                  allZones={allZones}
                  theme={theme}
                  onRoutesReady={handleNavigateRoutesReady}
                  onClose={() => setShowDesktopNavigate(false)}
                />
              </div>
            )}
            {navigateRoutes && (
              <div className="absolute left-4 right-4 bottom-4 z-[1260] max-w-md">
                <NavigateRouteBar
                  destination={navigateRoutes.destination}
                  safer={navigateRoutes.safer}
                  faster={navigateRoutes.faster}
                  selected={selectedNavigateRoute}
                  onSelect={setSelectedNavigateRoute}
                  onClear={() => setNavigateRoutes(null)}
                  theme={theme}
                />
              </div>
            )}
            {/* Dynamic KPIs */}
            {false && <MetricsGrid predictions={filteredPredictions} theme={theme} />}

            {/* Fallback status is shown only under Settings → For developers */}

            {/* Expanded Leaflet Map */}
            <div data-tour="map-container" className="flex-1 min-h-0 w-full h-full">
              <MapViewGate ready={!showStackSplash} theme={theme}>
                <MapView 
                  predictions={predictions} 
                  selectedZone={selectedPrediction}
                  onSelectZone={handleSelectZone}
                  theme={theme}
                  userLocation={userLocation}
                  waterwayThreshold={waterwayThreshold}
                  setWaterwayThreshold={setWaterwayThreshold}
                  waterwayBuffer={waterwayBuffer}
                  setWaterwayBuffer={setWaterwayBuffer}
                  earthquakes={earthquakes}
                  selectedEarthquake={selectedEarthquake}
                  onClearSelectedEarthquake={() => setSelectedEarthquake(null)}
                  nearMeFilterActive={nearMeFilterActive}
                  setNearMeFilterActive={setNearMeFilterActive}
                  nearMeRadius={nearMeRadius}
                  setNearMeRadius={handleNearMeRadiusChange}
                  evacuationRoute={evacuationRoute}
                  routeDestination={navigateRoutes?.destination ?? evacuationDestination}
                  navigateSaferRoute={navigateRoutes?.safer?.geometry}
                  navigateFasterRoute={navigateRoutes?.faster?.geometry}
                  selectedNavigateRoute={selectedNavigateRoute}
                  suppressMapControls={showNotificationPreferences}
                  isMobile={false}
                  layerPreset={mapLayerPreset}
                  routeFitPadding={routeFitPadding}
                />
              </MapViewGate>
            </div>
          </div>

          {/* Right panel: Timeline feeds, historical charts & trend lines */}
          <div data-tour="sidebar-filters" className="flex w-[32%] min-w-[400px] h-full shrink-0">
            <Sidebar 
              theme={theme}
              predictions={filteredPredictions}
              selectedPrediction={selectedPrediction}
              onSelectPrediction={handleSelectZone}
              timelineData={timelineData}
              timelineLoading={timelineLoading}
              selectedHours={selectedHours}
              setSelectedHours={setSelectedHours}
              earthquakes={earthquakes}
              selectedEarthquake={selectedEarthquake}
              onSelectEarthquake={setSelectedEarthquake}
              nearMeFilterActive={nearMeFilterActive}
              nearMeRadius={nearMeRadius}
              onClearNearMeFilter={() => setNearMeFilterActive(false)}
              defaultSeverityFilter={sidebarDefaultSeverity}
              severityFilterRevision={sidebarSeverityRevision}
              allZones={allZones}
              onGetEvacuation={() => openEvacuationPanel(selectedPrediction || null)}
              showEvacuationPanel={showEvacuation}
              evacuationPanelNode={
                <EvacuationPanel
                  compact={false}
                  theme={theme}
                  userLocation={userLocation}
                  predictions={filteredPredictions}
                  safePois={safePois}
                  activeThreatZones={filteredPredictions.map(p => ({
                    lat: p.zone?.latitude ?? p.zone?.geometry?.[0]?.[0],
                    lon: p.zone?.longitude ?? p.zone?.geometry?.[0]?.[1],
                    radius_m: p.zone?.radius_m ?? 1000,
                    name: p.zone?.name ?? 'threat zone',
                  }))}
                  tomtomApiKey={import.meta.env.VITE_TOMTOM_API_KEY}
                  onRouteReady={handleRouteReady}
                  onClose={closeEvacuationPanel}
                  onRequestLocation={locateUser}
                  activePrediction={evacuationTargetPrediction ?? selectedPrediction ?? filteredPredictions[0] ?? null}
              zoneIsNearby={evacuationZoneIsNearby}
              allZones={allZones}
                />
              }
            />
          </div>
        </main>
      )}
        <EmergencyHelpModal
          isOpen={showEmergencyHelp}
          onClose={() => setShowEmergencyHelp(false)}
          theme={theme}
        />
        {showAboutModal && (
          <div
            className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setShowAboutModal(false)}
          >
            <div
              className={`w-full max-w-5xl max-h-[85vh] overflow-y-auto rounded-2xl border shadow-2xl ${
                theme === 'light'
                  ? 'border-slate-200 bg-white text-slate-900'
                  : 'border-slate-700 bg-brand-elevated text-slate-100'
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={`flex items-center justify-between px-6 py-4 border-b ${
                theme === 'light' ? 'border-slate-200' : 'border-slate-800'
              }`}>
                <h2 className="text-xl font-bold text-indigo-500">
                  What is DIS-RUPTURE?
                </h2>

                <button
                  onClick={() => setShowAboutModal(false)}
                  className={`p-2 rounded-lg ${
                    theme === 'light' ? 'hover:bg-slate-100' : 'hover:bg-slate-800'
                  }`}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className={`p-8 space-y-8 ${theme === 'light' ? 'text-slate-600' : 'text-slate-300'}`}>

                <p>
                  DIS-RUPTURE is a real-time disruption intelligence platform
                  designed to identify and visualize flood, weather, traffic,
                  crowd, and earthquake risks across Jabodetabek.
                </p>

                <div>
                  <h3 className={`font-bold mb-2 ${theme === 'light' ? 'text-slate-900' : 'text-indigo-400'}`}>
                    Monitored Risk Sources
                  </h3>

                  <div className="flex flex-wrap gap-2">
                    <span className={`px-2 py-1 rounded ${theme === 'light' ? 'bg-slate-200 text-slate-800' : 'bg-slate-800 text-slate-200'}`}>🚗 Traffic</span>
                    <span className={`px-2 py-1 rounded ${theme === 'light' ? 'bg-slate-200 text-slate-800' : 'bg-slate-800 text-slate-200'}`}>🌧️ Weather</span>
                    <span className={`px-2 py-1 rounded ${theme === 'light' ? 'bg-slate-200 text-slate-800' : 'bg-slate-800 text-slate-200'}`}>🌊 Flood</span>
                    <span className={`px-2 py-1 rounded ${theme === 'light' ? 'bg-slate-200 text-slate-800' : 'bg-slate-800 text-slate-200'}`}>👥 Crowd</span>
                    <span className={`px-2 py-1 rounded ${theme === 'light' ? 'bg-slate-200 text-slate-800' : 'bg-slate-800 text-slate-200'}`}>🌋 Earthquake</span>
                  </div>
                </div>

                <div>
                  <h3 className={`font-bold mb-2 ${theme === 'light' ? 'text-slate-900' : 'text-indigo-400'}`}>
                    Risk Levels
                  </h3>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-red-500"></div>
                      <span>Critical (76–100%)</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-orange-500"></div>
                      <span>High (51–75%)</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
                      <span>Medium (26–50%)</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
                      <span>Low (0–25%)</span>
                    </div>
                  </div>

                  <p className={`mt-3 text-xs ${theme === 'light' ? 'text-slate-500' : 'text-slate-400'}`}>
                    Risk levels are generated from a composite disruption score combining
                    environmental, traffic, hydrological, crowd, and seismic indicators.
                  </p>
                </div>

                <div>
                  <h3 className={`font-bold mb-2 ${theme === 'light' ? 'text-slate-900' : 'text-indigo-400'}`}>
                    How to Read the Map
                  </h3>

                  <div className="text-sm space-y-2">
                    <p>🎨 Color = Risk Severity</p>
                    <p>⭕ Size = Geographic Impact Area</p>
                    <p>🌫️ Density = Disruption Intensity</p>
                  </div>
                </div>

              </div>
            </div>
          </div>
        )}
      {/* Dashboard full-screen overlay */}
      <Dashboard
        isOpen={showDashboard}
        onClose={() => setShowDashboard(false)}
        allZones={allZones}
        predictions={predictions}
      />

      {/* Manual Tour Replay Modal — triggered by the "Guide" button */}
      <FirstTimeTour
        isOpen={showTourReplay}
        onClose={() => setShowTourReplay(false)}
        dbStatus={dbStatus}
        isFallback={isFallback}
        isMobile={isMobile}
        theme={theme}
      />

      {showStartupPersonaPicker && (
        <PersonaPicker
          theme={theme}
          isMobile={isMobile}
          onSelect={(id) => handlePersonaSelect(id, false)}
          onSkip={handlePersonaSkip}
        />
      )}

      {showPersonaChangePicker && (
        <PersonaPicker
          theme={theme}
          isMobile={isMobile}
          changeMode
          currentPersona={persona}
          onSelect={(id) => handlePersonaSelect(id, true)}
        />
      )}

      <PersonaApplyConfirmModal
        isOpen={Boolean(personaApplyConfirm)}
        personaLabel={personaApplyConfirm?.label ?? ''}
        theme={theme}
        onApply={() => handlePersonaApplyConfirm(true)}
        onPersonaOnly={() => handlePersonaApplyConfirm(false)}
        onClose={dismissPersonaApplyConfirm}
      />

      {/* First-run tour after splash (skipped if user chose Skip and open map) */}
      {!showStackSplash && showFirstRunTour && !skippedToMap && personaResolved && persona && (
        <FirstTimeTour
          isOpen={true}
          isStartupSequence={true}
          overlayMode={true}
          isReady={true}
          onComplete={handleLaunchComplete}
          onSkipLocation={skipLocationPrompt}
          onEnableNotifications={handleStartupNotificationRequest}
          onOpenNotificationPreferences={() => setShowNotificationPreferences(true)}
          dbStatus={dbStatus}
          isFallback={isFallback}
          isMobile={isMobile}
          theme={theme}
        />
      )}
    </div>
  );
}
