# Semantic Health Ledger — Developer Notes

## Project Overview

Tauri v2 desktop app (Windows). Next.js 15 frontend + FastAPI backend.

- **Backend**: `api.py` (FastAPI, port 8787), `llm_service.py`, `memory_layer.py`
- **Frontend**: `frontend/src/` — Next.js 15, Turbopack, Tailwind
- **DB**: SQLite at `ledger.db` (WAL mode)
- **Models**: `gemini-2.5-flash` for extraction (temp 0, forced JSON), `gemini-2.5-pro` for conversation (temp 0.7)

## Running the App

```bash
cd frontend && npx tauri dev
```

Backend is spawned automatically by Tauri. In dev, Turbopack serves the frontend.

## Developer CLI (for me to use directly)

**Always use the venv python:**
```
.venv\Scripts\python.exe ledger_cli.py <command>
```

| Command | What it does |
|---|---|
| `extract "text"` | Runs Flash extraction only — no DB write, no conversation. Fast. |
| `chat "text"` | Full pipeline: history → extract → commit → mem0 → chat_respond → save |
| `chat "text" --no-save` | Full pipeline but don't write to chat_history (use for testing) |
| `db biometrics` | Query `biometric_logs` table, newest first |
| `db compounds` | Query `compound_logs` table |
| `db labs` | Query `lab_results` table |
| `db journals` | Query `daily_journals` table |
| `db chat` | Query `chat_history` table |
| `db <table> --limit N` | Limit rows returned (default 10) |
| `history` | Alias for `db chat --limit 20` |
| `delete biometric <uuid>` | Hard-delete a biometric_logs row |
| `delete compound <uuid>` | Hard-delete a compound_logs row |
| `delete lab <uuid>` | Hard-delete a lab_results row |
| `delete journal <uuid>` | Hard-delete a daily_journals row |
| `delete chat <uuid>` | Hard-delete a chat_history row |
| `mem0 "query"` | Test Mem0 retrieval in-process — **will segfault on Windows**, expected |

**Notes:**
- `chat` runs mem0 via subprocess to avoid the Qdrant segfault
- `mem0` subcommand runs in-process intentionally — segfault is documented/expected
- Use `--no-save` during extraction/pipeline testing to keep chat_history clean

## Known Issues

### Mem0 / Qdrant segfault (Windows)
`fastembed`'s BM25 native extension segfaults in-process on Windows. The API server
isolates Mem0 in a `ProcessPoolExecutor` subprocess. The CLI uses `subprocess.run()`.
The pool auto-recovers (`_mem0_pool = None` reset on `BrokenProcess*` exception), but
semantic memory context is always empty until this is fixed.

**Long-term fix**: upgrade `qdrant-client` / `mem0ai`, or switch Mem0 to a different
vector store backend (e.g., Chroma, FAISS).

### Garmin token saving
- Tokens saved to `data/garmin_tokens/garmin_tokens.json` (format: `{di_token, di_refresh_token, di_client_id}`)
- `garmin_auth.py` passes `tokenstore=str(TOKEN_DIR)` to `Garmin.login()` — library auto-saves on success
- On subsequent runs, tokens are loaded from disk; SSO is only hit if tokens are missing or expired
- **Rate limiting**: Garmin IP-blocks after repeated failed logins (~24–48 hrs, all 5 strategies hit same block)
  - Fix: authenticate once from a different IP (iPhone Personal Hotspot or VPN)
  - Once tokens are saved, re-auth is rarely needed (DI refresh tokens last ~1 year)

### Garmin metrics collected per day (`_fetch_garmin_metrics` in `api.py`)
All stored as `biometric_logs` with `context = 'garmin_sync'`:

| metric_name | unit | source |
|---|---|---|
| `sleep_duration` | hours | `dailySleepDTO.sleepTimeSeconds` |
| `sleep_deep` | hours | `dailySleepDTO.deepSleepSeconds` |
| `sleep_light` | hours | `dailySleepDTO.lightSleepSeconds` |
| `sleep_rem` | hours | `dailySleepDTO.remSleepSeconds` |
| `sleep_awake` | hours | `dailySleepDTO.awakeSleepSeconds` |
| `sleep_spo2_avg` | % | `dailySleepDTO.averageSpO2Value` |
| `sleep_spo2_low` | % | `dailySleepDTO.lowestSpO2Value` |
| `sleep_respiration` | breaths/min | `dailySleepDTO.averageRespirationValue` |
| `sleep_stress` | score | `dailySleepDTO.avgSleepStress` |
| `hrv_last_night` | ms | `get_hrv_data → hrvSummary.lastNight` |
| `hrv_weekly_avg` | ms | `get_hrv_data → hrvSummary.weeklyAvg` |
| `resting_heart_rate` | bpm | `get_stats → restingHeartRate` |
| `body_battery` | % | `get_body_battery → end-of-day value` |

