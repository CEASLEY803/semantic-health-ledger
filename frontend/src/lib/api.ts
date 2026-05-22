import type {
  BiometricLog,
  ChatIngestResponse,
  ClinicalNode,
  CompoundLog,
  DailyJournal,
  LabResult,
  MorningBriefing,
  RegimenItem,
} from './types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export async function postChatIngest(text: string, loggingEnabled = true): Promise<ChatIngestResponse> {
  return apiFetch<ChatIngestResponse>('/api/v1/chat/ingest', {
    method: 'POST',
    body: JSON.stringify({ text, logging_enabled: loggingEnabled }),
  });
}

// ── History reads ─────────────────────────────────────────────────────────────

export async function fetchLabResults(limit = 500): Promise<LabResult[]> {
  return apiFetch<LabResult[]>(
    `/api/v1/get/history?entry_type=lab_result&limit=${limit}`,
  );
}

export async function fetchBiometrics(limit = 500): Promise<BiometricLog[]> {
  return apiFetch<BiometricLog[]>(
    `/api/v1/get/history?entry_type=biometric&limit=${limit}`,
  );
}

export async function fetchCompounds(limit = 100): Promise<CompoundLog[]> {
  return apiFetch<CompoundLog[]>(
    `/api/v1/get/history?entry_type=compound&limit=${limit}`,
  );
}

export async function fetchJournals(limit = 50): Promise<DailyJournal[]> {
  return apiFetch<DailyJournal[]>(
    `/api/v1/get/history?entry_type=daily_journal&limit=${limit}`,
  );
}

// ── Entry update ─────────────────────────────────────────────────────────────

export async function updateEntry(
  entryType: 'biometric' | 'compound' | 'lab' | 'journal',
  id: string,
  fieldName: string,
  newValue: string,
): Promise<void> {
  await apiFetch(`/api/v1/entry/${entryType}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ field_name: fieldName, new_value: newValue }),
  });
}

// ── Entry deletion ────────────────────────────────────────────────────────────

export async function deleteEntry(
  entryType: 'biometric' | 'compound' | 'lab' | 'journal',
  id: string,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/entry/${entryType}/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Delete failed ${res.status}: ${body}`);
  }
}

export async function clearChatHistory(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/chat/history`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Clear failed ${res.status}: ${body}`);
  }
}

// ── Regimen ───────────────────────────────────────────────────────────────────

export async function fetchRegimen(): Promise<RegimenItem[]> {
  return apiFetch<RegimenItem[]>('/api/v1/regimen');
}

export async function deleteRegimenItem(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/regimen/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Delete failed ${res.status}: ${body}`);
  }
}

// ── Knowledge Graph / Morning Briefing ───────────────────────────────────────

export async function fetchMorningBriefing(): Promise<MorningBriefing> {
  return apiFetch<MorningBriefing>('/api/v1/insights/morning-briefing');
}

export async function fetchActiveTracking(): Promise<ClinicalNode[]> {
  return apiFetch<ClinicalNode[]>('/api/v1/insights/active-tracking');
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function fetchHealth(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>('/api/v1/health');
}

// ── Garmin sync ───────────────────────────────────────────────────────────────

export interface GarminSyncResult {
  dates_synced: number;
  synced: Array<{ metric_name: string; value: number; unit: string; date: string }>;
  skipped: string[];
  errors: string[];
}

export async function syncGarmin(opts: { force?: boolean; days?: number } = {}): Promise<GarminSyncResult> {
  const params = new URLSearchParams();
  if (opts.force) params.set('force', 'true');
  if (opts.days)  params.set('days',  String(opts.days));
  const qs = params.toString();
  return apiFetch<GarminSyncResult>(`/api/v1/sync/garmin${qs ? `?${qs}` : ''}`, { method: 'POST' });
}
