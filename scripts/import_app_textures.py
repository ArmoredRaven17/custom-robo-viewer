r"""Import Raven's app textures into the repo (docs/ui), where the viewer loads them from.

    python scripts\import_app_textures.py            # from F:\Custom Robo Extract\App Textures (or CR_APP_TEX)

The App Textures folder is where source art is collected; the app never reads it. Run this when a source changes,
then commit docs/ui. Sources that are missing are reported and their docs/ui copy is left as it is.

    Background.tif       -> panel_bg.png     panel tile, cropped to whole repeat periods (no seam)
    NavBackground.tif    -> nav_bg.png       sidebar tile, cropped the same way
    TitleBackground.tif  -> title_bg.png     title bar sheen
    Theme Icons.tif      -> theme_p1..4.png  1P..4P, split from the stacked sheet, white sheet made transparent
"""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_viewer import white_to_alpha  # noqa: E402

APP_TEX = os.environ.get("CR_APP_TEX", r"F:\Custom Robo Extract\App Textures")
DST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "ui")
TILES = {"Background.tif": "panel_bg.png", "NavBackground.tif": "nav_bg.png", "TitleBackground.tif": "title_bg.png"}
# Theme Icons.tif: 1P..4P stacked on an opaque white sheet; split at the white gaps
THEME_SHEET = "Theme Icons.tif"
THEME_BANDS = [(0, 86), (86, 172), (172, 258), (258, 346)]


def _period(a, axis):
    """Smallest repeat period of an image along an axis (rows for axis 0, columns for axis 1)."""
    n = a.shape[axis]
    for p in range(1, n):
        x, y = (a[p:], a[:-p]) if axis == 0 else (a[:, p:], a[:, :-p])
        if (x == y).all():
            return p
    return n


def save_tile(im, path):
    """Crop a repeating texture to a whole number of its periods, so tiling it shows no seam (Background.tif is
    173 rows of a 4-row stripe: the 173rd row doubled a line at every tile edge)."""
    a = np.asarray(im)
    py, px = _period(a, 0), _period(a, 1)
    h, w = a.shape[0] // py * py, a.shape[1] // px * px
    im.crop((0, 0, w, h)).save(path)


def main():
    os.makedirs(DST, exist_ok=True)
    missing = []
    for src, dst in TILES.items():
        p = os.path.join(APP_TEX, src)
        if not os.path.exists(p):
            missing.append(src)
            continue
        save_tile(Image.open(p).convert("RGBA"), os.path.join(DST, dst))
        print(f"{src} -> ui/{dst}")
    p = os.path.join(APP_TEX, THEME_SHEET)
    if os.path.exists(p):
        a = np.asarray(Image.open(p).convert("RGBA"))
        for k, (y0, y1) in enumerate(THEME_BANDS):
            Image.fromarray(white_to_alpha(a[y0:y1])).save(os.path.join(DST, f"theme_p{k + 1}.png"))
        print(f"{THEME_SHEET} -> ui/theme_p1..4.png")
    else:
        missing.append(THEME_SHEET)
    for m in missing:
        print(f"missing: {m} (docs/ui copy kept)")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
