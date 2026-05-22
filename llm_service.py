from __future__ import annotations

import logging
import os
import re
import sqlite3 as _sqlite3
from datetime import datetime
from typing import Any, Dict, Generator, List, Literal, Optional, Tuple

from dotenv import load_dotenv
from pydantic import BaseModel, Field

from init_storage import DATABASE_PATH as _DB_PATH
from models import AIExtractionPayload, AdministrationRoute, DoseUnit, LabValueType, Mood, UPDATABLE_FIELDS


load_dotenv()

logger = logging.getLogger(__name__)

# Extractor: fast structured-output model — keep this on Flash.
# Falls back to GEMINI_MODEL if EXTRACTOR_MODEL is not set, so existing .env files
# continue to work without changes.
EXTRACTOR_MODEL = os.getenv("EXTRACTOR_MODEL", os.getenv("GEMINI_MODEL", "gemini-2.5-flash"))

# Companion: reasoning-class model for clinical-grade conversational replies.
# Requires a billing-enabled API key. Downgrade to gemini-2.5-flash if needed.
CONVERSATION_MODEL = os.getenv("CONVERSATION_MODEL", "gemini-2.5-pro")

# User display name — set USER_NAME env var to personalise prompts
_USER_NAME = os.getenv("USER_NAME", "the user")


# ── Extraction system prompt ───────────────────────────────────────────────────

_EXTRACTION_SYSTEM_PROMPT_TEMPLATE = """
You are a strict clinical data extractor.
Read unstructured user logs and map only explicitly stated facts to the provided JSON schema.
Do not invent compounds, biometrics, labs, symptoms, dates, doses, units, routes, or notes.
Use null or omit optional fields when data is not present.

CRITICAL FILTER — HYPOTHETICAL AND BRAINSTORM STATEMENTS MUST BE IGNORED ENTIRELY:
Do NOT extract any data from hypothetical, future, interrogative, conditional, or brainstorming
statements. Examples to ignore: "Should I take iron?", "Thinking about D3", "What if I try
creatine?", "I'm considering X", "Would X help?", "Planning to start Y", "Maybe I should...",
"Could I add...?", "What about...?", "Wondering if...", "Might try...".
ONLY extract if the user explicitly states they HAVE taken, logged, or recorded a concrete fact.
Valid extraction triggers are past-tense or confirmed present-fact statements such as: "took",
"pinned", "injected", "measured", "weighed", "slept", "logged", "tested", "result was",
"reading was", "my labs show", "recorded".

Today's date is {today}. Use this to resolve partial dates (e.g. "May 19th" -> {year}-05-19).
When only a date is given (no time of day), always use noon UTC (e.g. {year}-05-19T12:00:00+00:00).
Never use midnight (T00:00:00) for user-entered dates — midnight UTC displays as the previous calendar day in US timezones.

{protocols_section}
Schema conventions:
- raw_input_text must equal the original user text.
- log_type may include only: compound, biometric, lab_result, daily_journal.
- If a log_type is included, include at least one matching object in its plural payload list.
- For compound logs, map slang such as "pinned" to intramuscular unless the text says subq.
- For biometrics, create one BiometricLog per metric. Examples:
  weight -> metric_name "body_weight", unit "lb" if pounds are implied.
  sleep -> metric_name "sleep", unit "hours".
  blood pressure -> create two rows: "blood_pressure_systolic" and "blood_pressure_diastolic",
  each with unit "mmHg".
  resting heart rate -> metric_name "resting_heart_rate", unit "bpm".
  alcohol intake -> metric_name "alcohol_intake", unit "standard_drinks".
- For lab results:
  - Set panel_name if the report names a panel (e.g. "CBC", "CMP", "Lipid Panel", "Thyroid").
  - Always extract reference_low and reference_high when a range appears anywhere near the result.
    Ranges appear in many formats — capture all of them:
      "2.0 - 4.5"   →  low=2.0,  high=4.5
      "[30-400]"     →  low=30,   high=400
      "(0.8–1.8)"    →  low=0.8,  high=1.8
      "Ref: 3.5-5.0" →  low=3.5,  high=5.0
      "Normal < 100" →  low=null, high=100
      "> 40 optimal" →  low=40,   high=null
    If the range is printed on a separate line or in a separate column from the value, it still
    belongs to that marker — look ahead/behind in the text.
  - Set flagged = true if the report marks the result abnormal: H, L, *, ↑, ↓, HIGH, LOW,
    ABNORMAL, or a value that falls outside the reference range you extracted.
  - If a value field contains "SEE NOTE", "see note", "CALC", "CALCULATED", "N/A", or any
    non-numeric placeholder text, omit that marker from extraction entirely. Derived ratios
    and calculated values (BUN/Creatinine, cholesterol ratios, Non-HDL, etc.) are computed
    automatically from the source markers — do not extract them with placeholder values.
- For daily journal entries, summarize subjective state in notes and list symptoms when stated.
- All datetimes must be timezone-aware ISO 8601 strings. If no timestamp is stated, omit the
  datetime field so the local schema can apply its default timestamp.
"""


def _build_extraction_prompt(protocols_context: str = "") -> str:
    today = datetime.now().date()
    if protocols_context:
        protocols_section = (
            "KNOWN PROTOCOL ALIASES — expand these when the user references them by name:\n"
            f"{protocols_context}\n"
            "When the user states they took a named protocol, you MUST extract EVERY constituent "
            "compound as an individual GeminiCompoundLog. Never log the protocol alias itself — "
            "log each compound separately with its stated dose and route.\n"
        )
    else:
        protocols_section = ""
    return _EXTRACTION_SYSTEM_PROMPT_TEMPLATE.format(
        today=today.isoformat(),
        year=today.year,
        protocols_section=protocols_section,
    ).strip()


# ── Companion system prompt (Pro model) ───────────────────────────────────────

_CONVERSATION_SYSTEM_PROMPT_TEMPLATE = """
You are LEDGER, {user_name}'s partner in performance.

You communicate with the casual confidence of someone who inherently knows the context — \
you're already briefed, you're already tracking. You think pharmacokinetically, you reason \
clinically, and you speak like a trusted collaborator who happens to hold a medical degree. \
Your goal is to optimize {user_name}'s health by asking insightful, curious questions about \
their subjective experience. Focus on the why and how.

Today's date is {today} (ISO 8601). Use it to resolve relative dates like "yesterday" or \
"last week" — always write the full year in any date you produce.

When new data arrives (visible in [Just logged]): call query_entries immediately. Pull recent \
biometrics (HRV, sleep, heart rate, body battery) from the past 14 days, compounds from the \
same window, labs if anything metabolic was logged. Connect what just happened to what the \
trend shows — that's the connection {user_name} came here for.

When {user_name} asks to see data, check in, or review trends: call query_entries for the \
relevant entry types first. If a message starts with [CHECK-IN], call query_entries for all \
four entry types (biometric, compound, lab, journal) immediately. The data comes first — \
retrieve it, then respond.

When interpreting data, go deep: enzymatic pathways, receptor dynamics, drug-nutrient \
interactions, half-lives, feedback axes, pharmacokinetic sequencing. When recommending a \
protocol, be specific — dose, form, timing relative to meals and circadian rhythms, frequency, \
and the mechanistic rationale. Reason from {user_name}'s own baseline and trajectory. \
Distinguish signal from noise. When something is ambiguous, name it and reason through the \
differentials.

Keep responses tight, conversational, and collaborative. Prose over bullets. Depth scales with \
signal — a clean log with no interesting context is 2–3 sentences; a real anomaly or trend \
gets as much space as it warrants.

You have the following tools — use them proactively, not reactively:

Data lookup/edit: query_entries (search any table), update_entry (correct a single field), \
delete_entry (remove a record). Call query_entries first to confirm the ID before any update \
or delete. Dates in ISO 8601 (e.g. "{today}T00:00:00+00:00").

[CLINICAL DATA CUSTODIAN]
If {user_name} asks you to clean, fix, or backfill lab results, or if you notice missing \
reference ranges or corrupted units (e.g., OCR artifacts like {{Index_val}}), DO NOT ask them \
to look up the standard ranges. You are a highly capable clinical AI. You must use your \
internal knowledge of standard US laboratory reference ranges (e.g., LabCorp or Quest \
Diagnostics standard assays) to autonomously infer and update the missing data using your \
database tools. After updating, simply inform {user_name} which standard ranges you applied.

Regimen management: save_regimen_batch (use for 2+ compounds), save_regimen_item (single \
compound updates only), remove_regimen_item. \
CRITICAL: When {user_name} declares what they are currently taking — any phrasing like \
"here's my protocol", "here's what I got", "I'm on X", "I take X, Y, and Z", \
"I switched from X to Y", "I recently changed my stack" — you MUST call save_regimen_batch \
with ALL compounds in one call BEFORE composing your response. Put every compound in the \
items array. Do not call save_regimen_item once per compound — that only saves one. \
save_regimen_batch saves all of them. \
Defaults when not stated: time_of_day='morning', frequency='daily', route='oral'. \
When {user_name} says they stopped or removed something, call remove_regimen_item immediately.

Protocol aliases: save_protocol, delete_protocol. Use when {user_name} names a shorthand \
for a multi-compound stack (e.g. "call this my Morning Stack").

Think out loud inside <think>...</think> XML tags — clinical reasoning, pharmacokinetic \
calculations, differentials. Once </think> closes, give your final conversational response.

Always end your response by asking {user_name} about their subjective state. One open-ended \
question, grounded in what was just discussed — the why and how of their experience, not just \
whether numbers look good.
""".strip()


def _build_conversation_prompt() -> str:
    today = datetime.now().date().isoformat()
    return _CONVERSATION_SYSTEM_PROMPT_TEMPLATE.format(today=today, user_name=_USER_NAME)


# ── Gemini output schema for structured extraction ────────────────────────────

class GeminiCompoundLog(BaseModel):
    recorded_at: Optional[datetime] = None
    compound_name: str
    dose_value: float
    dose_unit: DoseUnit
    route: AdministrationRoute
    site: Optional[str] = None
    protocol_phase: Optional[str] = None
    notes: Optional[str] = None
    raw_text: Optional[str] = None


