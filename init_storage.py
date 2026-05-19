from __future__ import annotations

import os
import sqlite3
from pathlib import Path


DATABASE_PATH = Path(os.getenv("DATABASE_PATH", "data/osassistant.sqlite3"))
WAL_PATH = Path(os.getenv("WAL_PATH", "data/wal.jsonl"))


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
"""


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
