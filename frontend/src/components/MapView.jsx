import React, { useEffect, useState, useMemo, useRef } from 'react';
import { ResolutionBadgeCompact } from './ResolutionBadge';
import { MapContainer, TileLayer, Tooltip, useMap, useMapEvents, Marker, Popup, Polyline, Circle } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Layers, ChevronDown, ChevronUp } from 'lucide-react';
import { getApiUrl } from '../utils/getApiUrl';
import { calculateDistanceKm } from '../utils/haversine';
import {
  formatEarthquakeWhen,
  getEarthquakeImpactRadiusMeters,
  getEarthquakeLatLng,
} from '../utils/formatEarthquake';

const CARTO_KEY = import.meta.env.VITE_CARTO_API_KEY || '';

// Which disruption types each POI category can serve as shelter for.
// Mirrors _DISRUPTION_SAFE_TIERS in backend/main.py — keep in sync if tiers change.
const POI_DISRUPTION_SUITABILITY = {
  hospital:   { disruptions: ['Flood', 'Earthquake', 'Traffic', 'Crowd', 'Severe Weather'], tier: 'Primary', emoji: '🏥' },
  police:     { disruptions: ['Earthquake', 'Traffic', 'Crowd'],                            tier: 'Primary', emoji: '🚔' },
  university: { disruptions: ['Flood', 'Earthquake', 'Traffic', 'Crowd', 'Severe Weather'], tier: 'Secondary', emoji: '🎓' },
  mall:       { disruptions: ['Flood', 'Earthquake', 'Traffic', 'Crowd', 'Severe Weather'], tier: 'Fallback', emoji: '🏬' },
  market:     { disruptions: ['Flood', 'Traffic', 'Crowd', 'Severe Weather'],               tier: 'Fallback', emoji: '🏪' },
  station:    { disruptions: ['Traffic', 'Crowd'],                                          tier: 'Fallback', emoji: '🚉' },
};

const DISRUPTION_EMOJI = {
  Flood: '🌊', Earthquake: '🌍', Traffic: '🚦', Crowd: '👥', 'Severe Weather': '⛈️',
};

 
// Leaflet center for Jabodetabek regional focus
const JABODETABEK_CENTER = [-6.25, 106.85];
 
// Inverts coordinates from GeoJSON [lon, lat] format to Leaflet [lat, lon] format
function invertCoords(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  const rings = geometry.coordinates;
  return rings[0].map(coord => [coord[1], coord[0]]);
}
 
// Computes center [lat, lon] and radius in meters from coordinates
function getCircleParams(coords) {
  if (!coords || coords.length === 0) return { center: [0, 0], radius: 0 };
  
  let sumLat = 0;
  let sumLon = 0;
  coords.forEach(coord => {
    sumLat += coord[0];
    sumLon += coord[1];
  });
  const center = [sumLat / coords.length, sumLon / coords.length];
  
  let maxDist = 0;
  coords.forEach(c => {
    const dLat = (c[0] - center[0]) * 111000;
    const dLon = (c[1] - center[1]) * 111000 * Math.cos(center[0] * Math.PI / 180);
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    if (dist > maxDist) maxDist = dist;
  });
  
  return {
    center,
    radius: maxDist * 0.8
  };
}
 
// Custom style mapper for geofenced zones based on their risk level
function getStyleForRisk(risk) {
  switch (risk) {
    case 'Critical':
      return {
        fillColor: '#FF2A2A',
        color: '#FF2A2A',
        weight: 4.0,
        opacity: 0.95,
        fillOpacity: 0.15,
        className: 'animate-pulse hover:fill-opacity-40 hover:opacity-75 transition-all duration-300'
      };
    case 'High':
      return {
        fillColor: '#FF7A00',
        color: '#FF7A00',
        weight: 3.5,
        opacity: 0.90,
        fillOpacity: 0.10,
        className: 'hover:fill-opacity-25 hover:opacity-50 transition-all duration-300'
      };
    case 'Medium':
      return {
        fillColor: '#E6A800',
        color: '#B8860B',
        weight: 3.5,
        opacity: 0.85,
        fillOpacity: 0.07,
        className: 'hover:fill-opacity-18 hover:opacity-40 transition-all duration-300'
      };
    case 'Low':
    default:
      return {
        fillColor: '#00E676',
        color: '#00E676',
        weight: 2.5,
        opacity: 0.80,
        fillOpacity: 0.05,
        className: 'hover:fill-opacity-10 hover:opacity-25 transition-all duration-300'
      };
  }
}
 
// Helper to construct highly stylized modern marker icons for different categories
const createPoiIcon = (category, isSuppressed = false, crowdScore = 0) => {
  let colorClass = 'bg-emerald-500 border-emerald-300';
  let emoji = '🏪';
  if (category === 'mall') {
    colorClass = isSuppressed ? 'bg-rose-500/60 border-rose-400/50' : 'bg-rose-500 border-rose-300 shadow-rose-500/50';
    emoji = '🛍️';
  } else if (category === 'station') {
    colorClass = isSuppressed ? 'bg-blue-500/60 border-blue-400/50' : 'bg-blue-500 border-blue-300 shadow-blue-500/50';
    emoji = '🚆';
  } else if (category === 'unique_building') {
    colorClass = isSuppressed ? 'bg-purple-500/60 border-purple-400/50' : 'bg-purple-500 border-purple-300 shadow-purple-500/50';
    emoji = '🏛️';
  } else if (category === 'small_business') {
    colorClass = isSuppressed ? 'bg-amber-500/60 border-amber-400/50' : 'bg-amber-500 border-amber-300 shadow-amber-500/50';
    emoji = '🍱';
  }
  
  const bounceClass = isSuppressed ? '' : 'animate-bounce';
  const borderStyle = isSuppressed ? 'border-dashed border' : 'border-2';
  const scaleStyle = isSuppressed ? 'opacity-65 scale-90' : 'shadow-glow';
 
  const crowdBadge = (!isSuppressed && crowdScore > 0)
    ? `<div style="position:absolute;top:-5px;right:-5px;background:${crowdScore >= 65 ? '#ef4444' : crowdScore >= 35 ? '#f97316' : '#22c55e'};border-radius:9999px;width:14px;height:14px;display:flex;align-items:center;justify-content:center;font-size:8px;border:1px solid white;font-weight:bold;color:white;">${Math.round(crowdScore)}</div>`
    : '';
 
  return L.divIcon({
    html: `<div style="position:relative;display:inline-block;">
      <div class="flex items-center justify-center w-8 h-8 rounded-full ${colorClass} text-white ${scaleStyle} ${borderStyle} ${bounceClass} cursor-pointer text-sm transform hover:scale-110 transition-all duration-200">
        <span>${emoji}</span>
      </div>
      ${crowdBadge}
    </div>`,
    className: 'custom-poi-marker',
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32]
  });
};
const createSafeZoneIcon = (type) => {
  let emoji = "🛡️";
 
  if (type === "Evacuation Point") {
    emoji = "&#x1F3D5;"; // 🏕️
  } else if (type === "High Ground") {
    emoji = "⛰️";
  }
 
  return L.divIcon({
    html: `
      <div class="flex items-center justify-center
                  w-10 h-10 rounded-full
                  bg-emerald-600
                  border-[3px] border-white
                  shadow-[0_0_0_2px_rgba(255,255,255,0.85)] text-lg">
        ${emoji}
      </div>
    `,
    className: "safe-zone-marker",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -24]
  });
};
const createStartPinIcon = () => L.divIcon({
  html: `
    <div class="flex items-center justify-center
                w-7 h-7 rounded-full
                bg-emerald-500
                border-[3px] border-white
                shadow-[0_2px_8px_rgba(0,0,0,0.35)]
                text-white text-xs font-extrabold
                ring-2 ring-emerald-500/40">
      A
    </div>
  `,
  className: "route-pin-marker",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -16]
});

const createDestinationPinIcon = () => L.divIcon({
  html: `
    <div class="flex items-center justify-center
                w-7 h-7 rounded-full
                bg-red-500
                border-[3px] border-white
                shadow-[0_2px_8px_rgba(0,0,0,0.35)]
                text-white text-xs font-extrabold
                ring-2 ring-red-500/40">
      B
    </div>
  `,
  className: "route-pin-marker",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -16]
});

// Helper to determine styling of Jakarta's waterways based on alert and category
const getWaterwayStyle = (category, alertLevel) => {
  let color = '#2563eb'; // Default Normal Safe Blue
  let weight = 4;
  let dashArray = null;
  let pulseClass = '';
 
  if (alertLevel === 'Siaga 1' || alertLevel === 'Siaga 2') {
    color = '#dc2626'; // Critical Red
    pulseClass = 'animate-pulse';
    weight = 5;
  } else if (alertLevel === 'Siaga 3') {
    color = '#ea580c'; // High Orange
    pulseClass = 'animate-pulse';
    weight = 4.5;
  } else if (alertLevel === 'Siaga 4') {
    color = '#d97706'; // Caution Amber
    weight = 4;
  }
 
  // Adjust style based on category
  if (category === 'canal') {
    dashArray = '8, 8'; // Dashed BKB canal
    weight += 1;
  } else if (category === 'kali') {
    weight -= 1.5; // Thinner local creek
  }
 
  return {
    color,
    weight,
    dashArray,
    className: `transition-all duration-300 hover:opacity-90 ${pulseClass}`
  };
};
 