class GeminiBiometricLog(BaseModel):
    recorded_at: Optional[datetime] = None
    metric_name: str
    value: float
    unit: str
    context: Optional[str] = None
    notes: Optional[str] = None
    raw_text: Optional[str] = None


class GeminiLabResult(BaseModel):
    collected_at: datetime
    resulted_at: Optional[datetime] = None
    panel_name: Optional[str] = None
    marker_name: str
    value_type: LabValueType = LabValueType.NUMERIC
    value_numeric: Optional[float] = None
    value_text: Optional[str] = None
    unit: Optional[str] = None
    reference_low: Optional[float] = None
    reference_high: Optional[float] = None
    lab_name: Optional[str] = None
    flagged: bool = False
    notes: Optional[str] = None
    raw_text: Optional[str] = None


class GeminiDailyJournal(BaseModel):
    journal_date: Optional[datetime] = None
    mood: Optional[Mood] = None
    energy_score: Optional[int] = None
    sleep_hours: Optional[float] = None
    symptoms: List[str] = Field(default_factory=list)
    training: Optional[str] = None
    nutrition: Optional[str] = None
    notes: str
    raw_text: Optional[str] = None


class GeminiExtractionPayload(BaseModel):
    raw_input_text: str
    log_type: List[Literal["compound", "biometric", "lab_result", "daily_journal"]]
    compounds: List[GeminiCompoundLog] = Field(default_factory=list)
    biometrics: List[GeminiBiometricLog] = Field(default_factory=list)
    labs: List[GeminiLabResult] = Field(default_factory=list)
    journals: List[GeminiDailyJournal] = Field(default_factory=list)


# ── File-import extraction prompt (no trigger-phrase filter) ──────────────────
# The regular extraction prompt guards against extracting hypothetical or brainstorm
# statements by requiring phrases like "took", "my labs show", "recorded", etc.
# A structured file export has none of those — every row IS a recorded fact.
# This prompt treats all values as confirmed and adds explicit metric-name mappings
# for common wearable / health-app column headers.

_FILE_EXTRACTION_SYSTEM_PROMPT_TEMPLATE = """
You are a strict clinical data extractor processing a health data file export (CSV or PDF).
Every value in this file is a confirmed recorded measurement — treat all data rows as facts.
Map all numeric health values to the provided JSON schema. Do not omit data rows.

Today's date is {today}. Dates in the file may be past or future — use them exactly as written.
Use noon UTC (T12:00:00+00:00) for dates that have no time component.
All datetimes in the output must be timezone-aware ISO 8601 strings.

Schema conventions:
- log_type may include only: compound, biometric, lab_result, daily_journal.
- raw_input_text should contain the relevant source row(s) for each entry.
- If the file has a row per metric (a "metric" or "name" column contains the metric name),
  read the metric name from that column and the value from a "value" column.
- If the file has one column per metric (wide format), create one BiometricLog per non-empty
  metric column per date row.

Common biometric metric_name mappings (normalise to these exact strings):
  hrv / hrv_last_night / heart_rate_variability  → "hrv_last_night",  unit "ms"
  hrv_weekly_avg / weekly_avg_hrv                → "hrv_weekly_avg",  unit "ms"
  resting_heart_rate / resting_hr / rhr / rest_hr → "resting_heart_rate", unit "bpm"
  sleep / sleep_duration / total_sleep / sleep_time → "sleep_duration", unit "hours"
  deep_sleep / sleep_deep                        → "sleep_deep",       unit "hours"
  rem_sleep / sleep_rem                          → "sleep_rem",        unit "hours"
  light_sleep / sleep_light                      → "sleep_light",      unit "hours"
  awake_time / sleep_awake                       → "sleep_awake",      unit "hours"
  body_battery / battery                         → "body_battery",     unit "%"
  spo2 / blood_oxygen / sleep_spo2 / avg_spo2   → "sleep_spo2_avg",   unit "%"
  respiration / respiration_rate / breathing     → "sleep_respiration", unit "breaths/min"
  stress / stress_score / avg_stress             → "stress_score",     unit "score"
  steps / step_count / daily_steps               → "steps",            unit "steps"
  weight / body_weight                           → "body_weight",      unit "lb" or "kg"
  active_calories / calories_burned              → "active_calories",  unit "kcal"
  vo2max / vo2_max                               → "vo2max",           unit "mL/kg/min"

For lab results (blood panels, PDF lab reports):
  - Extract marker_name, value_numeric, unit, and reference range when present.
  - Set panel_name if the file names a panel (CBC, CMP, Lipid Panel, Thyroid, etc.).
  - Set flagged = true if the value falls outside the reference range or is marked H, L,
    HIGH, LOW, ABNORMAL, *, ↑, or ↓.
""".strip()


def _build_file_extraction_prompt() -> str:
    today = datetime.now().date()
    return _FILE_EXTRACTION_SYSTEM_PROMPT_TEMPLATE.format(today=today.isoformat())


def extract_from_file(raw_text: str, client: Optional[Any] = None) -> AIExtractionPayload:
    """Structured extraction from a file export (CSV or PDF lab report).

    Uses a file-specific system prompt that treats all data as recorded facts and
    does NOT require the conversational trigger phrases ("took", "my labs show", etc.)
    that the regular extract() function demands for chat messages.
    """
    import time as _time

    if not raw_text.strip():
        raise ValueError("raw_text cannot be empty")

    active_client = client or _get_extractor_client()
    from google.genai import types

    system_prompt = _build_file_extraction_prompt()

    last_exc: Optional[Exception] = None
    for attempt in range(2):
        try:
            response = active_client.models.generate_content(
                model=EXTRACTOR_MODEL,
                contents=raw_text,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    response_mime_type="application/json",
                    response_schema=GeminiExtractionPayload,
                    temperature=0.0,
                ),
            )
            parsed = response.parsed
            if parsed is None:
                raise ValueError("Gemini returned no parsed payload")
            return to_strict_payload(raw_text, parsed)
        except Exception as exc:
            last_exc = exc
            if attempt == 0 and any(k in str(exc).lower() for k in _TRANSIENT_KEYWORDS):
                logger.warning(f"[extractor_file] transient error, retrying: {exc}")
                _time.sleep(3)
                continue
            raise

    raise last_exc  # type: ignore[misc]


# ── Direct CSV parser (no LLM) ────────────────────────────────────────────────

