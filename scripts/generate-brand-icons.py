"""Renders the Agent Forge brand mark (#345) into build/icon.png and build/icon.ico.

The geometry mirrors src/ui/components/BrandMark.tsx and public/favicon.svg (viewBox 512):
a gradient rounded square, a white anvil and an amber spark. Run with Python 3 and Pillow:
    python scripts/generate-brand-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512
SCALE = 4  # Draw large, then downscale for smooth edges.
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'build'

GRADIENT = [(0.0, (6, 182, 212)), (0.55, (59, 130, 246)), (1.0, (139, 92, 246))]
ANVIL = (255, 255, 255, 255)
SPARK = (252, 211, 77, 255)
OFFSET_Y = 16  # Centres the anvil and sparks vertically.


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_color(t):
    for (t0, c0), (t1, c1) in zip(GRADIENT, GRADIENT[1:]):
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return GRADIENT[-1][1]


def quad(p0, c, p1, steps=16):
    """Points of a quadratic Bezier curve, without its start point."""
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t ** 2 * p1[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t ** 2 * p1[1])
            for t in (i / steps for i in range(1, steps + 1))]


def anvil_points():
    pts = [(84, 232), (404, 232)]
    pts += quad((404, 232), (416, 232), (416, 244))
    pts += [(416, 272)]
    pts += quad((416, 272), (416, 284), (404, 284))
    pts += [(334, 284), (314, 330), (340, 330)]
    pts += quad((340, 330), (352, 330), (356, 342))
    pts += [(366, 384)]
    pts += quad((366, 384), (368, 396), (356, 396))
    pts += [(156, 396)]
    pts += quad((156, 396), (144, 396), (146, 384))
    pts += [(156, 342)]
    pts += quad((156, 342), (160, 330), (172, 330))
    pts += [(198, 330), (178, 284), (150, 284)]
    pts += quad((150, 284), (104, 284), (84, 232))
    return pts


def star_points(cx, cy, r, waist=0.25):
    w = r * waist
    return [(cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w),
            (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w)]


def render(size_px):
    big = SIZE * SCALE
    gradient = Image.new('RGB', (big, big))
    pixels = gradient.load()
    for y in range(big):
        for x in range(big):
            pixels[x, y] = gradient_color((x + y) / (2 * (big - 1)))
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=112 * SCALE, fill=255)
    image = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(image)
    scaled = lambda pts: [(x * SCALE, (y + OFFSET_Y) * SCALE) for x, y in pts]
    draw.polygon(scaled(anvil_points()), fill=ANVIL)
    for cx, cy, r in ((300, 138, 56), (374, 96, 24), (226, 104, 18)):
        draw.polygon(scaled(star_points(cx, cy, r)), fill=SPARK)
    return image.resize((size_px, size_px), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    master = render(1024)
    master.resize((512, 512), Image.LANCZOS).save(OUT / 'icon.png')
    master.save(OUT / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('wrote', OUT / 'icon.png', OUT / 'icon.ico')


if __name__ == '__main__':
    main()
