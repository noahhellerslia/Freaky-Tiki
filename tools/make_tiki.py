#!/usr/bin/env python3
"""Original procedural pixel-art tiki statues for Freaky Tiki.

Drawn on a 56x72 logical grid and upscaled x4 with NEAREST, in the same
spirit as tools/make_cards.py: every pixel is computed here - no external
artwork. Outputs:
  assets/tiki.png     the classic statue (haunts the table during a Freaky)
  assets/tiki_0..7.png  eight colourways, one per player at the table -
                        each player's character icon in the lobby and seat.
Run: python3 tools/make_tiki.py
"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from PIL import Image, ImageDraw
except ImportError:
    from _png_canvas import Image, ImageDraw

W, H, S = 56, 72, 4
INK = (43, 26, 18, 255)
WOOD = (156, 102, 66, 255)
WOOD_LIGHT = (194, 138, 90, 255)
WOOD_DARK = (104, 66, 38, 255)
WOOD_DEEP = (74, 44, 24, 255)
GOLD = (244, 185, 66, 255)
TEETH = (255, 246, 224, 255)
TEETH_SHADE = (224, 210, 182, 255)
MOUTH = (43, 26, 18, 255)
EYE = (43, 26, 18, 255)
WHITE = (255, 255, 255, 255)

# (feathers[4], plinth colour, forehead-gem colour)
COLORWAYS = [
    ([(42, 157, 143), (231, 111, 81), (244, 185, 66), (200, 67, 60)], (74, 44, 24), (244, 185, 66)),      # classic
    ([(255, 105, 180), (186, 85, 211), (255, 20, 147), (221, 160, 221)], (90, 40, 110), (255, 105, 180)),  # pink/purple
    ([(30, 144, 255), (0, 191, 255), (70, 130, 180), (135, 206, 250)], (25, 60, 120), (0, 229, 255)),      # blues
    ([(124, 205, 60), (34, 170, 80), (180, 230, 90), (20, 120, 60)], (30, 90, 45), (190, 242, 100)),       # greens
    ([(147, 112, 219), (138, 43, 226), (186, 150, 255), (106, 70, 200)], (60, 35, 110), (200, 170, 255)),  # purples
    ([(255, 99, 71), (255, 165, 0), (255, 215, 0), (255, 105, 135)], (130, 50, 30), (255, 200, 60)),        # sunset
    ([(0, 200, 190), (0, 150, 170), (110, 240, 220), (0, 110, 140)], (15, 80, 90), (120, 255, 235)),       # ocean
    ([(240, 230, 140), (220, 190, 60), (250, 245, 190), (190, 150, 30)], (110, 85, 25), (255, 240, 130)),  # golds
]

def draw_tiki(feathers, plinth, gem):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    F = [c + (255,) for c in feathers]
    PLINTH = plinth + (255,)
    GEM = gem + (255,)

    # Vibrant feather fan behind the head
    cx, cy = 28, 20
    for i, ang in enumerate(range(-64, 65, 16)):
        a = math.radians(ang - 90)
        tip = (cx + 21 * math.cos(a), cy + 20 * math.sin(a))
        left = (cx + 6 * math.cos(a + 0.36), cy + 6 * math.sin(a + 0.36) + 6)
        right = (cx + 6 * math.cos(a - 0.36), cy + 6 * math.sin(a - 0.36) + 6)
        d.polygon([left, tip, right], fill=F[i % len(F)])
        d.line([(cx, cy + 4), (round(tip[0]), round(tip[1]))], fill=F[i % len(F)], width=1)

    # side ear blocks (outlined and carved)
    d.rounded_rectangle([8, 29, 14, 47], radius=2, fill=WOOD_DARK, outline=INK, width=1)
    d.rounded_rectangle([42, 29, 48, 47], radius=2, fill=WOOD_DARK, outline=INK, width=1)
    d.rectangle([10, 33, 12, 43], fill=WOOD)
    d.rectangle([44, 33, 46, 43], fill=WOOD)
    # golden ear rings
    d.rectangle([9, 46, 12, 49], fill=GOLD, outline=INK)
    d.rectangle([44, 46, 47, 49], fill=GOLD, outline=INK)

    # head block + inner highlight rim
    d.rounded_rectangle([13, 14, 43, 58], radius=4, fill=WOOD, outline=INK, width=2)
    d.line([(15, 16), (41, 16)], fill=WOOD_LIGHT)
    d.line([(15, 17), (15, 55)], fill=WOOD_LIGHT)

    # carved brow band with symmetrical zigzags + a coloured forehead gem
    d.rectangle([14, 19, 42, 26], fill=WOOD_DARK, outline=INK)
    for x in (15, 20, 25, 31, 36):
        d.polygon([(x, 25), (x + 2, 20), (x + 5, 25)], fill=WOOD_LIGHT)
    d.polygon([(28, 18), (32, 22), (28, 26), (24, 22)], fill=GEM, outline=INK)
    d.point((27, 21), fill=WHITE)

    # angry brows, glowing eyes with pupils
    d.polygon([(16, 27), (25, 29), (25, 31), (16, 30)], fill=INK)
    d.polygon([(40, 27), (31, 29), (31, 31), (40, 30)], fill=INK)
    d.rectangle([16, 30, 24, 36], fill=TEETH, outline=INK)
    d.rectangle([32, 30, 40, 36], fill=TEETH, outline=INK)
    d.rectangle([19, 31, 22, 35], fill=EYE)
    d.rectangle([34, 31, 37, 35], fill=EYE)
    d.point([(20, 32), (35, 32)], fill=GEM)

    # wide carved nose + cheek spirals
    d.polygon([(25, 33), (31, 33), (33, 43), (23, 43)], fill=WOOD_LIGHT, outline=INK)
    d.point([(25, 41), (26, 41), (30, 41), (31, 41)], fill=INK)
    d.rectangle([16, 39, 20, 43], fill=WOOD_DARK, outline=INK)
    d.rectangle([36, 39, 40, 43], fill=WOOD_DARK, outline=INK)
    d.point([(18, 41), (38, 41)], fill=GEM)

    # big toothy grin
    d.rounded_rectangle([15, 45, 41, 55], radius=3, fill=MOUTH, outline=INK)
    for x in range(17, 38, 5):
        d.rectangle([x, 46, x + 3, 49], fill=TEETH)
        d.line([(x, 49), (x + 3, 49)], fill=TEETH_SHADE)
    for x in range(17, 38, 5):
        d.rectangle([x, 51, x + 3, 54], fill=TEETH)
        d.line([(x, 51), (x + 3, 51)], fill=TEETH_SHADE)

    # chin band + plinth (the colourway's signature colour) with symmetrical zigzags
    d.rectangle([13, 58, 43, 62], fill=WOOD_DARK, outline=INK)
    d.rounded_rectangle([10, 61, 46, 70], radius=2, fill=PLINTH, outline=INK, width=1)
    for x in range(13, 41, 6):
        d.polygon([(x, 69), (x + 2, 63), (x + 5, 69)], fill=WOOD_LIGHT)
    d.line([(11, 70), (45, 70)], fill=INK)

    return img.resize((W * S, H * S), Image.NEAREST)

def main():
    classic = draw_tiki(*COLORWAYS[0])
    classic.save("assets/tiki.png")
    print("tiki.png (classic Freaky statue)")
    for i, cw in enumerate(COLORWAYS):
        draw_tiki(*cw).save(f"assets/tiki_{i}.png")
        print(f"tiki_{i}.png")

if __name__ == "__main__":
    main()
