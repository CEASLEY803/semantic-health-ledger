# Semantic Health Ledger

A local-first health ledger with an AI-powered natural language ingest pipeline. Log supplements, biometrics, lab results, and daily journal entries by typing plain text. Gemini extracts and routes structured data into a local SQLite database, with semantic memory stored in a local Qdrant vector store via Mem0 — no cloud data storage.

**Stack:** FastAPI · Pydantic v2 · SQLite · Gemini 2.5 Flash · Mem0/Qdrant (backend) — Next.js 15 · Recharts · Tailwind v4 (frontend)

---

## Architecture

```
Browser (localhost:3000)
  └─ Next.js Frontend
       ├─ Chat Panel  →  POST /api/v1/chat/ingest
       └─ Dashboard   ←  GET  /api/v1/get/history?entry_type=...

Next.js rewrites /api/v1/* → localhost:8787 (no CORS config needed)

FastAPI (localhost:8787)
  ├─ llm_service.py   →  Gemini 2.5 Flash (structured JSON extraction, temp=0)
  ├─ memory_layer.py  →  Mem0 + local Qdrant (semantic recall)
  └─ init_storage.py  →  SQLite WAL + 4-table schema
```

All data stays on your machine. Nothing is sent to external servers except the Gemini API call for text extraction.

---

## Prerequisites

