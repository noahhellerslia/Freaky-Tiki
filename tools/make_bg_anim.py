#!/usr/bin/env python3
"""Generate animated pixel-art GIFs for the Freaky Tiki backgrounds and torches:
  - assets/lb_temple_bg.gif : animated volcano lava, rising embers, twinkling
                              stars, flickering temple lights, and lagoon ripples
  - assets/lb_torch.gif     : animated flickering pixel-art tiki torch (transparent)

Pure Python (no Pillow/numpy required). Uses tools/_png_canvas.py.
Run: .venv/bin/python tools/make_bg_anim.py
"""
import os
import random
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _png_canvas import Image, ImageDraw
import make_leaderboard_art as art


def _lzw_encode(indices: list[int], min_code_size: int) -> bytes:
    """Standard GIF variable-width LZW encoder."""
    clear_code = 1 << min_code_size
    eoi_code = clear_code + 1
    code_size = min_code_size + 1
    next_code = eoi_code + 1
    table = {(i,): i for i in range(clear_code)}

    out = bytearray()
    bit_buf = 0
    bit_cnt = 0

    def emit(code: int):
        nonlocal bit_buf, bit_cnt
        bit_buf |= code << bit_cnt
        bit_cnt += code_size
        while bit_cnt >= 8:
            out.append(bit_buf & 0xFF)
            bit_buf >>= 8
            bit_cnt -= 8

    emit(clear_code)
    cur: tuple[int, ...] = ()
    for idx in indices:
        nxt = cur + (idx,)
        if nxt in table:
            cur = nxt
        else:
            emit(table[cur])
            if next_code < 4096:
                table[nxt] = next_code
                next_code += 1
                if next_code > (1 << code_size) and code_size < 12:
                    code_size += 1
            else:
                emit(clear_code)
                table = {(i,): i for i in range(clear_code)}
                code_size = min_code_size + 1
                next_code = eoi_code + 1
            cur = (idx,)
    if cur:
        emit(table[cur])
    emit(eoi_code)
    if bit_cnt > 0:
        out.append(bit_buf & 0xFF)
    return bytes(out)


def save_gif(path: str, frames: list[Image], delay_cs: int = 14, transparent: bool = False) -> None:
    """Write an animated looping GIF89a from a list of RGBA Images."""
    w, h = frames[0].size
    palette: list[tuple[int, int, int]] = [(0, 0, 0)] if transparent else []
    color_map: dict[tuple[int, int, int], int] = {}

    indexed_frames: list[list[int]] = []
    for im in frames:
        idxs: list[int] = []
        for row in im._px:
            for r, g, b, a in row:
                if transparent and a < 128:
                    idxs.append(0)
                else:
                    rgb = (r, g, b)
                    idx = color_map.get(rgb)
                    if idx is None:
                        if len(palette) >= 256:
                            idx = min(
                                range(1 if transparent else 0, len(palette)),
                                key=lambda k: (palette[k][0] - r) ** 2 + (palette[k][1] - g) ** 2 + (palette[k][2] - b) ** 2,
                            )
                        else:
                            idx = len(palette)
                            palette.append(rgb)
                            color_map[rgb] = idx
                    idxs.append(idx)
        indexed_frames.append(idxs)

    # Pad palette to power of 2 (at least 4 colors -> min_code_size >= 2)
    bits = 2
    while (1 << bits) < len(palette):
        bits += 1
    pal_size = 1 << bits
    while len(palette) < pal_size:
        palette.append((0, 0, 0))

    gct = bytearray()
    for r, g, b in palette:
        gct.extend((r, g, b))

    buf = bytearray()
    buf.extend(b"GIF89a")
    buf.extend(struct.pack("<HHBBB", w, h, 0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0))
    buf.extend(gct)
    # NETSCAPE2.0 infinite loop
    buf.extend(b"\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00")

    min_code_size = max(2, bits)
    for idxs in indexed_frames:
        # Graphic Control Extension: disposal=2 (restore to bg) if transparent, else 0
        flags = 0x09 if transparent else 0x04
        buf.extend(struct.pack("<BBBBH", 0x21, 0xF9, 4, flags, delay_cs))
        buf.extend(struct.pack("<BB", 0, 0))
        # Image Descriptor
        buf.extend(struct.pack("<BHHHHB", 0x2C, 0, 0, w, h, 0))
        # Image Data
        buf.append(min_code_size)
        lzw = _lzw_encode(idxs, min_code_size)
        for pos in range(0, len(lzw), 255):
            chunk = lzw[pos:pos + 255]
            buf.append(len(chunk))
            buf.extend(chunk)
        buf.append(0)
    buf.append(0x3B)
    with open(path, "wb") as f:
        f.write(buf)


