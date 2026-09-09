import { useEffect, useRef } from 'react';
import { usePageVisible } from './usePageVisible';

/**
 * Interval polling that pauses when the tab is hidden (Page Visibility API).
 * Runs callback once when activated, then on each tick; catch-up refetch on resume.
 */
export function useVisibilityAwareInterval(callback, intervalMs, options = {}) {
  const {
    enabled = true,
    pauseWhenHidden = true,
  } = options;

  const visible = usePageVisible();
  const callbackRef = useRef(callback);
  const prevVisibleRef = useRef(visible);

  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return undefined;

    const active = !pauseWhenHidden || visible;
    const becameVisible = visible && prevVisibleRef.current === false;
    prevVisibleRef.current = visible;

    const tick = () => callbackRef.current();
    let intervalId = null;

    const stop = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const start = () => {
      stop();
      intervalId = setInterval(tick, intervalMs);
    };

    if (import.meta.env.DEV) {
      console.debug('[poll]', {
        visible,
        pauseWhenHidden,
        active,
        action: active ? (becameVisible ? 'resume' : 'start') : 'pause',
      });
    }

    if (active) {
      tick();
      start();
    } else {
      stop();
    }

    return stop;
  }, [enabled, intervalMs, pauseWhenHidden, visible]);
}
