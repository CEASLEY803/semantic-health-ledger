'use client';

import { useMemo, useState } from 'react';
import { deleteEntry } from '@/lib/api';
import type { BiometricLog } from '@/lib/types';

// Metrics where a falling value is an improvement (arrow down = green, arrow up = red)
const LOWER_IS_BETTER = new Set([
  'resting_heart_rate',
  'sleep_stress',
  'sleep_awake',
]);

interface BiometricsPanelProps {
  biometrics: BiometricLog[];
  isLoading: boolean;
  onRefresh: () => void;
}

interface SparkPoint {
  ts: number;
  value: number;
  label: string;
}

function Sparkline({ points }: { points: SparkPoint[] }) {
  const W = 300; const H = 56;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const range = hi - lo || 1;
  const pad = 4;
  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (W - pad * 2));
  const ys = vals.map((v) => H - pad - ((v - lo) / range) * (H - pad * 2));
  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x},${ys[i]}`).join(' ');
  const area = `${line} L${xs[xs.length - 1]},${H} L${xs[0]},${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(34,211,238)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="rgb(34,211,238)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sg)" />
      <path d={line} fill="none" stroke="rgb(34,211,238)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

interface MetricGroup {
  metric_name: string;
  unit: string;
  points: SparkPoint[];
  entries: BiometricLog[];   // full rows with IDs, sorted newest-first
  latest: number;
  min: number;
  max: number;
  trend: 'up' | 'down' | 'flat';
  inverted: boolean;         // true = lower is better (arrow down = green)
}

function groupByMetric(logs: BiometricLog[]): MetricGroup[] {
  const map = new Map<string, BiometricLog[]>();
  for (const log of logs) {
    const key = log.metric_name;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(log);
  }

  return [...map.entries()]
    .map(([metric_name, entries]) => {
      const sorted = [...entries].sort(
        (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime(),
      );

      const points: SparkPoint[] = sorted.map((e) => ({
        ts: new Date(e.recorded_at).getTime(),
        value: Number(e.value),
        label: new Date(e.recorded_at).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: sorted.length > 30 ? '2-digit' : undefined,
        }),
      }));

      const values = points.map((p) => p.value);
      const latest = values[values.length - 1];
      const min = Math.min(...values);
      const max = Math.max(...values);

      // ── Week-over-week trend ──────────────────────────────────────────────
      // Compare this week's avg (past 7 days) against last week's avg (8–14 days ago).
      // Falls back to flat if either window has no data.
      let trend: MetricGroup['trend'] = 'flat';
      const now = Date.now();
      const WEEK_MS = 7 * 86_400_000;
      const thisWeekVals = points.filter((p) => now - p.ts <= WEEK_MS).map((p) => p.value);
      const prevWeekVals = points
        .filter((p) => now - p.ts > WEEK_MS && now - p.ts <= 2 * WEEK_MS)
        .map((p) => p.value);

      if (thisWeekVals.length > 0 && prevWeekVals.length > 0) {
        const thisAvg = thisWeekVals.reduce((a, b) => a + b, 0) / thisWeekVals.length;
        const prevAvg = prevWeekVals.reduce((a, b) => a + b, 0) / prevWeekVals.length;
        const pctChange = (thisAvg - prevAvg) / Math.max(Math.abs(prevAvg), 0.001);
        if (pctChange > 0.03) trend = 'up';
        else if (pctChange < -0.03) trend = 'down';
      }

      return {
        metric_name,
        unit: sorted[sorted.length - 1].unit,
        points,
        entries: [...sorted].reverse(), // newest-first for the delete list
        latest,
        min,
        max,
        trend,
        inverted: LOWER_IS_BETTER.has(metric_name),
      };
    })
    .sort((a, b) => a.metric_name.localeCompare(b.metric_name));
}

// ── Trend indicator ───────────────────────────────────────────────────────────

function TrendIndicator({ trend, inverted = false }: { trend: MetricGroup['trend']; inverted?: boolean }) {
  if (trend === 'up') {
    const cls = inverted ? 'text-rose-500' : 'text-emerald-400';
    return <span className={`font-mono text-xs ${cls}`} aria-label="trending up">▲</span>;
  }
  if (trend === 'down') {
    const cls = inverted ? 'text-emerald-400' : 'text-rose-500';
    return <span className={`font-mono text-xs ${cls}`} aria-label="trending down">▼</span>;
  }
  return <span className="font-mono text-xs text-zinc-500" aria-label="stable">—</span>;
}

// ── Metric card ───────────────────────────────────────────────────────────────

function dispatchBiometricRef(metric_name: string, value: number, unit: string, recorded_at: string) {
  const displayDate = new Date(recorded_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });
  window.dispatchEvent(
    new CustomEvent('health:reference', {
      detail: {
        label: `${displayDate} · ${metric_name.replace(/_/g, ' ')}`,
        value: `${value} ${unit}`,
      },
    }),
  );
}