// Custom hook or component to render shape-following buffer zones dynamically on zoom
function WaterwayBufferLayer({ waterways, waterwayThreshold, waterwayBuffer, activeLayers }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  
  useEffect(() => {
    const handleZoom = () => setZoom(map.getZoom());
    map.on('zoomend', handleZoom);
    return () => { map.off('zoomend', handleZoom); };
  }, [map]);
 
  if (!activeLayers.waterways) return null;
 
  // Calculate meters per pixel at average Jakarta latitude (-6.21)
  const lat = -6.21;
  const metersPerPixel = (40075016.686 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom + 8);
 
  return (
    <>
      {waterways.map((waterway, idx) => {
        const isThreat = waterway.capacity_percentage >= waterwayThreshold;
        if (!isThreat) return null;
 
        // Calculate dynamic buffer in meters for this specific waterway based on its fill level
        // Exponential scaling to simulate rapid expansion of flood zones as capacity peaks
        // E.g., at 50% capacity -> 75m buffer; at 90% capacity -> 243m buffer; at 100% capacity
        const positions =
          typeof waterway.coordinates === "string"
            ? JSON.parse(waterway.coordinates)
            : waterway.coordinates;
        const leafletPositions = positions.map(([lon, lat]) => [lat, lon]);
        const cappedCapacity = Math.min(100, waterway.capacity_percentage);
        const dynamicBufferMeters = waterwayBuffer * Math.pow(cappedCapacity / 100, 2);
 
        // Compute pixel weight representing the dynamic buffer distance (diameter = 2 * radius in meters)
        // We enforce a minimum weight of 20px so that it is always visibly wider than the 5px waterway line itself.
        const bufferWeight = Math.max(20, (dynamicBufferMeters * 2) / metersPerPixel);
 
        // Scales opacity based on risk: higher capacity = denser threat glow
        const opacity = 0.12 + (waterway.capacity_percentage / 100) * 0.22;
 
        return (
          <Polyline
            key={`buffer-${waterway.name}-${idx}`}
            positions={leafletPositions}
            pathOptions={{
              color: '#ef4444',
              weight: bufferWeight,
              opacity,
              lineCap: 'round',
              lineJoin: 'round',
              className: 'animate-pulse'
            }}
            interactive={false}
          />
        );
      })}
    </>
  );
}
 
const DEFAULT_ROUTE_FIT_PADDING = [60, 60];

function getLatLngBoundsFromLatLngs(latLngs) {
  return latLngs.reduce(
    (b, [lat, lon]) => [
      [Math.min(b[0][0], lat), Math.min(b[0][1], lon)],
      [Math.max(b[1][0], lat), Math.max(b[1][1], lon)],
    ],
    [[Infinity, Infinity], [-Infinity, -Infinity]]
  );
}

function hasActiveRoute(evacuationRoute, navigateSaferRoute, navigateFasterRoute) {
  return [evacuationRoute, navigateSaferRoute, navigateFasterRoute].some((g) => {
    const coords = g?.coordinates ?? g?.geometry?.coordinates ?? [];
    return coords.length >= 2;
  });
}

function fitMapToEarthquake(map, eq, { isMobile = false, fitPadding = DEFAULT_ROUTE_FIT_PADDING } = {}) {
  const latLng = getEarthquakeLatLng(eq);
  if (!latLng) return;

  const radiusM = getEarthquakeImpactRadiusMeters(eq);
  const bounds = L.latLng(latLng).toBounds(radiusM * 2.2);

  const options = {
    maxZoom: 12,
    animate: true,
    duration: 1.0,
  };

  if (isMobile) {
    options.paddingTopLeft = [72, 40];
    options.paddingBottomRight = [128, 40];
  } else {
    options.padding = fitPadding;
  }

  map.fitBounds(bounds, options);
}

// Controller component to dynamically pan/zoom the map view to the selected zone or earthquake
function MapController({
  selectedZone,
  selectedEarthquake,
  mapVisible = true,
  isMobile = false,
  earthquakeFitPadding = DEFAULT_ROUTE_FIT_PADDING,
  disableZoneAutoZoom = false,
}) {
  const map = useMap();
  const selectedZoneId = selectedZone?.id ?? selectedZone?.zone_id ?? null;

  useEffect(() => {
    if (disableZoneAutoZoom || !selectedZoneId || !selectedZone?.geometry) return;

    const coords = invertCoords(selectedZone.geometry);
    if (coords.length === 0) return;

    const bounds = getLatLngBoundsFromLatLngs(coords);
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14, animate: true, duration: 1.2 });
  }, [selectedZoneId, disableZoneAutoZoom, map]);

  useEffect(() => {
    if (selectedZoneId || !selectedEarthquake || !mapVisible) return undefined;

    const fit = () => fitMapToEarthquake(map, selectedEarthquake, { isMobile, fitPadding: earthquakeFitPadding });

    fit();
    map.invalidateSize({ pan: false });

    // Re-fit after Leaflet remeasures the container (mobile tab switch / flex layout settle)
    const timers = [50, 300, 700].map((ms) => setTimeout(fit, ms));
    return () => timers.forEach(clearTimeout);
  }, [selectedZoneId, selectedEarthquake, mapVisible, isMobile, earthquakeFitPadding, map]);

  return null;
}

/**
 * Zooms the map to the user's location and the Near Me radius (e.g. 5 km).
 * Re-runs when location is obtained/refreshed or when the radius slider changes.
 */
function UserLocationController({ userLocation, nearMeRadius = 5, enabled = true, selectedEarthquake = null }) {
  const map = useMap();

  useEffect(() => {
    if (!enabled || selectedEarthquake || !userLocation?.lat || !userLocation?.lon) return;

    const radiusKm = Math.max(1, Number(nearMeRadius) || 5);
    // LatLng.toBounds(sizeInMeters): each edge is size/2 meters from center → pass diameter
    const bounds = L.latLng(userLocation.lat, userLocation.lon).toBounds(radiusKm * 1000 * 2);

    map.fitBounds(bounds, {
      padding: [48, 48],
      maxZoom: 15,
      animate: true,
      duration: 0.9,
    });
  }, [userLocation, nearMeRadius, enabled, selectedEarthquake, map]);

  return null;
}
 
function MapClickListener({ onClearSelectedEarthquake }) {
  useMapEvents({
    click(e) {
      // Clear selected earthquake only if clicking the general map canvas
      if (onClearSelectedEarthquake) {
        onClearSelectedEarthquake();
      }
    }
  });
  return null;
}

/**
 * Fixes the Leaflet "only responds in bottom-left corner" bug on mobile.
 *
 * Root cause: Leaflet caches the map container's page offset (offsetTop/Left)
 * at init time. On mobile with flexbox layouts, the container settles AFTER
 * Leaflet has already cached wrong values. Touch events are then mapped to
 * wrong coordinates — only the top-left region (where offset≈0) works.
 *
 * Fix: Use ResizeObserver to detect when the container actually gets its
 * real size, then call invalidateSize() to force Leaflet to remeasure.
 * Also call on multiple delays as a safety net.
 */
function MapSizeInvalidator({ selectedEarthquake = null, isMobile = false }) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();

    const measure = (label) => {
      const rect = container.getBoundingClientRect();
      const size = map.getSize();
      console.log(`[Leaflet ${label}] container rect:`, 
        `left=${rect.left.toFixed(0)} top=${rect.top.toFixed(0)}`,
        `w=${rect.width.toFixed(0)} h=${rect.height.toFixed(0)}`,
        `| map.getSize(): ${size.x}x${size.y}`
      );
      map.invalidateSize({ pan: false });
      if (selectedEarthquake) {
        fitMapToEarthquake(map, selectedEarthquake, { isMobile });
      }
    };

    const timers = [
      setTimeout(() => measure('50ms'), 50),
      setTimeout(() => measure('300ms'), 300),
      setTimeout(() => measure('800ms'), 800),
    ];

    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        measure('ResizeObserver');
      });
      ro.observe(container);
    }

    return () => {
      timers.forEach(clearTimeout);
      if (ro) ro.disconnect();
    };
  }, [map, selectedEarthquake, isMobile]);

  return null;
}

/**
 * RouteController — auto-pans and zooms the map to fit the evacuation route
 * whenever evacuationRoute changes. Works like a navigation app: as soon as
 * a route is calculated, the map adjusts to show the full path.
 */
function RouteController({
  evacuationRoute,
  navigateSaferRoute,
  navigateFasterRoute,
  fitPadding = DEFAULT_ROUTE_FIT_PADDING,
}) {
  const map = useMap();
  const fitPaddingRef = useRef(fitPadding);
  fitPaddingRef.current = fitPadding;

  useEffect(() => {
    const collections = [evacuationRoute, navigateSaferRoute, navigateFasterRoute]
      .map((g) => g?.coordinates ?? g?.geometry?.coordinates ?? [])
      .filter((coords) => coords.length >= 2);
    if (collections.length === 0) return;

    const coords = collections.flat();
    const latLngs = coords.map(([lon, lat]) => [lat, lon]);
    const bounds = getLatLngBoundsFromLatLngs(latLngs);

    map.fitBounds(bounds, {
      padding: fitPaddingRef.current,
      maxZoom: 15,
      animate: true,
      duration: 1.0,
    });
  }, [evacuationRoute, navigateSaferRoute, navigateFasterRoute, map]);

  return null;
}
 
