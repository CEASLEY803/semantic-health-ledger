"""Morning Reflection Engine — LEDGER's overnight reasoning step.

run_morning_synthesis() is called once per calendar day (from the FastAPI lifespan
boot sequence). It reads the last 24h of telemetry + recent chats + the current
Knowledge Graph, feeds them to Gemini, and writes back structured graph updates.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from init_storage import DATABASE_PATH
from llm_service import CONVERSATION_MODEL, _get_conversation_client

logger = logging.getLogger(__name__)

# ── Synthesis system prompt ────────────────────────────────────────────────────

_SYNTHESIS_SYSTEM_PROMPT = """
You are LEDGER, an autonomous clinical co-pilot performing your morning analysis.

Your job: review yesterday's data, re-examine your existing theories, and output ONLY
a JSON array of graph update commands. No prose. No markdown. Just the array.

Supported commands:

{"command": "CREATE_NODE", "concept_name": "string", "category": "string", "summary_text": "string", "confidence_level": "hypothesis|testing|confirmed", "expires_at": "ISO date string (optional, for temporal nodes only)"}

{"command": "UPDATE_NODE", "concept_name": "string (must match existing)", "summary_text": "string (optional)", "confidence_level": "hypothesis|testing|confirmed (optional)", "last_surfaced_date": "ISO date string (optional)", "is_archived": 0 or 1 (optional)}

{"command": "CREATE_EDGE", "source_concept": "string (must match existing node)", "target_concept": "string (must match existing node)", "relationship_type": "CAUSES|MITIGATES|EXACERBATES|CORRELATES_WITH|REQUIRES|PRECEDES", "evidence_summary": "string"}

Rules:
- CREATE_NODE uses concept_name as the unique key. If a node with that name already exists,
  it will be upserted (updated in place).
- CREATE_EDGE will be silently skipped if source_concept or target_concept does not exist.
  Always CREATE_NODE first, then CREATE_EDGE.
- confidence_level MUST be one of: hypothesis, testing, confirmed — no other values.
- Output an empty array [] if nothing warrants an update.

[TEMPORAL TRACKING & PHARMACOKINETICS]

When the user mentions stopping, dropping, or discontinuing a compound with a meaningful
half-life, you MUST create a Temporal Tracking Node using CREATE_NODE with:
  - concept_name: "[TRACKING] <Compound Name> Clearance"
  - category: "pharmacokinetics"
  - confidence_level: "confirmed"
  - expires_at: the ISO date of estimated full clearance (5 half-lives from discontinuation)
  - summary_text: a structured entry containing:
      * Date discontinued
      * Half-life of the compound (in days)
      * Estimated date of 50% clearance
      * Estimated date of 90% clearance (≈ 3.32 half-lives)
      * Estimated date of full clearance (≈ 5 half-lives)
      * Downstream effects to monitor at each milestone (e.g., gastric motility, absorption)

ANTI-SPAM PROTOCOL — strictly enforced:
During morning reflection, review all active Temporal Nodes (is_archived = 0).
Calculate today's clearance percentage using: clearance = 1 - (0.5 ^ (days_elapsed / half_life))
You may ONLY include a Temporal Node insight in today's briefing if today is within ±1 day
of a named clinical milestone: 50% clearance, 90% clearance, or full clearance (5 half-lives).
If no milestone is reached today, do NOT mention the node. Output no command for it.
If you DO surface a milestone, you MUST immediately follow with an UPDATE_NODE command
setting last_surfaced_date to today's ISO date. This prevents the same milestone from
appearing again tomorrow.

GRAPH PRUNING:
Once a Temporal Node's expires_at date has passed (full clearance reached), issue an
UPDATE_NODE command setting is_archived to 1. The node will be excluded from future
reflection passes. Do not delete it — it remains as a historical record.

