export default function DestinationRadiusSlider({
  radiusKm,
  onChange,
  theme = 'light',
  min = 1,
  max = 15,
}) {
  const isDark = theme === 'dark';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
            Destination disruption radius
          </p>
          <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            How far around a destination to look for disruption zones.
          </p>
        </div>
        <span className={`text-sm font-bold ${isDark ? 'text-indigo-400' : 'text-indigo-600'}`}>{radiusKm} km</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={radiusKm}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`h-1.5 w-full cursor-pointer rounded-lg accent-indigo-500 ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}
      />
      <p className={`mt-2 text-xs ${isDark ? 'text-slate-500' : 'text-slate-600'}`}>Default radius: 2 km</p>
    </div>
  );
}
