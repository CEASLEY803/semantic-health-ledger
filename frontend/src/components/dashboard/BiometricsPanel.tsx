'use client';

import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  Tooltip,
  ReferenceLine,
  YAxis,
} from 'recharts';
import type { BiometricLog } from '@/lib/types';

interface BiometricsPanelProps {
  biometrics: BiometricLog[];
  isLoading: boolean;
}

// One data point for Recharts
interface SparkPoint {
  ts: number;        // epoch ms — Recharts domain key
  value: number;
  label: string;     // formatted date for tooltip
}

interface MetricGroup {
  metric_name: string;
  unit: string;
  points: SparkPoint[];    // sorted oldest → newest
  latest: number;
  min: number;
  max: number;
  trend: 'up' | 'down' | 'flat';
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

      // Trend: compare last value to average of first half
      let trend: MetricGroup['trend'] = 'flat';
      if (points.length >= 3) {
        const mid = Math.floor(points.length / 2);
        const earlyAvg = values.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
        const delta = latest - earlyAvg;
        const threshold = (max - min) * 0.05; // 5 % of range
        if (Math.abs(delta) > threshold) trend = delta > 0 ? 'up' : 'down';
      }

      return {
        metric_name,
        unit: sorted[sorted.length - 1].unit,
        points,
        latest,
        min,
        max,
        trend,
      };
    })
    .sort((a, b) => a.metric_name.localeCompare(b.metric_name));
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

function SparkTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: { payload: SparkPoint; value: number }[];
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  const { label, value } = payload[0].payload;
  return (
    <div className="rounded border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-xs shadow-lg">
      <p className="text-gray-400">{label}</p>
      <p className="font-mono font-semibold text-gray-100">
        {value} {unit}
      </p>
    </div>
  );
}

// ── Trend arrow ───────────────────────────────────────────────────────────────

function TrendIndicator({ trend }: { trend: MetricGroup['trend'] }) {
  if (trend === 'up')
    return <span className="text-xs text-orange-400" aria-label="trending up">▲</span>;
  if (trend === 'down')
    return <span className="text-xs text-blue-400" aria-label="trending down">▼</span>;
  return <span className="text-xs text-gray-600" aria-label="stable">—</span>;
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ group }: { group: MetricGroup }) {
  const { metric_name, unit, points, latest, min, max, trend } = group;

  // Pad the Y domain by 10 % so the line never touches the card edges
  const padding = (max - min) * 0.1 || latest * 0.05 || 1;
  const yMin = min - padding;
  const yMax = max + padding;

  // Mean reference line — only rendered when there is enough spread to matter
  const mean = points.reduce((s, p) => s + p.value, 0) / points.length;
  const showMean = max - min > padding;

  const isSinglePoint = points.length === 1;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold capitalize text-gray-200">
            {metric_name.replace(/_/g, ' ')}
          </h3>
          <p className="text-xs text-gray-600">
            {points.length} reading{points.length !== 1 ? 's' : ''}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <TrendIndicator trend={trend} />
          <span className="font-mono text-2xl font-bold tabular-nums text-gray-100">
            {latest}
          </span>
          <span className="self-end pb-0.5 text-xs text-gray-500">{unit}</span>
        </div>
      </div>

      {/* Sparkline */}
      {isSinglePoint ? (
        <div className="flex h-14 items-center justify-center text-xs text-gray-600">
          Single reading — log more data to see a trend.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={56}>
          <LineChart data={points} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
            <YAxis domain={[yMin, yMax]} hide />

            {showMean && (
              <ReferenceLine
                y={mean}
                stroke="#374151"
                strokeDasharray="3 3"
                strokeWidth={1}
              />
            )}

            <Tooltip
              content={<SparkTooltip unit={unit} />}
              cursor={{ stroke: '#4b5563', strokeWidth: 1 }}
            />

            <Line
              type="monotone"
              dataKey="value"
              stroke="#3b82f6"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: '#93c5fd', strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Footer: range */}
      {!isSinglePoint && (
        <div className="flex justify-between text-[11px] text-gray-600">
          <span>
            Range:{' '}
            <span className="font-mono text-gray-500">
              {min} – {max} {unit}
            </span>
          </span>
          <span className="font-mono text-gray-500">
            avg {mean.toFixed(1)} {unit}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function BiometricsPanel({ biometrics, isLoading }: BiometricsPanelProps) {
  const groups = useMemo(() => groupByMetric(biometrics), [biometrics]);

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-500">
        Loading biometrics…
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-600">
        No biometric data logged yet. Use the chat panel to record vitals.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      <div className="flex gap-6 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 text-sm">
        <div className="flex flex-col">
          <span className="text-xs text-gray-500">Metrics Tracked</span>
          <span className="font-semibold text-gray-200">{groups.length}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-gray-500">Total Readings</span>
          <span className="font-semibold text-gray-200">{biometrics.length}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-gray-500">Trending Up</span>
          <span className="font-semibold text-orange-400">
            {groups.filter((g) => g.trend === 'up').length}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-gray-500">Trending Down</span>
          <span className="font-semibold text-blue-400">
            {groups.filter((g) => g.trend === 'down').length}
          </span>
        </div>
      </div>

      {/* Cards grid */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {groups.map((group) => (
          <MetricCard key={group.metric_name} group={group} />
        ))}
      </div>
    </div>
  );
}
