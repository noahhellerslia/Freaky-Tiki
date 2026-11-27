"""Multiplayer server: FastAPI + WebSockets. One deploy serves everything:
  GET  /            the browser client (client/index.html)
  GET  /assets/...  the pixel-art cards
  WS   /ws          rooms, lobby and game state
  GET  /health      {"ok": true, "rooms": N}

Run it (from this folder):
  pip install fastapi "uvicorn[standard]"
  uvicorn server:app --host 0.0.0.0 --port 8000
Then every player opens http://<this machine>:8000 on their own device,
types the same 4-letter room code, and plays from their own screen.

Protocol (JSON):
  -> {"type":"join","room":"ABCD","name":"Noah"}   first joiner is the host
  -> {"type":"start"}                              host only, needs >= MIN_PLAYERS
  -> {"type":"move","move":{...}}                  validated by game_logic.GameState
  <- {"type":"lobby","view":{...}}                 before the game starts
  <- {"type":"state","view":{...}}                 your OWN view only - see below
  <- {"type":"error","error":"..."}

Secrecy: after a move the server sends each player GameState.public_view_for(them):
their hand face-up, everyone else's hand as a count. Full state never leaves here.
Rooms live in this process's memory: run exactly ONE instance / ONE worker.
"""
import asyncio, os, random, sys, time
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "game"))
from game_logic import GameState, within_one  # noqa: E402

MIN_PLAYERS = 2      # will be set by Noah's rules
MAX_PLAYERS = 8      # will be set by Noah's rules
BOT_NAMES = ["Bot Mia", "Bot Leo", "Bot Zoe", "Bot Sam", "Bot Ivy", "Bot Max", "Bot Rue"]

# Stacking grabs (hold-to-stack, shared table state): while a player holds a
# stacking card, everyone sees it floating in that player's hand-sprite and
# nobody else may take it. A grab lives at most GRAB_TTL seconds.
GRAB_TTL = float(os.environ.get("FREAKY_GRAB_TTL", "5.0"))
DISCONNECT_DROP_SEC = float(os.environ.get("FREAKY_DROP_SEC", "30.0"))
STACK_PHASES = ("open", "stacked", "stacker_start", "freaky")

app = FastAPI()
rooms: dict[str, dict] = {}   # code -> {"state", "sockets" {name: ws}, "players" [names],
                              #          "host", "bots" {names}, driver bookkeeping}

app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")
app.mount("/client", StaticFiles(directory=ROOT / "client"), name="client")

@app.get("/")
def index():
    return FileResponse(ROOT / "client" / "index.html")

@app.get("/health")
def health():
    return {"ok": True, "rooms": len(rooms)}

@app.get("/api/room/{code}")
def room_exists(code: str):
    return {"exists": code.strip().upper() in rooms}


PRESET_ROOM_CODES = [
    "TIKI", "TKI2", "TKI3", "TKI4", "TKI5",
    "TKI6", "TKI7", "TKI8", "TKI9", "FRKY", "FRKI",
]


def _next_room_code(exclude: set[str] | None = None) -> str:
    blocked = set(rooms.keys()) | (exclude or set())
    available_presets = [code for code in PRESET_ROOM_CODES if code not in blocked]
    if available_presets and random.random() < 0.80:
        return random.choice(available_presets)
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    for _ in range(64):
        code = "".join(random.choice(chars) for _ in range(4))
        if code not in blocked:
            return code
    return "".join(random.choice(chars) for _ in range(4))


@app.get("/api/next_room_code")
def next_room_code(exclude: str = ""):
    ex = {c.strip().upper() for c in exclude.split(",") if c.strip()}
    return {"code": _next_room_code(ex)}


@app.get("/api/rooms")
def list_public_rooms():
    out = []
    for code, entry in rooms.items():
        if not entry.get("public") or entry.get("solo"):
            continue
        state = entry.get("state")
        out.append({
            "code": code,
            "host": entry.get("host"),
            "players": len(entry.get("players", [])),
            "max_players": MAX_PLAYERS,
            "started": state is not None and state.phase != "over",
        })
    return {"rooms": out}


def _assign_color(entry: dict, player: str, preferred: int | None = None) -> int:
    colors = entry.setdefault("colors", {})
    if player in colors:
        return colors[player]
    used = {colors[p] for p in entry.get("players", []) if p in colors and p != player}
    if isinstance(preferred, int) and 0 <= preferred < MAX_PLAYERS and preferred not in used:
        colors[player] = preferred
        return preferred
    for c in range(MAX_PLAYERS):
        if c not in used:
            colors[player] = c
            return c
    colors[player] = len(entry.get("players", [])) % MAX_PLAYERS
    return colors[player]

def _prune_grabs(entry: dict, now: float) -> bool:
    """Drop grabs that expired, point at a card that moved, belong to a
    finished player, or outlived the stacking phases. True if any dropped."""
    grabs = entry.get("grabs")
    if not grabs:
        return False
    state = entry["state"]
    if state is None or state.phase not in STACK_PHASES:
        grabs.clear()
        return True
    changed = False
    for g, gr in list(grabs.items()):
        if gr["slot"] == -1:
            # A lifted playing card (a blind card back held over the
            # lifter's own pile): no time limit - it stays until the
            # lifter plays it, puts it back, runs out of playing cards,
            # or leaves the table.
            if (not state.playing.get(g) or g in state.finished
                    or g not in entry.get("sockets", {})):
                del grabs[g]
                changed = True
            continue
        slots = state.stacking.get(gr["owner"], [])
        card = slots[gr["slot"]] if 0 <= gr["slot"] < len(slots) else None
        if (now - gr["t0"] > GRAB_TTL or card is None or card.name != gr["card"]
                or g in state.finished or gr["owner"] in state.finished):
            del grabs[g]
            changed = True
    return changed


