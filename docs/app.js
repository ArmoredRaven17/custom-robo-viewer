// Custom Robo Viewer: pick a robo body and colour, equip a gun, bomb, pod and legs.
// Data: data/index.json + data/models/*.glb + data/tex/*.png, built by F:\Custom Robo Extract\tools\convert.py
// and copied here by scripts/build_viewer.py.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const SLOTS = ['gun', 'bomb', 'pod', 'legs'];
// Player colour themes (the game gives each player one of four colours); icons from App Textures/Theme Icons.tif
const THEMES = [
  { name: 'P1', css: '#7B0808', icon: 'data/ui/theme_p1.png' }, { name: 'P2', css: '#002973', icon: 'data/ui/theme_p2.png' },
  { name: 'P3', css: '#006300', icon: 'data/ui/theme_p3.png' }, { name: 'P4', css: '#7B6B00', icon: 'data/ui/theme_p4.png' }];
// Every robo's five colour variants (chara.BIN entries 5i..5i+4) are, in the game, the original colours then red,
// blue, green and yellow; the swatches use those fixed colours for every robo.
const ROBO_COLOURS = [
  { name: 'Original', css: '#8c8c8c' }, { name: 'Red', css: '#d02a2a' }, { name: 'Blue', css: '#2f62d6' },
  { name: 'Green', css: '#2fa84f' }, { name: 'Yellow', css: '#e3c21c' }];
const DEFAULT = { robo: 0, colour: 0, gun: 0, bomb: 0, pod: 0, legs: 0 };
const $ = id => document.getElementById(id);

// ---- scene ---------------------------------------------------------------------------------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1013);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(2, 4, 3);
scene.add(key);
const rim = new THREE.DirectionalLight(0xbcd4ff, 1.0);
rim.position.set(-3, 2, -3);
scene.add(rim);

// Robos face -z in the game's model space (face, kneecaps, toes; pods on +z); turn the rig so they face the
// default camera (+z). The robo is cloned with SkeletonUtils so its skinned mesh follows the rig.
const rig = new THREE.Group();
rig.rotation.y = Math.PI;
scene.add(rig);
const grid = new THREE.GridHelper(4, 40, 0x445060, 0x262c36);
scene.add(grid);

// ---- panel texture: crisp at any pixel ratio ------------------------------------------------------
// Each texture pixel is drawn as round(devicePixelRatio) screen pixels, so the stripes stay even.
const panelTex = new Image();
function sizePanelTexture() {
  if (!panelTex.naturalWidth) return;
  const k = Math.max(1, Math.round(devicePixelRatio)) / devicePixelRatio;
  document.documentElement.style.setProperty('--panel-tex-size',
    `${panelTex.naturalWidth * k}px ${panelTex.naturalHeight * k}px`);
}
panelTex.onload = sizePanelTexture;
panelTex.src = 'data/ui/panel_bg.png';
(function watchRatio() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { sizePanelTexture(); watchRatio(); },
    { once: true });
})();

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const glbCache = new Map();
const texCache = new Map();
let index, stats = null, roboObj = null, skelHelper = null;
const partObj = {};
const partAnim = {};      // slot -> { mixer, action, frames }
const roboAnim = { mixer: null, actions: {}, current: null };
// Each mount rides on one robo bone (notes\mounts.md in the extract folder); parts follow it when the robo moves.
const MOUNT_ROLE = { gun: 'elbow_R', bomb: 'elbow_L', pod0: 'torso', pod1: 'torso',
  legs0: 'knee_R', legs1: 'foot_R', legs2: 'knee_L', legs3: 'foot_L' };
const follow = [];        // { node, bone, offset }
const state = { ...DEFAULT };

function loadGlb(file) {
  if (!glbCache.has(file)) glbCache.set(file, loader.loadAsync('data/models/' + file + '?b=' + (index.build || 0)));
  // SkeletonUtils.clone rebinds skinned meshes to the cloned bones (a plain clone keeps the cached skeleton,
  // which never moves with the rig).
  // Culling is off: skinned and animated meshes keep their bind-pose bounds, so posed parts could vanish at
  // some camera angles.
  return glbCache.get(file).then(g => {
    const o = SkeletonUtils.clone(g.scene);
    o.traverse(m => { if (m.isMesh) m.frustumCulled = false; });
    o.userData.clips = g.animations;
    return o;
  });
}

