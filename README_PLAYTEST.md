# Freaky Tiki — playtest tonight, no deployment needed

This runs the game on **your** computer and gives you a public link to share.
(One-time setup takes a few minutes; after that it's a single click/command.)

## Just want to test it alone first?
Run `bash scripts/run_solo.sh` (Mac/Linux), open http://127.0.0.1:8000,
type your name and click **Solo test vs bots**. You play against 1–7 bots
(pick the count on the page) running the full rules — stacking, Freaky Tiki,
Joker slaps and all. No tunnel, nothing leaves your computer.

## You need
- Python 3 installed — https://www.python.org/downloads/
  (Windows: tick **"Add python.exe to PATH"** during install.)
- Your computer on, awake, and online for the whole session.

## Start it
- **Windows:** double-click `scripts\start_windows.bat`
- **Mac / Linux:** in a terminal in this folder: `bash scripts/run_tunnel.sh`

First run downloads the dependencies and Cloudflare's tunnel tool, then prints
something like:

```
FREAKY TIKI IS LIVE:  https://brave-river-1234.trycloudflare.com
```

## Play
1. Send that link to your friends (text/Discord/whatever).
2. Everyone opens it, types their name and the **same room code** (make one up,
   e.g. `TIKI`), and taps Join.
3. The first person in is the host — they tap **Start game** once 2–8 players
   are in. Phones and computers can mix in the same room.
4. Dropped out mid-game? Reopen the link and rejoin with the same name + code —
   you get your seat back.

## Stop it
Close the windows / press Ctrl+C in the terminal. The link dies with them —
it's a fresh random link every time you start, which is also why this is a
playtest setup, not the permanent home (that's the Render deploy in
`docs/DEPLOY.md`).

## If the tunnel link never appears
- Same Wi-Fi fallback: friends can skip the tunnel and open
  `http://<your computer's local IP>:8000` instead (the server window shows it
  running on port 8000).
- Corporate/school networks sometimes block tunnel tools; try home Wi-Fi,
  or just do the Render deploy — it's free and takes ~10 minutes.