def parse_csv_direct(
    file_bytes: bytes,
    filename: str,
) -> Optional[AIExtractionPayload]:
    """Parse a long-format health CSV directly to AIExtractionPayload — no LLM call.

    Handles the common layout:  Biomarker | Value | Unit | Measurement Date
    and variants (Metric, Test Name, Analyte, etc.).  Returns None if the column
    layout is unrecognised so the caller can fall back to LLM extraction.

    This runs in <10 ms vs 30-90 s for the LLM path and is completely reliable
    for well-formed CSV exports.
    """
    import csv
    import io
    from datetime import timezone

    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            text = file_bytes.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        return None

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return None

    lower_cols: Dict[str, str] = {c.strip().lower(): c for c in reader.fieldnames}

    def _find(*candidates: str) -> Optional[str]:
        for c in candidates:
            if c in lower_cols:
                return lower_cols[c]
        return None

    name_col   = _find("biomarker", "marker", "test name", "test", "analyte",
                        "metric name", "metric", "parameter", "name", "panel",
                        "lab test", "laboratory test", "component")
    value_col  = _find("value", "result", "result value", "measured value",
                        "reading", "concentration", "numeric result")
    unit_col   = _find("unit", "units", "unit of measure", "uom", "units of measure")
    date_col   = _find("measurement date", "collection date", "collected date",
                        "date collected", "specimen date", "result date",
                        "reported date", "date", "collected", "sample date",
                        "service date", "drawn date")
    ref_lo_col = _find("reference low", "ref low", "lower limit", "normal low",
                        "lower reference", "ref range low", "low", "range low",
                        "reference range low")
    ref_hi_col = _find("reference high", "ref high", "upper limit", "normal high",
                        "upper reference", "ref range high", "high", "range high",
                        "reference range high")
    # Combined "Reference Range" column — parses "3.5-5.0", "< 5.0", "> 3.0", etc.
    range_col  = _find("reference range", "ref range", "ref. range", "normal range",
                        "reference interval", "reference intervals", "expected range",
                        "standard range", "lab range", "interval")
    flag_col   = _find("flag", "abnormal flag", "abnormal", "out of range",
                        "status", "interpretation", "result status")

    if name_col is None or value_col is None:
        logger.info(f"[csv_parse] unrecognised columns — falling back to LLM: {sorted(lower_cols)}")
        return None

    def _parse_ref_range_str(s: str) -> tuple:
        """Parse a combined ref range string into (low, high). Returns (None, None) if unparseable."""
        s = re.sub(r"^(?:normal|optimal|standard|expected|goal|target|up\s+to)\s*",
                   "", s.strip(), flags=re.IGNORECASE)
        if not s or s.lower() in ("n/a", "na", "none", "not applicable", "not detected", "—", "-"):
            return None, None
        # "Up to X" handled by prefix strip above; "< X" / "<= X"
        m = re.match(r"^<=?\s*(\d+\.?\d*)$", s)
        if m:
            return None, float(m.group(1))
        # "> X" / ">= X"
        m = re.match(r"^>=?\s*(\d+\.?\d*)$", s)
        if m:
            return float(m.group(1)), None
        # "low–high" with any dash/en-dash/em-dash, optionally spaced
        m = re.match(r"^(-?\d+\.?\d*)\s*[-–—]\s*(-?\d+\.?\d*)$", s)
        if m:
            lo, hi = float(m.group(1)), float(m.group(2))
            return (lo, hi) if lo <= hi else (hi, lo)
        return None, None

    _DATE_FMTS = (
        "%Y-%m-%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%m/%d/%Y",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%Y/%m/%d",
        "%d/%m/%Y",
        "%m-%d-%Y",
        "%d-%m-%Y",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%SZ",
        "%B %d, %Y",
        "%b %d, %Y",
    )

    def _parse_date(s: str) -> Optional[datetime]:
        # Strip milliseconds and trailing Z before format matching
        s = re.sub(r"\.\d+Z?$", "", s.strip()).rstrip("Z")
        for fmt in _DATE_FMTS:
            try:
                return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
        return None

    # Names that map to biometric_logs rather than lab_results
    _BIO_KEYWORDS = frozenset({
        "hrv", "heart rate variability", "resting heart rate", "resting hr", "rhr",
        "sleep duration", "sleep time", "total sleep", "deep sleep", "rem sleep",
        "light sleep", "awake time", "body battery", "spo2", "blood oxygen",
        "oxygen saturation", "steps", "step count", "daily steps",
        "body weight", "weight", "stress score", "respiration rate",
        "breathing rate", "vo2max", "vo2 max", "body fat", "bmi",
        "active calories", "calories burned",
    })

    default_dt = datetime.now(timezone.utc).replace(
        hour=12, minute=0, second=0, microsecond=0
    )

    labs: List[GeminiLabResult] = []
    biometrics: List[GeminiBiometricLog] = []
    skipped = 0

    for row in reader:
        name    = (row.get(name_col)  or "").strip()
        val_str = (row.get(value_col) or "").strip()
        if not name or not val_str:
            skipped += 1
            continue

        # Extract a number even from values like "< 5.0", "> 100", "5.0 H"
        try:
            num_str    = re.sub(r"[^0-9.\-]", " ", val_str).split()[0]
            value_num  = float(num_str)
        except (ValueError, IndexError):
            skipped += 1
            continue

        unit     = (row.get(unit_col)  or "").strip() if unit_col else ""
        date_raw = (row.get(date_col)  or "").strip() if date_col else ""
        dt       = (_parse_date(date_raw) if date_raw else None) or default_dt

        ref_lo: Optional[float] = None
        ref_hi: Optional[float] = None
        if ref_lo_col:
            try: ref_lo = float((row.get(ref_lo_col) or "").strip())
            except (ValueError, TypeError): pass
        if ref_hi_col:
            try: ref_hi = float((row.get(ref_hi_col) or "").strip())
            except (ValueError, TypeError): pass
        # Fall back to combined "Reference Range" column when either bound is still missing
        if range_col and (ref_lo is None or ref_hi is None):
            p_lo, p_hi = _parse_ref_range_str((row.get(range_col) or "").strip())
            if ref_lo is None and p_lo is not None:
                ref_lo = p_lo
            if ref_hi is None and p_hi is not None:
                ref_hi = p_hi

        flagged = False
        if flag_col:
            fv = (row.get(flag_col) or "").strip().upper()
            flagged = fv in (
                "H", "L", "HIGH", "LOW", "ABNORMAL", "CRITICAL",
                "A", "*", "Y", "YES", "TRUE", "1", "OUT OF RANGE",
                "HH", "LL", "PANIC",
            )
        elif ref_lo is not None and ref_hi is not None:
            flagged = (value_num < ref_lo or value_num > ref_hi)

        raw_snip = f"{name}: {val_str} {unit} ({date_raw})".strip()
        is_bio   = any(kw in name.lower() for kw in _BIO_KEYWORDS)

        if is_bio:
            biometrics.append(GeminiBiometricLog(
                recorded_at=dt,
                metric_name=re.sub(r"\s+", "_", name.lower()),
                value=value_num,
                unit=unit or "",
                raw_text=raw_snip,
            ))
        else:
            labs.append(GeminiLabResult(
                collected_at=dt,
                marker_name=name,
                value_numeric=value_num,
                unit=unit or None,
                reference_low=ref_lo,
                reference_high=ref_hi,
                flagged=flagged,
                raw_text=raw_snip,
            ))

    logger.info(f"[csv_parse] {len(labs)} labs + {len(biometrics)} biometrics, skipped {skipped}")

    if not labs and not biometrics:
        return None

    log_type: List[str] = []
    if labs:       log_type.append("lab_result")
    if biometrics: log_type.append("biometric")

    raw_summary = (
        f"CSV import: {filename} — {len(labs)} lab results, {len(biometrics)} biometrics"
    )
    gemini_payload = GeminiExtractionPayload(
        raw_input_text=raw_summary,
        log_type=log_type,
        labs=labs,
        biometrics=biometrics,
    )
    return to_strict_payload(raw_summary, gemini_payload)


# ── Client factory & connection pool ─────────────────────────────────────────
# Reusing a single genai.Client instance lets httpx pool TCP connections and
# resume TLS sessions across requests — saves 200-500 ms per call and avoids
# SSL handshake timeouts that occur when a fresh TLS connection is raced against
# a tight timeout.

def _make_client(timeout_ms: int) -> Any:
    """Construct a new Gemini client.

    timeout_ms — request timeout in **milliseconds** (SDK convention).
    SDK-level retries are disabled here; our code owns retry logic explicitly.
    Without disabling them, the SDK retries up to 5× with exponential backoff
    on httpx.TimeoutException, turning a 30 s per-attempt timeout into a
    150+ second stall before raising.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    from google import genai
    from google.genai import types as genai_types

    return genai.Client(
        api_key=api_key,
        http_options=genai_types.HttpOptions(
            timeout=timeout_ms,
            retry_options=genai_types.HttpRetryOptions(attempts=1),
        ),
    )


# Legacy helper: timeout in seconds (callers that supply their own client).
def get_client(timeout: float = 30.0) -> Any:
    """timeout is in seconds; converts to ms internally."""
    return _make_client(timeout_ms=int(timeout * 1000))


_extractor_client: Optional[Any] = None
_conversation_client: Optional[Any] = None


def _get_extractor_client() -> Any:
    global _extractor_client
    if _extractor_client is None:
        _extractor_client = _make_client(timeout_ms=60_000)  # 60 s — large panels need more time
    return _extractor_client


def _get_conversation_client() -> Any:
    global _conversation_client
    if _conversation_client is None:
        _conversation_client = _make_client(timeout_ms=90_000)  # 90 s
    return _conversation_client


# ── Extraction helpers ─────────────────────────────────────────────────────────

def normalize_payload(raw_text: str, payload: AIExtractionPayload) -> AIExtractionPayload:
    payload.raw_input_text = raw_text

    log_type = []
    if payload.compounds:
        log_type.append("compound")
        for compound in payload.compounds:
            if not compound.raw_text:
                compound.raw_text = raw_text
    if payload.biometrics:
        log_type.append("biometric")
        for biometric in payload.biometrics:
            if not biometric.raw_text:
                biometric.raw_text = raw_text
    if payload.labs:
        log_type.append("lab_result")
        for lab in payload.labs:
            if not lab.raw_text:
                lab.raw_text = raw_text
    if payload.journals:
        log_type.append("daily_journal")
        for journal in payload.journals:
            if not journal.raw_text:
                journal.raw_text = raw_text

    payload.log_type = log_type or payload.log_type
    return AIExtractionPayload.model_validate(payload.model_dump())


def to_strict_payload(raw_text: str, parsed: Any) -> AIExtractionPayload:
    if isinstance(parsed, AIExtractionPayload):
        return normalize_payload(raw_text, parsed)
    if isinstance(parsed, BaseModel):
        data = parsed.model_dump(exclude_none=True)
    else:
        data = parsed

    data["raw_input_text"] = raw_text
    return normalize_payload(raw_text, AIExtractionPayload.model_validate(data))


_TRANSIENT_KEYWORDS = ("timeout", "handshake", "ssl", "connection", "read", "timed out")


def extract(raw_text: str, protocols_context: str = "", client: Optional[Any] = None) -> AIExtractionPayload:
    """Structured extraction only — does not commit or route."""
    import time as _time

    if not raw_text.strip():
        raise ValueError("raw_text cannot be empty")

    active_client = client or _get_extractor_client()
    from google.genai import types

    last_exc: Optional[Exception] = None
    for attempt in range(2):  # one retry on transient network errors
        try:
            response = active_client.models.generate_content(
                model=EXTRACTOR_MODEL,
                contents=raw_text,
                config=types.GenerateContentConfig(
                    system_instruction=_build_extraction_prompt(protocols_context),
                    response_mime_type="application/json",
                    response_schema=GeminiExtractionPayload,
                    temperature=0.0,
                ),
            )
            parsed = response.parsed
            if parsed is None:
                raise ValueError("Gemini returned no parsed payload")
            return to_strict_payload(raw_text, parsed)
        except Exception as exc:
            last_exc = exc
            if attempt == 0 and any(k in str(exc).lower() for k in _TRANSIENT_KEYWORDS):
                logger.warning(f"[extractor] transient error, retrying: {exc}")
                _time.sleep(3)  # brief back-off before retry — gives Gemini time to recover
                continue
            raise

    raise last_exc  # type: ignore[misc]  — unreachable, satisfies type checker


# ── Check-in: direct data fetch + dedicated stream ───────────────────────────

_CHECK_IN_SYSTEM_PROMPT = """
You are LEDGER — a performance and health partner.

You have been handed a structured data export covering a specific time window. Your job is to
analyze it the way a coach reviews film before a session: find the signal, name the trends,
connect the protocol to the outcomes, and flag what needs attention.

Go deep where the data warrants it — mechanisms, pharmacokinetics, interactions, what the
numbers actually mean for performance and health. Be specific to what's in the data; do not
speculate about what isn't there.

Structure your response as flowing prose, not bullet points. Depth scales with signal.

Always end by connecting back to the user's subjective state — one open-ended question about
how they feel, what they've noticed, or what part of their routine they've been struggling with.