def _record_game_stats(entry: dict, state: GameState) -> None:
    if entry.get("stats_recorded"):
        return
    entry["stats_recorded"] = True
    stats = entry.setdefault("stats", {})
    for p in state.players:
        stats.setdefault(p, {"losses": 0, "p1": 0, "p2": 0, "p3": 0})
    for p in state.losers:
        stats[p]["losses"] += 1
    n = len(state.players)
    ped_slots = 1 if n <= 4 else (2 if n <= 6 else 3)
    for idx, p in enumerate(state.finished[:ped_slots]):
        stats[p][f"p{idx + 1}"] += 1


def _view(room_code: str, entry: dict, name: str) -> dict:
    state = entry["state"]
    waiting_list = list(entry.get("waiting", {}).keys())
    player_colors = dict(entry.get("colors", {}))
    bots_in_room = [p for p in entry.get("players", []) if p in entry.get("bots", set())]
    bot_difficulty = entry.get("bot_difficulty", "easy")
    if name in entry.get("waiting", {}):
        return {
            "started": False,
            "waiting_room": True,
            "room": room_code,
            "you": name,
            "players": list(entry["players"]),
            "player_colors": player_colors,
            "bots": bots_in_room,
            "bot_difficulty": bot_difficulty,
            "max_players": MAX_PLAYERS,
            "waiting_players": waiting_list,
            "host": entry["host"],
            "you_are_host": False,
            "game_in_progress": state is not None and state.phase != "over",
            "game_over": state is not None and state.phase == "over",
            "double_tap_play": bool(entry.get("double_tap_play", False)),
            "public": bool(entry.get("public", False)),
            "chat": list(entry.get("chat", [])),
            "can_start": False,
        }
    if state is None or name not in state.players or name in state.dropped:
        return {
            "started": False,
            "waiting_room": False,
            "admitted_next_game": (state is not None and state.phase == "over" and name in entry["players"]),
            "room": room_code,
            "you": name,
            "players": list(entry["players"]),
            "player_colors": player_colors,
            "bots": bots_in_room,
            "bot_difficulty": bot_difficulty,
            "max_players": MAX_PLAYERS,
            "waiting_players": waiting_list,
            "host": entry["host"],
            "you_are_host": entry["host"] == name,
            "double_tap_play": bool(entry.get("double_tap_play", False)),
            "public": bool(entry.get("public", False)),
            "chat": list(entry.get("chat", [])),
            "can_start": entry["host"] == name and len(entry["players"]) >= MIN_PLAYERS,
        }
    now = time.monotonic()
    _prune_grabs(entry, now)
    view = state.public_view_for(name, now=now)
    disconnected = [p for p in state.players
                    if p not in state.dropped and p not in entry.get("bots", set()) and p not in entry.get("sockets", {})]
    view.update({"started": True, "room": room_code, "host": entry["host"],
                 "all_players": list(entry["players"]),
                 "player_colors": player_colors,
                 "bots": bots_in_room,
                 "you_are_host": entry["host"] == name,
                 "public": bool(entry.get("public", False)),
                 "fast_bots": bool(entry.get("fast_bots", False)),
                 "max_players": MAX_PLAYERS,
                 "waiting_players": waiting_list,
                 "double_tap_play": bool(entry.get("double_tap_play", False)),
                 "bot_difficulty": bot_difficulty,
                 "disconnected": disconnected,
                 "disconnect_deadlines": {p: max(0, int(DISCONNECT_DROP_SEC - (now - t0)))
                                          for p, t0 in entry.get("disconnect_times", {}).items()},
                 "player_stats": entry.get("stats", {}),
                 "chat": list(entry.get("chat", [])),
                 "grabs": {g: {"owner": gr["owner"], "slot": gr["slot"],
                               "card": gr["card"],
                               "age_ms": int((now - gr["t0"]) * 1000)}
                           for g, gr in entry.get("grabs", {}).items()},
                 "awaiting_deal": bool(entry.get("awaiting_deal", False)),
                 # While the slap winner carries the middle stack to its
                 # new owner, everyone sees whose hand it is in.
                 "giveaway_holder": entry.get("giveaway_holder") if (
                     state.phase == "joker_choose"
                     and entry.get("giveaway_holder") is not None
                     and state.slap_winner == entry.get("giveaway_holder")) else None})
    if entry.get("awaiting_deal"):
        view["phase"] = "deal"
        view["your_playing_count"] = 0
        view["playing_counts"] = {p: 0 for p in state.players}
        view["stacking_hands"] = {p: [None] * len(state.stacking[p]) for p in state.players}
        view["turn_player"] = None
    return view

def _prune_disconnected_players(entry: dict):
    """Drop disconnected human players from the room roster between games."""
    bots = entry.get("bots", set())
    sockets = entry.get("sockets", {})
    kept = []
    for p in entry.get("players", []):
        if p in bots or p in sockets:
            kept.append(p)
        else:
            entry.get("colors", {}).pop(p, None)
            entry.get("disconnect_times", {}).pop(p, None)
            if entry.get("last_winner") == p:
                entry["last_winner"] = None
    entry["players"] = kept

