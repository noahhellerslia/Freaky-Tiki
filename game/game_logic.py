"""Freaky Tiki - pure-Python rules engine. No I/O: the server runs it
authoritatively. All timing is explicit: every method takes `now` in seconds
(any monotonic clock), and tick(now) processes time-driven events, so the
whole game is deterministically testable with a fake clock.

Rules: docs/RULES_SPEC.md (incl. Noah's resolved answers R1-R10).
Terminology:
  playing hand  - face-down pile; NOBODY sees it, owner included. List, TOP = [0].
  stacking hand - face-up slots (2, or 1 with 5+ players). Public. None = empty slot.
  middle stack  - shared pile. List, TOP = last element.
Timing (seconds): PACE 0.25 - gap before the next ordinary play, and the
  replacement delay. GRACE 0.5 - mistake grace period. STACK_TURN_DELAY 2.0 -
  quiet after the last stack before a stacker may start the next turn.
  FREAKY_TIMEOUT 10.0 - a Freaky Tiki auto-resolves as if called.
"""
from dataclasses import dataclass, field
import random

SUITS = ["spades", "hearts", "diamonds", "clubs"]
RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
RANK_VALUE = {r: i + 1 for i, r in enumerate(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"])}

PACE, GRACE, STACK_TURN_DELAY, FREAKY_TIMEOUT, JOKER_CHOOSE_TIMEOUT, STANDSTILL_TIMEOUT = 0.65, 0.85, 2.0, 10.0, 10.0, 10.0
SLAP_PRESSES, SLAP_PRESSES_STACKING_PLACER = 2, 5

@dataclass(frozen=True)
class Card:
    rank: str                      # "A".."K", or "joker_red" / "joker_black"
    suit: str = ""                 # "" only for jokers
    @property
    def is_joker(self) -> bool:
        return self.suit == ""
    @property
    def name(self) -> str:         # == atlas / file name, minus .png
        return self.rank if self.is_joker else f"{self.rank}_of_{self.suit}"
    def __str__(self) -> str:
        return self.name

def full_deck() -> list[Card]:
    """Freaky Tiki always uses 54 cards: the standard 52 + both jokers."""
    return [Card(r, s) for s in SUITS for r in RANKS] + [Card("joker_red"), Card("joker_black")]

def within_one(a: Card, b: Card) -> bool:
    """Within one point value on the 13-rank cycle, equal ranks included,
    Ace wraps to King (R1). Jokers have no point value."""
    if a.is_joker or b.is_joker:
        return False
    d = abs(RANK_VALUE[a.rank] - RANK_VALUE[b.rank]) % 13
    return d <= 1 or d == 12

def stacking_slots_for(player_count: int) -> int:
    return 1 if player_count >= 5 else 2

@dataclass
class GameState:
    players: list[str]                                   # seating = clockwise
    playing: dict[str, list[Card]] = field(default_factory=dict)
    stacking: dict[str, list] = field(default_factory=dict)          # Card | None per slot
    middle: list[Card] = field(default_factory=list)
    turn: int | None = None                              # index into players
    finished: list[str] = field(default_factory=list)    # finishing order = ranking
    pending_finish: list[str] = field(default_factory=list)  # stackers at 0 cards waiting for next play/stack
    losers: list[str] = field(default_factory=list)      # set when the game ends
    disconnected: set[str] = field(default_factory=set)
    dropped: list[str] = field(default_factory=list)
    phase: str = "open"      # open | stacked | stacker_start | freaky | joker | joker_choose | over
    started_at: float = 0.0
    last_placement_at: float | None = None
    stackers: list[str] = field(default_factory=list)
    last_stack_at: float | None = None
    pending: dict = field(default_factory=dict)          # stacker -> {"slots": [(owner, slot)], "due": float}
    freaky_player: str | None = None
    freaky_deadline: float | None = None
    shed_pool: list = field(default_factory=list)        # [(player, Card)] in received order
    joker_placer: str | None = None
    joker_from_stacking: bool = False
    presses: dict = field(default_factory=dict)          # player -> slap press count
    slap_winner: str | None = None
    joker_deadline: float | None = None
    last_joker_target: str | None = None
    joker_target_streak: int = 0
    standstill_deadline: float | None = None
    fast_bots: bool = False
    last_miss: dict | None = None
    miss_seq: int = 0
    last_stack: dict | None = None
    stack_seq: int = 0
    last_drop: dict | None = None
    drop_seq: int = 0
    _rng: random.Random = field(default_factory=lambda: random.Random(0), repr=False)

    # ------------------------------------------------------------------ setup
    @classmethod
    def start(cls, players: list[str], seed: int | None = None,
              starter: str | None = None, now: float = 0.0) -> "GameState":
        if not 2 <= len(players) <= 8:
            raise ValueError("Freaky Tiki needs 2-8 players")
        rng = random.Random(seed)
        deck = full_deck()
        rng.shuffle(deck)
        playing: dict[str, list[Card]] = {p: [] for p in players}
        for i, card in enumerate(deck):                  # one at a time, in seating order
            playing[players[i % len(players)]].append(card)
        stacking: dict[str, list] = {}
        for p in players:
            n = stacking_slots_for(len(players))
            stacking[p] = [playing[p].pop(0) for _ in range(n)]   # top cards, flipped face up
        turn = players.index(starter) if starter in players else rng.randrange(len(players))
        gs = cls(players=list(players), playing=playing, stacking=stacking,
                 turn=turn, started_at=now, _rng=rng)
        return gs

    # -------------------------------------------------------------- utilities
    @property
    def initial_count(self) -> int:
        return len(self.players)
    def is_active(self, p: str) -> bool:
        return p not in self.finished and p not in self.dropped
    def active_players(self) -> list[str]:
        return [p for p in self.players if self.is_active(p)]
    def total(self, p: str) -> int:
        return len(self.playing[p]) + sum(1 for c in self.stacking[p] if c is not None)
    def _ref_time(self) -> float:
        return self.last_placement_at if self.last_placement_at is not None else self.started_at
    def _end_threshold(self) -> int:
        return 3 if self.initial_count >= 6 else 2

    def _is_standstill(self) -> bool:
        """R11 (Noah, 2026-11-13): if nobody can legally move, the game ends
        there - the players still holding cards are the losers, standings as
        they are. 'Stuck' means: every active player's playing hand is empty,
        no replacement is pending, the middle is non-empty, and no face-up
        stacking card can legally be played (none within one of the middle
        top, and no stacking-hand Joker, which its owner may always play).
        An empty middle does NOT count: stacking into it routes the card to
        the stacker's own playing hand via the penalty path, which unsticks
        the game by itself."""
        if self.pending or not self.middle:
            return False
        act = self.active_players()
        if any(self.playing[p] for p in act):
            return False
        top = self.middle[-1]
        if top.is_joker:
            return False   # unreachable in open play; defensive
        for p in act:
            for c in self.stacking[p]:
                if c is None:
                    continue
                if c.is_joker or within_one(c, top):
                    return False
        return True

    def _check_finishes(self, defer: set[str] | None = None) -> None:
        """Players at zero total finish, in seating order - EXCEPT while a Joker
        is being resolved, while a slot is awaiting its delayed replacement (R4),
        or when a stacker just stacked their last card (deferred until someone
        else plays or stacks another card)."""
        if self.phase in ("joker", "joker_choose"):
            return
        self.pending_finish = [p for p in self.pending_finish
                               if self.is_active(p) and self.total(p) == 0]
        pending_owners = {owner for batch in self.pending.values() for owner, _ in batch["slots"]}
        for p in self.active_players():
            if p in pending_owners or p in self.pending_finish:
                continue
            if self.total(p) == 0:
                if defer and p in defer:
                    self.pending_finish.append(p)
                else:
                    self.finished.append(p)
                    if len(self.active_players()) <= self._end_threshold():
                        self.phase = "over"
                        self.losers = self.active_players()
                        return

    def _finalize_pending_finishes(self, actor: str | None = None) -> None:
        """Finalize players who stacked their last card once someone else plays
        or stacks another card (or when the Joker/standstill resolves)."""
        self.pending_finish = [p for p in self.pending_finish
                               if self.is_active(p) and self.total(p) == 0]
        pending_owners = {owner for batch in self.pending.values() for owner, _ in batch["slots"]}
        for p in list(self.pending_finish):
            if (actor is not None and p == actor) or p in pending_owners:
                continue
            self.pending_finish.remove(p)
            self.finished.append(p)
            if len(self.active_players()) <= self._end_threshold():
                self.phase = "over"
                self.losers = self.active_players()
                return

    def _next_with_cards(self, after_idx: int) -> int | None:
        n = len(self.players)
        for step in range(1, n + 1):
            i = (after_idx + step) % n
            p = self.players[i]
            if self.is_active(p) and p not in self.disconnected and self.playing[p]:
                return i
        return None

    def _settle_stacker_start(self) -> bool:
        """Keep only stackers who can still start (active, connected, holding
        playing cards). If none can, the stacker-start window collapses back
        to open play instead of stalling the game forever."""
        eligible = [s for s in self.stackers
                    if self.is_active(s) and s not in self.disconnected and self.playing[s]]
        if not eligible:
            self.stackers, self.phase = [], "open"
            return True
        changed = eligible != self.stackers or self.phase != "stacker_start"
        self.stackers, self.phase = eligible, "stacker_start"
        return changed

    def _fix_turn(self) -> bool:
        """In open play the turn must sit with someone who can actually play
        an ordinary card (active, connected, has playing cards); skip anyone who can't."""
        if self.phase != "open":
            return False
        if self.turn is None:
            nxt = self._next_with_cards(-1)
            if nxt is not None:
                self.turn = nxt
                return True
            return False
        p = self.players[self.turn]
        if self.is_active(p) and p not in self.disconnected and self.playing[p]:
            return False
        self.turn = self._next_with_cards(self.turn)
        return True

    def set_disconnected(self, player: str, is_disconnected: bool) -> bool:
        """Mark a player disconnected (skipping their turn) or reconnected."""
        if player not in self.players or player in self.dropped or self.phase == "over":
            return False
        if is_disconnected:
            if player in self.disconnected:
                return False
            self.disconnected.add(player)
            if self.phase == "stacker_start":
                self._settle_stacker_start()
            self._fix_turn()
            return True
        if player not in self.disconnected:
            return False
        self.disconnected.discard(player)
        self._fix_turn()
        return True

    def drop_player(self, player: str, now: float = 0.0) -> bool:
        """Drop a player from the game after disconnect timeout.
        Their remaining cards are shuffled onto the bottom of the middle stack."""
        if player not in self.players or player in self.dropped or self.phase == "over":
            return False
        self.disconnected.discard(player)
        self.dropped.append(player)
        dropped_cards = list(self.playing[player]) + [c for c in self.stacking[player] if c is not None]
        self.playing[player] = []
        self.stacking[player] = [None] * len(self.stacking[player])
        if dropped_cards:
            self._rng.shuffle(dropped_cards)
            self.middle = dropped_cards + self.middle
        self.drop_seq += 1
        self.last_drop = {"seq": self.drop_seq, "player": player, "cards": len(dropped_cards)}
        self.pending.pop(player, None)
        for stacker in list(self.pending.keys()):
            batch = self.pending[stacker]
            batch["slots"] = [(o, s) for (o, s) in batch["slots"] if o != player]
            if not batch["slots"]:
                self.pending.pop(stacker, None)
        if player in self.pending_finish:
            self.pending_finish.remove(player)
        if player in self.stackers:
            self.stackers.remove(player)
        if self.phase == "freaky" and self.freaky_player == player:
            self.shed_pool = []
            self.freaky_player = None
            self.freaky_deadline = None
            self.phase = "open"
        if self.phase == "joker_choose" and self.slap_winner == player:
            self.joker_placer = None
            self.presses = {}
            self.slap_winner = None
            self.last_slapper = None
            self.joker_from_stacking = False
            self.joker_deadline = None
            self.phase = "open"
        if self.phase == "stacker_start":
            self._settle_stacker_start()
        active = self.active_players()
        if len(active) <= 1:
            if len(active) == 1 and active[0] not in self.finished:
                self.finished.append(active[0])
            self.phase = "over"
            self.losers = []
            return True
        if len(active) <= self._end_threshold() and self.finished:
            self.phase = "over"
            self.losers = active
            return True
        self._fix_turn()
        return True

    def _pickup_middle(self, receiver: str, now: float) -> None:
        """Universal pickup (R5a/R5c + R7): middle shuffled onto the BOTTOM
        of the receiver's playing hand, and the receiver starts the next turn."""
        cards = self.middle
        self.middle = []
        self._rng.shuffle(cards)
        self.playing[receiver].extend(cards)             # bottom = end of list
        self.stackers, self.last_stack_at = [], None
        self.phase = "open"
        self.last_placement_at = now
        self.turn = self.players.index(receiver)
        self._fix_turn()
        self._refill_stacking(receiver)

    def _refill_stacking(self, player: str) -> None:
        """Noah's rule (2026-11-13): a player who is given the middle stack
        must top their stacking hand back up - any slot left empty (e.g. its
        card was stacked while they had no playing cards to replace it with,
        or the fallback could not cover it) is refilled from the top of
        their playing hand, up to the game's normal slot count (the slots
        list itself never grows: 2 slots, or 1 with 5+ players)."""
        slots = self.stacking[player]
        for i, c in enumerate(slots):
            if c is None and self.playing[player]:
                slots[i] = self.playing[player].pop(0)

    def _pace(self) -> float:
        return 0.08 if self.fast_bots else PACE

    def _grace(self) -> float:
        return 0.15 if self.fast_bots else GRACE

    def _stack_delay(self) -> float:
        return 0.25 if self.fast_bots else STACK_TURN_DELAY

    def _freaky_timeout(self) -> float:
        return 1.5 if self.fast_bots else FREAKY_TIMEOUT

    def _joker_timeout(self) -> float:
        return 1.5 if self.fast_bots else JOKER_CHOOSE_TIMEOUT

    def _standstill_timeout(self) -> float:
        return 1.5 if self.fast_bots else STANDSTILL_TIMEOUT

    def _schedule_replacement(self, stacker: str, owner: str, slot: int, now: float) -> None:
        due = now + self._pace()
        batch = self.pending.setdefault(stacker, {"slots": [], "due": due})
        batch["slots"].append((owner, slot))
        batch["due"] = due

    # -------------------------------------------------------------------- tick
    def tick(self, now: float) -> bool:
        """Process everything time-driven. Returns True if anything changed."""
        if self.phase == "over":
            return False
        changed = False
        # delayed, batched replacements (R4)
        resolved_stackers: set[str] = set()
        for stacker in [s for s, b in self.pending.items() if now >= b["due"]]:
            resolved_stackers.add(stacker)
            batch = self.pending.pop(stacker)
            for owner, slot in batch["slots"]:
                if self.stacking[owner][slot] is not None:
                    continue
                if self.playing[stacker]:
                    self.stacking[owner][slot] = self.playing[stacker].pop(0)
                elif owner != stacker and self.playing[owner]:
                    # stacker has none: the player taken from replaces their own (Noah's default)
                    self.stacking[owner][slot] = self.playing[owner].pop(0)
                # else: nobody can replace it - the slot stays empty
            changed = True
        if changed:
            self._check_finishes()
            if self.phase == "over":
                return True
        # stack window expiry -> stackers may start the next turn (R2)
        if self.phase == "stacked" and self.last_stack_at is not None \
                and now - self.last_stack_at >= self._stack_delay():
            self._settle_stacker_start()
            changed = True
        if self.phase == "stacker_start":
            # the eligible stackers may have changed (e.g. one of them finished)
            if self._settle_stacker_start():
                changed = True
        # Freaky Tiki timeout -> auto-resolves as if called (R9/A2)
        if self.phase == "freaky" and self.freaky_deadline is not None and now >= self.freaky_deadline:
            self._resolve_freaky(now)
            changed = True
        # Joker choose timeout -> give the stack to a random active player
        if self.phase == "joker_choose" and self.joker_deadline is not None and now >= self.joker_deadline:
            targets = self._valid_joker_targets()
            if targets:
                target = self._rng.choice(targets)
                self._slap_choose(self.slap_winner, {"target": target}, now)
            else:
                self.joker_placer, self.presses, self.slap_winner, self.last_slapper = None, {}, None, None
                self.joker_from_stacking = False
                self.joker_deadline = None
                self.phase = "open"
            changed = True
        if self._fix_turn():
            changed = True
        # R11 standstill: when no legal move exists for anyone, start a
        # countdown timer; when it expires, everyone still holding cards loses.
        if self.phase == "open" and self._is_standstill():
            if self.standstill_deadline is None:
                self.standstill_deadline = now + self._standstill_timeout()
                changed = True
            elif now >= self.standstill_deadline:
                self.standstill_deadline = None
                self._finalize_pending_finishes(actor=None)
                if self.phase == "over":
                    return True
                self.phase = "over"
                self.losers = self.active_players()
                changed = True
        elif self.standstill_deadline is not None:
            self.standstill_deadline = None
            changed = True
        return changed

    # ------------------------------------------------------------------- moves
    def apply_move(self, player: str, move: dict, now: float = 0.0) -> None:
        """Raises ValueError with a player-readable reason for any disallowed
        move. Penalty moves are NOT errors: they are applied and broadcast."""
        self.tick(now)
        if self.phase == "over":
            raise ValueError("the game is over")
        if player not in self.players:
            raise ValueError("you are not in this game")
        if not self.is_active(player):
            raise ValueError("you are out of the game")
        kind = (move or {}).get("type")
        if kind == "play":
            self._play(player, now)
        elif kind == "stack":
            self._stack(player, move, now)
        elif kind == "shed":
            self._shed(player)
        elif kind == "freaky":
            if self.phase != "freaky" or player != self.freaky_player:
                raise ValueError("no Freaky Tiki waiting for your call")
            self._resolve_freaky(now)
        elif kind == "slap_press":
            self._slap_press(player, now)
        elif kind == "slap_choose":
            self._slap_choose(player, move, now)
        else:
            raise ValueError(f"unknown move type: {kind!r}")

    def _play(self, player: str, now: float) -> None:
        if self.phase in ("freaky", "joker", "joker_choose"):
            raise ValueError("the game is paused while that card is resolved")
        if self.phase == "stacked":
            if player not in self.stackers:
                raise ValueError("only a player who stacked can start the next turn")
            raise ValueError("wait for play cooldown")
        if not self.playing[player]:
            raise ValueError("you have no playing-hand cards")
        if self.phase == "stacker_start":
            if player not in self.stackers:
                # R2 special case: simply not allowed, never a penalty
                raise ValueError("only a player who stacked can start the next turn")
            self._do_play(player, now)
            return
        # open phase
        if self.turn is not None and self.players[self.turn] != player:
            raise ValueError("it is not your turn")
        if self.last_placement_at is not None and now - self.last_placement_at < self._pace():
            raise ValueError("wait for play cooldown")
        self._do_play(player, now)

    def _do_play(self, player: str, now: float) -> None:
        self._finalize_pending_finishes(actor=player)
        if self.phase == "over":
            return
        prev_top = self.middle[-1] if self.middle else None
        card = self.playing[player].pop(0)
        self.middle.append(card)
        self.last_placement_at = now
        self.stackers, self.last_stack_at = [], None
        self.phase = "open"          # a stacker-start play lands here too; joker/freaky overwrite below
        if card.is_joker:
            self.phase = "joker"
            self.joker_placer, self.joker_from_stacking = player, False
            self.presses, self.slap_winner, self.last_slapper = {}, None, None
            return
        if prev_top is not None and within_one(card, prev_top):
            if self.total(player) == 0:
                # They just finished with this card - the win stands, no
                # Freaky Tiki (there is no hand left to pick sheds up with).
                self._advance_turn(player)
                self._check_finishes()
                return
            self.phase = "freaky"
            self.freaky_player, self.freaky_deadline = player, now + self._freaky_timeout()
            self.shed_pool = []
            self.turn = self.players.index(player)
            return
        self._advance_turn(player)
        self._check_finishes()

    def _advance_turn(self, after_player: str) -> None:
        idx = self.players.index(after_player)
        nxt = self._next_with_cards(idx)
        self.turn = nxt if nxt is not None else idx
        if not self.playing[self.players[self.turn]] and not self._next_with_cards(idx):
            self.turn = None

    def _stack(self, player: str, move: dict, now: float) -> None:
        if self.phase == "joker_choose":
            raise ValueError("the game is paused while that card is resolved")
        owner = move.get("owner")
        if owner not in self.stacking:
            raise ValueError("no such stacking hand")
        slot = move.get("slot")
        if not isinstance(slot, int) or not 0 <= slot < len(self.stacking[owner]):
            raise ValueError("no such stacking slot")
        card = self.stacking[owner][slot]
        if card is None:
            raise ValueError("that stacking slot is empty")
        if self.phase == "joker":
            if card.is_joker:
                raise ValueError("a Joker is already being slapped")
            if now - self._ref_time() < self._grace():
                raise ValueError("incorrect stack, but within the 0.5s grace period - disallowed, no penalty")
            self.miss_seq += 1
            self.last_miss = {
                "seq": self.miss_seq,
                "player": player,
                "card": card.name,
                "target": self.middle[-1].name if self.middle else None,
                "taken": 0,
                "during_joker": True,
            }
            self.stacking[owner][slot] = None
            if self.middle:
                self.middle.insert(-1, card)
            else:
                self.middle.append(card)
            self._schedule_replacement(player, owner, slot, now)
            return
        if card.is_joker:
            if player != owner:
                raise ValueError("only the owner can play a stacking-hand Joker")
            self._finalize_pending_finishes(actor=player)
            if self.phase == "over":
                return
            if self.phase == "freaky":
                self._resolve_freaky(now)
            self.stacking[owner][slot] = None
            self.middle.append(card)
            self.last_placement_at = now
            self.stack_seq += 1
            self.last_stack = {"seq": self.stack_seq, "player": player}
            self._schedule_replacement(player, owner, slot, now)
            self.phase = "joker"
            self.joker_placer, self.joker_from_stacking = player, True
            self.presses, self.slap_winner, self.last_slapper = {}, None, None
            return
        if not self.middle:
            raise ValueError("cannot stack a non-Joker card on an empty table")
        if within_one(card, self.middle[-1]):
            self._finalize_pending_finishes(actor=player)
            if self.phase == "over":
                return
            self.stacking[owner][slot] = None
            self.middle.append(card)
            self.last_placement_at = now
            self.stack_seq += 1
            self.last_stack = {"seq": self.stack_seq, "player": player}
            if self.phase != "freaky":
                self.phase = "stacked"
                if player not in self.stackers and self.playing[player]:
                    self.stackers.append(player)
                self.last_stack_at = now
            if self.playing[player] or (owner != player and self.playing[owner]):
                self._schedule_replacement(player, owner, slot, now)
            self._check_finishes()
            return
        # incorrect stack - timing decides disallow vs penalty (R3)
        if now - self._ref_time() < self._grace():
            raise ValueError("incorrect stack, but within the 0.5s grace period - disallowed, no penalty")
        self._finalize_pending_finishes(actor=player)
        if self.phase == "over":
            return
        if self.phase == "freaky":
            self._resolve_freaky(now)
        target_name = self.middle[-1].name
        taken_count = len(self.middle) + 1
        self.miss_seq += 1
        self.last_miss = {"seq": self.miss_seq, "player": player, "card": card.name, "target": target_name, "taken": taken_count}
        self.stacking[owner][slot] = None
        self.middle.append(card)
        self._schedule_replacement(player, owner, slot, now)
        self._pickup_middle(player, now)                 # R7: the placer starts next
        self._check_finishes()

    def _shed(self, player: str) -> None:
        if self.phase != "freaky":
            raise ValueError("nobody has a Freaky Tiki to shed against")
        if player == self.freaky_player:
            raise ValueError("you are the one who has to call Freaky Tiki")
        if not self.playing[player]:
            raise ValueError("you have no playing-hand cards to shed")
        self.shed_pool.append((player, self.playing[player].pop(0)))
        self._check_finishes()

    def _resolve_freaky(self, now: float) -> None:
        caller = self.freaky_player
        cards = [c for _, c in self.shed_pool]           # R5b: unshuffled, received order
        self.playing[caller] = cards + self.playing[caller]   # ...on TOP, earliest shed on top (A1)
        self.shed_pool = []
        self.freaky_player, self.freaky_deadline = None, None
        self.phase = "open"
        self.last_placement_at = now
        self.turn = self.players.index(caller)           # caller starts the next turn
        self._fix_turn()
        self._check_finishes()

    def _valid_joker_targets(self) -> list[str]:
        active = self.active_players()
        if self.slap_winner is not None and self.total(self.slap_winner) == 0:
            non_winner = [p for p in active if p != self.slap_winner]
            if non_winner:
                active = non_winner
        if (
            self.last_joker_target is not None
            and self.joker_target_streak >= 2
            and self.joker_placer == self.last_joker_target
            and len(self.middle) == 1
        ):
            others = [p for p in active if p != self.last_joker_target]
            if others:
                return others
        return active

    def _slap_press(self, player: str, now: float = 0.0) -> None:
        if self.phase != "joker":
            raise ValueError("there is no Joker to slap")
        self.presses[player] = self.presses.get(player, 0) + 1
        self.last_slapper = player
        threshold = SLAP_PRESSES_STACKING_PLACER if (self.joker_from_stacking and player == self.joker_placer) else SLAP_PRESSES
        if self.presses[player] >= threshold:
            if self.total(player) == 0 and (len(self.active_players()) - 1) <= self._end_threshold():
                # Last card was the Joker and their finish immediately ends the game:
                # keep self.middle intact (never wipe it) and finish the game cleanly.
                self.joker_placer, self.presses, self.slap_winner, self.last_slapper = None, {}, None, None
                self.joker_from_stacking = False
                self.joker_deadline = None
                self.pending.pop(player, None)
                self.stackers, self.last_stack_at = [], None
                self.phase = "open"
                self.last_placement_at = now
                self._advance_turn(player)
                self._check_finishes()
                self._fix_turn()
                return
            self.slap_winner = player
            self.phase = "joker_choose"
            self.joker_deadline = now + self._joker_timeout()

    def _slap_choose(self, player: str, move: dict, now: float) -> None:
        if self.phase != "joker_choose" or player != self.slap_winner:
            raise ValueError("only the slap winner chooses who gets the stack")
        target = move.get("target")
        if target not in self.players or not self.is_active(target):
            raise ValueError("that player is out of the game and cannot be given cards")
        if target not in self._valid_joker_targets():
            raise ValueError(f"{target} cannot receive the Joker stack 3 times in a row")
        if target == self.joker_placer and len(self.middle) == 1:
            if target == self.last_joker_target:
                self.joker_target_streak += 1
            else:
                self.last_joker_target = target
                self.joker_target_streak = 1
        else:
            self.last_joker_target = None
            self.joker_target_streak = 0
        self.joker_placer, self.presses, self.slap_winner, self.last_slapper = None, {}, None, None
        self.joker_from_stacking = False
        self.joker_deadline = None
        self._pickup_middle(target, now)                 # R5c + R7
        self._finalize_pending_finishes(actor=None)
        self._check_finishes()

    # -------------------------------------------------------------------- view
    def public_view_for(self, player: str, now: float = 0.0) -> dict:
        """Stacking hands and the middle are public. Playing hands are secret
        from EVERYONE including their owner - counts only, never the cards."""
        view = {
            "you": player,
            "phase": self.phase,
            "your_playing_count": len(self.playing[player]),
            "playing_counts": {p: len(h) for p, h in self.playing.items()},
            "stacking_hands": {p: [c.name if c else None for c in slots]
                               for p, slots in self.stacking.items()},
            "middle_top": self.middle[-1].name if self.middle else None,
            "middle_count": len(self.middle),
            "turn_player": self.players[self.turn] if self.turn is not None else None,
            "stackers": list(self.stackers),
            "finished": list(self.finished),
            "dropped": list(self.dropped),
            "last_miss": dict(self.last_miss) if self.last_miss else None,
            "last_stack": dict(self.last_stack) if self.last_stack else None,
            "last_drop": dict(self.last_drop) if self.last_drop else None,
            "pace_left": max(0.0, round(self._pace() - (now - self.last_placement_at), 3)) if self.last_placement_at is not None else 0.0,
            "pace_dur": self._pace(),
            "stack_delay_left": max(0.0, round(self._stack_delay() - (now - self.last_stack_at), 3)) if (self.phase == "stacked" and self.last_stack_at is not None) else 0.0,
            "stack_delay_dur": self._stack_delay(),
        }
        if self.phase == "open" and self.standstill_deadline is not None:
            view["standstill"] = {"seconds_left": max(0.0, round(self.standstill_deadline - now, 1))}
        if self.phase == "freaky":
            shed_counts: dict[str, int] = {}
            for p, _ in self.shed_pool:
                shed_counts[p] = shed_counts.get(p, 0) + 1
            view["freaky"] = {"player": self.freaky_player, "shed_counts": shed_counts,
                              "seconds_left": max(0.0, round((self.freaky_deadline or now) - now, 1))}
        if self.phase in ("joker", "joker_choose"):
            threshold = SLAP_PRESSES_STACKING_PLACER if (self.joker_from_stacking and player == self.joker_placer) else SLAP_PRESSES
            view["joker"] = {"placer": self.joker_placer, "from_stacking": self.joker_from_stacking,
                             "your_presses": self.presses.get(player, 0), "your_threshold": threshold,
                             "winner": self.slap_winner, "last_slapper": self.last_slapper, "targets": self._valid_joker_targets(),
                             "seconds_left": max(0.0, round((self.joker_deadline or now) - now, 1)) if self.phase == "joker_choose" else None}
        if self.phase == "over":
            view["ranking"] = list(self.finished)
            view["losers"] = list(self.losers)
        return view
