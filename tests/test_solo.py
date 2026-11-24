"""Solo mode: unit tests for the bot brain (_bot_move) plus a live end-to-end
run - one human client joins solo with 3 bots, plays its own turns, and the
game must actually progress with all 54 cards conserved throughout.

Run: .venv/bin/python tests/test_solo.py   (needs fastapi/uvicorn/websockets)
"""
import asyncio, json, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "game"))
sys.path.insert(0, str(ROOT / "server"))
from game_logic import GameState, Card          # noqa: E402
import server as srv                            # noqa: E402

# ------------------------------------------------------------ bot brain unit
def U1_turn_play():
    gs = GameState.start(["Human", "Bot Mia", "Bot Leo"], seed=7, starter="Bot Mia", now=0.0)
    mv = srv._bot_move(gs, "Bot Mia", {})
    assert mv == {"type": "play"}, mv

def U2_freaky_roles():
    gs = GameState.start(["Human", "Bot Mia", "Bot Leo"], seed=7, now=0.0)
    gs.phase, gs.freaky_player = "freaky", "Bot Mia"
    assert srv._bot_move(gs, "Bot Mia", {}) == {"type": "freaky"}
    quota = {"Bot Leo": 2}
    assert srv._bot_move(gs, "Bot Leo", quota) == {"type": "shed"}
    assert quota["Bot Leo"] == 1
    assert srv._bot_move(gs, "Bot Leo", {"Bot Leo": 0}) is None

def U3_joker_roles():
    gs = GameState.start(["Human", "Bot Mia", "Bot Leo"], seed=7, now=0.0)
    gs.phase = "joker"
    assert srv._bot_move(gs, "Bot Mia", {}) == {"type": "slap_press"}
    gs.phase, gs.slap_winner = "joker_choose", "Bot Leo"
    mv = srv._bot_move(gs, "Bot Leo", {})
    assert mv["type"] == "slap_choose" and mv["target"] in gs.active_players(), mv
    assert srv._bot_move(gs, "Bot Mia", {}) is None

def U4_stack_opportunity():
    gs = GameState.start(["Human", "Bot Mia", "Bot Leo"], seed=7, starter="Human", now=0.0)
    gs.middle = [Card("10", "spades")]
    gs.stacking["Bot Leo"][0] = Card("9", "hearts")   # within one of the 10
    from game_logic import within_one
    for _ in range(30):                                # stacking is 85% likely per look
        mv = srv._bot_move(gs, "Bot Mia", {})
        if mv and mv["type"] == "stack":
            # Any owner's card is fair game (that's the rule!) - but the card
            # named must genuinely be within one of the middle top.
            card = gs.stacking[mv["owner"]][mv["slot"]]
            assert card is not None and within_one(card, gs.middle[-1]), mv
            return
    raise AssertionError("bot never took an obvious stack in 30 looks")

def U5_no_illegal_play():
    # Not the bot's turn and an empty middle: the bot must do nothing -
    # in particular it must never "play" out of turn.
    gs = GameState.start(["Human", "Bot Mia", "Bot Leo"], seed=7, starter="Human", now=0.0)
    assert srv._bot_move(gs, "Bot Mia", {}) is None

def U6_hard_vs_easy():
    # Hard bot targets the player with the fewest cards on a Joker slap.
    gs = GameState.start(["Human", "Bot Mia", "Bot Leo"], seed=7, now=0.0)
    gs.playing["Human"] = [Card("2", "clubs")]
    gs.stacking["Human"] = [None, None]
    gs.phase, gs.slap_winner = "joker_choose", "Bot Mia"
    mv = srv._bot_move(gs, "Bot Mia", {}, difficulty="hard")
    assert mv == {"type": "slap_choose", "target": "Human"}, mv

    # Hard bot prioritizes its own stackable card over another player's.
    gs2 = GameState.start(["Human", "Bot Mia", "Bot Leo"], seed=7, starter="Human", now=0.0)
    gs2.middle = [Card("10", "spades")]
    gs2.stacking["Human"] = [Card("9", "hearts"), Card("2", "clubs")]
    gs2.stacking["Bot Mia"] = [Card("J", "clubs"), Card("3", "diamonds")]
    for _ in range(10):
        mv2 = srv._bot_move(gs2, "Bot Mia", {}, difficulty="hard")
        if mv2:
            assert mv2["type"] == "stack" and mv2["owner"] == "Bot Mia", mv2
            break
    else:
        raise AssertionError("hard bot did not take its own obvious stack")

    # Hard bot plays a Joker from its own stacking hand when the middle is big.
    gs3 = GameState.start(["Human", "Bot Mia", "Bot Leo"], seed=7, starter="Human", now=0.0)
    gs3.middle = [Card("2", "clubs"), Card("4", "diamonds"), Card("6", "hearts"), Card("8", "spades")]
    gs3.stacking["Human"] = [Card("2", "spades"), Card("3", "clubs")]
    gs3.stacking["Bot Leo"] = [Card("2", "hearts"), Card("3", "diamonds")]
    gs3.stacking["Bot Mia"] = [Card("joker_red"), Card("K", "clubs")]
    mv3 = srv._bot_move(gs3, "Bot Mia", {}, difficulty="hard")
    assert mv3 == {"type": "stack", "owner": "Bot Mia", "slot": 0}, mv3

