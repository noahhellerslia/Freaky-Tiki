# Building your card game in Python and hosting it for friends

Checked 2026-11-12. Two different questions are hiding in "host it on a website",
and they have opposite answers. **Decided 2026-11-12: everyone plays on their own
device, so Route B (§4) is the build.** Route A (§3) is kept only as a reference
for a possible single-player version later.

## 1. The decision that matters

| Your game | Right architecture | Hosting | Cost |
|---|---|---|---|
| Single-player, vs. the computer, or friends sharing one screen / taking turns on one device | **Pygame + pygbag** (your Python compiled to WebAssembly, runs entirely in each visitor's browser) | Any *static* host: itch.io, GitHub Pages, Netlify | Free, no server to run |
| Friends on **different devices**, each seeing only their own hand, playing live together | **Python server + thin web client.** Server: FastAPI + WebSockets running your rules. Client: a small HTML/JS page that draws the card PNGs and sends moves | A host that runs a long-lived Python process: Render, Fly.io, Railway | Free tier exists on Render (spins down when idle); small paid tiers remove that |

**The mistake to avoid:** pygbag builds cannot do multiplayer networking. The browser
sandbox gives them no sockets, no threads — a pygbag game is a single-player game
that happens to run in a browser. If you need live multiplayer, the Python moves to
the server (where it runs normally, not in a browser) and the browser becomes just
a screen. Your rules code is the same either way if you keep it separate — see §2.

A turn-based card game does not need anything fancier than WebSockets for this:
one connection per player, server pushes the new state after every move.

## 2. Project structure (already set up for you in this folder)

```
card-game/
  assets/
    cards/            56 individual PNGs, 64x88: 52 cards, card_back, blank_front, 2 jokers
    spritesheet.png   all 56 in one image (832x440) - load this in the game
    atlas.json        name -> {x, y, w, h} for every card in the sheet
    preview.png       the whole deck at 3x, for eyeballing
  game/
    game_logic.py     PURE Python rules: Card, full_deck(), GameState. No pygame imports.
    main.py           Pygame demo that loads the sheet and deals cards (pygbag-ready)
  server/
    server.py         FastAPI + WebSocket server: rooms, lobby, host start, serves client + assets
  client/
    index.html        the page every player opens on their own device
    app.js            WebSocket client: join, lobby, your hand, opponents as card backs
    style.css         pixelated (unsmoothed) card rendering, integer scaling
  tools/
    make_cards.py     regenerates all the art deterministically: python3 tools/make_cards.py
```

Rules to keep:

1. **Rules in `game_logic.py`, drawing in `main.py`, never mixed.** That's what lets
   the same rules run in the browser (single-player) *and* on the server (multiplayer).
2. **The server is authoritative.** Clients send *moves* (`{"type":"play","card":"A_of_spades"}`),
   never new state. The server validates the move, applies it, and replies with state.
3. **Never send a player another player's hand.** `GameState.public_view_for(player)`
   returns that player's cards face-up and everyone else's as a *count*. If full state
   reaches the browser, anyone can read it in dev-tools — secrecy has to happen server-side.
4. **Scale pixel art by integers only, no smoothing** (2x, 3x, 4x). In Pygame use
   `pygame.transform.scale` (non-smoothing); never `smoothscale`. In HTML/CSS use
   `image-rendering: pixelated`.

## 3. Route A — single-player / shared screen, via pygbag

```bash
cd game
python3 -m venv .venv && source .venv/bin/activate
pip install pygame-ce pygbag
python main.py                 # test locally first
python -m pygbag main.py       # test the browser build at http://localhost:8000
python -m pygbag --build main.py   # produces build/web/
```

pygbag requirements (these are the ones that produce a black screen when missed):
main must be `async def main():`, the loop must `await asyncio.sleep(0)` every frame,
`asyncio.run(main())` must be the final statement, no `threading`/`time.sleep()`/
sockets, and audio must be `.ogg`. `game/main.py` already follows all of them.

Host the output:
- **itch.io (easiest for games):** zip the *contents* of `build/web/`, create a project,
  kind = "HTML", upload the zip, tick "This file will be played in the browser".
- **GitHub Pages / Netlify:** publish the `build/web/` folder as a static site.

Send friends the URL. Nothing runs on a server; updates = rebuild + re-upload.

## 4. Route B — live multiplayer (YOUR route: everyone on their own device)

**This route is now built and tested** — `server/server.py` + the browser client in
`client/` (plain HTML/JS, no framework). One process serves the page, the card art,
and the WebSocket, so there is exactly one thing to deploy.

```bash
cd server
pip install fastapi "uvicorn[standard]"
uvicorn server:app --host 0.0.0.0 --port 8000
# every player then opens http://<this machine>:8000 on their own device
```

How it works:

- Each player types their name and the same room code. First person in is the host;
  the host gets the Start button once at least 2 players are in (player limits are the
  `MIN_PLAYERS` / `MAX_PLAYERS` constants in `server.py` — they'll be set by your rules).
- Player's browser opens `ws://your-host/ws` (the client switches to `wss://`
  automatically on an `https://` page) and sends
  `{"type":"join","room":"ABCD","name":"Noah"}` — the room code is how friends find each other.
- Moves: `{"type":"move","move":{"type":"play","card":"A_of_spades"}}` — clicking a card
  in your hand sends exactly this.
- After each accepted move the server sends each player their own `{"type":"state","view":...}`.
  Illegal moves get `{"type":"error","error":"not your turn"}` and change nothing.
- The client draws cards from the individual PNGs (`/assets/cards/A_of_spades.png`),
  shows your hand face-up, and opponents only as card backs with a count.
- Duplicate names in a room, joining a room that already started, and non-hosts trying
  to start are all rejected with an error. If the host disconnects, the next player
  becomes host.

Hosting it:
- **Render:** create a Web Service from your repo, start command
  `uvicorn server:app --host 0.0.0.0 --port $PORT`. Free services spin down after
  ~15 min idle, so the first friend to arrive waits ~a minute for it to wake.
- **Fly.io / Railway:** same start command in a container/Procfile; small paid
  instances stay awake.
- **Run exactly one instance / one worker.** Rooms are stored in that process's
  memory (`rooms = {}` in `server.py`). Two instances = players in the same room
  code landing on different computers-with-amnesia. One instance is plenty for
  friends; if you ever outgrow it, the fix is Redis, not more workers.
- In production the page is `https://`, so the socket must be `wss://` (not `ws://`)
  or the browser will block it.

## 5. Checklist before you send friends the link

- [ ] Played a full game locally with your actual rules (not just the demo deal)
- [ ] Opened the hosted URL in a private/incognito window (catches "works only when logged in as me")
- [ ] Two browsers / two devices joined the same room code and neither could see the other's hand
- [ ] Tried an illegal move — server rejected it and the game didn't change
- [ ] Refreshed mid-game and know what happens (with the skeleton: you rejoin, but a started
      game's seats are not restored — decide if you care before adding persistence)

## Sources / inspiration for the art

Design inspiration only — every pixel in `assets/` was generated by `tools/make_cards.py`,
so the art is yours to use with no attribution required:

- Kenney, *Playing Cards Pack* (CC0) — kenney.nl/assets/playing-cards-pack — clean white
  faces, corner rank+suit layout, small-card proportions
- Caz, *Pixel Fantasy Playing Cards* (CC-BY 4.0) — cazwolf.itch.io/pixel-fantasy-cards —
  chunky, high-contrast pips at small sizes
- OpenGameArt playing-card collections (CC0 / CC-BY packs) — opengameart.org

If you later swap in art from those packs directly, check each pack's licence:
Kenney's is CC0 (no attribution needed); Caz's is CC-BY 4.0 (credit required).
