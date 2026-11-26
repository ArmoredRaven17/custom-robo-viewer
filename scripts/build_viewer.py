r"""Copy the converter's output into docs/data/ for the viewer.

    python scripts\build_viewer.py            # from F:\Custom Robo Extract\conv (or CR_CONV)

Only index.json, models/*.glb, tex/*.png and the UI web font (fonts/message_font.woff, built from the game's
message font by tools\extract_fonts.py) are copied; textures no model or variant references are skipped.
"""
import json
import os
import shutil
import sys
import time

SRC = os.environ.get("CR_CONV", r"F:\Custom Robo Extract\conv")
# UI textures Raven supplies (kept beside the extract, not in the repo); copied to docs/data/ui as PNG
APP_TEX = os.environ.get("CR_APP_TEX", r"F:\Custom Robo Extract\App Textures")
UI_TEXTURES = {"Background.tif": "panel_bg.png"}
# Theme Icons.tif: 1P..4P stacked on an opaque white sheet; split at the white gaps, white made transparent
THEME_SHEET = "Theme Icons.tif"
THEME_BANDS = [(0, 86), (86, 172), (172, 258), (258, 346)]
# app icon: the game's Robo Cube (TPL embedded in logo_read_us.dbn at 0x130600, image 1). Its palette is opaque
# with a near-black background baked in, which black_to_alpha removes.
APP_ICON = os.path.join("textures", "_embedded", "logo_read_us.dbn@130600_1.png")
# parts-menu category words from the game (sprite/custom.tpl): 70 BOMB, 71 GUN, 72 LEGS, 73 POD, 74 BODY
MENU_SPRITES = [f"sprite/custom.tpl#{k}" for k in (70, 71, 72, 73, 74)]
DST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "data")


def white_to_alpha(rgba, light=170):
    """Make the white sheet behind an icon transparent. Only light pixels connected to the sheet's edge count as
    background (flood fill), so highlights inside the letters, which the dark outline encloses, stay opaque. Those
    background pixels get alpha = largest channel distance from white, with the colour un-premultiplied, so the
    soft glow becomes a semi-transparent halo instead of a white box."""
    import numpy as np
    from collections import deque
    a = rgba[..., :3].astype(float)
    h, w = a.shape[:2]
    lightm = a.min(axis=2) >= light
    outside = np.zeros((h, w), bool)
    q = deque((y, x) for y in range(h) for x in (0, w - 1)) + deque((y, x) for x in range(w) for y in (0, h - 1))
    while q:
        y, x = q.popleft()
        if outside[y, x] or not lightm[y, x]:
            continue
        outside[y, x] = True
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not outside[ny, nx]:
                q.append((ny, nx))
    out = rgba.copy()
    alpha = (255 - a).max(axis=2) / 255.0
    bg = outside & (alpha > 0)
    col = 255 - (255 - a[bg]) / alpha[bg][:, None]
    out[..., :3][bg] = np.clip(np.round(col), 0, 255).astype(np.uint8)
    out[..., 3][outside] = np.round(alpha[outside] * 255).astype(np.uint8)
    return out


def black_to_alpha(rgba, dark=72):
    """The white_to_alpha idea for a black sheet: dark pixels connected to the edge are background; they get
    alpha = brightest channel, colour un-premultiplied, so a glow fades out instead of leaving a black box."""
    import numpy as np
    from collections import deque
    a = rgba[..., :3].astype(float)
    h, w = a.shape[:2]
    darkm = a.max(axis=2) <= dark
    outside = np.zeros((h, w), bool)
    q = deque([(y, x) for y in range(h) for x in (0, w - 1)] + [(y, x) for x in range(w) for y in (0, h - 1)])
    while q:
        y, x = q.popleft()
        if outside[y, x] or not darkm[y, x]:
            continue
        outside[y, x] = True
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not outside[ny, nx]:
                q.append((ny, nx))
    out = rgba.copy()
    alpha = a.max(axis=2) / 255.0
    bg = outside & (alpha > 0)
    out[..., :3][bg] = np.clip(np.round(a[bg] / alpha[bg][:, None]), 0, 255).astype(np.uint8)
    out[..., 3][outside] = np.round(alpha[outside] * 255).astype(np.uint8)
    return out


