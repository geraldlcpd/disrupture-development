import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Shield, Zap } from 'lucide-react';
import { buildRouteIndex } from '../utils/routeGeometry.js';
import { findNearbyDisruptionsAlongRoute } from '../utils/nearbyDisruptionAlongRoute.js';
import { formatDistanceM, formatEtaClock } from '../utils/navUi.js';

const SWIPE_THRESHOLD_PX = 36;

function zoneCount(route, predictions, distanceAlongM) {
  const coords = route?.geometry?.coordinates ?? [];
  if (coords.length < 2) return 0;
  const index = buildRouteIndex(coords);
  return findNearbyDisruptionsAlongRoute({
    predictions,
    routeIndex: index,
    distanceAlongM: distanceAlongM ?? 0,
  }).length;
}

function variantAvoidsPrediction(route, prediction, distanceAlongM) {
  if (!route || !prediction) return false;
  const coords = route.geometry?.coordinates ?? [];
  if (coords.length < 2) return true;
  const index = buildRouteIndex(coords);
  const hits = findNearbyDisruptionsAlongRoute({
    predictions: [prediction],
    routeIndex: index,
    distanceAlongM: distanceAlongM ?? 0,
  });
  return hits.length === 0;
}

function eventClientY(event) {
  if (event.touches?.[0]) return event.touches[0].clientY;
  if (event.changedTouches?.[0]) return event.changedTouches[0].clientY;
  return event.clientY;
}

