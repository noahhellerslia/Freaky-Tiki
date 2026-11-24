#!/usr/bin/env python3
"""
Deterministic pixel-art playing cards for Freaky Tiki.
Unified with the carved-wood, torch-gold, and lagoon-teal Tiki aesthetic:
  - Warm parchment card faces with carved wood/gold inner frame accents
  - Royal Tiki court masks on J, Q, K (feathered warrior, gemmed queen, crowned king)
  - Outlined Tiki-Jester Jokers with bells and carved details
  - Carved Tiki idol card back with lagoon-teal and woven bamboo border
All art here is drawn pixel-by-pixel by this script. No external files used.
Native size: 128 x 176 per card (authored on a 64x88 logical grid, S=2).
Render games with NEAREST-neighbour scaling.
"""
import json, math, os, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from PIL import Image, ImageDraw
except ImportError:
    from _png_canvas import Image, ImageDraw

S = 2                    # rasterisation scale: 1 logical pixel = S x S canvas pixels
W, H = 64 * S, 88 * S
OUT = Path(__file__).resolve().parent.parent / "assets" / "cards"
OUT.mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parent.parent / "assets"

# Palette (unified with Freaky Tiki's carved wood, gold, and lagoon colors)
INK       = (26, 28, 44, 255)      # near-black blue, outlines / black suits (verified by verify_cards.py)
RED       = (193, 39, 45, 255)     # red suits (verified by verify_cards.py)
RED_D     = (145, 28, 35, 255)
PAPER     = (250, 244, 232, 255)   # warm parchment card face
PAPER_S   = (216, 198, 170, 255)   # warm tapa shading edge
PAPER_D   = (236, 224, 200, 255)   # court panel fill
GOLD      = (212, 160, 32, 255)    # gold (verified by verify_cards.py)
GOLD_L    = (244, 198, 72, 255)
WOOD      = (156, 102, 66, 255)
WOOD_L    = (194, 138, 90, 255)
WOOD_D    = (104, 66, 38, 255)
WOOD_DEEP = (64, 38, 22, 255)
LAGOON    = (20, 128, 138, 255)
LAGOON_L  = (42, 168, 172, 255)
LAGOON_D  = (12, 74, 88, 255)
WHITE     = (250, 246, 236, 255)
HIBISCUS  = (255, 86, 132, 255)
HIBIS_L   = (255, 146, 178, 255)
HIBIS_D   = (196, 42, 86, 255)
LEAF      = (54, 176, 92, 255)
LEAF_D    = (28, 108, 56, 255)
WAVE_L    = (64, 206, 208, 255)
TEAL_M    = (24, 148, 152, 255)
TEAL_D    = (12, 82, 92, 255)

# ---------- 5x7 rounded pixel font ----------
FONT = {
 'A': ["01110","10001","10001","11111","10001","10001","10001"],
 'E': ["11111","10000","10000","11110","10000","10000","11111"],
 'O': ["01110","10001","10001","10001","10001","10001","01110"],
 'J': ["00111","00010","00010","00010","00010","10010","01100"],
 'Q': ["01110","10001","10001","10001","10101","10010","01101"],
 'K': ["10001","10010","10100","11000","10100","10010","10001"],
 'R': ["11110","10001","10001","11110","10100","10010","10001"],
 '0': ["01110","10001","10001","10001","10001","10001","01110"],
 '1': ["00100","01100","00100","00100","00100","00100","01110"],
 '2': ["01110","10001","00001","00010","00100","01000","11111"],
 '3': ["11111","00010","00100","00010","00001","10001","01110"],
 '4': ["00010","00110","01010","10001","11111","00010","00010"],
 '5': ["11111","10000","11110","00001","00001","10001","01110"],
 '6': ["00110","01000","10000","11110","10001","10001","01110"],
 '7': ["11111","00001","00010","00100","01000","01000","01000"],
 '8': ["01110","10001","10001","01110","10001","10001","01110"],
 '9': ["01110","10001","10001","01111","00001","00010","01100"],
 '*': ["00000","10101","01110","11111","01110","10101","00000"],
}
def text_w(s, scale, sx=None):
    sx = scale if sx is None else sx
    return len(s) * 6 * sx - sx
