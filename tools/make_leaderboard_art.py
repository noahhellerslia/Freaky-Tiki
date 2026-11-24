#!/usr/bin/env python3
"""Procedural pixel-art assets for the Freaky Tiki themed leaderboard:
  - assets/lb_temple_bg.png : 192x108 -> 768x432 Tiki Temple & Volcano Island backdrop
  - assets/lb_torch.png     : 20x36  -> 80x144  carved tiki torch sprite
  - assets/lb_flame.png     : 16x20  -> 64x80   pixel-art flame sprite for burning losers

Uses the exact same palette and NEAREST upscaling as tools/make_tiki.py.
Run: .venv/bin/python tools/make_leaderboard_art.py
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from PIL import Image, ImageDraw
except ImportError:
    from _png_canvas import Image, ImageDraw

INK = (43, 26, 18, 255)
SKY_TOP = (21, 14, 28, 255)
SKY_MID = (34, 21, 46, 255)
SKY_LOW = (48, 28, 54, 255)
STAR_1 = (255, 241, 214, 255)
STAR_2 = (255, 207, 74, 255)
MOON = (255, 244, 210, 255)
MOON_SHADE = (227, 201, 153, 255)

OCEAN_D = (11, 74, 88, 255)
OCEAN_M = (20, 128, 138, 255)
OCEAN_L = (31, 156, 148, 255)
FOAM = (120, 230, 215, 255)

STONE_D = (42, 46, 56, 255)
STONE_M = (68, 74, 88, 255)
STONE_L = (98, 106, 122, 255)

WOOD_D = (74, 44, 24, 255)
WOOD_M = (104, 66, 38, 255)
WOOD_L = (156, 102, 66, 255)
WOOD_HI = (194, 138, 90, 255)

LEAF_D = (20, 96, 54, 255)
LEAF_M = (38, 152, 84, 255)
LEAF_L = (96, 210, 128, 255)

VOLC_D = (46, 18, 16, 255)
VOLC_M = (84, 30, 22, 255)
VOLC_L = (126, 46, 28, 255)

LAVA_D = (200, 56, 24, 255)
LAVA_M = (255, 118, 36, 255)
LAVA_L = (255, 207, 74, 255)
LAVA_CORE = (255, 246, 200, 255)


def make_temple_bg():
    W, H, S = 192, 108, 4
    img = Image.new("RGBA", (W, H), SKY_TOP)
    d = ImageDraw.Draw(img)

    # Night sky bands
    d.rectangle([0, 0, W, 24], fill=SKY_TOP)
    d.rectangle([0, 24, W, 46], fill=SKY_MID)
    d.rectangle([0, 46, W, 62], fill=SKY_LOW)

    # Pixel stars
    rng = random.Random(42)
    for _ in range(34):
        sx = rng.randint(2, W - 3)
        sy = rng.randint(2, 44)
        col = STAR_2 if rng.random() < 0.35 else STAR_1
        d.point((sx, sy), fill=col)

    # Pixel crescent moon (upper left)
    d.ellipse([18, 8, 32, 22], fill=MOON)
    d.ellipse([23, 7, 36, 20], fill=SKY_TOP)
    d.point([(20, 12), (21, 16)], fill=MOON_SHADE)

    # Lagoon ocean strip
    d.rectangle([0, 62, W, 78], fill=OCEAN_D)
    d.rectangle([0, 64, W, 71], fill=OCEAN_M)
    for x in range(4, W - 8, 14):
        d.line([(x, 66), (x + 6, 66)], fill=OCEAN_L)
        d.line([(x + 3, 70), (x + 7, 70)], fill=FOAM)

    # Left-side Tiki Temple silhouette & carved stone terrace
    d.polygon([(8, 62), (24, 38), (94, 38), (112, 62)], fill=STONE_D, outline=INK)
    d.polygon([(18, 62), (30, 42), (88, 42), (100, 62)], fill=STONE_M)
    # Temple roof / carved lintel
    d.rectangle([22, 32, 96, 40], fill=WOOD_M, outline=INK)
    d.line([(24, 34), (94, 34)], fill=WOOD_HI)
    for x in range(26, 92, 8):
        d.rectangle([x, 36, x + 3, 38], fill=LAVA_L)

    # Palm fronds framing the left side
    for px, py, dx, dy in [(0, 48, 22, -16), (0, 52, 26, -6), (0, 56, 20, 4)]:
        d.line([(px, py), (px + dx, py + dy)], fill=LEAF_D, width=3)
        d.line([(px, py - 1), (px + dx - 2, py + dy - 1)], fill=LEAF_M, width=2)
        d.line([(px + 2, py - 1), (px + dx - 4, py + dy - 1)], fill=LEAF_L, width=1)

    # Right-side Volcano rising over the pit
    d.polygon([(116, 76), (138, 22), (166, 22), (191, 76)], fill=VOLC_D, outline=INK)
    d.polygon([(124, 76), (142, 26), (162, 26), (184, 76)], fill=VOLC_M)
    # Volcano crater rim & lava rivers
    d.rectangle([138, 20, 166, 25], fill=LAVA_M, outline=INK)
    d.rectangle([142, 20, 162, 23], fill=LAVA_L)
    d.line([(148, 24), (144, 42), (149, 60), (145, 76)], fill=LAVA_D, width=3)
    d.line([(148, 24), (144, 42), (149, 60), (145, 76)], fill=LAVA_M, width=1)
    d.line([(156, 24), (160, 46), (155, 68)], fill=LAVA_M, width=2)
    d.line([(156, 24), (160, 46)], fill=LAVA_L, width=1)
    # Rising volcano embers
    for ex, ey in [(142, 14), (150, 9), (158, 12), (165, 16), (146, 5), (162, 7)]:
        d.point((ex, ey), fill=LAVA_L)
        d.point((ex + 1, ey + 2), fill=LAVA_M)

    # Foreground floor: left temple stone platform, right molten pit
    d.rectangle([0, 74, 118, H], fill=STONE_D, outline=INK)
    d.rectangle([2, 76, 116, 82], fill=STONE_L)
    for x in range(6, 114, 12):
        d.line([(x, 76), (x, H)], fill=INK)
    for y in range(84, H, 10):
        d.line([(0, y), (118, y)], fill=INK)

    # Right molten pit
    d.rectangle([118, 74, W, H], fill=VOLC_D, outline=INK)
    d.rectangle([120, 84, W - 2, H - 2], fill=LAVA_D)
    d.rectangle([122, 92, W - 4, H - 4], fill=LAVA_M)
    d.rectangle([126, 98, W - 8, H - 6], fill=LAVA_L)
    for x in range(124, W - 8, 10):
        d.rectangle([x, 88, x + 4, 91], fill=LAVA_L)
        d.point((x + 2, 82), fill=LAVA_L)

    return img.resize((W * S, H * S), Image.NEAREST)


def make_torch():
    W, H, S = 20, 36, 4
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Pixel flame
    d.polygon([(10, 2), (5, 11), (7, 16), (13, 16), (15, 11)], fill=LAVA_D, outline=INK)
    d.polygon([(10, 4), (7, 11), (8, 15), (12, 15), (13, 11)], fill=LAVA_M)
    d.polygon([(10, 7), (8, 12), (10, 15), (12, 12)], fill=LAVA_L)
    d.point([(10, 11), (10, 12)], fill=LAVA_CORE)

    # Carved wooden cup + bamboo shaft
    d.rectangle([6, 16, 14, 21], fill=WOOD_M, outline=INK)
    d.line([(7, 17), (13, 17)], fill=WOOD_HI)
    d.rectangle([8, 21, 12, 34], fill=WOOD_D, outline=INK)
    d.line([(9, 22), (9, 33)], fill=WOOD_L)
    for y in (25, 30):
        d.line([(8, y), (12, y)], fill=INK)

    return img.resize((W * S, H * S), Image.NEAREST)


def make_flame():
    W, H, S = 16, 20, 4
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.polygon([(8, 1), (3, 9), (2, 15), (5, 19), (11, 19), (14, 15), (13, 9)], fill=LAVA_D, outline=INK)
    d.polygon([(8, 3), (5, 10), (4, 15), (6, 18), (10, 18), (12, 15), (11, 10)], fill=LAVA_M)
    d.polygon([(8, 6), (6, 12), (6, 17), (10, 17), (10, 12)], fill=LAVA_L)
    d.rectangle([7, 13, 9, 17], fill=LAVA_CORE)
    d.point([(3, 4), (13, 6)], fill=LAVA_L)

    return img.resize((W * S, H * S), Image.NEAREST)


def make_pedestal(rank: int):
    """Carved metallic pixel-art pedestal (1=gold, 2=silver, 3=bronze)."""
    W, S = 28, 4
    H = {1: 22, 2: 17, 3: 15}[rank]
    palettes = {
        1: {  # Gold
            "hi": (255, 246, 178, 255),
            "light": (255, 222, 92, 255),
            "mid": (235, 174, 34, 255),
            "dark": (166, 108, 16, 255),
            "deep": (112, 68, 10, 255),
        },
        2: {  # Silver
            "hi": (250, 253, 255, 255),
            "light": (222, 232, 242, 255),
            "mid": (168, 182, 200, 255),
            "dark": (112, 126, 144, 255),
            "deep": (74, 84, 98, 255),
        },
        3: {  # Bronze
            "hi": (255, 212, 166, 255),
            "light": (236, 158, 94, 255),
            "mid": (196, 112, 52, 255),
            "dark": (138, 70, 28, 255),
            "deep": (92, 42, 16, 255),
        },
    }[rank]

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Top stepped cap where the tiki stands
    d.rectangle([1, 0, W - 2, 4], fill=palettes["mid"], outline=INK)
    d.line([(2, 1), (W - 3, 1)], fill=palettes["hi"])
    d.line([(2, 2), (W - 3, 2)], fill=palettes["light"])
    d.line([(2, 3), (W - 3, 3)], fill=palettes["dark"])

    # Main pillar body
    d.rectangle([3, 4, W - 4, H - 4], fill=palettes["mid"], outline=INK)
    d.line([(4, 5), (4, H - 5)], fill=palettes["light"])
    d.line([(5, 5), (5, H - 5)], fill=palettes["hi"])
    d.line([(W - 5, 5), (W - 5, H - 5)], fill=palettes["dark"])
    d.line([(W - 6, 5), (W - 6, H - 5)], fill=palettes["deep"])

    # Recessed center plaque
    p_top = 5 if rank == 3 else 6
    p_bot = H - 5 if rank == 3 else H - 6
    d.rectangle([7, p_top, W - 8, p_bot], fill=palettes["dark"], outline=palettes["deep"])
    d.rectangle([8, p_top + 1, W - 9, p_bot - 1], fill=palettes["mid"])
    d.line([(9, p_top + 2), (12, p_top + 2)], fill=palettes["hi"])

    # Bottom stepped base
    d.rectangle([1, H - 4, W - 2, H - 1], fill=palettes["dark"], outline=INK)
    d.line([(2, H - 3), (W - 3, H - 3)], fill=palettes["light"])
    d.line([(2, H - 2), (W - 3, H - 2)], fill=palettes["deep"])

    # Pixel rank digit centered in plaque
    cy = (p_top + p_bot) // 2
    cx = W // 2
    digits = {
        1: [(0, -2), (-1, -1), (0, -1), (0, 0), (0, 1), (-1, 2), (0, 2), (1, 2)],
        2: [(-1, -2), (0, -2), (1, -2), (1, -1), (-1, 0), (0, 0), (1, 0), (-1, 1), (-1, 2), (0, 2), (1, 2)],
        3: [(-1, -2), (0, -2), (1, -2), (1, -1), (0, 0), (1, 0), (1, 1), (-1, 2), (0, 2), (1, 2)],
    }[rank]
    for dx, dy in digits:
        d.point((cx + dx + 1, cy + dy + 1), fill=palettes["deep"])
    for dx, dy in digits:
        d.point((cx + dx, cy + dy), fill=palettes["hi"])

    return img.resize((W * S, H * S), Image.NEAREST)


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(out, exist_ok=True)
    make_temple_bg().save(os.path.join(out, "lb_temple_bg.png"))
    make_torch().save(os.path.join(out, "lb_torch.png"))
    make_flame().save(os.path.join(out, "lb_flame.png"))
    for rank in (1, 2, 3):
        make_pedestal(rank).save(os.path.join(out, f"lb_pedestal_{rank}.png"))
    print("Generated lb_temple_bg.png, lb_torch.png, lb_flame.png, lb_pedestal_1..3.png in assets/")


if __name__ == "__main__":
    main()
