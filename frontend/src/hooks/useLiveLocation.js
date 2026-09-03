import { useCallback, useEffect, useRef, useState } from 'react';
import { saveUserLocation } from '../utils/idbLocation.js';
import {
  acceptFix,
  geolocationToFix,
  shouldPersistLocation,
} from '../utils/liveLocation.js';

/**
 * Continuous GPS while a navigation session is active. Does nothing when enabled is false.
 */
export function useLiveLocation({ enabled = false, navigating = false, watch = true } = {}) {
  const [location, setLocation] = useState(null);
  const [error, setError] = useState(null);
  const prevRef = useRef(null);
  const persistAtRef = useRef(0);

  const ingestFix = useCallback((candidate) => {
    const result = acceptFix(prevRef.current, candidate, { navigating });
    if (!result.accepted) return;
    prevRef.current = result.fix;
    setLocation(result.fix);
    setError(null);
    const now = Date.now();
    if (shouldPersistLocation(persistAtRef.current, now)) {
      persistAtRef.current = now;
      saveUserLocation({
        lat: result.fix.lat,
        lng: result.fix.lon,
        timestamp: result.fix.timestamp,
      });
    }
  }, [navigating]);

  useEffect(() => {
    if (!enabled || !watch) {
      if (!enabled) {
        prevRef.current = null;
        setLocation(null);
        setError(null);
      }
      return undefined;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Geolocation is not supported.');
      return undefined;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => ingestFix(geolocationToFix(pos)),
      (err) => setError(err?.message || 'Unable to read location.'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [enabled, watch, ingestFix]);

  return { location, error, ingestFix };
}