def draw_text(img, x, y, s, color, scale=2, sx=None, sy=None):
    x, y = x * S, y * S
    sx = int((scale if sx is None else sx) * S)
    sy = int((scale if sy is None else sy) * S)
    d = ImageDraw.Draw(img)
    cx = x
    for ch in s:
        glyph = FONT[ch]
        for gy, row in enumerate(glyph):
            for gx, bit in enumerate(row):
                if bit == '1':
                    d.rectangle([cx+gx*sx, y+gy*sy,
                                 cx+gx*sx+sx-1, y+gy*sy+sy-1], fill=color)
        cx += 6 * sx
    return cx - sx

# ---------- suit shapes (point-in-shape, rasterised = clean pixels) ----------
def in_triangle(px, py, a, b, c):
    def sign(x1,y1,x2,y2,x3,y3): return (x1-x3)*(y2-y3)-(x2-x3)*(y1-y3)
    d1 = sign(px,py,b[0],b[1],c[0],c[1]); d2 = sign(px,py,c[0],c[1],a[0],a[1]); d3 = sign(px,py,a[0],a[1],b[0],b[1])
    neg = (d1<0) or (d2<0) or (d3<0); pos = (d1>0) or (d2>0) or (d3>0)
    return not (neg and pos)
def in_circle(px,py,cx,cy,r): return (px-cx)**2 + (py-cy)**2 <= r*r
def stem(px,py): return in_triangle(px,py,(0.37,0.99),(0.63,0.99),(0.50,0.68))

def suit_filled(suit, u, v):
    """u,v in [0,1], v top->bottom"""
    if suit == 'diamonds':
        return abs(u-0.5) + abs(v-0.5) <= 0.52
    if suit == 'hearts':
        return (in_circle(u,v,0.31,0.32,0.29) or in_circle(u,v,0.69,0.32,0.29)
                or in_triangle(u,v,(0.06,0.38),(0.94,0.38),(0.50,0.97)))
    if suit == 'spades':
        return (in_circle(u,v,0.32,0.62,0.26) or in_circle(u,v,0.68,0.62,0.26)
                or in_triangle(u,v,(0.12,0.58),(0.88,0.58),(0.50,0.04))
                or in_triangle(u,v,(0.40,0.99),(0.60,0.99),(0.50,0.70)))
    if suit == 'clubs':
        return (in_circle(u,v,0.50,0.28,0.27) or in_circle(u,v,0.27,0.62,0.27)
                or in_circle(u,v,0.73,0.62,0.27) or stem(u,v))
    raise ValueError(suit)

SMALL = {
 'hearts': [
  ".XX...XX.",
  "XXXXXXXXX",
  "XXXXXXXXX",
  ".XXXXXXX.",
  ".XXXXXXX.",
  "..XXXXX..",
  "..XXXXX..",
  "...XXX...",
  "....X...."],
 'spades': [
  "....X....",
  "...XXX...",
  "..XXXXX..",
  ".XXXXXXX.",
  "XXXXXXXXX",
  "XXXXXXXXX",
  "XXXX.XXXX",
  "...XXX...",
  "..XXXXX.."],
}
def draw_suit(img, x, y, size, suit, color):
    x, y, size = x * S, y * S, size * S
    d = ImageDraw.Draw(img)
    if size == 9 and suit in SMALL:
        for py, row in enumerate(SMALL[suit]):
            for px, bit in enumerate(row):
                if bit == 'X':
                    d.point((x+px, y+py), fill=color)
        return
    for py in range(size):
        for px in range(size):
            if suit_filled(suit, (px+0.5)/size, (py+0.5)/size):
                d.point((x+px, y+py), fill=color)

# ---------- logical-coordinate helpers (author in 64x88, rasterise at S) ----
def _pt(img, x, y, color):
    ImageDraw.Draw(img).rectangle([x*S, y*S, x*S+S-1, y*S+S-1], fill=color)

def _fill(img, x0, y0, x1, y1, color):
    """Inclusive logical rectangle."""
    ImageDraw.Draw(img).rectangle([x0*S, y0*S, (x1+1)*S-1, (y1+1)*S-1], fill=color)

def _disc(img, cx, cy, r, color):
    d = ImageDraw.Draw(img)
    for Y in range(int((cy-r)*S), int((cy+r)*S) + 1):
        for X in range(int((cx-r)*S), int((cx+r)*S) + 1):
            if in_circle((X+0.5)/S, (Y+0.5)/S, cx, cy, r):
                d.point((X, Y), fill=color)

