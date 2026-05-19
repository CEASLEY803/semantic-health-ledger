'use client';

import { useState, useCallback } from 'react';
import ChatPanel from '@/components/chat/ChatPanel';
import Dashboard from '@/components/dashboard/Dashboard';
import type { ChatIngestResponse } from '@/lib/types';

export default function Home() {
  const [refreshKey, setRefreshKey] = useState(0);

  const handleIngestSuccess = useCallback((_response: ChatIngestResponse) => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-gray-950 text-gray-100">
      {/* Left: chat */}
      <section className="flex w-[420px] flex-none flex-col border-r border-gray-800">
        <ChatPanel onIngestSuccess={handleIngestSuccess} />
      </section>

      {/* Right: dashboard */}
      <section className="min-w-0 flex-1 overflow-y-auto">
        <Dashboard refreshKey={refreshKey} />
      </section>
    </main>
  );
}
