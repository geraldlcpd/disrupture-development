import React from 'react';
import { Bell, X } from 'lucide-react';

const TYPE_OPTIONS = [
  { id: 'traffic', label: 'Traffic' },
  { id: 'weather', label: 'Weather' },
  { id: 'flood', label: 'Flood / River' },
  { id: 'crowd', label: 'Crowd' },
  { id: 'earthquake', label: 'Earthquake' },
];

export default function NotificationPreferences({
  preferences,
  onToggleEnabled,
  onRadiusChange,
  onToggleType,
  onClose,
  isEmbedded = false,
  permissionStatus = 'default',
  message = '',
  messageTone = 'info',
  pushStatus = 'idle',
  pushStatusMessage = '',
  pushSubscriptionActive = false,
  previewPayload = null,
  previewLoading = false,
  theme = 'light',
}) {
  const { enabled, radiusKm, types } = preferences;
  const isDark = theme === 'dark';
  const selectedCount = Object.values(types).filter(Boolean).length;
  const permissionLabel = {
    granted: 'Browser notifications are enabled',
    denied: 'Browser notifications are blocked',
    default: 'Browser permission has not been requested yet',
    unsupported: 'This browser does not support notifications',
  }[permissionStatus] || 'Notification permission status unknown';

  const toneClasses = {
    success: isDark
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : 'border-emerald-600/20 bg-emerald-50 text-emerald-700',
    error: isDark
      ? 'border-red-500/30 bg-red-500/10 text-red-300'
      : 'border-red-600/20 bg-red-50 text-red-700',
    info: isDark
      ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
      : 'border-indigo-600/20 bg-indigo-50 text-indigo-700',
  }[messageTone] || (isDark
    ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300'
    : 'border-indigo-600/20 bg-indigo-50 text-indigo-700');

  const sectionCardClasses = isDark
    ? 'border-slate-800/70 bg-slate-900/70'
    : 'border-slate-200 bg-slate-50';
  const shellClasses = isDark
    ? 'border-slate-800/80 bg-slate-950/95 text-slate-100 shadow-2xl'
    : 'border-slate-200 bg-white/95 text-slate-900 shadow-xl';
  const dividerClasses = isDark ? 'border-slate-800/70' : 'border-slate-200';
  const mutedTextClasses = isDark ? 'text-slate-400' : 'text-slate-600';
  const subtleTextClasses = isDark ? 'text-slate-500' : 'text-slate-600';
  const headingTextClasses = isDark ? 'text-slate-100' : 'text-slate-900';
  const previewCardClasses = isDark
    ? 'border-indigo-500/20 bg-indigo-500/10'
    : 'border-indigo-200 bg-indigo-50';
  const previewTitleClasses = isDark ? 'text-indigo-200' : 'text-indigo-700';
  const previewMetaClasses = isDark ? 'text-slate-400' : 'text-slate-600';
  const previewBodyClasses = isDark ? 'text-slate-200' : 'text-slate-800';

  const pushStatusLabel = {
    active: 'Push subscription active',
    ready: 'Browser permission ready',
    idle: 'Push subscription not active yet',
    pending: 'Push setup pending',
    blocked: 'Permission blocked',
    unsupported: 'Push unavailable',
    failed: 'Push setup failed',
    inactive: 'Push alerts disabled',
  }[pushStatus] || 'Push status unknown';

  return (
    <div className={`w-full max-h-[90vh] overflow-hidden flex flex-col ${isEmbedded ? 'rounded-3xl' : 'rounded-[28px]'} border ${shellClasses}`}>
      <div className={`shrink-0 border-b px-5 pt-5 pb-4 ${dividerClasses}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className={`mb-2 flex items-center gap-2 ${isDark ? 'text-indigo-400' : 'text-indigo-500'}`}>
              <Bell className="w-5 h-5" />
              <h2 className="text-lg font-bold">Alert Notifications</h2>
            </div>
            <p className={`text-sm ${mutedTextClasses}`}>
              Alerts help you stay aware of HIGH and MEDIUM disruptions near your location. They are designed to give calm, actionable guidance, not to cause panic.
            </p>
          </div>
          {!isEmbedded && onClose && (
            <button
              onClick={onClose}
              className={`rounded-xl p-2 transition-colors ${isDark ? 'bg-slate-900/80 text-slate-300 hover:bg-slate-800 hover:text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900'}`}
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-6 pt-5">
        <div className="space-y-5">
          <div className={`rounded-3xl border p-4 ${sectionCardClasses}`}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className={`text-sm font-semibold ${headingTextClasses}`}>Enable Alerts</p>
                <p className={`mt-1 text-xs ${subtleTextClasses}`}>Turn on calm alert notifications for nearby disruptions.</p>
              </div>
              <button
                onClick={onToggleEnabled}
                className={`relative inline-flex h-8 w-14 flex-shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-500' : isDark ? 'bg-slate-700' : 'bg-slate-300'}`}
                aria-pressed={enabled}
              >
                <span
                  className={`inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>
          </div>

          {message && (
            <div className={`rounded-2xl border px-3 py-2 text-sm ${toneClasses}`}>
              {message}
            </div>
          )}

          <div className={`rounded-3xl border p-4 ${sectionCardClasses}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className={`text-sm font-semibold ${headingTextClasses}`}>Push delivery status</p>
                <p className={`mt-1 text-xs ${subtleTextClasses}`}>{permissionLabel}</p>
              </div>
              <span className={`text-xs font-semibold uppercase tracking-wider ${pushSubscriptionActive ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : mutedTextClasses}`}>
                {pushSubscriptionActive ? 'Active' : pushStatusLabel}
              </span>
            </div>
            {pushStatusMessage && <p className={`mt-2 text-xs ${mutedTextClasses}`}>{pushStatusMessage}</p>}
          </div>

          <div className={`rounded-3xl border p-4 ${sectionCardClasses}`}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className={`text-sm font-semibold ${headingTextClasses}`}>Alert Radius</p>
                <p className={`mt-1 text-xs ${subtleTextClasses}`}>Choose how far around you alerts should be considered.</p>
              </div>
              <span className={`text-sm font-bold ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>{radiusKm} km</span>
            </div>
            <input
              type="range"
              min="1"
              max="20"
              value={radiusKm}
              onChange={(event) => onRadiusChange(Number(event.target.value))}
              className={`h-1.5 w-full cursor-pointer rounded-lg accent-indigo-500 ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}
            />
            <p className={`mt-2 text-xs ${subtleTextClasses}`}>Default radius: 5 km</p>
          </div>

          <div className={`rounded-3xl border p-4 ${sectionCardClasses}`}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className={`text-sm font-semibold ${headingTextClasses}`}>Disruption Types</p>
                <p className={`mt-1 text-xs ${subtleTextClasses}`}>Choose the alert categories you want to receive.</p>
              </div>
              <span className={`text-xs uppercase tracking-wider ${subtleTextClasses}`}>{selectedCount} selected</span>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {TYPE_OPTIONS.map((option) => (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-3 py-3 transition ${isDark ? 'border-slate-800/70 bg-slate-950/90 hover:border-indigo-500/40' : 'border-slate-200 bg-white hover:border-indigo-400/60'}`}
                >
                  <input
                    type="checkbox"
                    checked={!!types[option.id]}
                    onChange={() => onToggleType(option.id)}
                    className="h-4 w-4 rounded accent-indigo-500"
                  />
                  <span className={`text-sm font-medium ${headingTextClasses}`}>{option.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className={`rounded-3xl border p-4 ${sectionCardClasses}`}>
            <p className={`text-sm font-semibold ${headingTextClasses}`}>What are alerts for?</p>
            <p className={`mt-2 text-xs ${mutedTextClasses}`}>
              Alerts notify you when a selected disruption type reaches HIGH or MEDIUM severity within your chosen radius. Each alert includes the affected area, severity, calm guidance, and a nearby safe area recommendation when available.
            </p>
          </div>

          <div className={`rounded-3xl border p-4 ${previewCardClasses}`}>
            <div className="flex items-center justify-between gap-3">
              <p className={`text-sm font-semibold ${previewTitleClasses}`}>Sample calm alert</p>
              {previewLoading && <span className={`text-[10px] uppercase tracking-wide ${previewTitleClasses}`}>Loading…</span>}
            </div>
            <p className={`mt-3 text-sm ${previewBodyClasses}`}>
              {previewLoading
                ? 'Preparing a calm alert preview…'
                : (previewPayload?.message || 'DIS-RUPTURE - [SEVERITY] Alert [disruption type] at [area name]. Score ([risk score]/100).')}
            </p>
            <p className={`mt-2 text-xs ${previewMetaClasses}`}>
              Follow official emergency guidance and avoid the affected zone.
            </p>
          </div>

          <p className={`text-xs ${subtleTextClasses}`}>
            These preferences only control alert notifications. They do not change map layer visibility.
          </p>
        </div>

        {isEmbedded && (
          <div className="mt-5 space-y-2">
            <p className={`text-xs ${subtleTextClasses}`}>Preferences are saved to localStorage and loaded automatically next time.</p>
            <p className={`text-xs ${subtleTextClasses}`}>Browser status: {permissionLabel}</p>
          </div>
        )}
      </div>
    </div>
  );
}
