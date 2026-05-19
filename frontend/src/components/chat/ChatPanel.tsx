'use client';

import { useState, useRef, useEffect } from 'react';
import { useChatIngest } from '@/hooks/useChatIngest';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import type { ChatIngestResponse, ChatMessage } from '@/lib/types';

interface ChatPanelProps {
  onIngestSuccess: (response: ChatIngestResponse) => void;
}

export default function ChatPanel({ onIngestSuccess }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { submit, isPending, error } = useChatIngest(onIngestSuccess);

  const handleSubmit = async (text: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await submit(text);
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: buildAssistantSummary(response),
        ledger_response: response.ledger_response,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      // error state is surfaced via useChatIngest
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-gray-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-gray-300">
          Health Ledger — AI Ingest
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <MessageList messages={messages} />
        <div ref={bottomRef} />
      </div>

      {error && (
        <p className="px-4 py-1 text-xs text-red-400">{error}</p>
      )}

      <div className="border-t border-gray-800 p-3">
        <ChatInput onSubmit={handleSubmit} disabled={isPending} />
      </div>
    </div>
  );
}

function buildAssistantSummary(response: ChatIngestResponse): string {
  const c = response.ledger_response?.committed;
  if (!c) return 'Logged.';
  const parts: string[] = [];
  if (c.compound_logs) parts.push(`${c.compound_logs} compound(s)`);
  if (c.biometric_logs) parts.push(`${c.biometric_logs} biometric(s)`);
  if (c.lab_results) parts.push(`${c.lab_results} lab result(s)`);
  if (c.daily_journals) parts.push(`${c.daily_journals} journal entry(s)`);
  return parts.length ? `Logged: ${parts.join(', ')}.` : 'Processed — nothing new to commit.';
}