function tex(file) {
  if (!texCache.has(file)) {
    const t = texLoader.load('data/tex/' + file);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    texCache.set(file, t);
  }
  return texCache.get(file);
}

function eachMaterial(obj, fn) {
  obj.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => fn(m, o)); });
}

// ---- robo ----------------------------------------------------------------------------------------
async function setRobo(i) {
  const r = index.robos[i];
  status(`Loading ${r.name}…`);
  const obj = await loadGlb(r.glb);
  if (state.robo !== i) return;
  // materials are cloned per load so colour swaps never touch the cache
  eachMaterial(obj, (m, mesh) => { mesh.material = m.clone(); });
  if (roboObj) rig.remove(roboObj);
  if (roboAnim.mixer) roboAnim.mixer.stopAllAction();
  roboObj = obj;
  rig.add(obj);
  setupRoboMotions(obj);
  applyColour();
  applyView();
  for (const s of SLOTS) await setPart(s, state[s]);
  frame();
  status('');
}

function applyColour() {
  const r = index.robos[state.robo];
  const v = r.variants[state.colour] || r.variants[0];
  eachMaterial(roboObj, m => {
    if (m.map && v.tex[m.map.name]) {
      const t = tex(v.tex[m.map.name]);
      t.name = m.map.name;
      m.map = t;
      m.needsUpdate = true;
    }
  });
  document.querySelectorAll('.swatch').forEach((b, k) => b.classList.toggle('on', k === state.colour));
}

// ---- parts ---------------------------------------------------------------------------------------
// Each part root sits at its mount: robo bone x T(t) x S(0.1) x diag(s), read from the game (index.json "mounts",
// computed by convert.py from the battle code at DOL 0x80039FAC and the per-robo table at 0x801C5C10).
function boneByRole(role) {
  let found = null;
  roboObj.traverse(o => { if (!found && o.isBone && o.name.endsWith('_' + role)) found = o; });
  return found;
}

function restBoneMatrix(bone) {
  // the bone's bind (rest) matrix in robo space: inverse of its inverse-bind matrix
  let sk = null;
  roboObj.traverse(o => { if (o.isSkinnedMesh) sk = o.skeleton; });
  const i = sk ? sk.bones.indexOf(bone) : -1;
  return i >= 0 ? sk.boneInverses[i].clone().invert() : new THREE.Matrix4();
}

function placeRoots(obj, p) {
  const mounts = index.robos[state.robo].mounts;
  for (const r of p.roots) {
    const node = obj.getObjectByName(r.node);
    if (!node || !mounts[r.mount]) continue;
    node.matrixAutoUpdate = false;
    node.matrix.fromArray(mounts[r.mount]);
    node.matrixWorldNeedsUpdate = true;
    const bone = boneByRole(MOUNT_ROLE[r.mount]);
    if (bone) follow.push({ node, bone, offset: restBoneMatrix(bone).invert().multiply(node.matrix) });
  }
}

const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();
function followBones() {
  if (!roboObj || !follow.length) return;
  roboObj.updateMatrixWorld(true);
  _inv.copy(roboObj.matrixWorld).invert();
  for (const f of follow) {
    _m.multiplyMatrices(_inv, f.bone.matrixWorld);
    f.node.matrix.multiplyMatrices(_m, f.offset);
    f.node.matrixWorldNeedsUpdate = true;
  }
}