def _tri(img, a, b, c, color):
    d = ImageDraw.Draw(img)
    xs = [a[0], b[0], c[0]]; ys = [a[1], b[1], c[1]]
    for Y in range(int(min(ys)*S), int(max(ys)*S) + 1):
        for X in range(int(min(xs)*S), int(max(xs)*S) + 1):
            if in_triangle((X+0.5)/S, (Y+0.5)/S, a, b, c):
                d.point((X, Y), fill=color)

# ---------- card base ----------
def rounded_mask():
    m = Image.new("L", (W,H), 0); d = ImageDraw.Draw(m); r = 7 * S
    d.rectangle([r,0,W-r-1,H-1], fill=255); d.rectangle([0,r,W-1,H-r-1], fill=255)
    for cx,cy in [(r,r),(W-r-1,r),(r,H-r-1),(W-r-1,H-r-1)]:
        d.ellipse([cx-r,cy-r,cx+r,cy+r], fill=255)
    for x,y in [(0,0),(1,0),(0,1),(63,0),(62,0),(63,1),(0,87),(1,87),(0,86),(63,87),(62,87),(63,86)]:
        d.rectangle([x*S, y*S, x*S+S-1, y*S+S-1], fill=0)
    return m

MASK = rounded_mask()
def base_card():
    img = Image.new("RGBA", (W,H), (0,0,0,0))
    d = ImageDraw.Draw(img)
    d.rectangle([0,0,W-1,H-1], fill=PAPER)
    d.rectangle([0,0,W-1,H-1], outline=INK, width=2*S)
    d.rectangle([2*S,2*S,W-1-2*S,H-1-2*S], outline=PAPER_S, width=S)
    img.putalpha(MASK)
    return img

def _corner_once(img, rank, suit, color):
    if len(rank) == 1:
        draw_text(img, 4, 4, rank, color, scale=2)
    else:
        draw_text(img, 3, 4, rank, color, sx=1.5, sy=2)
    draw_suit(img, 4, 21, 11, suit, color)

def corner(img, rank, suit, color, flip=False):
    """Top-left corner, or bottom-right flipped 180 degrees."""
    if not flip:
        _corner_once(img, rank, suit, color)
    else:
        tmp = Image.new("RGBA", (W,H), (0,0,0,0))
        _corner_once(tmp, rank, suit, color)
        img.alpha_composite(tmp.rotate(180))

# Pip layouts: (col,row) on a 3-col x 4-row interior grid, standard French deck
PIPS = {
 '2': [(1,0),(1,3)],
 '3': [(1,0),(1,1.5),(1,3)],
 '4': [(0,0),(2,0),(0,3),(2,3)],
 '5': [(0,0),(2,0),(1,1.5),(0,3),(2,3)],
 '6': [(0,0),(2,0),(0,1.5),(2,1.5),(0,3),(2,3)],
 '7': [(0,0),(2,0),(1,0.75),(0,1.5),(2,1.5),(0,3),(2,3)],
 '8': [(0,0),(2,0),(1,0.75),(0,1.5),(2,1.5),(1,2.25),(0,3),(2,3)],
 '9': [(0,0),(2,0),(0,1),(2,1),(1,1.5),(0,2),(2,2),(0,3),(2,3)],
 '10':[(0,0),(2,0),(1,0.5),(0,1),(2,1),(0,2),(2,2),(1,2.5),(0,3),(2,3)],
}
PIP = 9
COL_C = [20, 32, 44]
def _row_c(row): return int(round(25 + row * (38/3)))
def pips(img, rank, suit, color):
    for col,row in PIPS[rank]:
        x = COL_C[int(col)] - PIP//2
        y = _row_c(row) - PIP//2
        draw_suit(img, x, y, PIP, suit, color)

def draw_hibiscus(img, cx, cy, col=HIBISCUS, hi=HIBIS_L, center=GOLD_L):
    _fill(img, cx - 3, cy - 1, cx + 3, cy + 1, LEAF)
    _fill(img, cx - 1, cy - 3, cx + 1, cy + 3, LEAF_D)
    _fill(img, cx - 2, cy - 2, cx + 2, cy + 2, col)
    _pt(img, cx - 2, cy - 2, hi); _pt(img, cx + 2, cy - 2, hi)
    _pt(img, cx, cy - 3, col); _pt(img, cx, cy + 3, col)
    _pt(img, cx - 3, cy, col); _pt(img, cx + 3, cy, col)
    _pt(img, cx, cy, center)

