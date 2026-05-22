'use client';

import { useMemo, useState } from 'react';
import { deleteEntry } from '@/lib/api';
import type { DailyJournal, Mood } from '@/lib/types';
import { ActiveTrackingBoard } from '@/components/journal/ActiveTrackingBoard';

interface JournalPanelProps {
  journals: DailyJournal[];
  isLoading: boolean;
  onRefresh: () => void;
}

// ── Schema coercion ───────────────────────────────────────────────────────────

function parseSymptoms(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseSleep(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

// ── Mood config ───────────────────────────────────────────────────────────────

const MOOD_CONFIG: Record<
  Mood,
  { label: string; score: number; bar: string; text: string; bg: string }
> = {
  very_low:  { label: 'Very Low',  score: 1, bar: 'bg-rose-500',    text: 'text-rose-400',    bg: 'bg-rose-500/[0.04]' },
  low:       { label: 'Low',       score: 2, bar: 'bg-amber-500',   text: 'text-amber-400',   bg: 'bg-amber-500/[0.04]' },
  neutral:   { label: 'Neutral',   score: 3, bar: 'bg-yellow-400',  text: 'text-yellow-400',  bg: 'bg-yellow-400/[0.03]' },
  good:      { label: 'Good',      score: 4, bar: 'bg-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-400/[0.04]' },
  very_good: { label: 'Very Good', score: 5, bar: 'bg-cyan-400',    text: 'text-cyan-400',    bg: 'bg-cyan-400/[0.04]' },
};

// ── Energy helpers ────────────────────────────────────────────────────────────

function energyColor(score: number): string {
  if (score <= 3) return 'text-rose-400';
  if (score <= 5) return 'text-amber-400';
  if (score <= 7) return 'text-yellow-400';
  return 'text-emerald-400';
}

function energyBarColor(score: number): string {
  if (score <= 3) return 'bg-rose-500';
  if (score <= 5) return 'bg-amber-500';
  if (score <= 7) return 'bg-yellow-400';
  return 'bg-emerald-400';
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function formatCardDate(iso: string): { primary: string; secondary: string } {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const secondary = d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });

  if (sameDay(d, today)) return { primary: 'TODAY', secondary };
  if (sameDay(d, yesterday)) return { primary: 'YESTERDAY', secondary };
  return {
    primary: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase(),
    secondary,
  };
}

// ── Derived journal entry ─────────────────────────────────────────────────────

interface JournalEntry {
  raw: DailyJournal;
  symptoms: string[];
  sleepHours: number | null;
}

function enrichJournals(journals: DailyJournal[]): JournalEntry[] {
  return [...journals]
    .sort(
      (a, b) =>
        new Date(b.journal_date).getTime() - new Date(a.journal_date).getTime(),
    )
    .map((j) => ({
      raw: j,
      symptoms: parseSymptoms(j.symptoms),
      sleepHours: parseSleep(j.sleep_hours),
    }));
}

// ── 7-day rolling averages ────────────────────────────────────────────────────

interface RollingAverages {
  sleep: number | null;
  energy: number | null;
  mood: number | null;
  entryCount: number;
}

function rollingAverages(entries: JournalEntry[], days = 7): RollingAverages {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const window = entries.filter(
    (e) => new Date(e.raw.journal_date).getTime() >= cutoff,
  );

  const avg = (nums: number[]) =>
    nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;

  const sleeps = window.map((e) => e.sleepHours).filter((v): v is number => v !== null);
  const energies = window.map((e) => e.raw.energy_score).filter((v): v is number => v !== null);
  const moods = window
    .map((e) => (e.raw.mood ? MOOD_CONFIG[e.raw.mood].score : null))
    .filter((v): v is number => v !== null);

  return { sleep: avg(sleeps), energy: avg(energies), mood: avg(moods), entryCount: window.length };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AvgCard({
  label,
  value,
  unit,
  color,
  subtext,
}: {
  label: string;
  value: string | null;
  unit?: string;
  color: string;
  subtext?: string;
}) {
  return (
    <div className="flex flex-col gap-1 border border-zinc-800 bg-zinc-900 px-4 py-3">
      <span className="font-mono text-[10px] tracking-widest text-zinc-400">{label}</span>
      {value !== null ? (
        <span className={`font-mono text-xl font-bold tabular-nums ${color}`}>
          {value}
          {unit && <span className="ml-0.5 font-mono text-xs font-normal text-zinc-400">{unit}</span>}
        </span>
      ) : (
        <span className="font-mono text-xl font-bold text-zinc-600">—</span>
      )}
      {subtext && (
        <span className="font-mono text-[10px] tracking-widest text-zinc-500">{subtext}</span>
      )}
    </div>
  );
}

function MoodBar({ mood }: { mood: Mood }) {
  const cfg = MOOD_CONFIG[mood];
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-0.5">
        {([1, 2, 3, 4, 5] as const).map((i) => (
          <div
            key={i}
            className={`h-2 w-2 ${i <= cfg.score ? cfg.bar : 'bg-white/[0.06]'}`}
          />
        ))}
      </div>
      <span className={`font-mono text-[11px] font-semibold tracking-wide ${cfg.text}`}>
        {cfg.label}
      </span>
    </div>
  );
}

function EnergyBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-24 overflow-hidden bg-white/[0.06]">
        <div
          className={`h-full transition-all ${energyBarColor(score)}`}
          style={{ width: `${score * 10}%` }}
        />
      </div>
      <span className={`font-mono text-xs font-semibold tabular-nums ${energyColor(score)}`}>
        {score}/10
      </span>
    </div>
  );
}

