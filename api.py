from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from init_storage import DATABASE_PATH, WAL_PATH, initialize_storage
from llm_service import extract_and_route
from memory_layer import add_semantic_memory, retrieve_context
from models import AIExtractionPayload, BiometricLog, CompoundLog, DailyJournal, LabResult


app = FastAPI(title="Semantic Health Ledger API", version="1.0.0")


class ChatMessage(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def json_default(value: Any) -> str:
    if isinstance(value, (datetime, UUID)):
        return str(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def append_to_wal(raw_text: str, source: str = "user") -> None:
    WAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    wal_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "raw_text": raw_text,
    }
    with WAL_PATH.open("a", encoding="utf-8") as wal_file:
        wal_file.write(json.dumps(wal_entry, default=json_default) + "\n")


def get_db_conn() -> sqlite3.Connection:
    initialize_storage(DATABASE_PATH, WAL_PATH)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def model_as_wal_text(model: Any) -> str:
    raw_text = getattr(model, "raw_text", None)
    if raw_text:
        return raw_text
    return model.model_dump_json()


def insert_compound(cursor: sqlite3.Cursor, compound: CompoundLog) -> None:
    cursor.execute(
        """
        INSERT INTO compound_logs (
            id, recorded_at, compound_name, dose_value, dose_unit, route,
            site, protocol_phase, notes, raw_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(compound.id),
            compound.recorded_at.isoformat(),
            compound.compound_name,
            str(compound.dose_value),
            compound.dose_unit,
            compound.route,
            compound.site,
            compound.protocol_phase,
            compound.notes,
            compound.raw_text,
        ),
    )


def insert_biometric(cursor: sqlite3.Cursor, biometric: BiometricLog) -> None:
    cursor.execute(
        """
        INSERT INTO biometric_logs (
            id, recorded_at, metric_name, value, unit, context, notes, raw_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(biometric.id),
            biometric.recorded_at.isoformat(),
            biometric.metric_name,
            str(biometric.value),
            biometric.unit,
            biometric.context,
            biometric.notes,
            biometric.raw_text,
        ),
    )


def insert_lab_result(cursor: sqlite3.Cursor, lab: LabResult) -> None:
    cursor.execute(
        """
        INSERT INTO lab_results (
            id, collected_at, resulted_at, panel_name, marker_name, value_type,
            value_numeric, value_text, unit, reference_low, reference_high,
            lab_name, flagged, notes, raw_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(lab.id),
            lab.collected_at.isoformat(),
            lab.resulted_at.isoformat() if lab.resulted_at else None,
            lab.panel_name,
            lab.marker_name,
            lab.value_type,
            str(lab.value_numeric) if lab.value_numeric is not None else None,
            lab.value_text,
            lab.unit,
            str(lab.reference_low) if lab.reference_low is not None else None,
            str(lab.reference_high) if lab.reference_high is not None else None,
            lab.lab_name,
            int(lab.flagged),
            lab.notes,
            lab.raw_text,
        ),
    )


def insert_daily_journal(cursor: sqlite3.Cursor, journal: DailyJournal) -> None:
    cursor.execute(
        """
        INSERT INTO daily_journals (
            id, journal_date, mood, energy_score, sleep_hours, symptoms,
            training, nutrition, notes, raw_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(journal.id),
            journal.journal_date.isoformat(),
            journal.mood,
            journal.energy_score,
            str(journal.sleep_hours) if journal.sleep_hours is not None else None,
            json.dumps(journal.symptoms),
            journal.training,
            journal.nutrition,
            journal.notes,
            journal.raw_text,
        ),
    )


def commit_logs(
    compounds: Optional[List[CompoundLog]] = None,
    biometrics: Optional[List[BiometricLog]] = None,
    labs: Optional[List[LabResult]] = None,
    journals: Optional[List[DailyJournal]] = None,
) -> Dict[str, Any]:
    compounds = compounds or []
    biometrics = biometrics or []
    labs = labs or []
    journals = journals or []

    conn = get_db_conn()
    cursor = conn.cursor()
    try:
        for compound in compounds:
            insert_compound(cursor, compound)
        for biometric in biometrics:
            insert_biometric(cursor, biometric)
        for lab in labs:
            insert_lab_result(cursor, lab)
        for journal in journals:
            insert_daily_journal(cursor, journal)
        conn.commit()
    except sqlite3.Error as exc:
        conn.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Database write transaction aborted: {exc}",
        ) from exc
    finally:
        conn.close()

    return {
        "compound_logs": len(compounds),
        "biometric_logs": len(biometrics),
        "lab_results": len(labs),
        "daily_journals": len(journals),
    }


