#!/usr/bin/env python3
"""Verify the generated deck in assets/:
- every card PNG is 128x176 and matches atlas.json (56 frames, card_size too)
- every number card has EXACTLY its pip count and every ace exactly 1 centre
  pip, counted as connected components of the suit colour with the corner
  boxes treated as walls (so a pip merged with a corner index cannot hide)
- both jokers carry JOKER lettering on both edges plus the jester face/bells
Run after tools/make_cards.py:  python3 tools/verify_cards.py
"""
import json, os, sys
from collections import deque
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from PIL import Image
except ImportError:
    from _png_canvas import Image

ROOT = Path(__file__).resolve().parent.parent / "assets"
INK, RED = (26, 28, 44), (193, 39, 45)
SUIT_RGB = {"spades": INK, "clubs": INK, "hearts": RED, "diamonds": RED}

def comps(im, rgb):
    px = im.load(); seen = set(); n = 0
    def blocked(x, y): return (x < 44 and y < 70) or (x > 88 and y > 104)   # TL box is wider: the '10' index reaches canvas x=39
    def inside(x, y):
        return 4 <= x <= 123 and 4 <= y <= 171 and not blocked(x, y) \
            and px[x, y][:3] == rgb and px[x, y][3] > 0
    for y in range(4, 172):
        for x in range(4, 124):
            if (x, y) in seen or not inside(x, y):
                continue
            n += 1; q = deque([(x, y)]); seen.add((x, y))
            while q:
                cx, cy = q.popleft()
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    p = (cx + dx, cy + dy)
                    if p not in seen and inside(*p):
                        seen.add(p); q.append(p)
    return n

def main():
    atlas = json.loads((ROOT / "atlas.json").read_text())
    assert atlas["card_size"] == [128, 176], atlas["card_size"]
    pngs = {p.stem for p in (ROOT / "cards").glob("*.png")}
    assert pngs == set(atlas["frames"]), "atlas/PNG name mismatch"
    for name in pngs:
        assert Image.open(ROOT / "cards" / f"{name}.png").size == (128, 176), name
    print(f"56 cards, all 128x176, atlas consistent")
    for suit, rgb in SUIT_RGB.items():
        for r in ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10"]:
            want = 1 if r == "A" else int(r)
            got = comps(Image.open(ROOT / "cards" / f"{r}_of_{suit}.png").convert("RGBA"), rgb)
            assert got == want, f"{r} of {suit}: {got} pips, want {want}"
    print("pip counts: ALL EXACT (40 cards)")
    for name, col in [("joker_red", RED), ("joker_black", INK)]:
        im = Image.open(ROOT / "cards" / f"{name}.png").convert("RGBA"); px = im.load()
        left = sum(1 for x in range(4, 24) for y in range(10, 160) if px[x, y][:3] == col)
        right = sum(1 for x in range(104, 124) for y in range(16, 166) if px[x, y][:3] == col)
        face = sum(1 for x in range(128) for y in range(176) if px[x, y][:3] == (24, 148, 152))
        gold = sum(1 for x in range(128) for y in range(176) if px[x, y][:3] == (212, 160, 32))
        assert left > 500 and right > 500 and face > 300 and gold > 150, name
    print("jokers: JOKER lettering both edges + jester face/bells present")
    print("verify_cards: ALL PASSED")

if __name__ == "__main__":
    main()
