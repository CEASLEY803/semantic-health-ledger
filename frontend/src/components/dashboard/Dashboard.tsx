'use client';

import { useState } from 'react';
import { useDashboardData } from '@/hooks/useDashboardData';
import LabsPanel from './LabsPanel';
import BiometricsPanel from './BiometricsPanel';
import CompoundsPanel from './CompoundsPanel';
import JournalPanel from './JournalPanel';

type Tab = 'labs' | 'biometrics' | 'compounds' | 'journal';

const TABS: { id: Tab; label: string }[] = [
  { id: 'labs', label: 'Labs' },
  { id: 'biometrics', label: 'Biometrics' },
  { id: 'compounds', label: 'Compounds' },
  { id: 'journal', label: 'Journal' },
];

interface DashboardProps {
  refreshKey: number;
}

export default function Dashboard({ refreshKey }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<Tab>('labs');
  const { labs, biometrics, compounds, journals, isLoading, error } =
    useDashboardData(refreshKey);

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <nav className="flex border-b border-gray-800 bg-gray-950 px-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-blue-500 text-blue-400'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="border-b border-red-900 bg-red-950/40 px-4 py-2 text-xs text-red-400">
          Dashboard error: {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'labs' && (
          <LabsPanel labs={labs} isLoading={isLoading} />
        )}
        {activeTab === 'biometrics' && (
          <BiometricsPanel biometrics={biometrics} isLoading={isLoading} />
        )}
        {activeTab === 'compounds' && (
          <CompoundsPanel compounds={compounds} isLoading={isLoading} />
        )}
        {activeTab === 'journal' && (
          <JournalPanel journals={journals} isLoading={isLoading} />
        )}
      </div>
    </div>
  );
}