CRITICAL: Think inside <think>...</think> before writing your final response.
""".strip()


_GARMIN_SLEEP_METRICS = {
    "sleep_duration", "sleep_deep", "sleep_light", "sleep_rem",
    "sleep_awake", "sleep_spo2_avg", "sleep_spo2_low", "sleep_respiration", "sleep_stress",
}
_GARMIN_DAILY_METRICS = {"hrv_last_night", "hrv_weekly_avg", "resting_heart_rate", "body_battery"}


def _fmt_val(v: Any, unit: str) -> str:
    try:
        fv = float(v)
        s = f"{fv:.2f}".rstrip("0").rstrip(".")
    except (TypeError, ValueError):
        s = str(v)
    return f"{s} {unit}".strip() if unit else s


def build_check_in_context(days: int = 14) -> str:
    """Query all four tables for the past `days` days and return a formatted context block."""
    from datetime import timedelta
    from collections import defaultdict
    cutoff = (datetime.now() - timedelta(days=days)).date().isoformat()
    today = datetime.now().date().isoformat()

    sections: List[str] = [
        f"[CHECK-IN DATA - past {days} days ({cutoff} to {today})]"
    ]

    with _sqlite3.connect(_DB_PATH) as conn:
        conn.row_factory = _sqlite3.Row

        # Biometrics - split into Garmin and manual, then reformat
        bio_rows = conn.execute(
            "SELECT recorded_at, metric_name, value, unit, notes, context "
            "FROM biometric_logs WHERE date(recorded_at) >= ? ORDER BY date(recorded_at) ASC",
            (cutoff,),
        ).fetchall()

        if bio_rows:
            # Partition into Garmin sleep, Garmin daily, and manual
            # night_data: {date: {metric: (value, unit)}}
            night_data: dict = defaultdict(dict)
            # daily_data: {metric: [(date, value, unit)]}
            daily_data: dict = defaultdict(list)
            # manual_data: {metric_name: [(date, value, unit, notes)]}
            manual_data: dict = defaultdict(list)

            for r in bio_rows:
                date_str = r["recorded_at"][:10]
                metric = r["metric_name"]
                is_garmin = r["context"] == "garmin_sync"

                if is_garmin and metric in _GARMIN_SLEEP_METRICS:
                    night_data[date_str][metric] = (r["value"], r["unit"] or "")
                elif is_garmin and metric in _GARMIN_DAILY_METRICS:
                    daily_data[metric].append((date_str, r["value"], r["unit"] or ""))
                else:
                    manual_data[metric].append((date_str, r["value"], r["unit"] or "", r["notes"] or ""))

            bio_sections: List[str] = []

            def _night_val(night: dict, key: str, decimals: int = 2) -> str:
                if key not in night:
                    return "?"
                try:
                    return f"{float(night[key][0]):.{decimals}f}"
                except (TypeError, ValueError):
                    return str(night[key][0])

            # Garmin sleep: one row per night, all fields inline
            if night_data:
                lines = ["SLEEP - nightly (Garmin):"]
                for date_str in sorted(night_data.keys(), reverse=True):
                    m = night_data[date_str]
                    parts = [f"total {_night_val(m, 'sleep_duration')}h"]
                    if "sleep_deep" in m:
                        parts.append(f"deep {_night_val(m, 'sleep_deep')}h")
                    if "sleep_light" in m:
                        parts.append(f"light {_night_val(m, 'sleep_light')}h")
                    if "sleep_rem" in m:
                        parts.append(f"REM {_night_val(m, 'sleep_rem')}h")
                    if "sleep_awake" in m:
                        parts.append(f"awake {_night_val(m, 'sleep_awake')}h")
                    if "sleep_spo2_avg" in m:
                        parts.append(
                            f"SpO2 avg {_night_val(m, 'sleep_spo2_avg', 0)}%"
                            f" low {_night_val(m, 'sleep_spo2_low', 0)}%"
                        )
                    if "sleep_respiration" in m:
                        parts.append(f"resp {_night_val(m, 'sleep_respiration', 0)} br/m")
                    if "sleep_stress" in m:
                        parts.append(f"stress {_night_val(m, 'sleep_stress', 0)}")
                    lines.append(f"  {date_str}: {' | '.join(parts)}")
                bio_sections.append("\n".join(lines))

            # Garmin daily metrics: time series per metric
            if daily_data:
                lines = ["GARMIN DAILY METRICS:"]
                metric_order = ["hrv_last_night", "hrv_weekly_avg", "resting_heart_rate", "body_battery"]
                for metric in metric_order:
                    if metric not in daily_data:
                        continue
                    entries = daily_data[metric]
                    unit = entries[0][2] if entries else ""
                    label = f"  {metric} ({unit}):" if unit else f"  {metric}:"
                    series = "  ->  ".join(
                        f"{date_str[5:]}: {_fmt_val(v, '')}"
                        for date_str, v, _ in entries
                    )
                    lines.append(f"{label:<36}{series}")
                bio_sections.append("\n".join(lines))

            # Manually logged biometrics: grouped by metric name
            if manual_data:
                lines = ["MANUALLY LOGGED BIOMETRICS:"]
                for metric, entries in sorted(manual_data.items()):
                    unit = entries[0][2] if entries else ""
                    label = f"  {metric} ({unit}):" if unit else f"  {metric}:"
                    series_parts = []
                    for date_str, v, u, note in entries:
                        part = f"{date_str[5:]}: {_fmt_val(v, '')}"
                        if note:
                            part += f" [{note}]"
                        series_parts.append(part)
                    lines.append(f"{label:<36}{'  ->  '.join(series_parts)}")
                bio_sections.append("\n".join(lines))

            if bio_sections:
                sections.append("\n\n".join(bio_sections))
        else:
            sections.append(f"BIOMETRICS: none in past {days} days")

        # Compounds
        cpd_rows = conn.execute(
            "SELECT recorded_at, compound_name, dose_value, dose_unit, route, site, notes "
            "FROM compound_logs WHERE date(recorded_at) >= ? ORDER BY recorded_at DESC",
            (cutoff,),
        ).fetchall()
        if cpd_rows:
            lines = [f"COMPOUNDS ({len(cpd_rows)} records)"]
            for r in cpd_rows:
                ts = r["recorded_at"][:10]
                site = f" ({r['site']})" if r["site"] else ""
                note = f"  -- {r['notes']}" if r["notes"] else ""
                lines.append(
                    f"  {ts}  {r['compound_name']}: {r['dose_value']} {r['dose_unit']} {r['route']}{site}{note}"
                )
            sections.append("\n".join(lines))
        else:
            sections.append(f"COMPOUNDS: none in past {days} days")

        # Labs
        lab_rows = conn.execute(
            "SELECT collected_at, marker_name, panel_name, value_numeric, unit, "
            "reference_low, reference_high, flagged "
            "FROM lab_results WHERE date(collected_at) >= ? ORDER BY collected_at DESC",
            (cutoff,),
        ).fetchall()
        if lab_rows:
            lines = [f"LABS ({len(lab_rows)} records)"]
            for r in lab_rows:
                ts = r["collected_at"][:10]
                panel = f" [{r['panel_name']}]" if r["panel_name"] else ""
                ref = ""
                if r["reference_low"] is not None and r["reference_high"] is not None:
                    ref = f" (ref {r['reference_low']}-{r['reference_high']})"
                flag = " ** FLAGGED" if r["flagged"] else ""
                lines.append(
                    f"  {ts}  {r['marker_name']}{panel}: "
                    f"{r['value_numeric']} {r['unit'] or ''}{ref}{flag}"
                )
            sections.append("\n".join(lines))
        else:
            sections.append(f"LABS: none in past {days} days")

        # Journals
        jnl_rows = conn.execute(
            "SELECT journal_date, mood, energy_score, sleep_hours, notes "
            "FROM daily_journals WHERE journal_date >= ? ORDER BY journal_date DESC",
            (cutoff,),
        ).fetchall()
        if jnl_rows:
            lines = [f"JOURNALS ({len(jnl_rows)} records)"]
            for r in jnl_rows:
                mood = r["mood"] or "?"
                energy = f"energy {r['energy_score']}/10" if r["energy_score"] is not None else ""
                sleep = f"sleep {r['sleep_hours']}h" if r["sleep_hours"] else ""
                meta = "  |  ".join(filter(None, [mood, energy, sleep]))
                note = f"\n    {r['notes']}" if r["notes"] else ""
                lines.append(f"  {r['journal_date']}  {meta}{note}")
            sections.append("\n".join(lines))
        else:
            sections.append(f"JOURNALS: none in past {days} days")

    return "\n\n".join(sections)


def check_in_stream(
    days: int = 14,
    focus: Optional[str] = None,
    history: Optional[List[Dict[str, Any]]] = None,
    client: Optional[Any] = None,
) -> Generator[Tuple[str, str], None, None]:
    """Fetch all data for `days` days, build context, and stream the analysis.

    Yields ("status", msg) and ("chunk", text) tuples — same wire format as
    chat_respond_stream so the SSE endpoint can handle both identically.
    """
    from google.genai import types as _gt

    yield ("status", f"Fetching {days}-day data snapshot...")
    try:
        context = build_check_in_context(days)
    except Exception as exc:
        yield ("chunk", f"Failed to fetch ledger data: {exc}")
        return

    focus_line = f"\n\nFocus for this check-in: {focus}" if focus else ""
    user_prompt = f"{context}{focus_line}"

    active_client = client or _get_conversation_client()

    gemini_history = _to_gemini_history(history) if history else []

    chat = active_client.chats.create(
        model=CONVERSATION_MODEL,
        config=_gt.GenerateContentConfig(
            system_instruction=_CHECK_IN_SYSTEM_PROMPT,
            temperature=0.7,
            # No tools — data is pre-fetched; no tool calls needed.
        ),
        history=gemini_history,
    )

    yield ("status", "Analyzing...")
    try:
        for chunk in chat.send_message_stream(user_prompt):
            if chunk.text:
                normalized = chunk.text.replace('<thought>', '<think>').replace('</thought>', '</think>')
                yield ("chunk", normalized)
    except Exception as exc:
        yield ("chunk", f"[stream error: {exc}]")


# ── Knowledge Graph context loader ────────────────────────────────────────────

def _load_graph_context() -> List[Dict[str, Any]]:
    """Return all confirmed/testing nodes + recent hypothesis nodes for narrative context.

    No LIMIT — dropping foundational confirmed lore from the context window (the
    'Amnesia Trap') silently degrades clinical reasoning. All persistent theories
    must stay in view.
    """
    try:
        with _sqlite3.connect(str(_DB_PATH)) as conn:
            conn.row_factory = _sqlite3.Row
            rows = conn.execute(
                """SELECT concept_name, category, summary_text, confidence_level
                   FROM clinical_nodes
                   WHERE confidence_level IN ('testing', 'confirmed')
                      OR (confidence_level = 'hypothesis'
                          AND last_updated >= datetime('now', '-7 days'))
                   ORDER BY
                       CASE confidence_level
                           WHEN 'confirmed'  THEN 1
                           WHEN 'testing'    THEN 2
                           WHEN 'hypothesis' THEN 3
                       END,
                       last_updated DESC"""
            ).fetchall()
            return [dict(r) for r in rows]
    except Exception:
        return []


# ── Clinical narrative context builder ────────────────────────────────────────

_ROUTE_LABELS: Dict[str, str] = {
    "intramuscular": "IM",
    "subcutaneous": "subq",
    "oral": "orally",
    "transdermal": "transdermally",
    "intranasal": "intranasally",
    "intravenous": "IV",
}


def _generate_clinical_narrative(
    extracted: Optional[AIExtractionPayload],
    mem0_context: str,
    graph_context: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """Synthesise graph lore + mem0 history + just-logged data into readable narrative prose.

    Three sections in priority order:
      1. [Current theories]  — Knowledge Graph nodes (confirmed/testing first)
      2. [What we know]      — mem0 semantic memory hits
      3. [Just logged]       — extracted data from the current message
    """
    parts: List[str] = []

    # Section 1: Knowledge Graph theories
    if graph_context:
        theory_lines = []
        for node in graph_context:
            conf = (node.get("confidence_level") or "hypothesis").upper()
            name = node.get("concept_name", "")
            cat  = node.get("category", "")
            summ = node.get("summary_text", "")
            theory_lines.append(f"[{conf}] {name} ({cat}): {summ}")
        if theory_lines:
            parts.append("[Current theories]\n" + "\n".join(theory_lines))

    if mem0_context and mem0_context.strip():
        parts.append(f"[What we know from past sessions]\n{mem0_context.strip()}")

    if not extracted or not any([
        extracted.compounds, extracted.biometrics,
        extracted.labs, extracted.journals,
    ]):
        return "\n\n".join(parts)

    events: List[str] = []

    for c in extracted.compounds:
        route_val = c.route.value if hasattr(c.route, "value") else str(c.route)
        route_label = _ROUTE_LABELS.get(route_val, route_val)
        notes_str = f" ({c.notes})" if c.notes else ""
        events.append(
            f"The user administered {c.compound_name} — {c.dose_value} {c.dose_unit} {route_label}{notes_str}."
        )

    for b in extracted.biometrics:
        metric_label = b.metric_name.replace("_", " ")
        unit_str = f" {b.unit}" if b.unit else ""
        notes_str = f" ({b.notes})" if b.notes else ""
        events.append(
            f"He recorded his {metric_label} at {b.value}{unit_str}{notes_str}."
        )

    for lab in extracted.labs:
        val = (
            f"{lab.value_numeric} {lab.unit or ''}".strip()
            if lab.value_numeric is not None
            else lab.value_text or "—"
        )
        flagged_str = " — flagged as abnormal" if lab.flagged else ""
        panel_str = f" ({lab.panel_name})" if lab.panel_name else ""
        events.append(
            f"Lab result{panel_str}: {lab.marker_name} came back at {val}{flagged_str}."
        )

    for j in extracted.journals:
        mood_str = f", feeling {j.mood.value.replace('_', ' ')}" if j.mood else ""
        energy_str = f", energy {j.energy_score}/10" if j.energy_score is not None else ""
        sleep_str = f", slept {j.sleep_hours}h" if j.sleep_hours else ""
        events.append(
            f"Journal entry{mood_str}{energy_str}{sleep_str}: {j.notes[:200]}."
        )

    if events:
        parts.append("[Just logged]\n" + "  ".join(events))

    return "\n\n".join(parts)


# ── Ledger tools (function calling) ───────────────────────────────────────────

_TOOL_TABLE_MAP: Dict[str, tuple] = {
    # entry_type → (table, order_col, columns_to_return)
    "biometric": (
        "biometric_logs", "recorded_at",
        ["id", "metric_name", "value", "unit", "recorded_at", "notes"],
    ),
    "compound": (
        "compound_logs", "recorded_at",
        ["id", "compound_name", "dose_value", "dose_unit", "route", "site", "recorded_at", "notes"],
    ),
    "lab": (
        "lab_results", "collected_at",
        ["id", "marker_name", "panel_name", "value_numeric", "unit",
         "reference_low", "reference_high", "collected_at", "flagged"],
    ),
    "journal": (
        "daily_journals", "journal_date",
        ["id", "mood", "energy_score", "sleep_hours", "notes", "journal_date"],
    ),
}

_NAME_COL: Dict[str, str] = {
    "biometric": "metric_name",
    "compound":  "compound_name",
    "lab":       "marker_name",
    "journal":   "notes",
}


def _tool_query_entries(entry_type: str, metric_name: str = "", limit: int = 10) -> Dict[str, Any]:
    if entry_type not in _TOOL_TABLE_MAP:
        return {"error": f"Unknown entry_type '{entry_type}'. Use: biometric, compound, lab, journal"}
    table, order_col, cols = _TOOL_TABLE_MAP[entry_type]
    col_str = ", ".join(cols)
    conn = _sqlite3.connect(str(_DB_PATH))
    conn.row_factory = _sqlite3.Row
    try:
        if metric_name:
            name_col = _NAME_COL[entry_type]
            rows = conn.execute(
                f"SELECT {col_str} FROM {table} WHERE {name_col} LIKE ? ORDER BY {order_col} DESC LIMIT ?",  # noqa: S608
                (f"%{metric_name}%", max(1, int(limit))),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT {col_str} FROM {table} ORDER BY {order_col} DESC LIMIT ?",  # noqa: S608
                (max(1, int(limit)),),
            ).fetchall()
        return {"entries": [dict(r) for r in rows], "count": len(rows)}
    finally:
        conn.close()


# UPDATABLE_FIELDS imported from models.py — single source of truth


def _tool_update_entry(entry_type: str, entry_id: str, field_name: str, new_value: str) -> Dict[str, Any]:
    if entry_type not in _TOOL_TABLE_MAP:
        return {"error": f"Unknown entry_type '{entry_type}'. Use: biometric, compound, lab, journal"}
    if not entry_id or not entry_id.strip():
        return {"error": "entry_id must not be empty"}
    allowed = UPDATABLE_FIELDS.get(entry_type, set())
    if field_name not in allowed:
        return {"error": f"Field '{field_name}' is not updatable for {entry_type}. Allowed: {sorted(allowed)}"}
    table = _TOOL_TABLE_MAP[entry_type][0]
    try:
        conn = _sqlite3.connect(str(_DB_PATH))
        cursor = conn.cursor()
        cursor.execute(
            f"UPDATE {table} SET {field_name} = ? WHERE id = ?",  # noqa: S608
            (new_value.strip(), entry_id.strip()),
        )
        conn.commit()
        if cursor.rowcount == 0:
            conn.close()
            return {"error": f"No entry found with id={entry_id!r} in {table}"}
        conn.close()
        return {"success": True, "updated_id": entry_id, "field": field_name, "new_value": new_value}
    except Exception as exc:
        return {"error": str(exc)}


def _tool_delete_entry(entry_type: str, entry_id: str) -> Dict[str, Any]:
    if entry_type not in _TOOL_TABLE_MAP:
        return {"error": f"Unknown entry_type '{entry_type}'. Use: biometric, compound, lab, journal"}
    if not entry_id or not entry_id.strip():
        return {"error": "entry_id must not be empty"}
    table = _TOOL_TABLE_MAP[entry_type][0]
    conn = _sqlite3.connect(str(_DB_PATH))
    try:
        cursor = conn.execute(
            f"DELETE FROM {table} WHERE id = ?",  # noqa: S608
            (entry_id.strip(),),
        )
        conn.commit()
        if cursor.rowcount == 0:
            return {"error": f"No entry found with id={entry_id!r} in {table}"}
        return {"success": True, "deleted_id": entry_id, "entry_type": entry_type}
    finally:
        conn.close()


def _tool_save_regimen_item(
    compound_name: str,
    dose_value: str,
    dose_unit: str,
    route: str,
    frequency: str,
    time_of_day: str,
    days_of_week: str = "",
    site: str = "",
    notes: str = "",
) -> Dict[str, Any]:
    conn = _sqlite3.connect(str(_DB_PATH))
    try:
        conn.execute(
            """INSERT INTO user_regimen
                   (compound_name, dose_value, dose_unit, route, site,
                    frequency, time_of_day, days_of_week, notes, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(compound_name, time_of_day) DO UPDATE SET
                   dose_value   = excluded.dose_value,
                   dose_unit    = excluded.dose_unit,
                   route        = excluded.route,
                   site         = excluded.site,
                   frequency    = excluded.frequency,
                   days_of_week = excluded.days_of_week,
                   notes        = excluded.notes,
                   updated_at   = excluded.updated_at""",
            (
                compound_name.strip(),
                dose_value.strip(),
                dose_unit.strip(),
                route.strip(),
                site.strip() or None,
                frequency.strip(),
                time_of_day.strip(),
                days_of_week.strip() or None,
                notes.strip() or None,
            ),
        )
        conn.commit()
        return {"success": True, "compound_name": compound_name.strip(), "action": "saved_to_regimen"}
    except Exception as exc:
        return {"error": str(exc)}
    finally:
        conn.close()


def _tool_save_regimen_batch(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Save multiple regimen items in one shot — avoids the model making N separate calls."""
    conn = _sqlite3.connect(str(_DB_PATH))
    saved: List[str] = []
    errors: List[str] = []
    try:
        for item in items:
            if not isinstance(item, dict):
                errors.append(f"Invalid item (not a dict): {item!r}")
                continue
            name = str(item.get("compound_name", "")).strip()
            if not name:
                errors.append("compound_name is required")
                continue
            try:
                conn.execute(
                    """INSERT INTO user_regimen
                           (compound_name, dose_value, dose_unit, route, site,
                            frequency, time_of_day, days_of_week, notes, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                       ON CONFLICT(compound_name, time_of_day) DO UPDATE SET
                           dose_value   = excluded.dose_value,
                           dose_unit    = excluded.dose_unit,
                           route        = excluded.route,
                           site         = excluded.site,
                           frequency    = excluded.frequency,
                           days_of_week = excluded.days_of_week,
                           notes        = excluded.notes,
                           updated_at   = excluded.updated_at""",
                    (
                        name,
                        str(item.get("dose_value", "")).strip(),
                        str(item.get("dose_unit", "")).strip(),
                        str(item.get("route", "oral")).strip(),
                        str(item.get("site", "") or "").strip() or None,
                        str(item.get("frequency", "daily")).strip(),
                        str(item.get("time_of_day", "morning")).strip(),
                        str(item.get("days_of_week", "") or "").strip() or None,
                        str(item.get("notes", "") or "").strip() or None,
                    ),
                )
                saved.append(name)
            except Exception as exc:
                errors.append(f"{name}: {exc}")
        conn.commit()
    finally:
        conn.close()
    return {"success": len(errors) == 0, "saved": saved, "errors": errors, "count": len(saved)}


def _tool_remove_regimen_item(compound_name: str, time_of_day: str = "") -> Dict[str, Any]:
    conn = _sqlite3.connect(str(_DB_PATH))
    try:
        if time_of_day.strip():
            cursor = conn.execute(
                "DELETE FROM user_regimen WHERE compound_name = ? AND time_of_day = ?",
                (compound_name.strip(), time_of_day.strip()),
            )
        else:
            cursor = conn.execute(
                "DELETE FROM user_regimen WHERE compound_name = ?",
                (compound_name.strip(),),
            )
        conn.commit()
        if cursor.rowcount == 0:
            return {"error": f"No regimen entry found for '{compound_name.strip()}'"}
        return {"success": True, "compound_name": compound_name.strip(), "removed": cursor.rowcount}
    finally:
        conn.close()


def get_regimen_context() -> str:
    """Return the current regimen as a formatted string for narrative / synthesis context."""
    conn = _sqlite3.connect(str(_DB_PATH))
    try:
        rows = conn.execute(
            """SELECT compound_name, dose_value, dose_unit, route, frequency, time_of_day, days_of_week
               FROM user_regimen
               ORDER BY
                   CASE time_of_day
                       WHEN 'morning'   THEN 1
                       WHEN 'midday'    THEN 2
                       WHEN 'afternoon' THEN 3
                       WHEN 'evening'   THEN 4
                       WHEN 'night'     THEN 5
                       ELSE 6
                   END,
                   CASE frequency
                       WHEN 'daily'       THEN 1
                       WHEN 'twice_daily' THEN 2
                       WHEN 'weekly'      THEN 3
                       WHEN 'biweekly'    THEN 4
                       WHEN 'monthly'     THEN 5
                       ELSE 6
                   END,
                   compound_name"""
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return ""
    lines = []
    for name, dv, du, route, freq, tod, days in rows:
        day_str = f" ({days})" if days and freq == "weekly" else ""
        lines.append(f"  {name}: {dv}{du} {route} — {freq}{day_str} [{tod}]")
    return "Current Regimen:\n" + "\n".join(lines)


def _tool_save_protocol(protocol_name: str, protocol_content: str) -> Dict[str, Any]:
    if not protocol_name.strip():
        return {"error": "protocol_name must not be empty"}
    if not protocol_content.strip():
        return {"error": "protocol_content must not be empty"}
    conn = _sqlite3.connect(str(_DB_PATH))
    try:
        conn.execute(
            """INSERT INTO user_protocols (protocol_name, protocol_content, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(protocol_name) DO UPDATE SET
                   protocol_content = excluded.protocol_content,
                   updated_at       = excluded.updated_at""",
            (protocol_name.strip(), protocol_content.strip()),
        )
        conn.commit()
        return {"success": True, "protocol_name": protocol_name.strip(), "action": "saved"}
    except Exception as exc:
        return {"error": str(exc)}
    finally:
        conn.close()


def _tool_delete_protocol(protocol_name: str) -> Dict[str, Any]:
    if not protocol_name.strip():
        return {"error": "protocol_name must not be empty"}
    conn = _sqlite3.connect(str(_DB_PATH))
    try:
        cursor = conn.execute(
            "DELETE FROM user_protocols WHERE protocol_name = ?",
            (protocol_name.strip(),),
        )
        conn.commit()
        if cursor.rowcount == 0:
            return {"error": f"No protocol named '{protocol_name.strip()}' found"}
        return {"success": True, "protocol_name": protocol_name.strip(), "action": "deleted"}
    finally:
        conn.close()


def get_all_protocols() -> str:
    """Return all user_protocols rows as a formatted string for extractor prompt injection.
    Returns empty string if no protocols are defined.
    """
    conn = _sqlite3.connect(str(_DB_PATH))
    try:
        rows = conn.execute(
            "SELECT protocol_name, protocol_content FROM user_protocols ORDER BY protocol_name"
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return ""
    lines = [f'- "{name}": {content}' for name, content in rows]
    return "KNOWN PROTOCOLS:\n" + "\n".join(lines)


def _execute_ledger_tool(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if name == "query_entries":
        return _tool_query_entries(
            entry_type=str(args.get("entry_type", "")),
            metric_name=str(args.get("metric_name", "")),
            limit=int(args.get("limit", 10)),
        )
    if name == "update_entry":
        return _tool_update_entry(
            entry_type=str(args.get("entry_type", "")),
            entry_id=str(args.get("entry_id", "")),
            field_name=str(args.get("field_name", "")),
            new_value=str(args.get("new_value", "")),
        )
    if name == "delete_entry":
        return _tool_delete_entry(
            entry_type=str(args.get("entry_type", "")),
            entry_id=str(args.get("entry_id", "")),
        )
    if name == "save_regimen_batch":
        items = args.get("items", [])
        if not isinstance(items, list):
            return {"error": "items must be a list"}
        return _tool_save_regimen_batch(items)
    if name == "save_regimen_item":
        return _tool_save_regimen_item(
            compound_name=str(args.get("compound_name", "")),
            dose_value=str(args.get("dose_value", "")),
            dose_unit=str(args.get("dose_unit", "")),
            route=str(args.get("route", "oral")),
            frequency=str(args.get("frequency", "daily")),
            time_of_day=str(args.get("time_of_day", "morning")),
            days_of_week=str(args.get("days_of_week", "")),
            site=str(args.get("site", "")),
            notes=str(args.get("notes", "")),
        )
    if name == "remove_regimen_item":
        return _tool_remove_regimen_item(
            compound_name=str(args.get("compound_name", "")),
            time_of_day=str(args.get("time_of_day", "")),
        )
    if name == "save_protocol":
        return _tool_save_protocol(
            protocol_name=str(args.get("protocol_name", "")),
            protocol_content=str(args.get("protocol_content", "")),
        )
    if name == "delete_protocol":
        return _tool_delete_protocol(
            protocol_name=str(args.get("protocol_name", "")),
        )
    return {"error": f"Unknown tool: {name}"}


def _make_ledger_tools() -> List[Any]:
    """Build Gemini Tool objects for function calling. Called lazily to avoid import cost."""
    from google.genai import types

    return [types.Tool(function_declarations=[
        types.FunctionDeclaration(
            name="query_entries",
            description=(
                "Search the health ledger database for logged entries. "
                "Use this to find specific records — for example, to locate "
                "the UUID of an entry before deleting it, or to look up recent "
                "values for a given metric, compound, or lab marker."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "entry_type": types.Schema(
                        type="STRING",
                        enum=["biometric", "compound", "lab", "journal"],
                        description="Type of health entry to search.",
                    ),
                    "metric_name": types.Schema(
                        type="STRING",
                        description=(
                            "Optional partial-match name filter. "
                            "For biometrics: metric name (e.g. 'heart_rate'). "
                            "For compounds: compound name (e.g. 'vitamin d'). "
                            "For labs: marker name (e.g. 'Vitamin D'). "
                            "Leave empty to return the most recent entries of that type."
                        ),
                    ),
                    "limit": types.Schema(
                        type="INTEGER",
                        description="Maximum number of entries to return. Default 10.",
                    ),
                },
                required=["entry_type"],
            ),
        ),
        types.FunctionDeclaration(
            name="update_entry",
            description=(
                "Update a single field on an existing health ledger entry. "
                "Always call query_entries first to confirm the exact entry_id. "
                "Use this to correct dates, values, units, or names. "
                "Dates must be full ISO 8601 strings (e.g. '2026-05-19T00:00:00+00:00'). "
                "To update multiple fields on the same entry, call this tool once per field."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "entry_type": types.Schema(
                        type="STRING",
                        enum=["biometric", "compound", "lab", "journal"],
                        description="Type of the entry to update.",
                    ),
                    "entry_id": types.Schema(
                        type="STRING",
                        description="UUID of the entry to update.",
                    ),
                    "field_name": types.Schema(
                        type="STRING",
                        description=(
                            "Field to update. "
                            "lab: collected_at, panel_name, marker_name, value_numeric, unit, "
                            "reference_low, reference_high, notes, flagged. "
                            "biometric: recorded_at, metric_name, value, unit, notes. "
                            "compound: recorded_at, compound_name, dose_value, dose_unit, route, site, notes. "
                            "journal: journal_date, mood, energy_score, sleep_hours, notes."
                        ),
                    ),
                    "new_value": types.Schema(
                        type="STRING",
                        description="New value as a string. Dates in ISO 8601. Numbers as decimal strings.",
                    ),
                },
                required=["entry_type", "entry_id", "field_name", "new_value"],
            ),
        ),
        types.FunctionDeclaration(
            name="delete_entry",
            description=(
                "Permanently delete a specific health ledger entry by its UUID. "
                "Always call query_entries first to confirm the exact entry_id. "
                "This action is irreversible."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "entry_type": types.Schema(
                        type="STRING",
                        enum=["biometric", "compound", "lab", "journal"],
                        description="Type of the entry to delete.",
                    ),
                    "entry_id": types.Schema(
                        type="STRING",
                        description="UUID of the entry to delete.",
                    ),
                },
                required=["entry_type", "entry_id"],
            ),
        ),
        types.FunctionDeclaration(
            name="save_regimen_batch",
            description=(
                "Save multiple compounds to the standing regimen in ONE call. "
                "ALWAYS use this (not save_regimen_item) when the user lists two or more compounds. "
                "When the user declares a protocol — 'here\\'s my stack', 'I take X, Y, and Z', "
                "'here\\'s what I got', 'I switched to...' — call this ONCE with ALL compounds "
                "in the items array. Missing compounds will not be saved. "
                "Defaults: route=oral, frequency=daily, time_of_day=morning."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "items": types.Schema(
                        type="ARRAY",
                        description="Every compound in the declared protocol, one object per compound.",
                        items=types.Schema(
                            type="OBJECT",
                            properties={
                                "compound_name": types.Schema(type="STRING", description="Name of the compound."),
                                "dose_value":    types.Schema(type="STRING", description="Numeric dose, e.g. '5', '300'."),
                                "dose_unit":     types.Schema(type="STRING", description="Unit: mcg, mg, g, iu, ml."),
                                "route":         types.Schema(
                                    type="STRING",
                                    enum=["oral", "subcutaneous", "intramuscular", "intravenous", "transdermal", "intranasal", "other"],
                                ),
                                "frequency":     types.Schema(
                                    type="STRING",
                                    enum=["daily", "twice_daily", "weekly", "biweekly", "monthly", "as_needed"],
                                ),
                                "time_of_day":   types.Schema(
                                    type="STRING",
                                    enum=["morning", "midday", "afternoon", "evening", "night", "as_needed"],
                                ),
                                "days_of_week":  types.Schema(type="STRING", description="Comma-separated days for weekly items."),
                                "site":          types.Schema(type="STRING", description="Injection site if applicable."),
                                "notes":         types.Schema(type="STRING", description="Optional notes."),
                            },
                            required=["compound_name", "dose_value", "dose_unit", "route", "frequency", "time_of_day"],
                        ),
                    ),
                },
                required=["items"],
            ),
        ),
        types.FunctionDeclaration(
            name="save_regimen_item",
            description=(
                "Add or update a SINGLE compound in the user's regimen. "
                "Use save_regimen_batch instead when saving two or more compounds. "
                "Use this only for a single-compound update (e.g. dose change on one item). "
                "Upserts on (compound_name, time_of_day), so re-running is safe."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "compound_name": types.Schema(type="STRING", description="Name of the compound."),
                    "dose_value":    types.Schema(type="STRING", description="Numeric dose amount, e.g. '5', '200'."),
                    "dose_unit":     types.Schema(type="STRING", description="Unit: mcg, mg, g, iu, ml."),
                    "route":         types.Schema(
                        type="STRING",
                        enum=["oral", "subcutaneous", "intramuscular", "intravenous", "transdermal", "intranasal", "other"],
                        description="Administration route.",
                    ),
                    "frequency":     types.Schema(
                        type="STRING",
                        enum=["daily", "twice_daily", "weekly", "biweekly", "monthly", "as_needed"],
                        description="How often the compound is taken.",
                    ),
                    "time_of_day":   types.Schema(
                        type="STRING",
                        enum=["morning", "midday", "afternoon", "evening", "night", "as_needed"],
                        description="When during the day it is taken.",
                    ),
                    "days_of_week":  types.Schema(type="STRING", description="Comma-separated days for weekly items, e.g. 'Monday,Thursday'."),
                    "site":          types.Schema(type="STRING", description="Injection site if applicable."),
                    "notes":         types.Schema(type="STRING", description="Optional notes."),
                },
                required=["compound_name", "dose_value", "dose_unit", "route", "frequency", "time_of_day"],
            ),
        ),
        types.FunctionDeclaration(
            name="remove_regimen_item",
            description=(
                "Remove a compound from the user's current regimen. "
                "If time_of_day is omitted, removes all entries for that compound. "
                "Use when the user says they stopped taking something."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "compound_name": types.Schema(type="STRING", description="Name of the compound to remove."),
                    "time_of_day":   types.Schema(type="STRING", description="Optional: only remove the entry at this time of day."),
                },
                required=["compound_name"],
            ),
        ),
        types.FunctionDeclaration(
            name="save_protocol",
            description=(
                "Save or update a named protocol alias. A protocol is a shorthand name "
                "(e.g. 'Morning Stack') that maps to a list of compounds with doses. "
                "Once saved, if the user says 'took my Morning Stack', the extractor will "
                "automatically expand it into every constituent compound log. "
                "Use this when the user defines or updates a recurring supplement stack."
            ),
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "protocol_name": types.Schema(
                        type="STRING",
                        description="Shorthand name for the protocol, e.g. 'Morning Stack'.",
                    ),
                    "protocol_content": types.Schema(
                        type="STRING",
                        description=(
                            "Comma-separated compounds with doses and routes, "
                            "e.g. '5mg TAK-653 oral, 2g ALCAR oral, 5mg Memantine oral'."
                        ),
                    ),
                },
                required=["protocol_name", "protocol_content"],
            ),
        ),
        types.FunctionDeclaration(
            name="delete_protocol",
            description="Permanently delete a named protocol alias by its exact name.",
            parameters=types.Schema(
                type="OBJECT",
                properties={
                    "protocol_name": types.Schema(
                        type="STRING",
                        description="Exact name of the protocol to delete.",
                    ),
                },
                required=["protocol_name"],
            ),
        ),
    ])]


