'use client';

import { useMemo, useState } from 'react';
import type { DailyJournal, Mood } from '@/lib/types';

interface JournalPanelProps {
  journals: DailyJournal[];
  isLoading: boolean;
}

// ── Schema coercion ───────────────────────────────────────────────────────────
// SQLite returns sleep_hours as a string and symptoms as a JSON string.

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
  very_low: { label: 'Very Low', score: 1, bar: 'bg-red-500',    text: 'text-red-400',    bg: 'bg-red-950/30' },
  low:      { label: 'Low',      score: 2, bar: 'bg-orange-500', text: 'text-orange-400', bg: 'bg-orange-950/30' },
  neutral:  { label: 'Neutral',  score: 3, bar: 'bg-yellow-500', text: 'text-yellow-400', bg: 'bg-yellow-950/20' },
  good:     { label: 'Good',     score: 4, bar: 'bg-emerald-500',text: 'text-emerald-400',bg: 'bg-emerald-950/30' },
  very_good:{ label: 'Very Good',score: 5, bar: 'bg-blue-500',   text: 'text-blue-400',   bg: 'bg-blue-950/30' },
};

// ── Energy config ─────────────────────────────────────────────────────────────

function energyColor(score: number): string {
  if (score <= 3) return 'text-red-400';
  if (score <= 5) return 'text-orange-400';
  if (score <= 7) return 'text-yellow-400';
  return 'text-emerald-400';
}

function energyBarColor(score: number): string {
  if (score <= 3) return 'bg-red-500';
  if (score <= 5) return 'bg-orange-500';
  if (score <= 7) return 'bg-yellow-500';
  return 'bg-emerald-500';
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

  if (sameDay(d, today)) return { primary: 'Today', secondary };
  if (sameDay(d, yesterday)) return { primary: 'Yesterday', secondary };
  return {
    primary: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    secondary,
  };
}

// ── Derived journal entry (coerced + enriched) ────────────────────────────────

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
  const energies = window
    .map((e) => e.raw.energy_score)
    .filter((v): v is number => v !== null);
  const moods = window
    .map((e) => (e.raw.mood ? MOOD_CONFIG[e.raw.mood].score : null))
    .filter((v): v is number => v !== null);

  return {
    sleep: avg(sleeps),
    energy: avg(energies),
    mood: avg(moods),
    entryCount: window.length,
  };
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
    <div className="flex flex-col gap-0.5 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
      <span className="text-xs text-gray-500">{label}</span>
      {value !== null ? (
        <span className={`text-xl font-bold tabular-nums ${color}`}>
          {value}
          {unit && <span className="ml-0.5 text-sm font-normal text-gray-500">{unit}</span>}
        </span>
      ) : (
        <span className="text-xl font-bold text-gray-700">—</span>
      )}
      {subtext && <span className="text-[11px] text-gray-600">{subtext}</span>}
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
            className={`h-2.5 w-2.5 rounded-sm ${
              i <= cfg.score ? cfg.bar : 'bg-gray-800'
            }`}
          />
        ))}
      </div>
      <span className={`text-xs font-semibold ${cfg.text}`}>{cfg.label}</span>
    </div>
  );
}

function EnergyBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-800">
        <div
          className={`h-full rounded-full transition-all ${energyBarColor(score)}`}
          style={{ width: `${score * 10}%` }}
        />
      </div>
      <span className={`font-mono text-xs font-semibold ${energyColor(score)}`}>
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
          className="rounded-full border border-amber-900/60 bg-amber-950/30 px-2.5 py-0.5 text-[11px] font-medium text-amber-400"
        >
          {s}
        </span>
      ))}
    </div>
  );
}

