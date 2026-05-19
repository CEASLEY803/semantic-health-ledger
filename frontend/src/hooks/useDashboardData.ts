'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fetchBiometrics,
  fetchCompounds,
  fetchJournals,
  fetchLabResults,
} from '@/lib/api';
import type { BiometricLog, CompoundLog, DailyJournal, LabResult } from '@/lib/types';

interface DashboardData {
  labs: LabResult[];
  biometrics: BiometricLog[];
  compounds: CompoundLog[];
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
  compounds: [],
  journals: [],
};

// refreshKey is incremented by page.tsx after every successful chat ingest.
// Changing it triggers a full re-fetch of all four history endpoints.
export function useDashboardData(refreshKey: number): UseDashboardDataResult {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [internalKey, setInternalKey] = useState(refreshKey);

  const refetch = useCallback(() => {
    setInternalKey((k) => k + 1);
  }, []);

  // Keep internalKey in sync when the parent increments refreshKey
  useEffect(() => {
    setInternalKey(refreshKey);
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    Promise.all([
      fetchLabResults(),
      fetchBiometrics(),
      fetchCompounds(),
      fetchJournals(),
    ])
      .then(([labs, biometrics, compounds, journals]) => {
        if (!cancelled) {
          setData({ labs, biometrics, compounds, journals });
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
  }, [internalKey]);

  return { ...data, isLoading, error, refetch };
}
