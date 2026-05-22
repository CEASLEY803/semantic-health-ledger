'use client';

import { useState } from 'react';
import { deleteRegimenItem } from '@/lib/api';
import type { AdministrationRoute, RegimenItem } from '@/lib/types';

interface CompoundsPanelProps {
  regimen: RegimenItem[];
  isLoading: boolean;
  onRefresh: () => void;
}

// ── Route badge ───────────────────────────────────────────────────────────────

const ROUTE_ABBR: Record<AdministrationRoute, string> = {
  oral:          'PO',
  subcutaneous:  'SUBQ',
  intramuscular: 'IM',
  intravenous:   'IV',
  transdermal:   'TD',
  intranasal:    'IN',
  other:         'OTHER',
};

const ROUTE_COLOR: Record<AdministrationRoute, string> = {
  intramuscular: 'bg-violet-500/10 text-violet-400 ring-violet-500/30',
  subcutaneous:  'bg-cyan-400/10 text-cyan-400 ring-cyan-400/30',
  intravenous:   'bg-rose-500/10 text-rose-400 ring-rose-500/30',
  oral:          'bg-emerald-400/10 text-emerald-400 ring-emerald-400/30',
  transdermal:   'bg-amber-400/10 text-amber-400 ring-amber-400/30',
  intranasal:    'bg-sky-400/10 text-sky-400 ring-sky-400/30',
  other:         'bg-zinc-800/60 text-zinc-400 ring-zinc-700/50',
};

function RouteBadge({ route }: { route: AdministrationRoute }) {
  return (
    <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-widest ring-1 ring-inset ${ROUTE_COLOR[route] ?? ROUTE_COLOR.other}`}>
      {ROUTE_ABBR[route] ?? route.toUpperCase()}
    </span>
  );
}

// ── Frequency / days label ────────────────────────────────────────────────────

function formatSchedule(item: RegimenItem): string {
  if (item.frequency === 'daily')       return 'DAILY';
  if (item.frequency === 'twice_daily') return '2×/DAY';
  if (item.frequency === 'biweekly')    return 'BIWEEKLY';
  if (item.frequency === 'monthly')     return 'MONTHLY';
  if (item.frequency === 'as_needed')   return 'AS NEEDED';
  if (item.frequency === 'weekly' && item.days_of_week) {
    return item.days_of_week
      .split(',')
      .map((d) => d.trim().slice(0, 3).toUpperCase())
      .join('/');
  }
  return item.frequency.replace(/_/g, ' ').toUpperCase();
}

// ── Time-of-day grouping ──────────────────────────────────────────────────────

const TIME_ORDER = ['morning', 'midday', 'afternoon', 'evening', 'night', 'as_needed'] as const;

const TIME_LABELS: Record<string, string> = {
  morning:   'MORNING',
  midday:    'MIDDAY',
  afternoon: 'AFTERNOON',
  evening:   'EVENING',
  night:     'NIGHT',
  as_needed: 'AS NEEDED',
};

function groupByTime(items: RegimenItem[]): { key: string; label: string; items: RegimenItem[] }[] {
  const map = new Map<string, RegimenItem[]>();
  for (const item of items) {
    const key = item.time_of_day;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  // Ordered known keys first, then any unknown time_of_day values
  const orderedKeys = [
    ...TIME_ORDER.filter((k) => map.has(k)),
    ...[...map.keys()].filter((k) => !TIME_ORDER.includes(k as typeof TIME_ORDER[number])),
  ];
  return orderedKeys.map((key) => ({
    key,
    label: TIME_LABELS[key] ?? key.toUpperCase(),
    items: map.get(key)!,
  }));
}

// ── Single regimen row ────────────────────────────────────────────────────────

function RegimenRow({ item, onRefresh }: { item: RegimenItem; onRefresh: () => void }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleting(true);
    try {
      await deleteRegimenItem(item.id);
      onRefresh();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="group flex items-center gap-3 border-b border-zinc-800/60 px-4 py-3 last:border-0 hover:bg-white/[0.02] transition-colors">
      {/* Compound name */}
      <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold text-zinc-100 truncate">
        {item.compound_name}
      </span>

      {/* Dose */}
      <span className="shrink-0 font-mono text-[13px] font-bold tabular-nums text-white">
        {item.dose_value}&thinsp;<span className="text-zinc-400 font-normal">{item.dose_unit}</span>
      </span>

      {/* Route badge */}
      <RouteBadge route={item.route} />

      {/* Schedule */}
      <span className="shrink-0 font-mono text-[10px] tracking-widest text-zinc-500 min-w-[60px] text-right">
        {formatSchedule(item)}
      </span>

      {/* Site (if present) */}
      {item.site && (
        <span className="shrink-0 font-mono text-[10px] text-zinc-600">
          {item.site}
        </span>
      )}

      {/* Delete */}
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity font-mono text-[11px] text-zinc-600 hover:text-rose-400 disabled:text-zinc-700"
        title="Remove from regimen"
      >
        {deleting ? '…' : '×'}
      </button>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function CompoundsPanel({ regimen, isLoading, onRefresh }: CompoundsPanelProps) {
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center font-mono text-xs tracking-widest text-zinc-500">
        LOADING REGIMEN…
      </div>
    );
  }

  if (regimen.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
          </svg>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <p className="font-mono text-xs font-semibold tracking-widest text-zinc-300">NO REGIMEN DEFINED</p>
          <p className="font-mono text-[10px] tracking-widest text-zinc-500 text-center max-w-[220px]">
            Tell LEDGER what you take and when — e.g. &ldquo;I take 5mg TAK-653 every morning&rdquo;
          </p>
        </div>
      </div>
    );
  }

  const groups = groupByTime(regimen);
  const totalCompounds = regimen.length;

  return (
    <div className="flex flex-col gap-1">
      {/* Header stat */}
      <div className="flex items-center justify-between border border-zinc-800 bg-zinc-900 px-5 py-3 mb-2">
        <span className="font-mono text-[10px] tracking-widest text-zinc-400">CURRENT STACK</span>
        <span className="font-mono text-xl font-bold tabular-nums text-white">{totalCompounds}</span>
      </div>

      {/* Groups */}
      {groups.map(({ key, label, items }) => (
        <section key={key} className="border border-zinc-800 bg-zinc-900">
          {/* Section header */}
          <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
            <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-cyan-500/70">
              {label}
            </span>
            <div className="flex-1 h-px bg-zinc-800" />
            <span className="font-mono text-[10px] text-zinc-600">{items.length}</span>
          </div>

          {/* Rows */}
          <div>
            {items.map((item) => (
              <RegimenRow key={item.id} item={item} onRefresh={onRefresh} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
