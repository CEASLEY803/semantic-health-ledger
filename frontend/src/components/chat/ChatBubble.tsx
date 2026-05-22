'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, CommittedCounts } from '@/lib/types';

interface ChatBubbleProps {
  message: ChatMessage;
}

function CommittedPill({ committed }: { committed: CommittedCounts }) {
  const parts: string[] = [];
  if (committed.compound_logs) parts.push(`${committed.compound_logs} compound${committed.compound_logs !== 1 ? 's' : ''}`);
  if (committed.biometric_logs) parts.push(`${committed.biometric_logs} biometric${committed.biometric_logs !== 1 ? 's' : ''}`);
  if (committed.lab_results) parts.push(`${committed.lab_results} lab result${committed.lab_results !== 1 ? 's' : ''}`);
  if (committed.daily_journals) parts.push(`${committed.daily_journals} journal${committed.daily_journals !== 1 ? 's' : ''}`);
  if (!parts.length) return null;

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.8)]" />
      <span className="font-mono text-[9px] tracking-widest text-emerald-500/80 uppercase">
        logged · {parts.join(' · ')}
      </span>
    </div>
  );
}

export function MarkdownContent({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0 text-sm leading-relaxed">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-zinc-100">{children}</strong>,
          em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
          ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 text-sm">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 text-sm">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold text-zinc-100 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-1.5 mt-3 text-sm font-semibold text-zinc-100 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-zinc-200 first:mt-0">{children}</h3>,
          code: ({ children }) => <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs text-emerald-400">{children}</code>,
          pre: ({ children }) => <pre className="mb-2 overflow-x-auto rounded bg-zinc-800 p-3 font-mono text-xs text-emerald-300">{children}</pre>,
          hr: () => <hr className="my-3 border-zinc-700" />,
          blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-zinc-600 pl-3 text-zinc-400">{children}</blockquote>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-sm bg-cyan-800/60 px-3.5 py-2.5 ring-1 ring-cyan-700/40">
          <p className="text-sm leading-relaxed text-cyan-50">{message.text}</p>
          <p className="mt-1.5 text-right font-mono text-[9px] tracking-widest text-cyan-400/50">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] border-l-2 border-emerald-500/40 bg-zinc-900/80 py-2.5 pl-3.5 pr-4 ring-1 ring-zinc-800/60">
        <p className="mb-1.5 font-mono text-[9px] tracking-widest text-emerald-500/60">LEDGER</p>
        {message.thinkingText && (
          <div className="mb-3 border-l border-zinc-700 pl-3">
            <p className="mb-1 font-mono text-[9px] tracking-widest text-zinc-600">CLINICAL REASONING</p>
            <p className="text-xs italic leading-relaxed text-zinc-600">{message.thinkingText}</p>
          </div>
        )}
        <MarkdownContent text={message.text} className="text-zinc-200" />
        {message.committed && <CommittedPill committed={message.committed} />}
        <p className="mt-2 font-mono text-[9px] tracking-widest text-zinc-600">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </div>
  );
}