| Tool            | Version                 | Notes                                                                           |
| --------------- | ----------------------- | ------------------------------------------------------------------------------- |
| Python          | 3.9+ (3.11 recommended) |                                                                                 |
| Node.js         | 18+                     |                                                                                 |
| Gemini API key  | —                       | Free tier works — get one at [aistudio.google.com](https://aistudio.google.com) |
| WSL2            | —                       | **Windows only** — see Windows setup below                                      |

---

## Quick Start (Linux / macOS / WSL2)

```bash
git clone https://github.com/CEASLEY803/semantic-health-ledger.git
cd semantic-health-ledger
bash setup.sh
```

The script creates a Python virtual environment, installs all dependencies, copies `.env.example` → `.env`, and initialises the SQLite database. It will print:

```text
>>> Open .env and set GEMINI_API_KEY= before starting the server. <<<
```

**Add your key to `.env`**, then start both servers:

```bash
# Terminal 1 — backend
source .venv/bin/activate
uvicorn api:app --host 127.0.0.1 --port 8787 --reload

# Terminal 2 — frontend
npm --prefix frontend run dev
```

Open **[http://localhost:3000](http://localhost:3000)**.

---

## Windows Setup (WSL2)

Both servers run inside WSL2. The browser runs on the Windows host and reaches them at `localhost:3000` / `localhost:8787` automatically via WSL2's loopback bridge.

### 1. Install WSL2 with Ubuntu

Open PowerShell as Administrator:

```powershell
wsl --install
# Restart when prompted, then open Ubuntu from the Start menu
```

### 2. Install Python and Node inside WSL2

```bash
sudo apt update && sudo apt install -y python3 python3-pip python3-venv
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 3. Clone and run setup

```bash
git clone https://github.com/CEASLEY803/semantic-health-ledger.git
cd semantic-health-ledger
bash setup.sh
```

Add your Gemini API key to `.env`, then start both servers in two Ubuntu terminals as shown in Quick Start above. Open your **Windows** browser at `http://localhost:3000`.

---

## Configuration

All config lives in `.env` (created by `setup.sh` from `.env.example`). The only required value is `GEMINI_API_KEY`. Everything else has sensible defaults.

```env
# Required
GEMINI_API_KEY=your_key_here

# Optional — defaults shown
GEMINI_MODEL=gemini-2.5-flash
DATABASE_PATH=data/osassistant.sqlite3
WAL_PATH=data/wal.jsonl
MEM0_USER_ID=primary_user
MEM0_QDRANT_PATH=data/memory/qdrant
MEM0_STATE_DIR=data/memory/mem0_state
MEM0_COLLECTION_NAME=health_ledger_semantic
MEM0_EMBEDDING_MODEL=models/gemini-embedding-001
MEM0_EMBEDDING_DIMS=768
```

---

## End-to-End Test: The Omni-Prompt

This single message exercises every schema simultaneously — compound, biometric, lab result, and daily journal — in one ingest call.

### Step 1 — Send the omni-prompt

In the chat panel, paste:

```
Felt extremely lethargic today, sleep was terrible, maybe 4 hours. Mood is very low.
Weight is 212 lbs. Took 500mg of Vitamin D3 (oral). Also got my labs back: HDL is 31,
ApoB is 110, Hematocrit is 51%.
```

> **Note for personal use:** substitute your actual log text. The extraction system maps slang — "pinned" → `intramuscular`, compound names, lab marker abbreviations — exactly as you type them.

Hit **Send** or press **Enter**.

### Step 2 — Watch the Uvicorn terminal

Within 2–4 seconds you should see Gemini's extraction printed to the FastAPI terminal:

```json
--- Successful Extraction & Database Commit ---
{
  "raw_input_text": "...",
  "log_type": ["compound", "biometric", "lab_result", "daily_journal"],
  "compounds": [ { "compound_name": "Vitamin D3", "dose_value": 500, "dose_unit": "mg", "route": "oral", ... } ],
  "biometrics": [ { "metric_name": "body_weight", "value": 212, "unit": "lb" }, { "metric_name": "sleep", "value": 4, "unit": "hours" } ],
  "labs": [
    { "marker_name": "HDL", "value_numeric": 31, ... },
    { "marker_name": "ApoB", "value_numeric": 110, ... },
    { "marker_name": "Hematocrit", "value_numeric": 51, "unit": "%" ... }
  ],
  "journals": [ { "mood": "very_low", "sleep_hours": 4, "energy_score": null, "symptoms": ["lethargy"], "notes": "..." } ]
}
```

Followed by a `200 OK` log line. If you see `422 Unprocessable Entity` the Pydantic schema rejected the extraction — check the `detail` field in the response.

### Step 3 — Confirm the UI auto-refreshed

Back in the browser, the dashboard should have already refetched all four panels without a manual reload. This is the `refreshKey` state in `page.tsx` incrementing on every successful chat response, which triggers `useDashboardData` to re-query all history endpoints.

### Step 4 — Audit the four panels

Click through each tab:

**Labs tab**
- HDL (31) and ApoB (110) appear at the top because the default sort is `status: asc` — flagged and out-of-range markers surface first.
- Both should have a red dot on the `RefRangeBar`, sitting outside (to the left of) the green reference band.
- If `reference_low` / `reference_high` were not in your text, the bar shows grey ("No Ref") — this is correct. You can log reference ranges explicitly: *"HDL reference range is 40–80"*.

**Compounds tab**
- A new timeline entry appears at the top under Today's date heading.
- The route badge reads the abbreviation matching your route (`PO` for oral, `IM` for intramuscular, `SubQ` for subcutaneous).
- The dose displays with a thin space between value and unit (`500 mg`).

**Biometrics tab**
- `body_weight` should have a new sparkline point at 212 lb.
- `sleep` should have a new sparkline point at 4 hours.
- If this is your first reading, the card shows "Single reading — log more data to see a trend."

**Journal tab**
- A new card appears at the top with the red "Very Low" mood bar (all five squares filled in red).
- Sleep shows `4h`.
- The notes field contains Gemini's structured extraction of your subjective entry.
- Any extracted symptoms ("lethargy", etc.) render as amber chips below the notes.

### Step 5 — Test semantic recall

Send a follow-up message in the chat panel:

```
Based on my recent logs, why might I be feeling so bad today?
```

The backend hits `retrieve_context()` in `memory_layer.py`, which queries the local Qdrant vector store via Mem0. The response returned to the chat bubble will include context pulled from the semantic embeddings of your previous log entry — correlating the subjective lethargy with the logged sleep duration, mood, and any other recent entries in the vector store.

> **First-run note:** Mem0 initializes the Qdrant collection on the first `add()` call. This may take 10–20 seconds on first run while the embedding model loads. Subsequent calls are fast.

---

## API Reference

All endpoints are documented interactively at `http://localhost:8787/docs` (FastAPI's auto-generated Swagger UI).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Liveness check |
| `POST` | `/api/v1/chat/ingest` | Natural language → Gemini extraction → SQLite + Mem0 |
| `POST` | `/api/v1/log/raw` | Direct structured `AIExtractionPayload` write |
| `POST` | `/api/v1/log/compound` | Write a single `CompoundLog` |
| `POST` | `/api/v1/log/biometric` | Write a single `BiometricLog` |
| `POST` | `/api/v1/log/lab_result` | Write a single `LabResult` |
| `POST` | `/api/v1/log/journal` | Write a single `DailyJournal` |
| `GET` | `/api/v1/get/history` | Paginated history for any entry type |
| `GET` | `/api/v1/history/compounds` | Shorthand for compound history |
| `GET` | `/api/v1/memory/search` | Semantic search against Qdrant |

---

## Data Storage

All state is local and excluded from version control via `.gitignore`:

```
data/
├── osassistant.sqlite3   # structured ledger (4 tables)
├── wal.jsonl             # append-only raw event log
└── memory/
    ├── qdrant/           # local Qdrant vector store (on-disk)
    └── mem0_state/       # Mem0 state directory
```

To reset all data:
```bash
rm -rf data/
python init_storage.py
```

---

## Troubleshooting

**`GEMINI_API_KEY is not set`**
The `.env` file is missing or not in the working directory you launched uvicorn from. Always run uvicorn from the project root, not from a subdirectory.

**`422 Unprocessable Entity` on ingest**
Gemini extracted a payload that failed Pydantic validation. Check the terminal for the full `ValidationError`. Common causes: a `lab_result` log_type declared but no lab objects populated, or a datetime without timezone info.

**Dashboard doesn't update after chat**
Open the browser console. If you see a network error on `/api/v1/get/history`, the FastAPI server is not running or the Next.js rewrite proxy can't reach `localhost:8787`. Confirm uvicorn is running and listening on port 8787, not 8000.

**Mem0/Qdrant first-run is slow**
Normal — Qdrant initializes an on-disk collection and the Gemini embedding model loads on first call. Subsequent calls are fast. If it times out, increase `timeout=15` in `memory_layer.py`'s `get_memory()` initialization.

**Recharts sparklines don't appear**
Recharts requires `'use client'` — already set in `BiometricsPanel.tsx`. If you see a hydration error, ensure `next.config.ts` has not accidentally enabled static export mode.

**WSL2: browser can't reach localhost:3000**
Next.js binds to `0.0.0.0` by default in dev mode, which is accessible from the Windows host at `localhost:3000`. If it doesn't connect, run `ip addr show eth0` inside WSL2 to find the WSL2 IP and use that instead.