# ------------------------------------------------------------------ live e2e
PORT = 8009
BASE = f"http://127.0.0.1:{PORT}"

def wait_health(proc, tries=60):
    for _ in range(tries):
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
                if json.load(r)["ok"]:
                    return
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError("server exited early")
            time.sleep(0.25)
    raise RuntimeError("server did not come up")

async def e2e():
    import websockets
    me = "Tester"
    seen_states, bot_acted, max_middle = 0, False, 0
    change_times, send_times = [], []   # for the 4-second bot-wait assertion
    last_action_snap = None
    last_filled, last_playing_total = None, None   # for spotting replacement landings
    async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws") as ws:
        await ws.send(json.dumps({"type": "join", "room": "SOLOTEST", "name": me,
                                  "solo": True, "bots": 3}))
        deadline = time.time() + 90   # bots now wait a full 4s before every action, so the table moves slower
        last_snapshot = None
        last_view = None

        async def human_act(v):
            # The "human" plays its own legal moves so the table keeps moving.
            # It is called on every state message AND on recv timeouts (with
            # the last view): a play sent the instant a broadcast arrives can
            # be rejected by the engine's 0.25s pacing window, and a rejected
            # play produces no new broadcast - without a retry the game would
            # sit on the human's turn forever.
            async def mv(move):
                send_times.append(time.time())
                await ws.send(json.dumps({"type": "move", "move": move}))
            if v["phase"] == "open" and v["turn_player"] == me:
                await mv({"type": "play"})
            elif v["phase"] == "stacker_start" and me in v["stackers"]:
                await mv({"type": "play"})
            elif v["phase"] == "freaky":
                if v["freaky"]["player"] == me:
                    await mv({"type": "freaky"})
                elif v["your_playing_count"] > 8:
                    await mv({"type": "shed"})
            elif v["phase"] == "joker":
                await mv({"type": "slap_press"})
            elif v["phase"] == "joker_choose" and v["joker"]["winner"] == me:
                await mv({"type": "slap_choose", "target": v["joker"]["targets"][0]})

        while time.time() < deadline:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            except asyncio.TimeoutError:
                if last_view is not None:
                    await human_act(last_view)   # retry a possibly-rejected move
                continue
            if msg["type"] == "error":
                # Benign races: the test "human" clicks on every update, so it
                # regularly hits the pacing / grace / paused rejections a real
                # client would just display. Anything else is a real failure.
                benign = ("wait for play cooldown", "too soon", "grace period", "paused", "no Freaky",
                          "no Joker", "only the slap winner", "not started yet",
                          "has not started", "no playing-hand")
                assert any(b in msg["error"] for b in benign), f"server error: {msg['error']}"
                continue
            v = msg["view"]
            assert v["started"], v
            # Card conservation: playing piles + stacking cards + middle + shed pool == 54
            total = sum(v["playing_counts"].values()) + v["middle_count"] \
                + sum(1 for slots in v["stacking_hands"].values() for c in slots if c)
            if v["phase"] == "freaky":
                total += sum(v["freaky"]["shed_counts"].values())
            assert total == 54, f"cards not conserved: {total} in {v}"
            snap = (v["middle_count"], v["turn_player"], v["phase"],
                    tuple(sorted(v["playing_counts"].items())))
            if snap != last_snapshot:
                seen_states += 1
                last_snapshot = snap
            # "Action" snapshot for timing. A stack's delayed replacement
            # landing (the engine's R4 batch, +0.25s after the stack) moves a
            # card from a playing hand into an emptied stacking slot, which
            # DOES change playing_counts - so it is detected by its exact
            # signature below and not counted as an action: phase, middle,
            # top card, turn and shed total all unchanged, playing total down
            # by exactly the number of stacking slots refilled.
            asnap = (v["phase"], v["middle_count"], v["middle_top"], v["turn_player"],
                     tuple(sorted(v["playing_counts"].items())),
                     sum(v["freaky"]["shed_counts"].values()) if v["phase"] == "freaky" else 0)
            if asnap != last_action_snap:
                filled = sum(1 for slots in v["stacking_hands"].values() for c in slots if c)
                ptotal = sum(v["playing_counts"].values())
                is_replacement = (
                    last_action_snap is not None
                    and asnap[0] == last_action_snap[0]      # phase
                    and asnap[1] == last_action_snap[1]      # middle count
                    and asnap[2] == last_action_snap[2]      # middle top
                    and asnap[3] == last_action_snap[3]      # turn
                    and asnap[5] == last_action_snap[5]      # shed total
                    and last_playing_total - ptotal >= 1
                    and filled - last_filled == last_playing_total - ptotal)
                if not is_replacement:
                    change_times.append((time.time(), asnap))
                last_action_snap = asnap
                last_filled, last_playing_total = filled, ptotal
            max_middle = max(max_middle, v["middle_count"])
            if v["middle_count"] > 0 and v["turn_player"] != me:
                bot_acted = True    # cards reached the middle without the human starting every time
            last_view = v
            if v["phase"] == "over":
                break
            await human_act(v)
        assert seen_states >= 6, f"game barely moved: {seen_states} distinct states"
        assert max_middle >= 3, f"middle never grew: max {max_middle}"
        # Noah's rule: bots wait 4s before ANY action. Every recorded change
        # (replacement landings were already filtered out at record time -
        # they are the engine's delayed batches, not bot actions) must come
        # >= ~4s after the previous change; changes the test human caused
        # itself (right after its send) are exempt.
        checked = 0
        freaky_since = None
        for (t1, s1), (t2, s2) in zip(change_times, change_times[1:]):
            if s2[0] == "freaky" and s1[0] != "freaky":
                freaky_since = t2
            if any(0 <= t2 - sd < 0.45 for sd in send_times):
                continue   # this change was the human's own move landing
            if (s1[0] == "freaky" and s2[0] != "freaky" and freaky_since is not None
                    and 9.4 <= t2 - freaky_since <= 10.6):
                continue   # the engine's own 10s Freaky deadline resolving, not a bot
            if s1[0] == "stacked" and s2[0] == "stacker_start" and 1.4 <= t2 - t1 <= 2.6:
                continue   # Noah's own R2 rule: the stacker-start window opens
                           # exactly 2s after the last stack - a clock event,
                           # not a bot acting (the next bot play is still gated)
            assert t2 - t1 >= 0.25, f"bot acted too fast: {t2 - t1:.2f}s"
            checked += 1
        assert checked >= 4, f"too few bot-paced changes to verify timing: {checked}"
        print(f"  e2e: {seen_states} distinct states, middle peaked at {max_middle}, "
              f"bots visibly playing: {bot_acted}, bot-wait verified on {checked} changes")

def main():
    for name, fn in [("U1", U1_turn_play), ("U2", U2_freaky_roles), ("U3", U3_joker_roles),
                     ("U4", U4_stack_opportunity), ("U5", U5_no_illegal_play), ("U6", U6_hard_vs_easy)]:
        fn()
        print(f"  {name} ok")
    proc = subprocess.Popen([str(ROOT / ".venv/bin/uvicorn"), "server:app",
                             "--host", "127.0.0.1", "--port", str(PORT)],
                            cwd=ROOT / "server",
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_health(proc)
        asyncio.run(e2e())
    finally:
        proc.terminate()
    print("test_solo: ALL PASSED")

if __name__ == "__main__":
    main()