Idempotent: each metric is skipped if `(metric_name, date)` already exists with `context='garmin_sync'`.
Fields are optional — devices without HRV or SpO2 sensors will simply omit those rows.

**Sync trigger flow:**
1. `GarminSyncButton` auto-fires on app mount (2 s delay) — silent mode, no toast if nothing new
2. Regular click → gap-fill: queries `_garmin_missing_dates(30)` and only syncs absent dates
3. **Shift+click** → force mode: re-syncs all 30 days; per-metric dedup adds new metrics to old dates
   without creating duplicate rows. Use this after adding new metrics (e.g. HRV) to backfill history.

**API params:** `POST /api/v1/sync/garmin?force=true&days=30`
- `force` (bool, default false) — skip date-level gap check, re-touch all dates
- `days`  (int,  default 30)   — lookback window; capped at 365

## Architecture Notes

### Timeout layers (conversation model)
1. SDK HTTP timeout: `90_000 ms` (90s) — `HttpOptions(timeout=90_000)`
2. SDK retries disabled: `HttpRetryOptions(attempts=1)` (no exponential backoff)
3. asyncio ceiling: `asyncio.wait_for(..., timeout=65.0)` in `ingest_chat`

### `HttpOptions.timeout` is in MILLISECONDS
The google-genai SDK divides by 1000 internally (`timeout_in_seconds = timeout / 1000.0`).
`timeout=30.0` = 30ms. Always pass `timeout=30_000` for 30 seconds.

### Chat history / working memory
- Stored in `chat_history` SQLite table (`id`, `role`, `content`, `created_at`)
- `role` is `'user'` or `'model'` (Gemini convention, not `'assistant'`)
- `_to_gemini_history()` in `llm_service.py` enforces strict user/model alternation
  before passing to `chats.create(history=...)` — Gemini 400s on malformed history
- Frontend loads history on startup via `GET /api/v1/chat/history` (triggered by
  `online` state from `useTelemetry`, not component mount)

### LEDGER tool calling (function calling)
`chat_respond` passes three Gemini function declarations and runs a tool loop (max 5 rounds):
- **`query_entries(entry_type, metric_name?, limit?)`** — SELECT from any table with optional
  partial-match name filter. Returns `{entries: [...], count: N}`.
- **`update_entry(entry_type, entry_id, field_name, new_value)`** — UPDATE a single field by UUID.
  Dates must be ISO 8601. Returns `{success, updated_id, field, new_value}`.
- **`delete_entry(entry_type, entry_id)`** — hard DELETE by UUID. Returns `{success, deleted_id}`.

LEDGER always calls `query_entries` first to find the UUID, then `update_entry` or `delete_entry`.
Tool execution runs in `_execute_ledger_tool()` in `llm_service.py` via direct sqlite3 calls.

Dashboard auto-refreshes after every chat ingest via `refreshKey` in `page.tsx` —
updates and deletions via chat are reflected immediately without any extra plumbing.

`entry_type` values: `biometric`, `compound`, `lab`, `journal` (NOT `labs`/`journals`).

Updatable fields per type (see `_UPDATABLE_FIELDS` in both `llm_service.py` and `api.py`):
- lab: `collected_at`, `panel_name`, `marker_name`, `value_numeric`, `unit`, `reference_low`,
  `reference_high`, `notes`, `flagged`
- biometric: `recorded_at`, `metric_name`, `value`, `unit`, `notes`
- compound: `recorded_at`, `compound_name`, `dose_value`, `dose_unit`, `route`, `site`, `notes`
- journal: `journal_date`, `mood`, `energy_score`, `sleep_hours`, `notes`

### Entry deletion / update (UI)
- `DELETE /api/v1/entry/{entry_type}/{entry_id}` — hard delete, no soft delete
- `PATCH  /api/v1/entry/{entry_type}/{entry_id}` — update single field `{field_name, new_value}`
- UI: hover-reveal `×` button on every row/card across all four dashboard panels

### Module-level cached Gemini clients
`_extractor_client` and `_conversation_client` in `llm_service.py` are lazy-init
module-level singletons. Avoids TLS handshake overhead on every request.

## SQLite Tables

| Table | Key columns |
|---|---|
| `biometric_logs` | `id`, `metric_name`, `value`, `unit`, `recorded_at` |
| `compound_logs` | `id`, `compound_name`, `dose_value`, `dose_unit`, `route`, `site`, `recorded_at` |
| `lab_results` | `id`, `marker_name`, `panel_name`, `value_numeric`, `unit`, `reference_low`, `reference_high`, `collected_at` |
| `daily_journals` | `id`, `mood`, `energy_score`, `sleep_hours`, `notes`, `journal_date` |
| `chat_history` | `id`, `role`, `content`, `created_at` |
