'use client';

import { useMemo, useState } from 'react';
import type { AdministrationRoute, CompoundLog } from '@/lib/types';

interface CompoundsPanelProps {
  compounds: CompoundLog[];
  isLoading: boolean;
}

// ── Route helpers ─────────────────────────────────────────────────────────────

const ROUTE_ABBR: Record<AdministrationRoute, string> = {
  oral:           'PO',
  subcutaneous:   'SubQ',
  intramuscular:  'IM',
  intravenous:    'IV',
  transdermal:    'TD',
  intranasal:     'IN',
  other:          'Other',
};

const ROUTE_COLOR: Record<AdministrationRoute, string> = {
  intramuscular:  'bg-violet-900/50 text-violet-300 ring-violet-700',
  subcutaneous:   'bg-blue-900/50 text-blue-300 ring-blue-700',
  intravenous:    'bg-red-900/50 text-red-300 ring-red-700',
  oral:           'bg-emerald-900/50 text-emerald-300 ring-emerald-700',
  transdermal:    'bg-amber-900/50 text-amber-300 ring-amber-700',
  intranasal:     'bg-cyan-900/50 text-cyan-300 ring-cyan-700',
  other:          'bg-gray-800 text-gray-400 ring-gray-700',
};

function RouteBadge({ route }: { route: AdministrationRoute }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-bold ring-1 ring-inset ${ROUTE_COLOR[route]}`}
    >
      {ROUTE_ABBR[route]}
    </span>
  );
}

// ── Date grouping ─────────────────────────────────────────────────────────────

function formatDateHeading(isoString: string): string {
  const d = new Date(isoString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Groups entries newest-first into [{ heading, entries[] }] buckets by calendar day.
function groupByDay(
  compounds: CompoundLog[],
): { heading: string; entries: CompoundLog[] }[] {
  const sorted = [...compounds].sort(
    (a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
  );

  const buckets: { heading: string; entries: CompoundLog[] }[] = [];
  let currentHeading = '';

  for (const entry of sorted) {
    const heading = formatDateHeading(entry.recorded_at);
    if (heading !== currentHeading) {
      currentHeading = heading;
      buckets.push({ heading, entries: [] });
    }
    buckets[buckets.length - 1].entries.push(entry);
  }

  return buckets;
}

// ── Compound name → unique stable colour for the timeline dot ─────────────────

const DOT_PALETTE = [
  'bg-violet-400',
  'bg-blue-400',
  'bg-emerald-400',
  'bg-amber-400',
  'bg-pink-400',
  'bg-cyan-400',
  'bg-orange-400',
  'bg-teal-400',
];

function useDotColors(compounds: CompoundLog[]): Map<string, string> {
  return useMemo(() => {
    const names = [...new Set(compounds.map((c) => c.compound_name))].sort();
    const map = new Map<string, string>();
    names.forEach((name, i) => {
      map.set(name, DOT_PALETTE[i % DOT_PALETTE.length]);
    });
    return map;
  }, [compounds]);
}

// ── Timeline entry card ───────────────────────────────────────────────────────

function TimelineEntry({
  entry,
  dotColor,
  isLast,
}: {
  entry: CompoundLog;
  dotColor: string;
  isLast: boolean;
}) {
  const hasMetadata = entry.site || entry.protocol_phase || entry.notes;

  return (
    <li className="relative flex gap-4">
      {/* Vertical connector line + dot */}
      <div className="flex flex-col items-center">
        <div className={`mt-1 h-3 w-3 flex-none rounded-full ring-2 ring-gray-950 ${dotColor}`} />
        {!isLast && <div className="mt-1 flex-1 w-px bg-gray-800" />}
      </div>

      {/* Card */}
      <div className="mb-5 flex-1 rounded-lg border border-gray-800 bg-gray-900 p-4">
        {/* Top row: name + dose + route badge + time */}
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-gray-100">
              {entry.compound_name}
            </span>
            <span className="font-mono text-sm font-medium text-gray-300">
              {entry.dose_value}&thinsp;{entry.dose_unit}
            </span>
            <RouteBadge route={entry.route} />
          </div>
          <time
            dateTime={entry.recorded_at}
            className="flex-none font-mono text-xs text-gray-500"
          >
            {formatTime(entry.recorded_at)}
          </time>
        </div>

        {/* Metadata row */}
        {hasMetadata && (
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
            {entry.protocol_phase && (
              <div className="flex gap-1.5">
                <dt className="text-gray-600">Phase</dt>
                <dd className="font-medium text-gray-400">{entry.protocol_phase}</dd>
              </div>
            )}
            {entry.site && (
              <div className="flex gap-1.5">
                <dt className="text-gray-600">Site</dt>
                <dd className="font-medium text-gray-400">{entry.site}</dd>
              </div>
            )}
            {entry.notes && (
              <div className="mt-1 w-full">
                <dt className="sr-only">Notes</dt>
                <dd className="text-gray-500 leading-relaxed">{entry.notes}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </li>
  );
}

// ── Filters ───────────────────────────────────────────────────────────────────

type RouteFilter = AdministrationRoute | 'all';

// ── Summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({
  compounds,
  compoundFilter,
  setCompoundFilter,
  routeFilter,
  setRouteFilter,
}: {
  compounds: CompoundLog[];
  compoundFilter: string;
  setCompoundFilter: (v: string) => void;
  routeFilter: RouteFilter;
  setRouteFilter: (v: RouteFilter) => void;
}) {
  const uniqueNames = useMemo(
    () => ['all', ...[...new Set(compounds.map((c) => c.compound_name))].sort()],
    [compounds],
  );

  const uniqueRoutes = useMemo(
    () =>
      ['all', ...[...new Set(compounds.map((c) => c.route))].sort()] as RouteFilter[],
    [compounds],
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="flex gap-6 text-sm">
        <div className="flex flex-col">
          <span className="text-xs text-gray-500">Total Logs</span>
          <span className="font-semibold text-gray-200">{compounds.length}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-gray-500">Compounds</span>
          <span className="font-semibold text-gray-200">
            {new Set(compounds.map((c) => c.compound_name)).size}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          value={compoundFilter}
          onChange={(e) => setCompoundFilter(e.target.value)}
          className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300 focus:outline-none"
        >
          {uniqueNames.map((n) => (
            <option key={n} value={n}>
              {n === 'all' ? 'All Compounds' : n}
            </option>
          ))}
        </select>

        <select
          value={routeFilter}
          onChange={(e) => setRouteFilter(e.target.value as RouteFilter)}
          className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300 focus:outline-none"
        >
          {uniqueRoutes.map((r) => (
            <option key={r} value={r}>
              {r === 'all' ? 'All Routes' : ROUTE_ABBR[r as AdministrationRoute]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function CompoundsPanel({ compounds, isLoading }: CompoundsPanelProps) {
  const [compoundFilter, setCompoundFilter] = useState('all');
  const [routeFilter, setRouteFilter] = useState<RouteFilter>('all');

  const dotColors = useDotColors(compounds);

  const filtered = useMemo(() => {
    return compounds.filter((c) => {
      if (compoundFilter !== 'all' && c.compound_name !== compoundFilter) return false;
      if (routeFilter !== 'all' && c.route !== routeFilter) return false;
      return true;
    });
  }, [compounds, compoundFilter, routeFilter]);

  const dayGroups = useMemo(() => groupByDay(filtered), [filtered]);

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-500">
        Loading compound logs…
      </div>
    );
  }

  if (compounds.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-600">
        No compound logs yet. Use the chat panel to record a dose.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SummaryBar
        compounds={compounds}
        compoundFilter={compoundFilter}
        setCompoundFilter={setCompoundFilter}
        routeFilter={routeFilter}
        setRouteFilter={setRouteFilter}
      />

      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-600">
          No entries match the current filters.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {dayGroups.map(({ heading, entries }) => (
            <section key={heading}>
              {/* Day heading */}
              <div className="mb-3 flex items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                  {heading}
                </span>
                <div className="flex-1 border-t border-gray-800" />
              </div>

              {/* Timeline entries for this day */}
              <ul className="flex flex-col">
                {entries.map((entry, i) => (
                  <TimelineEntry
                    key={entry.id}
                    entry={entry}
                    dotColor={dotColors.get(entry.compound_name) ?? 'bg-gray-400'}
                    isLast={i === entries.length - 1}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
