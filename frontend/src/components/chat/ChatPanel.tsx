'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChatIngest } from '@/hooks/useChatIngest';
import { useCheckIn } from '@/hooks/useCheckIn';
import { usePdfIngest } from '@/hooks/usePdfIngest';
import { useTelemetry } from '@/hooks/useTelemetry';
import type { TelemetryData } from '@/hooks/useTelemetry';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import { MarkdownContent } from './ChatBubble';
import type { ChatHistoryRow, ChatIngestResponse, ChatMessage } from '@/lib/types';

interface ChatPanelProps {
  onIngestSuccess: (response: ChatIngestResponse) => void;
  droppedPath?: string | null;
  onPathConsumed?: () => void;
  droppedFile?: File | null;
  onFileConsumed?: () => void;
}

// ── Telemetry footer helpers ───────────────────────────────────────────────────

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function MetricPill({
  label,
  value,
  alert = false,
  warn = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
  warn?: boolean;
}) {
  const valueColor = alert
    ? 'text-rose-500'
    : warn
      ? 'text-amber-400'
      : 'text-zinc-500';
  return (
    <span className="font-mono text-[10px] tracking-widest">
      <span className="text-zinc-600">{label} </span>
      <span className={valueColor}>{value}</span>
    </span>
  );
}

function TelemetryFooter({ data, online }: { data: TelemetryData | null; online: boolean }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-t border-zinc-800/60 bg-zinc-950/40 px-4 py-2">
        <div className="flex items-center gap-2">
          <div
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              online
                ? 'bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.7)]'
                : 'bg-rose-500'
            }`}
          />
          <span className="font-mono text-[10px] tracking-widest text-zinc-500">
            ENGINE {online ? 'ONLINE' : 'OFFLINE'}
            {data ? ` · UP ${formatUptime(data.uptime_s)}` : ''}
          </span>
        </div>
        {data ? (
          <span className="font-mono text-[10px] tracking-widest text-zinc-600">
            {data.records_today} LOG{data.records_today !== 1 ? 'S' : ''} ·{' '}
            {data.api_calls_today} CALL{data.api_calls_today !== 1 ? 'S' : ''} TODAY
          </span>
        ) : (
          <span className="font-mono text-[10px] tracking-widest text-zinc-700">—</span>
        )}
      </div>
      <div className="flex items-center gap-5 border-t border-zinc-800/30 bg-zinc-950/70 px-4 py-1.5">
        {data ? (
          <>
            <MetricPill label="CPU" value={`${data.cpu_pct.toFixed(1)}%`} alert={data.cpu_pct > 5} />
            <MetricPill label="MEM" value={`${data.mem_mb} MB`} warn={data.mem_mb > 300} alert={data.mem_mb > 500} />
            <MetricPill label="DB" value={`${data.db_mb} MB`} />
          </>
        ) : (
          <span className="font-mono text-[10px] tracking-widest text-zinc-700">
            {online ? 'POLLING…' : 'CONNECT BACKEND TO START'}
          </span>
        )}
      </div>
    </div>
  );
}

// ── <think> parser ────────────────────────────────────────────────────────────

interface ParsedResponse {
  thinking: string;
  response: string;
}

function parseThinkTags(text: string): ParsedResponse {
  // Strip <tool_code> artifacts (Gemini 2.5 Pro echoes function calls as pseudo-code)
  const stripped = text.replace(/<tool_code[\s\S]*?<\/tool_code>/g, '').trim();

  // Normalize all variant tag names → <think>
  const normalized = stripped
    .replace(/<thinking>/g, '<think>').replace(/<\/thinking>/g, '</think>')
    .replace(/<thought>/g,  '<think>').replace(/<\/thought>/g,  '</think>');

  // Collect ALL <think>...</think> blocks — Phase 1 streaming and Phase 2 post-tool
  // each produce their own block; we need to handle both.
  const thinkParts: string[] = [];
  const responseParts: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0) {
    const openIdx = remaining.indexOf('<think>');
    if (openIdx === -1) {
      const tail = remaining.trim();
      if (tail) responseParts.push(tail);
      break;
    }
    // Content before <think> is response text
    const before = remaining.slice(0, openIdx).trim();
    if (before) responseParts.push(before);

    const closeIdx = remaining.indexOf('</think>', openIdx + 7);
    if (closeIdx === -1) {
      // Unclosed — still streaming; rest is thinking
      thinkParts.push(remaining.slice(openIdx + 7).trim());
      break;
    }
    thinkParts.push(remaining.slice(openIdx + 7, closeIdx).trim());
    remaining = remaining.slice(closeIdx + 8);
  }

  return {
    thinking: thinkParts.filter(Boolean).join('\n\n---\n\n'),
    response: responseParts.filter(Boolean).join('\n\n'),
  };
}

// Resolves a completed (non-streaming) model response into { text, thinkingText }.
// When the model puts its entire reply inside <think>...</think> with nothing after,
// we surface the thinking content as the main response rather than falling back to
// raw markup or showing "No response received."
function resolveCommittedMessage(raw: string): { text: string; thinkingText?: string } {
  const { thinking, response } = parseThinkTags(raw);
  if (response) {
    return { text: response, thinkingText: thinking || undefined };
  }
  if (thinking) {
    // Model put everything inside think tags — surface as response without reasoning section
    return { text: thinking };
  }
  // Strip any residual markup for the last-resort fallback
  const stripped = raw
    .replace(/<tool_code[\s\S]*?<\/tool_code>/g, '')
    .replace(/<(think|thinking|thought)[^>]*>[\s\S]*?<\/(think|thinking|thought)>/g, '')
    .trim();
  return { text: stripped || 'No response received.' };
}

// ── Pipeline status indicator ─────────────────────────────────────────────────

function PipelineStatus({ msg }: { msg: string | null }) {
  return (
    <div className="mt-3 flex justify-start">
      <div className="border-l-2 border-cyan-500/50 bg-zinc-900/80 py-2.5 pl-3.5 pr-5 ring-1 ring-zinc-800/60">
        <p className="mb-1.5 font-mono text-[9px] tracking-widest text-cyan-500/60">LEDGER</p>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-cyan-400">{'>'}</span>
          <span className="font-mono text-xs text-zinc-400">{msg ?? 'Initializing...'}</span>
          <span className="animate-pulse font-mono text-sm text-emerald-400">_</span>
        </div>
      </div>
    </div>
  );
}

// ── Streaming response bubble ─────────────────────────────────────────────────

function StreamingBubble({ text }: { text: string }) {
  const { thinking, response } = parseThinkTags(text);
  return (
    <div className="mt-3 flex justify-start">
      <div className="max-w-[85%] border-l-2 border-emerald-500/40 bg-zinc-900/80 py-2.5 pl-3.5 pr-5 ring-1 ring-zinc-800/60">
        <p className="mb-2 font-mono text-[9px] tracking-widest text-emerald-500/60">LEDGER</p>
        {thinking && (
          <div className="mb-3 border-l border-zinc-700/60 pl-3">
            <p className="mb-1 font-mono text-[9px] tracking-widest text-zinc-600">
              CLINICAL REASONING
            </p>
            <p className="whitespace-pre-wrap text-xs italic text-zinc-600">{thinking}</p>
          </div>
        )}
        {response && (
          <MarkdownContent text={response} className="text-zinc-100" />
        )}
        {!response && !thinking && (
          <span className="animate-pulse font-mono text-sm text-emerald-400">_</span>
        )}
      </div>
    </div>
  );
}

// ── Logging toggle ────────────────────────────────────────────────────────────

function LoggingToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title={
        enabled
          ? 'Logging ON — entries will be committed to the ledger. Click to switch to brainstorm mode.'
          : 'Brainstorm mode — nothing will be logged. Click to re-enable logging.'
      }
      className="flex items-center gap-2"
    >
      <div
        className={`relative h-3.5 w-7 rounded-full transition-colors duration-200 ${
          enabled ? 'bg-emerald-500/30' : 'bg-zinc-700'
        }`}
      >
        <div
          className={`absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all duration-200 ${
            enabled
              ? 'left-[calc(100%-0.75rem)] bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]'
              : 'left-0.5 bg-zinc-500'
          }`}
        />
      </div>
      <span
        className={`font-mono text-[10px] tracking-widest transition-colors ${
          enabled ? 'text-emerald-400' : 'text-zinc-500'
        }`}
      >
        {enabled ? 'LOGGING' : 'BRAINSTORM'}
      </span>
    </button>
  );
}

// ── Session ID persistence ────────────────────────────────────────────────────
// Backed by localStorage so page refreshes don't give the AI amnesia.
// Each app launch continues the same session; "New Session" generates a fresh UUID.

function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return 'default';
  const stored = localStorage.getItem('ledger_session_id');
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem('ledger_session_id', id);
  return id;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';


const CHECK_IN_DAYS_OPTIONS = [7, 14, 30, 90] as const;

export default function ChatPanel({ onIngestSuccess, droppedPath, onPathConsumed, droppedFile, onFileConsumed }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());
  const [loggingEnabled, setLoggingEnabled] = useState(true);
  const [showCheckIn, setShowCheckIn] = useState(false);
  const [checkInDays, setCheckInDays] = useState<number>(14);
  const [checkInFocus, setCheckInFocus] = useState('');
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { data: telemetry, online } = useTelemetry();
  const { submit, isPending, statusMsg, toolStatus, streamingText, error } = useChatIngest(sessionId, onIngestSuccess);
  const { run: runCheckIn, isPending: checkInPending, statusMsg: checkInStatus,
          streamingText: checkInStreaming, error: checkInError } = useCheckIn();
  const { uploadPath, uploadFile, isPending: pdfPending, statusMsg: pdfStatus,
          streamingText: pdfStreaming, error: pdfError } = usePdfIngest(onIngestSuccess);

  useEffect(() => {
    if (!online || historyLoaded) return;

    fetch(`${API_URL}/api/v1/chat/history?session_id=${sessionId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((rows: ChatHistoryRow[]) => {
        if (rows.length === 0) return;
        const loaded: ChatMessage[] = rows.map((row) => {
          if (row.role === 'user') {
            return { id: row.id, role: 'user' as const, text: row.content, timestamp: row.created_at };
          }
          const { text, thinkingText } = resolveCommittedMessage(row.content);
          return {
            id: row.id,
            role: 'assistant' as const,
            text,
            thinkingText,
            timestamp: row.created_at,
          };
        });
        setMessages(loaded);
      })
      .catch(() => {})
      .finally(() => setHistoryLoaded(true));
  }, [online, historyLoaded, sessionId]);

  // Trigger PDF/CSV processing when a file path arrives from Tauri's drag-drop event
  useEffect(() => {
    if (!droppedPath) return;
    onPathConsumed?.(); // clear immediately so a re-drop of the same file works

    // Sentinel: Tauri got a drop but Chrome used OLE virtual-file format (no real path)
    if (droppedPath === '__NO_PATH__') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          text: 'Could not read the dropped file — Chrome\'s downloads bar uses a virtual format that prevents direct file access. Try right-clicking the file in Explorer and dragging from there, or use the file upload button.',
          timestamp: new Date().toISOString(),
        },
      ]);
      return;
    }

    const name = droppedPath.split(/[\\/]/).pop() ?? 'document';
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: `📄 ${name}`,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    uploadPath(droppedPath)
      .then((response) => {
        const { text: msgText, thinkingText } = resolveCommittedMessage(response.reply ?? '');
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: msgText,
          thinkingText,
          committed: response.committed ?? null,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      })
      .catch(() => {
        // error surfaced via usePdfIngest
      });
  // droppedPath is the only trigger we want; other deps are stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedPath]);

  // Trigger PDF processing when a File object arrives from HTML5 drag-drop
  useEffect(() => {
    if (!droppedFile) return;
    onFileConsumed?.(); // clear immediately so re-drop of the same file works

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: `📄 ${droppedFile.name}`,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    uploadFile(droppedFile)
      .then((response) => {
        const { text: msgText, thinkingText } = resolveCommittedMessage(response.reply ?? '');
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: msgText,
          thinkingText,
          committed: response.committed ?? null,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      })
      .catch(() => {
        // error surfaced via usePdfIngest
      });
  // droppedFile is the only trigger we want; other deps are stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedFile]);

  const handleClear = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmClear(false);
    const newId = crypto.randomUUID();
    localStorage.setItem('ledger_session_id', newId);
    setSessionId(newId);
    setMessages([]);
  }, [confirmClear]);

  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const handleSubmit = async (text: string) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await submit(text, loggingEnabled);
      const { text: msgText, thinkingText } = resolveCommittedMessage(response.reply ?? '');
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: msgText,
        thinkingText,
        committed: response.committed ?? null,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      // error state is surfaced via useChatIngest
    }
  };

  const handleCheckIn = async () => {
    setShowCheckIn(false);
    const label = checkInFocus.trim()
      ? `Check-in (${checkInDays}d): ${checkInFocus.trim()}`
      : `Check-in — past ${checkInDays} days`;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: label,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    try {
      const response = await runCheckIn({ days: checkInDays, focus: checkInFocus.trim() || undefined });
      const { text: msgText, thinkingText } = resolveCommittedMessage(response.reply ?? '');
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: msgText,
        thinkingText,
        committed: null,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
      onIngestSuccess({ status: 'success', reply: response.reply ?? '' });
    } catch {
      // error surfaced via useCheckIn
    }
  };

  const anyPending = isPending || checkInPending || pdfPending;
  const activeStatus = checkInPending ? checkInStatus : pdfPending ? pdfStatus : statusMsg;
  const activeStream = checkInPending ? checkInStreaming : pdfPending ? pdfStreaming : streamingText;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, anyPending, activeStream]);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h1 className="font-mono text-xs font-semibold tracking-widest text-zinc-200">
          LEDGER — HEALTH COMPANION
        </h1>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowCheckIn((v) => !v)}
            disabled={anyPending || !online}
            className={`font-mono text-[10px] tracking-widest transition-colors disabled:opacity-30 ${
              showCheckIn ? 'text-cyan-300' : 'text-cyan-500 hover:text-cyan-300'
            }`}
            title="Open check-in panel"
          >
            CHECK IN
          </button>
          <button
            onClick={handleClear}
            disabled={anyPending}
            className={`font-mono text-[10px] tracking-widest transition-colors disabled:opacity-40 ${
              confirmClear
                ? 'text-rose-400 hover:text-rose-300'
                : 'text-zinc-600 hover:text-zinc-400'
            }`}
            title="Start a new session (preserves all database records)"
          >
            {confirmClear ? 'CONFIRM?' : 'NEW SESSION'}
          </button>
        </div>
      </header>

      {/* Check-in options panel */}
      {showCheckIn && (
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/80 px-4 py-3">
          <p className="mb-2 font-mono text-[9px] tracking-widest text-cyan-500/60">CHECK-IN OPTIONS</p>
          <div className="mb-3 flex items-center gap-1">
            {CHECK_IN_DAYS_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setCheckInDays(d)}
                className={`px-2.5 py-1 font-mono text-[10px] tracking-widest transition-colors ${
                  checkInDays === d
                    ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/40'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {d}D
              </button>
            ))}
            <span className="ml-2 font-mono text-[10px] text-zinc-600">window</span>
          </div>
          <input
            type="text"
            value={checkInFocus}
            onChange={(e) => setCheckInFocus(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCheckIn()}
            placeholder="Focus (optional) — e.g. sleep quality, HRV trend..."
            className="mb-3 w-full bg-transparent font-mono text-xs text-zinc-300 placeholder-zinc-600 outline-none"
          />
          <button
            onClick={handleCheckIn}
            disabled={anyPending || !online}
            className="font-mono text-[10px] tracking-widest text-cyan-400 hover:text-cyan-200 transition-colors disabled:opacity-30"
          >
            RUN CHECK-IN &gt;
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <MessageList messages={messages} />
        {anyPending && activeStream && <StreamingBubble text={activeStream} />}
        {anyPending && !activeStream && <PipelineStatus msg={activeStatus} />}
        <div ref={bottomRef} />
      </div>

      {(error || checkInError || pdfError) && (
        <p className="shrink-0 px-4 py-1 font-mono text-xs text-red-400">{error || checkInError || pdfError}</p>
      )}

      <div className="shrink-0">
        <div className="border-t border-zinc-800 px-3 pt-2 pb-0">
          <div className="mb-2 flex items-center justify-end">
            <LoggingToggle
              enabled={loggingEnabled}
              onToggle={() => setLoggingEnabled((v) => !v)}
            />
          </div>
        </div>
        {toolStatus && (
          <div className="px-4 pb-2">
            <div className="animate-pulse font-mono text-[11px] tracking-widest text-cyan-500">
              {'>'} Executing: {toolStatus}...
            </div>
          </div>
        )}
        <div className="px-3 pb-3">
          <ChatInput onSubmit={handleSubmit} disabled={anyPending} />
        </div>
        <TelemetryFooter data={telemetry} online={online} />
      </div>
    </div>
  );
}
