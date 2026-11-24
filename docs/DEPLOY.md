# Deploying Freaky Tiki (and how players join)

One thing gets deployed: the FastAPI server in `server/`. It serves the game
page, the card art, and the WebSocket — there is no separate frontend hosting.

## Option 1 — Render (recommended, easiest)

1. Put this `card-game/` folder in a GitHub repo (the folder itself should be
   the repo root, so `render.yaml`, `requirements.txt`, `server/` are at the top):
   ```bash
   cd card-game
   git init && git add . && git commit -m "Freaky Tiki"
   git remote add origin https://github.com/<you>/freaky-tiki.git
   git push -u origin main
   ```
2. On render.com: **New → Blueprint**, pick the repo. `render.yaml` in the repo
   configures everything (build: `pip install -r requirements.txt`, start:
   `cd server && uvicorn server:app --host 0.0.0.0 --port $PORT`, health check
   `/health`, 1 instance). Manual equivalent if you prefer **New → Web Service**:
   runtime Python, same build/start commands.
3. Wait for the first deploy (a few minutes). You get a URL like
   `https://freaky-tiki.onrender.com`. Open it — you should see the join screen.
   `https://<your-url>/health` should return `{"ok":true,...}`.
4. Send friends the URL. Done — future updates are just `git push`.

**Cost notes:** Render's free web service spins down after ~15 minutes with no
visitors; the first person to open the link then waits ~a minute for it to wake
up (the game itself is unaffected once it's awake). A paid Starter instance
(~$7/mo) stays awake. **Never scale past 1 instance / 1 worker**: rooms live in
that one process's memory.

## Option 2 — Fly.io (stays awake cheaply, a bit more setup)

```bash
fly launch --dockerfile Dockerfile   # pick a name/region; say no to databases/extras
fly deploy
```
In `fly.toml`, set `min_machines_running = 1` and `auto_stop_machines = false`
(a stopped machine ends every game in progress). You get
`https://<app>.fly.dev`.

## Option 3 — No deploy: playtest from your own computer tonight

Easiest: use the playtest kit — `README_PLAYTEST.md` plus `scripts/start_windows.bat`
(Windows, double-click) or `scripts/run_tunnel.sh` (Mac/Linux). They install
everything, start the server, open a Cloudflare quick tunnel, and print the
public link to share. Manual equivalent:

```bash
cd server
pip install -r ../requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```
- Same Wi-Fi: friends open `http://<your computer's local IP>:8000`
  (e.g. `192.168.1.20:8000`).
- Different networks: run a tunnel, e.g. `cloudflared tunnel --url localhost:8000`
  or `ngrok http 8000`, and send friends the tunnel URL.
Your computer must stay on and the server running for the whole game.

## How players join a game (phone or computer — identical)

1. Open the URL in any modern browser. No install, no account.
2. Type a **name** and a **4-letter room code** everyone agreed on (e.g. `TIKI`),
   tap **Join room**.
3. First person in is the **host**. When 2–8 players are in, the host taps
   **Start game**. The previous game's winner starts the next game.
4. Dropped connection (phone lock, tunnel, dead zone)? Reopen the URL and join
   with the **same name and room code** — you'll be reconnected to your seat
   and your cards. A name that isn't in the game can't sneak in mid-game.

## Phone vs computer

Same page, same game, either device — players can mix freely in one room.
- **Phone:** everything needed is on-screen buttons: play (tap your card back),
  stack (tap any stacking card), shed, FREAKY TIKI!, and SLAP. Keep the tab in
  the foreground during fast moments — a backgrounded tab can drop the
  connection (reconnect above covers it).
- **Computer:** same buttons, plus slapping can be done by mashing the
  **spacebar** (2 presses; 5 for whoever placed a stacking-hand Joker).
