import { useState, useEffect, useCallback } from 'react';
import { getApiUrl } from '../utils/getApiUrl';

const API_URL = getApiUrl();

export function usePredictions({ intervalMs = 30000 } = {}) {
  const [predictions, setPredictions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFallback, setIsFallback] = useState(false);

  const fetchActivePredictions = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/predictions/active`);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      const data = await response.json();

      // Normalize new schema field names to what the rest of the app expects
      const normalized = data.map(a => ({
        id: a.alert_id,
        disruption_type: a.disruption_type,
        probability_percentage: a.probability_percentage,
        estimated_time_to_peak: a.estimated_time_to_peak,
        estimated_resolution_at: a.estimated_resolution_at,
        resolution_confidence: a.resolution_confidence,
        risk_level: a.severity ? (a.severity.charAt(0).toUpperCase() + a.severity.slice(1).toLowerCase()) : 'Low',
        created_at: a.alert_timestamp,
        zone: {
          ...a.zone,
          id: a.zone?.zone_id,
        },
      }));

      // If backend is healthy but has no active alerts → show All Clear (empty array)
      // Do NOT fall back to mock data — that caused the ghost zones
      setPredictions(normalized);
      setIsFallback(false);
      setError(null);
    } catch (err) {
      // Only use empty array on error — no mock fallback that pollutes the map
      console.warn('[usePredictions] Fetch failed:', err.message);
      setError(err.message);
      setPredictions([]);
      setIsFallback(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActivePredictions();
    const intervalId = setInterval(fetchActivePredictions, intervalMs);
    return () => clearInterval(intervalId);
  }, [fetchActivePredictions, intervalMs]);

  return { predictions, loading, error, isFallback, refresh: fetchActivePredictions };
}