function MetricCard({ group, onRefresh }: { group: MetricGroup; onRefresh: () => void }) {
  const { metric_name, unit, points, entries, latest, min, max, trend, inverted } = group;
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const mean = points.reduce((s, p) => s + p.value, 0) / points.length;
  const isSinglePoint = points.length === 1;
  const latestEntry = entries[0]; // newest-first

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleting(id);
    try {
      await deleteEntry('biometric', id);
      onRefresh();
    } finally {
      setDeleting(null);
    }
  };

  const handleLatestRef = () => {
    if (!latestEntry) return;
    dispatchBiometricRef(metric_name, Number(latestEntry.value), unit, latestEntry.recorded_at);
  };

  return (
    <div className="flex flex-col gap-4 border border-zinc-800 bg-zinc-900 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-zinc-300">
            {metric_name.replace(/_/g, ' ')}
          </h3>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-left font-mono text-[10px] tracking-widest text-zinc-500 hover:text-cyan-400 transition-colors"
          >
            {points.length} READING{points.length !== 1 ? 'S' : ''} {expanded ? '▲' : '▼'}
          </button>
        </div>

        <div
          className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-cyan-500/[0.07]"
          onClick={handleLatestRef}
          title={`Pin latest ${metric_name.replace(/_/g, ' ')} to chat`}
        >
          <TrendIndicator trend={trend} inverted={inverted} />
          <span className="font-mono text-2xl font-bold tabular-nums text-white">{latest}</span>
          <span className="self-end pb-0.5 font-mono text-xs text-zinc-400">{unit}</span>
        </div>
      </div>

      {/* Sparkline */}
      {isSinglePoint ? (
        <div className="flex h-14 items-center justify-center font-mono text-[10px] tracking-widest text-zinc-500">
          SINGLE READING — LOG MORE DATA TO SEE TREND
        </div>
      ) : (
        <Sparkline points={points} />
      )}

      {/* Footer: range + avg */}
      {!isSinglePoint && (
        <div className="flex justify-between">
          <span className="font-mono text-[10px] tracking-widest text-zinc-500">
            RANGE{' '}
            <span className="text-zinc-500">
              {min} – {max} {unit}
            </span>
          </span>
          <span className="font-mono text-[10px] tracking-widest text-zinc-500">
            AVG <span className="text-zinc-500">{mean.toFixed(1)} {unit}</span>
          </span>
        </div>
      )}

      {/* Expandable raw readings list */}
      {expanded && (
        <div className="border-t border-zinc-800 pt-3 flex flex-col gap-1">
          {entries.map((e) => (
            <div
              key={e.id}
              onClick={() => dispatchBiometricRef(metric_name, Number(e.value), unit, e.recorded_at)}
              className="group flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 transition-colors hover:bg-cyan-500/[0.06] active:bg-cyan-500/[0.10]"
              title={`Pin to chat`}
            >
              <span className="font-mono text-[11px] text-zinc-400 tabular-nums">
                {new Date(e.recorded_at).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </span>
              <span className="font-mono text-[11px] font-semibold text-zinc-200 tabular-nums">
                {Number(e.value)} {e.unit}
              </span>
              <button
                onClick={(ev) => handleDelete(e.id, ev)}
                disabled={deleting === e.id}
                className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity font-mono text-[10px] text-zinc-500 hover:text-rose-400 disabled:text-zinc-600"
                title="Delete this reading"
              >
                {deleting === e.id ? '…' : '×'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function BiometricsPanel({ biometrics, isLoading, onRefresh }: BiometricsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const allGroups = useMemo(() => groupByMetric(biometrics), [biometrics]);
  const groups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter((g) => g.metric_name.toLowerCase().includes(q));
  }, [allGroups, searchQuery]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center font-mono text-xs tracking-widest text-zinc-500">
        LOADING BIOMETRIC DATA…
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
          </svg>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <p className="font-mono text-xs font-semibold tracking-widest text-zinc-300">NO BIOMETRIC DATA</p>
          <p className="font-mono text-[10px] tracking-widest text-zinc-500">Log vitals to track trends over time</p>
        </div>
      </div>
    );
  }

  const trendingUp = allGroups.filter((g) => g.trend === 'up').length;
  const trendingDown = allGroups.filter((g) => g.trend === 'down').length;

  return (
    <div className="flex flex-col gap-3">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-zinc-800 bg-zinc-900 px-5 py-3">
        <div className="flex gap-10">
          <Stat label="METRICS TRACKED" value={allGroups.length} />
          <Stat label="TOTAL READINGS" value={biometrics.length} />
          <Stat
            label="TRENDING UP"
            value={trendingUp}
            color={trendingUp > 0 ? 'text-emerald-400' : undefined}
          />
          <Stat
            label="TRENDING DOWN"
            value={trendingDown}
            color={trendingDown > 0 ? 'text-rose-500' : undefined}
          />
        </div>

        <div className="flex items-center gap-1.5 border border-zinc-700 bg-zinc-800/60 px-3 py-1.5">
          <svg className="h-3 w-3 shrink-0 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="SEARCH METRICS…"
            className="w-32 bg-transparent font-mono text-[10px] tracking-widest text-zinc-300 placeholder-zinc-600 focus:outline-none"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="text-zinc-600 transition-colors hover:text-zinc-400">×</button>
          )}
        </div>
      </div>

      {/* Cards grid */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {groups.map((group) => (
          <MetricCard key={group.metric_name} group={group} onRefresh={onRefresh} />
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] tracking-widest text-zinc-400">{label}</span>
      <span
        className={`font-mono text-xl font-bold leading-none tabular-nums ${color ?? 'text-white'}`}
      >
        {value}
      </span>
    </div>
  );
}
