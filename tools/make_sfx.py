"""Generate free-use (CC0 / public domain) procedural WAV sound effects for Freaky Tiki.

Run: .venv/bin/python tools/make_sfx.py
Outputs crisp 22.05kHz 16-bit mono WAV files into assets/sfx/.
"""
import math
import os
import random
import struct
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets" / "sfx"
SR = 22050


def write_wav(name: str, samples: list[float]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{name}.wav"
    peak = max((abs(s) for s in samples), default=1.0)
    scale = 0.85 / peak if peak > 0.85 else 1.0
    pcm = bytearray()
    for s in samples:
        v = max(-32767, min(32767, int(s * scale * 32767)))
        pcm.extend(struct.pack("<h", v))
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(bytes(pcm))


def env_exp(t: float, dur: float, decay: float) -> float:
    if t < 0 or t >= dur:
        return 0.0
    return math.exp(-t * decay) * min(1.0, t / 0.004)


def make_flip() -> list[float]:
    rng = random.Random(1)
    dur = 0.11
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        noise = (rng.random() * 2 - 1) * env_exp(t, dur, 48.0) * 0.45
        thump = math.sin(2 * math.pi * (170 - 90 * (t / dur)) * t) * env_exp(t, dur, 36.0) * 0.45
        out.append(noise + thump)
    return out


def make_stack() -> list[float]:
    rng = random.Random(2)
    dur = 0.22
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        snap = (rng.random() * 2 - 1) * env_exp(t, 0.06, 65.0) * 0.35
        tone1 = math.sin(2 * math.pi * 523.25 * t) * env_exp(t, dur, 16.0) * 0.45
        tone2 = math.sin(2 * math.pi * 783.99 * max(0.0, t - 0.045)) * env_exp(t - 0.045, dur, 14.0) * 0.45
        out.append(snap + tone1 + tone2)
    return out


def make_miss() -> list[float]:
    dur = 0.34
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        freq = 210 - 115 * (t / dur)
        saw = (2.0 * ((freq * t) % 1.0) - 1.0) * 0.35
        sub = math.sin(2 * math.pi * freq * 0.5 * t) * 0.4
        out.append((saw + sub) * env_exp(t, dur, 7.5))
    return out


def make_tiki_tap() -> list[float]:
    dur = 0.12
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        f = 420 + 60 * math.exp(-t * 45.0)
        wood = math.sin(2 * math.pi * f * t) * 0.65 + math.sin(2 * math.pi * f * 2.4 * t) * 0.25
        out.append(wood * env_exp(t, dur, 32.0))
    return out


def make_freaky() -> list[float]:
    notes = [(0.0, 392.0), (0.09, 493.88), (0.18, 587.33), (0.28, 783.99)]
    dur = 0.55
    n = int(SR * dur)
    out = [0.0] * n
    for start, freq in notes:
        for i in range(int(start * SR), n):
            t = i / SR - start
            v = (math.sin(2 * math.pi * freq * t) + 0.35 * math.sin(2 * math.pi * freq * 2 * t))
            out[i] += v * env_exp(t, dur - start, 10.0) * 0.35
    return out


def make_shed() -> list[float]:
    rng = random.Random(3)
    dur = 0.09
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        swish = (rng.random() * 2 - 1) * env_exp(t, dur, 55.0) * 0.4
        tick = math.sin(2 * math.pi * 660 * t) * env_exp(t, dur, 40.0) * 0.3
        out.append(swish + tick)
    return out


def make_joker() -> list[float]:
    dur = 0.46
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        f = 340 + 280 * math.sin(2 * math.pi * 7.5 * t) * math.exp(-t * 2.5)
        v = math.sin(2 * math.pi * f * t) * 0.5 + math.sin(2 * math.pi * (f * 1.5) * t) * 0.25
        out.append(v * env_exp(t, dur, 5.5))
    return out


def make_slap() -> list[float]:
    rng = random.Random(4)
    dur = 0.14
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        crack = (rng.random() * 2 - 1) * env_exp(t, dur, 52.0) * 0.7
        punch = math.sin(2 * math.pi * (240 - 150 * (t / dur)) * t) * env_exp(t, dur, 38.0) * 0.65
        out.append(crack + punch)
    return out


def make_win() -> list[float]:
    notes = [(0.0, 523.25), (0.10, 659.25), (0.20, 783.99), (0.32, 1046.50)]
    dur = 0.85
    n = int(SR * dur)
    out = [0.0] * n
    for start, freq in notes:
        for i in range(int(start * SR), n):
            t = i / SR - start
            v = math.sin(2 * math.pi * freq * t) + 0.3 * math.sin(2 * math.pi * freq * 2 * t)
            out[i] += v * env_exp(t, dur - start, 6.0) * 0.35
    return out


def make_firework() -> list[float]:
    rng = random.Random(5)
    dur = 0.55
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        pop = math.sin(2 * math.pi * (220 - 140 * min(1.0, t / 0.1)) * t) * env_exp(t, 0.12, 30.0) * 0.55
        crackle = (rng.random() * 2 - 1) * (1.0 if rng.random() < 0.25 else 0.25) * env_exp(t, dur, 7.0) * 0.5
        out.append(pop + crackle)
    return out


def main() -> None:
    generators = {
        "flip": make_flip,
        "stack": make_stack,
        "miss": make_miss,
        "tiki_tap": make_tiki_tap,
        "freaky": make_freaky,
        "shed": make_shed,
        "joker": make_joker,
        "slap": make_slap,
        "win": make_win,
        "firework": make_firework,
    }
    for name, fn in generators.items():
        write_wav(name, fn())
    print(f"Generated {len(generators)} WAV sound effects in {OUT_DIR}")


if __name__ == "__main__":
    main()