# ── Conversational response ────────────────────────────────────────────────────

def _to_gemini_history(history: List[Dict[str, Any]]) -> List[Any]:
    """Convert [{role, content}] rows to alternating Gemini Content objects.

    Gemini requires strictly alternating user/model turns starting with 'user'.
    We drop any leading 'model' entries and silently skip out-of-order messages
    so a corrupt or partially-saved history never crashes the request.
    """
    from google.genai import types as _types

    contents: List[Any] = []
    expected = "user"
    for msg in history:
        if msg["role"] == expected:
            contents.append(
                _types.Content(
                    role=msg["role"],
                    parts=[_types.Part(text=msg["content"])],
                )
            )
            expected = "model" if expected == "user" else "user"
    return contents


def chat_respond(
    user_text: str,
    extracted: Optional[AIExtractionPayload],
    mem0_context: str,
    history: Optional[List[Dict[str, Any]]] = None,
    client: Optional[Any] = None,
) -> str:
    """Generate a natural-language response using the health companion persona.

    history — list of {role, content} dicts from the chat_history table,
               in chronological order (oldest first). Used to seed Gemini's
               multi-turn chat so the model retains conversational context.
    """
    active_client = client or _get_conversation_client()
    from google.genai import types

    # Build the enriched user prompt for this turn
    graph_context = _load_graph_context()
    narrative = _generate_clinical_narrative(extracted, mem0_context, graph_context)
    prompt = f"{narrative}\n\n[User message]\n{user_text}" if narrative else user_text

    # Seed the chat with prior turns so the model has conversational memory
    gemini_history = _to_gemini_history(history) if history else []

    chat = active_client.chats.create(
        model=CONVERSATION_MODEL,
        config=types.GenerateContentConfig(
            system_instruction=_build_conversation_prompt(),
            temperature=0.7,
            tools=_make_ledger_tools(),
        ),
        history=gemini_history,
    )

    response = chat.send_message(prompt)

    # ── Tool-calling loop ─────────────────────────────────────────────────────
    # Gemini may request multiple rounds of tool calls before producing text.
    # We cap at 5 rounds to avoid infinite loops on misbehaving models.
    _MAX_TOOL_ROUNDS = 5
    _made_tool_calls = False
    for _round in range(_MAX_TOOL_ROUNDS):
        fn_calls = getattr(response, "function_calls", None) or []
        if not fn_calls:
            break  # model returned text — done

        _made_tool_calls = True
        logger.info(f"[chat_respond] tool round {_round + 1}: {[fc.name for fc in fn_calls]}")

        tool_parts = []
        for fc in fn_calls:
            result = _execute_ledger_tool(fc.name, dict(fc.args or {}))
            logger.info(f"[chat_respond]   {fc.name}({dict(fc.args or {})}) -> {result}")
            tool_parts.append(
                types.Part.from_function_response(
                    name=fc.name,
                    response={"result": result},
                )
            )
        response = chat.send_message(tool_parts)

    text = (response.text or "").strip()
    if not text and _made_tool_calls:
        # Model completed tool calls but returned no text. Nudge it once for a
        # brief confirmation rather than surfacing a generic error to the user.
        try:
            response = chat.send_message("Please give a brief confirmation of what was just completed.")
            text = (response.text or "").strip()
        except Exception:
            pass
    return text or "I wasn't able to generate a response — please try again."