function JournalCard({ entry }: { entry: JournalEntry }) {
  const { raw, symptoms, sleepHours } = entry;
  const { primary, secondary } = formatCardDate(raw.journal_date);
  const hasMeta = raw.mood || raw.energy_score !== null || sleepHours !== null;
  const moodCfg = raw.mood ? MOOD_CONFIG[raw.mood] : null;

  return (
    <article
      className={`flex flex-col gap-4 rounded-lg border bg-gray-900 p-5 ${
        moodCfg ? `border-gray-800 ${moodCfg.bg}` : 'border-gray-800'
      }`}
    >
      {/* Header: date + quick stats */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-base font-bold text-gray-100">{primary}</p>
          <p className="text-xs text-gray-500">{secondary}</p>
        </div>

        {hasMeta && (
          <div className="flex flex-col gap-2">
            {raw.mood && <MoodBar mood={raw.mood} />}
            {raw.energy_score !== null && <EnergyBar score={raw.energy_score} />}
            {sleepHours !== null && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-600">Sleep</span>
                <span className="font-mono text-xs font-semibold text-gray-300">
                  {sleepHours}h
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Notes — primary content */}
      <p className="text-sm leading-relaxed text-gray-300 whitespace-pre-wrap">
        {raw.notes}
      </p>

      {/* Symptoms */}
      <SymptomChips symptoms={symptoms} />

      {/* Optional: training / nutrition as collapsed metadata */}
      {(raw.training || raw.nutrition) && (
        <div className="flex flex-col gap-1 border-t border-gray-800 pt-3 text-xs">
          {raw.training && (
            <div className="flex gap-2">
              <span className="w-16 flex-none text-gray-600">Training</span>
              <span className="text-gray-400">{raw.training}</span>
            </div>
          )}
          {raw.nutrition && (
            <div className="flex gap-2">
              <span className="w-16 flex-none text-gray-600">Nutrition</span>
              <span className="text-gray-400">{raw.nutrition}</span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

type MoodFilter = Mood | 'all';

export default function JournalPanel({ journals, isLoading }: JournalPanelProps) {
  const [moodFilter, setMoodFilter] = useState<MoodFilter>('all');

  const entries = useMemo(() => enrichJournals(journals), [journals]);
  const avgs = useMemo(() => rollingAverages(entries, 7), [entries]);

  const filtered = useMemo(() => {
    if (moodFilter === 'all') return entries;
    return entries.filter((e) => e.raw.mood === moodFilter);
  }, [entries, moodFilter]);

  // Collect every unique symptom across all entries for a quick frequency map
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
      <div className="flex h-40 items-center justify-center text-sm text-gray-500">
        Loading journal entries…
      </div>
    );
  }

  if (journals.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-gray-600">
        No journal entries yet. Use the chat panel to log a daily check-in.
      </div>
    );
  }

  // Mood score → label for the average display
  const moodScoreToLabel = (score: number): string => {
    const rounded = Math.round(score);
    return (
      Object.values(MOOD_CONFIG).find((c) => c.score === rounded)?.label ?? '—'
    );
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ── Summary row ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <AvgCard
          label="7-Day Avg Sleep"
          value={avgs.sleep !== null ? avgs.sleep.toFixed(1) : null}
          unit="h"
          color="text-blue-400"
          subtext={`${avgs.entryCount} entries this week`}
        />
        <AvgCard
          label="7-Day Avg Energy"
          value={avgs.energy !== null ? avgs.energy.toFixed(1) : null}
          unit="/10"
          color={avgs.energy !== null ? energyColor(Math.round(avgs.energy)) : 'text-gray-400'}
          subtext="rolling score"
        />
        <AvgCard
          label="7-Day Avg Mood"
          value={avgs.mood !== null ? moodScoreToLabel(avgs.mood) : null}
          color={
            avgs.mood !== null
              ? MOOD_CONFIG[
                  (Object.entries(MOOD_CONFIG).find(
                    ([, v]) => v.score === Math.round(avgs.mood!),
                  )?.[0] as Mood) ?? 'neutral'
                ].text
              : 'text-gray-400'
          }
          subtext="based on logged days"
        />
        <AvgCard
          label="Total Entries"
          value={String(journals.length)}
          color="text-gray-200"
          subtext={
            symptomFreq.length
              ? `Top: ${symptomFreq[0][0]}`
              : 'No symptoms logged'
          }
        />
      </div>

      {/* ── Top symptoms ── */}
      {symptomFreq.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
          <span className="text-xs text-gray-500">Most frequent symptoms:</span>
          {symptomFreq.map(([s, count]) => (
            <span
              key={s}
              className="rounded-full border border-amber-900/60 bg-amber-950/30 px-2.5 py-0.5 text-[11px] font-medium text-amber-400"
            >
              {s}
              <span className="ml-1 opacity-60">×{count}</span>
            </span>
          ))}
        </div>
      )}

      {/* ── Mood filter ── */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600">
          {filtered.length} of {journals.length} entries
        </p>
        <select
          value={moodFilter}
          onChange={(e) => setMoodFilter(e.target.value as MoodFilter)}
          className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300 focus:outline-none"
        >
          <option value="all">All Moods</option>
          {(Object.entries(MOOD_CONFIG) as [Mood, (typeof MOOD_CONFIG)[Mood]][]).map(
            ([key, cfg]) => (
              <option key={key} value={key}>
                {cfg.label}
              </option>
            ),
          )}
        </select>
      </div>

      {/* ── Entry feed ── */}
      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-600">
          No entries match the current filter.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {filtered.map((entry) => (
            <li key={entry.raw.id}>
              <JournalCard entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
