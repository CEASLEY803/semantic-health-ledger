interface StatusBadgeProps {
  status: 'flagged' | 'high' | 'low' | 'normal' | 'no-range';
}

const CONFIG = {
  flagged: { label: 'Flagged', classes: 'bg-red-900/60 text-red-300 ring-red-700' },
  high:    { label: 'High',    classes: 'bg-orange-900/60 text-orange-300 ring-orange-700' },
  low:     { label: 'Low',     classes: 'bg-yellow-900/60 text-yellow-300 ring-yellow-700' },
  normal:  { label: 'Normal',  classes: 'bg-emerald-900/40 text-emerald-400 ring-emerald-700' },
  'no-range': { label: 'No Ref', classes: 'bg-gray-800 text-gray-500 ring-gray-700' },
} satisfies Record<StatusBadgeProps['status'], { label: string; classes: string }>;

export default function StatusBadge({ status }: StatusBadgeProps) {
  const { label, classes } = CONFIG[status];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${classes}`}
    >
      {label}
    </span>
  );
}
