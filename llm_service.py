from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError

from models import AIExtractionPayload, AdministrationRoute, DoseUnit, LabValueType, Mood


load_dotenv()

API_URL = os.getenv("OSASSISTANT_API_URL", "http://127.0.0.1:8787/api/v1/log/raw")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")


SYSTEM_INSTRUCTION = """
You are a clinical harm-reduction data extractor.
Read unstructured user logs and map only explicitly stated facts to the provided JSON schema.
Do not invent compounds, biometrics, labs, symptoms, dates, doses, units, routes, or notes.
Use null or omit optional fields when data is not present.

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
- For daily journal entries, summarize subjective state in notes and list symptoms when stated.
- All datetimes must be timezone-aware ISO 8601 strings. If no timestamp is stated, omit the
  datetime field so the local schema can apply its default timestamp.
""".strip()


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


def get_client() -> Any:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    from google import genai

    return genai.Client(api_key=api_key)


def normalize_payload(raw_text: str, payload: AIExtractionPayload) -> AIExtractionPayload:
    payload.raw_input_text = raw_text

    # Keep log_type aligned with the lists Gemini actually populated.
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


def extract(raw_text: str, client: Optional[Any] = None) -> AIExtractionPayload:
    if not raw_text.strip():
        raise ValueError("raw_text cannot be empty")

    active_client = client or get_client()
    from google.genai import types

    response = active_client.models.generate_content(
        model=GEMINI_MODEL,
        contents=raw_text,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_INSTRUCTION,
            response_mime_type="application/json",
            response_schema=GeminiExtractionPayload,
            temperature=0.0,
        ),
    )

    parsed = response.parsed
    if parsed is None:
        raise ValueError("Gemini returned no parsed payload")
    return to_strict_payload(raw_text, parsed)


def route_payload(payload: AIExtractionPayload, api_url: str = API_URL) -> Dict[str, Any]:
    import requests

    api_response = requests.post(
        api_url,
        data=payload.model_dump_json(exclude_none=True),
        headers={"Content-Type": "application/json"},
        timeout=15,
    )
    api_response.raise_for_status()
    return api_response.json()


def extract_and_route(raw_text: str) -> Dict[str, Any]:
    try:
        extracted_data = extract(raw_text)
    except (RuntimeError, ValueError, ValidationError) as exc:
        return {"status": "error", "stage": "extraction", "message": str(exc)}
    except Exception as exc:
        return {"status": "error", "stage": "gemini", "message": str(exc)}

    try:
        api_result = route_payload(extracted_data)
    except Exception as exc:
        return {"status": "error", "stage": "api", "message": str(exc)}

    print("\n--- Successful Extraction & Database Commit ---")
    print(extracted_data.model_dump_json(indent=2, exclude_none=True))
    return api_result


if __name__ == "__main__":
    test_input = (
        "Weight is holding steady at 215. Pinned 50mg of Anadrol with the 1-inch, "
        "smooth shot. Sleep was rough, maybe 5 hours. Zero drinks yesterday. "
        "BP was 120/80 this morning."
    )
    print(extract_and_route(test_input))
