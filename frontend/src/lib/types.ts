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

// Chat / ingest shapes

export interface ChatIngestResponse {
  status: 'success' | 'error';
  ledger_response: {
    committed: {
      compound_logs: number;
      biometric_logs: number;
      lab_results: number;
      daily_journals: number;
    };
    log_type: string[];
    semantic_memory: string;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ledger_response?: ChatIngestResponse['ledger_response'];
  timestamp: string;
}
