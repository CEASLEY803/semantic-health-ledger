interface RefRangeBarProps {
  value: number;
  low: number | null;
  high: number | null;
}

// Renders a horizontal bar with the reference range highlighted in green and
// a marker pin showing where the actual value lands. When no reference range
// is provided the bar renders as a neutral grey track.
export default function RefRangeBar({ value, low, high }: RefRangeBarProps) {
  if (low === null || high === null) {
    return (
      <div className="h-2 w-full rounded-full bg-gray-700" title="No reference range" />
    );
  }

  const range = high - low;

  // Extend the visual axis 20 % on each side of [low, high] so there is always
  // visible space for out-of-bounds markers.
  const padding = range * 0.2 || 1;
  const axisMin = low - padding;
  const axisMax = high + padding;
  const axisRange = axisMax - axisMin;

  const toPercent = (v: number) =>
    Math.min(100, Math.max(0, ((v - axisMin) / axisRange) * 100));

  const refLeft = toPercent(low);
  const refWidth = toPercent(high) - refLeft;
  const markerLeft = toPercent(value);

  const isOutOfRange = value < low || value > high;

  return (
    <div className="relative h-3 w-full" aria-label={`Value ${value}, range ${low}–${high}`}>
      {/* Full track */}
      <div className="absolute inset-y-1/2 w-full -translate-y-1/2 h-1.5 rounded-full bg-gray-700" />

      {/* Reference range band */}
      <div
        className="absolute inset-y-1/2 -translate-y-1/2 h-1.5 rounded-full bg-emerald-700/60"
        style={{ left: `${refLeft}%`, width: `${refWidth}%` }}
      />

      {/* Value marker */}
      <div
        className={`absolute inset-y-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full ring-2 ring-gray-950 ${
          isOutOfRange ? 'bg-red-400' : 'bg-emerald-400'
        }`}
        style={{ left: `${markerLeft}%` }}
      />
    </div>
  );
}
