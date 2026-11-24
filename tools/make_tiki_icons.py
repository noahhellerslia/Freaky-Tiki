#!/usr/bin/env python3
"""Procedural pixel-art Tiki UI icons so the entire game uses crisp
Tiki-themed pixel art instead of system emojis.

Generates in assets/:
  - ico_crown.png   : Tiki Chief golden crown (host + win banner)
  - ico_star.png    : Golden hibiscus star (your seat badge + finishers)
  - ico_gear.png    : Carved wood & gold gear (Settings)
  - ico_expand.png  : Carved gold fullscreen arrows (Full screen)
  - ico_scroll.png  : Bamboo & parchment scroll (How to play)
  - ico_medal_1.png : Gold Tiki medal (1st place)
  - ico_medal_2.png : Silver Tiki medal (2nd place)
  - ico_medal_3.png : Bronze Tiki medal (3rd place)

Run: .venv/bin/python tools/make_tiki_icons.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from PIL import Image, ImageDraw
except ImportError:
    from _png_canvas import Image, ImageDraw

INK = (43, 26, 18, 255)
GOLD_HI = (255, 240, 148, 255)
GOLD = (255, 207, 74, 255)
GOLD_D = (188, 124, 24, 255)

SILVER_HI = (244, 248, 252, 255)
SILVER = (203, 213, 225, 255)
SILVER_D = (120, 134, 152, 255)

BRONZE_HI = (251, 204, 140, 255)
BRONZE = (221, 107, 32, 255)
BRONZE_D = (146, 62, 24, 255)

WOOD_HI = (194, 138, 90, 255)
WOOD = (156, 102, 66, 255)
WOOD_D = (92, 56, 30, 255)

CREAM = (255, 241, 214, 255)
CREAM_D = (218, 190, 142, 255)
HIBISCUS = (255, 79, 139, 255)
LEAF = (61, 220, 151, 255)
LAGOON = (20, 128, 138, 255)

S = 4


def canvas():
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def save_icon(img, out_dir, name):
    img.resize((16 * S, 16 * S), Image.NEAREST).save(os.path.join(out_dir, name))


def make_crown():
    img, d = canvas()
    # Base band + 3 points
    d.polygon([(2, 12), (2, 5), (5, 8), (8, 3), (11, 8), (14, 5), (14, 12)], fill=GOLD, outline=INK)
    d.rectangle([2, 11, 14, 14], fill=GOLD_D, outline=INK)
    d.line([(3, 12), (13, 12)], fill=GOLD_HI)
    d.point([(8, 4), (3, 6), (13, 6)], fill=GOLD_HI)
    # Tiki gems
    d.point([(8, 9), (5, 11), (11, 11)], fill=HIBISCUS)
    d.point([(8, 11)], fill=LEAF)
    return img


def make_star():
    img, d = canvas()
    # 5-petal golden hibiscus / star
    d.polygon([(8, 1), (10, 6), (15, 6), (11, 9), (13, 14), (8, 11), (3, 14), (5, 9), (1, 6), (6, 6)],
              fill=GOLD, outline=INK)
    d.rectangle([6, 6, 10, 9], fill=GOLD_HI)
    d.point([(8, 8)], fill=HIBISCUS)
    return img


def make_gear():
    img, d = canvas()
    # Teeth
    for x in (6, 9):
        d.rectangle([x, 1, x + 1, 3], fill=GOLD_D, outline=INK)
        d.rectangle([x, 12, x + 1, 14], fill=GOLD_D, outline=INK)
    for y in (6, 9):
        d.rectangle([1, y, 3, y + 1], fill=GOLD_D, outline=INK)
        d.rectangle([12, y, 14, y + 1], fill=GOLD_D, outline=INK)
    for x, y in [(3, 3), (11, 3), (3, 11), (11, 11)]:
        d.rectangle([x, y, x + 1, y + 1], fill=GOLD_D, outline=INK)
    # Carved ring
    d.ellipse([3, 3, 13, 13], fill=GOLD, outline=INK)
    d.ellipse([5, 5, 11, 11], fill=WOOD_D, outline=INK)
    d.ellipse([6, 6, 10, 10], fill=(0, 0, 0, 0))
    d.point([(6, 4), (7, 4), (9, 4)], fill=GOLD_HI)
    return img


def make_expand():
    img, d = canvas()
    # Four corner arrows in gold with dark ink outline
    # Top-left
    d.rectangle([1, 1, 6, 2], fill=INK)
    d.rectangle([1, 1, 2, 6], fill=INK)
    d.line([(2, 2), (5, 2)], fill=GOLD_HI)
    d.line([(2, 2), (2, 5)], fill=GOLD_HI)
    d.point([(4, 4)], fill=GOLD)
    # Top-right
    d.rectangle([9, 1, 14, 2], fill=INK)
    d.rectangle([13, 1, 14, 6], fill=INK)
    d.line([(10, 2), (13, 2)], fill=GOLD_HI)
    d.line([(13, 2), (13, 5)], fill=GOLD_HI)
    d.point([(11, 4)], fill=GOLD)
    # Bottom-left
    d.rectangle([1, 13, 6, 14], fill=INK)
    d.rectangle([1, 9, 2, 14], fill=INK)
    d.line([(2, 13), (5, 13)], fill=GOLD)
    d.line([(2, 10), (2, 13)], fill=GOLD)
    d.point([(4, 11)], fill=GOLD_HI)
    # Bottom-right
    d.rectangle([9, 13, 14, 14], fill=INK)
    d.rectangle([13, 9, 14, 14], fill=INK)
    d.line([(10, 13), (13, 13)], fill=GOLD)
    d.line([(13, 10), (13, 13)], fill=GOLD)
    d.point([(11, 11)], fill=GOLD_HI)
    return img


def make_scroll():
    img, d = canvas()
    # Parchment body
    d.rectangle([3, 2, 12, 13], fill=CREAM, outline=INK)
    # Top & bottom bamboo rollers
    d.rectangle([2, 1, 13, 3], fill=WOOD, outline=INK)
    d.line([(3, 2), (12, 2)], fill=WOOD_HI)
    d.rectangle([2, 12, 13, 14], fill=WOOD, outline=INK)
    d.line([(3, 13), (12, 13)], fill=WOOD_D)
    # Carved "?" mark
    d.line([(6, 5), (9, 5)], fill=INK)
    d.point([(9, 6), (8, 7), (7, 8), (7, 10)], fill=INK)
    return img


def make_medal(hi, mid, dark):
    img, d = canvas()
    # Lagoon/hibiscus ribbon
    d.polygon([(4, 1), (7, 1), (8, 6), (6, 6)], fill=LAGOON, outline=INK)
    d.polygon([(9, 1), (12, 1), (10, 6), (8, 6)], fill=HIBISCUS, outline=INK)
    # Medallion disc
    d.ellipse([3, 5, 13, 15], fill=mid, outline=INK)
    d.line([(5, 7), (10, 7)], fill=hi)
    d.point([(5, 8), (11, 13)], fill=hi)
    d.line([(6, 14), (10, 14)], fill=dark)
    d.point([(8, 9), (8, 10), (8, 11)], fill=INK)
    return img


def make_minimize():
    img, d = canvas()
    # Four inward-pointing corner brackets (exit fullscreen / minimize)
    # Top-left quadrant -> bottom-right corner at (6, 6)
    d.rectangle([1, 5, 6, 6], fill=INK)
    d.rectangle([5, 1, 6, 6], fill=INK)
    d.line([(2, 5), (5, 5)], fill=GOLD_HI)
    d.line([(5, 2), (5, 5)], fill=GOLD_HI)
    d.point([(2, 2), (3, 3)], fill=GOLD)
    # Top-right quadrant -> bottom-left corner at (9, 6)
    d.rectangle([9, 5, 14, 6], fill=INK)
    d.rectangle([9, 1, 10, 6], fill=INK)
    d.line([(10, 5), (13, 5)], fill=GOLD_HI)
    d.line([(10, 2), (10, 5)], fill=GOLD_HI)
    d.point([(13, 2), (12, 3)], fill=GOLD)
    # Bottom-left quadrant -> top-right corner at (6, 9)
    d.rectangle([1, 9, 6, 10], fill=INK)
    d.rectangle([5, 9, 6, 14], fill=INK)
    d.line([(2, 10), (5, 10)], fill=GOLD)
    d.line([(5, 10), (5, 13)], fill=GOLD)
    d.point([(2, 13), (3, 12)], fill=GOLD_HI)
    # Bottom-right quadrant -> top-left corner at (9, 9)
    d.rectangle([9, 9, 14, 10], fill=INK)
    d.rectangle([9, 9, 10, 14], fill=INK)
    d.line([(10, 10), (13, 10)], fill=GOLD)
    d.line([(10, 10), (10, 13)], fill=GOLD)
    d.point([(13, 13), (12, 12)], fill=GOLD_HI)
    return img


def make_sound():
    img, d = canvas()
    d.rectangle([2, 6, 5, 10], fill=GOLD, outline=INK)
    d.polygon([(5, 6), (9, 2), (9, 13), (5, 10)], fill=GOLD_HI, outline=INK)
    d.line([(11, 5), (12, 6), (12, 9), (11, 10)], fill=LEAF)
    d.line([(13, 3), (14, 5), (14, 10), (13, 12)], fill=GOLD_HI)
    return img


def make_music():
    img, d = canvas()
    d.rectangle([5, 3, 12, 5], fill=GOLD_HI, outline=INK)
    d.line([(5, 4), (5, 11)], fill=GOLD, width=2)
    d.line([(12, 4), (12, 10)], fill=GOLD, width=2)
    d.ellipse([2, 10, 6, 13], fill=HIBISCUS, outline=INK)
    d.ellipse([9, 9, 13, 12], fill=HIBISCUS, outline=INK)
    return img


def make_disconnected():
    img, d = canvas()
    d.ellipse([1, 1, 14, 14], fill=(210, 46, 56, 255), outline=INK)
    d.line([(4, 4), (11, 11)], fill=CREAM, width=2)
    d.line([(11, 4), (4, 11)], fill=CREAM, width=2)
    return img


def make_stopwatch():
    img, d = canvas()
    d.rectangle([6, 1, 9, 2], fill=GOLD_HI, outline=INK)
    d.rectangle([7, 2, 8, 3], fill=GOLD_D)
    d.point([(12, 4), (13, 3)], fill=GOLD)
    d.ellipse([2, 3, 13, 14], fill=GOLD, outline=INK)
    d.ellipse([4, 5, 11, 12], fill=CREAM, outline=INK)
    d.line([(8, 6), (8, 9)], fill=INK)
    d.line([(8, 9), (10, 9)], fill=HIBISCUS)
    d.point([(5, 6)], fill=GOLD_HI)
    return img


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(out_dir, exist_ok=True)
    save_icon(make_crown(), out_dir, "ico_crown.png")
    save_icon(make_star(), out_dir, "ico_star.png")
    save_icon(make_gear(), out_dir, "ico_gear.png")
    save_icon(make_expand(), out_dir, "ico_expand.png")
    save_icon(make_minimize(), out_dir, "ico_minimize.png")
    save_icon(make_scroll(), out_dir, "ico_scroll.png")
    save_icon(make_sound(), out_dir, "ico_sound.png")
    save_icon(make_music(), out_dir, "ico_music.png")
    save_icon(make_disconnected(), out_dir, "ico_disconnected.png")
    save_icon(make_stopwatch(), out_dir, "ico_stopwatch.png")
    save_icon(make_medal(GOLD_HI, GOLD, GOLD_D), out_dir, "ico_medal_1.png")
    save_icon(make_medal(SILVER_HI, SILVER, SILVER_D), out_dir, "ico_medal_2.png")
    save_icon(make_medal(BRONZE_HI, BRONZE, BRONZE_D), out_dir, "ico_medal_3.png")
    print("Generated 13 pixel-art Tiki icons in assets/")


if __name__ == "__main__":
    main()