@app.get("/api/v1/health", status_code=status.HTTP_200_OK)
async def health_check() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/chat/ingest", status_code=status.HTTP_200_OK)
async def ingest_chat(payload: ChatMessage) -> Dict[str, Any]:
    result = await run_in_threadpool(extract_and_route, payload.text)
    return {"status": "success", "ledger_response": result}


@app.post("/api/v1/log/raw", status_code=status.HTTP_201_CREATED)
async def log_raw_entry(payload: AIExtractionPayload) -> Dict[str, Any]:
    append_to_wal(payload.raw_input_text)
    committed = commit_logs(
        compounds=payload.compounds,
        biometrics=payload.biometrics,
        labs=payload.labs,
        journals=payload.journals,
    )
    semantic_memory = add_semantic_memory(payload.raw_input_text)
    return {
        "status": "success",
        "committed": committed,
        "log_type": payload.log_type,
        "semantic_memory": semantic_memory["status"],
    }


@app.post("/api/v1/log/compound", status_code=status.HTTP_201_CREATED)
async def log_compound(payload: CompoundLog) -> Dict[str, Any]:
    raw_text = model_as_wal_text(payload)
    append_to_wal(raw_text, source="compound")
    committed = commit_logs(compounds=[payload])
    semantic_memory = add_semantic_memory(raw_text)
    return {"status": "success", "committed": committed, "semantic_memory": semantic_memory["status"]}


@app.post("/api/v1/log/biometric", status_code=status.HTTP_201_CREATED)
async def log_biometric(payload: BiometricLog) -> Dict[str, Any]:
    raw_text = model_as_wal_text(payload)
    append_to_wal(raw_text, source="biometric")
    committed = commit_logs(biometrics=[payload])
    semantic_memory = add_semantic_memory(raw_text)
    return {"status": "success", "committed": committed, "semantic_memory": semantic_memory["status"]}


@app.post("/api/v1/log/lab_result", status_code=status.HTTP_201_CREATED)
async def log_lab_result(payload: LabResult) -> Dict[str, Any]:
    raw_text = model_as_wal_text(payload)
    append_to_wal(raw_text, source="lab_result")
    committed = commit_logs(labs=[payload])
    semantic_memory = add_semantic_memory(raw_text)
    return {"status": "success", "committed": committed, "semantic_memory": semantic_memory["status"]}


@app.post("/api/v1/log/journal", status_code=status.HTTP_201_CREATED)
async def log_journal(payload: DailyJournal) -> Dict[str, Any]:
    raw_text = model_as_wal_text(payload)
    append_to_wal(raw_text, source="daily_journal")
    committed = commit_logs(journals=[payload])
    semantic_memory = add_semantic_memory(raw_text)
    return {"status": "success", "committed": committed, "semantic_memory": semantic_memory["status"]}


@app.get("/api/v1/history/compounds", status_code=status.HTTP_200_OK)
async def get_compound_history(limit: int = Query(default=50, ge=1, le=500)) -> List[Dict[str, Any]]:
    return get_history("compound", limit)


@app.get("/api/v1/get/history", status_code=status.HTTP_200_OK)
async def get_history_endpoint(
    entry_type: Literal["compound", "biometric", "lab_result", "daily_journal"] = "compound",
    limit: int = Query(default=50, ge=1, le=500),
) -> List[Dict[str, Any]]:
    return get_history(entry_type, limit)


@app.get("/api/v1/memory/search", status_code=status.HTTP_200_OK)
async def search_semantic_memory(
    query: str = Query(min_length=1),
    top_k: int = Query(default=5, ge=1, le=20),
) -> Dict[str, str]:
    return {"context": retrieve_context(query=query, top_k=top_k)}


def get_history(entry_type: str, limit: int) -> List[Dict[str, Any]]:
    table_by_type = {
        "compound": ("compound_logs", "recorded_at"),
        "biometric": ("biometric_logs", "recorded_at"),
        "lab_result": ("lab_results", "collected_at"),
        "daily_journal": ("daily_journals", "journal_date"),
    }
    table_name, order_column = table_by_type[entry_type]
    conn = get_db_conn()
    cursor = conn.cursor()
    try:
        cursor.execute(
            f"SELECT * FROM {table_name} ORDER BY {order_column} DESC LIMIT ?",
            (limit,),
        )
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8787"))
    uvicorn.run("api:app", host="127.0.0.1", port=port, reload=True)