def draw_tiki_face(img, x0, y0, body, light, dark, outline, eye_col, eye_glint, tooth_top, tooth_bot, cheek_col, cheek_center, wild_eyes=False):
    _fill(img, x0, y0, x0 + 21, y0 + 29, outline)
    _fill(img, x0 + 1, y0 + 1, x0 + 20, y0 + 28, body)
    _fill(img, x0 + 1, y0 + 1, x0 + 20, y0 + 2, light)
    _fill(img, x0 + 1, y0 + 1, x0 + 2, y0 + 28, light)
    _fill(img, x0 + 19, y0 + 2, x0 + 20, y0 + 28, dark)
    _fill(img, x0 + 1, y0 + 3, x0 + 20, y0 + 6, dark)
    for gx in range(x0 + 2, x0 + 20, 3):
        _pt(img, gx, y0 + 4, light)
    _fill(img, x0 - 2, y0 + 8, x0, y0 + 17, outline)
    _fill(img, x0 - 1, y0 + 9, x0 - 1, y0 + 16, dark)
    _fill(img, x0 + 21, y0 + 8, x0 + 23, y0 + 17, outline)
    _fill(img, x0 + 22, y0 + 9, x0 + 22, y0 + 16, dark)
    _fill(img, x0 - 1, y0 + 18, x0, y0 + 19, GOLD_L)
    _fill(img, x0 + 21, y0 + 18, x0 + 22, y0 + 19, GOLD_L)
    _fill(img, x0 + 3, y0 + 8, x0 + 7, y0 + 9, outline)
    _fill(img, x0 + 14, y0 + 8, x0 + 18, y0 + 9, outline)
    if wild_eyes:
        _fill(img, x0 + 3, y0 + 10, x0 + 8, y0 + 14, WHITE)
        _fill(img, x0 + 5, y0 + 11, x0 + 7, y0 + 13, INK)
        _pt(img, x0 + 6, y0 + 11, HIBISCUS)
        _fill(img, x0 + 13, y0 + 10, x0 + 18, y0 + 13, GOLD_L)
        _fill(img, x0 + 14, y0 + 11, x0 + 16, y0 + 12, INK)
        _pt(img, x0 + 15, y0 + 11, WAVE_L)
    else:
        _fill(img, x0 + 3, y0 + 10, x0 + 8, y0 + 13, eye_col)
        _fill(img, x0 + 13, y0 + 10, x0 + 18, y0 + 13, eye_col)
        if eye_glint:
            _pt(img, x0 + 5, y0 + 11, eye_glint)
            _pt(img, x0 + 15, y0 + 11, eye_glint)
    _fill(img, x0 + 9, y0 + 10, x0 + 12, y0 + 17, outline)
    _fill(img, x0 + 10, y0 + 10, x0 + 11, y0 + 16, light)
    _fill(img, x0 + 9, y0 + 15, x0 + 12, y0 + 16, light)
    _pt(img, x0 + 9, y0 + 16, outline); _pt(img, x0 + 12, y0 + 16, outline)
    _fill(img, x0 + 3, y0 + 15, x0 + 6, y0 + 17, outline)
    _fill(img, x0 + 4, y0 + 16, x0 + 5, y0 + 16, cheek_col)
    if cheek_center:
        _pt(img, x0 + 4, y0 + 16, cheek_center)
    _fill(img, x0 + 15, y0 + 15, x0 + 18, y0 + 17, outline)
    _fill(img, x0 + 16, y0 + 16, x0 + 17, y0 + 16, cheek_col)
    if cheek_center:
        _pt(img, x0 + 17, y0 + 16, cheek_center)
    _fill(img, x0 + 3, y0 + 20, x0 + 18, y0 + 26, outline)
    for tx in (x0 + 4, x0 + 8, x0 + 12, x0 + 15):
        _fill(img, tx, y0 + 21, tx + 1, y0 + 23, tooth_top)
        _fill(img, tx, y0 + 24, tx + 1, y0 + 25, tooth_bot)

