r"""Copy the converter's output into docs/data/ for the viewer.

    python scripts\build_viewer.py            # from F:\Custom Robo Extract\conv (or CR_CONV)

Only index.json, models/*.glb, tex/*.png, the UI web font (fonts/message_font.woff, built from the game's
message font by tools\extract_fonts.py) and the game sprites the UI uses (data/ui) are copied; textures no model or
variant references are skipped. docs/data is game-derived, gitignored and rebuilt from scratch on every run.

Raven's own app textures are not part of this build: they live in docs/ui (tracked), imported from the App Textures
folder by scripts\import_app_textures.py.
"""
import json
import os
import shutil
import sys
import time

SRC = os.environ.get("CR_CONV", r"F:\Custom Robo Extract\conv")
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


def _slim(v):
    """Drop the raw record bytes and the texts the viewer does not use (it has the descriptions from index.json)."""
    if isinstance(v, dict):
        return {k: _slim(x) for k, x in v.items() if k not in ("raw", "description", "dev_name")}
    if isinstance(v, list):
        return [_slim(x) for x in v]
    return v


def copy_effects():
    """Weapon effects (tools/effects.py: effects.json + models/gfx_<kind>_NN.glb + their textures) and the fire
    data (tools/gun_attacks.py: gun_attacks.json; tools/bomb_pod_attacks.py: bomb_attacks.json, pod_attacks.json),
    slimmed by _slim."""
    eff_src = os.path.join(SRC, "effects.json")
    if not os.path.exists(eff_src):
        return 0
    eff = json.load(open(eff_src, encoding="utf-8"))
    tex, n = set(), 0
    for kind in ("gun", "bomb", "pod", "leg", "attack"):
        for g in eff.get(kind, {}).values():
            shutil.copy2(os.path.join(SRC, "models", g["glb"]), os.path.join(DST, "models", g["glb"]))
            n += 1
            for st in g.values():
                if isinstance(st, dict):
                    for m in st.get("mats", []):
                        tex.update(([m["tex"]["img"]] if m.get("tex") else []) + m.get("imgs", []))
                        if m.get("tex1"):                       # the second TObj (Stun Gun, Wave Laser)
                            tex.update([m["tex1"]["img"]] + m["tex1"].get("imgs", []))
    # HSD particle banks (tools/particles.py: particles.json + one PNG per texture-group image)
    ptcl_src = os.path.join(SRC, "particles.json")
    if os.path.exists(ptcl_src):
        pt = json.load(open(ptcl_src, encoding="utf-8"))
        for bank in pt["banks"].values():
            for grp in bank["texg"]:
                tex.update(grp["images"])
        shutil.copy2(ptcl_src, os.path.join(DST, "particles.json"))
    for t in tex:
        shutil.copy2(os.path.join(SRC, "tex", t), os.path.join(DST, "tex", t))
    shutil.copy2(eff_src, os.path.join(DST, "effects.json"))
    # jump / air moves / landing (tools/move_air.py): per body the dash style and counts, per body x legs the
    # blended movement fields the simulation needs
    mv_src = os.path.join(SRC, "movement.json")
    if os.path.exists(mv_src):
        mv = json.load(open(mv_src, encoding="utf-8"))
        keep = ("id", "name", "dash_style", "air_dash_count", "air_jump_count", "dash_pitch_deg", "flies", "stealth_dash")
        def charge(b):
            c = {k: v for k, v in b["charge_attack_state12"].items() if k != "sim_flat_standard_legs"}
            return c
        out = {"units": mv["units"], "bodies": [{**{k: b[k] for k in keep}, "charge": charge(b)} for b in mv["bodies"]],
               "fields": mv["blended_fields_by_body_then_legs"]}
        json.dump(out, open(os.path.join(DST, "movement.json"), "w", encoding="utf-8"), separators=(",", ":"))
    # hit reactions (tools/hit_reactions.py): per body the down threshold, knockback / stagger %, down ticks
    hr_src = os.path.join(SRC, "hit_reactions.json")
    if os.path.exists(hr_src):
        hr = json.load(open(hr_src, encoding="utf-8"))
        keep = ("id", "name", "down_threshold", "knockback_pct", "stagger_pct", "down_ticks", "hurt_radius")
        out = {"constants": hr["constants"], "bodies": [{k: b[k] for k in keep} for b in hr["bodies"]]}
        json.dump(out, open(os.path.join(DST, "hit_reactions.json"), "w", encoding="utf-8"), separators=(",", ":"))
    for name in ("gun_attacks.json", "bomb_attacks.json", "pod_attacks.json"):
        src = os.path.join(SRC, name)
        if os.path.exists(src):
            atk = _slim(json.load(open(src, encoding="utf-8")))
            json.dump(atk, open(os.path.join(DST, name), "w", encoding="utf-8"), separators=(",", ":"))
    return n


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
    icon = os.path.join(SRC, APP_ICON)
    if os.path.exists(icon):
        os.makedirs(os.path.join(DST, "ui"), exist_ok=True)
        from PIL import Image
        import numpy as np
        rgba = np.asarray(Image.open(icon).convert("RGBA"))
        Image.fromarray(black_to_alpha(rgba)).save(os.path.join(DST, "ui", "app_icon.png"))
    stats_src = os.path.join(SRC, "stats.json")
    if os.path.exists(stats_src):
        copy_stats(stats_src)
    n_fx = copy_effects()
    index["build"] = int(time.time())       # the viewer appends it to model URLs so rebuilt GLBs are refetched
    json.dump(index, open(os.path.join(DST, "index.json"), "w"), separators=(",", ":"))
    print(f"{len(models)} models, {len(tex)} textures, {n_fx} effect models (guns, bombs, pods) -> {DST}")


if __name__ == "__main__":
    sys.exit(main())