export default function NavigationFooter({
  session,
  predictions = [],
  theme = 'light',
  isMobile = true,
  follow = true,
  onRecenter,
  onSwitchVariant,
  switchingKey = null,
  promptedZoneIds,
}) {
  const isLight = theme === 'light';
  const [expanded, setExpanded] = useState(!isMobile);
  const dragRef = useRef({
    active: false,
    startY: 0,
    lastY: 0,
    pointerId: null,
  });
  const grabRef = useRef(null);
  const panel = isLight
    ? 'bg-white/95 border-slate-200 text-slate-900'
    : 'bg-slate-950/95 border-slate-700 text-white';

  useEffect(() => {
    if (!isMobile) setExpanded(true);
  }, [isMobile]);

  const finishDrag = (clientY) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    const dy = drag.startY - clientY;
    drag.active = false;
    drag.pointerId = null;
    if (dy > SWIPE_THRESHOLD_PX) {
      setExpanded(true);
      return;
    }
    if (dy < -SWIPE_THRESHOLD_PX) {
      setExpanded(false);
      return;
    }
    if (Math.abs(dy) < 10) {
      setExpanded((open) => !open);
    }
  };

  const onGrabPointerDown = (event) => {
    if (event.target.closest('[data-nav-no-drag]')) return;
    dragRef.current = {
      active: true,
      startY: event.clientY,
      lastY: event.clientY,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onGrabPointerMove = (event) => {
    if (!dragRef.current.active) return;
    dragRef.current.lastY = event.clientY;
  };

  const onGrabPointerUp = (event) => {
    finishDrag(event.clientY);
  };

  const onGrabTouchStart = (event) => {
    if (event.target.closest('[data-nav-no-drag]')) return;
    const y = eventClientY(event);
    dragRef.current = { active: true, startY: y, lastY: y, pointerId: null };
  };

  const onGrabTouchMove = (event) => {
    if (!dragRef.current.active) return;
    dragRef.current.lastY = eventClientY(event);
    event.preventDefault();
  };

  const onGrabTouchEnd = (event) => {
    finishDrag(eventClientY(event));
  };

  const activeKey = session?.activeKey || 'safer';
  const otherKey = activeKey === 'safer' ? 'faster' : 'safer';
  const nearby = session?.nearbyDisruption;
  const otherRoute = session?.routes?.[otherKey]?.route;
  const risk = nearby?.prediction?.risk_level;
  const showAvoid = Boolean(
    nearby
    && (risk === 'High' || risk === 'Critical')
    && otherRoute
    && variantAvoidsPrediction(otherRoute, nearby.prediction, session?.distanceAlongM)
    && !promptedZoneIds?.has(nearby.prediction?.id)
  );

  const rows = useMemo(() => {
    if (!session) return [];
    return ['safer', 'faster'].map((key) => {
      const entry = session.routes?.[key];
      const route = entry?.route;
      if (!route) return null;
      const count = zoneCount(route, predictions, session.distanceAlongM);
      const deltaMin = route.durationMin - (session.remainingDurationMin || route.durationMin);
      return {
        key,
        route,
        stale: entry.stale,
        count,
        deltaMin,
        active: key === activeKey,
      };
    }).filter(Boolean);
  }, [session, predictions, activeKey]);

  const routesInnerRef = useRef(null);
  const [routesBlockHeight, setRoutesBlockHeight] = useState(0);

  useEffect(() => {
    if (!expanded) {
      setRoutesBlockHeight(0);
      return undefined;
    }
    const measure = () => {
      const h = routesInnerRef.current?.scrollHeight ?? 0;
      if (h > 0) setRoutesBlockHeight(h);
    };
    measure();
    const t = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(t);
  }, [expanded, rows.length, switchingKey, session?.activeKey]);

  return (
    <div className="pointer-events-auto shrink-0">
      {showAvoid && (
        <div className={`mx-3 mb-2 rounded-xl border px-3 py-2 shadow-lg flex items-center gap-2 ${
          isLight ? 'bg-white border-orange-200 text-slate-900' : 'bg-slate-900 border-orange-500/40 text-white'
        }`}>
          <p className="min-w-0 flex-1 text-xs font-semibold">
            {nearby.prediction?.zone?.name || 'Disruption'} in {formatDistanceM(nearby.aheadM)} — switch to {otherKey === 'safer' ? 'Safer' : 'Faster'}?
          </p>
          <button
            type="button"
            onClick={() => onSwitchVariant?.(otherKey, nearby.prediction?.id)}
            className="shrink-0 min-h-[44px] rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white"
          >
            Avoid it
          </button>
        </div>
      )}

      <div
        className={`rounded-t-2xl border-t shadow-lg ${panel}`}
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}
      >
        <div
          ref={grabRef}
          className="touch-none select-none"
          style={{ touchAction: 'none' }}
          onPointerDown={onGrabPointerDown}
          onPointerMove={onGrabPointerMove}
          onPointerUp={onGrabPointerUp}
          onPointerCancel={onGrabPointerUp}
          onTouchStart={onGrabTouchStart}
          onTouchMove={onGrabTouchMove}
          onTouchEnd={onGrabTouchEnd}
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse route options' : 'Expand route options'}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setExpanded((open) => !open);
            }
          }}
        >
          <div className="flex justify-center pt-2 pb-1">
            <span className="block h-1.5 w-12 rounded-full bg-slate-400/70" />
          </div>
          <div className="flex items-center gap-3 px-4 pb-2 min-h-[48px]">
            <div className="min-w-0 flex-1">
              <p className="text-lg font-extrabold leading-none tabular-nums">
                {formatEtaClock(session?.etaClock)}
              </p>
              <p className={`text-[11px] font-semibold ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                {Math.max(0, session?.remainingDurationMin || 0)} min · {(session?.remainingDistanceKm ?? 0).toFixed(1)} km
              </p>
            </div>
            <span className={`text-[10px] font-bold uppercase tracking-wide ${activeKey === 'safer' ? 'text-emerald-500' : 'text-orange-400'}`}>
              {activeKey === 'safer' ? <Shield className="w-4 h-4 inline" /> : <Zap className="w-4 h-4 inline" />}
            </span>
            {!follow && (
              <button
                type="button"
                data-nav-no-drag
                onClick={(event) => {
                  event.stopPropagation();
                  onRecenter?.();
                }}
                className="min-h-[44px] rounded-full px-3 text-xs font-bold bg-indigo-600 text-white"
              >
                Recenter
              </button>
            )}
          </div>
        </div>

        <div
          className="overflow-hidden transition-[max-height] duration-300 ease-out"
          style={{ maxHeight: expanded ? Math.max(routesBlockHeight, rows.length * 92 + 16) : 0 }}
          aria-hidden={!expanded}
        >
          <div ref={routesInnerRef} className="px-3 pt-1 pb-3 space-y-2">
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                disabled={row.active || switchingKey === row.key}
                onClick={() => onSwitchVariant?.(row.key)}
                className={`w-full min-h-[52px] rounded-xl border px-3 py-2.5 text-left ${
                  row.active
                    ? row.key === 'safer'
                      ? 'border-emerald-500 bg-emerald-500/15'
                      : 'border-orange-500 bg-orange-500/15'
                    : isLight
                      ? 'border-slate-200 bg-white'
                      : 'border-slate-700 bg-slate-900'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold capitalize">{row.key}</span>
                  <span className="text-xs font-semibold">
                    {switchingKey === row.key ? 'Updating…' : `${row.route.durationMin} min · ${row.route.distanceKm} km`}
                  </span>
                </div>
                <p className={`text-[11px] mt-0.5 ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>
                  {row.stale ? 'May be outdated · tap to refresh. ' : ''}
                  {row.count === 0 ? 'Avoids disruption zones' : `Passes ${row.count} disruption zone${row.count === 1 ? '' : 's'}`}
                  {row.active ? '' : row.deltaMin !== 0 ? ` · ${row.deltaMin > 0 ? '+' : ''}${row.deltaMin} min vs current ETA` : ''}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