// ---- robo motions --------------------------------------------------------------------------------
// idle / gun drawn / bomb drawn stances decoded from motion.DBN (notes\motions.md): the game's IK targets posed by convert.py.
function setupRoboMotions(obj) {
  roboAnim.actions = {};
  roboAnim.current = null;
  const clips = obj.userData.clips || [];
  roboAnim.mixer = clips.length ? new THREE.AnimationMixer(obj) : null;
  roboAnim.fps = (index.robos[state.robo].motions || {}).fps || 30;
  for (const c of clips) roboAnim.actions[c.name] = roboAnim.mixer.clipAction(c);
  const has = !!clips.length;
  for (const id of ['motIdle', 'motGun', 'motBomb']) $(id).disabled = !has;
  $('motFly').hidden = !roboAnim.actions.fly;
  if (has) playMotion('idle', 0);
}

// Blend times from the parts menu (DOL 0x800528B8): idle blends in over 7 frames, the gun/bomb stances over 3.
const MENU_BLEND = { idle: 7, gun: 3, bomb: 3 };
function playMotion(name, fade) {
  if (fade === undefined) fade = (MENU_BLEND[name] || 0) / (roboAnim.fps || 30);
  const A = roboAnim.actions;
  if (!roboAnim.mixer) return;
  const next = name === 'rest' ? null : A[name];
  const prev = roboAnim.current;
  if (next) {
    next.reset();
    // the stances loop (held); the flying transformation plays once and holds its last frame
    next.setLoop(name === 'fly' ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = true;
    next.play();
    if (prev && prev !== next && fade) prev.crossFadeTo(next, fade, false);
  }
  if (!next) roboAnim.mixer.stopAllAction();
  else if (prev && prev !== next && !fade) prev.stop();
  roboAnim.current = next;
  document.querySelectorAll('.motbtn').forEach(b => b.classList.toggle('on', b.dataset.m === name));
}

function menuStance(slot) {
  showPartStats(slot);
  const want = slot === 'gun' || slot === 'bomb' ? slot : 'idle';
  if (!roboAnim.current || roboAnim.current.getClip().name !== want) playMotion(want);
}

function stepRobo(dt) {
  if (!roboAnim.mixer) return;
  roboAnim.mixer.update(dt);
}

async function setPart(slot, id) {
  if (partObj[slot]) {
    for (let k = follow.length - 1; k >= 0; k--) if (partObj[slot].getObjectById(follow[k].node.id)) follow.splice(k, 1);
    rig.remove(partObj[slot]); partObj[slot] = null;
  }
  if (partAnim[slot]) { partAnim[slot].mixer.stopAllAction(); delete partAnim[slot]; }
  if (id == null || id < 0) { syncAnimUi(); if (slot === statSlot && index) showPartStats(); return; }
  const p = index.parts[slot].find(x => x.id === id);
  if (!p) return;
  const obj = await loadGlb(p.glb);
  if (state[slot] !== id) return;
  placeRoots(obj, p);
  obj.name = slot;
  partObj[slot] = obj;
  const clip = obj.userData.clips && obj.userData.clips[0];
  if (clip && p.anim) {
    const mixer = new THREE.AnimationMixer(obj);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    partAnim[slot] = { mixer, action, frames: p.anim.frames, fps: p.anim.fps };
    holdEnd(partAnim[slot]);
  }
  rig.add(obj);
  applyView();
  syncAnimUi();
  if (slot === statSlot) showPartStats();
}

// ---- part animations -----------------------------------------------------------------------------
// Each part's action clip (decoded from its HSD AnimJoint, notesnimations.md in the extract folder). Most run from
// an action pose into the rest pose; a few (e.g. Standard Bomb) start at rest. Play holds the last frame; Rest shows
// the rest pose with no clip applied.
const anim = { playing: false, frame: null };

function maxFrames() {
  return Math.max(0, ...Object.values(partAnim).map(a => a.frames));
}

function poseAt(f) {
  anim.frame = f;
  for (const a of Object.values(partAnim)) {
    a.action.play();
    a.action.paused = true;
    a.action.time = Math.min(f, a.frames) / a.fps;
    a.mixer.update(0);
  }
  $('animFrame').value = f;
  $('animLabel').textContent = `frame ${f.toFixed(1)} / ${maxFrames()}`;
}

// Parts rest on the last frame of their clip. Most clips end on the stored rest pose; Standard Bomb's starts there
// (folded) and ends open, so holding the stored rest pose left it folded unlike the others.
function holdEnd(a) {
  a.solo = null;
  a.action.play();
  a.action.paused = true;
  a.action.time = a.frames / a.fps;
  a.mixer.update(0);
}

function restPose() {
  anim.playing = false;
  anim.frame = null;
  for (const a of Object.values(partAnim)) holdEnd(a);
  syncAnimUi();
}

function syncAnimUi() {
  const n = maxFrames();
  $('animFrame').max = n || 10;
  $('animFrame').disabled = $('animPlay').disabled = !n;
  if (anim.frame == null) {
    $('animFrame').value = n;
    $('animLabel').textContent = n ? `deployed (clip: ${n} frames)` : 'no animation';
  } else poseAt(Math.min(anim.frame, n));
  $('animPlay').textContent = anim.playing ? 'Stop' : 'Play';
}

// Selecting a part plays that part's own clip once (at the chosen speed) and holds its last frame.
function playPartClip(slot) {
  const a = partAnim[slot];
  if (!a) return;
  a.solo = 0;
  a.action.play();
  a.action.paused = true;
  a.action.time = 0;
  a.mixer.update(0);
}

function stepAnim(dt) {
  const speed = Number($('animSpeed').value);
  for (const a of Object.values(partAnim)) {
    if (a.solo == null) continue;
    a.solo = Math.min(a.solo + dt * 60 * speed, a.frames);
    a.action.time = a.solo / a.fps;
    a.mixer.update(0);
    if (a.solo >= a.frames) a.solo = null;
  }
  if (!anim.playing) return;
  const f = (anim.frame ?? 0) + dt * 60 * speed;
  if (f >= maxFrames()) { anim.playing = false; poseAt(maxFrames()); syncAnimUi(); return; }
  poseAt(f);
}

// ---- view ----------------------------------------------------------------------------------------
function applyView() {
  const wire = $('optWire').checked;
  for (const o of [roboObj, ...Object.values(partObj)]) if (o) eachMaterial(o, m => { m.wireframe = wire; });
  grid.visible = $('optGrid').checked;
  if (skelHelper) { scene.remove(skelHelper); skelHelper = null; }
  if ($('optBones').checked && roboObj) {
    skelHelper = new THREE.SkeletonHelper(roboObj);
    scene.add(skelHelper);
  }
}

function bounds() {
  const box = new THREE.Box3();
  for (const o of [roboObj, ...Object.values(partObj)]) if (o) box.expandByObject(o);
  return box;
}

function frame(dir = [0, 0.15, 1]) {
  if (!roboObj) return;
  rig.updateMatrixWorld(true);
  const box = bounds();
  grid.position.y = box.min.y;
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  const d = new THREE.Vector3(...dir).normalize().multiplyScalar(size * 1.6);
  camera.position.copy(c).add(d);
  controls.target.copy(c);
  camera.near = size / 100;
  camera.far = size * 50;
  camera.updateProjectionMatrix();
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

const clock = new THREE.Clock();
function loop() {
  resize();
  const dt = Math.min(clock.getDelta(), 0.1);
  stepAnim(dt);
  stepRobo(dt);
  followBones();
  if ($('optSpin').checked) rig.rotation.y += 0.006;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

function status(s) { $('status').textContent = s; }

// ---- UI ------------------------------------------------------------------------------------------
function label(x) { return x.name + (x.tag === 'illegal' ? ' ★' : ''); }

function fillParts() {
  const showIllegal = $('optIllegal').checked;
  for (const s of SLOTS) {
    const sel = $('sel-' + s);
    sel.innerHTML = '<option value="-1">— none —</option>' + index.parts[s]
      .filter(p => showIllegal || p.tag !== 'illegal' || p.id === state[s])
      .map(p => `<option value="${p.id}">${label(p)}</option>`).join('');
    sel.value = String(state[s]);
  }
}

function fillRobo() {
  fillFamilies();
  const r = index.robos[state.robo];
  $('swatches').innerHTML = r.variants.map((v, k) => {
    const c = ROBO_COLOURS[k] || { name: `Colour ${k + 1}`, css: v.swatch || '#888' };
    return `<button class="swatch" style="background:${c.css}" title="${c.name}" data-k="${k}"></button>`;
  }).join('');
  $('swatches').querySelectorAll('.swatch').forEach(b => b.onclick = () => { state.colour = +b.dataset.k; applyColour(); writeHash(); });
  $('roboDesc').textContent = r.desc || '';
  const rs = stats && stats.robos[r.id];
  renderChart($('roboStats'), 'body', rs ? rs.stats : null);
}

// ---- stat charts (stats.json from tools\extract_stats.py; notes\stats.md) -------------------------------
// Drawn as the game's customize screen does (DOL 0x800FCE50): five 25-px columns 37 px apart over the category's
// label strip; a part value v shows v 5-px segments, a body value v shows v>>1 segments plus a 3-px half segment
// when odd; 0 hides the column. Legs have no chart in the game.
let statSlot = 'gun';
const SLOT_NAME = { gun: 'Gun', bomb: 'Bomb', pod: 'Pod', legs: 'Legs' };

function sprite(ref) { return ref ? 'data/ui/' + ref.split('/').pop().replace('.tpl#', '_') + '.png' : null; }

function renderChart(el, cat, values) {
  const c = stats && stats.categories[cat];
  if (!c) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const bar = sprite(stats.bar.sprite);
  // every column shows the bar sprite dimmed as its empty track; values fill it from the bottom
  const track = i => `<div class="col" style="--i:${i}"><div class="track" style="background-image:url(${bar})"></div>`;
  if (!c.sprite || !values) {
    // no chart in the game (legs) or no part: empty bars and a faded label row, so the panel stays the same.
    // Legs have no label strip in the game; the gun strip stands in, faded like the bars (Raven, 2026-11-26).
    const stand = stats.categories.gun && stats.categories.gun.sprite;
    const lab = stand ? `<img class="labels faded" src="${sprite(stand)}" alt="">` : '<div class="labels blank"></div>';
    el.innerHTML = `<div class="bars">${[0, 1, 2, 3, 4].map(i => track(i) + '</div>').join('')}</div>${lab}`;
    return;
  }
  const cols = values.map((v, i) => {
    const px = cat === 'body' ? 5 * (v >> 1) + (v & 1 ? 3 : 0) : 5 * v;
    const tip = `${c.labels[i]} ${v} / ${c.max}`;
    return track(i).replace('class="col"', `class="col" title="${tip}"`) +
      (v ? `<div class="fill" style="--h:${px};background-image:url(${bar})"></div>` : '') + '</div>';
  }).join('');
  el.innerHTML = `<div class="bars">${cols}</div><img class="labels" src="${sprite(c.sprite)}" alt="${c.labels.join(' ')}">`;
}

function showPartStats(slot) {
  if (slot) statSlot = slot;
  const id = state[statSlot];
  const list = stats && stats.parts[statSlot];
  const p = list && list.find(x => x.id === id);
  const part = index.parts[statSlot].find(x => x.id === id);
  $('partStatsTitle').textContent = part ? `${SLOT_NAME[statSlot]}: ${part.name}` : `${SLOT_NAME[statSlot]}: none`;
  renderChart($('partStats'), statSlot, p ? p.stats : null);
  $('partDesc').textContent = part ? (part.desc || '') : '';
  $('partDesc').hidden = !(part && part.desc);
}

// sprite pixels cover a whole number of screen pixels (about 1.33 CSS px per sprite pixel)
function sizeStatSprites() {
  const k = Math.max(1, Math.round(devicePixelRatio * 1.3)) / devicePixelRatio;
  document.documentElement.style.setProperty('--stat-k', k);
}

// ---- robo picker: by body family, then the family's robos -----------------------------------------
// The game's body menu (DOL list 0x8023B73A, pages of 3) labels rows NORMAL / ARMOR / SPEED on its first eight
// pages (one family each) and OTHERS after that (notes\stats.md). Family names come from the robos' own
// descriptions ("A Shining Fighter model."); the rest are grouped as Others in menu order.
let familiesCache = null;
function roboFamilies() {
  if (familiesCache) return familiesCache;
  const order = stats && stats.robos.every(r => r.menu_pos != null)
    ? [...stats.robos].sort((a, b) => a.menu_pos - b.menu_pos).map(r => r.id)
    : index.robos.map(r => r.id);
  const fams = [], others = { name: 'Others', robos: [] };
  order.forEach((id, pos) => {
    const r = index.robos[id];
    const s = stats && stats.robos[id];
    const type = s ? s.type : null;
    if (pos < 24) {
      const page = Math.floor(pos / 3);
      if (!fams[page]) {
        const m = /^An? (.+?) model\./.exec(r.desc || '');
        fams[page] = { name: m ? m[1] : `Family ${page + 1}`, robos: [] };
      }
      fams[page].robos.push({ id, type });
    } else others.robos.push({ id, type });
  });
  if (others.robos.length) fams.push(others);
  familiesCache = fams;
  return fams;
}

function fillFamilies() {
  const fams = roboFamilies();
  const fi = Math.max(0, fams.findIndex(f => f.robos.some(r => r.id === state.robo)));
  $('familySel').innerHTML = fams.map((f, k) => `<option value="${k}">${f.name}</option>`).join('');
  $('familySel').value = String(fi);
  const badge = t => {
    const ref = stats && stats.categories.body.type_sprites && stats.categories.body.type_sprites[t];
    return ref ? `<img class="type-badge" src="${sprite(ref)}" alt="${t}">` : '';
  };
  $('roboOpts').innerHTML = fams[fi].robos.map(o => {
    const r = index.robos[o.id];
    return `<button class="robo-opt${o.id === state.robo ? ' on' : ''}" data-id="${o.id}" title="${r.name}">` +
      `${badge(o.type)}<span>${label(r)}</span></button>`;
  }).join('');
  $('roboOpts').querySelectorAll('.robo-opt').forEach(b => b.onclick = () => {
    const id = +b.dataset.id;
    if (id !== state.robo) apply({ ...state, robo: id, colour: 0 });
  });
}

function themeIndex() {
  const k = +(localStorage.getItem('cr-theme') || 0);
  return k >= 0 && k < THEMES.length ? k : 0;
}

function setTheme(k) {
  const t = THEMES[k];
  document.documentElement.style.setProperty('--theme', t.css);
  $('themeIcon').src = t.icon;
  $('themeIcon').alt = t.name;
  $('themeBtn').title = `Player colour: ${t.name} (click for the next)`;
  try { localStorage.setItem('cr-theme', String(k)); } catch (e) { /* private mode: not remembered */ }
}
setTheme(themeIndex());

function writeHash() {
  const h = `r=${state.robo}&c=${state.colour}&` + SLOTS.map(s => `${s}=${state[s]}`).join('&');
  history.replaceState(null, '', '#' + h);
}

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const out = { ...DEFAULT };
  if (q.has('r')) out.robo = Math.max(0, Math.min(index.robos.length - 1, +q.get('r') || 0));
  if (q.has('c')) out.colour = Math.max(0, Math.min(4, +q.get('c') || 0));
  for (const s of SLOTS) if (q.has(s)) out[s] = +q.get(s);
  return out;
}

async function apply(next) {
  const roboChanged = next.robo !== state.robo || !roboObj;
  Object.assign(state, next);
  fillRobo();
  fillParts();
  writeHash();
  if (roboChanged) await setRobo(state.robo);
  else {
    applyColour();
    for (const s of SLOTS) await setPart(s, state[s]);
  }
}

function wire() {
  document.querySelectorAll('.panel-head').forEach(h => h.onclick = () => {
    const p = h.parentElement;
    p.dataset.open = p.dataset.open === 'true' ? 'false' : 'true';
  });
  $('familySel').onchange = e => {
    const fam = roboFamilies()[+e.target.value];
    if (fam && !fam.robos.some(r => r.id === state.robo)) apply({ ...state, robo: fam.robos[0].id, colour: 0 });
  };
  for (const s of SLOTS) $('sel-' + s).onchange = async e => {
    state[s] = +e.target.value;
    writeHash();
    await setPart(s, state[s]);
    menuStance(s);
    playPartClip(s);
  };
  // The parts menu (DOL 0x80101418) shows the gun / bomb stance while its cursor is on that category, and idle
  // on body, pod and legs; focusing a part list does the same here.
  for (const s of SLOTS) $('sel-' + s).addEventListener('focus', () => menuStance(s));
  ['optGrid', 'optWire', 'optBones'].forEach(id => $(id).onchange = applyView);
  $('optIllegal').onchange = fillParts;
  $('frontBtn').onclick = () => frame([0, 0.15, 1]);
  $('sideBtn').onclick = () => frame([1, 0.15, 0]);
  $('backBtn').onclick = () => frame([0, 0.15, -1]);
  $('resetBtn').onclick = () => { rig.rotation.y = Math.PI; apply({ ...DEFAULT }).then(() => frame()); };
  $('clearBtn').onclick = () => apply({ ...state, gun: -1, bomb: -1, pod: -1, legs: -1 });
  $('animPlay').onclick = () => {
    if (anim.playing) { restPose(); return; }
    anim.playing = true;
    poseAt(0);
    syncAnimUi();
  };
  $('animFrame').oninput = e => { anim.playing = false; poseAt(Number(e.target.value)); syncAnimUi(); };
  $('animRest').onclick = restPose;
  // cycle the part stat chart through Gun / Bomb / Pod / Legs without touching the part lists
  const cycleStats = d => showPartStats(SLOTS[(SLOTS.indexOf(statSlot) + d + SLOTS.length) % SLOTS.length]);
  $('statPrev').onclick = () => cycleStats(-1);
  $('statNext').onclick = () => cycleStats(1);
  $('themeBtn').onclick = () => setTheme((themeIndex() + 1) % THEMES.length);
  $('motIdle').onclick = () => playMotion('idle');
  $('motGun').onclick = () => playMotion('gun');
  $('motBomb').onclick = () => playMotion('bomb');
  $('motFly').onclick = () => playMotion('fly', 0.1);
  $('randBtn').onclick = () => {
    const pick = a => a[Math.floor(Math.random() * a.length)].id;
    const legal = s => index.parts[s].filter(p => $('optIllegal').checked || p.tag !== 'illegal');
    apply({ robo: state.robo, colour: state.colour, gun: pick(legal('gun')), bomb: pick(legal('bomb')),
            pod: pick(legal('pod')), legs: pick(legal('legs')) });
  };
  $('shotBtn').onclick = () => {
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.download = `${index.robos[state.robo].name.replace(/\W+/g, '_')}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  $('saveBtn').onclick = () => {
    const names = Object.fromEntries(SLOTS.map(s => [s, index.parts[s].find(p => p.id === state[s])?.name || null]));
    const doc = { app: 'custom-robo-viewer', version: 1, ...state, robo_name: index.robos[state.robo].name, part_names: names };
    const a = document.createElement('a');
    a.download = 'loadout.json';
    a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }));
    a.click();
  };
  $('openBtn').onclick = () => $('openFile').click();
  $('openFile').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      const next = { ...DEFAULT };
      for (const k of ['robo', 'colour', ...SLOTS]) if (Number.isInteger(d[k])) next[k] = d[k];
      await apply(next);
    } catch (err) { status('Could not read that loadout: ' + err.message); }
    e.target.value = '';
  };
  $('aboutBtn').onclick = () => $('about').showModal();
  addEventListener('hashchange', () => apply(readHash()));
}

async function main() {
  index = await (await fetch('data/index.json', { cache: 'no-cache' })).json();
  stats = await fetch('data/stats.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  sizeStatSprites();
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', sizeStatSprites);
  wire();
  await apply(readHash());
  showPartStats();
  document.body.classList.remove('booting');
  requestAnimationFrame(loop);
}
main().catch(err => { status('Failed to load: ' + err.message); console.error(err); });
window.__viewer = { state, get index() { return index; }, partObj, partAnim, get robo() { return roboObj; }, rig, camera };
