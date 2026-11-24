"""End-to-end test of the multiplayer plumbing (NOT the game's rules yet).
Start the server first:  cd ../server && uvicorn server:app --port 8765
Then:                    python test_multiplayer.py
Uses two separate WebSocket connections, like two players on two devices.
"""
import asyncio, json, sys, urllib.request
import websockets

BASE = "http://127.0.0.1:8765"
WS = "ws://127.0.0.1:8765/ws"
ROOM = "TEST"

def http(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return r.status, r.headers.get_content_type(), r.read()

async def recv(ws):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=5))

async def main():
    # --- HTTP: page, health, a card PNG, the client script ---
    status, ctype, body = http("/health")
    assert status == 200 and json.loads(body)["ok"], "health failed"
    status, ctype, body = http("/")
    assert status == 200 and b"Freaky Tiki" in body, "index failed"
    status, ctype, body = http("/assets/cards/A_of_spades.png")
    assert status == 200 and body[:8] == b"\x89PNG\r\n\x1a\n", "card PNG failed"
    status, ctype, body = http("/client/app.js")
    assert status == 200 and b"WebSocket" in body, "app.js failed"
    print("HTTP: PASS (health, page, card PNG, client script all served)")

    async with websockets.connect(WS) as c1, websockets.connect(WS) as c2:
        # --- lobby ---
        await c1.send(json.dumps({"type": "join", "room": ROOM, "name": "Noah"}))
        m = await recv(c1)
        assert m["type"] == "lobby" and m["view"]["players"] == ["Noah"], m
        assert m["view"]["host"] == "Noah" and m["view"]["can_start"] is False, m
        await c1.send(json.dumps({"type": "start"}))
        m = await recv(c1)
        assert m["type"] == "error" and "at least 2" in m["error"], m  # too early to start

        await c2.send(json.dumps({"type": "join", "room": ROOM, "name": "Friend"}))
        m1, m2 = await recv(c1), await recv(c2)
        assert m1["view"]["players"] == ["Noah", "Friend"] and m1["view"]["can_start"] is True, m1
        assert m2["view"]["you"] == "Friend" and m2["view"]["you_are_host"] is False, m2
        print("Lobby: PASS (join broadcasts, host = first player, start gated at 2 players)")

        # --- duplicate name rejected ---
        async with websockets.connect(WS) as c3:
            await c3.send(json.dumps({"type": "join", "room": ROOM, "name": "Noah"}))
            m = await recv(c3)
            assert m["type"] == "error" and "already in room" in m["error"], m
        print("Duplicate name: PASS (rejected)")

        # --- only the host can start; no moves before start ---
        await c2.send(json.dumps({"type": "start"}))
        m = await recv(c2)
        assert m["type"] == "error" and "only the host" in m["error"], m
        await c1.send(json.dumps({"type": "move", "move": {"type": "play", "card": "A_of_spades"}}))
        m = await recv(c1)
        assert m["type"] == "error" and "not started" in m["error"], m

        # --- host starts a Freaky Tiki game: 54 dealt, stacking hands public,
        #     playing hands secret from everyone, including their owners ---
        await c1.send(json.dumps({"type": "start"}))
        m1, m2 = await recv(c1), await recv(c2)
        conns = {"Noah": c1, "Friend": c2}
        for m, who in ((m1, "Noah"), (m2, "Friend")):
            v = m["view"]
            assert m["type"] == "state" and v["started"] and v["you"] == who, m
            assert v["playing_counts"] == {"Noah": 25, "Friend": 25}, m   # 27 dealt - 2 flipped up
            assert v["your_playing_count"] == 25, m
            assert all(len(s) == 2 and all(s) for s in v["stacking_hands"].values()), m
            dealt = [c for s in v["stacking_hands"].values() for c in s]
            assert len(dealt) == 4 and len(set(dealt)) == 4, m              # public, unique
            assert "your_hand" not in v and "playing" not in v, m           # blind hands never sent
            assert v["middle_top"] is None and v["middle_count"] == 0, m
        starter = m1["view"]["turn_player"]
        assert starter in conns, m1     # first game: a random player starts
        print(f"Start: PASS (54 dealt 27/27, 2 stacking cards each face up, playing hands blind, {starter} starts)")

        # --- the rules engine is live: grace-period disallow, then a real first card ---
        other = "Friend" if starter == "Noah" else "Noah"
        await conns[other].send(json.dumps({"type": "move", "move": {"type": "play"}}))
        m = await recv(conns[other])
        assert m["type"] == "error" and "grace period" in m["error"], m   # <0.5s: disallowed, no penalty
        await conns[starter].send(json.dumps({"type": "move", "move": {"type": "play"}}))
        m = await recv(conns[starter])
        assert m["type"] == "state" and m["view"]["middle_count"] == 1 and m["view"]["middle_top"], m
        print(f"Moves: PASS (out-of-turn disallowed in grace period; {starter} played the first card: {m['view']['middle_top']})")

        # --- reconnect: a dropped player gets their seat back; strangers can't sneak in ---
        await conns[other].close()
        await asyncio.sleep(0.3)   # let the server register the disconnect
        async with websockets.connect(WS) as c4:
            await c4.send(json.dumps({"type": "join", "room": ROOM, "name": "Stranger"}))
            m = await recv(c4)
            assert m["type"] == "error" and "already started" in m["error"], m
        async with websockets.connect(WS) as c5:
            await c5.send(json.dumps({"type": "join", "room": ROOM, "name": other}))
            m = await recv(c5)
            v = m["view"]
            assert m["type"] == "state" and v["started"] and v["you"] == other, m
            assert v["middle_count"] == 1 and v["playing_counts"][other] in (24, 25, 26), m
        print(f"Reconnect: PASS (stranger blocked; {other} dropped and rejoined their seat, game intact)")

    print("ALL MULTIPLAYER PLUMBING TESTS PASSED")

if __name__ == "__main__":
    asyncio.run(main())
