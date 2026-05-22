'use client';

import { useEffect, useState } from 'react';
import { fetchMorningBriefing } from '@/lib/api';
import type { ClinicalEdge, ClinicalNode, ConfidenceLevel, MorningBriefing } from '@/lib/types';

const CONFIDENCE_STYLES: Record<ConfidenceLevel, { badge: string; dot: string }> = {
  confirmed:  { badge: 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50', dot: 'bg-emerald-400' },
  testing:    { badge: 'bg-amber-950/60  text-amber-400  border-amber-800/50',  dot: 'bg-amber-400'  },
  hypothesis: { badge: 'bg-zinc-800/60   text-zinc-400   border-zinc-700/50',   dot: 'bg-zinc-500'   },
};

function NodePill({ node }: { node: ClinicalNode }) {
  const [expanded, setExpanded] = useState(false);
  const styles = CONFIDENCE_STYLES[node.confidence_level] ?? CONFIDENCE_STYLES.hypothesis;

  return (
    <button
      onClick={() => setExpanded((e) => !e)}
      className="w-full text-left"
    >
      <div className={`rounded border px-3 py-2 transition-colors hover:bg-white/[0.03] ${styles.badge}`}>
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${styles.dot}`} />
          <span className="font-mono text-[10px] font-semibold tracking-widest uppercase">
            {node.confidence_level}
          </span>
          <span className="font-mono text-[11px] font-bold text-white truncate">
            {node.concept_name}
          </span>
          <span className="ml-auto font-mono text-[10px] text-zinc-500 shrink-0">
            {node.category}
          </span>
        </div>
        {expanded && (
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-zinc-300 whitespace-normal">
            {node.summary_text}
          </p>
        )}
      </div>
    </button>
  );
}

function EdgeRow({ edge }: { edge: ClinicalEdge }) {
  const REL_COLORS: Record<string, string> = {
    CAUSES:          'text-rose-400',
    MITIGATES:       'text-emerald-400',
    EXACERBATES:     'text-orange-400',
    CORRELATES_WITH: 'text-cyan-400',
    REQUIRES:        'text-violet-400',
    PRECEDES:        'text-blue-400',
  };
  const relColor = REL_COLORS[edge.relationship_type] ?? 'text-zinc-400';

  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px] py-0.5">
      <span className="text-zinc-300 truncate max-w-[28%]">{edge.source}</span>
      <span className="text-zinc-600">—[</span>
      <span className={`font-semibold ${relColor}`}>{edge.relationship_type}</span>
      <span className="text-zinc-600">]→</span>
      <span className="text-zinc-300 truncate max-w-[28%]">{edge.target}</span>
      {edge.evidence_summary && (
        <span className="text-zinc-500 truncate flex-1 ml-1">{edge.evidence_summary}</span>
      )}
    </div>
  );
}

interface LedgerThoughtsCardProps {
  refreshKey?: number;
}

export default function LedgerThoughtsCard({ refreshKey }: LedgerThoughtsCardProps) {
  const [briefing, setBriefing] = useState<MorningBriefing | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMorningBriefing()
      .then((data) => { if (!cancelled) setBriefing(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (!briefing?.ready || briefing.nodes.length === 0) return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="font-mono text-[11px] tracking-widest text-zinc-600 uppercase">No synthesis available</p>
      <p className="font-mono text-[10px] text-zinc-700">Knowledge graph updates overnight after sufficient data is logged.</p>
    </div>
  );

  return (
    <div>
      {/* Header */}
      <div className="mb-3 flex items-center gap-3">
        <div className="h-px flex-1 bg-zinc-800" />
        <span className="font-mono text-[10px] font-semibold tracking-[0.2em] text-cyan-500/80 uppercase">
          Ledger&apos;s Thoughts — {briefing.synthesis_date}
        </span>
        <div className="h-px flex-1 bg-zinc-800" />
      </div>

      {/* Nodes */}
      <div className="grid gap-1.5 sm:grid-cols-2">
        {briefing.nodes.map((node) => (
          <NodePill key={node.concept_name} node={node} />
        ))}
      </div>

      {/* Edges */}
      {briefing.edges.length > 0 && (
        <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2">
          <p className="mb-1.5 font-mono text-[9px] tracking-widest text-zinc-500 uppercase">
            Relationships
          </p>
          <div className="space-y-0.5">
            {briefing.edges.map((edge, i) => (
              <EdgeRow key={i} edge={edge} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
