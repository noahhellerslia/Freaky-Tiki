#!/usr/bin/env bash
# Freaky Tiki playtest: start the game server on THIS computer and open a
# Cloudflare quick tunnel so friends anywhere can join. Run:
#   bash scripts/run_tunnel.sh        (Mac / Linux)
# The public URL is random and changes every run. Keep this terminal open
# while you play; Ctrl+C / closing it ends the game for everyone.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
mkdir -p logs tools

command -v python3 >/dev/null || { echo "Python 3 not found. Install it from https://www.python.org/downloads/ and run this again."; exit 1; }

# one-time setup: virtualenv + dependencies + cloudflared for this machine
[ -x .venv/bin/uvicorn ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
if [ ! -x tools/cloudflared ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)  F=cloudflared-linux-amd64 ;;
    Linux-aarch64) F=cloudflared-linux-arm64 ;;
    Darwin-arm64)  F=cloudflared-darwin-arm64.tgz ;;
    Darwin-x86_64) F=cloudflared-darwin-amd64.tgz ;;
    *) echo "Couldn't pick a cloudflared build for $(uname -s)-$(uname -m); see docs/DEPLOY.md Option 3."; exit 1 ;;
  esac
  echo "Downloading cloudflared ($F)..."
  curl -sL -o "tools/$F" "https://github.com/cloudflare/cloudflared/releases/latest/download/$F"
  case "$F" in *.tgz) tar -xzf "tools/$F" -C tools cloudflared ;; *) mv "tools/$F" tools/cloudflared ;; esac
  chmod +x tools/cloudflared
fi

# stop any previous instances of ours (portable: works on macOS and Linux)
lsof -ti tcp:8000 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
pkill -f "cloudflared tunnel --url http://127.0.0.1:8000" 2>/dev/null
sleep 1

# game server (nohup + background: no setsid on macOS, and none is needed)
(cd server && nohup "$ROOT/.venv/bin/uvicorn" server:app --host 0.0.0.0 --port 8000 > "$ROOT/logs/server.log" 2>&1 &)
for i in $(seq 1 20); do curl -s -m 2 http://127.0.0.1:8000/health >/dev/null && break; sleep 0.5; done
curl -s -m 2 http://127.0.0.1:8000/health >/dev/null || { echo "SERVER FAILED TO START:"; tail -20 logs/server.log; exit 1; }
echo "Game server running on this computer (port 8000)."

# tunnel
nohup "$ROOT/tools/cloudflared" tunnel --url http://127.0.0.1:8000 --no-autoupdate > "$ROOT/logs/tunnel.log" 2>&1 &
URL=""
for i in $(seq 1 45); do
  URL=$(grep -oE "https://[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com" logs/tunnel.log | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "TUNNEL FAILED:"; tail -20 logs/tunnel.log; exit 1; }
echo "$URL" > logs/tunnel_url.txt
echo ""
echo "=================================================="
echo "  FREAKY TIKI IS LIVE:  $URL"
echo "  Send that link to your friends. Pick a room code"
echo "  (e.g. TIKI) and everyone joins with it."
echo "  Keep this window open while you play."
echo "=================================================="
