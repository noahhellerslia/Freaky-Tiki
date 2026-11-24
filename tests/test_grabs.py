"""Shared stacking grabs: server-enforced dibs on a held card.

Flow: seed the middle by playing turns until some face-up stacking card
can legally stack on it. The OTHER player grabs that card -> both players
SEE the grab; the slot's owner cannot grab or stack it meanwhile; the
grabber CAN stack it (spending the grab); and a grab left alone expires
after the TTL.

Runs its own server on port 8021 with FREAKY_GRAB_TTL=3.0.
Needs the project venv (websockets is a uvicorn dependency).
"""
import asyncio, json, os, signal, subprocess, sys, time, urllib.request
import websockets

PORT = 8021
WS = f"ws://127.0.0.1:{PORT}/ws"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]


def rv(card):
    r = card.split("_of_")[0]
    return 14 if r == "A" else 13 if r == "K" else 12 if r == "Q" else 11 if r == "J" else int(r)


def within_one(a, b):
    d = abs(rv(a) - rv(b))
    return d <= 1 or d == 12


async def wait_view(ws, pred, timeout=6):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        if "view" in m:
            last = m["view"]
            if pred(last):
                return last
    raise AssertionError(f"no matching view; last phase={last and last.get('phase')} grabs={last and last.get('grabs')}")


async def fresh_view(ws, seconds=1.2):
    """The freshest view within a short window, or None if the server sent
    nothing (a silently-refused move broadcasts nothing)."""
    view = None
    try:
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=seconds))
            if "view" in m:
                view = m["view"]
    except asyncio.TimeoutError:
        pass
    return view


async def main():
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.server:app", "--port", str(PORT)],
        cwd=ROOT, env={**os.environ, "FREAKY_GRAB_TTL": "3.0"},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1)
                break
            except Exception:
                await asyncio.sleep(0.25)
        socks = {}
        async with websockets.connect(WS) as a, websockets.connect(WS) as b:
            socks = {"Ann": a, "Bob": b}
            await a.send(json.dumps({"type": "join", "room": "GRAB", "name": "Ann"}))
            await wait_view(a, lambda v: not v.get("started", True))
            await b.send(json.dumps({"type": "join", "room": "GRAB", "name": "Bob"}))
            await wait_view(b, lambda v: not v.get("started", True))
            await a.send(json.dumps({"type": "start"}))
            v = await wait_view(a, lambda v: v.get("started") and v.get("phase") == "open")

            # ---- seed the middle until a legal stack target exists --------
            target = None   # (owner, slot, card)
            for _ in range(14):
                if v["phase"] == "freaky":
                    fp = v["freaky"]["player"]
                    await socks[fp].send(json.dumps({"type": "move", "move": {"type": "freaky"}}))
                    v = await wait_view(a, lambda x: x.get("phase") != "freaky")
                    continue
                if v["phase"] in ("joker", "joker_choose"):
                    for who in ("Ann", "Bob"):
                        for _ in range(2):
                            await socks[who].send(json.dumps({"type": "move", "move": {"type": "slap_press"}}))
                    v = await fresh_view(a)
                    if v["phase"] == "joker_choose":
                        w = v["joker"]["winner"]
                        await socks[w].send(json.dumps({"type": "move", "move": {"type": "slap_choose", "target": w}}))
                        v = await wait_view(a, lambda x: x.get("phase") not in ("joker", "joker_choose"))
                    continue
                top = v["middle_top"]
                if top and not top.startswith("joker"):
                    for owner, slots in v["stacking_hands"].items():
                        for slot, card in enumerate(slots):
                            if card and within_one(card, top):
                                target = (owner, slot, card)
                                break
                        if target:
                            break
                if target:
                    break
                turn = v["turn_player"]
                await socks[turn].send(json.dumps({"type": "move", "move": {"type": "play"}}))
                v2 = await fresh_view(a)
                if v2 is not None:
                    v = v2   # a refused play changes nothing: the loop retries it
            assert target, "never found a stackable card to grab"
            owner, slot, card = target
            grabber = "Bob" if owner == "Ann" else "Ann"
            other = owner
            mid0 = v["middle_count"]
            print(f"  setup: {grabber} will grab {owner}'s {card} (slot {slot}) over a {v['middle_top']} middle")

            # ---- G1: the grab shows in everyone's view --------------------
            await socks[grabber].send(json.dumps({"type": "grab", "owner": owner, "slot": slot}))
            va = await wait_view(a, lambda x: grabber in x.get("grabs", {}))
            vb = await wait_view(b, lambda x: grabber in x.get("grabs", {}))
            assert va["grabs"][grabber]["card"] == card and vb["grabs"][grabber]["card"] == card
            print("  G1 ok - a grab shows in every player's view")

            # ---- G2: nobody else can take the held card -------------------
            # Refusals are silent; a legal probe grab forces a full broadcast.
            probe = next((o, s) for o, ss in v["stacking_hands"].items()
                         for s, c in enumerate(ss) if c and not (o == owner and s == slot))
            await socks[other].send(json.dumps({"type": "grab", "owner": owner, "slot": slot}))
            await socks[other].send(json.dumps({"type": "move", "move": {"type": "stack", "owner": owner, "slot": slot}}))
            await socks[other].send(json.dumps({"type": "grab", "owner": probe[0], "slot": probe[1]}))
            vo = await wait_view(socks[other], lambda x: x.get("grabs", {}).get(other, {}).get("slot") == probe[1])
            assert vo["grabs"][grabber]["slot"] == slot, "the grab survived both attempts"
            assert vo["middle_count"] == mid0 and vo["stacking_hands"][owner][slot] == card, \
                "stacking a held card is refused - no move, no penalty"
            await socks[other].send(json.dumps({"type": "release_grab"}))
            await wait_view(socks[other], lambda x: other not in x.get("grabs", {}))
            print("  G2 ok - a held card cannot be grabbed or stacked by anyone else")

            # ---- G3: the grabber stacks it, spending the grab -------------
            await socks[grabber].send(json.dumps({"type": "move", "move": {"type": "stack", "owner": owner, "slot": slot}}))
            vg = await wait_view(socks[grabber], lambda x: x.get("middle_top") == card)
            assert vg["grabs"] == {}, f"stacking spends the grab: {vg['grabs']}"
            print("  G3 ok - the grabber can stack the held card; the grab clears")

            # ---- G4: an untouched grab expires ----------------------------
            await asyncio.sleep(2.2)   # let the stack sequence settle to open/stacker_start
            v = await fresh_view(a)
            tries = 0
            while v["phase"] not in ("open", "stacked", "stacker_start") and tries < 10:
                await asyncio.sleep(0.5)
                v = await fresh_view(a)
                tries += 1
            slot2 = next(s for s, c in enumerate(v["stacking_hands"]["Bob"]) if c)
            await b.send(json.dumps({"type": "grab", "owner": "Bob", "slot": slot2}))
            await wait_view(a, lambda x: "Bob" in x.get("grabs", {}))
            await asyncio.sleep(3.4)
            v = await wait_view(a, lambda x: "Bob" not in x.get("grabs", {}), timeout=5)
            print("  G4 ok - an untouched grab expires and the card falls back")
        print("test_grabs: ALL PASSED")
    finally:
        proc.send_signal(signal.SIGTERM)


if __name__ == "__main__":
    asyncio.run(main())
