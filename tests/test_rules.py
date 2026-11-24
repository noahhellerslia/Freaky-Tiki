"""Deterministic tests for the Freaky Tiki rules engine (Noah's R1-R10).
Crafted states + a fake clock: every timing rule (0.25 / 0.5 / 2 / 10s) is
exercised exactly. Run: python3 test_rules.py  (from this folder)"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "game"))
from game_logic import Card, GameState

def C(spec):
    if spec.startswith("joker"): return Card(spec)
    return Card(spec[:-1], {"s": "spades", "h": "hearts", "d": "diamonds", "c": "clubs"}[spec[-1]])
def hand(*specs): return [C(s) for s in specs]
def names(cards): return [c.name for c in cards]

def state(players, playing, stacking, middle, turn, last=None):
    return GameState(players=players, playing={p: hand(*playing[p]) for p in players},
                     stacking={p: [C(s) if s else None for s in stacking[p]] for p in players},
                     middle=hand(*middle), turn=players.index(turn),
                     started_at=0.0, last_placement_at=last)
def rich(players, **kw):
    """Everyone padded with cards so nobody finishes by accident."""
    playing = {p: kw.get("playing", {}).get(p, ["2c", "3d"]) for p in players}
    stacking = {p: kw.get("stacking", {}).get(p, ["4c", "5d"]) for p in players}
    return state(players, playing, stacking, kw["middle"], kw["turn"], kw.get("last"))

def expect_error(fn, needle):
    try:
        fn()
    except ValueError as e:
        assert needle in str(e), f"error {e!r} does not contain {needle!r}"
        return
    raise AssertionError(f"expected ValueError containing {needle!r}")

P3 = ["A", "B", "C"]

# --- T1: ordinary play, clockwise turns, 0.25s pacing (R10) ---
gs = rich(P3, middle=["Kd"], turn="A", playing={"A": ["5s", "9h"]})
gs.apply_move("A", {"type": "play"}, now=10.0)
assert names(gs.middle) == ["K_of_diamonds", "5_of_spades"] and gs.players[gs.turn] == "B"
expect_error(lambda: gs.apply_move("B", {"type": "play"}, now=10.1), "wait for play cooldown")
gs.apply_move("B", {"type": "play"}, now=10.3)
assert gs.players[gs.turn] == "C"
print("T1 ordinary play + pacing: PASS")

# --- T2: out-of-turn playing hand is disallowed (both within and after grace) ---
gs = rich(P3, middle=["Kd", "4c"], turn="C", last=10.0, playing={"A": ["7d", "8h", "9s"]})
expect_error(lambda: gs.apply_move("A", {"type": "play"}, now=10.3), "not your turn")
expect_error(lambda: gs.apply_move("A", {"type": "play"}, now=10.6), "not your turn")
assert len(gs.middle) == 2 and len(gs.playing["A"]) == 3 and gs.players[gs.turn] == "C"
print("T2 out-of-turn play disallowed: PASS")

# --- T3: stack chain, batched replacement 0.25s after LAST stack, stacker-start (R2, R4) ---
gs = rich(P3, middle=["10s"], turn="B", last=0.0,
          playing={"A": ["3c", "4d", "5h", "Ks", "2d"]},
          stacking={"A": ["9h", "6c"], "B": ["8d", "6h"], "C": ["7c", "6s"]})
gs.apply_move("A", {"type": "stack", "owner": "A", "slot": 0}, now=1.0)
gs.apply_move("A", {"type": "stack", "owner": "B", "slot": 0}, now=1.1)
gs.apply_move("A", {"type": "stack", "owner": "C", "slot": 0}, now=1.2)
assert gs.phase == "stacked" and gs.stackers == ["A"]
assert gs.stacking["A"][0] is None and gs.stacking["B"][0] is None and gs.stacking["C"][0] is None
gs.tick(1.44)
assert gs.stacking["A"][0] is None and names(gs.playing["A"])[0] == "3_of_clubs"   # not yet
gs.tick(1.45)   # 0.25s after the last stack: ALL replacements land at once, in taken order
assert gs.stacking["A"][0].name == "3_of_clubs"
assert gs.stacking["B"][0].name == "4_of_diamonds"
assert gs.stacking["C"][0].name == "5_of_hearts"
expect_error(lambda: gs.apply_move("A", {"type": "play"}, now=2.0), "wait for play cooldown")
expect_error(lambda: gs.apply_move("B", {"type": "play"}, now=2.0), "only a player who stacked")
expect_error(lambda: gs.apply_move("B", {"type": "play"}, now=3.3), "only a player who stacked")
gs.apply_move("A", {"type": "play"}, now=3.3)   # the stacker starts; K on 7 = no Freaky
assert gs.middle[-1].name == "K_of_spades" and gs.players[gs.turn] == "B" and gs.phase == "open"
print("T3 stack chain + delayed batch replacement + stacker-start: PASS")

# --- T4: incorrect stack - grace disallows, then penalty on the PLACER (R3, R4, R7) ---
gs = rich(P3, middle=["3s"], turn="A", last=0.0,
          playing={"B": ["6c", "8d"]}, stacking={"B": ["5h", "4s"]})
expect_error(lambda: gs.apply_move("B", {"type": "stack", "owner": "B", "slot": 0}, now=0.3), "grace period")
assert gs.stacking["B"][0] is not None and len(gs.middle) == 1
gs.apply_move("B", {"type": "stack", "owner": "B", "slot": 0}, now=1.0)   # penalty applied
assert gs.middle == [] and gs.players[gs.turn] == "B"
assert set(names(gs.playing["B"])[-2:]) == {"3_of_spades", "5_of_hearts"} or \
       set(names(gs.playing["B"])) >= {"3_of_spades", "5_of_hearts"}
gs.tick(1.3)   # the incorrect card's slot is still replaced, 0.25s after the stack
assert gs.stacking["B"][0] is not None and gs.stacking["B"][0].name == "6_of_clubs"
print("T4 incorrect stack grace/penalty/replacement: PASS")

# --- T5: replacement fallback - owner replaces own slot; both empty -> slot stays, owner can finish ---
P4 = ["A", "B", "C", "D"]
gs = rich(P4, middle=["10s"], turn="C", last=0.0,
          playing={"A": [], "B": ["4c"]},
          stacking={"A": ["Qs", "3h"], "B": ["9h", "3s"]})
gs.apply_move("A", {"type": "stack", "owner": "B", "slot": 0}, now=1.0)   # A has no playing cards
gs.tick(1.3)
assert gs.stacking["B"][0].name == "4_of_clubs" and gs.playing["B"] == []   # B replaced their own
gs = rich(P4, middle=["9s"], turn="C", last=0.0,
          playing={"A": [], "B": []},
          stacking={"A": ["Qs", "3h"], "B": ["8h", None]})
gs.apply_move("A", {"type": "stack", "owner": "B", "slot": 0}, now=1.0)
gs.tick(1.3)
assert gs.stacking["B"][0] is None and "B" in gs.finished   # nobody could replace it; B hit zero total
print("T5 replacement fallback: PASS")

# --- T6: Freaky Tiki - trigger, shedding, call pays sheds UNSHUFFLED on TOP; 10s timeout (R1, R5b, R9) ---
gs = rich(P3, middle=["Ks"], turn="A", last=0.0,
          playing={"A": ["Qh", "2c"], "B": ["3d", "4s", "9c"], "C": ["5d", "8s"]})
gs.apply_move("A", {"type": "play"}, now=1.0)   # Q on K = within one -> Freaky Tiki
assert gs.phase == "freaky" and gs.freaky_player == "A"
gs.apply_move("B", {"type": "shed"}, now=1.1)
gs.apply_move("B", {"type": "shed"}, now=1.2)
gs.apply_move("C", {"type": "shed"}, now=1.3)
expect_error(lambda: gs.apply_move("B", {"type": "freaky"}, now=1.4), "no Freaky Tiki")
gs.apply_move("A", {"type": "freaky"}, now=2.0)
assert names(gs.playing["A"]) == ["3_of_diamonds", "4_of_spades", "5_of_diamonds", "2_of_clubs"]
assert gs.players[gs.turn] == "A" and gs.phase == "open" and gs.middle[-1].name == "Q_of_hearts"
gs = rich(P3, middle=["Ks"], turn="A", last=0.0,
          playing={"A": ["Qh", "2c"], "B": ["3d", "9c"]})
gs.apply_move("A", {"type": "play"}, now=1.0)
gs.apply_move("B", {"type": "shed"}, now=2.0)
gs.tick(10.9); assert gs.phase == "freaky"
gs.tick(11.0)   # 10s after the trigger: auto-resolves like a call
assert gs.phase == "open" and names(gs.playing["A"])[0] == "3_of_diamonds"
print("T6 Freaky Tiki call + timeout: PASS")

# --- T7: Jokers - slap press counts, stacking-Joker placer needs 5, recipient starts (R5c, R6, R7) ---
gs = rich(P3, middle=["4s"], turn="A", last=0.0, playing={"A": ["joker_red", "8c"]})
gs.apply_move("A", {"type": "play"}, now=1.0)
assert gs.phase == "joker" and gs.joker_placer == "A"
gs.apply_move("B", {"type": "slap_press"}, now=1.1)
assert gs.phase == "joker"   # one press is not a slap
gs.apply_move("B", {"type": "slap_press"}, now=1.2)
assert gs.phase == "joker_choose" and gs.slap_winner == "B"
expect_error(lambda: gs.apply_move("A", {"type": "slap_choose", "target": "C"}, now=1.3), "only the slap winner")
before = names(gs.playing["C"])
gs.apply_move("B", {"type": "slap_choose", "target": "C"}, now=1.4)
assert gs.middle == [] and gs.players[gs.turn] == "C" and gs.phase == "open"
assert names(gs.playing["C"])[:len(before)] == before
assert set(names(gs.playing["C"])[len(before):]) == {"4_of_spades", "joker_red"}
gs = rich(P3, middle=["9s"], turn="A", last=0.0,
          playing={"B": ["3c", "6d"]}, stacking={"B": ["joker_black", "4h"]})
expect_error(lambda: gs.apply_move("A", {"type": "stack", "owner": "B", "slot": 0}, now=1.0), "only the owner")
gs.apply_move("B", {"type": "stack", "owner": "B", "slot": 0}, now=1.0)
assert gs.phase == "joker" and gs.joker_from_stacking
for i in range(4):
    gs.apply_move("B", {"type": "slap_press"}, now=1.1 + i * 0.01)
assert gs.phase == "joker"   # placer needs 5 presses (3 = lifting their hand)
gs.apply_move("C", {"type": "slap_press"}, now=1.2)
gs.apply_move("C", {"type": "slap_press"}, now=1.21)
assert gs.slap_winner == "C"   # everyone else needs only 2
gs.apply_move("C", {"type": "slap_choose", "target": "B"}, now=1.22)
gs.tick(1.3)   # the Joker's slot is replaced from B's hand (top card first - giveaway went to the bottom)
assert gs.stacking["B"][0].name == "3_of_clubs" and gs.players[gs.turn] == "B"
print("T7 Joker slaps: PASS")

# --- T8: finishing, ranking, game end thresholds; win by stacking (R8) ---
gs = rich(P3, middle=["9s"], turn="A", last=0.0,
          playing={"A": ["2c"]}, stacking={"A": [None, None]})
gs.apply_move("A", {"type": "play"}, now=1.0)
assert gs.finished == ["A"] and gs.phase == "over" and gs.losers == ["B", "C"]   # 3p game ends at 2 left
P4 = ["A", "B", "C", "D"]
gs = rich(P4, middle=["9s"], turn="A", last=0.0,
          playing={"A": ["2c"]}, stacking={"A": [None, None]})
gs.apply_move("A", {"type": "play"}, now=1.0)
assert gs.finished == ["A"] and gs.phase == "open" and gs.players[gs.turn] == "B"  # 4p game continues
gs = rich(P4, middle=["10s"], turn="B", last=0.0,
          playing={"A": []}, stacking={"A": ["9h", None]})
gs.apply_move("A", {"type": "stack", "owner": "A", "slot": 0}, now=1.0)
assert "A" in gs.finished and gs.phase == "stacked"   # non-Joker last card wins immediately
gs.tick(3.1)   # stack window expires; A has no playing cards so open play resumes on B
assert gs.phase == "open"
print("T8 finishing + game end + win by stacking: PASS")

# --- T9: equal-rank and wrap stacks are legal (R1) ---
gs = rich(P3, middle=["10s"], turn="A", last=0.0, stacking={"B": ["10h", "4s"]})
gs.apply_move("B", {"type": "stack", "owner": "B", "slot": 0}, now=1.0)
assert gs.middle[-1].name == "10_of_hearts"
gs = rich(P3, middle=["Ks"], turn="A", last=0.0, stacking={"B": ["Ah", "4s"]})
gs.apply_move("C", {"type": "stack", "owner": "B", "slot": 0}, now=1.0)
assert gs.middle[-1].name == "A_of_hearts"   # C stacked B's Ace onto the King (wrap)
print("T9 equal + wrap stacking: PASS")

# --- T11: being given the middle refills empty stacking slots (Noah, 2026-11-13) ---
# C has one stacking card and an empty slot, and no playing cards. B wins a
# slap and gives C the middle: C must top the empty slot back up from the
# cards just received.
gs = rich(P3, middle=["4s"], turn="A", last=0.0,
          playing={"A": ["joker_red", "8c"], "C": []},
          stacking={"C": ["9c", None]})
gs.apply_move("A", {"type": "play"}, now=1.0)
gs.apply_move("B", {"type": "slap_press"}, now=1.1)
gs.apply_move("B", {"type": "slap_press"}, now=1.2)
gs.apply_move("B", {"type": "slap_choose", "target": "C"}, now=1.3)
assert gs.stacking["C"][0].name == "9_of_clubs" and gs.stacking["C"][1] is not None
assert len(gs.playing["C"]) == 1   # received 2 cards (4s + joker), 1 went up to the slot
assert len(gs.stacking["C"]) == 2  # the slot COUNT never grows - still a 2-slot game
print("T11 given-the-middle refills stacking slots: PASS")

# --- T12: stacking with no playing cards skips that player automatically ---
gs = rich(P4, middle=["10s"], turn="B", last=0.0,
          playing={"A": []}, stacking={"A": ["9h", "2c"]})
gs.apply_move("A", {"type": "stack", "owner": "A", "slot": 0}, now=1.0)
assert gs.stackers == [] and gs.phase == "stacked"
gs.tick(3.1)
assert gs.phase == "open" and gs.players[gs.turn] == "B"
print("T12 empty-hand stacker skipped automatically: PASS")

# --- T13: stacks can occur during a Freaky Tiki without ending it early ---
gs = rich(P3, middle=["Ks"], turn="A", last=0.0,
          playing={"A": ["Qh", "2c"], "B": ["3d", "4s"], "C": ["5d", "8s"]},
          stacking={"A": ["4c", "5d"], "B": ["Jc", "6h"], "C": ["9h", "6s"]})
gs.apply_move("A", {"type": "play"}, now=1.0)   # Q on K -> Freaky Tiki
assert gs.phase == "freaky"
gs.apply_move("B", {"type": "shed"}, now=1.1)
gs.apply_move("C", {"type": "stack", "owner": "B", "slot": 0}, now=1.2)  # J onto Q during Freaky Tiki
assert gs.phase == "freaky" and gs.middle[-1].name == "J_of_clubs"
gs.tick(1.5)
assert gs.stacking["B"][0].name == "5_of_diamonds"   # C replaced B's slot
gs.apply_move("A", {"type": "freaky"}, now=2.0)
assert gs.phase == "open" and names(gs.playing["A"]) == ["3_of_diamonds", "2_of_clubs"]
print("T13 stacking during Freaky Tiki: PASS")

print("ALL RULES TESTS PASSED")
