"""Pure-Python RGBA pixel-art canvas + PNG reader/writer fallback when Pillow
is not installed in the active virtualenv. Supports the exact subset of
PIL.Image and PIL.ImageDraw used by make_tiki.py, make_hands.py,
make_cards.py, and verify_cards.py."""
import math, struct, zlib
from pathlib import Path


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


class Image:
    NEAREST = 0

    def __init__(self, mode, size, buf=None):
        self.mode = mode
        self.width, self.height = size
        w, h = size
        if buf is not None:
            self._px = buf
        elif mode == "L":
            self._px = [[0] * w for _ in range(h)]
        else:
            self._px = [[(0, 0, 0, 0)] * w for _ in range(h)]

    @property
    def size(self):
        return (self.width, self.height)

    @classmethod
    def new(cls, mode, size, color=0):
        w, h = size
        if mode == "L":
            c = int(color) if isinstance(color, int) else int(color[0])
            buf = [[c] * w for _ in range(h)]
        else:
            c = tuple(color) if isinstance(color, (tuple, list)) else (0, 0, 0, 0)
            if len(c) == 3:
                c = c + (255,)
            buf = [[c] * w for _ in range(h)]
        return cls(mode, size, buf)

    @classmethod
    def open(cls, path):
        data = Path(path).read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n", "Not a PNG file"
        pos = 8
        w = h = bit_depth = color_type = 0
        idat = bytearray()
        while pos < len(data):
            length = struct.unpack(">I", data[pos:pos + 4])[0]
            ctype = data[pos + 4:pos + 8]
            chunk = data[pos + 8:pos + 8 + length]
            pos += 12 + length
            if ctype == b"IHDR":
                w, h, bit_depth, color_type, _, _, _ = struct.unpack(">IIBBBBB", chunk)
            elif ctype == b"IDAT":
                idat.extend(chunk)
            elif ctype == b"IEND":
                break
        raw = zlib.decompress(bytes(idat))
        bpp = 4 if color_type == 6 else (3 if color_type == 2 else 1)
        stride = w * bpp
        buf = []
        prev = [0] * stride
        i = 0
        for _y in range(h):
            ft = raw[i]
            i += 1
            row = list(raw[i:i + stride])
            i += stride
            if ft == 1:
                for x in range(bpp, stride):
                    row[x] = (row[x] + row[x - bpp]) & 0xFF
            elif ft == 2:
                for x in range(stride):
                    row[x] = (row[x] + prev[x]) & 0xFF
            elif ft == 3:
                for x in range(stride):
                    a = row[x - bpp] if x >= bpp else 0
                    row[x] = (row[x] + ((a + prev[x]) >> 1)) & 0xFF
            elif ft == 4:
                for x in range(stride):
                    a = row[x - bpp] if x >= bpp else 0
                    c = prev[x - bpp] if x >= bpp else 0
                    row[x] = (row[x] + _paeth(a, prev[x], c)) & 0xFF
            prev = row
            px_row = []
            for x in range(0, stride, bpp):
                if bpp == 4:
                    px_row.append((row[x], row[x + 1], row[x + 2], row[x + 3]))
                elif bpp == 3:
                    px_row.append((row[x], row[x + 1], row[x + 2], 255))
                else:
                    px_row.append((row[x], row[x], row[x], 255))
            buf.append(px_row)
        return cls("RGBA", (w, h), buf)

    def convert(self, mode):
        return self

    def load(self):
        img = self
        class _Acc:
            def __getitem__(self, xy):
                x, y = xy
                return img._px[y][x]
            def __setitem__(self, xy, val):
                x, y = xy
                img._px[y][x] = val
        return _Acc()

    def putalpha(self, mask):
        for y in range(self.height):
            r_px = self._px[y]
            m_px = mask._px[y]
            for x in range(self.width):
                r, g, b, _a = r_px[x]
                r_px[x] = (r, g, b, m_px[x])

    def rotate(self, deg):
        if deg == 180:
            buf = [list(reversed(row)) for row in reversed(self._px)]
            return Image(self.mode, (self.width, self.height), buf)
        raise ValueError(f"Unsupported rotation: {deg}")

    def alpha_composite(self, other, dest=(0, 0)):
        dx, dy = dest
        for y in range(other.height):
            ty = dy + y
            if not (0 <= ty < self.height):
                continue
            s_row = other._px[y]
            d_row = self._px[ty]
            for x in range(other.width):
                tx = dx + x
                if not (0 <= tx < self.width):
                    continue
                sr, sg, sb, sa = s_row[x]
                if sa == 0:
                    continue
                if sa == 255:
                    d_row[tx] = (sr, sg, sb, 255)
                else:
                    dr, dg, db, da = d_row[tx]
                    inv = 255 - sa
                    out_a = sa + (da * inv) // 255
                    if out_a == 0:
                        d_row[tx] = (0, 0, 0, 0)
                    else:
                        r = (sr * sa + (dr * da * inv) // 255) // out_a
                        g = (sg * sa + (dg * da * inv) // 255) // out_a
                        b = (sb * sa + (db * da * inv) // 255) // out_a
                        d_row[tx] = (r, g, b, out_a)

    def resize(self, new_size, resample=0):
        nw, nh = new_size
        sx = self.width / nw
        sy = self.height / nh
        buf = []
        for y in range(nh):
            oy = min(self.height - 1, int(y * sy))
            s_row = self._px[oy]
            buf.append([s_row[min(self.width - 1, int(x * sx))] for x in range(nw)])
        return Image(self.mode, (nw, nh), buf)

    def save(self, path):
        raw = bytearray()
        for y in range(self.height):
            raw.append(0)  # filter type 0 (None)
            for r, g, b, a in self._px[y]:
                raw.extend((r & 0xFF, g & 0xFF, b & 0xFF, a & 0xFF))
        def chunk(ctype, data):
            crc = zlib.crc32(ctype + data) & 0xFFFFFFFF
            return struct.pack(">I", len(data)) + ctype + data + struct.pack(">I", crc)
        ihdr = struct.pack(">IIBBBBB", self.width, self.height, 8, 6, 0, 0, 0)
        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", ihdr)
               + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
               + chunk(b"IEND", b""))
        Path(path).write_bytes(png)


class _Draw:
    def __init__(self, img):
        self.img = img

    def _norm_color(self, fill):
        if fill is None:
            return None
        if self.img.mode == "L":
            return int(fill) if isinstance(fill, int) else int(fill[0])
        if len(fill) == 3:
            return (fill[0], fill[1], fill[2], 255)
        return tuple(fill)

    def _set(self, x, y, c):
        if c is not None and 0 <= x < self.img.width and 0 <= y < self.img.height:
            self.img._px[int(y)][int(x)] = c

    def point(self, xy, fill=None):
        c = self._norm_color(fill)
        if isinstance(xy, (list, tuple)) and xy and isinstance(xy[0], (list, tuple)):
            for p in xy:
                self._set(round(p[0]), round(p[1]), c)
        else:
            self._set(round(xy[0]), round(xy[1]), c)

    def line(self, xy, fill=None, width=1):
        c = self._norm_color(fill)
        if c is None:
            return
        if isinstance(xy[0], (list, tuple)):
            pts = list(xy)
        else:
            pts = [(xy[i], xy[i + 1]) for i in range(0, len(xy), 2)]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            x0, y0, x1, y1 = round(x0), round(y0), round(x1), round(y1)
            dx, dy = abs(x1 - x0), abs(y1 - y0)
            steps = max(dx, dy, 1)
            for s in range(steps + 1):
                px = round(x0 + (x1 - x0) * s / steps)
                py = round(y0 + (y1 - y0) * s / steps)
                for wy in range(-(width - 1) // 2, width // 2 + 1):
                    for wx in range(-(width - 1) // 2, width // 2 + 1):
                        self._set(px + wx, py + wy, c)

    def rectangle(self, box, fill=None, outline=None, width=1):
        if len(box) == 2 and isinstance(box[0], (list, tuple)):
            (x0, y0), (x1, y1) = box
        else:
            x0, y0, x1, y1 = box
        x0, y0, x1, y1 = int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))
        if x0 > x1:
            x0, x1 = x1, x0
        if y0 > y1:
            y0, y1 = y1, y0
        fc = self._norm_color(fill)
        oc = self._norm_color(outline)
        if fc is not None:
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    self._set(x, y, fc)
        if oc is not None and width > 0:
            for w in range(width):
                for x in range(x0 + w, x1 - w + 1):
                    self._set(x, y0 + w, oc)
                    self._set(x, y1 - w, oc)
                for y in range(y0 + w, y1 - w + 1):
                    self._set(x0 + w, y, oc)
                    self._set(x1 - w, y, oc)

    def rounded_rectangle(self, box, radius=0, fill=None, outline=None, width=1):
        if len(box) == 2 and isinstance(box[0], (list, tuple)):
            (x0, y0), (x1, y1) = box
        else:
            x0, y0, x1, y1 = box
        x0, y0, x1, y1 = int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))
        r = max(0, min(int(round(radius)), (x1 - x0) // 2, (y1 - y0) // 2))
        fc = self._norm_color(fill)
        oc = self._norm_color(outline)

        def inside(px, py, rad, ix0, iy0, ix1, iy1):
            if px < ix0 or px > ix1 or py < iy0 or py > iy1:
                return False
            if ix0 + rad <= px <= ix1 - rad or iy0 + rad <= py <= iy1 - rad:
                return True
            cx = ix0 + rad if px < ix0 + rad else ix1 - rad
            cy = iy0 + rad if py < iy0 + rad else iy1 - rad
            return (px - cx) ** 2 + (py - cy) ** 2 <= (rad + 0.35) ** 2

        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if not inside(x, y, r, x0, y0, x1, y1):
                    continue
                if oc is not None and width > 0 and not inside(
                    x, y, max(0, r - width), x0 + width, y0 + width, x1 - width, y1 - width
                ):
                    self._set(x, y, oc)
                elif fc is not None:
                    self._set(x, y, fc)

    def ellipse(self, box, fill=None, outline=None):
        x0, y0, x1, y1 = box
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        rx, ry = max(0.5, (x1 - x0) / 2.0), max(0.5, (y1 - y0) / 2.0)
        fc = self._norm_color(fill)
        oc = self._norm_color(outline)
        for y in range(int(math.floor(y0)), int(math.ceil(y1)) + 1):
            for x in range(int(math.floor(x0)), int(math.ceil(x1)) + 1):
                d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
                if d <= 1.05:
                    if fc is not None:
                        self._set(x, y, fc)
                    if oc is not None and d >= 0.72:
                        self._set(x, y, oc)

    def polygon(self, pts, fill=None, outline=None):
        pts = [(float(p[0]), float(p[1])) for p in pts]
        fc = self._norm_color(fill)
        oc = self._norm_color(outline)
        if fc is not None and len(pts) >= 3:
            ys = [p[1] for p in pts]
            ymin, ymax = int(math.floor(min(ys))), int(math.ceil(max(ys)))
            n = len(pts)
            for y in range(ymin, ymax + 1):
                py = y + 0.0
                nodes = []
                j = n - 1
                for i in range(n):
                    yi, yj = pts[i][1], pts[j][1]
                    xi, xj = pts[i][0], pts[j][0]
                    if (yi < py <= yj) or (yj < py <= yi):
                        nodes.append(xi + (py - yi) / (yj - yi) * (xj - xi))
                    j = i
                nodes.sort()
                for k in range(0, len(nodes) - 1, 2):
                    for x in range(int(math.ceil(nodes[k])), int(math.floor(nodes[k + 1])) + 1):
                        self._set(x, y, fc)
            for p in pts:
                self._set(round(p[0]), round(p[1]), fc)
        if oc is not None:
            for i in range(len(pts)):
                self.line([pts[i], pts[(i + 1) % len(pts)]], fill=oc, width=1)


class ImageDraw:
    @staticmethod
    def Draw(img):
        return _Draw(img)
