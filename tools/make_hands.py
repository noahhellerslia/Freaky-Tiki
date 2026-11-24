#!/usr/bin/env python3
"""Original pixel-art grabbing-hand sprites, one per player colourway.

The hand that hovers over a grabbed stacking card wears the grabber's
colours (their tiki's first feather colour, shaded with the second, plus a
carved wooden tiki cuff with their forehead gem), so everyone at the table
can see WHO is holding a card. Drawn on a 28x28 logical grid, upscaled x4 -
same all-original-pixels approach as the deck and tikis.
Outputs assets/hand_0..7.png. Run: python3 tools/make_hands.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from PIL import Image, ImageDraw
except ImportError:
    from _png_canvas import Image, ImageDraw
from make_tiki import COLORWAYS  # noqa: E402

W = H = 28
S = 4
INK = (43, 26, 18, 255)
WOOD = (156, 102, 66, 255)
WOOD_DARK = (104, 66, 38, 255)
WOOD_LIGHT = (194, 138, 90, 255)
WHITE = (255, 246, 224, 255)

def draw_hand(main, shade, gem):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    MAIN = main + (255,)
    SHADE = shade + (255,)
    GEM = gem + (255,)

    # fingers: four rounded columns of slightly different heights
    fingers = [(5, 3, 9, 15), (10, 1, 14, 15), (15, 2, 19, 15), (20, 4, 24, 15)]
    for (x0, y0, x1, y1) in fingers:
        d.rounded_rectangle((x0, y0, x1, y1), radius=2, fill=MAIN, outline=INK, width=1)
        # fingernail / tip highlight
        d.point((x0 + 2, y0 + 2), fill=WHITE)
    # palm
    d.rounded_rectangle([4, 11, 25, 23], radius=4, fill=MAIN, outline=INK, width=1)
    # thumb reaching in from the left, shading tone
    d.polygon([(1, 15), (8, 12), (10, 18), (4, 21)], fill=SHADE, outline=INK)
    # knuckle shading
    for (x0, y0, x1, y1) in fingers:
        d.rectangle([x0 + 1, y1 - 3, x1 - 1, y1 - 2], fill=SHADE)

    # carved wooden tiki cuff at the wrist with the player's gem
    d.rounded_rectangle([5, 21, 24, 27], radius=2, fill=WOOD_DARK, outline=INK, width=1)
    for x in (7, 11, 17, 21):
        d.polygon([(x, 26), (x + 1, 22), (x + 2, 26)], fill=WOOD_LIGHT)
    d.polygon([(14, 22), (16, 24), (14, 26), (12, 24)], fill=GEM, outline=INK)

    return img.resize((W * S, H * S), Image.NEAREST)

def main():
    for i, (feathers, _plinth, gem) in enumerate(COLORWAYS):
        draw_hand(feathers[0], feathers[1], gem).save(f"assets/hand_{i}.png")
        print(f"hand_{i}.png")

if __name__ == "__main__":
    main()
