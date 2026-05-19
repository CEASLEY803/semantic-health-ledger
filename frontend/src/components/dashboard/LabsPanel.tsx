'use client';

import { useMemo, useState } from 'react';
import RefRangeBar from '@/components/ui/RefRangeBar';
import StatusBadge from '@/components/ui/StatusBadge';
import type { LabResult } from '@/lib/types';
import type { StatusBadgeProps } from '@/components/ui/StatusBadge';

type BadgeStatus = 'flagged' | 'high' | 'low' | 'normal' | 'no-range';

interface LabsPanelProps {
  labs: LabResult[];
  isLoading: boolean;
}

// SQLite returns reference_low / reference_high as strings (or null).
// Coerce once here.
function parseNum(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function deriveStatus(lab: LabResult): BadgeStatus {
  if (lab.flagged) return 'flagged';
  const value = parseNum(String(lab.value_numeric));
  const low = parseNum(lab.reference_low);
  const high = parseNum(lab.reference_high);
  if (value === null) return 'no-range';
  if (low === null || high === null) return 'no-range';
  if (value > high) return 'high';
  if (value < low) return 'low';
  return 'normal';
}

type SortField = 'marker_name' | 'collected_at' | 'status';
type SortDir = 'asc' | 'desc';

const STATUS_ORDER: Record<BadgeStatus, number> = {
  flagged: 0,
  high: 1,
  low: 2,
  normal: 3,
  'no-range': 4,
};

export default function LabsPanel({ labs, isLoading }: LabsPanelProps) {
  const [sortField, setSortField] = useState<SortField>('status');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [panelFilter, setPanelFilter] = useState<string>('all');

  const panels = useMemo(() => {
    const names = [...new Set(labs.map((l) => l.panel_name).filter(Boolean))] as string[];
    return ['all', ...names.sort()];
  }, [labs]);

  const processed = useMemo(() => {
    return labs.map((lab) => ({
      ...lab,
      _value: parseNum(String(lab.value_numeric)),
      _low: parseNum(lab.reference_low),
      _high: parseNum(lab.reference_high),
      _status: deriveStatus(lab),
    }));
  }, [labs]);

  const filtered = useMemo(() => {
    if (panelFilter === 'all') return processed;
    return processed.filter((l) => l.panel_name === panelFilter);
  }, [processed, panelFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'marker_name') {
        cmp = a.marker_name.localeCompare(b.marker_name);
      } else if (sortField === 'collected_at') {
        cmp = a.collected_at.localeCompare(b.collected_at);
      } else {
        cmp = STATUS_ORDER[a._status] - STATUS_ORDER[b._status];
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortField, sortDir]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortIndicator = (field: SortField) =>
    sortField === field ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-500">
        Loading lab results…
      </div>
    );
  }

  if (labs.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-600">
        No lab results logged yet. Use the chat panel to ingest a lab report.
      </div>
    );
  }

  const flaggedCount = processed.filter(
    (l) => l._status === 'flagged' || l._status === 'high' || l._status === 'low',
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary bar */}
      <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
        <div className="flex gap-6 text-sm">
          <Stat label="Total Markers" value={labs.length} />
          <Stat label="Out of Range" value={flaggedCount} highlight={flaggedCount > 0} />
        </div>

        {/* Panel filter */}
        <select
          value={panelFilter}
          onChange={(e) => setPanelFilter(e.target.value)}
          className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300 focus:outline-none"
        >
          {panels.map((p) => (
            <option key={p} value={p}>
              {p === 'all' ? 'All Panels' : p}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900 text-xs uppercase tracking-wider text-gray-500">
              <Th onClick={() => handleSort('status')} label={`Status${sortIndicator('status')}`} />
              <Th onClick={() => handleSort('marker_name')} label={`Marker${sortIndicator('marker_name')}`} />
              <th className="px-4 py-2 text-left">Panel</th>
              <th className="px-4 py-2 text-right">Value</th>
              <th className="px-4 py-2 text-center">Ref Range</th>
              <th className="px-4 py-2 min-w-[160px]">Distribution</th>
              <Th onClick={() => handleSort('collected_at')} label={`Collected${sortIndicator('collected_at')}`} />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {sorted.map((lab) => (
              <LabRow key={lab.id} lab={lab} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type ProcessedLab = {
  id: string;
  marker_name: string;
  panel_name: string | null;
  value_numeric: number | null;
  value_text: string | null;
  unit: string | null;
  reference_low: string | null;
  reference_high: string | null;
  collected_at: string;
  _value: number | null;
  _low: number | null;
  _high: number | null;
  _status: BadgeStatus;
};

// ── Sub-components ────────────────────────────────────────────────────────────

function Th({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <th
      className="cursor-pointer select-none px-4 py-2 text-left hover:text-gray-300"
      onClick={onClick}
    >
      {label}
    </th>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`font-semibold ${highlight ? 'text-red-400' : 'text-gray-200'}`}>
        {value}
      </span>
    </div>
  );
}

type LabRowProps = { lab: ProcessedLab };

function LabRow({ lab }: LabRowProps) {
  const refRange =
    lab._low !== null && lab._high !== null
      ? `${lab._low} – ${lab._high}`
      : '—';

  const displayValue =
    lab._value !== null
      ? `${lab._value}${lab.unit ? ` ${lab.unit}` : ''}`
      : lab.value_text ?? '—';

  const collectedDate = new Date(lab.collected_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const rowAccent =
    lab._status === 'flagged' || lab._status === 'high' || lab._status === 'low'
      ? 'bg-red-950/10'
      : '';

  return (
    <tr className={`transition-colors hover:bg-gray-800/40 ${rowAccent}`}>
      <td className="px-4 py-3">
        <StatusBadge status={lab._status} />
      </td>
      <td className="px-4 py-3 font-medium text-gray-200">{lab.marker_name}</td>
      <td className="px-4 py-3 text-gray-500">{lab.panel_name ?? '—'}</td>
      <td className="px-4 py-3 text-right font-mono text-gray-200">{displayValue}</td>
      <td className="px-4 py-3 text-center font-mono text-xs text-gray-500">{refRange}</td>
      <td className="px-4 py-3">
        {lab._value !== null ? (
          <RefRangeBar value={lab._value} low={lab._low} high={lab._high} />
        ) : (
          <span className="text-xs text-gray-600">N/A</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-gray-500">{collectedDate}</td>
    </tr>
  );
}

