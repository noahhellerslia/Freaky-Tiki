"""Unit tests for Freaky Tiki SETUP only (turn mechanics await Noah's answers
to RULES_SPEC.md Q1-Q10). Run: python3 test_setup.py  (from this folder)"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "game"))
from game_logic import Card, GameState, full_deck, within_one

atlas = json.loads((Path(__file__).resolve().parent.parent / "assets" / "atlas.json").read_text())["frames"]

# 54-card deck, both jokers, every name exists in the art atlas
deck = full_deck()
assert len(deck) == 54 and len({c.name for c in deck}) == 54
assert {c.name for c in deck if c.is_joker} == {"joker_red", "joker_black"}
assert all(c.name in atlas for c in deck), "deck/atlas name mismatch"
print("Deck: PASS (54 unique cards incl. both jokers, all names match atlas)")

def strings(x):
    if isinstance(x, str): yield x
    elif isinstance(x, dict):
        for v in x.values(): yield from strings(v)
    elif isinstance(x, list):
        for v in x: yield from strings(v)

for n in range(2, 9):
    players = [f"P{i}" for i in range(n)]
    gs = GameState.start(players, seed=42)
    totals = {p: len(gs.playing[p]) + sum(1 for c in gs.stacking[p] if c) for p in players}
    assert sum(totals.values()) == 54, (n, totals)
    assert max(totals.values()) - min(totals.values()) <= 1, (n, totals)   # split evenly
    slots = 1 if n >= 5 else 2
    assert all(len(gs.stacking[p]) == slots for p in players), n
    all_cards = [c.name for p in players for c in gs.playing[p]] + \
                [c.name for p in players for c in gs.stacking[p] if c]
    assert len(all_cards) == 54 and len(set(all_cards)) == 54, n           # nothing lost/duplicated
    # Secrecy: a player's view must contain NONE of ANYONE's playing-hand cards
    view = gs.public_view_for(players[0])
    seen = set(strings(view))
    assert not ({c.name for p in players for c in gs.playing[p]} & seen), n
    # ...while every stacking card IS in the view (they're face up, public)
    assert {c.name for p in players for c in gs.stacking[p] if c} <= seen, n
    print(f"Setup {n} players: PASS (totals {sorted(totals.values())}, {slots} stacking slot(s), hands blind, stacking public)")

# Adjacency helper (Ace wraps; jokers have no value)
C = Card
assert within_one(C("10", "spades"), C("J", "hearts"))
assert within_one(C("10", "spades"), C("9", "hearts"))
assert within_one(C("A", "spades"), C("K", "hearts"))
assert within_one(C("A", "spades"), C("2", "hearts"))
assert not within_one(C("5", "spades"), C("3", "hearts"))
assert not within_one(C("joker_red"), C("K", "hearts"))
print("Adjacency: PASS (10-J, 10-9, A-K wrap, A-2; 5-3 and jokers excluded)")
print("ALL SETUP TESTS PASSED")