async def _drop_from_lobby_or_standings(room_code: str, entry: dict, player: str) -> None:
    """Instantly remove a disconnected player when in the lobby or Tiki Standings."""
    entry["sockets"].pop(player, None)
    entry.get("waiting", {}).pop(player, None)
    entry.get("grabs", {}).pop(player, None)
    if player in entry.get("players", []):
        entry["players"].remove(player)
    entry.get("colors", {}).pop(player, None)
    entry.get("pref_colors", {}).pop(player, None)
    entry.get("disconnect_times", {}).pop(player, None)
    if entry.get("last_winner") == player:
        entry["last_winner"] = None
    if entry.get("host") == player and entry["sockets"]:
        entry["host"] = next(iter(entry["sockets"]))


async def broadcast(room_code: str, _retry: bool = False):
    if room_code not in rooms:
        return
    entry = rooms[room_code]
    state = entry["state"]
    in_lobby_or_standings = (state is None or state.phase == "over")
    if state is not None and state.phase == "over":
        _record_game_stats(entry, state)
        if state.finished:
            entry["last_winner"] = state.finished[0]   # winner starts the next game (rules)
    if in_lobby_or_standings:
        _prune_disconnected_players(entry)
    dead_seated = []
    for name, ws in list(entry["sockets"].items()):
        v = _view(room_code, entry, name)
        k = "state" if v.get("started") else "lobby"
        try:
            await ws.send_json({"type": k, "view": v})
        except Exception:
            dead_seated.append(name)
    dead_waiting = []
    for wname, wws in list(entry.get("waiting", {}).items()):
        try:
            await wws.send_json({"type": "lobby", "view": _view(room_code, entry, wname)})
        except Exception:
            dead_waiting.append(wname)
    if (dead_seated or dead_waiting) and in_lobby_or_standings:
        for p in dead_seated + dead_waiting:
            await _drop_from_lobby_or_standings(room_code, entry, p)
        if not entry["sockets"] and not entry.get("waiting"):
            for key in ("ticker", "bot_task"):
                old = entry.get(key)
                if old is not None:
                    old.cancel()
            rooms.pop(room_code, None)
        elif not _retry:
            await broadcast(room_code, _retry=True)

async def room_ticker(room_code: str):
    """Time-driven rules (replacements at +0.25s, stacker-start at +2s,
    Freaky Tiki auto-resolve at +10s, disconnect drop at +30s) need a clock."""
    last_countdown_sec = None
    try:
        while room_code in rooms:
            entry = rooms[room_code]
            state = entry["state"]
            if state is None:
                return
            now = time.monotonic()
            changed = state.tick(now)
            if _prune_grabs(entry, now):
                changed = True
            disc_times = entry.get("disconnect_times", {})
            for p, t0 in list(disc_times.items()):
                if now - t0 >= DISCONNECT_DROP_SEC:
                    disc_times.pop(p, None)
                    if state.drop_player(p, now=now):
                        if p in entry["players"]:
                            entry["players"].remove(p)
                        changed = True
            # Keep countdown readouts ticking smoothly once per second
            dl = None
            if state.phase == "freaky" and state.freaky_deadline is not None:
                dl = state.freaky_deadline
            elif state.phase == "joker_choose" and state.joker_deadline is not None:
                dl = state.joker_deadline
            elif state.phase == "open" and state.standstill_deadline is not None:
                dl = state.standstill_deadline
            cur_sec = max(0, int((dl - now) + 0.999)) if dl is not None else None
            if cur_sec != last_countdown_sec:
                last_countdown_sec = cur_sec
                if cur_sec is not None:
                    changed = True
            if changed:
                await broadcast(room_code)
            if state.phase == "over":
                return
            await asyncio.sleep(0.05)
    except asyncio.CancelledError:
        pass

# ---------------------------------------------------------------------- bots
# Solo testing: bots are ordinary players as far as the engine is concerned.
# They read the full state (they "see" the same public table a human would,
# plus their own blind pile count - never its contents: playing is blind even
# for bots, they just flip their top card like everyone else).

BOT_PROFILES = {
    "easy": {
        "quiet_wait": 1.15,
        "other_stack_wait": 3.50,
        "open_delay": 1.35,
        "stack_prob": 0.55,
        "smart_target": False,
        "stack_joker": True,
        "shed_range": (0, 2),
        "delay": {
            "play": (1.45, 2.35),
            "stack": (1.7, 2.9),
            "stack_other": (3.2, 4.8),
            "shed": (1.05, 1.75),
            "slap_press": (1.05, 1.75),
            "freaky": (2.3, 3.8),
            "slap_choose": (1.3, 2.2),
        },
    },
    "hard": {
        "quiet_wait": 0.95,
        "other_stack_wait": 2.10,
        "open_delay": 0.85,
        "stack_prob": 0.96,
        "smart_target": True,
        "stack_joker": True,
        "shed_range": (2, 5),
        "delay": {
            "play": (1.05, 1.50),
            "stack": (0.85, 1.30),
            "stack_other": (2.0, 3.0),
            "shed": (0.45, 0.78),
            "slap_press": (0.45, 0.78),
            "freaky": (0.80, 1.10),
            "slap_choose": (0.80, 1.35),
        },
    },
}


