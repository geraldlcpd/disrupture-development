export default function LocationOffChip({
  theme = 'light',
  onUseLocation,
  onSearchArea,
  locating = false,
}) {
  const isLight = theme === 'light';

  return (
    <div
      className={`inline-flex max-w-full items-center gap-2 rounded-xl border px-3 py-2 text-xs shadow-lg backdrop-blur-md ${
        isLight
          ? 'border-slate-200 bg-white/95 text-slate-800'
          : 'border-slate-700 bg-slate-900/95 text-slate-100'
      }`}
    >
      <span className="min-w-0 truncate font-semibold">Location off</span>
      <button
        type="button"
        onClick={onUseLocation}
        disabled={locating}
        className={`shrink-0 font-bold ${isLight ? 'text-indigo-600' : 'text-indigo-300'} disabled:opacity-60`}
      >
        {locating ? 'Locating…' : 'Turn on'}
      </button>
      <span className={isLight ? 'text-slate-400' : 'text-slate-500'}>·</span>
      <button
        type="button"
        onClick={onSearchArea}
        className={`shrink-0 font-bold ${isLight ? 'text-indigo-600' : 'text-indigo-300'}`}
      >
        Search area
      </button>
    </div>
  );
}