export default function MapView({ 
  predictions = [], 
  selectedZone, 
  onSelectZone, 
  theme = 'light', 
  userLocation = null,
  waterwayThreshold = 75,
  setWaterwayThreshold,
  waterwayBuffer = 150,
  setWaterwayBuffer,
  earthquakes = [],
  selectedEarthquake = null,
  onClearSelectedEarthquake,
  nearMeFilterActive = false,
  setNearMeFilterActive,
  nearMeRadius = 5,
  setNearMeRadius,
  evacuationRoute = null,
  navigateSaferRoute = null,
  navigateFasterRoute = null,
  routeDestination = null,
  selectedNavigateRoute = 'safer',
  suppressMapControls = false,
  isMobile = false,
  mapVisible = true,
  layerPreset = null,
  routeFitPadding = DEFAULT_ROUTE_FIT_PADDING,
}) {
  const isLight = theme === 'light';
  const [globalPois, setGlobalPois] = useState([]);
  const hasActiveDisruptions = predictions.length > 0;
  const activeRoutePresent = useMemo(
    () => hasActiveRoute(evacuationRoute, navigateSaferRoute, navigateFasterRoute),
    [evacuationRoute, navigateSaferRoute, navigateFasterRoute]
  );

  // Destination pin position: prefer the named destination passed from App
  // (Navigate selection or evacuation panel). Fall back to the end point of
  // whichever route polyline is currently drawn.
  const routePinDestination = useMemo(() => {
    if (!activeRoutePresent) return null;
    if (Number.isFinite(routeDestination?.lat) && Number.isFinite(routeDestination?.lon)) {
      return {
        lat: routeDestination.lat,
        lon: routeDestination.lon,
        name: routeDestination.name || 'Destination',
        address: routeDestination.address || '',
      };
    }
    let coords = null;
    if (evacuationRoute?.geometry?.coordinates?.length >= 2) {
      coords = evacuationRoute.geometry.coordinates[evacuationRoute.geometry.coordinates.length - 1];
    } else {
      const primary = selectedNavigateRoute === 'faster'
        ? (navigateFasterRoute ?? navigateSaferRoute)
        : (navigateSaferRoute ?? navigateFasterRoute);
      const arr = primary?.coordinates ?? primary?.geometry?.coordinates ?? [];
      if (arr.length >= 2) coords = arr[arr.length - 1];
    }
    if (!coords) return null;
    return { lat: coords[1], lon: coords[0], name: 'Destination', address: '' };
  }, [activeRoutePresent, routeDestination, evacuationRoute, navigateSaferRoute, navigateFasterRoute, selectedNavigateRoute]);
  const [waterways, setWaterways] = useState([]);
  const [allZones, setAllZones] = useState([]);
  const [showLayerPanel, setShowLayerPanel] = useState(false);
  const [isLegendMinimized, setIsLegendMinimized] = useState(true);
  const [activeLayers, setActiveLayers] = useState({
    hospital: false,
    police: false,
    university: false,
    mall: false,
    market: false,
    station: false,
    waterways: false,
    earthquakes: false,
    safe_zones: true,
    threat_traffic: true,
    threat_weather: true,
    threat_crowd: true,
    threat_waterway: true,
    threat_earthquake: true
  });
 
  // Automatically enable the Earthquakes layer if an earthquake is selected
  useEffect(() => {
    if (selectedEarthquake) {
      setActiveLayers(prev => ({ ...prev, earthquakes: true }));
    }
  }, [selectedEarthquake]);

  useEffect(() => {
    if (suppressMapControls) setShowLayerPanel(false);
  }, [suppressMapControls]);

  useEffect(() => {
    if (!layerPreset) return;
    setActiveLayers((prev) => ({ ...prev, ...layerPreset }));
  }, [layerPreset]);
 
  const hasDisruptionInRadius = useMemo(() => {
    if (!userLocation || !predictions || predictions.length === 0) return false;
    return predictions.some(pred => {
      const coords = invertCoords(pred.zone.geometry);
      if (coords.length === 0) return false;
      const { center } = getCircleParams(coords);
      const distance = calculateDistanceKm(userLocation.lat, userLocation.lon, center[0], center[1]);
      return distance <= nearMeRadius;
    });
  }, [userLocation, predictions, nearMeRadius]);
 
  const API_URL = getApiUrl();
 
  // Fetch POIs catalog globally
  useEffect(() => {
    fetch(`${API_URL}/pois`)
      .then(res => {
        if (res.ok) return res.json();
        throw new Error('Seeding fallback');
      })
      .then(data => setGlobalPois(data))
      .catch(() => {
        console.warn("[MapView] Loading offline high-fidelity local POI stubs.");
        setGlobalPois(prev => {
          if (prev && prev.length > 0) return prev;
          return [
            // --- Jakarta Core ---
            { name: "Grand Indonesia Mall", category: "mall", lat: -6.195, lon: 106.820, is_suppressed: false },
            { name: "Plaza Indonesia", category: "mall", lat: -6.193, lon: 106.821, is_suppressed: false },
            { name: "Pacific Place Mall", category: "mall", lat: -6.224, lon: 106.810, is_suppressed: false },
            { name: "Kuningan City Mall", category: "mall", lat: -6.225, lon: 106.830, is_suppressed: false },
            { name: "Lippo Mall Kemang", category: "mall", lat: -6.273, lon: 106.815, is_suppressed: false },
            { name: "Mal Ciputra Jakarta", category: "mall", lat: -6.167, lon: 106.786, is_suppressed: false },
            { name: "Central Park Mall", category: "mall", lat: -6.177, lon: 106.790, is_suppressed: false },
            
            { name: "Sudirman MRT Station", category: "station", lat: -6.202, lon: 106.822, is_suppressed: false },
            { name: "BNI City LRT Station", category: "station", lat: -6.202, lon: 106.819, is_suppressed: false },
            { name: "Kuningan LRT Station", category: "station", lat: -6.220, lon: 106.829, is_suppressed: false },
            { name: "Grogol KRL Station", category: "station", lat: -6.161, lon: 106.789, is_suppressed: false },
 
            { name: "Jakarta City Hall", category: "unique_building", lat: -6.181, lon: 106.827, is_suppressed: false },
            { name: "DPR Parliament Building", category: "unique_building", lat: -6.210, lon: 106.800, is_suppressed: false },
            { name: "BPBD DKI Jakarta Office", category: "unique_building", lat: -6.175, lon: 106.820, is_suppressed: false },
 
            { name: "UMKM Kuliner Sabang", category: "small_business", lat: -6.187, lon: 106.824, is_suppressed: false },
            { name: "Kemang Food Festival", category: "small_business", lat: -6.2725, lon: 106.8153, is_suppressed: true },
            { name: "Grogol UMKM Street Food", category: "small_business", lat: -6.166, lon: 106.788, is_suppressed: false },
 
            // --- Bogor ---
            { name: "Botani Square Mall", category: "mall", lat: -6.601, lon: 106.806, is_suppressed: false },
            { name: "Bogor Railway Station", category: "station", lat: -6.594, lon: 106.789, is_suppressed: false },
            { name: "Bogor Presidential Palace", category: "unique_building", lat: -6.597, lon: 106.797, is_suppressed: false },
            { name: "UMKM Suryakencana Street Food", category: "small_business", lat: -6.604, lon: 106.800, is_suppressed: false },
 
            // --- Depok ---
            { name: "Margo City Mall", category: "mall", lat: -6.372, lon: 106.834, is_suppressed: false },
            { name: "Depok Baru Station", category: "station", lat: -6.391, lon: 106.818, is_suppressed: false },
            { name: "Universitas Indonesia Rectorate", category: "unique_building", lat: -6.361, lon: 106.827, is_suppressed: false },
            { name: "UMKM Margonda Culinary", category: "small_business", lat: -6.376, lon: 106.832, is_suppressed: false },
 
            // --- Tangerang ---
            { name: "Summarecon Mall Serpong", category: "mall", lat: -6.241, lon: 106.628, is_suppressed: false },
            { name: "Tangerang Railway Station", category: "station", lat: -6.176, lon: 106.633, is_suppressed: false },
            { name: "Tangerang City Hall", category: "unique_building", lat: -6.174, lon: 106.640, is_suppressed: false },
            { name: "UMKM Pasar Lama Tangerang", category: "small_business", lat: -6.179, lon: 106.632, is_suppressed: false },
 
            // --- Bekasi ---
            { name: "Summarecon Mall Bekasi", category: "mall", lat: -6.223, lon: 106.999, is_suppressed: false },
            { name: "Bekasi Railway Station", category: "station", lat: -6.235, lon: 106.999, is_suppressed: false },
            { name: "Bekasi City Hall", category: "unique_building", lat: -6.230, lon: 106.994, is_suppressed: false },
            { name: "UMKM Galaxy Food City", category: "small_business", lat: -6.269, lon: 106.974, is_suppressed: false },
          ];
        });
      });
  }, []);
 
  // Fetch dynamic Waterways catalog
  useEffect(() => {
    fetch(`${API_URL}/rivers`)
      .then(res => {
        if (res.ok) return res.json();
        throw new Error('Rivers fallback');
      })
      .then(data => setWaterways(data))
      .catch(() => {
        console.warn("[MapView] Loading offline Jakarta waterways stubs.");
        setWaterways(prev => {
          if (prev && prev.length > 0) return prev;
          return [
            { name: "Ciliwung River", category: "river", coordinates: [[-6.600, 106.800], [-6.450, 106.810], [-6.300, 106.840], [-6.250, 106.835], [-6.220, 106.828], [-6.205, 106.825], [-6.180, 106.827], [-6.150, 106.820]], current_level: 630.0, max_capacity: 1000.0, capacity_percentage: 63.0, alert_level: "Normal" },
            { name: "Cisadane River", category: "river", coordinates: [[-6.350, 106.600], [-6.300, 106.610], [-6.241, 106.628], [-6.179, 106.632], [-6.100, 106.630]], current_level: 480.0, max_capacity: 900.0, capacity_percentage: 53.3, alert_level: "Normal" },
            { name: "Kali Bekasi", category: "river", coordinates: [[-6.320, 106.995], [-6.269, 106.974], [-6.230, 106.994], [-6.180, 107.000], [-6.120, 107.010]], current_level: 310.0, max_capacity: 700.0, capacity_percentage: 44.3, alert_level: "Normal" },
            { name: "West Flood Canal (BKB)", category: "canal", coordinates: [[-6.220, 106.798], [-6.210, 106.802], [-6.198, 106.815], [-6.185, 106.798], [-6.160, 106.788]], current_level: 535.5, max_capacity: 800.0, capacity_percentage: 66.9, alert_level: "Normal" },
            { name: "Kali Grogol", category: "kali", coordinates: [[-6.240, 106.785], [-6.200, 106.782], [-6.180, 106.786], [-6.155, 106.780]], current_level: 315.0, max_capacity: 500.0, capacity_percentage: 63.0, alert_level: "Siaga 4" }
          ];
        });
      });
  }, [predictions]); // Refetch when predictions sweep updates (ensures sync)
 
  // Fetch ALL zone statuses (not just alerts) to show every zone on the map
  useEffect(() => {
    const fetchAllZones = async () => {
      try {
        const res = await fetch(`${getApiUrl()}/zone-status/all`);
        if (res.ok) {
          const data = await res.json();
          setAllZones(data);
        }
      } catch (e) {
        console.warn('[MapView] Could not fetch zone statuses:', e);
      }
    };
    fetchAllZones();
    const id = setInterval(fetchAllZones, 30000);
    return () => clearInterval(id);
  }, []);
 
  const toggleLayer = (layerId) => {
    setActiveLayers(prev => ({ ...prev, [layerId]: !prev[layerId] }));
  };

  const applyLayerPreset = (presetKey) => {
    const base = {
      hospital: false,
      police: false,
      university: false,
      mall: false,
      market: false,
      station: false,
      waterways: false,
      earthquakes: false,
      safe_zones: true,
      threat_traffic: true,
      threat_weather: true,
      threat_crowd: true,
      threat_waterway: true,
      threat_earthquake: true,
    };
    if (presetKey === 'hospitals') {
      setActiveLayers({ ...base, hospital: true });
      return;
    }
    if (presetKey === 'safe_places') {
      setActiveLayers({ ...base, hospital: true, police: true, safe_zones: true });
      return;
    }
    setActiveLayers(base);
  };
  const [safeZones, setSafeZones] = useState([]);
  // Re-fetch whenever active threat layers change so the right safe zone category shows:
  // flood/waterway → high_ground, everything else → evacuation_point
  useEffect(() => {
    const LAYER_TO_DISRUPTION = {
      threat_traffic: 'traffic', threat_weather: 'weather', threat_crowd: 'crowd',
      threat_earthquake: 'earthquake', threat_waterway: 'waterway',
    };
    const activeDisruptions = Object.entries(LAYER_TO_DISRUPTION)
      .filter(([id]) => activeLayers[id])
      .map(([, dtype]) => dtype);
    const qs = activeDisruptions.length ? `?disruption_types=${activeDisruptions.join(',')}` : '';
    fetch(`${API_URL}/safe-zones${qs}`)
      .then(res => { if (!res.ok) throw new Error('Failed'); return res.json(); })
      .then(data => setSafeZones(data))
      .catch(err => console.error('Safe zones fetch failed:', err));
  }, [API_URL, activeLayers]);
 
  // Compute active threat zone s to suppress safe zones within them
  const threatZones = useMemo(() => {
    const list = [];
    
    // 1. From active predictions
    predictions.forEach(pred => {
      const zone = pred.zone;
      if (zone && zone.geometry) {
        const coords = invertCoords(zone.geometry);
        if (coords.length > 0) {
          const { center, radius } = getCircleParams(coords);
          list.push({ center, radius });
        }
      }
    });
 
    // 2. From allZones that have a dominant active threat
    const threatLayerMap = {
      traffic: 'threat_traffic',
      weather: 'threat_weather',
      crowd: 'threat_crowd',
      earthquake: 'threat_earthquake',
      waterway: 'threat_waterway',
    };
 
    allZones.forEach(zs => {
      if (predictions.some(p => p.zone?.zone_id === zs.zone_id || p.zone?.id === zs.zone_id)) {
        return;
      }
      const zone = zs.zone;
      if (!zone || !zone.geometry) return;
 
      const dimScores = {
        traffic: zs.traffic_score || 0,
        weather: zs.weather_score || 0,
        crowd: zs.crowd_score || 0,
        earthquake: zs.earthquake_score || 0,
        waterway: zs.waterway_score || 0,
      };
 
      // Zone suppresses nearby safe zones only if it has an OPEN alert for an
      // active checked dimension — matches the "ghost " fix above so
      // safe zones reappear once the alert closes, not just once the score decays.
      const openDims = new Set(zs.open_threat_dims || []);
      const hasActiveThreat = Object.entries(dimScores).some(([dim, score]) =>
        activeLayers[threatLayerMap[dim]] && openDims.has(dim) && score >= 10
      );

      if (hasActiveThreat) {
        const coords = invertCoords(zone.geometry);
        if (coords.length > 0) {
          const { center, radius } = getCircleParams(coords);
          list.push({ center, radius });
        }
      }
    });
 
    return list;
  }, [predictions, allZones, activeLayers]);
 
  const filteredSafeZones = useMemo(() => {
    return safeZones.filter(sz => {
      const isInsideThreat = threatZones.some(circle => {
        const distKm = calculateDistanceKm(sz.latitude, sz.longitude, circle.center[0], circle.center[1]);
        return distKm * 1000 <= circle.radius;
      });
      return !isInsideThreat;
    });
  }, [safeZones, threatZones]);
 
  // Determine POIs to display globally
  const poisToRender = globalPois.filter(poi => activeLayers[poi.category]);
 
  return (
    <div className="relative w-full h-full overflow-hidden">
      {!suppressMapControls && (
        <>
          {/* Risk Legend — on mobile, sit below the Near Me status chip (primary "am I safe?" signal) */}
          <div className={`absolute left-4 z-[1100] ${isMobile ? 'top-[4.75rem]' : 'top-4'}`}>
            {isLegendMinimized ? (
              <button
                type="button"
                onClick={() => setIsLegendMinimized(false)}
                className="flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-2 text-sm font-semibold text-slate-900 shadow-lg transition hover:bg-white dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-100"
              >
                <ChevronDown className="h-4 w-4" />
                <span>Legend</span>
              </button>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white/95 px-3 py-3 text-slate-900 shadow-lg dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-100">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-600 dark:text-slate-400">
                    Legend
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsLegendMinimized(true)}
                    className="rounded-full p-1 text-slate-600 transition hover:bg-slate-200/80 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    aria-label="Minimize legend"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="text-xs font-bold uppercase tracking-[0.2em] text-slate-600 dark:text-slate-400 mb-2">
                  Risk Levels
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-[#FF2A2A]"></span>
                    <span className="text-[11px] text-slate-900 dark:text-slate-100">Critical (80+)</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-[#FF7A00]"></span>
                    <span className="text-[11px] text-slate-900 dark:text-slate-100">High (65-79)</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-[#E6A800]"></span>
                    <span className="text-[11px] text-slate-900 dark:text-slate-100">Medium (35-64)</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-[#00E676]"></span>
                    <span className="text-[11px] text-slate-900 dark:text-slate-100">Low (0-34)</span>
                  </div>
                </div>

                <div className="mt-3 text-xs font-bold uppercase tracking-[0.2em] text-slate-600 dark:text-slate-400 mb-2">
                  Size Legend
                </div>

                <div className="space-y-1.5 text-xs text-slate-900 dark:text-slate-100">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full border border-slate-700 bg-white/80 dark:border-slate-200 dark:bg-slate-800/80"></div>
                    <span>Small circle = smaller affected area</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="h-6 w-6 rounded-full border border-slate-700 bg-white/80 dark:border-slate-200 dark:bg-slate-800/80"></div>
                    <span>Large circle = larger affected area</span>
                  </div>
                </div>

                <div className="mt-3 text-xs font-bold uppercase tracking-[0.2em] text-slate-600 dark:text-slate-400 mb-2">
                  Disruption Intensity
                </div>

                <div className="space-y-1.5 text-xs text-slate-900 dark:text-slate-100">
                  <div className="flex items-center gap-2">
                    <div className="h-4 w-4 rounded-full bg-[#FF2A2A]"></div>
                    <span>Solid = Strong disruption</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="h-4 w-4 rounded-full bg-[#FF2A2A] opacity-30"></div>
                    <span>Faded = Lower disruption</span>
                  </div>
                </div>
              </div>
            )}
          </div>
          {/* Floating Layer Toggle Panel — items-end keeps the trigger on the map's right edge
               even while the panel (min-w-[220px]) is closed / invisible */}
          <div className="absolute top-3 right-3 z-[1100] flex flex-col items-end pointer-events-none sm:top-4 sm:right-4">
   
    <button
      data-tour="layers-trigger"
      onClick={() => setShowLayerPanel(!showLayerPanel)}
      className="px-3 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-bold shadow-lg border border-indigo-400/30 hover:from-indigo-500 hover:to-purple-500 transition-all pointer-events-auto"
    >
      Map display
    </button>
   
    <div
      className={`glass-panel mt-2 p-2.5 rounded-xl border border-slate-700/60 shadow-2xl text-slate-100 flex flex-col space-y-1 w-[min(220px,calc(100vw-1.5rem))] max-h-[55vh] overflow-y-auto transform transition-transform duration-300 ease-out ${showLayerPanel ? 'translate-x-0 opacity-100 pointer-events-auto' : 'translate-x-3 opacity-0 pointer-events-none'}`}
      aria-hidden={!showLayerPanel}
    >
      <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-1">
        <div className="flex items-center space-x-2">
          <Layers className="w-4 h-4 text-indigo-400" />
          <span className="text-xs uppercase font-extrabold tracking-wider">Map display</span>
        </div>
        <button
          onClick={() => setShowLayerPanel(false)}
          className="text-slate-400 hover:text-slate-100 bg-transparent p-1 rounded hover:bg-slate-800/30">
          ✕
        </button>
      </div>
          {isMobile ? (
            <div className="grid grid-cols-1 gap-1.5 pb-2 border-b border-slate-800">
              {[
                { key: 'essentials', label: 'Essentials (threats only)' },
                { key: 'hospitals', label: 'Hospitals' },
                { key: 'safe_places', label: 'Safe places' },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyLayerPreset(key)}
                  className="min-h-[44px] w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 text-left text-xs font-semibold text-slate-200 hover:border-indigo-500/50 hover:text-indigo-300 transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
          <>
          <div className="text-xs uppercase font-bold text-slate-500 pt-1 pb-0.5 border-t border-slate-700/40">Threat Zones</div>
          <div className="flex flex-col space-y-1.5">
          {[
            { id: 'threat_traffic', label: 'Traffic 🚗', color: 'text-orange-400' },
            { id: 'threat_weather', label: 'Weather 🌧️', color: 'text-blue-400' },
            { id: 'threat_waterway', label: 'Flood / River 🌊', color: 'text-cyan-400' },
            { id: 'threat_crowd', label: 'Crowd 👥', color: 'text-yellow-400' },
            { id: 'threat_earthquake', label: 'Earthquake 🌋', color: 'text-red-400' }
          ].map(layer => (
            <label key={layer.id} className="flex items-center justify-between cursor-pointer group py-1.5 px-1.5 hover:bg-slate-800/30 active:bg-slate-800/50 rounded-lg transition-all">
              <span className={`text-[11px] font-semibold ${activeLayers[layer.id] ? layer.color : 'text-slate-500 dark:text-slate-400'} group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors`}>{layer.label}</span>
              <input
                type="checkbox"
                checked={activeLayers[layer.id]}
                onChange={() => toggleLayer(layer.id)}
                className="w-4 h-4 rounded border-slate-800 text-indigo-600 focus:ring-indigo-500 bg-slate-950/70 cursor-pointer"
              />
            </label>
          ))}
        </div>
 
        <div className="text-xs uppercase font-bold text-slate-500 pt-1 pb-0.5 border-t border-slate-700/40">Map Overlays</div>
        <div className="flex flex-col space-y-2 pb-2">
          {[
            { id: 'waterways', label: 'Waterways & Canals 🗺️', color: 'text-sky-400' },
            { id: 'earthquakes', label: 'Earthquake Rings 🌋', color: 'text-red-400' },
            { id: 'hospital', label: 'Hospitals 🏥', color: 'text-red-400' },
            { id: 'police', label: 'Police 🚔', color: 'text-blue-400' },
            { id: 'university', label: 'Universities 🎓', color: 'text-purple-400' },
            { id: 'mall', label: 'Malls 🏬', color: 'text-rose-400' },
            { id: 'market', label: 'Markets 🏪', color: 'text-amber-400' },
            { id: 'station', label: 'Stations 🚉', color: 'text-green-400' },
            { id: 'safe_zones', label: 'Safe Zones 🛡️', color: 'text-emerald-400' },
          ].map(layer => (
            <label key={layer.id} className="flex items-center justify-between cursor-pointer group py-1.5 px-1.5 hover:bg-slate-800/30 active:bg-slate-800/50 rounded-lg transition-all">
              <span className={`text-[11px] font-semibold ${activeLayers[layer.id] ? layer.color : 'text-slate-500 dark:text-slate-400'} group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors`}>{layer.label}</span>
              <input
                type="checkbox"
                checked={activeLayers[layer.id]}
                onChange={() => toggleLayer(layer.id)}
                className="w-4 h-4 rounded border-slate-800 text-indigo-600 focus:ring-indigo-500 bg-slate-950/70 cursor-pointer"
              />
            </label>
          ))}
        </div>
          </>
          )}

        {/* Radius query control integrated in layer filters panel */}
        {userLocation && (
          <div className="border-t border-slate-800/80 pt-2.5 mt-1.5 space-y-2.5">
            <div className="flex items-center justify-between py-1 px-0.5 hover:bg-slate-800/30 active:bg-slate-800/50 rounded-lg transition-all select-none">
              <span className="text-[11px] font-extrabold uppercase text-indigo-400">Near me / Distance</span>
              <input
                type="checkbox"
                checked={nearMeFilterActive}
                onChange={() => setNearMeFilterActive(!nearMeFilterActive)}
                className="w-4 h-4 rounded border-slate-800 text-indigo-600 focus:ring-indigo-500 bg-slate-950/70 cursor-pointer"
              />
            </div>
            
            <div className="space-y-1">
              <div className="flex justify-between text-xs font-semibold">
                <span className="text-slate-400">Distance:</span>
                <span className="text-indigo-400 font-bold font-mono">{nearMeRadius} km</span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                value={nearMeRadius}
                onChange={(e) => setNearMeRadius(Number(e.target.value))}
                className="w-full h-1 rounded bg-slate-950 accent-indigo-500 cursor-pointer"
              />
            </div>
          </div>
        )}
        
 
      </div>
    </div>
    </>
      )}
 
      <MapContainer 
        center={JABODETABEK_CENTER} 
        zoom={10} 
        zoomControl={false}
        scrollWheelZoom={true}
        touchZoom={true}
        dragging={true}
        tap={false}
        doubleClickZoom={true}
        className="w-full h-full"
        style={{ touchAction: 'none', WebkitTapHighlightColor: 'transparent' }}
      >
        {/* Tiles */}
        <TileLayer
          url={theme === 'dark'
            ? `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`
            : `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`
          }
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        />
        
        {/* Render User Location Circle first so it sits at the bottom of the z-index overlay */}
        {userLocation && (
          <>
            <Marker 
              position={[userLocation.lat, userLocation.lon]}
              icon={L.divIcon({
                html: `<div class="relative flex items-center justify-center">
                  <div class="absolute w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/40 shadow-glow animate-ping"></div>
                  <div class="w-3.5 h-3.5 rounded-full bg-blue-600 border-2 border-white shadow-md"></div>
                </div>`,
                className: 'user-location-marker',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
              })}
            >
              <Popup>
                <div className="font-sans p-2 text-slate-900 dark:text-slate-100 min-w-[210px] select-none">
                  <div className="font-bold text-sm mb-1 text-slate-800 dark:text-slate-200">My Location</div>
                  <div className="text-xs text-slate-500 mb-2.5">Accuracy: ±{Math.round(userLocation.accuracy)} meters</div>
                  
                  <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Disruptions Near Me:</span>
                      <button
                        onClick={() => setNearMeFilterActive(!nearMeFilterActive)}
                        className={`px-2.5 py-1 rounded text-[10px] font-extrabold uppercase transition-all duration-200 ${
                          nearMeFilterActive 
                            ? 'bg-indigo-600 hover:bg-indigo-500 text-white' 
                            : 'bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200'
                        }`}
                      >
                        {nearMeFilterActive ? 'Active' : 'Enable'}
                      </button>
                    </div>
 
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-bold text-slate-600 dark:text-slate-400">
                        <span>Search Radius:</span>
                        <span className="text-indigo-500 dark:text-indigo-400 font-bold font-mono">{nearMeRadius} km</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="20"
                        value={nearMeRadius}
                        onChange={(e) => setNearMeRadius(Number(e.target.value))}
                        className="w-full h-1 rounded bg-slate-200 dark:bg-slate-900 accent-indigo-500 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              </Popup>
            </Marker>
 
            <Circle
              center={[userLocation.lat, userLocation.lon]}
              radius={nearMeRadius * 1000}
              interactive={false}
              pathOptions={{ 
                color: hasDisruptionInRadius ? '#f97316' : '#3b82f6', 
                fillColor: hasDisruptionInRadius ? '#f97316' : '#3b82f6', 
                fillOpacity: nearMeFilterActive ? 0.08 : 0.03,
                weight: nearMeFilterActive ? 1.5 : 0.8,
                dashArray: nearMeFilterActive ? '5, 5' : null
              }}
            >
              <Tooltip sticky>
                <div className="font-sans p-1 text-slate-100 font-semibold text-xs">
                  {hasDisruptionInRadius ? '🟠 Warning: Disruptions inside Search Radius' : '🔵 Search Radius geofence'} ({nearMeRadius} km)
                </div>
              </Tooltip>
            </Circle>
          </>
        )}

        {/* Route start pin (A) — shown only while a route is active */}
        {activeRoutePresent && userLocation && (
          <Marker
            position={[userLocation.lat, userLocation.lon]}
            icon={createStartPinIcon()}
            zIndexOffset={500}
          >
            <Tooltip direction="top" offset={[0, -14]}>
              <div className="font-sans p-1 text-slate-100 font-semibold text-xs">
                Start — Your Location
              </div>
            </Tooltip>
          </Marker>
        )}

        {/* Route destination pin (B) — one marker shared by safer/faster routes */}
        {activeRoutePresent && routePinDestination && (
          <Marker
            position={[routePinDestination.lat, routePinDestination.lon]}
            icon={createDestinationPinIcon()}
            zIndexOffset={500}
          >
            <Popup>
              <div className="font-sans p-2 text-slate-900 dark:text-slate-100 min-w-[190px] select-none">
                <div className="font-bold text-sm mb-1 text-slate-800 dark:text-slate-200">
                  {routePinDestination.name}
                </div>
                {routePinDestination.address && (
                  <div className="text-xs text-slate-500 mb-1.5">{routePinDestination.address}</div>
                )}
                {Number.isFinite(routeDestination?.distanceKm) && (
                  <div className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 border-t border-slate-200 dark:border-slate-800 pt-1.5">
                    ~{routeDestination.distanceKm} km to destination
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        )}

        {/* Render geofenced zones */}
        {predictions.length > 0 && (() => {
          // Deduplicate by zone_id + disruption_type — keeps the highest probability entry.
          // Guards against duplicate OPEN alerts from the worker before the DB is cleaned up.
          const seen = new Map();
          predictions.forEach(pred => {
            const key = `${pred.zone?.id ?? pred.zone?.zone_id}_${pred.disruption_type}`;
            const existing = seen.get(key);
            if (!existing || (pred.probability_percentage ?? 0) > (existing.probability_percentage ?? 0)) {
              seen.set(key, pred);
            }
          });
          const dedupedPredictions = Array.from(seen.values());
          return dedupedPredictions;
        })().map(pred => {
          const zone = pred.zone;
          const coords = invertCoords(zone.geometry);
          const isSelected = selectedZone && selectedZone.zone.id === zone.id;
          
          if (coords.length === 0) return null;
 
          // Gate by threat layer filter checkboxes
          const disruptionToLayer = {
            traffic: 'threat_traffic', weather: 'threat_weather', crowd: 'threat_crowd',
            earthquake: 'threat_earthquake', waterway: 'threat_waterway', flood: 'threat_waterway',
          };
          // Snapshot allOff at render time — avoids stale closure from toggle cycles.
          // Check allOff FIRST so deselecting all always hides every zone regardless
          // of per-layer state (fixes the ghost-circle bug on repeated toggle cycles).
          const allOff = !Object.values(disruptionToLayer).some(id => activeLayers[id]);
          if (allOff) return null;
          const dtype = (pred.disruption_type || '').toLowerCase().trim();
          const layerId = disruptionToLayer[dtype];
          if (layerId && !activeLayers[layerId]) return null;
 
          const { center, radius } = getCircleParams(coords);
          const riskStyle = getStyleForRisk(pred.risk_level);
          
          // Compute if inside proximity filter
          let isOutOfRadius = false;
          let distanceStr = '';
          if (nearMeFilterActive && userLocation) {
            const distance = calculateDistanceKm(userLocation.lat, userLocation.lon, center[0], center[1]);
            if (distance > nearMeRadius) {
              isOutOfRadius = true;
            } else {
              distanceStr = `${distance.toFixed(1)} km`;
            }
          }
 
          // Modify path styling if out of radius or selected
          let pathOptions = riskStyle;
          if (isOutOfRadius) {
            pathOptions = {
              ...riskStyle,
              fillOpacity: 0.01,
              opacity: 0.04,
              weight: 0.5,
              className: 'transition-all duration-300'
            };
          } else if (isSelected) {
            pathOptions = { ...riskStyle, weight: 5, fillOpacity: 1, opacity: 0.20, dashArray: '6, 6' };
          }
 
          return (
            <Circle
              key={`${zone.id}_${pred.disruption_type}_${isOutOfRadius ? 'out' : 'in'}`}
              center={center}
              radius={radius}
              pathOptions={pathOptions}
              interactive={!isOutOfRadius}
              eventHandlers={{
                click: () => !isOutOfRadius && onSelectZone(pred),
                touchend: () => !isOutOfRadius && onSelectZone(pred),
              }}
            >
              <Tooltip sticky>
                <div className="font-sans p-1 text-slate-100">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-sm">{zone.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      pred.risk_level === 'Critical' ? 'bg-red-500/20 text-red-400' :
                      pred.risk_level === 'High' ? 'bg-orange-500/20 text-orange-400' :
                      pred.risk_level === 'Medium' ? (isLight ? 'bg-yellow-500/20 text-yellow-700' : 'bg-yellow-500/20 text-yellow-300') :
                      'bg-emerald-500/20 text-emerald-400'
                    }`}>
                      {pred.risk_level}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-300 mt-1">
                    {pred.disruption_type}
                  </div>
                  {pred.estimated_resolution_at && (
                    <div className="mt-1.5 pt-1.5 border-t border-slate-700/40">
                      <ResolutionBadgeCompact
                        estimated_resolution_at={pred.estimated_resolution_at}
                        resolution_confidence={pred.resolution_confidence}
                        theme={theme}
                      />
                    </div>
                  )}
                  {distanceStr && (
                    <div className="text-[10px] text-indigo-300 font-bold border-t border-slate-700/40 pt-1 mt-1">
                      📍 {distanceStr} away from you
                    </div>
                  )}
                </div>
              </Tooltip>
            </Circle>
          );
        })}
 
        {/* Render threat zone circles — one circle per ACTIVE threat type per zone.
             Unchecking "Traffic" removes only traffic circles. Checking only "Flood"
             shows only flood/waterway circles. Zones with no active types are hidden. */}
        {(() => {
          const threatLayerMap = {
            traffic: 'threat_traffic', weather: 'threat_weather',
            crowd: 'threat_crowd', earthquake: 'threat_earthquake', waterway: 'threat_waterway',
          };
          const DIM_COLORS = {
            traffic: '#f97316', weather: '#3b82f6', crowd: '#eab308',
            earthquake: '#ef4444', waterway: '#06b6d4',
          };
          const dimOrder = ['traffic','weather','crowd','earthquake','waterway'];
          const circles = [];

          allZones
            .filter(zs => !predictions.some(p => p.zone?.zone_id === zs.zone_id || p.zone?.id === zs.zone_id))
            .forEach(zs => {
              const zone = zs.zone;
              if (!zone || !zone.geometry) return;
              const coords = invertCoords(zone.geometry);
              if (coords.length === 0) return;
              const { center, radius } = getCircleParams(coords);

              const dimScores = {
                traffic: zs.traffic_score || 0, weather: zs.weather_score || 0,
                crowd: zs.crowd_score || 0, earthquake: zs.earthquake_score || 0,
                waterway: zs.waterway_score || 0,
              };
              const matchedPredsByDim = {};
              for (const p of predictions) {
                const pZoneId = p.zone?.zone_id ?? p.zone?.id;
                if (pZoneId === zone.zone_id && p.disruption_type) {
                  matchedPredsByDim[p.disruption_type.toLowerCase()] = p;
                }
              }
              const isSelected = !!(selectedZone && (selectedZone.zone?.id === zone.zone_id || selectedZone.zone?.zone_id === zone.zone_id));

              let isOutOfRadius = false, distanceStr = '';
              if (nearMeFilterActive && userLocation) {
                const d = calculateDistanceKm(userLocation.lat, userLocation.lon, center[0], center[1]);
                if (d > nearMeRadius) isOutOfRadius = true;
                else distanceStr = `${d.toFixed(1)} km`;
              }

              const openDims = new Set(zs.open_threat_dims || []);

              dimOrder.forEach((dim, idx) => {
                const score = dimScores[dim];
                if (!activeLayers[threatLayerMap[dim]]) return;
                // OPEN alert → draw full threat circle.
                // No OPEN alert on this dim → draw faint green LOW indicator
                // (only on traffic dim to avoid stacking circles per zone).
                if (!openDims.has(dim)) {
                  if (dim !== 'traffic') return;
                  if (score < 5) return;
                  circles.push(
                    <Circle
                      key={`${zone.zone_id}-low`}
                      center={center} radius={radius}
                      pathOptions={{ fillColor: '#00E676', color: '#00E676', weight: 1.5, opacity: 0.2, fillOpacity: 0.03 }}
                      interactive={false}
                    />
                  );
                  return;
                }
                // Show any zone with a real OPEN alert, even LOW severity (score > 0).
                // Previously filtered score < 10, which silently hid genuine LOW alerts
                // that the database marked OPEN — misleading since "no circle" looked
                // identical to "no alert at all".
                if (score <= 0) return;

                const riskKey = score >= 65 ? 'High' : score >= 35 ? 'Medium' : 'Low';
                const color = DIM_COLORS[dim];
                const r = radius * (1 - idx * 0.03);

                let po = {
                  fillColor: color, color,
                  weight: score >= 65 ? 3.0 : score >= 35 ? 2.5 : 2.0,
                  opacity: score >= 65 ? 0.55 : score >= 35 ? 0.35 : 0.15,
                  fillOpacity: score >= 65 ? 0.20 : score >= 35 ? 0.10 : 0.04,
                  className: score >= 65 ? 'animate-pulse' : '',
                };
                if (isOutOfRadius) {
                  po = { ...po, fillOpacity: 0.01, opacity: 0.04, weight: 0.5, className: '' };
                } else if (isSelected) {
                  po = { ...po, weight: 4, fillOpacity: 0.30, opacity: 0.8, dashArray: '6,6' };
                }

                circles.push(
                  <Circle
                    key={`${zone.zone_id}-${dim}-${isOutOfRadius ? 'out' : 'in'}`}
                    center={center} radius={r} pathOptions={po}
                    interactive={!isOutOfRadius}
                    eventHandlers={{
                      click: () => {
                        if (isOutOfRadius) return;
                        matchedPredsByDim[dim]
                          ? onSelectZone(matchedPredsByDim[dim])
                          : onSelectZone({ zone: { ...zone, id: zone.zone_id }, risk_level: riskKey, disruption_type: dim, probability_percentage: score });
                      },
                      touchend: () => {
                        if (isOutOfRadius) return;
                        matchedPredsByDim[dim]
                          ? onSelectZone(matchedPredsByDim[dim])
                          : onSelectZone({ zone: { ...zone, id: zone.zone_id }, risk_level: riskKey, disruption_type: dim, probability_percentage: score });
                      },
                    }}
                  >
                    <Tooltip sticky>
                      <div className="font-sans p-1 text-slate-100">
                        <div className="flex items-center space-x-2 mb-0.5">
                          <span className="font-bold text-sm">{zone.name}</span>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold capitalize"
                            style={{ background: `${color}25`, color }}>{dim} · {riskKey}</span>
                        </div>
                        <div className="text-[11px] text-slate-300">
                          Score: <span className="font-semibold text-slate-100">{score.toFixed(1)}/100</span>
                        </div>
                        <div className="text-[11px] text-slate-400 mt-1 space-y-0.5">
                          {dimOrder.map(d => {
                            const s = dimScores[d];
                            return s >= 25 && activeLayers[threatLayerMap[d]] ? (
                              <div key={d} className="flex justify-between gap-3">
                                <span className="capitalize" style={{ color: DIM_COLORS[d] }}>{d}</span>
                                <span className={s >= 65 ? 'text-red-400 font-bold' : s >= 35 ? 'text-yellow-400' : 'text-emerald-400'}>{s.toFixed(1)}</span>
                              </div>
                            ) : null;
                          })}
                        </div>
                        {distanceStr && (
                          <div className="text-[10px] text-indigo-300 font-bold border-t border-slate-700/40 pt-1 mt-1">
                            📍 {distanceStr} away from you
                          </div>
                        )}
                      </div>
                    </Tooltip>
                  </Circle>
                );
              });
            });
          return circles;
        })()}
 
        {/* Render Earthquakes if active */}
        {activeLayers.earthquakes && earthquakes.map((eq, idx) => {
          const latLng = getEarthquakeLatLng(eq);
          if (!latLng) return null;
          const isMajor = eq.magnitude >= 6.0;
          const threatColor = isMajor ? '#EF4444' : '#F97316';
          return (
            <Circle
              key={`eq-${eq.id || eq.event_id || idx}`}
              center={latLng}
              radius={getEarthquakeImpactRadiusMeters(eq)}
              pathOptions={{
                color: threatColor,
                fillColor: threatColor,
                weight: 2,
                opacity: 0.8,
                fillOpacity: 0.2,
                className: 'animate-pulse'
              }}
            >
              <Popup>
                <div className="font-sans p-2.5 !text-slate-900 dark:!text-slate-100 min-w-[200px]">
                  <div className="flex items-center justify-between mb-1.5 border-b border-slate-200 dark:border-slate-800 pb-1.5">
                    <span className="font-bold text-sm text-slate-900 dark:text-slate-100">🚨 Earthquake Warning</span>
                    <span className={`text-[10px] font-extrabold uppercase px-1.5 py-0.5 rounded ${
                      isMajor ? 'bg-red-500/20 text-red-400' : 'bg-orange-500/20 text-orange-400'
                    }`}>
                      M {eq.magnitude.toFixed(1)}
                    </span>
                  </div>
                  <div className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
                    <div>
                      <span className="text-slate-500">Location:</span> <span className="font-semibold">{eq.wilayah}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Depth:</span>
                      <span className="font-semibold">{eq.depth}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Potential:</span>
                      <span className="font-bold text-indigo-500 dark:text-indigo-400">{eq.potensi || 'Tidak berpotensi tsunami'}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-200 dark:border-slate-800 pt-1 mt-1 text-[10px] text-slate-400">
                      <span>Occurred:</span>
                      <span>{formatEarthquakeWhen(eq.datetime)}</span>
                    </div>
                  </div>
                </div>
              </Popup>
            </Circle>
          );
        })}
 
        {/* Render dynamic Waterways safety buffer layer beneath the actual waterways */}
        <WaterwayBufferLayer
          waterways={waterways}
          waterwayThreshold={waterwayThreshold}
          waterwayBuffer={waterwayBuffer}
          activeLayers={activeLayers}
        />
 
        {/* Render dynamic Waterways layers (Rivers, Canals, creeks) */}
        {activeLayers.waterways && waterways.map((waterway, idx) => {
          const positions =
           typeof waterway.coordinates === "string"
            ? JSON.parse(waterway.coordinates)
            : waterway.coordinates;
          const leafletPositions = positions.map(([lon, lat]) => [lat, lon]);
          return (
          <Polyline
            key={`${waterway.name}-${idx}`}
            positions={leafletPositions}
            pathOptions={getWaterwayStyle(waterway.category, waterway.alert_level)}
          >
            <Popup>
              <div className="font-sans p-2.5 !text-slate-900 dark:!text-slate-100 min-w-[200px]">
                <div className="flex items-center justify-between mb-1.5 border-b border-slate-200 dark:border-slate-800 pb-1.5">
                  <span className="font-bold text-sm text-slate-900 dark:text-slate-100">{waterway.name}</span>
                  <span className={`text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${
                    waterway.alert_level === 'Siaga 1' ? 'bg-red-500/20 text-red-400' :
                    waterway.alert_level === 'Siaga 2' ? 'bg-red-400/20 text-red-400' :
                    waterway.alert_level === 'Siaga 3' ? 'bg-orange-500/20 text-orange-400' :
                    waterway.alert_level === 'Siaga 4' ? 'bg-amber-500/20 text-amber-400' :
                    'bg-sky-500/20 text-sky-400'
                  }`}>
                    {waterway.alert_level}
                  </span>
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Classification:</span>
                    <span className="font-semibold capitalize text-slate-700 dark:text-slate-300">{waterway.category}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Current Level:</span>
                    <span className="font-bold text-indigo-500 dark:text-indigo-400">{waterway.current_level} cm</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Max Capacity:</span>
                    <span className="font-semibold text-slate-700 dark:text-slate-300">{waterway.max_capacity} cm</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                    <div className="flex justify-between text-[10px] mb-1 font-semibold text-slate-400">
                      <span>Water Vol Capacity Used:</span>
                      <span className={waterway.capacity_percentage > 85 ? 'text-red-400 animate-pulse' : 'text-slate-600 dark:text-slate-300'}>
                        {waterway.capacity_percentage}%
                      </span>
                    </div>
                    {/* Visual Progress Bar */}
                    <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${
                          waterway.capacity_percentage > 85 ? 'bg-red-500' :
                          waterway.capacity_percentage > 70 ? 'bg-orange-500' : 'bg-sky-500'
                        }`}
                        style={{ width: `${Math.min(100, waterway.capacity_percentage)}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
              </div>
            </Popup>
          </Polyline>
          );
        })}
 
        {/* Render POIs inside selected zone (Only if they aren't already globally displayed) */}
        {!selectedZone?.zone?.pois?.some(poi => activeLayers[poi.category]) && selectedZone?.zone?.pois?.map((poi, idx) => (
          <Marker
            key={`selected-${poi.name}-${idx}`}
            position={[poi.lat, poi.lon]}
            icon={createPoiIcon(poi.category, false)}
          >
            <Popup>
              <div className="font-sans p-2 text-slate-100 min-w-[190px]">
                <div className="flex items-center space-x-1.5 mb-1.5">
                  <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{poi.name}</span>
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-400 capitalize flex items-center space-x-1">
                  <span>Category:</span>
                  <span className="font-semibold text-indigo-500 dark:text-indigo-400">{poi.category.replace('_', ' ')}</span>
                </div>

                {/* Disruption suitability for zone POIs */}
                {POI_DISRUPTION_SUITABILITY[poi.category] && (
                  <div className="mt-1.5 pt-1.5 border-t border-slate-200 dark:border-slate-800">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide mb-1">
                      Safe refuge during:
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {POI_DISRUPTION_SUITABILITY[poi.category].disruptions.map(d => (
                        <span key={d} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                          {DISRUPTION_EMOJI[d] || '⚠️'} {d}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5 border-t border-slate-200 dark:border-slate-800 pt-1.5">
                  Latitude: {poi.lat.toFixed(4)}<br/>
                  Longitude: {poi.lon.toFixed(4)}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
        {/* Render Safe Zones */}
        {hasActiveDisruptions && 
         activeLayers.safe_zones &&
         filteredSafeZones.map(zone => {
           const type = zone.type || (zone.category === 'evacuation_point' ? 'Evacuation Point' : zone.category === 'high_ground' ? 'High Ground' : 'Safe Zone');
           // capacity intentionally removed — not shown in popup
           const details = zone.details || (zone.category === 'evacuation_point' ? 'Equipped with emergency medical kits, power back-up, and shelter supplies.' : 'Designated high ground assembly area above flood levels.');
           return (
            <Marker
              key={zone.id || zone.poi_id}
              position={[zone.latitude, zone.longitude]}
              icon={createSafeZoneIcon(type)}
            >
              <Popup>
                <div className="font-sans min-w-[220px] p-2.5 text-slate-900 dark:text-slate-100">
                  <div className="font-bold text-sm !text-black dark:!text-slate-100 mb-0.5">{zone.name}</div>
                  <div className="text-emerald-600 dark:text-emerald-400 text-xs font-semibold mb-2">
                    {POI_DISRUPTION_SUITABILITY[zone.category]?.emoji || '🛡️'} {type}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-400 mb-2">{details}</div>
                  {POI_DISRUPTION_SUITABILITY[zone.category] && (
                    <div>
                      <div className="text-[10px] text-slate-700 dark:text-slate-400 font-semibold uppercase tracking-wide mb-1">
                        Recommended during:
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {POI_DISRUPTION_SUITABILITY[zone.category].disruptions.map(d => (
                          <span key={d} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                            {DISRUPTION_EMOJI[d] || '⚠️'} {d}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {typeof zone.crowd_score === 'number' && (
                    <div className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-700">
                      <div className="flex items-center justify-between text-[10px] mb-1">
                        <span className="text-slate-700 dark:text-slate-400 font-semibold">👥 Current Crowd</span>
                        <span className={`font-bold ${zone.crowd_score >= 65 ? 'text-red-400' : zone.crowd_score >= 35 ? 'text-orange-400' : 'text-emerald-400'}`}>
                          {zone.crowd_score >= 65 ? 'High' : zone.crowd_score >= 35 ? 'Moderate' : 'Low'}
                          <span className="ml-1 opacity-70 font-normal">({Math.round(zone.crowd_score)}/100)</span>
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${zone.crowd_score >= 65 ? 'bg-red-500' : zone.crowd_score >= 35 ? 'bg-orange-400' : 'bg-emerald-400'}`}
                          style={{ width: `${Math.min(100, zone.crowd_score)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
           );
         })}
 
        {/* Render Global POIs based on checkbox toggles */}
        {poisToRender.map((poi, idx) => (
          <Marker
            key={`global-${poi.name}-${idx}`}
            position={[poi.lat, poi.lon]}
            icon={createPoiIcon(poi.category, poi.is_suppressed, poi.crowd_score || 0)}
          >
            <Popup>
              <div className="font-sans p-2 text-slate-100 min-w-[190px]">
                <div className="flex items-center space-x-1.5 mb-1">
                  <span className="text-sm font-bold text-slate-900 dark:text-slate-100">{poi.name}</span>
                  {poi.is_suppressed && (
                    <span className="text-[8px] bg-red-500/20 text-red-400 border border-red-500/30 px-1 py-0.5 rounded uppercase font-extrabold tracking-wider">
                      Suppressed
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-400 capitalize flex items-center space-x-1">
                  <span>Category:</span>
                  <span className="font-semibold text-indigo-500 dark:text-indigo-400">{poi.category.replace('_', ' ')}</span>
                </div>

                {/* Disruption suitability */}
                {POI_DISRUPTION_SUITABILITY[poi.category] && (
                  <div className="mt-1.5 pt-1.5 border-t border-slate-200 dark:border-slate-800">
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide mb-1">
                      Recommended during:
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {POI_DISRUPTION_SUITABILITY[poi.category].disruptions.map(d => (
                        <span key={d} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                          {DISRUPTION_EMOJI[d] || '⚠️'} {d}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {typeof poi.crowd_score === 'number' && (
                  <div className="mt-1.5 pt-1.5 border-t border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-500 dark:text-slate-400 font-semibold">👥 Crowd Level:</span>
                      <span className={`font-bold ${poi.crowd_score >= 65 ? 'text-red-400' : poi.crowd_score >= 35 ? 'text-orange-400' : 'text-emerald-400'}`}>
                        {poi.crowd_score >= 65 ? 'High' : poi.crowd_score >= 35 ? 'Moderate' : 'Low'}
                        <span className="ml-1 opacity-70 font-normal">({Math.round(poi.crowd_score)}/100)</span>
                      </span>
                    </div>
                    <div className="mt-1 w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${poi.crowd_score >= 65 ? 'bg-red-500' : poi.crowd_score >= 35 ? 'bg-orange-400' : 'bg-emerald-400'}`}
                        style={{ width: `${Math.min(100, poi.crowd_score)}%` }}
                      ></div>
                    </div>
                  </div>
                )}
                <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5 border-t border-slate-200 dark:border-slate-800 pt-1.5">
                  Status: <span className={poi.is_suppressed ? 'text-rose-400' : 'text-emerald-400'}>
                    {poi.is_suppressed ? 'Priority-Suppressed (Ignored in Zoning)' : 'Active Zoning POI'}
                  </span><br/>
                  Latitude: {poi.lat.toFixed(4)}<br/>
                  Longitude: {poi.lon.toFixed(4)}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
 
 
        {/* Auto-fit map to evacuation route when route is ready */}
        <RouteController
          evacuationRoute={evacuationRoute}
          navigateSaferRoute={navigateSaferRoute}
          navigateFasterRoute={navigateFasterRoute}
          fitPadding={routeFitPadding}
        />

        {/* Fix Leaflet container size on mobile */}
        <MapSizeInvalidator selectedEarthquake={selectedEarthquake} isMobile={isMobile} />

        {/* Listen for selected zone changes and reposition camera */}
        <MapController
          selectedZone={selectedZone?.zone}
          selectedEarthquake={selectedEarthquake}
          mapVisible={mapVisible}
          isMobile={isMobile}
          earthquakeFitPadding={routeFitPadding}
          disableZoneAutoZoom={activeRoutePresent}
        />
        <UserLocationController
          userLocation={userLocation}
          nearMeRadius={nearMeRadius}
          enabled={!evacuationRoute && nearMeFilterActive}
          selectedEarthquake={selectedEarthquake}
        />
 
        {/* Map click listener to dismiss selection */}
        <MapClickListener onClearSelectedEarthquake={onClearSelectedEarthquake} />
 
        {/* Focus Popup for inspected earthquake */}
        {selectedEarthquake && getEarthquakeLatLng(selectedEarthquake) && (
          <Popup position={getEarthquakeLatLng(selectedEarthquake)} autoClose={false} closeOnClick={false}>
            <div className="font-sans p-2.5 !text-slate-900 dark:!text-slate-100 min-w-[200px]">
              <div className="flex items-center justify-between mb-1.5 border-b border-slate-200 dark:border-slate-800 pb-1.5">
                <span className="font-bold text-sm text-slate-900 dark:text-slate-100">🚨 Earthquake Focus</span>
                <span className="text-[10px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
                  M {selectedEarthquake.magnitude.toFixed(1)}
                </span>
              </div>
              <div className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
                <div>
                  <span className="text-slate-500">Location:</span> <span className="font-semibold">{selectedEarthquake.wilayah}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Depth:</span>
                  <span className="font-semibold">{selectedEarthquake.depth}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Potential:</span>
                  <span className="font-bold text-indigo-500 dark:text-indigo-400">{selectedEarthquake.potensi || 'Tidak berpotensi tsunami'}</span>
                </div>
              </div>
            </div>
          </Popup>
        )}

                {/* Evacuation route — dashed indigo polyline drawn on the map */}
        {evacuationRoute && (() => {
          const coords = evacuationRoute.geometry?.coordinates ?? [];
          if (coords.length < 2) return null;
          const positions = coords.map(([lon, lat]) => [lat, lon]);
          return (
            <Polyline
              positions={positions}
              pathOptions={{
                color: '#6366f1',
                weight: 5,
                opacity: 0.9,
                dashArray: '12, 7',
                lineCap: 'round',
              }}
            />
          );
        })()}

        {navigateFasterRoute && (() => {
          const coords = navigateFasterRoute.coordinates ?? [];
          if (coords.length < 2) return null;
          const selected = selectedNavigateRoute === 'faster';
          return (
            <Polyline
              positions={coords.map(([lon, lat]) => [lat, lon])}
              pathOptions={{
                color: '#f97316',
                weight: selected ? 6 : 4,
                opacity: selected ? 0.95 : 0.45,
                lineCap: 'round',
              }}
            />
          );
        })()}
        {navigateSaferRoute && (() => {
          const coords = navigateSaferRoute.coordinates ?? [];
          if (coords.length < 2) return null;
          const selected = selectedNavigateRoute === 'safer';
          return (
            <Polyline
              positions={coords.map(([lon, lat]) => [lat, lon])}
              pathOptions={{
                color: '#22c55e',
                weight: selected ? 6 : 4,
                opacity: selected ? 0.95 : 0.5,
                dashArray: '10, 6',
                lineCap: 'round',
              }}
            />
          );
        })()}

        {/* Global all-clear: no disruptions anywhere */}
        {predictions.length === 0 && allZones.length === 0 && (
          <div className="absolute bottom-6 left-6 z-[1000]">
            <div className="glass-panel rounded-xl px-4 py-3 border border-emerald-500/20 bg-emerald-500/10 backdrop-blur-md">
              <div className="flex items-center gap-2">
                <span className="text-xl">✅</span>
                <div>
                  <div className="font-bold text-emerald-400">All Clear</div>
                  <div className="text-xs text-slate-300">No active disruptions detected in Jabodetabek</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Personal all-clear: user has location active, there ARE disruptions globally
            but none within their search radius */}
        {userLocation && nearMeFilterActive && predictions.length > 0 && !hasDisruptionInRadius && (
          <div className="absolute bottom-6 left-6 z-[1000] animate-fade-in">
            <div className="glass-panel rounded-xl px-4 py-3 border border-emerald-500/30 bg-emerald-500/10 backdrop-blur-md max-w-[260px]">
              <div className="flex items-start gap-2.5">
                <span className="text-2xl mt-0.5">✅</span>
                <div>
                  <div className="font-bold text-emerald-400 text-sm">You&apos;re in the clear</div>
                  <div className="text-xs text-slate-300 mt-0.5 leading-relaxed">
                    No active disruptions within <span className={`font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`}>{nearMeRadius} km</span> of your location.
                    Active disruptions exist elsewhere in Jabodetabek — stay informed.
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </MapContainer>
    </div>
  );
}