def _bot_move(state: GameState, bot: str, shed_quota: dict, difficulty: str = "easy",
              allow_other_stack: bool = True) -> dict | None:
    prof = BOT_PROFILES.get(difficulty, BOT_PROFILES["easy"])
    ph = state.phase
    if ph == "freaky":
        if state.freaky_player == bot:
            return {"type": "freaky"}
        if shed_quota.get(bot, 0) > 0 and state.playing[bot]:
            shed_quota[bot] -= 1
            return {"type": "shed"}
        return None
    if ph == "joker":
        return {"type": "slap_press"}
    if ph == "joker_choose":
        if state.slap_winner == bot:
            valid = state._valid_joker_targets()
            targets = [p for p in valid if p != bot] or valid
            if prof["smart_target"]:
                target = min(targets, key=lambda p: state.total(p))
            else:
                target = random.choice(targets)
            return {"type": "slap_choose", "target": target}
        return None
    if ph == "stacker_start" and bot in state.stackers and state.playing[bot]:
        return {"type": "play"}
    if ph == "open" and state.turn is not None and state.players[state.turn] == bot \
            and state.playing[bot]:
        return {"type": "play"}
    # Stacking opportunity: any face-up card within one of the middle top.
    # Bots wait longer (other_stack_wait) before stacking another player's card.
    if state.middle and ph in ("open", "stacked", "stacker_start", "freaky"):
        top = state.middle[-1]
        options = [(owner, i) for owner, slots in state.stacking.items()
                   if state.is_active(owner) and (allow_other_stack or owner == bot)
                   for i, c in enumerate(slots)
                   if c is not None and not c.is_joker and within_one(c, top)]
        if options and random.random() < prof["stack_prob"]:
            if prof["smart_target"]:
                own_opts = [opt for opt in options if opt[0] == bot]
                owner, slot = random.choice(own_opts or options)
            else:
                owner, slot = random.choice(options)
            return {"type": "stack", "owner": owner, "slot": slot}
        # Bots are willing to drop a Joker from their own stacking hand so
        # games don't stall, or when they have no playing cards / stack is big.
        if prof["stack_joker"] and not top.is_joker:
            own_jokers = [i for i, c in enumerate(state.stacking.get(bot, []))
                          if c is not None and c.is_joker]
            no_playing_left = not any(state.playing[p] for p in state.active_players())
            if own_jokers and (no_playing_left or not state.playing[bot] or len(state.middle) >= 3 or state.total(bot) <= 3):
                return {"type": "stack", "owner": bot, "slot": own_jokers[0]}
    # Also allow playing a stacking-hand Joker on an empty table if nobody has playing cards
    if not state.middle and ph in ("open", "stacked", "stacker_start") and prof["stack_joker"]:
        own_jokers = [i for i, c in enumerate(state.stacking.get(bot, []))
                      if c is not None and c.is_joker]
        no_playing_left = not any(state.playing[p] for p in state.active_players())
        if own_jokers and (no_playing_left or not state.playing[bot]):
            return {"type": "stack", "owner": bot, "slot": own_jokers[0]}
    return None


def _fingerprint(state: GameState):
    """Everything about the state a bot could react to."""
    return (state.phase, len(state.middle),
            state.middle[-1].name if state.middle else None,
            state.turn,
            tuple(len(state.playing[p]) for p in state.players),
            tuple(tuple(c.name if c else None for c in slots)
                  for slots in state.stacking.values()),
            state.freaky_player, state.slap_winner,
            tuple(sorted(state.presses.items())),
            tuple(state.finished))