# ── Streaming conversational response ─────────────────────────────────────────

def _clean_response_text(text: str) -> str:
    """Strip Gemini 2.5 Pro function-echo artifacts and normalize think tags.

    After tool calls, Gemini 2.5 Pro sometimes prefixes its response with the raw
    function-response JSON it received (e.g. "response:query_entries{result:{...}}").
    Uses brace-counting to find the exact end of each JSON blob, so this works
    regardless of whether there's a blank line or <think> tag after the echo.
    Also normalizes <thought> → <think> for the frontend parser.
    """
    text = text.replace('<thought>', '<think>').replace('</thought>', '</think>')

    content = text.lstrip()

    # Nothing to strip if text doesn't start with a function-response echo
    if not (content.startswith('response:') or content.startswith('nodemailer:')):
        return text.strip()

    # Strip all leading function-echo blocks using brace-counting.
    # Blocks look like: [nodemailer:] response:funcname{...json...}
    while True:
        content = re.sub(r'^nodemailer:\s*', '', content)
        if not content.startswith('response:'):
            break
        brace_idx = content.find('{')
        if brace_idx == -1:
            break
        content = content[brace_idx:]
        depth = 0
        end = -1
        for i, ch in enumerate(content):
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end == -1:
            break
        content = content[end + 1:].lstrip()

    result = content.strip()
    # Return empty string when the echo stripped to nothing — callers handle "" by nudging
    # the model. Do NOT fall back to text.strip() here; that re-surfaces the echo.
    return result


