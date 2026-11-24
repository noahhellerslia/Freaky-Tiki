"""Pygame viewer / local game - pygbag-compatible so it can run in a browser.
Run locally:   pip install pygame-ce   then   python main.py
Run in browser: pip install pygbag     then   python -m pygbag main.py
                (test server on http://localhost:8000 - build with --build)
pygbag rules that are NOT optional:
  * main() must be `async def`, the loop must `await asyncio.sleep(0)` every frame
  * asyncio.run(main()) must be the last statement
  * no threading, no sockets, no time.sleep(), audio only as .ogg
This demo just deals 5 cards face-up and 5 face-down; click to re-deal.
Your rules go in game_logic.py, drawing/input go here.
"""
import asyncio, json, random
from pathlib import Path
import pygame

SCALE = 3                      # cards are 64x88, displayed at 192x264
CARD_W, CARD_H = 64 * SCALE, 88 * SCALE
ASSETS = Path(__file__).resolve().parent.parent / "assets"

def load_cards():
    sheet = pygame.image.load(ASSETS / "spritesheet.png").convert_alpha()
    atlas = json.loads((ASSETS / "atlas.json").read_text())["frames"]
    cards = {}
    for name, r in atlas.items():
        surf = sheet.subsurface(pygame.Rect(r["x"], r["y"], r["w"], r["h"]))
        # pygame.transform.scale is non-smoothing by default = crisp pixels. Never use smoothscale.
        cards[name] = pygame.transform.scale(surf, (CARD_W, CARD_H))
    return cards

async def main():
    pygame.init()
    screen = pygame.display.set_mode((1100, 640))
    pygame.display.set_caption("Card game - demo deal")
    cards = load_cards()
    names = [n for n in cards if "_of_" in n]
    rng = random.Random()
    def deal():
        pick = rng.sample(names, 10)
        return pick[:5], pick[5:]
    hand, opponents = deal()
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            if event.type == pygame.MOUSEBUTTONDOWN:
                hand, opponents = deal()
        screen.fill((24, 68, 44))  # table green
        for i, _ in enumerate(opponents):
            screen.blit(cards["card_back"], (60 + i * (CARD_W + 16), 30))
        for i, name in enumerate(hand):
            screen.blit(cards[name], (60 + i * (CARD_W + 16), 330))
        pygame.display.flip()
        await asyncio.sleep(0)     # yields to the browser every frame - required by pygbag

asyncio.run(main())