async def bot_driver(room_code: str):
    """Pace the bots like real players with per-difficulty reaction times
    and staggered personal clocks."""
    try:
        while room_code in rooms:
            entry = rooms[room_code]
            state = entry["state"]
            if state is None or state.phase == "over" or not entry["bots"]:
                return
            fast = bool(entry.get("fast_bots", False))
            difficulty = entry.get("bot_difficulty", "easy")
            prof = BOT_PROFILES.get(difficulty, BOT_PROFILES["easy"])
            now = time.monotonic()
            fp = _fingerprint(state)
            if fp != entry.get("fp"):
                old_phase = entry.get("last_phase")
                entry["fp"] = fp
                entry["fp_at"] = now
                entry["last_phase"] = state.phase
                entry["quiet_until"] = 0 if fast else max(entry.get("quiet_until", 0), now + prof["quiet_wait"])
                # When a race phase (joker slap or freaky) starts, stagger each
                # bot's personal reaction clock so they don't act in lockstep.
                if state.phase != old_phase and state.phase in ("joker", "freaky"):
                    for b in entry["bots"]:
                        if fast:
                            entry["bot_next"][b] = now + 0.02
                            continue
                        spd = entry.setdefault("bot_speed", {}).setdefault(b, random.uniform(0.85, 1.22))
                        if state.phase == "freaky" and state.freaky_player == b:
                            lo, hi = prof["delay"]["freaky"]
                            entry["bot_next"][b] = now + random.uniform(lo * 0.75, hi) * spd
                        else:
                            lo, hi = prof["delay"]["slap_press" if state.phase == "joker" else "shed"]
                            entry["bot_next"][b] = now + random.uniform(lo * 0.65, hi * 1.15) * spd
            # New Freaky Tiki? Deal each bot a difficulty-scaled number of cards to shed.
            fkey = (state.freaky_player, state.freaky_deadline) if state.phase == "freaky" else None
            if fkey != entry.get("freaky_key"):
                entry["freaky_key"] = fkey
                if fkey is not None:
                    s_lo, s_hi = prof["shed_range"]
                    entry["shed_quota"] = {b: random.randint(s_lo, s_hi) for b in entry["bots"]}
            allow_other_stack = fast or ((now - entry.get("fp_at", now)) >= prof["other_stack_wait"])
            acted = False
            for bot in list(entry["bots"]):
                spd = entry.setdefault("bot_speed", {}).setdefault(bot, random.uniform(0.85, 1.22))
                if bot not in entry["bot_next"]:
                    entry["bot_next"][bot] = now + (0.02 if fast else (prof["open_delay"] + random.uniform(0.0, 0.45) * spd))
                    continue
                if not state.is_active(bot):
                    continue
                in_race = state.phase in ("joker", "freaky")
                if (not fast and not in_race and now < entry.get("quiet_until", 0)) or now < entry["bot_next"].get(bot, 0):
                    continue
                mv = _bot_move(state, bot, entry.setdefault("shed_quota", {}),
                               difficulty, allow_other_stack=allow_other_stack)
                if mv is None:
                    entry["bot_next"][bot] = now + (0.03 if fast else random.uniform(0.2, 0.45))
                    continue
                try:
                    state.apply_move(bot, mv, now=now)
                except ValueError:
                    entry["bot_next"][bot] = now + (0.03 if fast else 0.35)
                    continue
                if fast:
                    entry["bot_next"][bot] = now + 0.02
                else:
                    delay_key = "stack_other" if (mv["type"] == "stack" and mv.get("owner") != bot) else mv["type"]
                    lo, hi = prof["delay"][delay_key]
                    if difficulty == "hard" and mv["type"] == "play":
                        entry["bot_next"][bot] = now + lo
                    else:
                        hesitate = random.uniform(0.35, 0.85) if (mv["type"] in ("play", "stack") and random.random() < 0.16) else 0.0
                        entry["bot_next"][bot] = now + random.uniform(lo, hi) * spd + hesitate
                acted = True
                if not fast and mv["type"] != "slap_press":
                    break
            if acted:
                await broadcast(room_code)
            await asyncio.sleep(0.02 if fast else 0.06)
    except asyncio.CancelledError:
        pass

def start_drivers(room_code: str, entry: dict):
    """(Re)start the clock + bot tasks for a room whose game is running."""
    state = entry["state"]
    if state is None or state.phase == "over":
        return
    old = entry.get("ticker")
    if old is None or old.done():
        entry["ticker"] = asyncio.create_task(room_ticker(room_code))
    if entry["bots"]:
        old = entry.get("bot_task")
        if old is None or old.done():
            entry["bot_task"] = asyncio.create_task(bot_driver(room_code))