STALE HYPOTHESIS PRUNING:
For every node where confidence_level = 'hypothesis' and last_updated is more than 45 days
ago (visible in the NODES list): if there is no recent evidence to promote or refute it,
issue UPDATE_NODE setting is_archived to 1. A hypothesis that has not been updated in 45+
days is stale speculation, not active intelligence. Archive it to keep the graph clean.
Do not archive nodes with confidence_level 'testing' or 'confirmed' under this rule.
""".strip()


def _fmt_biometrics(rows: List[Dict]) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows:
        ts = str(r.get("recorded_at", ""))[:16]
        lines.append(f"  {ts} | {r.get('metric_name')} = {r.get('value')} {r.get('unit', '')}")
    return "\n".join(lines)


def _fmt_compounds(rows: List[Dict]) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows:
        ts = str(r.get("recorded_at", ""))[:16]
        lines.append(
            f"  {ts} | {r.get('compound_name')} {r.get('dose_value')} {r.get('dose_unit')} "
            f"via {r.get('route')}"
        )
    return "\n".join(lines)


def _fmt_labs(rows: List[Dict]) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows:
        ts = str(r.get("collected_at", ""))[:10]
        flagged = " [FLAGGED]" if r.get("flagged") else ""
        lines.append(
            f"  {ts} | {r.get('marker_name')} = {r.get('value_numeric')} {r.get('unit', '')}{flagged}"
        )
    return "\n".join(lines)


def _fmt_journals(rows: List[Dict]) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows:
        ts = str(r.get("journal_date", ""))[:10]
        mood = r.get("mood") or "—"
        energy = r.get("energy_score") or "—"
        sleep = r.get("sleep_hours") or "—"
        notes = (r.get("notes") or "")[:200]
        lines.append(f"  {ts} | mood={mood} energy={energy}/10 sleep={sleep}h | {notes}")
    return "\n".join(lines)


def _fmt_chats(rows: List[Dict]) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows:
        role = "User" if r.get("role") == "user" else "LEDGER"
        content = (r.get("content") or "")[:300]
        lines.append(f"  {role}: {content}")
    return "\n".join(lines)


def _fmt_nodes(rows: List[Dict]) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows:
        if r.get("is_archived"):
            continue  # exclude archived nodes from the prompt entirely
        conf = (r.get("confidence_level") or "hypothesis").upper()
        temporal = ""
        if r.get("expires_at"):
            temporal = f" | expires={r['expires_at']}"
            if r.get("last_surfaced_date"):
                temporal += f" last_surfaced={r['last_surfaced_date']}"
        lines.append(
            f"  [{conf}] {r.get('concept_name')} ({r.get('category')}): "
            f"{r.get('summary_text')}{temporal}"
        )
    return "\n".join(lines) if lines else "  (none)"


def _fmt_edges(rows: List[Dict]) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows:
        ev = r.get("evidence_summary") or ""
        lines.append(
            f"  {r.get('source_name')} --[{r.get('relationship_type')}]--> "
            f"{r.get('target_name')}: {ev}"
        )
    return "\n".join(lines)


def _build_synthesis_prompt(
    biometrics: List[Dict],
    compounds: List[Dict],
    labs: List[Dict],
    journals: List[Dict],
    chats: List[Dict],
    nodes: List[Dict],
    edges: List[Dict],
) -> str:
    today = datetime.now(timezone.utc).date().isoformat()
    return f"""Today is {today}.

## Yesterday's Telemetry (last 24h)

BIOMETRICS:
{_fmt_biometrics(biometrics)}

COMPOUNDS:
{_fmt_compounds(compounds)}

LABS:
{_fmt_labs(labs)}

JOURNALS:
{_fmt_journals(journals)}

## Recent Conversations (last 24h)
{_fmt_chats(chats)}

## Current Knowledge Graph

NODES:
{_fmt_nodes(nodes)}

EDGES:
{_fmt_edges(edges)}

