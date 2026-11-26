# Custom Robo Viewer

A robo customiser for *Custom Robo* (GameCube, USA). The page is three.js r169 (vendored), has no build step, and
uses only data read from the game disc.

- **Robo:** choose a body family, then one of its robos. Each robo shows the game's NORMAL / ARMOR / SPEED / OTHERS
  badge, its stat chart, its five colours (original, red, blue, green, yellow) and its description.
- **Parts:** equip a gun, bomb, pod and legs. Each part is placed where the game's battle code mounts it. A
  `< Part >` cycler shows each equipped part's stat chart and description.
- **Animation:**
  - Robo poses: Idle, Gun drawn and Bomb drawn, the stances the game's parts menu plays. Focusing the Gun or Bomb
    list switches the stance, as the menu cursor does. The Lightning Sky bodies and Ruhiel also have a Fly button
    for their flying mode.
  - Part animations: each part's own clip plays when the part is chosen; it can also be played or scrubbed.
- **Look:**
  - The UI uses the game's message font and menu sprites (stat bars, labels, category words).
  - A 1P–4P button switches the player theme colour.
- **Saving:** a loadout is kept in the URL hash (`#r=0&c=0&gun=0&bomb=0&pod=0&legs=0`) and can be saved or opened
  as .json.

```powershell
python -m http.server 5660 --directory docs
```

## Data
`docs\data` is gitignored. Nothing derived from the game is committed. It is built in `F:\Custom Robo Extract`, then
copied here:

```powershell
python -P tools\convert.py
```

```powershell
python -P tools\extract_textures.py
```

```powershell
python -P tools\extract_fonts.py
```

```powershell
python -P tools\extract_stats.py
```

```powershell
python -P "C:\Coding Repos\custom-robo-viewer\scripts\build_viewer.py"
```

Run the first four in `F:\Custom Robo Extract`:
- **`convert.py`:** models, textures and `index.json`.
- **`extract_textures.py`:** the menu sprites.
- **`extract_fonts.py`:** the web font.
- **`extract_stats.py`:** `stats.json`.

`build_viewer.py` copies them in. It also takes the panel texture and the theme icons from
`F:\Custom Robo Extract\App Textures`: it trims the texture to a seamless tile, splits the 1P–4P sheet and makes its
white background transparent.

How each piece is read from the game is documented in `F:\Custom Robo Extract\notes`. For example, part mounts are
in `mounts.md`, the poses in `robo-ik.md` and `menu-motions.md`, and the stats and robo types in `stats.md`.