def face_card(img, rank, suit, color):
    """Reef Wave & Hibiscus Royal Tiki court cards (J, Q, K)."""
    d = ImageDraw.Draw(img)
    d.rectangle([16*S, 12*S, (47+1)*S-1, (75+1)*S-1], fill=PAPER_D, outline=LEAF_D, width=S)
    d.rectangle([17*S, 13*S, (46+1)*S-1, (74+1)*S-1], outline=HIBISCUS, width=S)

    if rank == 'J':
        # Tropical warrior plumes in hibiscus & reef wave
        for fx, tx, col in [(20, 17, WAVE_L), (26, 25, HIBISCUS), (31, 32, GOLD_L), (37, 39, HIBISCUS), (41, 46, WAVE_L)]:
            _tri(img, (fx, 25), (fx+2, 25), (tx, 15), col)
        _fill(img, 20, 23, 43, 25, LEAF_D)
    elif rank == 'Q':
        # Feather & hibiscus fan crown
        for fx, tx, col in [(20, 16, WAVE_L), (24, 21, HIBISCUS), (29, 31, GOLD_L), (35, 42, HIBISCUS), (40, 47, WAVE_L)]:
            _tri(img, (fx, 25), (fx+3, 25), (tx, 14), col)
        _fill(img, 20, 23, 43, 25, LEAF)
        draw_hibiscus(img, 32, 23)
    elif rank == 'K':
        # Grand golden crown + reef hibiscus blooms
        _fill(img, 20, 21, 43, 25, GOLD)
        for cx in (21, 27, 34, 40):
            _fill(img, cx, 15, cx+2, 21, GOLD_L)
            _pt(img, cx+1, 15, HIBISCUS)
        draw_hibiscus(img, 19, 23); draw_hibiscus(img, 44, 23)

    draw_tiki_face(img, 21, 25, WOOD, WOOD_L, WOOD_D, WOOD_DEEP, WAVE_L, WHITE, WHITE, PAPER_S, HIBISCUS, GOLD_L)
    _fill(img, 20, 56, 43, 72, LEAF_D)
    _fill(img, 22, 58, 41, 70, PAPER)
    draw_suit(img, 26, 58, 12, suit, color)

SUITS = ['spades','hearts','diamonds','clubs']
SUIT_COLOR = {'spades':INK, 'clubs':INK, 'hearts':RED, 'diamonds':RED}
RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K']

cards = {}  # name -> image
for suit in SUITS:
    color = SUIT_COLOR[suit]
    for rank in RANKS:
        img = base_card()
        corner(img, rank, suit, color); corner(img, rank, suit, color, flip=True)
        if rank == 'A':
            draw_suit(img, 20, 32, 24, suit, color)
        elif rank in ('J','Q','K'):
            face_card(img, rank, suit, color)
        else:
            pips(img, rank, suit, color)
        name = f"{rank}_of_{suit}"
        cards[name] = img

# Card back: Reef Wave & Hibiscus lagoon back with a center Tiki mask emblem
back = Image.new("RGBA",(W,H),(0,0,0,0)); d = ImageDraw.Draw(back)
d.rectangle([0,0,W-1,H-1], fill=WOOD_DEEP)
d.rectangle([0,0,W-1,H-1], outline=INK, width=2*S)
d.rectangle([3*S,3*S,W-1-3*S,H-1-3*S], outline=GOLD, width=2*S)
d.rectangle([6*S,6*S,W-1-6*S,H-1-6*S], fill=LAGOON, outline=WOOD_DEEP, width=S)
for wy in range(12, 76, 10):
    for wx in range(8, 56, 8):
        _fill(back, wx, wy, wx+3, wy, WAVE_L)
        _fill(back, wx+4, wy+1, wx+7, wy+1, LAGOON_L)
for hx, hy in [(11, 11), (52, 11), (11, 76), (52, 76)]:
    draw_hibiscus(back, hx, hy)
for fx, tx, col in [(22, 18, HIBISCUS), (27, 25, WAVE_L), (31, 32, GOLD_L), (36, 40, WAVE_L), (40, 46, HIBISCUS)]:
    _tri(back, (fx, 25), (fx+2, 25), (tx, 16), col)