function SymptomChips({ symptoms }: { symptoms: string[] }) {
  if (symptoms.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {symptoms.map((s, i) => (
        <span
          key={i}
          className="rounded-sm border border-amber-500/20 bg-amber-500/[0.06] px-2 py-0.5 font-mono text-[10px] tracking-wide text-amber-400"
        >
          {s}
        </span>
      ))}
    </div>
  );
}

function JournalCard({ entry, onRefresh }: { entry: JournalEntry; onRefresh: () => void }) {
  const { raw, symptoms, sleepHours } = entry;
  const { primary, secondary } = formatCardDate(raw.journal_date);
  const hasMeta = raw.mood || raw.energy_score !== null || sleepHours !== null;
  const moodCfg = raw.mood ? MOOD_CONFIG[raw.mood] : null;
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteEntry('journal', raw.id);
      onRefresh();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <article
      className={`group flex flex-col gap-4 border border-zinc-800 bg-zinc-900 p-5 ${moodCfg?.bg ?? ''}`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm font-bold text-zinc-100">{primary}</p>
          <p className="font-mono text-[10px] tracking-widest text-zinc-400">{secondary}</p>
        </div>

        <div className="flex items-start gap-4">
          {hasMeta && (
            <div className="flex flex-col gap-2">
              {raw.mood && <MoodBar mood={raw.mood} />}
              {raw.energy_score !== null && <EnergyBar score={raw.energy_score} />}
              {sleepHours !== null && (
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] tracking-widest text-zinc-400">SLEEP</span>
                  <span className="font-mono text-xs font-semibold tabular-nums text-zinc-300">
                    {sleepHours}h
                  </span>
                </div>
              )}
            </div>
          )}
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="opacity-0 group-hover:opacity-100 transition-opacity font-mono text-sm text-zinc-500 hover:text-rose-400 disabled:text-zinc-600 mt-0.5"
            title="Delete this journal entry"
          >
            {deleting ? '…' : '×'}
          </button>
        </div>
      </div>

      {/* Notes */}
      <p className="text-sm leading-relaxed text-zinc-300 whitespace-pre-wrap">{raw.notes}</p>

      {/* Symptoms */}
      <SymptomChips symptoms={symptoms} />

      {/* Training / nutrition */}
      {(raw.training || raw.nutrition) && (
        <div className="flex flex-col gap-1 border-t border-white/[0.06] pt-3">
          {raw.training && (
            <div className="flex gap-2">
              <span className="w-16 flex-none font-mono text-[10px] tracking-widest text-zinc-400">
                TRAINING
              </span>
              <span className="text-xs text-zinc-400">{raw.training}</span>
            </div>
          )}
          {raw.nutrition && (
            <div className="flex gap-2">
              <span className="w-16 flex-none font-mono text-[10px] tracking-widest text-zinc-400">
                NUTRITION
              </span>
              <span className="text-xs text-zinc-400">{raw.nutrition}</span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

type MoodFilter = Mood | 'all';

export default function JournalPanel({ journals, isLoading, onRefresh }: JournalPanelProps) {
  const [moodFilter, setMoodFilter] = useState<MoodFilter>('all');

  const entries = useMemo(() => enrichJournals(journals), [journals]);
  const avgs = useMemo(() => rollingAverages(entries, 7), [entries]);

  const filtered = useMemo(() => {
    if (moodFilter === 'all') return entries;
    return entries.filter((e) => e.raw.mood === moodFilter);
  }, [entries, moodFilter]);

  const symptomFreq = useMemo(() => {
    const freq = new Map<string, number>();
    for (const e of entries) {
      for (const s of e.symptoms) {
        freq.set(s, (freq.get(s) ?? 0) + 1);
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [entries]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center font-mono text-xs tracking-widest text-zinc-500">
        LOADING JOURNAL ENTRIES…
      </div>
    );
  }

  if (journals.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
          </svg>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <p className="font-mono text-xs font-semibold tracking-widest text-zinc-300">NO JOURNAL ENTRIES</p>
          <p className="font-mono text-[10px] tracking-widest text-zinc-500">Log a daily check-in to begin tracking</p>
        </div>
      </div>
    );
  }

  const moodScoreToLabel = (score: number): string => {
    const rounded = Math.round(score);
    return Object.values(MOOD_CONFIG).find((c) => c.score === rounded)?.label ?? '—';
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Active PK clearance board — renders nothing when empty */}
      <ActiveTrackingBoard />

      {/* Summary row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <AvgCard
          label="7-DAY AVG SLEEP"
          value={avgs.sleep !== null ? avgs.sleep.toFixed(1) : null}
          unit="h"
          color="text-cyan-400"
          subtext={`${avgs.entryCount} ENTRIES THIS WEEK`}
        />
        <AvgCard
          label="7-DAY AVG ENERGY"
          value={avgs.energy !== null ? avgs.energy.toFixed(1) : null}
          unit="/10"
          color={avgs.energy !== null ? energyColor(Math.round(avgs.energy)) : 'text-zinc-400'}
          subtext="ROLLING SCORE"
        />
        <AvgCard
          label="7-DAY AVG MOOD"
          value={avgs.mood !== null ? moodScoreToLabel(avgs.mood) : null}
          color={
            avgs.mood !== null
              ? MOOD_CONFIG[
                  (Object.entries(MOOD_CONFIG).find(
                    ([, v]) => v.score === Math.round(avgs.mood!),
                  )?.[0] as Mood) ?? 'neutral'
                ].text
              : 'text-zinc-400'
          }
          subtext="BASED ON LOGGED DAYS"
        />
        <AvgCard
          label="TOTAL ENTRIES"
          value={String(journals.length)}
          color="text-zinc-200"
          subtext={symptomFreq.length ? `TOP: ${symptomFreq[0][0].toUpperCase()}` : 'NO SYMPTOMS LOGGED'}
        />
      </div>

      {/* Top symptoms */}
      {symptomFreq.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border border-white/10 bg-zinc-950 px-4 py-3">
          <span className="font-mono text-[10px] tracking-widest text-zinc-400">
            FREQUENT SYMPTOMS:
          </span>
          {symptomFreq.map(([s, count]) => (
            <span
              key={s}
              className="rounded-sm border border-amber-500/20 bg-amber-500/[0.06] px-2 py-0.5 font-mono text-[10px] tracking-wide text-amber-400"
            >
              {s}
              <span className="ml-1 opacity-60">×{count}</span>
            </span>
          ))}
        </div>
      )}

      {/* Mood filter + entry count */}
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] tracking-widest text-zinc-400">
          {filtered.length} OF {journals.length} ENTRIES
        </p>
        <select
          value={moodFilter}
          onChange={(e) => setMoodFilter(e.target.value as MoodFilter)}
          className="border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-[11px] tracking-widest text-zinc-300 transition-colors focus:border-cyan-400/50 focus:outline-none"
        >
          <option value="all" className="bg-black">ALL MOODS</option>
          {(Object.entries(MOOD_CONFIG) as [Mood, (typeof MOOD_CONFIG)[Mood]][]).map(
            ([key, cfg]) => (
              <option key={key} value={key} className="bg-black">
                {cfg.label.toUpperCase()}
              </option>
            ),
          )}
        </select>
      </div>

      {/* Entry feed */}
      {filtered.length === 0 ? (
        <p className="py-10 text-center font-mono text-xs tracking-widest text-zinc-500">
          NO ENTRIES MATCH CURRENT FILTER
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((entry) => (
            <li key={entry.raw.id}>
              <JournalCard entry={entry} onRefresh={onRefresh} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
