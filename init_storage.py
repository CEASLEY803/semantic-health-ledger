from __future__ import annotations

import os
import sqlite3
from pathlib import Path


_BASE = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", str(_BASE / "data" / "osassistant.sqlite3")))
WAL_PATH = Path(os.getenv("WAL_PATH", str(_BASE / "data" / "wal.jsonl")))


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS compound_logs (
    id TEXT PRIMARY KEY,
    recorded_at TEXT NOT NULL,
    compound_name TEXT NOT NULL,
    dose_value TEXT NOT NULL,
    dose_unit TEXT NOT NULL,
    route TEXT NOT NULL,
    site TEXT,
    protocol_phase TEXT,
    notes TEXT,
    raw_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS biometric_logs (
    id TEXT PRIMARY KEY,
    recorded_at TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    value TEXT NOT NULL,
    unit TEXT NOT NULL,
    context TEXT,
    notes TEXT,
    raw_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lab_results (
    id TEXT PRIMARY KEY,
    collected_at TEXT NOT NULL,
    resulted_at TEXT,
    panel_name TEXT,
    marker_name TEXT NOT NULL,
    value_type TEXT NOT NULL,
    value_numeric TEXT,
    value_text TEXT,
    unit TEXT,
    reference_low TEXT,
    reference_high TEXT,
    lab_name TEXT,
    flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
    notes TEXT,
    raw_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_journals (
    id TEXT PRIMARY KEY,
    journal_date TEXT NOT NULL,
    mood TEXT,
    energy_score INTEGER CHECK (energy_score BETWEEN 1 AND 10),
    sleep_hours TEXT,
    symptoms TEXT NOT NULL DEFAULT '[]',
    training TEXT,
    nutrition TEXT,
    notes TEXT NOT NULL,
    raw_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_history (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    content TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT 'legacy',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clinical_nodes (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    concept_name     TEXT NOT NULL UNIQUE,
    category         TEXT NOT NULL,
    summary_text     TEXT NOT NULL,
    confidence_level TEXT NOT NULL CHECK (confidence_level IN ('hypothesis', 'testing', 'confirmed')),
    last_updated     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clinical_edges (
    id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source_node_id    TEXT NOT NULL REFERENCES clinical_nodes(id) ON DELETE CASCADE,
    target_node_id    TEXT NOT NULL REFERENCES clinical_nodes(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    evidence_summary  TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source_node_id, target_node_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS user_protocols (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    protocol_name    TEXT NOT NULL UNIQUE,
    protocol_content TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_regimen (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    compound_name TEXT NOT NULL,
    dose_value    TEXT NOT NULL,
    dose_unit     TEXT NOT NULL,
    route         TEXT NOT NULL DEFAULT 'oral',
    site          TEXT,
    frequency     TEXT NOT NULL DEFAULT 'daily',
    time_of_day   TEXT NOT NULL DEFAULT 'morning',
    days_of_week  TEXT,
    notes         TEXT,
    added_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (compound_name, time_of_day)
);
"""


def migrate_chat_session_id(database_path: Path = DATABASE_PATH) -> None:
    """Add session_id column to chat_history for existing databases. Idempotent."""
    with sqlite3.connect(database_path) as conn:
        try:
            conn.execute(
                "ALTER TABLE chat_history ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy'"
            )
            conn.commit()
        except sqlite3.OperationalError:
            pass  # column already exists


def migrate_clinical_nodes_temporal(database_path: Path = DATABASE_PATH) -> None:
    """Add temporal tracking columns to clinical_nodes. Idempotent."""
    with sqlite3.connect(database_path) as conn:
        for ddl in [
            "ALTER TABLE clinical_nodes ADD COLUMN expires_at TEXT",
            "ALTER TABLE clinical_nodes ADD COLUMN last_surfaced_date TEXT",
            "ALTER TABLE clinical_nodes ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
        ]:
            try:
                conn.execute(ddl)
                conn.commit()
            except sqlite3.OperationalError:
                pass  # column already exists


def initialize_storage(database_path: Path = DATABASE_PATH, wal_path: Path = WAL_PATH) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    wal_path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(database_path) as connection:
        connection.executescript(SCHEMA)

    wal_path.touch(exist_ok=True)


if __name__ == "__main__":
    initialize_storage()
    print(f"Initialized SQLite database at {DATABASE_PATH}")
    print(f"Initialized raw event WAL at {WAL_PATH}")
