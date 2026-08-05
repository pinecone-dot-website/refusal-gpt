#!/usr/bin/env python3
"""Render web/static/img/og-card.png — the 1200x630 social card.

    python3 scripts/make-og-card.py

Run it after changing the tagline. The card is what most people see: a link
posted to Reddit or Bluesky is an image and a title long before it is a website,
and on a .cyou domain a missing card reads as spam.

Pillow rather than an SVG rasteriser for one reason that matters — it can
MEASURE text. The first version guessed a font size and overflowed the canvas by
about 50px, which is invisible locally and permanent once the link is shared.
The headline is now fitted by search against real glyph widths, so it cannot
overflow whatever the copy becomes.

Archivo (the site's display face, OFL) is downloaded to a cache on first run.
Needs: pip install pillow
"""
import urllib.request

FONT_BASE = ("https://fonts.gstatic.com/s/archivo/v25/"
             "k3k6o8UDI-1M0wlSV9XAw6lQkqWY8Q82sJaRE-NWIDdgffTT")
FONT_FILES = {"400": "NDNp8A.ttf", "600": "6jRp8A.ttf", "700": "0zRp8A.ttf"}

import os, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
F = os.path.join(HERE, ".fontcache")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    REPO, "web", "static", "img", "og-card.png")

os.makedirs(F, exist_ok=True)
for weight, tail in FONT_FILES.items():
    path = os.path.join(F, f"archivo-{weight}.ttf")
    if not os.path.exists(path):
        print(f"  fetching Archivo {weight}…")
        urllib.request.urlretrieve(FONT_BASE + tail, path)

W, H = 1200, 630
PAD = 80
INNER = W - PAD * 2

PAPER, INK, SLATE, SLATE2, RULE, AMBER, AMBER_INK = (
    "#FAFAF8", "#14161A", "#5B6270", "#8A909C", "#E2E1DC", "#C8791A", "#8A5210",
)

def font(weight, size):
    return ImageFont.truetype(os.path.join(F, f"archivo-{weight}.ttf"), size)

img = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(img)

# ── brand lockup: the mark, drawn to match the CSS .mark, plus the wordmark ──
cx, cy, r, sw = PAD + 21, 104, 19, 5
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=INK, width=sw)
# the strike: a "/" through the disc, same direction as the nav mark
off = r * 0.72
d.line([cx - off, cy + off, cx + off, cy - off], fill=INK, width=sw)
d.text((PAD + 58, cy), "RefusalGPT", font=font(700, 32), fill=INK, anchor="lm")

# ── headline, fitted ────────────────────────────────────────────────────────
LINES = [[("The last model you’ll ever", INK)],
         [("need to ", INK), ("not", AMBER), (" do anything.", INK)]]

def line_width(parts, f):
    return sum(f.getlength(t) for t, _ in parts)

size = 88
while size > 40:
    f = font(700, size)
    if max(line_width(p, f) for p in LINES) <= INNER:
        break
    size -= 1
head = font(700, size)
leading = int(size * 1.09)

y = 270
for parts in LINES:
    x = PAD
    for text, colour in parts:
        d.text((x, y), text, font=head, fill=colour, anchor="ls")
        x += head.getlength(text)
    y += leading

# ── supporting line ─────────────────────────────────────────────────────────
sub = font(400, 27)
subtitle = "It understands your request completely, then declines."
assert sub.getlength(subtitle) <= INNER, "subtitle overflows"
d.text((PAD, y + 22), subtitle, font=sub, fill=SLATE, anchor="ls")

# ── footer ──────────────────────────────────────────────────────────────────
d.line([PAD, 516, W - PAD, 516], fill=RULE, width=1)
foot = font(600, 19)
d.text((PAD, 562), "refusalgpt.cyou", font=foot, fill=SLATE2, anchor="ls")
right = "100.00% DENIAL RATE"
assert foot.getlength(right) + foot.getlength("refusalgpt.cyou") + 40 <= INNER
d.text((W - PAD, 562), right, font=foot, fill=AMBER_INK, anchor="rs")

img.save(OUT, "PNG", optimize=True)
print(f"  wrote {OUT}  headline fitted at {size}px "
      f"(widest line {max(line_width(p, head) for p in LINES):.0f} of {INNER}px)")
