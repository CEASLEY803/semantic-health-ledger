#!/usr/bin/env bash
set -euo pipefail

# ── Semantic Health Ledger — one-time setup ───────────────────────────────────
# Run once after cloning: bash setup.sh
# Works on Linux, macOS, and WSL2 (Ubuntu recommended).

PYTHON=${PYTHON:-python3}

echo ""
echo "=== Semantic Health Ledger Setup ==="
echo ""

# ── 1. Check Python ───────────────────────────────────────────────────────────
if ! command -v "$PYTHON" &>/dev/null; then
  echo "ERROR: python3 not found. Install Python 3.9+ and re-run."
  exit 1
fi

PY_VERSION=$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Python $PY_VERSION found."

# ── 2. Create and activate virtual environment ────────────────────────────────
if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  "$PYTHON" -m venv .venv
fi

# Activate for the rest of this script
# shellcheck disable=SC1091
source .venv/bin/activate
echo "Virtual environment active."

# ── 3. Install Python dependencies ───────────────────────────────────────────
echo "Installing Python dependencies..."
pip install --quiet --upgrade pip
pip install --quiet -e .
echo "Python dependencies installed."

# ── 4. Create .env from example ──────────────────────────────────────────────
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo "  .env created from .env.example."
  echo "  >>> Open .env and set GEMINI_API_KEY= before starting the server. <<<"
  echo ""
else
  echo ".env already exists — skipping."
fi

# ── 5. Initialise SQLite database and WAL ────────────────────────────────────
echo "Initialising database..."
python init_storage.py
echo "Database ready."

# ── 6. Install frontend dependencies ─────────────────────────────────────────
if command -v node &>/dev/null && command -v npm &>/dev/null; then
  echo "Installing frontend dependencies..."
  npm --prefix frontend install --silent
  echo "Frontend dependencies installed."
else
  echo "WARNING: Node.js / npm not found — skipping frontend install."
  echo "         Install Node.js 18+ then run: npm --prefix frontend install"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup complete ==="
echo ""
echo "To start the backend:"
echo "  source .venv/bin/activate"
echo "  uvicorn api:app --host 127.0.0.1 --port 8787 --reload"
echo ""
echo "To start the frontend (new terminal):"
echo "  npm --prefix frontend run dev"
echo ""
echo "Then open http://localhost:3000 in your browser."
echo ""