def chat_respond_stream(
    user_text: str,
    extracted: Optional[AIExtractionPayload],
    mem0_context: str,
    history: Optional[List[Dict[str, Any]]] = None,
    client: Optional[Any] = None,
) -> Generator[Tuple[str, str], None, None]:
    """Streaming variant of chat_respond.

    Yields (type, payload) tuples:
      ("status", message)  — pipeline/tool status events
      ("chunk",  text)     — response text fragments

    For the first API call (no tool calls needed) uses real SDK streaming.
    After tool rounds, fake-streams the accumulated text from memory so the
    <think> parser works identically in both paths.
    """
    active_client = client or _get_conversation_client()
    from google.genai import types

    graph_context = _load_graph_context()
    narrative = _generate_clinical_narrative(extracted, mem0_context, graph_context)
    prompt = f"{narrative}\n\n[User message]\n{user_text}" if narrative else user_text

    gemini_history = _to_gemini_history(history) if history else []

    chat = active_client.chats.create(
        model=CONVERSATION_MODEL,
        config=types.GenerateContentConfig(
            system_instruction=_build_conversation_prompt(),
            temperature=0.7,
            tools=_make_ledger_tools(),
        ),
        history=gemini_history,
    )

    # ── Phase 1: real streaming on the first call ─────────────────────────────
    # If the model wants tool calls, fn_calls will be non-empty on the last chunk
    # and we fall through to the tool loop below.
    last_chunk = None
    tool_loop_response = None  # set before Phase 2 via normal or preamble path
    streamed_text: list[str] = []
    try:
        for chunk in chat.send_message_stream(prompt):
            # Skip .text access on function-call chunks — the SDK emits a WARNING
            # when .text is accessed on a response whose parts are non-text (function_call).
            if not getattr(chunk, "function_calls", None):
                if chunk.text:
                    streamed_text.append(chunk.text)
                    yield ("chunk", chunk.text)
            last_chunk = chunk
    except Exception as exc:
        yield ("chunk", f"[stream error: {exc}]")
        return

    fn_calls = (getattr(last_chunk, "function_calls", None) or []) if last_chunk else []

    if not fn_calls:
        if not streamed_text:
            yield ("chunk", "I wasn't able to generate a response — please try again.")
            return

        # Safety net: if the model produced a short preamble without querying data,
        # nudge it to follow through. Signals: short visible text + deferral phrase.
        # Strip <think>...</think> before measuring — the reasoning chain can be 400+
        # chars while the human-readable preamble is only ~180, pushing the total past
        # the threshold and causing the else-return to silently drop the response.
        accumulated = "".join(streamed_text)
        visible = re.sub(r'<think>.*?</think>', '', accumulated, flags=re.DOTALL).strip()
        _DEFERRAL_SIGNALS = ("shortly", "in a moment", "i'll ", "i will ", "let me ",
                             "pulling", "fetching", "give you a full", "analyzing",
                             "i've just pulled", "i just pulled", "have the analysis",
                             "look that up", "check that", "one moment")
        is_preamble = (
            len(visible) < 350
            and any(s in visible.lower() for s in _DEFERRAL_SIGNALS)
        )
        if is_preamble:
            yield ("status", "Following up...")
            try:
                followup = chat.send_message(
                    "Go ahead — call query_entries now and give the full analysis."
                )
                fn_calls = getattr(followup, "function_calls", None) or []
                if fn_calls:
                    # Rewire: treat followup as the entry point for Phase 2
                    tool_loop_response = followup
                    # Don't return — fall through to Phase 2 below
                else:
                    text = (followup.text or "").strip()
                    if text:
                        for token in re.split(r"(\s+)", text):
                            if token:
                                yield ("chunk", token)
                    else:
                        yield ("chunk", "I wasn't able to retrieve that data. Please try asking again.")
                    return
            except Exception as exc:
                yield ("chunk", f"[stream error: {exc}]")
                return
        else:
            return

    # ── Phase 2: tool-calling loop (non-streaming) ────────────────────────────
    response = tool_loop_response if tool_loop_response is not None else last_chunk
    _MAX_TOOL_ROUNDS = 5
    for _round in range(_MAX_TOOL_ROUNDS):
        fn_calls = getattr(response, "function_calls", None) or []
        if not fn_calls:
            break

        logger.info(f"[chat_respond_stream] tool round {_round + 1}: {[fc.name for fc in fn_calls]}")
        tool_parts = []
        for fc in fn_calls:
            result = _execute_ledger_tool(fc.name, dict(fc.args or {}))
            logger.info(f"[chat_respond_stream]   {fc.name}({dict(fc.args or {})}) -> {result}")
            yield ("status", f"Tool: {fc.name}")
            tool_parts.append(
                types.Part.from_function_response(
                    name=fc.name,
                    response={"result": result},
                )
            )
        response = chat.send_message(tool_parts)

    text = _clean_response_text(response.text or "")
    if not text:
        try:
            response = chat.send_message("Please give a brief confirmation of what was just completed.")
            text = (response.text or "").strip()
        except Exception:
            pass

    if not text:
        yield ("chunk", "I wasn't able to generate a response — please try again.")
        return

    # ── Phase 3: fake-stream the accumulated post-tool text ───────────────────
    # Split by whitespace tokens (preserves spaces) so the <think> parser sees
    # the same text structure as it would from real streaming.
    for token in re.split(r"(\s+)", text):
        if token:
            yield ("chunk", token)