---
Review the above. Update your theories where the evidence supports it.
Output ONLY a valid JSON array of commands as specified in your system prompt.
If nothing warrants an update, output: []"""


# ── Main synthesis function ────────────────────────────────────────────────────

def run_morning_synthesis() -> Dict[str, Any]:
    """Read yesterday's data + current graph, call Gemini, write graph updates.

    Synchronous by design — all I/O (SQLite, Gemini SDK) is blocking. Called via
    run_in_threadpool() from the async lifespan so the event loop stays unblocked.

    Returns a summary dict: {"nodes_created": N, "nodes_updated": N, "edges_created": N}
    """
    db_path = str(DATABASE_PATH)
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()

    # ── 1. Gather data ─────────────────────────────────────────────────────────
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row

        biometrics = [dict(r) for r in conn.execute(
            "SELECT metric_name, value, unit, recorded_at FROM biometric_logs "
            "WHERE recorded_at >= ? ORDER BY recorded_at DESC",
            (since,),
        ).fetchall()]

        compounds = [dict(r) for r in conn.execute(
            "SELECT compound_name, dose_value, dose_unit, route, recorded_at "
            "FROM compound_logs WHERE recorded_at >= ? ORDER BY recorded_at DESC",
            (since,),
        ).fetchall()]

        labs = [dict(r) for r in conn.execute(
            "SELECT marker_name, value_numeric, unit, flagged, collected_at "
            "FROM lab_results WHERE collected_at >= ? ORDER BY collected_at DESC",
            (since,),
        ).fetchall()]

        journals = [dict(r) for r in conn.execute(
            "SELECT mood, energy_score, sleep_hours, notes, journal_date "
            "FROM daily_journals WHERE journal_date >= ? ORDER BY journal_date DESC",
            (since,),
        ).fetchall()]

        chats = [dict(r) for r in conn.execute(
            "SELECT role, content FROM chat_history "
            "WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC",
            (since,),
        ).fetchall()]

        nodes = [dict(r) for r in conn.execute(
            "SELECT id, concept_name, category, summary_text, confidence_level, "
            "expires_at, last_surfaced_date, is_archived "
            "FROM clinical_nodes ORDER BY last_updated DESC",
        ).fetchall()]

        edges = [dict(r) for r in conn.execute(
            """SELECT e.id, e.relationship_type, e.evidence_summary,
                      src.concept_name AS source_name, tgt.concept_name AS target_name
               FROM clinical_edges e
               JOIN clinical_nodes src ON src.id = e.source_node_id
               JOIN clinical_nodes tgt ON tgt.id = e.target_node_id""",
        ).fetchall()]

    # ── 2. Build prompt and call Gemini ────────────────────────────────────────
    prompt = _build_synthesis_prompt(biometrics, compounds, labs, journals, chats, nodes, edges)

    try:
        client = _get_conversation_client()
        from google.genai import types  # noqa: PLC0415

        response = client.models.generate_content(
            model=CONVERSATION_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=_SYNTHESIS_SYSTEM_PROMPT,
                temperature=0,
            ),
        )
        raw = (response.text or "").strip()
    except Exception as exc:
        logger.error(f"[synthesis] Gemini call failed: {exc}")
        return {"error": str(exc), "nodes_created": 0, "nodes_updated": 0, "edges_created": 0}

    # ── 3. Strip markdown fences (LLM may wrap output despite instructions) ────
    raw = re.sub(r"^```(?:json)?\s*\n?", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\n?```\s*$", "", raw, flags=re.MULTILINE)
    raw = raw.strip()

    # ── 4. Parse JSON ──────────────────────────────────────────────────────────
    try:
        commands = json.loads(raw)
        if not isinstance(commands, list):
            commands = [commands]
    except json.JSONDecodeError as exc:
        logger.error(f"[synthesis] JSON parse error: {exc}\nRaw output (first 500 chars): {raw[:500]}")
        return {"error": str(exc), "nodes_created": 0, "nodes_updated": 0, "edges_created": 0}

    if not commands:
        logger.info("[synthesis] Gemini returned empty command list — no updates")
        return {"nodes_created": 0, "nodes_updated": 0, "edges_created": 0}

    # ── 5. Execute commands in two passes (nodes first, then edges) ────────────
    # Edges require UUIDs from nodes — processing nodes first ensures all new
    # nodes exist before we try to resolve their IDs for edge creation.
    nodes_created = nodes_updated = edges_created = 0

    node_commands = [c for c in commands if c.get("command") in ("CREATE_NODE", "UPDATE_NODE")]
    edge_commands = [c for c in commands if c.get("command") == "CREATE_EDGE"]

    with sqlite3.connect(db_path) as conn:
        # Pass 1: nodes
        for cmd in node_commands:
            command = cmd.get("command", "")
            try:
                if command == "CREATE_NODE":
                    conn.execute(
                        """INSERT INTO clinical_nodes
                               (concept_name, category, summary_text, confidence_level,
                                expires_at, last_updated)
                           VALUES (?, ?, ?, ?, ?, datetime('now'))
                           ON CONFLICT(concept_name) DO UPDATE SET
                               category          = excluded.category,
                               summary_text      = excluded.summary_text,
                               confidence_level  = excluded.confidence_level,
                               expires_at        = excluded.expires_at,
                               last_updated      = excluded.last_updated""",
                        (
                            cmd["concept_name"],
                            cmd["category"],
                            cmd["summary_text"],
                            cmd["confidence_level"],
                            cmd.get("expires_at"),  # optional, None if not a temporal node
                        ),
                    )
                    nodes_created += 1
                elif command == "UPDATE_NODE":
                    # Dynamic SET clause — only update keys present in the command
                    UPDATABLE = {
                        "summary_text":       "summary_text",
                        "confidence_level":   "confidence_level",
                        "last_surfaced_date": "last_surfaced_date",
                        "is_archived":        "is_archived",
                    }
                    set_parts = []
                    params = []
                    for key, col in UPDATABLE.items():
                        if key in cmd:
                            set_parts.append(f"{col} = ?")
                            params.append(cmd[key])

                    if not set_parts:
                        logger.warning(
                            f"[synthesis] UPDATE_NODE for '{cmd.get('concept_name')}' "
                            "had no updatable fields — skipped"
                        )
                    else:
                        set_parts.append("last_updated = datetime('now')")
                        params.append(cmd["concept_name"])
                        conn.execute(
                            f"UPDATE clinical_nodes SET {', '.join(set_parts)} "
                            "WHERE concept_name = ?",
                            params,
                        )
                        nodes_updated += 1
            except Exception as exc:
                logger.error(f"[synthesis] node command error ({command}): {exc} — {cmd}")

        # Pass 2: edges — explicit UUID resolution prevents FK crashes
        for cmd in edge_commands:
            try:
                src_row = conn.execute(
                    "SELECT id FROM clinical_nodes WHERE concept_name = ?",
                    (cmd.get("source_concept", ""),),
                ).fetchone()
                tgt_row = conn.execute(
                    "SELECT id FROM clinical_nodes WHERE concept_name = ?",
                    (cmd.get("target_concept", ""),),
                ).fetchone()

                if src_row is None or tgt_row is None:
                    logger.warning(
                        f"[synthesis] CREATE_EDGE skipped — unknown node(s): "
                        f"'{cmd.get('source_concept')}' / '{cmd.get('target_concept')}'"
                    )
                    continue

                conn.execute(
                    """INSERT OR IGNORE INTO clinical_edges
                           (source_node_id, target_node_id, relationship_type, evidence_summary)
                       VALUES (?, ?, ?, ?)""",
                    (
                        src_row[0],
                        tgt_row[0],
                        cmd.get("relationship_type", "CORRELATES_WITH"),
                        cmd.get("evidence_summary"),
                    ),
                )
                edges_created += 1
            except Exception as exc:
                logger.error(f"[synthesis] edge command error: {exc} — {cmd}")

    result = {
        "nodes_created": nodes_created,
        "nodes_updated": nodes_updated,
        "edges_created": edges_created,
    }
    logger.info(f"[synthesis] complete: {result}")
    return result