@app.websocket("/ws")
async def ws(ws: WebSocket):
    await ws.accept()
    room = name = None
    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            if kind == "join":
                code = str(msg.get("room", "")).strip().upper()
                player = str(msg.get("name", "")).strip()
                if not code or not player:
                    await ws.send_json({"type": "error", "error": "room code and name are both required"})
                    continue
                if msg.get("solo"):
                    # Solo test: a fresh room with the human + N bots, started
                    # immediately. The human is the host.
                    if code in rooms:
                        await ws.send_json({"type": "error", "error": f"room {code} already exists - solo test needs a fresh room code"})
                        continue
                    n_bots = max(1, min(int(msg.get("bots") or 3), MAX_PLAYERS - 1))
                    difficulty = str(msg.get("difficulty") or "easy").strip().lower()
                    if difficulty not in BOT_PROFILES:
                        difficulty = "easy"
                    bots = set()
                    for b in BOT_NAMES:
                        if len(bots) >= n_bots:
                            break
                        if b != player:
                            bots.add(b)
                    entry = {"state": None, "sockets": {player: ws}, "waiting": {},
                             "players": [player] + [b for b in BOT_NAMES if b in bots],
                             "host": player, "bots": bots, "bot_difficulty": difficulty,
                             "public": False, "solo": True, "colors": {},
                             "double_tap_play": bool(msg.get("double_tap_play", False)),
                             "disconnect_times": {},
                             "bot_next": {}, "shed_quota": {}, "freaky_key": None, "grabs": {}, "giveaway_holder": None}
                    pref_col = msg.get("preferred_color")
                    pref_col = pref_col if isinstance(pref_col, int) and 0 <= pref_col < MAX_PLAYERS else None
                    for p in entry["players"]:
                        _assign_color(entry, p, pref_col if p == player else None)
                    rooms[code] = entry
                    room, name = code, player
                    entry["state"] = GameState.start(list(entry["players"]), now=time.monotonic())
                    entry["awaiting_deal"] = True
                    await broadcast(room)
                    continue
                entry = rooms.setdefault(code, {"state": None, "sockets": {}, "waiting": {}, "host": player,
                                                "players": [], "bots": set(), "bot_difficulty": "easy",
                                                "solo": False, "public": bool(msg.get("public", False)), "colors": {},
                                                "pref_colors": {},
                                                "double_tap_play": False,
                                                "disconnect_times": {},
                                                "bot_next": {}, "shed_quota": {}, "freaky_key": None, "grabs": {}, "giveaway_holder": None})
                pref_col = msg.get("preferred_color")
                pref_col = pref_col if isinstance(pref_col, int) and 0 <= pref_col < MAX_PLAYERS else None
                if pref_col is not None:
                    entry.setdefault("pref_colors", {})[player] = pref_col
                if player in entry["sockets"] or player in entry.get("waiting", {}):
                    await ws.send_json({"type": "error", "error": f"'{player}' is already in room {code} - pick a different name"})
                    continue
                if entry["state"] is not None:
                    state = entry["state"]
                    # If the player was dropped after disconnecting for 30s,
                    # rejoining puts them in the waiting room for the next game.
                    if player in state.dropped:
                        room, name = code, player
                        entry.setdefault("waiting", {})[name] = ws
                        await broadcast(room)
                    elif (state.phase != "over" and player in state.players) or (state.phase == "over" and player in entry["players"]):
                        room, name = code, player
                        entry.get("disconnect_times", {}).pop(name, None)
                        state.set_disconnected(name, False)
                        entry["sockets"][name] = ws
                        _assign_color(entry, name, pref_col)
                        start_drivers(room, entry)
                        await broadcast(room)
                    else:
                        room, name = code, player
                        entry.setdefault("waiting", {})[name] = ws
                        await broadcast(room)
                    continue
                if len(entry["players"]) >= MAX_PLAYERS:
                    await ws.send_json({"type": "error", "error": f"room {code} is full"})
                    continue
                room, name = code, player
                entry["sockets"][name] = ws
                entry["players"].append(name)
                _assign_color(entry, name, pref_col)
                await broadcast(room)
            elif kind == "admit" and room and name:
                entry = rooms[room]
                if entry["host"] != name:
                    await ws.send_json({"type": "error", "error": "only the host can admit players"})
                elif entry["state"] is not None and entry["state"].phase != "over":
                    await ws.send_json({"type": "error", "error": "players can only be admitted between games"})
                else:
                    waiting = entry.setdefault("waiting", {})
                    if msg.get("admit_all"):
                        for wname in list(waiting.keys()):
                            if len(entry["players"]) >= MAX_PLAYERS:
                                await ws.send_json({"type": "error", "error": "Player limit has been reached for this game."})
                                break
                            wws = waiting.pop(wname)
                            entry["sockets"][wname] = wws
                            if wname not in entry["players"]:
                                entry["players"].append(wname)
                            _assign_color(entry, wname, entry.get("pref_colors", {}).get(wname))
                        await broadcast(room)
                    else:
                        target = str(msg.get("target", "")).strip()
                        if target in waiting:
                            if len(entry["players"]) >= MAX_PLAYERS:
                                await ws.send_json({"type": "error", "error": "Player limit has been reached for this game."})
                            else:
                                wws = waiting.pop(target)
                                entry["sockets"][target] = wws
                                if target not in entry["players"]:
                                    entry["players"].append(target)
                                _assign_color(entry, target, entry.get("pref_colors", {}).get(target))
                                await broadcast(room)
            elif kind == "set_color" and room and name:
                entry = rooms[room]
                if entry["state"] is not None and entry["state"].phase != "over":
                    await ws.send_json({"type": "error", "error": "colors can only be changed in the lobby"})
                elif name not in entry["players"]:
                    await ws.send_json({"type": "error", "error": "only seated players can pick a color"})
                else:
                    color = msg.get("color")
                    if not isinstance(color, int) or color < 0 or color >= MAX_PLAYERS:
                        await ws.send_json({"type": "error", "error": "invalid color choice"})
                    else:
                        colors = entry.setdefault("colors", {})
                        taken = any(p != name and colors.get(p) == color for p in entry["players"])
                        if taken:
                            await ws.send_json({"type": "error", "error": "that color is already taken"})
                        else:
                            colors[name] = color
                            await broadcast(room)
            elif kind == "start" and room and name:
                entry = rooms[room]
                if entry["host"] != name:
                    await ws.send_json({"type": "error", "error": "only the host can start the game"})
                elif entry["state"] is not None and entry["state"].phase != "over":
                    await ws.send_json({"type": "error", "error": "game already started"})
                else:
                    _prune_disconnected_players(entry)
                    if len(entry["players"]) < MIN_PLAYERS:
                        await ws.send_json({"type": "error", "error": f"need at least {MIN_PLAYERS} players to start"})
                    else:
                        for key in ("ticker", "bot_task"):
                            old = entry.get(key)
                            if old is not None:
                                old.cancel()
                        entry["state"] = GameState.start(
                            list(entry["players"]),
                            starter=entry.get("last_winner"),   # previous winner starts; random if none
                            now=time.monotonic())
                        entry["awaiting_deal"] = True
                        entry["disconnect_times"] = {}
                        entry["stats_recorded"] = False
                        entry["bot_next"] = {}
                        entry["grabs"] = {}
                        entry["giveaway_holder"] = None
                        await broadcast(room)
            elif kind == "deal" and room and name:
                entry = rooms[room]
                if entry["host"] != name:
                    await ws.send_json({"type": "error", "error": "only the host can deal the cards"})
                elif entry.get("state") is None or not entry.get("awaiting_deal"):
                    await ws.send_json({"type": "error", "error": "cards are already dealt"})
                else:
                    now = time.monotonic()
                    entry["awaiting_deal"] = False
                    entry["fast_bots"] = False
                    entry["state"].fast_bots = False
                    entry["state"].started_at = now
                    deal_wait = 4.8 + len(entry["state"].players) * 0.90
                    entry["fp"] = _fingerprint(entry["state"])
                    entry["fp_at"] = now
                    entry["last_phase"] = entry["state"].phase
                    entry["quiet_until"] = now + deal_wait
                    entry["bot_next"] = {b: entry["quiet_until"] for b in entry.get("bots", set())}
                    start_drivers(room, entry)
                    await broadcast(room)
            elif kind == "set_rule" and room and name:
                entry = rooms[room]
                if entry["host"] != name:
                    await ws.send_json({"type": "error", "error": "only the host can change room rules"})
                elif entry["state"] is not None and entry["state"].phase != "over":
                    await ws.send_json({"type": "error", "error": "rules can only be changed before the game starts"})
                else:
                    if "double_tap_play" in msg:
                        entry["double_tap_play"] = bool(msg.get("double_tap_play"))
                    if "bot_difficulty" in msg:
                        diff = str(msg.get("bot_difficulty") or "easy").strip().lower()
                        if diff in BOT_PROFILES:
                            entry["bot_difficulty"] = diff
                    await broadcast(room)
            elif kind == "set_fast_bots" and room and name:
                entry = rooms[room]
                state = entry.get("state")
                if entry["host"] != name:
                    await ws.send_json({"type": "error", "error": "only the host can speed up bots"})
                elif state is None or state.phase == "over":
                    await ws.send_json({"type": "error", "error": "game is not active"})
                else:
                    humans = [p for p in state.players if p not in entry.get("bots", set()) and p not in state.dropped]
                    if not humans or not all(p in state.finished for p in humans):
                        await ws.send_json({"type": "error", "error": "available once all human players have won"})
                    else:
                        enabled = bool(msg.get("enabled", not entry.get("fast_bots", False)))
                        entry["fast_bots"] = enabled
                        state.fast_bots = enabled
                        if enabled:
                            now = time.monotonic()
                            entry["quiet_until"] = 0
                            entry["bot_next"] = {b: 0 for b in entry.get("bots", set())}
                            if state.freaky_deadline is not None:
                                state.freaky_deadline = min(state.freaky_deadline, now + 0.5)
                            if state.joker_deadline is not None:
                                state.joker_deadline = min(state.joker_deadline, now + 0.5)
                        await broadcast(room)
            elif kind == "add_bot" and room and name:
                entry = rooms[room]
                if entry["host"] != name:
                    await ws.send_json({"type": "error", "error": "only the host can add bots"})
                elif entry["state"] is not None and entry["state"].phase != "over":
                    await ws.send_json({"type": "error", "error": "bots can only be added before the game starts"})
                elif len(entry["players"]) >= MAX_PLAYERS:
                    await ws.send_json({"type": "error", "error": f"room {room} is full (max {MAX_PLAYERS} players)"})
                else:
                    taken = set(entry["players"]) | set(entry.get("waiting", {}).keys())
                    bot_name = next((b for b in BOT_NAMES if b not in taken), None)
                    if bot_name is None:
                        idx = 1
                        while f"Bot {idx}" in taken:
                            idx += 1
                        bot_name = f"Bot {idx}"
                    entry.setdefault("bots", set()).add(bot_name)
                    entry["players"].append(bot_name)
                    _assign_color(entry, bot_name)
                    await broadcast(room)
            elif kind == "remove_bot" and room and name:
                entry = rooms[room]
                if entry["host"] != name:
                    await ws.send_json({"type": "error", "error": "only the host can remove bots"})
                elif entry["state"] is not None and entry["state"].phase != "over":
                    await ws.send_json({"type": "error", "error": "bots can only be removed before the game starts"})
                else:
                    bots = entry.get("bots", set())
                    target = msg.get("target")
                    if target and target in bots:
                        bot_name = target
                    else:
                        bot_name = next((p for p in reversed(entry["players"]) if p in bots), None)
                    if bot_name:
                        bots.discard(bot_name)
                        if bot_name in entry["players"]:
                            entry["players"].remove(bot_name)
                        entry.get("colors", {}).pop(bot_name, None)
                        await broadcast(room)
            elif kind == "grab" and room and name:
                entry = rooms[room]
                state = entry["state"]
                if state is not None and not entry.get("awaiting_deal") and state.phase in STACK_PHASES and name not in state.finished:
                    _prune_grabs(entry, time.monotonic())
                    owner, slot = msg.get("owner"), msg.get("slot")
                    grabs = entry.setdefault("grabs", {})
                    if slot == -1 and owner == name and state.playing.get(name) and state.phase != "freaky":
                        # Lifting the top card of your own blind pile: the
                        # card back floats over your pile for the whole
                        # table and your pile count drops by one while
                        # you hold it.
                        grabs[name] = {"owner": name, "slot": -1,
                                       "card": "card_back", "t0": time.monotonic()}
                        await ws.send_json({"type": "key_debug", "action": "grab:play", "phase": state.phase})
                        await broadcast(room)
                    else:
                        slots = state.stacking.get(owner, []) if isinstance(owner, str) else []
                        if (isinstance(slot, int) and 0 <= slot < len(slots) and slots[slot] is not None
                                and not any(g != name and gr["owner"] == owner and gr["slot"] == slot
                                            for g, gr in grabs.items())):
                            grabs[name] = {"owner": owner, "slot": slot,
                                           "card": slots[slot].name, "t0": time.monotonic()}
                            await ws.send_json({"type": "key_debug", "action": f"grab:{owner}[{slot}]", "phase": state.phase})
                            await broadcast(room)
            elif kind == "release_grab" and room and name:
                entry = rooms[room]
                if entry.get("grabs", {}).pop(name, None) is not None:
                    await broadcast(room)
            elif kind == "giveaway_hold" and room and name:
                entry = rooms[room]
                state = entry["state"]
                if state is not None and state.phase == "joker_choose" and state.slap_winner == name:
                    entry["giveaway_holder"] = name
                    await broadcast(room)
            elif kind == "giveaway_release" and room and name:
                entry = rooms[room]
                if entry.get("giveaway_holder") == name:
                    entry["giveaway_holder"] = None
                    await broadcast(room)
            elif kind == "move" and room and name:
                entry = rooms[room]
                if entry["state"] is None:
                    await ws.send_json({"type": "error", "error": "game has not started"})
                    continue
                if entry.get("awaiting_deal"):
                    await ws.send_json({"type": "error", "error": "waiting for the host to deal cards"})
                    continue
                move = msg.get("move") or {}
                if move.get("type") == "stack":
                    # A grabbed card is IN the grabber's hand: nobody else may
                    # stack it, and stacking spends your own grab.
                    _prune_grabs(entry, time.monotonic())
                    grabs = entry.get("grabs", {})
                    holder = next((g for g, gr in grabs.items()
                                   if gr["owner"] == move.get("owner") and gr["slot"] == move.get("slot")), None)
                    if holder is not None and holder != name:
                        continue
                    grabs.pop(name, None)
                try:
                    entry["state"].apply_move(name, move, now=time.monotonic())
                except ValueError as e:
                    await ws.send_json({"type": "error", "error": str(e)})
                    continue
                entry["grabs"].pop(name, None)   # acting spends any card you were holding up
                await ws.send_json({"type": "key_debug", "action": f"move:{move.get('type')}", "phase": entry["state"].phase})
                await broadcast(room)
            elif kind == "key_debug" and room and name:
                entry = rooms[room]
                st = entry.get("state")
                await ws.send_json({
                    "type": "key_debug",
                    "key": str(msg.get("key") or "")[:24],
                    "code": str(msg.get("code") or "")[:24],
                    "action": str(msg.get("action") or "keydown")[:40],
                    "phase": st.phase if st is not None else "lobby",
                })
            elif kind == "chat" and room and name:
                entry = rooms[room]
                text = str(msg.get("text", "")).strip()[:200]
                if text:
                    item = {
                        "sender": name,
                        "text": text,
                        "color": _assign_color(entry, name),
                        "ts": time.time(),
                    }
                    chat = entry.setdefault("chat", [])
                    chat.append(item)
                    if len(chat) > 60:
                        del chat[:-60]
                    for target_ws in list(entry["sockets"].values()) + list(entry.get("waiting", {}).values()):
                        try:
                            await target_ws.send_json({"type": "chat", "message": item})
                        except Exception:
                            pass
            elif kind in ("start", "move"):
                await ws.send_json({"type": "error", "error": "join a room first"})
    except WebSocketDisconnect:
        pass
    finally:
        if room and name and room in rooms:
            entry = rooms[room]
            if entry["sockets"].get(name) is ws:
                entry["sockets"].pop(name, None)
            was_waiting = False
            if entry.get("waiting", {}).get(name) is ws:
                entry["waiting"].pop(name, None)
                was_waiting = True
            entry.get("grabs", {}).pop(name, None)
            state = entry["state"]
            if state is None or state.phase == "over":
                # Instantly drop disconnected players in the lobby or Tiki Standings.
                await _drop_from_lobby_or_standings(room, entry, name)
            elif not was_waiting and state is not None and state.phase != "over":
                if name in state.players and name not in state.dropped:
                    entry.setdefault("disconnect_times", {})[name] = time.monotonic()
                    state.set_disconnected(name, True)
            if not entry["sockets"]:
                if entry.get("waiting"):
                    if state is None or state.phase == "over":
                        for key in ("ticker", "bot_task"):
                            old = entry.get(key)
                            if old is not None:
                                old.cancel()
                        if state is not None and state.phase == "over":
                            entry["state"] = None
                        wname, wws = next(iter(entry["waiting"].items()))
                        entry["waiting"].pop(wname, None)
                        entry["sockets"][wname] = wws
                        if wname not in entry["players"]:
                            entry["players"].append(wname)
                        entry["host"] = wname
                        try:
                            await broadcast(room)
                        except Exception:
                            pass
                    else:
                        for key in ("ticker", "bot_task"):
                            old = entry.get(key)
                            if old is not None:
                                old.cancel()
                else:
                    for key in ("ticker", "bot_task"):
                        old = entry.get(key)
                        if old is not None:
                            old.cancel()
                    rooms.pop(room, None)
            else:
                if entry["host"] == name:
                    entry["host"] = next(iter(entry["sockets"]))  # host passes to the next player
                try:
                    await broadcast(room)
                except Exception:
                    pass
