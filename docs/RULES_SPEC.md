# Freaky Tiki — rules spec

Source: Noah's rules as given 2026-11-12. Status tags:
**[STATED]** = in Noah's text · **[DEFAULT]** = my assumption, veto any of these ·
**[OPEN Qn]** = blocks implementation, asked to Noah 2026-11-12, awaiting answers.

## Setup [STATED]
- 54 cards: standard 52 + 2 jokers, split evenly among all players; some players
  get one more card than others.
- Each player holds their cards face down (their order is hidden): the **playing hand**.
- Each player starts with cards face up in front of them: 2 each, or only 1 each
  if there are 5+ players: the **stacking hand** (face-up slots).
- First game: a random player starts. Later games: the winner of the last game starts.

## Ordinary play [STATED]
- On your turn, place the top card of your playing hand on the middle stack.
  Play then passes clockwise, one card per turn.
- Playing out of turn: that player picks up the entire middle stack.

## Stacking [STATED]
- Whenever a card is in the middle, any player may play a card from **any** player's
  stacking hand (their own or someone else's) onto the middle if that card is within
  one point value of the current top card. Ace wraps (A is within one of K and of 2).
  Suits don't matter [DEFAULT — only point value is ever mentioned].
- Whoever stacked replaces that stacking slot with a card from **their own** playing hand.
- Stacks may chain multiple times in one turn. Once 2 seconds have passed since the
  last stack, the next turn can start — see [OPEN Q2] for who starts it.
- Incorrect stack (e.g. a 5 on a 3): the stacker takes the entire middle stack,
  shuffles it, and puts it on the **bottom** of their playing hand.

## Freaky Tiki [STATED]
- If a player takes an **ordinary** turn and their card "matches" the card that was
  on top (example given: Queen played onto a King), they must say "Freaky Tiki!" —
  the exact trigger is [OPEN Q1].
- Before they say it, every other player may place cards from their playing hand
  onto the table in front of themselves, one by one.
- When they say it, they pick up all cards the others placed.
- After a Freaky Tiki, the player who said it starts the next turn.

## Jokers [STATED]
- Joker played from a playing hand onto the middle: first player to slap it chooses
  any player (including themselves) to receive the entire middle stack.
- Joker in a stacking hand: its owner may play it to the middle whenever they want.
  First player to slap chooses who receives the entire middle stack. The placer must
  lift their hand before they may slap it themselves.

## Winning / losing [STATED]
- First player to place all their cards down wins.
- The game continues until only 2 players still have cards — or only 3, if the game
  started with 6+ players. Those remaining players are the losers.

## Defaults I'm building on unless corrected [DEFAULT]
- D1. The deck is shuffled before it is split; cards are dealt one at a time,
  clockwise from the starting player, so the extra cards go to the earliest
  players in that order (only matters because 54 doesn't divide evenly).
- D2. Stacking hand = the **top** cards of the dealt pile, flipped face up (players
  get no choice — they haven't seen them). Playing-hand order: top = first card
  you can play, consistently defined in code.
- D3. A replacement card goes into the slot **face up**, taken from the **top** of
  the stacker's playing hand. If the stacker has no playing-hand cards, the slot
  simply stays empty (this is also the only way stacking slots ever empty).
  **Superseded in part by Noah's 2026-11-13 answer on the defaults:** replacement
  is *delayed* (see Resolved R4), and if the stacker has no playing cards, the
  player who was taken from replaces their own slot from their own playing hand;
  the slot stays empty only if they have none either.
- D4. Seating / clockwise = the order players joined the room.
- D5. Finished players are out: they can't stack, slap, or be given the middle stack.
- D6. Races (stacks, slaps, Freaky Tiki sheds) are decided by the order the server
  receives them. No turn timer (it's a friends game; a stalled player stalls it).
- D7. A stacking-hand Joker may be played even onto an empty middle.
- D8. Player count 2–8 (server currently allows 8); in a 2-player game the first
  finisher wins and the other loses.
- D9. Each player's stacking hand is public (it's face up on the table); playing
  hands stay secret — the server sends only counts for those.
- D10. A new game in the same room keeps the same seating; the previous game's
  winner starts, per the stated rule.

## Resolved — Noah's answers, 2026-11-13
- R1 (Q1/Q1b). Freaky Tiki trigger = **within one, including equal ranks and Ace
  wrap**. Stacking likewise allows equal ranks. (within_one() already did this.)
- R2 (Q2). After a stack sequence: **any player who stacked may start the next
  turn; first to play gets it.** This window is a special case: a non-stacker
  playing then is NOT penalised — the play is simply not allowed.
- R3 (Q3). Mistakes use a **0.5-second grace period**: if the offending attempt
  comes <0.5s after the last card was placed, it is just disallowed (no penalty);
  at >=0.5s, the penalty applies. (Covers out-of-turn plays, incorrect stacks,
  and the simultaneous-stack race.)
- R4 (Q4). Replacement is **delayed and batched**: a stacker replaces all slots
  they took from **0.25s after their own last stack**. If they chain stacks
  (own card, then right's, then left's), all replacements happen 0.25s after the
  final one. Penalty always falls on the placer, never the slot's owner.
  Fallback (from Noah's defaults note): if, when replacement comes due, the
  stacker has no playing cards, the player taken from replaces their own slot
  from their own playing hand; empty only if they have none either.
- R5 (Q5). Pickups: out-of-turn (a) and Joker giveaway (c) — **shuffled, bottom**
  of the receiver's playing hand. Freaky Tiki sheds (b) — **unshuffled, on TOP**
  of the caller's playing hand. [Assumption A1: shed cards keep server-received
  order, earliest shed = topmost. Veto if wrong.]
- R6 (Q6). Joker slap: (a) the placer MAY slap their own Joker. (b) No lockout,
  but slapping is done by **spamming the slap input**: everyone needs 2 presses
  to complete a slap, EXCEPT the player who placed a stacking-hand Joker, who
  needs 5 (the first 3 are "lifting their hand"). The completed slap is timed at
  the final press; first to complete wins the race. (c) Whoever receives the
  middle stack starts the next turn (see R7).
- R7 (Q7 + Q6c). **Universal rule: whoever picks up the entire middle stack
  starts the next turn.** So after a penalty the *offender* starts; after a slap
  the *recipient* starts.
- R8 (Q8). Winning = **zero cards total** (playing + stacking). Finishers are
  ranked in finishing order, are out immediately, cannot act, and cannot be
  given cards.
- R9 (Q9). Shedding is unlimited, one card at a time. A player cannot win by
  shedding alone because they will still hold a stacking card (finish checks are
  total = 0, per R8). If the trigger player never calls, the game waits
  **10 seconds** — [Assumption A2: at 10s the Freaky Tiki auto-resolves exactly
  as if called: caller picks up the sheds and starts the next turn. The
  alternative, cancelling, would reward stalling. Veto if wrong.]
- R10 (Q10). After a placement, the next ordinary play needs a **0.25-second
  window** to pass first (stacks are not bound by this; they are reactions).
- R11 (Noah, 2026-11-13). **Standstill:** if no player has a legal move —
  every remaining player's playing hand is empty, no replacement is pending,
  and no face-up stacking card can legally be played (none within one of the
  middle top, and no stacking-hand Joker, which its owner may always play) —
  the game **ends there**: the players still holding cards are the losers and
  the standings stay as they are. (An empty middle is not a standstill: the
  incorrect-stack penalty path routes a card into the stacker's own playing
  hand, which unsticks the game.)
- R12 (Noah, 2026-11-13). **Given the middle? Top up your stacking hand.**
  When a player receives the entire middle stack (slap giveaway or penalty
  pickup), any of their stacking slots standing empty is immediately
  refilled from the top of their playing hand — back up to the game's
  normal stacking-hand size (the slot count itself never changes: 2 slots,
  or 1 with 5+ players).

## Timing constants (seconds)
PACE = 0.25 (min gap before the next ordinary play; also replacement delay)
GRACE = 0.5 (mistake grace period, R3)
STACK_TURN_DELAY = 2.0 (quiet time after the last stack before a stacker may start)
FREAKY_TIMEOUT = 10.0 (auto-resolve, R9/A2)
SLAP_PRESSES = 2, SLAP_PRESSES_STACKING_PLACER = 5 (R6)