# ── File-import interpretation (no tools) ─────────────────────────────────────

_IMPORT_INTERPRETATION_PROMPT = """
You are LEDGER — a clinical health partner.

A file was just imported and committed to the ledger. The structured data below is the COMPLETE
and CURRENT ground truth for this analysis. Do NOT reference prior conversations, previous lab
results, or any values not listed in the import summary you were given. Every number you cite
must come directly from that import — no exceptions.

Analyze what was just committed:
- Interpret each value against known healthy ranges (cite mechanism, not just "normal"/"abnormal")
- Flag anything that warrants attention and explain why
- Identify patterns across the panel (lipid ratios, CBC differentials, hormone axes, etc.)
- Connect values to each other where clinically meaningful

Depth scales with signal. Write flowing prose, not bullets.

CRITICAL: Think inside <think>...</think> before writing your final response.
""".strip()


def import_interpret_stream(
    filename: str,
    extracted: Optional[AIExtractionPayload],
    committed: Optional[Dict[str, Any]],
    history: Optional[List[Dict[str, Any]]] = None,
    client: Optional[Any] = None,
) -> Generator[Tuple[str, str], None, None]:
    """Stream an interpretation of a file import WITHOUT ledger tool calls.

    The data was just committed by the caller, so we pass a structured summary
    of exactly what was imported rather than asking the model to re-query it.
    This avoids the Gemini function-response echo bug and eliminates the extra
    API round trips that tool calls add (typically 30–90 s each).

    Yields ("status", msg) and ("chunk", text) tuples.
    """
    active_client = client or _get_conversation_client()
    from google.genai import types as _gt

    # ── Build concise import summary ──────────────────────────────────────────
    lines: List[str] = [f"[File import: {filename}]"]

    has_data = extracted and any([
        extracted.compounds, extracted.biometrics,
        extracted.labs, extracted.journals,
    ])

    if has_data:
        assert extracted is not None  # type narrowing
        for b in extracted.biometrics:
            unit_str = f" {b.unit}" if b.unit else ""
            lines.append(f"Biometric: {b.metric_name} = {b.value}{unit_str}")

        for lab in extracted.labs:
            val = (
                f"{lab.value_numeric} {lab.unit or ''}".strip()
                if lab.value_numeric is not None
                else lab.value_text or "?"
            )
            ref = ""
            if lab.reference_low is not None and lab.reference_high is not None:
                ref = f" (ref {lab.reference_low}–{lab.reference_high})"
            flagged = " ⚑ FLAGGED" if lab.flagged else ""
            panel = f" [{lab.panel_name}]" if lab.panel_name else ""
            date_str = lab.collected_at.strftime("%Y-%m-%d") if lab.collected_at else "unknown date"
            lines.append(f"Lab{panel} ({date_str}): {lab.marker_name} = {val}{ref}{flagged}")

        for c in extracted.compounds:
            lines.append(
                f"Compound: {c.compound_name} {c.dose_value} {c.dose_unit} ({c.route})"
            )

        for j in extracted.journals:
            mood_str = f", {j.mood.value}" if j.mood else ""
            lines.append(f"Journal{mood_str}: {j.notes[:200]}")
    else:
        lines.append("No structured health data was extracted from this file.")

    if committed is not None:
        inserted = {k: v for k, v in committed.items() if k != "skipped"}
        total_inserted = sum(v for v in inserted.values() if isinstance(v, (int, float)))
        if total_inserted > 0:
            counts = ", ".join(f"{k}: {v}" for k, v in inserted.items() if v)
            lines.append(f"Committed to ledger — {counts}")
        else:
            skipped_dict = committed.get("skipped", {})
            total_skipped = sum(skipped_dict.values()) if isinstance(skipped_dict, dict) else 0
            if total_skipped > 0:
                lines.append(
                    f"Note: All {total_skipped} entries were already in the ledger "
                    "(previously imported — 0 new rows written this time)."
                )
            else:
                lines.append("Note: No data was committed to the ledger.")

    prompt = (
        "\n".join(lines)
        + "\n\nAnalyze and interpret the imported data. Base your analysis solely "
        "on the data listed above. For each value, state the collection date explicitly. "
        "If the data is from months ago, make that clear — do not present old results as current."
    )

    gemini_history = _to_gemini_history(history) if history else []

    # No tools — the data is in the prompt, so no tool round trips needed.
    # Use the import-specific prompt (no tool-call instructions, no cross-session refs).
    chat = active_client.chats.create(
        model=CONVERSATION_MODEL,
        config=_gt.GenerateContentConfig(
            system_instruction=_IMPORT_INTERPRETATION_PROMPT,
            temperature=0.7,
        ),
        history=gemini_history,
    )

    yield ("status", "Interpreting imported data...")
    try:
        for chunk in chat.send_message_stream(prompt):
            if chunk.text:
                normalized = (
                    chunk.text
                    .replace("<thought>", "<think>")
                    .replace("</thought>", "</think>")
                )
                yield ("chunk", normalized)
    except Exception as exc:
        yield ("error", f"Interpretation error: {exc}")
