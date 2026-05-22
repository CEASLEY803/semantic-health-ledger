'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fetchBiometrics,
  fetchJournals,
  fetchLabResults,
  fetchRegimen,
} from '@/lib/api';
import type { BiometricLog, DailyJournal, LabResult, RegimenItem } from '@/lib/types';

interface DashboardData {
  labs: LabResult[];
  biometrics: BiometricLog[];
  regimen: RegimenItem[];
  journals: DailyJournal[];
}

interface UseDashboardDataResult extends DashboardData {
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const EMPTY: DashboardData = {
  labs: [],
  biometrics: [],
  regimen: [],
  journals: [],
};

// refreshKey is incremented by page.tsx after every successful chat ingest.
// manualKey is incremented by refetch() for UI-triggered refreshes (e.g. delete).
// Both are direct dependencies so the fetch fires in a single render cycle.
export function useDashboardData(refreshKey: number): UseDashboardDataResult {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualKey, setManualKey] = useState(0);

  const refetch = useCallback(() => setManualKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    Promise.all([
      fetchLabResults(),
      fetchBiometrics(),
      fetchRegimen(),
      fetchJournals(),
    ])
      .then(([labs, biometrics, regimen, journals]) => {
        if (!cancelled) {
          setData({ labs, biometrics, regimen, journals });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey, manualKey]);

  return { ...data, isLoading, error, refetch };
}