def save_theme_icons(sheet):
    from PIL import Image
    import numpy as np
    a = np.asarray(Image.open(sheet).convert("RGBA"))
    os.makedirs(os.path.join(DST, "ui"), exist_ok=True)
    for k, (y0, y1) in enumerate(THEME_BANDS):
        Image.fromarray(white_to_alpha(a[y0:y1])).save(os.path.join(DST, "ui", f"theme_p{k + 1}.png"))


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
    import numpy as np
    a = np.asarray(im)
    py, px = _period(a, 0), _period(a, 1)
    h, w = a.shape[0] // py * py, a.shape[1] // px * px
    im.crop((0, 0, w, h)).save(path)


def copy_stats(stats_src):
    """stats.json (tools\\extract_stats.py) plus the game sprites it names ("sprite/custom.tpl#55" ->
    conv/textures/sprite/custom_55.png) into docs/data/ui."""
    stats = json.load(open(stats_src, encoding="utf-8"))
    refs = [stats.get("bar", {}).get("sprite")] + [c.get("sprite") for c in stats.get("categories", {}).values()]
    refs += list(stats.get("categories", {}).get("body", {}).get("type_sprites", {}).values())
    refs += MENU_SPRITES
    os.makedirs(os.path.join(DST, "ui"), exist_ok=True)
    for ref in filter(None, refs):
        path, k = ref.split("#")
        src = os.path.join(SRC, "textures", os.path.splitext(path)[0].replace("/", os.sep) + f"_{k}.png")
        name = os.path.basename(os.path.splitext(path)[0]) + f"_{k}.png"
        shutil.copy2(src, os.path.join(DST, "ui", name))
    shutil.copy2(stats_src, os.path.join(DST, "stats.json"))


def main():
    index = json.load(open(os.path.join(SRC, "index.json")))
    models = [r["glb"] for r in index["robos"]] + [p["glb"] for ps in index["parts"].values() for p in ps]
    tex = set()
    for r in index["robos"]:
        for v in r["variants"]:
            tex.update(v["tex"].values())
    for m in models:
        g = open(os.path.join(SRC, "models", m), "rb").read()
        n = int.from_bytes(g[12:16], "little")
        js = json.loads(g[20:20 + n])
        tex.update(os.path.basename(i["uri"]) for i in js.get("images", []) if "uri" in i)
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    os.makedirs(os.path.join(DST, "models"))
    os.makedirs(os.path.join(DST, "tex"))
    for m in models:
        shutil.copy2(os.path.join(SRC, "models", m), os.path.join(DST, "models", m))
    for t in sorted(tex):
        shutil.copy2(os.path.join(SRC, "tex", t), os.path.join(DST, "tex", t))
    font = os.path.join(SRC, "fonts", "message_font.woff")
    if os.path.exists(font):
        os.makedirs(os.path.join(DST, "fonts"))
        shutil.copy2(font, os.path.join(DST, "fonts", "message_font.woff"))
    if os.path.isdir(APP_TEX):
        from PIL import Image
        os.makedirs(os.path.join(DST, "ui"), exist_ok=True)
        for src, dst in UI_TEXTURES.items():
            if os.path.exists(os.path.join(APP_TEX, src)):
                save_tile(Image.open(os.path.join(APP_TEX, src)).convert("RGBA"), os.path.join(DST, "ui", dst))
    icon = os.path.join(SRC, APP_ICON)
    if os.path.exists(icon):
        os.makedirs(os.path.join(DST, "ui"), exist_ok=True)
        from PIL import Image
        import numpy as np
        rgba = np.asarray(Image.open(icon).convert("RGBA"))
        Image.fromarray(black_to_alpha(rgba)).save(os.path.join(DST, "ui", "app_icon.png"))
    sheet = os.path.join(APP_TEX, THEME_SHEET)
    if os.path.exists(sheet):
        save_theme_icons(sheet)
    stats_src = os.path.join(SRC, "stats.json")
    if os.path.exists(stats_src):
        copy_stats(stats_src)
    index["build"] = int(time.time())       # the viewer appends it to model URLs so rebuilt GLBs are refetched
    json.dump(index, open(os.path.join(DST, "index.json"), "w"), separators=(",", ":"))
    print(f"{len(models)} models, {len(tex)} textures -> {DST}")


if __name__ == "__main__":
    sys.exit(main())
