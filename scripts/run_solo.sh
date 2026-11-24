#!/usr/bin/env bash
# Freaky Tiki SOLO test: run the game server on THIS computer only - no
# tunnel, no link to share. Open the page, click "Solo test vs bots", play.
#   bash scripts/run_solo.sh        (Mac / Linux)
# Ctrl+C stops the server.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"

command -v python3 >/dev/null || { echo "Python 3 not found. Install it from https://www.python.org/downloads/ and run this again."; exit 1; }

[ -x .venv/bin/uvicorn ] || { echo "First-run setup..."; python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }

lsof -ti tcp:8000 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
sleep 1
echo ""
echo "=================================================="
echo "  Open in your browser:  http://127.0.0.1:8000"
echo "  Type your name, then click 'Solo test vs bots'."
echo "  Ctrl+C here stops the game."
echo "=================================================="
echo ""
cd server && exec "$ROOT/.venv/bin/uvicorn" server:app --host 0.0.0.0 --port 8000
