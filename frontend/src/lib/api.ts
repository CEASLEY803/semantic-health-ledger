import type {
  BiometricLog,
  ChatIngestResponse,
  CompoundLog,
  DailyJournal,
  LabResult,
} from './types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

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

export async function postChatIngest(text: string): Promise<ChatIngestResponse> {
  return apiFetch<ChatIngestResponse>('/api/v1/chat/ingest', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

// ── History reads ─────────────────────────────────────────────────────────────

export async function fetchLabResults(limit = 100): Promise<LabResult[]> {
  return apiFetch<LabResult[]>(
    `/api/v1/get/history?entry_type=lab_result&limit=${limit}`,
  );
}

export async function fetchBiometrics(limit = 100): Promise<BiometricLog[]> {
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

// ── Health ────────────────────────────────────────────────────────────────────

export async function fetchHealth(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>('/api/v1/health');
}
