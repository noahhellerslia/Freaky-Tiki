"""Game-end rules, exactly as Noah specified them (R8 + his original rules):
- A player finishes at ZERO cards total (playing + stacking), ranked in
  finish order, and is then out: cannot act, cannot be given cards.
- The game ends when only 2 players still hold cards - or only 3 if the
  game started with 6+ players. The players left are the losers.
- finished[0] is the winner (the server makes them start the next game).

Run: python3 tests/test_endgame.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "game"))
from game_logic import GameState, Card   # noqa: E402

C = Card
FILLER = [C("3", "clubs"), C("4", "clubs"), C("5", "clubs")]

def rig(players, finisher):
    """A game where `finisher` holds exactly one stacking card (a 9) over a
    middle topped by a 10; everyone else holds filler cards."""
    gs = GameState.start(players, seed=3, now=0.0)
    for p in players:
        gs.playing[p] = list(FILLER)
        gs.stacking[p] = [C("7", "clubs"), C("8", "clubs")]
    gs.playing[finisher] = []
    gs.stacking[finisher] = [C("9", "hearts"), None]
    gs.middle = [C("10", "spades")]
    gs.phase, gs.finished, gs.losers, gs.pending = "open", [], [], {}
    return gs

def finish_by_stack(gs, who, t):
    """`who` stacks their last non-Joker card and finishes immediately."""
    gs.apply_move(who, {"type": "stack", "owner": who, "slot": 0}, now=t)
    gs.tick(t + 0.3)
    assert who in gs.finished, f"{who} should finish immediately on non-Joker stack: {gs.finished}"

def E1_four_players_end_at_two_left():
    gs = rig(["A", "B", "C", "D"], "A")
    finish_by_stack(gs, "A", 10.0)
    assert gs.phase != "over" and gs.finished == ["A"], gs.finished
    gs.middle = [C("10", "spades")]
    gs.playing["B"] = []
    gs.stacking["B"] = [C("9", "diamonds"), None]
    finish_by_stack(gs, "B", 20.0)
    assert gs.phase == "over", gs.phase
    assert gs.finished == ["A", "B"], gs.finished          # finish order = ranking
    assert sorted(gs.losers) == ["C", "D"], gs.losers       # the 2 left are the losers
    assert gs.finished[0] == "A"                            # winner starts next game

def E2_six_players_end_at_three_left():
    ps = ["A", "B", "C", "D", "E", "F"]
    gs = rig(ps, "A")
    finish_by_stack(gs, "A", 10.0)
    assert gs.phase != "over"
    gs.middle = [C("10", "spades")]
    gs.playing["B"] = []; gs.stacking["B"] = [C("9", "diamonds"), None]
    finish_by_stack(gs, "B", 20.0)
    assert gs.phase != "over", "6-player game must NOT end with 4 still holding cards"
    gs.middle = [C("9", "spades")]
    gs.playing["C"] = []; gs.stacking["C"] = [C("10", "clubs"), None]   # within one of the 9 now on top
    finish_by_stack(gs, "C", 30.0)
    assert gs.phase == "over", "6-player game ends when 3 are left"
    assert gs.finished == ["A", "B", "C"] and sorted(gs.losers) == ["D", "E", "F"]

def E3_two_players_first_finish_ends_it():
    gs = rig(["A", "B"], "A")
    finish_by_stack(gs, "A", 10.0)
    assert gs.phase == "over" and gs.finished == ["A"] and gs.losers == ["B"]

def E4_finished_players_are_out():
    gs = rig(["A", "B", "C", "D"], "A")
    finish_by_stack(gs, "A", 10.0)
    # cannot act
    try:
        gs.apply_move("A", {"type": "play"}, now=11.0); raise SystemExit("A acted!")
    except ValueError:
        pass
    # cannot be given the middle stack via a slap choice
    gs.phase, gs.slap_winner = "joker_choose", "B"
    try:
        gs.apply_move("B", {"type": "slap_choose", "target": "A"}, now=11.5)
        raise SystemExit("A was given cards!")
    except ValueError:
        pass
    # and their (empty) stacking slots can't be stacked by anyone
    gs.phase = "open"
    try:
        gs.apply_move("B", {"type": "stack", "owner": "A", "slot": 0}, now=12.0)
        raise SystemExit("A's empty slot was stacked!")
    except ValueError:
        pass

def E5_finish_by_ordinary_play():
    gs = rig(["A", "B", "C"], "A")
    gs.playing["A"] = [C("5", "hearts")]        # not within one of the 10, not a joker
    gs.stacking["A"] = [None, None]
    gs.turn = gs.players.index("A")
    gs.last_placement_at = 0.0
    gs.apply_move("A", {"type": "play"}, now=10.0)
    assert gs.finished == ["A"], gs.finished
    assert gs.phase == "over"        # 3-player game: 2 left = game over
    assert sorted(gs.losers) == ["B", "C"]

def standstill_game():
    """4 players: D already finished. A, B, C hold ONLY stacking cards, none
    within one of the King on top of the middle; all playing hands empty."""
    gs = GameState.start(["A", "B", "C", "D"], seed=3, now=0.0)
    for p in ["A", "B", "C"]:
        gs.playing[p] = []
    gs.stacking["A"] = [C("5", "clubs"), None]
    gs.stacking["B"] = [C("8", "diamonds"), None]
    gs.stacking["C"] = [C("3", "spades"), None]
    gs.playing["D"] = []
    gs.stacking["D"] = [None, None]
    gs.middle = [C("7", "hearts"), C("K", "hearts")]
    gs.phase, gs.pending = "open", {}
    gs.finished, gs.losers = ["D"], []
    gs.turn = None
    return gs

def E6_standstill_ends_game():
    gs = standstill_game()
    assert gs.tick(100.0) is True
    assert gs.phase == "over", gs.phase
    assert gs.finished == ["D"]                       # standings as they are
    assert sorted(gs.losers) == ["A", "B", "C"]       # the players left lose

def E7_not_standstill_when_a_move_exists():
    # (a) a stacking card within one of the top card (Q on K) -> game lives
    gs = standstill_game(); gs.stacking["B"] = [C("Q", "diamonds"), None]
    gs.tick(100.0); assert gs.phase != "over"
    # (b) a stacking-hand Joker (owner may always play it) -> game lives
    gs = standstill_game(); gs.stacking["B"] = [C("joker_red"), None]
    gs.tick(100.0); assert gs.phase != "over"
    # (c) anyone still holding a playing card -> game lives
    gs = standstill_game(); gs.playing["A"] = [C("2", "clubs")]
    gs.tick(100.0); assert gs.phase != "over"
    # (d) empty middle -> not a standstill (the penalty path unsticks it)
    gs = standstill_game(); gs.middle = []
    gs.tick(100.0); assert gs.phase != "over"

def E8_end_on_joker_can_slap_and_receive():
    # Ending on a Joker keeps the placer in the game to slap and be targeted.
    gs = rig(["A", "B", "C"], "A")
    gs.playing["A"] = [C("joker_red")]
    gs.stacking["A"] = [None, None]
    gs.turn = gs.players.index("A")
    gs.last_placement_at = 0.0
    gs.apply_move("A", {"type": "play"}, now=10.0)
    assert gs.phase == "joker" and "A" not in gs.finished
    assert "A" in gs.public_view_for("B", now=10.0)["joker"]["targets"]
    # A can slap!
    gs.apply_move("A", {"type": "slap_press"}, now=10.1)
    assert gs.presses["A"] == 1
    # If B slaps first and gives the stack to A, A receives it and stays in the game.
    gs.apply_move("B", {"type": "slap_press"}, now=10.2)
    gs.apply_move("B", {"type": "slap_press"}, now=10.3)
    assert gs.slap_winner == "B"
    gs.apply_move("B", {"type": "slap_choose", "target": "A"}, now=10.4)
    assert "A" not in gs.finished and gs.total("A") >= 2

def E9_end_on_joker_wins_when_given_away():
    gs = rig(["A", "B", "C"], "A")
    gs.playing["A"] = [C("joker_red")]
    gs.stacking["A"] = [None, None]
    gs.turn = gs.players.index("A")
    gs.last_placement_at = 0.0
    gs.apply_move("A", {"type": "play"}, now=10.0)
    gs.apply_move("A", {"type": "slap_press"}, now=10.1)
    gs.apply_move("A", {"type": "slap_press"}, now=10.2)
    assert "A" in gs.finished and gs.phase == "over"

def main():
    for name, fn in [("E1", E1_four_players_end_at_two_left),
                     ("E2", E2_six_players_end_at_three_left),
                     ("E3", E3_two_players_first_finish_ends_it),
                     ("E4", E4_finished_players_are_out),
                     ("E5", E5_finish_by_ordinary_play),
                     ("E6", E6_standstill_ends_game),
                     ("E7", E7_not_standstill_when_a_move_exists),
                     ("E8", E8_end_on_joker_can_slap_and_receive),
                     ("E9", E9_end_on_joker_wins_when_given_away)]:
        fn()
        print(f"  {name} ok")
    print("test_endgame: ALL PASSED")

if __name__ == "__main__":
    main()