def make_temple_bg_frames(n_frames: int = 16) -> list[Image]:
    # 544x288 logical grid (upscaled S=2 -> 1088x576)
    W, H, S = 544, 288, 2
    X0, Y0 = 80, 36
    frames: list[Image] = []
    rng = random.Random(42)
    stars = [
        (rng.randint(4, W - 5), rng.randint(4, 118), rng.random() < 0.35, rng.randint(0, 7), rng.random() < 0.25)
        for _ in range(110)
    ]

    SKY_HORIZON = (48, 26, 62, 255)
    SKY_GLOW = (86, 36, 66, 255)
    CLOUD_D = (36, 22, 54, 255)
    CLOUD_L = (64, 38, 82, 255)
    SAND_D = (164, 120, 68, 255)
    SAND_M = (214, 168, 102, 255)
    SAND_L = (244, 212, 152, 255)
    SAND_WET = (138, 102, 64, 255)
    GRASS_D = (20, 82, 46, 255)
    GRASS_M = (42, 138, 70, 255)
    GRASS_L = (92, 196, 106, 255)
    THATCH_D = (122, 80, 36, 255)
    THATCH_M = (172, 120, 56, 255)
    THATCH_L = (218, 170, 92, 255)
    SMOKE_D = (44, 30, 56, 255)
    SMOKE_M = (66, 44, 74, 255)
    SMOKE_L = (94, 58, 84, 255)
    BASALT_DEEP = (28, 12, 16, 255)
    VOLC_HI = (158, 68, 42, 255)
    VOLC_ASH = (66, 38, 46, 255)
    LAVA_CRUST = (96, 26, 20, 255)
    SAND_ASH = (132, 98, 66, 255)
    ASH_SOIL = (94, 62, 46, 255)
    MAGMA_ROCK_D = (56, 26, 24, 255)
    MAGMA_ROCK_M = (78, 36, 28, 255)
    TIKI_COLORS = [
        (244, 185, 66, 255),
        (255, 105, 180, 255),
        (0, 229, 255, 255),
        (190, 242, 100, 255),
    ]

    for f in range(n_frames):
        img = Image.new("RGBA", (W, H), art.SKY_TOP)
        d = ImageDraw.Draw(img)

        # Dithered twilight sky gradient with volcanic horizon glow
        d.rectangle([0, 0, W, 56], fill=art.SKY_TOP)
        d.rectangle([0, 56, W, 98], fill=art.SKY_MID)
        d.rectangle([0, 98, W, 132], fill=art.SKY_LOW)
        d.rectangle([0, 132, W, 154], fill=SKY_HORIZON)
        d.rectangle([240, 136, W, 162], fill=SKY_GLOW)
        for y, c_hi in [(56, art.SKY_TOP), (98, art.SKY_MID), (132, art.SKY_LOW)]:
            for x in range(0, W, 2):
                d.point((x, y), fill=c_hi)
                d.point((x + 1, y + 2), fill=c_hi)

        # Twinkling stars
        for sx, sy, is_gold, phase, big in stars:
            t = (f // 2 + phase) % 8
            if t == 0:
                col = art.LAVA_CORE
            elif t in (3, 4):
                continue
            else:
                col = art.STAR_2 if is_gold else art.STAR_1
            d.point((sx, sy), fill=col)
            if big and t in (1, 2):
                d.point([(sx - 1, sy), (sx + 1, sy), (sx, sy - 1), (sx, sy + 1)], fill=col)

        # Crescent moon with soft night halo
        d.ellipse([44, 14, 88, 58], fill=art.SKY_MID)
        d.ellipse([52, 20, 80, 48], fill=art.MOON)
        d.ellipse([62, 18, 88, 44], fill=art.SKY_TOP)
        d.point([(56, 28), (57, 29), (58, 36), (59, 37), (62, 42)], fill=art.MOON_SHADE)

        # Soft drifting pixel clouds
        c_shift = f
        for cx, cy, cw in [(130, 34, 48), (275, 24, 56), (430, 44, 42)]:
            ox = (cx + c_shift) % (W + 60) - 30
            d.ellipse([ox, cy, ox + cw, cy + 12], fill=CLOUD_D)
            d.ellipse([ox + 8, cy - 5, ox + cw - 8, cy + 8], fill=CLOUD_L)
            d.ellipse([ox + 4, cy + 3, ox + cw - 6, cy + 11], fill=CLOUD_D)

        # ---- Left side: Continuous Lush Tropical Tiki Island (no shoreline) ----
        d.rectangle([0, 122 + Y0, 240 + X0, H], fill=GRASS_D)
        d.polygon([(-2, 134 + Y0), (24, 102 + Y0), (88 + X0, 86 + Y0), (168 + X0, 96 + Y0), (232 + X0, 136 + Y0), (232 + X0, 160 + Y0), (-2, 160 + Y0)], fill=GRASS_D, outline=art.INK)
        d.polygon([(-2, 134 + Y0), (34, 106 + Y0), (92 + X0, 92 + Y0), (160 + X0, 102 + Y0), (214 + X0, 134 + Y0), (214 + X0, 154 + Y0), (-2, 154 + Y0)], fill=GRASS_M)
        d.line([(36, 106 + Y0), (92 + X0, 93 + Y0), (156 + X0, 102 + Y0)], fill=GRASS_L)
        # Tropical bushes on ridge
        for bx, by, br in [(18, 114 + Y0, 10), (74 + X0, 98 + Y0, 9), (144 + X0, 104 + Y0, 10), (190 + X0, 118 + Y0, 9)]:
            d.ellipse([bx - br, by - br + 2, bx + br, by + br - 2], fill=GRASS_D)
            d.ellipse([bx - br + 2, by - br + 2, bx + br - 2, by + br - 4], fill=GRASS_M)
            d.point([(bx - 2, by - 3), (bx + 2, by - 2)], fill=GRASS_L)

        # Warm sandy island clearing extending smoothly across the foreground (3 textured height levels)
        pit_x = 236 + X0
        d.polygon([(-2, 136 + Y0), (18, 120 + Y0), (192 + X0, 118 + Y0), (234 + X0, 138 + Y0), (234 + X0, H), (-2, H)], fill=SAND_M)
        d.line([(-2, 122 + Y0), (190 + X0, 121 + Y0)], fill=SAND_L)
        # Level 1 (upper clearing): subtle wind-swept grain & sunlit speckles
        sand_rng = random.Random(77)
        for _ in range(70):
            gx = sand_rng.randint(4, pit_x - 30)
            gy = sand_rng.randint(124 + Y0, 150 + Y0)
            d.point((gx, gy), fill=SAND_L if sand_rng.random() < 0.45 else SAND_D)
        for sx in range(14, pit_x - 44, 42):
            d.line([(sx, 132 + Y0), (sx + 10, 131 + Y0), (sx + 18, 132 + Y0)], fill=SAND_L)

        # Level 2 (mid-level dune shelf): undulating ridge at 152+Y0 with ripples & pebbles
        mid_pts = [(-2, 154 + Y0)]
        for rx in range(0, pit_x + 12, 18):
            ry = 152 + Y0 + (2 if (rx // 18) % 2 == 0 else -1)
            mid_pts.append((rx, ry))
        mid_pts += [(pit_x + 12, H), (-2, H)]
        d.polygon(mid_pts, fill=SAND_M)
        for rx in range(0, pit_x - 20, 18):
            ry = 152 + Y0 + (2 if (rx // 18) % 2 == 0 else -1)
            d.line([(rx, ry), (rx + 18, 152 + Y0 + (2 if ((rx // 18) + 1) % 2 == 0 else -1))], fill=SAND_L)
        for sx in range(8, pit_x - 42, 32):
            d.line([(sx, 165 + Y0), (sx + 10, 163 + Y0), (sx + 20, 165 + Y0)], fill=SAND_L)
            d.line([(sx + 1, 166 + Y0), (sx + 10, 164 + Y0), (sx + 19, 166 + Y0)], fill=SAND_D)
            d.line([(sx + 10, 177 + Y0), (sx + 20, 175 + Y0), (sx + 28, 177 + Y0)], fill=SAND_D)
        for _ in range(95):
            gx = sand_rng.randint(4, pit_x - 28)
            gy = sand_rng.randint(154 + Y0, 188 + Y0)
            d.point((gx, gy), fill=SAND_L if sand_rng.random() < 0.4 else SAND_D)

        # Level 3 (lower foreground sand): wavy dithered ridge at 188+Y0 with deeper ripples & pebbles
        low_pts = [(-2, 190 + Y0)]
        for rx in range(0, pit_x + 4, 16):
            ry = 188 + Y0 + (2 if (rx // 16) % 2 == 0 else -2)
            low_pts.append((rx, ry))
        low_pts += [(pit_x, H), (-2, H)]
        d.polygon(low_pts, fill=SAND_D)
        for sx in range(0, pit_x - 36, 4):
            ry = 188 + Y0 + (2 if (sx // 16) % 2 == 0 else -2)
            d.point((sx, ry - 1), fill=SAND_M)
            d.point((sx + 2, ry + 1), fill=SAND_WET)
        for sx in range(12, pit_x - 44, 34):
            d.line([(sx, 202 + Y0), (sx + 10, 200 + Y0), (sx + 22, 202 + Y0)], fill=SAND_M)
            d.line([(sx + 1, 203 + Y0), (sx + 10, 201 + Y0), (sx + 21, 203 + Y0)], fill=SAND_WET)
            d.line([(sx + 8, 222 + Y0), (sx + 18, 220 + Y0), (sx + 28, 222 + Y0)], fill=SAND_WET)
        for _ in range(110):
            gx = sand_rng.randint(4, pit_x - 28)
            gy = sand_rng.randint(192 + Y0, H - 2)
            d.point((gx, gy), fill=SAND_M if sand_rng.random() < 0.35 else SAND_WET)
        for px, py in [(28, 208 + Y0), (88, 218 + Y0), (138, 196 + Y0), (206, 226 + Y0)]:
            d.rectangle([px, py, px + 2, py + 1], fill=SAND_ASH)
            d.point((px, py), fill=SAND_M)

        # Organic ash-to-sand blend on the eastern island slope near the volcano
        d.polygon([(194 + X0, 130 + Y0), (218 + X0, 134 + Y0), (234 + X0, 144 + Y0), (234 + X0, 160 + Y0), (184 + X0, 160 + Y0)], fill=SAND_ASH)
        d.polygon([(208 + X0, 138 + Y0), (234 + X0, 142 + Y0), (234 + X0, 160 + Y0), (200 + X0, 160 + Y0)], fill=ASH_SOIL)
        for sx in range(182 + X0, 224 + X0, 4):
            d.point((sx, 142 + Y0), fill=SAND_ASH)
            d.point((sx + 2, 146 + Y0), fill=ASH_SOIL)

        # Winding packed-sand & stepping-stone path from hut running in front of the tiki bar
        HX = X0 + 10
        path_pts = [
            (102 + HX, 122 + Y0), (104 + HX, 134 + Y0), (112 + HX, 148 + Y0),
            (186, 158 + Y0), (218, 160 + Y0), (246, 160 + Y0),
            (250, 176 + Y0), (226, 200 + Y0), (198, 226 + Y0), (184, H)
        ]
        fire_pts = [(76, 146 + Y0), (114, 140 + Y0), (138, 132 + Y0), (103 + HX, 128 + Y0)]
        # Draw all outer SAND_D borders first so the firepit branch merges seamlessly into the hut trail
        for i in range(len(path_pts) - 1):
            d.line([path_pts[i], path_pts[i + 1]], fill=SAND_D, width=14)
        for i in range(len(fire_pts) - 1):
            d.line([fire_pts[i], fire_pts[i + 1]], fill=SAND_D, width=10)
        # Draw all inner SAND_L centers on top for a seamless junction
        for i in range(len(path_pts) - 1):
            d.line([path_pts[i], path_pts[i + 1]], fill=SAND_L, width=8)
        for i in range(len(fire_pts) - 1):
            d.line([fire_pts[i], fire_pts[i + 1]], fill=SAND_L, width=5)
        for sx, sy in [
            (103 + HX, 128 + Y0), (108 + HX, 142 + Y0), (186, 158 + Y0),
            (214, 160 + Y0), (242, 160 + Y0), (248, 176 + Y0),
            (224, 200 + Y0), (198, 224 + Y0),
            (116, 139 + Y0), (138, 132 + Y0)
        ]:
            d.ellipse([sx - 5, sy - 2, sx + 5, sy + 2], fill=art.STONE_M, outline=art.STONE_D)
            d.point((sx - 2, sy - 1), fill=art.STONE_L)

        # Detailed Thatched Tiki Hut (shifted right)
        # Main timber walls + woven bamboo slats + corner support posts
        d.rectangle([74 + HX, 91 + Y0, 130 + HX, 121 + Y0], fill=art.WOOD_D, outline=art.INK)
        d.rectangle([78 + HX, 94 + Y0, 126 + HX, 120 + Y0], fill=art.WOOD_M)
        for wy in range(97 + Y0, 119 + Y0, 4):
            d.line([(79 + HX, wy), (125 + HX, wy)], fill=art.WOOD_D)
        for wx in (76 + HX, 128 + HX):
            d.line([(wx, 92 + Y0), (wx, 120 + Y0)], fill=art.WOOD_L, width=2)
            for wy in range(95 + Y0, 120 + Y0, 5):
                d.point((wx, wy), fill=art.INK)
        # Stone/wood porch step
        d.rectangle([91 + HX, 119 + Y0, 113 + HX, 122 + Y0], fill=art.WOOD_L, outline=art.INK)
        # Shuttered glowing side windows
        win_col = art.LAVA_L if (f // 4) % 2 == 0 else art.LAVA_M
        for win_x in (81 + HX, 115 + HX):
            d.rectangle([win_x, 100 + Y0, win_x + 8, 108 + Y0], fill=art.WOOD_D, outline=art.INK)
            d.rectangle([win_x + 2, 102 + Y0, win_x + 6, 106 + Y0], fill=win_col)
            d.line([(win_x + 4, 100 + Y0), (win_x + 4, 108 + Y0)], fill=art.WOOD_D)
        # Carved arched doorway with warm hearth glow & keystone mask
        door_col = art.LAVA_L if (f // 2) % 3 != 0 else art.LAVA_CORE
        d.rectangle([94 + HX, 99 + Y0, 110 + HX, 120 + Y0], fill=art.WOOD_HI, outline=art.INK)
        d.rectangle([96 + HX, 102 + Y0, 108 + HX, 119 + Y0], fill=art.LAVA_M, outline=art.INK)
        d.rectangle([98 + HX, 104 + Y0, 106 + HX, 118 + Y0], fill=door_col)
        d.rectangle([100 + HX, 108 + Y0, 104 + HX, 117 + Y0], fill=art.LAVA_CORE)
        # Mini carved keystone mask above doorway
        d.rectangle([99 + HX, 96 + Y0, 105 + HX, 101 + Y0], fill=art.WOOD_L, outline=art.INK)
        d.point([(100 + HX, 98 + Y0), (104 + HX, 98 + Y0)], fill=art.LAVA_CORE)
        # Layered shaggy thatched roof + crossed bamboo apex poles
        d.line([(97 + HX, 62 + Y0), (107 + HX, 71 + Y0)], fill=art.WOOD_L, width=2)
        d.line([(107 + HX, 62 + Y0), (97 + HX, 71 + Y0)], fill=art.WOOD_L, width=2)
        d.polygon([(63 + HX, 94 + Y0), (102 + HX, 64 + Y0), (141 + HX, 94 + Y0)], fill=THATCH_D, outline=art.INK)
        d.polygon([(68 + HX, 92 + Y0), (102 + HX, 67 + Y0), (136 + HX, 92 + Y0)], fill=THATCH_M)
        d.polygon([(78 + HX, 84 + Y0), (102 + HX, 68 + Y0), (126 + HX, 84 + Y0)], fill=THATCH_L)
        for tx_rib in (-22, -14, -6, 6, 14, 22):
            d.line([(102 + HX, 69 + Y0), (102 + HX + tx_rib, 91 + Y0)], fill=THATCH_D)
        # Shaggy eave fringe + hanging amber lanterns
        for ex in range(65 + HX, 140 + HX, 4):
            d.line([(ex, 93 + Y0), (ex, 95 + Y0)], fill=THATCH_D)
        for lan_x in (69 + HX, 135 + HX):
            d.line([(lan_x, 94 + Y0), (lan_x, 97 + Y0)], fill=art.INK)
            d.rectangle([lan_x - 1, 97 + Y0, lan_x + 1, 100 + Y0], fill=art.LAVA_CORE if (f // 2) % 2 == 0 else art.LAVA_L, outline=art.INK)

        # Curved Palm Trees with coconuts & feathered fronds
        sway = 2 if (f // 4) % 2 == 1 else 0
        for tx, ty, lean in [(36, 120 + Y0, 7), (26 + X0, 120 + Y0, 6), (176 + X0, 120 + Y0, -7)]:
            mid_x = tx + lean // 2
            mid_y = ty - 22
            cx = tx + lean
            cy = ty - 46
            d.line([(tx, ty), (mid_x, mid_y), (cx, cy)], fill=art.WOOD_D, width=5)
            d.line([(tx, ty), (mid_x, mid_y), (cx, cy)], fill=art.WOOD_L, width=2)
            for step_i in range(1, 7):
                frac = step_i / 7.0
                px = int(tx + lean * frac)
                py = int(ty - 46 * frac)
                d.line([(px - 2, py), (px + 2, py)], fill=art.INK)
            # Coconuts
            d.ellipse([cx - 4, cy + 1, cx, cy + 5], fill=art.WOOD_D, outline=art.INK)
            d.ellipse([cx, cy + 2, cx + 4, cy + 6], fill=art.WOOD_D, outline=art.INK)
            # Feathered palm fronds
            for fx, fy in [(-26, -6 + sway), (-20, -18), (-4, -22 + sway), (14, -18), (26, -6 - sway)]:
                mx = cx + fx // 2
                my = cy + fy // 2 - 4
                d.line([(cx, cy), (mx, my), (cx + fx, cy + fy)], fill=art.LEAF_D, width=3)
                d.line([(cx, cy - 1), (mx, my - 1), (cx + fx, cy + fy - 1)], fill=art.LEAF_M, width=1)
                d.point((cx + fx // 2, cy + fy // 2 - 2), fill=GRASS_L)

        def draw_player_tiki(kx, by, gem_col, fset, has_feathers=True, has_base=True):
            if has_feathers:
                for fi, (fdx, fh) in enumerate([(-7, 4), (-4, 6), (0, 8), (4, 6), (7, 4)]):
                    fcol = fset[fi % len(fset)]
                    d.line([(kx + fdx // 2, by - 23), (kx + fdx, by - 23 - fh)], fill=fcol, width=1)
            # Ears + gold square earrings
            d.rectangle([kx - 9, by - 16, kx - 7, by - 8], fill=art.WOOD_M, outline=art.INK)
            d.rectangle([kx + 7, by - 16, kx + 9, by - 8], fill=art.WOOD_M, outline=art.INK)
            d.rectangle([kx - 9, by - 7, kx - 8, by - 6], fill=art.STAR_2, outline=art.INK)
            d.rectangle([kx + 8, by - 7, kx + 9, by - 6], fill=art.STAR_2, outline=art.INK)
            # Main carved wooden head
            d.rectangle([kx - 7, by - 23, kx + 7, by - 4], fill=art.WOOD_M, outline=art.INK)
            # Brow band with dark zigzag triangles + center diamond gem
            d.rectangle([kx - 6, by - 21, kx + 6, by - 18], fill=art.WOOD_HI)
            for zx in range(kx - 5, kx + 6, 3):
                d.point([(zx, by - 21), (zx, by - 20)], fill=art.WOOD_D)
            d.point([(kx, by - 21), (kx - 1, by - 20), (kx, by - 20), (kx + 1, by - 20), (kx, by - 19)], fill=gem_col)
            # Heavy dark brow + tall rectangular white eyes with colored glint
            d.line([(kx - 6, by - 17), (kx + 6, by - 17)], fill=art.INK)
            d.rectangle([kx - 5, by - 16, kx - 2, by - 13], fill=art.STAR_1, outline=art.INK)
            d.rectangle([kx + 2, by - 16, kx + 5, by - 13], fill=art.STAR_1, outline=art.INK)
            d.rectangle([kx - 4, by - 15, kx - 3, by - 14], fill=art.INK)
            d.rectangle([kx + 3, by - 15, kx + 4, by - 14], fill=art.INK)
            d.point([(kx - 3, by - 15), (kx + 3, by - 15)], fill=gem_col)
            # Broad trapezoid nose + cheek studs
            d.rectangle([kx - 1, by - 14, kx + 1, by - 11], fill=art.WOOD_HI, outline=art.INK)
            d.point([(kx - 5, by - 11), (kx + 5, by - 11)], fill=gem_col)
            # Big 2-row grinning white teeth
            d.rectangle([kx - 5, by - 9, kx + 5, by - 5], fill=art.STAR_1, outline=art.INK)
            d.line([(kx - 4, by - 7), (kx + 4, by - 7)], fill=art.INK)
            for tx_t in (kx - 3, kx - 1, kx + 1, kx + 3):
                d.point([(tx_t, by - 8), (tx_t, by - 6)], fill=art.INK)
            if has_base:
                d.rectangle([kx - 8, by - 4, kx + 8, by], fill=art.WOOD_D, outline=art.INK)
                for bx_z in range(kx - 6, kx + 7, 3):
                    d.point([(bx_z, by - 2), (bx_z, by - 1)], fill=gem_col)

        feather_sets = [
            [(20, 148, 136, 255), (235, 108, 72, 255), (244, 185, 66, 255), (200, 56, 48, 255)],
            [(255, 80, 165, 255), (176, 108, 224, 255), (255, 130, 195, 255), (218, 178, 240, 255)],
            [(0, 229, 255, 255), (72, 168, 255, 255), (190, 242, 100, 255), (244, 185, 66, 255)],
            [(190, 242, 100, 255), (61, 220, 151, 255), (244, 185, 66, 255), (255, 138, 61, 255)],
        ]

        # Three Tikis Stacked on Top of Each Other (replaces tall tiki)
        d.rectangle([39 + X0, 118 + Y0, 63 + X0, 122 + Y0], fill=art.STONE_D, outline=art.INK)
        d.line([(40 + X0, 119 + Y0), (62 + X0, 119 + Y0)], fill=art.STONE_L)
        draw_player_tiki(51 + X0, 118 + Y0, TIKI_COLORS[0], feather_sets[0], has_feathers=False, has_base=True)
        draw_player_tiki(51 + X0, 96 + Y0, TIKI_COLORS[1], feather_sets[1], has_feathers=False, has_base=True)
        draw_player_tiki(51 + X0, 74 + Y0, TIKI_COLORS[2], feather_sets[2], has_feathers=True, has_base=True)

        # Detailed Island Tiki Torches (hut centered evenly between its two flanking torches)
        for idx, (torch_x, torch_y) in enumerate([(20, 108 + Y0), (58 + HX, 104 + Y0), (146 + HX, 104 + Y0), (204 + X0, 108 + Y0)]):
            d.rectangle([torch_x - 3, torch_y + 15, torch_x + 3, torch_y + 17], fill=art.STONE_D, outline=art.INK)
            d.rectangle([torch_x - 1, torch_y, torch_x + 1, torch_y + 16], fill=art.WOOD_D, outline=art.INK)
            d.line([(torch_x, torch_y + 1), (torch_x, torch_y + 15)], fill=art.WOOD_L)
            for node_y in (torch_y + 4, torch_y + 9, torch_y + 13):
                d.line([(torch_x - 1, node_y), (torch_x + 1, node_y)], fill=art.INK)
            d.polygon([(torch_x - 3, torch_y - 3), (torch_x + 3, torch_y - 3), (torch_x + 2, torch_y + 1), (torch_x - 2, torch_y + 1)], fill=art.WOOD_M, outline=art.INK)
            d.line([(torch_x - 2, torch_y - 2), (torch_x + 2, torch_y - 2)], fill=art.WOOD_HI)
            fl_x = torch_x + (1 if ((f // 2) + idx) % 2 == 0 else -1)
            fl_h = 10 + ((f // 2 + idx) % 2)
            d.polygon([(fl_x, torch_y - fl_h), (torch_x - 3, torch_y - 4), (torch_x + 3, torch_y - 4)], fill=art.LAVA_D)
            d.polygon([(fl_x, torch_y - fl_h + 2), (torch_x - 2, torch_y - 3), (torch_x + 2, torch_y - 3)], fill=art.LAVA_M)
            d.rectangle([torch_x - 1, torch_y - 6, torch_x + 1, torch_y - 3], fill=art.LAVA_L)
            d.point((torch_x, torch_y - 4), fill=art.LAVA_CORE)
            sp_y = torch_y - fl_h - 1 - ((f + idx) % 3)
            d.point((fl_x, sp_y), fill=art.LAVA_L)

        # Firepit on the LEFT side of the path with Tikis gathered around it
        fp_x, fp_y = 72, 146 + Y0
        # Warm firelight glow on the sand around the firepit
        d.ellipse([fp_x - 28, fp_y - 10, fp_x + 28, fp_y + 13], fill=(228, 174, 96, 255))
        d.ellipse([fp_x - 17, fp_y - 6, fp_x + 17, fp_y + 8], fill=(242, 190, 108, 255))
        # Back tikis around firepit (drawn behind flames)
        for idx, (kx, ky) in enumerate([(52, 140 + Y0), (92, 140 + Y0)]):
            bob = -2 if (((f // 2) + idx) % 4 < 2) else 0
            draw_player_tiki(kx, ky + bob, TIKI_COLORS[idx % len(TIKI_COLORS)], feather_sets[idx % len(feather_sets)])
        # Stone ring + crossed logs + animated firepit flames
        for ang_x, ang_y in [(-10, -2), (-6, -4), (0, -5), (6, -4), (10, -2), (-9, 3), (-4, 5), (2, 5), (8, 4)]:
            d.ellipse([fp_x + ang_x - 2, fp_y + ang_y - 2, fp_x + ang_x + 2, fp_y + ang_y + 2], fill=art.STONE_D, outline=art.INK)
            d.point((fp_x + ang_x - 1, fp_y + ang_y - 1), fill=art.STONE_L)
        d.line([(fp_x - 6, fp_y + 2), (fp_x + 6, fp_y - 2)], fill=art.WOOD_D, width=2)
        d.line([(fp_x - 6, fp_y - 2), (fp_x + 6, fp_y + 2)], fill=art.WOOD_M, width=2)
        fx_off = 1 if (f // 2) % 2 == 0 else -1
        d.polygon([(fp_x + fx_off, fp_y - 14), (fp_x - 7, fp_y), (fp_x + 7, fp_y)], fill=art.LAVA_D)
        d.polygon([(fp_x + fx_off, fp_y - 11), (fp_x - 5, fp_y), (fp_x + 5, fp_y)], fill=art.LAVA_M)
        d.polygon([(fp_x, fp_y - 7), (fp_x - 3, fp_y), (fp_x + 3, fp_y)], fill=art.LAVA_L)
        d.rectangle([fp_x - 1, fp_y - 3, fp_x + 1, fp_y], fill=art.LAVA_CORE)
        for sp_i in range(3):
            sp_y = fp_y - 14 - ((f + sp_i * 4) % 10)
            sp_x = fp_x + ((sp_i - 1) * 3) + (1 if (f + sp_i) % 2 else -1)
            d.point((sp_x, sp_y), fill=art.LAVA_L if sp_i % 2 else art.LAVA_CORE)
        # Front tikis around firepit (left side of path)
        for idx, (kx, ky) in enumerate([(42, 158 + Y0), (102, 158 + Y0)]):
            bob = -2 if (((f // 2) + idx + 2) % 4 < 2) else 0
            c_idx = (idx + 2) % len(TIKI_COLORS)
            draw_player_tiki(kx, ky + bob, TIKI_COLORS[c_idx], feather_sets[c_idx])

        # ---- Right side of the path: Detailed Tiki Bar + Small Stacked Tikis on either side ----
        bar_x, bar_y = 236, 148 + Y0
        # Helper for small 2-high stacked tiki totems flanking the bar
        def draw_mini_stacked_tiki(mx, my, c1, c2, fset):
            d.rectangle([mx - 6, my - 2, mx + 6, my], fill=art.STONE_D, outline=art.INK)
            for lvl, col in enumerate([c1, c2]):
                ty = my - 2 - lvl * 12
                d.rectangle([mx - 5, ty - 12, mx + 5, ty], fill=art.WOOD_M, outline=art.INK)
                d.rectangle([mx - 4, ty - 11, mx + 4, ty - 9], fill=art.WOOD_HI)
                d.point((mx, ty - 10), fill=col)
                # Dark brow + crisp white eyes with dark pupils
                d.line([(mx - 4, ty - 8), (mx + 4, ty - 8)], fill=art.INK)
                d.rectangle([mx - 4, ty - 7, mx - 2, ty - 5], fill=art.STAR_1)
                d.rectangle([mx + 2, ty - 7, mx + 4, ty - 5], fill=art.STAR_1)
                d.point((mx - 3, ty - 6), fill=art.INK)
                d.point((mx + 3, ty - 6), fill=art.INK)
                d.rectangle([mx - 3, ty - 4, mx + 3, ty - 2], fill=art.STAR_1, outline=art.INK)
                d.line([(mx - 2, ty - 3), (mx + 2, ty - 3)], fill=art.INK)
            # Top feathers on mini totem
            top_y = my - 24
            for fi, (fdx, fh) in enumerate([(-4, 3), (0, 5), (4, 3)]):
                d.line([(mx + fdx // 2, top_y), (mx + fdx, top_y - fh)], fill=fset[fi % len(fset)], width=1)

        # Tiki Bar shadow on sand
        d.ellipse([bar_x - 24, bar_y - 3, bar_x + 24, bar_y + 5], fill=SAND_D)
        # Back wall / shelves with colorful bottles & mugs
        d.rectangle([bar_x - 16, bar_y - 24, bar_x + 16, bar_y - 8], fill=art.WOOD_D, outline=art.INK)
        d.line([(bar_x - 14, bar_y - 18), (bar_x + 14, bar_y - 18)], fill=art.WOOD_HI)
        d.line([(bar_x - 14, bar_y - 13), (bar_x + 14, bar_y - 13)], fill=art.WOOD_HI)
        bottle_cols = [TIKI_COLORS[0], TIKI_COLORS[1], art.STAR_2, art.LEAF_L, art.LAVA_M]
        for bi, bx in enumerate(range(bar_x - 12, bar_x + 13, 5)):
            bc = bottle_cols[bi % len(bottle_cols)]
            d.rectangle([bx, bar_y - 22, bx + 2, bar_y - 19], fill=bc)
            d.point((bx + 1, bar_y - 23), fill=art.STAR_1)
            d.rectangle([bx, bar_y - 16, bx + 2, bar_y - 14], fill=bottle_cols[(bi + 2) % len(bottle_cols)])
        # Corner bamboo posts
        for px in (bar_x - 18, bar_x + 17):
            d.rectangle([px - 1, bar_y - 26, px + 1, bar_y], fill=art.WOOD_L, outline=art.INK)
        # Bar counter with carved wood trim & bamboo slats
        d.rectangle([bar_x - 20, bar_y - 10, bar_x + 20, bar_y], fill=art.WOOD_M, outline=art.INK)
        d.rectangle([bar_x - 21, bar_y - 12, bar_x + 21, bar_y - 9], fill=art.WOOD_HI, outline=art.INK)
        for sx in range(bar_x - 16, bar_x + 17, 4):
            d.line([(sx, bar_y - 8), (sx, bar_y - 1)], fill=art.WOOD_D)
        # Drink mugs on the bar top
        d.rectangle([bar_x - 10, bar_y - 15, bar_x - 7, bar_y - 12], fill=TIKI_COLORS[0], outline=art.INK)
        d.point((bar_x - 8, bar_y - 16), fill=TIKI_COLORS[1])
        d.rectangle([bar_x + 6, bar_y - 15, bar_x + 9, bar_y - 12], fill=art.STAR_2, outline=art.INK)
        d.point((bar_x + 8, bar_y - 16), fill=art.LEAF_L)
        # Thatched overhanging bar roof
        d.polygon([(bar_x - 23, bar_y - 25), (bar_x + 23, bar_y - 25), (bar_x + 17, bar_y - 35), (bar_x - 17, bar_y - 35)], fill=THATCH_M, outline=art.INK)
        d.polygon([(bar_x - 19, bar_y - 27), (bar_x + 19, bar_y - 27), (bar_x + 14, bar_y - 34), (bar_x - 14, bar_y - 34)], fill=THATCH_L)
        for tx_t in range(bar_x - 20, bar_x + 21, 4):
            d.line([(tx_t, bar_y - 26), (tx_t, bar_y - 24)], fill=THATCH_D)
        # Twinkling string lights under the eaves
        for li, lx in enumerate(range(bar_x - 16, bar_x + 17, 6)):
            on = ((f // 3 + li) % 2) == 0
            d.point((lx, bar_y - 24), fill=art.LAVA_CORE if on else art.LAVA_M)
        # Barstools in front of the counter
        for bsx in (bar_x - 11, bar_x, bar_x + 11):
            d.line([(bsx, bar_y - 3), (bsx, bar_y + 2)], fill=art.WOOD_D, width=2)
            d.rectangle([bsx - 3, bar_y - 5, bsx + 3, bar_y - 3], fill=art.WOOD_HI, outline=art.INK)
        # Small stacked tikis on either side of the Tiki Bar
        draw_mini_stacked_tiki(bar_x - 29, bar_y + 1, TIKI_COLORS[0], TIKI_COLORS[1], feather_sets[0])
        draw_mini_stacked_tiki(bar_x + 29, bar_y + 1, TIKI_COLORS[2], TIKI_COLORS[3], feather_sets[2])

        # ---- Right side: Craggy Detailed Volcano with Coherent Ridges & Lava Paths ----
        for s_i in range(6):
            sy = 34 + Y0 - ((f * 3 + s_i * 8) % 48)
            sx = 304 + X0 + ((f // 2 + s_i * 2) % 7) - 3
            sr = 6 + (34 + Y0 - sy) // 6
            scol = SMOKE_L if sy > 18 + Y0 else (SMOKE_M if sy > 4 + Y0 else SMOKE_D)
            d.ellipse([sx - sr, sy - sr // 2, sx + sr, sy + sr // 2], fill=scol)
            if sy > 20 + Y0:
                d.line([(sx - sr // 2, sy + sr // 3), (sx + sr // 2, sy + sr // 3)], fill=art.LAVA_D)

        # Main volcano body with craggy stepped basalt silhouette
        d.polygon([
            (214 + X0, 154 + Y0), (230 + X0, 134 + Y0), (242 + X0, 118 + Y0),
            (252 + X0, 96 + Y0), (260 + X0, 74 + Y0), (268 + X0, 56 + Y0), (274 + X0, 44 + Y0),
            (334 + X0, 44 + Y0), (344 + X0, 58 + Y0), (358 + X0, 76 + Y0), (374 + X0, 92 + Y0),
            (398 + X0, 108 + Y0), (424 + X0, 116 + Y0), (W - 1, 102 + Y0), (W - 1, 154 + Y0)
        ], fill=art.VOLC_D, outline=art.INK)

        # Coherent radial basalt ridge facets (alternating lit slopes & deep shadowed gullies)
        d.polygon([
            (218 + X0, 154 + Y0), (244 + X0, 118 + Y0), (268 + X0, 58 + Y0),
            (274 + X0, 48 + Y0), (278 + X0, 62 + Y0), (262 + X0, 104 + Y0), (244 + X0, 154 + Y0)
        ], fill=VOLC_ASH)
        d.polygon([
            (244 + X0, 154 + Y0), (264 + X0, 104 + Y0), (282 + X0, 50 + Y0),
            (290 + X0, 50 + Y0), (284 + X0, 88 + Y0), (274 + X0, 126 + Y0), (270 + X0, 154 + Y0)
        ], fill=art.VOLC_M)
        d.polygon([
            (296 + X0, 154 + Y0), (298 + X0, 120 + Y0), (294 + X0, 86 + Y0),
            (300 + X0, 50 + Y0), (310 + X0, 50 + Y0), (314 + X0, 88 + Y0),
            (318 + X0, 122 + Y0), (316 + X0, 154 + Y0)
        ], fill=art.VOLC_M)
        d.polygon([
            (328 + X0, 154 + Y0), (324 + X0, 116 + Y0), (320 + X0, 50 + Y0),
            (332 + X0, 50 + Y0), (344 + X0, 84 + Y0), (358 + X0, 118 + Y0), (368 + X0, 154 + Y0)
        ], fill=art.VOLC_M)
        d.polygon([
            (384 + X0, 154 + Y0), (368 + X0, 114 + Y0), (346 + X0, 74 + Y0),
            (364 + X0, 84 + Y0), (394 + X0, 112 + Y0), (434 + X0, 126 + Y0), (W - 1, 112 + Y0), (W - 1, 154 + Y0)
        ], fill=VOLC_ASH)

        # Continuous ridge crests (warm rim-lit on inner slopes, deep gully shadow on outer side)
        ridge_spines = [
            ([(274 + X0, 48 + Y0), (264 + X0, 76 + Y0), (248 + X0, 110 + Y0), (228 + X0, 150 + Y0)], art.VOLC_L, BASALT_DEEP, -1),
            ([(286 + X0, 50 + Y0), (278 + X0, 80 + Y0), (268 + X0, 112 + Y0), (254 + X0, 150 + Y0)], VOLC_HI, BASALT_DEEP, -1),
            ([(305 + X0, 50 + Y0), (303 + X0, 82 + Y0), (308 + X0, 114 + Y0), (304 + X0, 152 + Y0)], VOLC_HI, BASALT_DEEP, 1),
            ([(325 + X0, 50 + Y0), (334 + X0, 82 + Y0), (344 + X0, 116 + Y0), (348 + X0, 152 + Y0)], art.VOLC_L, BASALT_DEEP, 1),
            ([(336 + X0, 54 + Y0), (356 + X0, 82 + Y0), (382 + X0, 110 + Y0), (416 + X0, 146 + Y0)], art.VOLC_L, BASALT_DEEP, 1),
        ]
        for pts, hi_col, sh_col, side in ridge_spines:
            for i in range(len(pts) - 1):
                x1, y1 = pts[i]
                x2, y2 = pts[i + 1]
                d.line([(x1 + side, y1), (x2 + side, y2)], fill=sh_col, width=2)
                d.line([(x1, y1), (x2, y2)], fill=hi_col, width=1)

        # Stepped basalt strata ledges & rocky outcrops along lower apron
        for lx, ly, lw in [
            (236 + X0, 136 + Y0, 16), (256 + X0, 122 + Y0, 14), (272 + X0, 96 + Y0, 12),
            (334 + X0, 98 + Y0, 14), (356 + X0, 126 + Y0, 20), (392 + X0, 134 + Y0, 24),
        ]:
            d.line([(lx, ly), (lx + lw, ly + 2)], fill=art.VOLC_L)
            d.line([(lx, ly + 1), (lx + lw, ly + 3)], fill=BASALT_DEEP)

        # Glowing magma fissures tucked in outer gullies (slow pulse)
        fiss_col = art.LAVA_M if (f // 4) % 2 == 0 else art.LAVA_D
        d.line([(260 + X0, 96 + Y0), (254 + X0, 112 + Y0), (248 + X0, 128 + Y0)], fill=art.LAVA_D)
        d.point([(254 + X0, 112 + Y0), (253 + X0, 113 + Y0)], fill=fiss_col)
        d.line([(348 + X0, 92 + Y0), (356 + X0, 108 + Y0), (364 + X0, 124 + Y0)], fill=art.LAVA_D)
        d.point([(356 + X0, 108 + Y0), (357 + X0, 109 + Y0)], fill=fiss_col)

        # Jagged Crater Rim & Slowly Bubbling Caldera
        d.rectangle([272 + X0, 40 + Y0, 336 + X0, 50 + Y0], fill=art.LAVA_D, outline=art.INK)
        d.rectangle([276 + X0, 41 + Y0, 332 + X0, 47 + Y0], fill=art.LAVA_M)
        d.rectangle([284 + X0, 41 + Y0, 324 + X0, 45 + Y0], fill=art.LAVA_L)
        dome_x = 294 + X0 + ((f // 2) % 16)
        d.rectangle([dome_x, 40 + Y0, dome_x + 8, 43 + Y0], fill=art.LAVA_CORE)
        for tooth_x in (274 + X0, 286 + X0, 302 + X0, 318 + X0, 330 + X0):
            d.polygon([(tooth_x, 44 + Y0), (tooth_x + 3, 37 + Y0), (tooth_x + 6, 44 + Y0)], fill=art.VOLC_D, outline=art.INK)
            d.point((tooth_x + 3, 39 + Y0), fill=VOLC_HI)

        # Helper: draw a coherent carved lava path with raised basalt banks & slow viscous flow
        def draw_lava_path(waypoints, hw_top, hw_bot, phase_off):
            y_start = waypoints[0][1]
            y_end = waypoints[-1][1]
            total_h = max(1, y_end - y_start)
            for py in range(y_start, y_end + 1):
                cx = waypoints[0][0]
                for si in range(len(waypoints) - 1):
                    x_a, y_a = waypoints[si]
                    x_b, y_b = waypoints[si + 1]
                    if y_a <= py <= y_b:
                        t_seg = (py - y_a) / max(1, y_b - y_a)
                        cx = int(round(x_a + (x_b - x_a) * t_seg))
                        break
                t_all = (py - y_start) / total_h
                hw = int(round(hw_top + (hw_bot - hw_top) * t_all))
                # Raised basalt gorge banks
                d.point((cx - hw - 2, py), fill=VOLC_HI)
                d.point((cx - hw - 1, py), fill=BASALT_DEEP)
                d.point((cx + hw + 1, py), fill=BASALT_DEEP)
                d.point((cx + hw + 2, py), fill=art.VOLC_L)
                # Slow viscous lava flow (1px/frame over 16 frames = seamless slow drift)
                flow_p = (py - f + phase_off) % 16
                crust_p = (py - (f // 2) + phase_off * 2) % 8
                for dx in range(-hw, hw + 1):
                    dist = abs(dx)
                    if dist == hw:
                        col = LAVA_CRUST if crust_p in (0, 1) else art.LAVA_D
                    elif dist >= max(1, hw - 1):
                        col = art.LAVA_M if flow_p < 10 else art.LAVA_D
                    else:
                        if flow_p in (0, 1, 2) and dx == 0:
                            col = art.LAVA_CORE
                        elif flow_p in (3, 4, 5, 11, 12):
                            col = art.LAVA_L
                        elif crust_p == 4 and dx != 0:
                            col = art.LAVA_D
                        else:
                            col = art.LAVA_M
                    d.point((cx + dx, py), fill=col)

        # 1. Main Western Lava Path (flows directly into the lava pit)
        draw_lava_path([
            (294 + X0, 47 + Y0), (288 + X0, 68 + Y0), (294 + X0, 90 + Y0),
            (287 + X0, 114 + Y0), (293 + X0, 136 + Y0), (288 + X0, 166 + Y0)
        ], hw_top=2, hw_bot=5, phase_off=0)
        # 2. Western Tributary Branch (flows into the western edge of the lava pit)
        draw_lava_path([
            (287 + X0, 70 + Y0), (278 + X0, 88 + Y0), (272 + X0, 108 + Y0),
            (267 + X0, 128 + Y0), (264 + X0, 163 + Y0)
        ], hw_top=1, hw_bot=2, phase_off=5)
        # 3. Main Eastern Lava Path (flows directly into the lava pit)
        draw_lava_path([
            (314 + X0, 47 + Y0), (320 + X0, 70 + Y0), (314 + X0, 94 + Y0),
            (323 + X0, 118 + Y0), (318 + X0, 138 + Y0), (322 + X0, 166 + Y0)
        ], hw_top=2, hw_bot=5, phase_off=8)

        # Rising volcano sparks / embers (slow gentle drift)
        base_embers = [(284 + X0, 36 + Y0), (294 + X0, 30 + Y0), (304 + X0, 34 + Y0), (314 + X0, 28 + Y0), (324 + X0, 36 + Y0), (300 + X0, 24 + Y0)]
        for i, (ex, ey) in enumerate(base_embers):
            rise = (f * 2 + i * 5) % 32
            nx = ex + (1 if ((f // 2 + i) % 4 < 2) else -1)
            ny = ey - rise
            if 4 <= ny <= 38 + Y0:
                d.rectangle([nx, ny, nx + 1, ny + 1], fill=art.LAVA_CORE if rise < 10 else (art.LAVA_L if rise < 20 else art.LAVA_M))

        # ---- Foreground: Grass Tufts & Volcanic Ash -> Dark Magma Rock + Lava Tidepool ----
        for gx, gy in [(32, 174 + Y0), (72, 198 + Y0), (144, 168 + Y0), (168, 210 + Y0), (226, 176 + Y0)]:
            d.line([(gx, gy), (gx - 2, gy - 4)], fill=GRASS_M)
            d.line([(gx, gy), (gx + 1, gy - 5)], fill=GRASS_L)
            d.line([(gx, gy), (gx + 3, gy - 3)], fill=GRASS_D)

        # Seamless sand -> volcanic ash -> dark magma rock transition
        d.polygon([
            (pit_x - 52, H), (pit_x - 42, 192 + Y0), (pit_x - 32, 168 + Y0),
            (pit_x - 22, 148 + Y0), (pit_x + 12, 148 + Y0), (pit_x + 12, H)
        ], fill=SAND_ASH)
        d.polygon([
            (pit_x - 36, H), (pit_x - 28, 198 + Y0), (pit_x - 20, 170 + Y0),
            (pit_x - 12, 148 + Y0), (pit_x + 12, 148 + Y0), (pit_x + 12, H)
        ], fill=ASH_SOIL)
        d.polygon([
            (pit_x - 24, H), (pit_x - 18, 202 + Y0), (pit_x - 12, 174 + Y0),
            (pit_x - 4, 148 + Y0), (pit_x + 12, 148 + Y0), (pit_x + 12, H)
        ], fill=MAGMA_ROCK_D)
        for ty in range(150 + Y0, H - 2, 3):
            edge_x = pit_x - 24 - int((ty - (148 + Y0)) * 0.22)
            d.point((edge_x - 8, ty), fill=SAND_ASH)
            d.point((edge_x - 4, ty + 1), fill=SAND_ASH)
            d.point((edge_x + 1, ty), fill=ASH_SOIL)
            d.point((edge_x + 6, ty + 1), fill=MAGMA_ROCK_D)
        for bx, by, bw, bh, bcol in [
            (pit_x - 38, 166 + Y0, 7, 4, ASH_SOIL),
            (pit_x - 26, 182 + Y0, 9, 5, MAGMA_ROCK_M),
            (pit_x - 44, 194 + Y0, 6, 3, SAND_ASH),
            (pit_x - 30, 212 + Y0, 10, 5, MAGMA_ROCK_D),
            (pit_x - 36, 232 + Y0, 8, 4, ASH_SOIL),
        ]:
            d.ellipse([bx, by, bx + bw, by + bh], fill=bcol, outline=BASALT_DEEP)
            d.point((bx + 2, by + 1), fill=art.VOLC_L)

        # Craggy rocky border & detailed slowly churning lava tidepool on the right
        d.polygon([
            (pit_x - 14, H), (pit_x - 9, 198 + Y0), (pit_x - 5, 162 + Y0), (pit_x + 8, 148 + Y0),
            (W - 1, 148 + Y0), (W - 1, H)
        ], fill=art.VOLC_D)
        d.line([(pit_x - 14, H), (pit_x - 9, 198 + Y0), (pit_x - 5, 162 + Y0), (pit_x + 8, 148 + Y0)], fill=MAGMA_ROCK_M, width=2)
        d.line([(pit_x - 7, 188 + Y0), (pit_x - 3, 172 + Y0)], fill=art.LAVA_D)
        # Stepped basalt rim highlights along the lava pit edge
        d.line([(pit_x - 4, 160 + Y0), (pit_x + 12, 151 + Y0), (W - 2, 151 + Y0)], fill=art.VOLC_L)
        d.line([(pit_x - 8, H - 4), (pit_x - 3, 164 + Y0)], fill=art.VOLC_M)

        # Molten lava lake base (deep red-orange perimeter, molten orange core)
        d.polygon([
            (pit_x + 4, H - 3), (pit_x + 9, 164 + Y0), (pit_x + 24, 156 + Y0),
            (W - 3, 158 + Y0), (W - 3, H - 3)
        ], fill=art.LAVA_D, outline=BASALT_DEEP)
        d.polygon([
            (pit_x + 12, H - 7), (pit_x + 18, 174 + Y0), (pit_x + 34, 166 + Y0),
            (W - 7, 168 + Y0), (W - 7, H - 7)
        ], fill=art.LAVA_M)

        # Redraw lower lava-flow mouths over the pit rim so lava pours directly in
        draw_lava_path([(292 + X0, 140 + Y0), (288 + X0, 168 + Y0)], hw_top=4, hw_bot=6, phase_off=0)
        draw_lava_path([(266 + X0, 142 + Y0), (264 + X0, 166 + Y0)], hw_top=2, hw_bot=3, phase_off=5)
        draw_lava_path([(319 + X0, 140 + Y0), (322 + X0, 168 + Y0)], hw_top=4, hw_bot=6, phase_off=8)

        # Slowly drifting molten veins & cooled basalt crust plates (0.5px/frame)
        drift = f // 2  # 0..7 over 16 frames
        # Glowing lava splash deltas where the three volcano rivers pour into the pool
        for dx_in, sp_r in [(264 + X0, 4), (288 + X0, 6), (322 + X0, 6)]:
            splash_w = sp_r + ((f // 4) % 2)
            d.ellipse([dx_in - splash_w, 162 + Y0, dx_in + splash_w, 173 + Y0], fill=art.LAVA_L)
            d.ellipse([dx_in - max(2, sp_r // 2), 164 + Y0, dx_in + max(2, sp_r // 2), 170 + Y0], fill=art.LAVA_CORE)

        # Winding glowing magma veins across the tidepool
        for row_i, vy in enumerate(range(172 + Y0, H - 10, 14)):
            for vx in range(pit_x + 16, W - 14, 24):
                ox = vx + ((drift + row_i * 5) % 16) - 8
                vy_w = vy + (1 if ((ox // 8 + row_i) % 2 == 0) else -1)
                d.line([(ox, vy_w), (ox + 10, vy_w + 1), (ox + 16, vy_w)], fill=art.LAVA_L, width=2)
                d.line([(ox + 3, vy_w), (ox + 9, vy_w + 1)], fill=art.LAVA_CORE)

        # Drifting dark cooled basalt crust plates with glowing cracks
        crust_specs = [
            (pit_x + 26, 180 + Y0, 22, 8), (pit_x + 98, 174 + Y0, 26, 9),
            (pit_x + 158, 186 + Y0, 24, 8), (pit_x + 34, 214 + Y0, 28, 10),
            (pit_x + 124, 224 + Y0, 30, 10), (pit_x + 184, 210 + Y0, 20, 8),
        ]
        for c_i, (cx0, cy0, cw, ch) in enumerate(crust_specs):
            cx = cx0 + (drift if c_i % 2 == 0 else -drift) // 2
            cy = cy0 + (1 if ((f // 4 + c_i) % 2 == 0) else 0)
            d.polygon([
                (cx, cy + ch // 2), (cx + cw // 4, cy), (cx + (3 * cw) // 4, cy + 1),
                (cx + cw, cy + ch // 2), (cx + (2 * cw) // 3, cy + ch), (cx + cw // 5, cy + ch - 1)
            ], fill=LAVA_CRUST, outline=art.LAVA_D)
            d.line([(cx + cw // 4, cy + 2), (cx + (2 * cw) // 3, cy + ch - 3)], fill=BASALT_DEEP)

        # Craggy basalt rock island in the lava lake with molten shoreline rim
        isl_pts = [(pit_x + 64, 204 + Y0), (pit_x + 76, 193 + Y0), (pit_x + 94, 198 + Y0), (pit_x + 88, 212 + Y0), (pit_x + 70, 214 + Y0)]
        d.polygon(isl_pts, fill=art.VOLC_D, outline=art.LAVA_L)
        d.polygon([(pit_x + 70, 203 + Y0), (pit_x + 78, 196 + Y0), (pit_x + 90, 200 + Y0), (pit_x + 84, 208 + Y0)], fill=art.VOLC_M)
        d.line([(pit_x + 76, 195 + Y0), (pit_x + 91, 199 + Y0)], fill=VOLC_HI)

        # Slowly pulsing magma bubbles
        bubbles = [(pit_x + 52, 188 + Y0, 0), (pit_x + 144, 178 + Y0, 4), (pit_x + 112, 208 + Y0, 8), (pit_x + 172, 234 + Y0, 12), (pit_x + 64, 236 + Y0, 2)]
        for bx, by, b_ph in bubbles:
            bt = (f + b_ph) % 16
            if bt < 5:
                d.point((bx, by), fill=art.LAVA_L)
            elif bt < 10:
                d.rectangle([bx - 1, by - 1, bx + 1, by + 1], fill=art.LAVA_CORE, outline=art.LAVA_L)
            elif bt < 13:
                d.rectangle([bx - 2, by - 1, bx + 2, by + 1], fill=art.LAVA_L)
                d.point((bx, by), fill=art.LAVA_M)

        frames.append(img.resize((W * S, H * S), Image.NEAREST))
    return frames


def make_torch_frames(n_frames: int = 8) -> list[Image]:
    W, H, S = 20, 36, 4
    frames: list[Image] = []
    # Flame tip x-offset and height modulation per frame
    tips = [(10, 2), (9, 3), (11, 2), (10, 1), (11, 3), (9, 2), (10, 3), (11, 1)]
    for f in range(n_frames):
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        tx, ty = tips[f % len(tips)]
        mid_x = 10 + (1 if tx > 10 else (-1 if tx < 10 else 0))

        # Outer flame
        d.polygon([(tx, ty), (5, 11), (7, 16), (13, 16), (15, 11)], fill=art.LAVA_D, outline=art.INK)
        # Mid flame
        d.polygon([(tx, ty + 2), (7, 11), (8, 15), (12, 15), (13, 11)], fill=art.LAVA_M)
        # Inner flame
        d.polygon([(mid_x, ty + 5), (8, 12), (10, 15), (12, 12)], fill=art.LAVA_L)
        d.point([(10, 11), (10, 12), (mid_x, 10)], fill=art.LAVA_CORE)

        # Rising spark above flame
        sy = 4 - (f % 4)
        sx = tx + (1 if f % 2 == 0 else -1)
        if 0 <= sy <= 5:
            d.point((sx, sy), fill=art.LAVA_L if f % 2 else art.LAVA_CORE)

        # Carved wooden cup + bamboo shaft
        d.rectangle([6, 16, 14, 21], fill=art.WOOD_M, outline=art.INK)
        d.line([(7, 17), (13, 17)], fill=art.WOOD_HI)
        d.rectangle([8, 21, 12, 34], fill=art.WOOD_D, outline=art.INK)
        d.line([(9, 22), (9, 33)], fill=art.WOOD_L)
        for y in (25, 30):
            d.line([(8, y), (12, y)], fill=art.INK)

        frames.append(img.resize((W * S, H * S), Image.NEAREST))
    return frames


def make_podium_bg_frames(n_frames: int = 8) -> list[Image]:
    """Simple outdoor night-sky backdrop with minimal ground and detailed left & right fire."""
    W, H, S = 320, 180, 2
    frames: list[Image] = []
    rng = random.Random(101)
    stars = [(rng.randint(6, W - 7), rng.randint(4, 148), rng.random() < 0.35, rng.randint(0, 7)) for _ in range(72)]
    GROUND_D = (28, 18, 22, 255)
    GROUND_M = (46, 28, 28, 255)
    GROUND_LIT = (84, 44, 28, 255)

    for f in range(n_frames):
        img = Image.new("RGBA", (W, H), art.SKY_TOP)
        d = ImageDraw.Draw(img)
        # Tall open night sky gradient behind the podium
        d.rectangle([0, 0, W, 56], fill=art.SKY_TOP)
        d.rectangle([0, 56, W, 114], fill=art.SKY_MID)
        d.rectangle([0, 114, W, 166], fill=art.SKY_LOW)
        # Twinkling stars across the night sky
        for sx, sy, is_gold, ph in stars:
            t = (f + ph) % 8
            if t in (3, 4):
                continue
            d.point((sx, sy), fill=art.STAR_2 if is_gold else art.STAR_1)
        # Crescent moon centered high in the night sky
        d.ellipse([146, 10, 174, 38], fill=art.SKY_MID)
        d.ellipse([151, 14, 170, 33], fill=art.MOON)
        d.ellipse([158, 12, 176, 30], fill=art.SKY_TOP)

        # Detailed carved stone flagstone ground strip at the very bottom
        d.rectangle([0, 165, W, H], fill=GROUND_D)
        # Beveled stone curb edge with mortar joints
        d.rectangle([0, 165, W, 168], fill=art.STONE_D, outline=art.INK)
        d.line([(0, 166), (W, 166)], fill=art.STONE_M)
        for cx in range(0, W, 20):
            d.line([(cx, 165), (cx, 168)], fill=art.INK)
            d.point((cx + 2, 166), fill=art.STONE_L)
        # Staggered flagstone pavers + warm firelight reflection on nearby stones
        for row_idx, py in enumerate((168, 174)):
            off = 10 if row_idx % 2 else 0
            for px in range(-off, W, 22):
                lit = (px < 96) or (px > W - 110)
                hi_lit = (px < 56) or (px > W - 70)
                tile_col = GROUND_LIT if hi_lit else (GROUND_M if lit else GROUND_D)
                d.rectangle([px + 1, py + 1, px + 20, py + 5], fill=tile_col, outline=art.INK)
                d.line([(px + 2, py + 1), (px + 19, py + 1)], fill=art.STONE_L if hi_lit else art.STONE_M)
                if (px + row_idx) % 3 == 0:
                    d.point((px + 7, py + 3), fill=art.STONE_D)

        # Detailed Ornate Stone & Bronze Fire Braziers to the left and right of the podium
        for idx, bx in enumerate((28, W - 28)):
            # Stepped stone plinth base
            d.rectangle([bx - 13, 162, bx + 13, 167], fill=art.STONE_D, outline=art.INK)
            d.line([(bx - 12, 163), (bx + 12, 163)], fill=art.STONE_L)
            # Fluted pedestal + carved gold/bronze collar ring
            d.rectangle([bx - 8, 156, bx + 8, 162], fill=art.STONE_M, outline=art.INK)
            for fx in (bx - 4, bx, bx + 4):
                d.line([(fx, 157), (fx, 161)], fill=art.STONE_D)
            d.rectangle([bx - 10, 154, bx + 10, 156], fill=art.STAR_2, outline=art.INK)
            # Flared iron/stone fire bowl with carved tooth trim & ember vents
            d.polygon([(bx - 16, 144), (bx + 16, 144), (bx + 11, 154), (bx - 11, 154)], fill=art.STONE_M, outline=art.INK)
            d.rectangle([bx - 17, 142, bx + 17, 145], fill=art.STONE_D, outline=art.INK)
            d.line([(bx - 16, 143), (bx + 16, 143)], fill=art.STONE_L)
            for rx in range(bx - 14, bx + 15, 4):
                d.point((rx, 143), fill=art.STAR_2)
                d.point((rx + 1, 148), fill=art.LAVA_D if (f + rx) % 2 == 0 else art.LAVA_M)
            for vx in (bx - 6, bx, bx + 6):
                d.rectangle([vx - 1, 149, vx + 1, 152], fill=art.LAVA_M if f % 2 == 0 else art.LAVA_L)
            # Glowing coals & crossed charred logs
            d.rectangle([bx - 11, 140, bx + 11, 142], fill=art.LAVA_D)
            d.line([(bx - 9, 142), (bx + 9, 138)], fill=art.WOOD_D, width=2)
            d.line([(bx - 9, 138), (bx + 9, 142)], fill=art.WOOD_M, width=2)

            # Detailed multi-layered animated pixel-art flames
            sway = 2 if ((f + idx) % 2 == 0) else -2
            flick = (f + idx * 2) % 4
            main_h = 34 + (flick % 3) * 4
            fire_y = 143
            # Outer crimson/deep-orange flame body + side licks
            d.polygon([(bx + sway, fire_y - main_h), (bx - 12, fire_y), (bx + 12, fire_y)], fill=art.LAVA_D)
            d.polygon([(bx - 10 - (flick % 2), fire_y - 18), (bx - 13, fire_y), (bx - 4, fire_y)], fill=art.LAVA_D)
            d.polygon([(bx + 10 + (flick % 2), fire_y - 16), (bx + 4, fire_y), (bx + 13, fire_y)], fill=art.LAVA_D)
            # Mid bright-orange flame body + side licks
            d.polygon([(bx + sway, fire_y - main_h + 6), (bx - 9, fire_y), (bx + 9, fire_y)], fill=art.LAVA_M)
            d.polygon([(bx - 7, fire_y - 14), (bx - 9, fire_y), (bx - 2, fire_y)], fill=art.LAVA_M)
            d.polygon([(bx + 7, fire_y - 13), (bx + 2, fire_y), (bx + 9, fire_y)], fill=art.LAVA_M)
            # Inner golden flame tongue
            d.polygon([(bx + (sway // 2), fire_y - main_h + 13), (bx - 5, fire_y), (bx + 5, fire_y)], fill=art.LAVA_L)
            # White-hot inner core
            d.polygon([(bx, fire_y - 12), (bx - 3, fire_y), (bx + 3, fire_y)], fill=art.LAVA_CORE)
            # Rising sparks & embers
            for sp in range(5):
                sy = (fire_y - 4) - main_h - ((f * 4 + sp * 7) % 26)
                sx = bx + ((sp - 2) * 3) + (sway if sp % 2 == 0 else -sway)
                if sy >= 6:
                    d.rectangle([sx, sy, sx + 1, sy + 1], fill=art.LAVA_CORE if sp < 2 else art.LAVA_L)

        frames.append(img.resize((W * S, H * S), Image.NEAREST))
    return frames


def make_lava_pit_bg_frames(n_frames: int = 12) -> list[Image]:
    """Volcanic Lava Pit background for the end-of-game losers pit."""
    W, H, S = 240, 180, 2
    frames: list[Image] = []
    BASALT_DEEP = (24, 10, 14, 255)
    LAVA_CRUST = (96, 26, 20, 255)
    VOLC_HI = (158, 68, 42, 255)

    for f in range(n_frames):
        img = Image.new("RGBA", (W, H), BASALT_DEEP)
        d = ImageDraw.Draw(img)
        # Smokey dark volcanic cavern upper backdrop
        d.rectangle([0, 0, W, 62], fill=(38, 16, 20, 255))
        d.rectangle([0, 62, W, 106], fill=(64, 22, 18, 255))
        # Jagged basalt pit walls framing left and right
        d.polygon([(0, 0), (42, 0), (28, 56), (18, 102), (24, 140), (0, 150)], fill=art.VOLC_D, outline=art.INK)
        d.polygon([(W, 0), (W - 42, 0), (W - 26, 54), (W - 18, 102), (W - 24, 140), (W, 150)], fill=art.VOLC_D, outline=art.INK)
        d.line([(28, 56), (18, 102), (24, 140)], fill=VOLC_HI, width=1)
        d.line([(W - 26, 54), (W - 18, 102), (W - 24, 140)], fill=VOLC_HI, width=1)

        # Molten lava pit filling the lower half (y = 96 .. H)
        d.rectangle([0, 96, W, H], fill=art.LAVA_D)
        d.rectangle([0, 104, W, H], fill=art.LAVA_M)
        wave_off = f % 6
        for wx in range(-12 + wave_off * 2, W, 24):
            d.line([(wx, 97), (wx + 14, 97)], fill=art.LAVA_L, width=2)
            d.line([(wx + 4, 98), (wx + 10, 98)], fill=art.LAVA_CORE)

        # Slow drifting magma veins
        drift = f // 2
        for row_i, vy in enumerate(range(114, H - 8, 14)):
            for vx in range(14, W - 14, 34):
                ox = vx + ((drift + row_i * 5) % 14) - 7
                d.line([(ox, vy), (ox + 12, vy + 1), (ox + 20, vy)], fill=art.LAVA_L, width=2)
                d.line([(ox + 4, vy), (ox + 12, vy + 1)], fill=art.LAVA_CORE)

        # Cooled basalt crust plates floating in the pit
        for c_i, (cx0, cy0, cw, ch) in enumerate([(28, 122, 26, 8), (118, 118, 30, 9), (176, 134, 24, 8), (64, 152, 28, 9)]):
            cx = cx0 + (drift if c_i % 2 == 0 else -drift) // 2
            d.polygon([
                (cx, cy0 + ch // 2), (cx + cw // 4, cy0), (cx + (3 * cw) // 4, cy0),
                (cx + cw, cy0 + ch // 2), (cx + (2 * cw) // 3, cy0 + ch), (cx + cw // 4, cy0 + ch)
            ], fill=LAVA_CRUST, outline=art.LAVA_D)

        # Rising embers
        for i, (ex, ey) in enumerate([(44, 88), (92, 82), (144, 90), (192, 84), (116, 74)]):
            rise = (f * 3 + i * 7) % 44
            ny = ey - rise
            nx = ex + (1 if ((f + i) % 4 < 2) else -1)
            if 6 <= ny <= 94:
                d.rectangle([nx, ny, nx + 1, ny + 1], fill=art.LAVA_CORE if rise < 16 else art.LAVA_L)

        frames.append(img.resize((W * S, H * S), Image.NEAREST))
    return frames


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
    os.makedirs(out, exist_ok=True)
    save_gif(os.path.join(out, "lb_temple_bg.gif"), make_temple_bg_frames(), delay_cs=18, transparent=False)
    save_gif(os.path.join(out, "lb_podium_bg.gif"), make_podium_bg_frames(), delay_cs=18, transparent=False)
    save_gif(os.path.join(out, "lb_lava_pit_bg.gif"), make_lava_pit_bg_frames(), delay_cs=18, transparent=False)
    save_gif(os.path.join(out, "lb_torch.gif"), make_torch_frames(), delay_cs=11, transparent=True)
    print("Generated lb_temple_bg.gif, lb_podium_bg.gif, lb_lava_pit_bg.gif, and lb_torch.gif in assets/")


if __name__ == "__main__":
    main()
