'use client';

import { useState } from 'react';
import { useDashboardData } from '@/hooks/useDashboardData';
import LabsPanel from './LabsPanel';
import BiometricsPanel from './BiometricsPanel';
import CompoundsPanel from './CompoundsPanel';
import JournalPanel from './JournalPanel';
import LedgerThoughtsCard from './LedgerThoughtsCard';

type Tab = 'labs' | 'biometrics' | 'compounds' | 'journal';

const TABS: { id: Tab; label: string }[] = [
  { id: 'labs', label: 'LABS' },
  { id: 'biometrics', label: 'BIOMETRICS' },
  { id: 'compounds', label: 'COMPOUNDS' },
  { id: 'journal', label: 'JOURNAL' },
];

interface DashboardProps {
  refreshKey: number;
}

export default function Dashboard({ refreshKey }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<Tab>('labs');
  const { labs, biometrics, regimen, journals, isLoading, error, refetch } =
    useDashboardData(refreshKey);

  return (
    <div className="flex h-full flex-col">
      {/* Knowledge Graph — overnight synthesis insights */}
      <LedgerThoughtsCard refreshKey={refreshKey} />

      {/* Tab bar */}
      <nav className="flex shrink-0 border-b border-zinc-800 bg-zinc-950 px-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-3 font-mono text-[11px] font-semibold tracking-widest transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-cyan-400 bg-cyan-950/40 text-cyan-400'
                : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="shrink-0 border-b border-rose-500/20 bg-rose-500/5 px-4 py-2 font-mono text-xs text-rose-400 tracking-wide">
          ERR // {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'labs' && <LabsPanel labs={labs} isLoading={isLoading} onRefresh={refetch} />}
        {activeTab === 'biometrics' && <BiometricsPanel biometrics={biometrics} isLoading={isLoading} onRefresh={refetch} />}
        {activeTab === 'compounds' && <CompoundsPanel regimen={regimen} isLoading={isLoading} onRefresh={refetch} />}
        {activeTab === 'journal' && <JournalPanel journals={journals} isLoading={isLoading} onRefresh={refetch} />}
      </div>
    </div>
  );
}