draw_tiki_face(back, 21, 25, WOOD, WOOD_L, WOOD_D, WOOD_DEEP, WAVE_L, WHITE, WHITE, PAPER_S, HIBISCUS, GOLD_L)
for lx, col in [(20, HIBISCUS), (24, GOLD_L), (28, WHITE), (32, HIBISCUS), (36, GOLD_L), (40, HIBISCUS)]:
    _fill(back, lx, 57, lx+3, 60, LEAF_D)
    _fill(back, lx+1, 58, lx+2, 59, col)
back.putalpha(MASK); cards['card_back'] = back

# Blank front (template / under-card peek)
cards['blank_front'] = base_card()

# Jokers: Reef Wave & Hibiscus lagoon-painted Tiki jester with 3-point hat,
# gold bells, hibiscus ruffle collar, and vertical JOKER lettering down both edges.
def draw_joker(img, col, accent):
    d = ImageDraw.Draw(img)
    d.rectangle([14*S, 10*S, (49+1)*S-1, (77+1)*S-1], fill=PAPER_D, outline=LEAF_D, width=S)
    d.rectangle([15*S, 11*S, (48+1)*S-1, (76+1)*S-1], outline=LAGOON, width=S)
    for i, ch in enumerate("JOKER"):
        draw_text(img, 3, 8 + i * 12, ch, col, scale=1.5)
    tmp = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for i, ch in enumerate("JOKER"):
        draw_text(tmp, 3, 8 + i * 12, ch, col, scale=1.5)
    img.alpha_composite(tmp.rotate(180))
    # 3-point tropical jester crown with gold bells
    y_band = 26
    c1, c2, c3 = (HIBISCUS, accent, HIBISCUS) if col == RED else (WAVE_L, HIBISCUS, WAVE_L)
    _tri(img, (20, y_band), (29, y_band), (14, y_band - 14), c1)
    _tri(img, (27, y_band), (37, y_band), (32, y_band - 17), c2)
    _tri(img, (35, y_band), (44, y_band), (50, y_band - 14), c3)
    _fill(img, 19, y_band - 1, 44, y_band + 2, WOOD_DEEP)
    _fill(img, 20, y_band, 43, y_band + 1, GOLD)
    for bx, by in [(14, y_band - 14), (32, y_band - 17), (50, y_band - 14)]:
        _disc(img, bx, by, 3.2, WOOD_DEEP)
        _disc(img, bx, by, 2.5, GOLD_L)
        _pt(img, bx, by, INK)
    draw_tiki_face(img, 21, 28, TEAL_M, WAVE_L, TEAL_D, INK, GOLD_L, WHITE, WHITE, GOLD_L, HIBISCUS, GOLD_L, wild_eyes=True)
    for i in range(5):
        x = 20 + i * 5
        _tri(img, (x, 59), (x + 5, 59), (x + 2, 70), LEAF if i % 2 == 0 else HIBISCUS)
    draw_hibiscus(img, 23, 62); draw_hibiscus(img, 40, 62)

for name, col, accent in [('joker_red', RED, GOLD), ('joker_black', INK, GOLD)]:
    img = base_card()
    draw_joker(img, col, accent)
    cards[name] = img

# Save individuals
for name, img in cards.items():
    img.save(OUT / f"{name}.png")

# Spritesheet: rows = spades, hearts, diamonds, clubs, extras ; cols = A..K (+ extras in row 5)
rows = []
for suit in SUITS: rows.append([f"{r}_of_{suit}" for r in RANKS])
rows.append(['card_back','joker_red','joker_black','blank_front'] + [None]*9)
cols, nrows = 13, len(rows)
sheet = Image.new("RGBA", (cols*W, nrows*H), (0,0,0,0))
atlas = {}
for ri,row in enumerate(rows):
    for ci,name in enumerate(row):
        if name is None: continue
        sheet.alpha_composite(cards[name], (ci*W, ri*H))
        atlas[name] = {"x": ci*W, "y": ri*H, "w": W, "h": H}
sheet.save(ROOT / "spritesheet.png")
(ROOT / "atlas.json").write_text(json.dumps({"card_size":[W,H],"frames":atlas}, indent=2))

# Preview: 2x nearest-neighbour contact sheet of the whole spritesheet
prev = sheet.resize((sheet.width*2, sheet.height*2), Image.NEAREST)
prev.save(ROOT / "preview.png")

print(f"cards={len(cards)} sheet={sheet.size} files in {OUT}")
