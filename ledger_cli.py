#!/usr/bin/env python3
"""
ledger_cli.py — Developer CLI for the Semantic Health Ledger.

Calls Python functions directly (no HTTP server required) so the full
pipeline can be tested and debugged without going through the UI.

Usage
-----
# Full pipeline: extraction + Mem0 context + conversational reply
python ledger_cli.py chat "500mg vitamin D and 400mg magnesium glycinate with breakfast"

# Extraction only — parses text, prints structured result, no DB write
python ledger_cli.py extract "58 bpm resting heart rate"

# Query SQLite tables directly
python ledger_cli.py db biometrics
python ledger_cli.py db compounds --limit 3
python ledger_cli.py db chat         # chat history rows

# Delete an entry by type + UUID
python ledger_cli.py delete biometric <uuid>
python ledger_cli.py delete chat <uuid>

# Test Mem0 semantic retrieval (runs in-process — may segfault on Windows)
python ledger_cli.py mem0 "vitamin D levels"
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

# ── UTF-8 output (Windows cp1252 can't handle box-drawing chars) ──────────────
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Bootstrap ─────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from init_storage import DATABASE_PATH, WAL_PATH, initialize_storage  # noqa: E402


# ── Formatting helpers ────────────────────────────────────────────────────────

def _hr(char: str = "─", width: int = 64) -> None:
    print(char * width)

def _section(label: str) -> None:
    pad = max(0, 55 - len(label))
    print(f"\n  ┌─ {label} {'─' * pad}")

def _ok(msg: str) -> None:
    print(f"  ✓  {msg}")

def _err(msg: str) -> None:
    print(f"  ✗  {msg}", file=sys.stderr)

def _pjson(obj: object) -> None:
    print(json.dumps(obj, indent=4, default=str))


# ── DB helpers (bypass api.py to avoid FastAPI import cost) ──────────────────

def _get_conn() -> sqlite3.Connection:
    initialize_storage(DATABASE_PATH, WAL_PATH)
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def _db_history(limit: int = 20) -> list[dict]:
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT role, content FROM chat_history ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]
    finally:
        conn.close()

def _db_insert_chat(role: str, content: str) -> None:
    import uuid
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT INTO chat_history (id, role, content) VALUES (?, ?, ?)",
            (str(uuid.uuid4()), role, content),
        )
        conn.commit()
    finally:
        conn.close()


# ── Mem0 subprocess helper ────────────────────────────────────────────────────
# Qdrant's fastembed native extension segfaults in-process on Windows.
# We isolate it in a child process exactly like the API server does.

_MEM0_HELPER = """\
import sys, os
sys.path.insert(0, {root!r})
os.chdir({root!r})
from dotenv import load_dotenv
load_dotenv({env!r})
from memory_layer import retrieve_context
result = retrieve_context(query={query!r}, top_k={top_k})
print(result or '', end='')
"""

def _retrieve_context_safe(query: str, top_k: int = 5) -> str:
    """Run retrieve_context in a subprocess to avoid Qdrant segfault on Windows."""
    script = _MEM0_HELPER.format(
        root=str(ROOT),
        env=str(ROOT / ".env"),
        query=query,
        top_k=top_k,
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
        return ""
    except Exception:
        return ""


# ── cmd: extract ──────────────────────────────────────────────────────────────

def cmd_extract(args: argparse.Namespace) -> None:
    """Parse text through Flash extraction — no DB write, no conversation."""
    from llm_service import extract

    text = " ".join(args.text)
    print(f"\nInput: {text!r}")
    _hr()

    t0 = time.time()
    try:
        result = extract(text)
    except Exception as exc:
        _err(f"Extraction failed: {exc}")
        sys.exit(1)

    elapsed = time.time() - t0
    _ok(f"Extracted in {elapsed:.2f}s  →  log_type = {result.log_type}")

    if result.compounds:
        _section("compounds")
        for c in result.compounds:
            print(f"    {c.compound_name}  {c.dose_value} {c.dose_unit}  via {c.route}"
                  + (f"  [{c.site}]" if c.site else "")
                  + (f"  // {c.notes}" if c.notes else ""))

    if result.biometrics:
        _section("biometrics")
        for b in result.biometrics:
            print(f"    {b.metric_name} = {b.value} {b.unit}"
                  + (f"  // {b.notes}" if b.notes else ""))

    if result.labs:
        _section("labs")
        for lab in result.labs:
            val = f"{lab.value_numeric} {lab.unit or ''}".strip() if lab.value_numeric else lab.value_text
            ref = (f"  [ref {lab.reference_low}–{lab.reference_high}]"
                   if lab.reference_low and lab.reference_high else "")
            print(f"    {lab.marker_name} = {val}{ref}")

    if result.journals:
        _section("journals")
        for j in result.journals:
            print(f"    mood={j.mood}  energy={j.energy_score}  sleep={j.sleep_hours}")
            print(f"    {j.notes[:120]}")

    if not any([result.compounds, result.biometrics, result.labs, result.journals]):
        print("\n  (no health data detected)")

    print()


# ── cmd: chat ─────────────────────────────────────────────────────────────────

def cmd_chat(args: argparse.Namespace) -> None:
    """Full pipeline: extract → Mem0 → conversation reply → save to history."""
    from llm_service import chat_respond, extract, CONVERSATION_MODEL

    # Avoid circular import — only pull the DB helpers we need
    from api import commit_logs, append_to_wal  # noqa: PLC0415

    text = " ".join(args.text)
    print(f"\nInput: {text!r}")
    _hr()

    t_total = time.time()

    # ── Chat history ──────────────────────────────────────────────────────────
    chat_history = _db_history(20)
    print(f"  history   {len(chat_history)} prior turns loaded")

    # ── Step A: extraction ────────────────────────────────────────────────────
    extracted = None
    committed = None
    t = time.time()
    try:
        extracted = extract(text)
        _ok(f"extract   {time.time()-t:.1f}s  log_type={extracted.log_type}")
        for c in extracted.compounds:
            print(f"           compound: {c.compound_name} {c.dose_value}{c.dose_unit} {c.route}")
        for b in extracted.biometrics:
            print(f"           biometric: {b.metric_name}={b.value}{b.unit}")
        for lab in extracted.labs:
            print(f"           lab: {lab.marker_name}={lab.value_numeric}{lab.unit or ''}")
        for j in extracted.journals:
            print(f"           journal: mood={j.mood}")
    except Exception as exc:
        _err(f"extract   {exc} (non-fatal, continuing)")

    # ── Commit if data ────────────────────────────────────────────────────────
    if extracted and any([extracted.compounds, extracted.biometrics,
                          extracted.labs, extracted.journals]):
        try:
            append_to_wal(text)
            committed = commit_logs(
                compounds=extracted.compounds,
                biometrics=extracted.biometrics,
                labs=extracted.labs,
                journals=extracted.journals,
            )
            _ok(f"commit    {committed}")
        except Exception as exc:
            _err(f"commit    {exc}")

    # ── Step B: Mem0 context (subprocess-isolated to avoid Qdrant segfault) ─────
    mem0_context = ""
    t = time.time()
    mem0_context = _retrieve_context_safe(text, top_k=5)
    snippet = mem0_context[:80].replace("\n", " ") + ("…" if len(mem0_context) > 80 else "")
    _ok(f"mem0      {time.time()-t:.1f}s  {len(mem0_context)} chars  {snippet!r}")

    # ── Step C: conversational reply ──────────────────────────────────────────
    print(f"  respond   calling {CONVERSATION_MODEL}…")
    t = time.time()
    try:
        reply = chat_respond(text, extracted, mem0_context, chat_history)
        _ok(f"respond   {time.time()-t:.1f}s")
    except Exception as exc:
        reply = f"[error: {exc}]"
        _err(f"respond   {exc}")

    # ── Output ────────────────────────────────────────────────────────────────
    _hr()
    print(f"\nLEDGER:\n{reply}\n")
    _hr()
    total = time.time() - t_total
    print(f"  total {total:.1f}s  |  committed: {committed}\n")

    # ── Persist to chat history ───────────────────────────────────────────────
    if not args.no_save:
        try:
            _db_insert_chat("user", text)
            _db_insert_chat("model", reply)
            print("  history   saved")
        except Exception as exc:
            _err(f"history save: {exc}")


# ── cmd: db ───────────────────────────────────────────────────────────────────

_TABLE_MAP = {
    "biometrics": ("biometric_logs",   "recorded_at"),
    "compounds":  ("compound_logs",    "recorded_at"),
    "labs":       ("lab_results",      "collected_at"),
    "journals":   ("daily_journals",   "journal_date"),
    "chat":       ("chat_history",     "created_at"),
}

_TRIM_COLS = {"raw_text", "notes", "content"}

def cmd_db(args: argparse.Namespace) -> None:
    """Query a SQLite table and pretty-print rows."""
    table_key = getattr(args, "table", "chat")
    if table_key not in _TABLE_MAP:
        _err(f"Unknown table '{table_key}'. Choose: {', '.join(_TABLE_MAP)}")
        sys.exit(1)

    table, order_col = _TABLE_MAP[table_key]
    limit = getattr(args, "limit", 10)

    conn = _get_conn()
    try:
        rows = conn.execute(
            f"SELECT * FROM {table} ORDER BY {order_col} DESC LIMIT ?", (limit,)  # noqa: S608
        ).fetchall()
    finally:
        conn.close()

    if not rows:
        print(f"\n  (no rows in {table})\n")
        return

    print(f"\n{len(rows)} rows from \033[1m{table}\033[0m (newest first):\n")
    _hr()
    for row in rows:
        d = dict(row)
        for k in _TRIM_COLS:
            if k in d and d[k] and len(str(d[k])) > 100:
                d[k] = str(d[k])[:100] + "…"
        _pjson(d)
        print()


# ── cmd: history ──────────────────────────────────────────────────────────────

def cmd_history(args: argparse.Namespace) -> None:
    """Show persisted chat history rows."""
    args.table = "chat"
    args.limit = getattr(args, "limit", 20)
    cmd_db(args)


# ── cmd: delete ───────────────────────────────────────────────────────────────

def cmd_delete(args: argparse.Namespace) -> None:
    """Hard-delete a row by entry type and UUID."""
    type_to_table = {
        "biometric": "biometric_logs",
        "compound":  "compound_logs",
        "lab":       "lab_results",
        "journal":   "daily_journals",
        "chat":      "chat_history",
    }
    if args.entry_type not in type_to_table:
        _err(f"Unknown type. Choose: {', '.join(type_to_table)}")
        sys.exit(1)

    table = type_to_table[args.entry_type]
    conn = _get_conn()
    try:
        cursor = conn.execute(f"DELETE FROM {table} WHERE id = ?", (args.id,))  # noqa: S608
        conn.commit()
    finally:
        conn.close()

    if cursor.rowcount == 0:
        _err(f"No row found  id={args.id!r}  table={table}")
        sys.exit(1)
    _ok(f"Deleted {args.entry_type}  {args.id}  from {table}")


# ── cmd: mem0 ────────────────────────────────────────────────────────────────

def cmd_mem0(args: argparse.Namespace) -> None:
    """Run a Mem0 semantic retrieval query in-process.

    Warning: Qdrant's native extension may segfault on Windows on first call.
    This is expected — it's why the server isolates Mem0 in a subprocess.
    """
    from memory_layer import retrieve_context

    query = " ".join(args.query)
    print(f"\nQuery: {query!r}")
    _hr()
    t0 = time.time()
    try:
        result = retrieve_context(query=query, top_k=5)
        elapsed = time.time() - t0
        _ok(f"Retrieved in {elapsed:.2f}s\n")
        print(result or "  (empty — no matching memories)")
    except Exception as exc:
        _err(f"{type(exc).__name__}: {exc}")
        print("\n  Note: Qdrant segfaults in-process on Windows. This is expected.\n"
              "  The server uses ProcessPoolExecutor to isolate this crash.")
    print()


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="ledger",
        description="Semantic Health Ledger — developer CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # chat
    p = sub.add_parser("chat", help="Full pipeline: extract + Mem0 + conversation + save")
    p.add_argument("text", nargs="+", help="Message to process")
    p.add_argument("--no-save", action="store_true",
                   help="Skip saving this turn to chat_history")
    p.set_defaults(func=cmd_chat)

    # extract
    p = sub.add_parser("extract", help="Extraction only — no DB write, no conversation")
    p.add_argument("text", nargs="+")
    p.set_defaults(func=cmd_extract)

    # db
    p = sub.add_parser("db", help="Query a SQLite table")
    p.add_argument("table", choices=list(_TABLE_MAP), metavar="TABLE",
                   help=f"{{{', '.join(_TABLE_MAP)}}}")
    p.add_argument("--limit", type=int, default=10, metavar="N")
    p.set_defaults(func=cmd_db)

    # history
    p = sub.add_parser("history", help="Show chat history (alias: db chat)")
    p.add_argument("--limit", type=int, default=20, metavar="N")
    p.set_defaults(func=cmd_history)

    # delete
    p = sub.add_parser("delete", help="Hard-delete an entry")
    p.add_argument("entry_type",
                   choices=["biometric", "compound", "lab", "journal", "chat"],
                   metavar="TYPE")
    p.add_argument("id", metavar="UUID")
    p.set_defaults(func=cmd_delete)

    # mem0
    p = sub.add_parser("mem0", help="Test Mem0 semantic retrieval in-process")
    p.add_argument("query", nargs="+")
    p.set_defaults(func=cmd_mem0)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
