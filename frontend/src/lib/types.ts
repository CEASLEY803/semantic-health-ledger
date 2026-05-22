// TypeScript mirrors of the Pydantic v2 models in models.py.
// Keep in sync with backend schema changes.

export type DoseUnit = 'mcg' | 'mg' | 'g' | 'iu' | 'ml';

export type AdministrationRoute =
  | 'oral'
  | 'subcutaneous'
  | 'intramuscular'
  | 'intravenous'
  | 'transdermal'
  | 'intranasal'
  | 'other';

export type LabValueType = 'numeric' | 'positive_negative' | 'text';

export type Mood = 'very_low' | 'low' | 'neutral' | 'good' | 'very_good';

export interface CompoundLog {
  id: string;
  entry_type: 'compound';
  recorded_at: string;
  compound_name: string;
  dose_value: number;
  dose_unit: DoseUnit;
  route: AdministrationRoute;
  site: string | null;
  protocol_phase: string | null;
  notes: string | null;
  raw_text: string | null;
}

export interface BiometricLog {
  id: string;
  entry_type: 'biometric';
  recorded_at: string;
  metric_name: string;
  value: number;
  unit: string;
  context: string | null;
  notes: string | null;
  raw_text: string | null;
}

export interface LabResult {
  id: string;
  entry_type: 'lab_result';
  collected_at: string;
  resulted_at: string | null;
  panel_name: string | null;
  marker_name: string;
  value_type: LabValueType;
  value_numeric: number | null;
  // SQLite returns numerics as strings; coerce with Number() at the call site
  value_text: string | null;
  unit: string | null;
  reference_low: string | null;
  reference_high: string | null;
  lab_name: string | null;
  flagged: number; // SQLite stores booleans as 0/1
  notes: string | null;
  raw_text: string | null;
}

export interface DailyJournal {
  id: string;
  entry_type: 'daily_journal';
  journal_date: string;
  mood: Mood | null;
  energy_score: number | null;
  sleep_hours: string | null; // SQLite stores as string
  symptoms: string; // JSON-encoded string array; parse with JSON.parse()
  training: string | null;
  nutrition: string | null;
  notes: string;
  raw_text: string | null;
}

export interface RegimenItem {
  id: string;
  compound_name: string;
  dose_value: string;
  dose_unit: string;
  route: AdministrationRoute;
  site: string | null;
  frequency: string;
  time_of_day: string;
  days_of_week: string | null;
  notes: string | null;
}

// Chat / ingest shapes

export interface CommittedCounts {
  compound_logs: number;
  biometric_logs: number;
  lab_results: number;
  daily_journals: number;
}

export interface ChatIngestResponse {
  status: 'success' | 'error';
  reply: string;
  committed?: CommittedCounts | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinkingText?: string;
  committed?: CommittedCounts | null;
  timestamp: string;
}

// Shape returned by GET /api/v1/chat/history
export interface ChatHistoryRow {
  id: string;
  role: 'user' | 'model';  // Gemini convention; map 'model' → 'assistant' in UI
  content: string;
  created_at: string;
}

// ── Knowledge Graph ───────────────────────────────────────────────────────────

export type ConfidenceLevel = 'hypothesis' | 'testing' | 'confirmed';

export interface ClinicalNode {
  concept_name: string;
  category: string;
  summary_text: string;
  confidence_level: ConfidenceLevel;
  last_updated: string;
  expires_at?: string | null;
  last_surfaced_date?: string | null;
  is_archived?: number;
}

export interface ClinicalEdge {
  source: string;
  target: string;
  relationship_type: string;
  evidence_summary: string | null;
}

export interface MorningBriefing {
  synthesis_date: string | null;
  nodes: ClinicalNode[];
  edges: ClinicalEdge[];
  ready: boolean;
}
