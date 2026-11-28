// Custom Robo Viewer: pick a robo body and colour, equip a gun, bomb, pod and legs.
// Data: data/index.json + data/models/*.glb + data/tex/*.png, built by F:\Custom Robo Extract\tools\convert.py
// and copied here by scripts/build_viewer.py.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { GunAttack, EffectLib, setParticles } from './attack.js?v=17';
import { BombAttack, PodAttack } from './throw.js?v=14';
import { ParticleSystem } from './particles.js?v=2';
import { Mover } from './move.js?v=5';
import { effectInstance } from './attack.js?v=17';

const SLOTS = ['gun', 'bomb', 'pod', 'legs'];
// Player colour themes (the game gives each player one of four colours); icons from App Textures/Theme Icons.tif
const THEMES = [
  { name: 'P1', css: '#7B0808', icon: 'ui/theme_p1.png' }, { name: 'P2', css: '#002973', icon: 'ui/theme_p2.png' },
  { name: 'P3', css: '#006300', icon: 'ui/theme_p3.png' }, { name: 'P4', css: '#7B6B00', icon: 'ui/theme_p4.png' }];
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
renderer.localClippingEnabled = true;          // the target dummy is cut off at the floor while it rises
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
// Floor grid: 0.5-unit squares (a run covers up to ~0.11 units per frame, so the lines read as motion instead of
// strobing), all lines one colour (the floor wraps by one square while it scrolls, so a centre line would jump), and
// faded out with distance from the robo so its edge never shows.
const GRID_SIZE = 24, GRID_DIV = 48, GRID_FADE = [3.5, 10];
const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIV, 0x343c4a, 0x343c4a);
grid.material.transparent = true;
grid.material.depthWrite = false;
const floorCentre = { value: new THREE.Vector2() };       // the robo's x/z: the fade follows it
grid.material.onBeforeCompile = sh => {
  sh.uniforms.floorCentre = floorCentre;
  sh.vertexShader = 'varying vec3 vFloorW;\n' + sh.vertexShader.replace('#include <project_vertex>',
    '#include <project_vertex>\nvFloorW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = 'varying vec3 vFloorW;\nuniform vec2 floorCentre;\n' + sh.fragmentShader.replace('#include <color_fragment>',
    `#include <color_fragment>\ndiffuseColor.a *= 1.0 - smoothstep(${GRID_FADE[0].toFixed(1)}, ${GRID_FADE[1].toFixed(1)}, length(vFloorW.xz - floorCentre));`);
};
scene.add(grid);

// ---- UI textures: crisp at any pixel ratio ----------------------------------------------------------
// Each texture pixel is drawn as round(devicePixelRatio) screen pixels, so the stripes stay even.
// panel_bg.png fills the panels (--panel-tex-size), nav_bg.png the navigation sidebar (--nav-tex-size).
const uiTextures = [['ui/panel_bg.png?v=2', '--panel-tex-size'], ['ui/nav_bg.png?v=2', '--nav-tex-size']]
  .map(([src, prop]) => { const im = new Image(); im.onload = sizeUiTextures; im.src = src; return [im, prop]; });
function sizeUiTextures() {
  const k = Math.max(1, Math.round(devicePixelRatio)) / devicePixelRatio;
  for (const [im, prop] of uiTextures) {
    if (im.naturalWidth) document.documentElement.style.setProperty(prop,
      `${im.naturalWidth * k}px ${im.naturalHeight * k}px`);
  }
}
(function watchRatio() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { sizeUiTextures(); watchRatio(); },
    { once: true });
})();

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const glbCache = new Map();
const texCache = new Map();
let index, stats = null, roboObj = null;
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
  $('motionSel').disabled = !has;
  for (const o of $('motionSel').options) {
    o.disabled = !roboAnim.actions[o.value];
    if (o.value === 'fly') o.hidden = !roboAnim.actions.fly;       // Lightning Sky bodies and Ruhiel only
  }
  // keep the pose chosen for the previous robo (Fly only exists on the transforming bodies; others fall back to idle)
  const chosen = roboAnim.selected;
  if (has) playMotion(roboAnim.actions[chosen] ? chosen : 'idle', 0);
  if (chosen) roboAnim.selected = chosen;     // a fallback to idle doesn't forget the choice
}

// Blend times from the parts menu (DOL 0x800528B8): idle blends in over 7 frames, the gun/bomb stances over 3.
// The walk/run loops and the midair pose use 6 frames: a viewer choice (the battle code's blend is not read).
const MENU_BLEND = { idle: 7, gun: 3, bomb: 3, walk: 6, run: 6, walk_back: 6, run_back: 6, air: 6 };
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
  if (next) roboAnim.selected = name;
  if (next) $('motionSel').value = name;
}

// ---- gun attack -------------------------------------------------------------------------------------
// Fire the equipped gun at a target (attack.js). The Midair stance fires the gun's AIR block, any other stance its
// GROUND block (the game picks by R+0x139 at the fire input); a ground shot switches to the Gun drawn stance, the
// firing motion (record slot 20), and both end with the recoil motion over the gun's recovery (onPose).
const fxLib = new EffectLib(loadGlb);
// HSD particles (particles.js): weapon effect joints spawn generators through their PTCL keys
const particles = new ParticleSystem(scene, camera);
particles.load().then(d => { if (d) setParticles(particles); });
const attack = new GunAttack({
  scene, loadGlb, lib: fxLib, sync: followBones,
  gun: () => (partObj.gun && state.gun >= 0 ? { id: state.gun, obj: partObj.gun } : null),
  airborne: () => roboAnim.selected === 'air' || mover.airborne,
  floorY: () => grid.position.y,
  // the target keeps its place in front of the robo; it holds while the robo is airborne, landing or attacking, and
  // rises up out of the floor at its new spot once the robo has settled (loop)
  origin: () => ({ pos: new THREE.Vector3(rig.position.x, 0, rig.position.z),
                   fwd: new THREE.Vector3(0, 0, -1).applyQuaternion(rig.getWorldQuaternion(new THREE.Quaternion())) }),
  onFire: air => {
    if (!air && roboAnim.selected !== 'gun') playMotion('gun');
    // the muzzle is read on the gun's rest pose (its clip's last frame), which the attack data's muzzle axis matches;
    // when the game plays the gun's own clip during a shot is not read
    if (partAnim.gun) { anim.playing = false; holdEnd(partAnim.gun); syncAnimUi(); }
  },
  // recovery: the recoil motion at the frame the fire state sets (record slot 25 ground / 22 air)
  onPose: p => { if (p) holdMotion(p.clip, p.frame); else if (roboAnim.held) endHold(); },
  onDone: () => { if (roboAnim.held) endHold(); },
});

/** Show one robo clip at a set frame without changing the chosen stance (the fire state's directly set frames). */
function holdMotion(name, frame, fadeTicks = 0) {
  const a = roboAnim.actions[name];
  if (!a || !roboAnim.mixer) return;
  if (roboAnim.current !== a) {
    const prev = roboAnim.current;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.play();
    if (prev && fadeTicks) prev.crossFadeTo(a, fadeTicks / 60, false);
    else if (prev) prev.stop();
    roboAnim.current = a;
  }
  roboAnim.held = name;
  a.paused = true;
  a.time = frame / (roboAnim.fps || 30);
}

/** Back to the chosen stance once the recoil ends (the game returns to the move state; the blend is a viewer choice). */
function endHold() {
  roboAnim.held = null;
  const name = roboAnim.selected || 'idle';
  const a = roboAnim.actions[name];
  if (a) a.paused = false;
  playMotion(name);
}

// ---- bombs and pods (throw.js): same target; the robo can only be in one attack state at a time -------------------
function boneWorld(role) {
  const b = roboObj && boneByRole(role);
  if (!b) return null;
  b.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
}
const throwCtx = slot => ({
  scene, lib: fxLib, sync: followBones, gun: attack,
  part: () => (partObj[slot] && state[slot] >= 0 ? { id: state[slot], obj: partObj[slot] } : null),
  body: () => state.robo,
  airborne: () => roboAnim.selected === 'air' || mover.airborne,
  floorY: () => grid.position.y,
  robo: () => {
    const pos = rig.getWorldPosition(new THREE.Vector3());
    pos.y = grid.position.y;                                 // R+0x20: the robo's feet
    return { pos, fwd: new THREE.Vector3(0, 0, -1).applyQuaternion(rig.getWorldQuaternion(new THREE.Quaternion())) };
  },
  bone: boneWorld,
  onPose: p => { if (p) holdMotion(p.clip, p.frame); else if (roboAnim.held) endHold(); },
  // a blast hit the target: its reaction (bombs / pods: pushed away from the blast)
  onHit: h => attack.hitTarget(h ? { down: h.X.down, v: h.X.hit_params, from: h.from } : null),
});
const bombs = new BombAttack(throwCtx('bomb'));
const pods = new PodAttack(throwCtx('pod'));
const acting = () => attack.acting || bombs.acting || pods.acting;
const blocked = () => acting() || (typeof mover !== 'undefined' && mover.state === 'charge');

// ---- jump, air moves, landing (move.js) and the legs part's effects ---------------------------------------------------
// Jump: hold for height (up to the legs/body hold ticks), press again in the air for an air move (dash, air jump or
// the flyers' steerable dash, by body). The robo moves through the world; the camera and the floor follow it.
const mover = new Mover({
  fields: () => {
    const d = mover.data;
    if (!d) return null;
    const legs = state.legs >= 0 ? state.legs : 0;
    const v = d.fields.values[String(state.robo)] && d.fields.values[String(state.robo)][legs];
    return v ? Object.fromEntries(d.fields.order.map((k, i) => [k, v[i]])) : null;
  },
  body: () => mover.data && mover.data.bodies.find(b => b.id === state.robo),
  facing: () => new THREE.Vector3(0, 0, -1).applyQuaternion(rig.getWorldQuaternion(new THREE.Quaternion())),
  attacking: () => acting(),
  position: () => new THREE.Vector3(home.x + mover.pos.x, mover.pos.y, home.z + mover.pos.z),
  target: () => attack.target,
  targetRadius: () => attack.targetRadius,
  targetShown: () => attack.shown,
  onCharge: (ev, m) => chargeEvent(ev, m),
  onPose: (name, frame, fade) => {
    if (acting()) return;                       // an attack's own pose (recoil, throw) wins
    if (name) holdMotion(name, frame, fade);
    else if (roboAnim.held) endHold();
  },
});
mover.load();

// The legs part's effects (READ, notes\move-effects.md): leg_effect.BIN entry = legs id (16+ copy 0), sets
//  boost: two instances at the knee nozzles (legs roots 4/5 locator: (4, 0, 0) in the knee root's space, local Z along
//         its X), started when a boosting tick finds the ramp at 0; the ramp moves 0.05/tick toward 1 while boosting
//         and toward 0 after, and at 0 the generators are killed (their particles finish);
//  land:  one instance at the robo's floor position on landing.
const legFx = { ramp: 0, boost: [], land: [], fx: null, id: -1 };
async function legFxPrepare() {
  const id = state.legs >= 0 && state.legs < 16 ? state.legs : 0;
  if (legFx.id !== id) { legFx.fx = await fxLib.get('leg', id); legFx.id = id; }
  return legFx.fx;
}
function nozzles() {
  const p = state.legs >= 0 && index.parts.legs.find(x => x.id === state.legs);
  const obj = partObj.legs;
  if (!p || !obj) return [];
  return ['legs0', 'legs2'].map(m => {
    const r = p.roots.find(x => x.mount === m);
    const root = r && obj.getObjectByName(r.node);
    if (!root) return null;
    let n = root.getObjectByName('nozzle');
    if (!n) {
      n = new THREE.Object3D();
      n.name = 'nozzle';
      n.position.set(4, 0, 0);
      n.rotation.y = Math.PI / 2;               // local Z onto the root's X (down the shin)
      root.add(n);
    }
    return n;
  }).filter(Boolean);
}
function legFxTick() {
  const boosting = mover.state === 'dash' || mover.state === 'airjump' || (mover.airborne && acting());
  if (boosting && legFx.ramp === 0 && legFx.fx) {
    for (const n of nozzles()) {
      const inst = effectInstance(legFx.fx, 'boost');
      scene.add(inst.root);
      legFx.boost.push({ inst, node: n, frame: 0 });
    }
  }
  legFx.ramp = THREE.MathUtils.clamp(legFx.ramp + (boosting ? 0.05 : -0.05), 0, 1);
  for (const b of legFx.boost) {
    b.node.updateWorldMatrix(true, false);
    b.inst.root.matrix.copy(b.node.matrixWorld);
    b.inst.root.matrixWorldNeedsUpdate = true;
    b.inst.setFrame(++b.frame);
  }
  if (legFx.ramp === 0 && legFx.boost.length) {
    for (const b of legFx.boost) { b.inst.kill(); scene.remove(b.inst.root); }
    legFx.boost = [];
  }
  legFx.land = legFx.land.filter(l => { if (++l.t < 600) return true; l.inst.kill(); scene.remove(l.inst.root); return false; });
}
function legFxStep() {
  const foot = roboObj && boneByRole('foot_R');
  if (!foot) return;
  legFxPrepare().then(fx => {
    if (!fx) return;
    const inst = effectInstance(fx, 'step');
    foot.updateWorldMatrix(true, false);
    inst.root.matrix.copy(foot.matrixWorld);
    scene.add(inst.root);
    inst.root.updateMatrixWorld(true);
    inst.setFrame(0);
    legFx.land.push({ inst, t: 0 });
  });
}
function legFxLand(pos) {
  if (!legFx.fx) return;
  const inst = effectInstance(legFx.fx, 'land');
  inst.root.matrix.makeTranslation(pos.x, pos.y, pos.z);
  scene.add(inst.root);
  inst.root.updateMatrixWorld(true);
  inst.setFrame(0);
  legFx.land.push({ inst, t: 0 });
}

const home = { x: 0, z: 0, last: new THREE.Vector3() };

// ---- collision charge (state 12): the body's aura on the robo, the impact at the hit (attack_effect.BIN[body]) -------
// READ (notes\move-effects.md 6): the aura (set `charge`) rides the robo matrix (Z = facing, Y = up, at the feet) and
// plays at 0.5 frame per tick while the charge lasts; the impact (set `impact`) appears once, on the hit, at the
// robo's position (frozen during phase 1 on some bodies) facing the charge, 20 frames at 1 per tick.
const charge = { aura: null, impact: [], fx: null, glow: 0 };
// The robo matrix the effects ride (R+0x194, 0x80039494): Z = normalize(-R+0x170, R+0x174, R+0x178), the facing in the
// game's velocity space (z already negated) with x negated, i.e. world Z = -facing: like the robo models (which face
// -z), the effects' +Z points behind the robo.
function facingMatrix(F, pos) {
  const z = F.clone().setY(0).normalize().negate(), y = new THREE.Vector3(0, 1, 0), x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos);
}
function feet(p) { return new THREE.Vector3(home.x + p.x, grid.position.y + p.y, home.z + p.z); }
async function chargeEvent(ev, m) {
  if (ev === 'start') {
    charge.fx = await fxLib.get('attack', state.robo);
    if (!charge.fx || mover.state !== 'charge') return;
    const inst = effectInstance(charge.fx, 'charge');
    scene.add(inst.root);
    charge.aura = { inst, frame: 0 };
  } else if (ev === 'hit') {
    // the charge always knocks down (down -1), launched by the attacker's recipe (+0x20 speed, +0x22 elevation, 100)
    const C = mover.ctx.body().charge;
    attack.hitTarget({ down: -1, v: [0, 0, 0, 0, C.launch_speed_raw, C.launch_elev_deg, 100], dir: m.dir });
    if (charge.fx) {
      const inst = effectInstance(charge.fx, 'impact');
      inst.root.matrix.copy(facingMatrix(m.dir, feet(m.anchor)));
      scene.add(inst.root);
      inst.root.updateMatrixWorld(true);
      inst.setFrame(0);
      charge.impact.push({ inst, frame: 0 });
    }
  } else if (ev === 'land') legFxLand(feet(m.pos));
  else if (ev === 'end') endAura();
}
function endAura() {
  // drawing stops; the aura's generators are not killed in the game (they run out on their own)
  if (charge.aura) { scene.remove(charge.aura.inst.root); charge.aura = null; }
}
function chargeTick() {
  if (charge.aura && mover.state === 'charge') {
    charge.aura.inst.root.matrix.copy(facingMatrix(mover.dir, feet(mover.pos)));
    charge.aura.inst.root.matrixWorldNeedsUpdate = true;
    charge.aura.frame += 0.5;
    charge.aura.inst.setFrame(charge.aura.frame);
  } else if (charge.aura) endAura();
  charge.impact = charge.impact.filter(c => {
    c.inst.setFrame(++c.frame);
    if (c.frame < 20) return true;
    c.inst.kill(); scene.remove(c.inst.root); return false;      // the end callback kills its generators
  });
  // the stealth / anchoring states draw the robo (and its parts) at alpha 0.5, translucent (0x80038FA4)
  setVanish(mover.vanish);
  // super armour: the body glows red (R+0x187C, x0.95 per tick), drawn as material colour (255 v, 0, 0)
  const g = mover.state === 'charge' ? mover.glow : charge.glow * 0.95;
  charge.glow = g;
  if (roboObj) eachMaterial(roboObj, mt => { if (mt.emissive) mt.emissive.setRGB(g, 0, 0); });
}
const vanishMat = new WeakMap();
let vanished = false;
function setVanish(on) {
  if (on === vanished && !on) return;
  vanished = on;
  for (const o of [roboObj, ...Object.values(partObj)]) if (o) eachMaterial(o, m => {
    if (!vanishMat.has(m)) vanishMat.set(m, { opacity: m.opacity, transparent: m.transparent });
    const orig = vanishMat.get(m);
    const t = on || orig.transparent;
    if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
    m.opacity = orig.opacity * (on ? 0.5 : 1);
  });
}

async function chargePress() {
  if (acting() || mover.state !== 'ground' || roboAnim.selected === 'air') return;
  await mover.load();
  const B = mover.ctx.body();
  if (!B || !B.charge) return;
  const C = B.charge, ticks = C.phases.reduce((n, p) => n + p.ticks + 1, 0);
  if (mover.startCharge()) $('fireLabel').textContent = `Charge: ${ticks} ticks, hits within ${(C.hit_range_units + attack.targetRadius).toFixed(2)} in the second phase, ${C.damage} damage`;
}
function moveLabel() {
  const F = mover.ctx.fields(), B = mover.ctx.body();
  if (!F || !B) return '';
  const style = ['dash', 'air jump', B.flies ? 'flying dash' : 'steerable dash'][B.dash_style];
  const n = B.dash_style === 1 ? B.air_jump_count : B.air_dash_count;
  const dist = ((F.dash_ticks + 1) * 0.001 * F.dash_speed).toFixed(1);
  const extra = B.dash_style === 1 ? `air jump ${(0.01 * F.air_jump_height).toFixed(1)} up` : `${style} ${dist} units`;
  return `Jump ${(0.01 * F.jump_height).toFixed(1)} units (hold), then ${n} × ${extra}`;
}
function moveTick() {
  const wasAir = mover.airborne && mover.state !== 'charge';
  mover.tick();
  chargeTick();
  if (wasAir && !mover.airborne) legFxLand(new THREE.Vector3(home.x + mover.pos.x, grid.position.y, home.z + mover.pos.z));
  legFxTick();
}
function moveUpdate(dt) {
  mover.acc = Math.min(mover.acc + dt, 0.25);
  while (mover.acc >= 1 / 60) { moveTick(); mover.acc -= 1 / 60; }
}
async function jumpPress() {
  if (mover.state === 'charge') return;                 // the charge cannot be cancelled
  if (roboAnim.selected === 'air') { $('fireLabel').textContent = 'Jump starts from a ground stance.'; return; }
  await mover.load();
  await legFxPrepare();
  if (mover.state === 'ground') $('fireLabel').textContent = moveLabel();
  mover.press();
}
function returnHome() {
  mover.reset();
  if (roboAnim.held) endHold();
}

async function fireBomb() {
  if (blocked()) return;
  const r = await bombs.fire();
  const bd = bombs.partData(state.bomb);
  if (!r) {
    $('fireLabel').textContent = !bd ? 'No attack data for this bomb.' : bombs.cooldown > 0 ? `Bomb reloading (${bombs.cooldown} ticks).` : '';
    return;
  }
  const b = r.block, X = b.explosion, n = Math.min(bd.bombs_per_launch, b.bombs.length);
  $('fireLabel').textContent = `${r.air ? 'Air' : 'Ground'} bomb: ${n} bomb${n > 1 ? 's' : ''} to ${b.aim_percent}% of the way, ` +
    `blast ${X.radius_peak.toFixed(2)}${X.blasts > 1 ? ` × ${X.blasts}` : ''}, fuse ${b.fuse_ticks}, reload ${b.cooldown_ticks}`;
}

async function firePod() {
  if (blocked()) return;
  const r = await pods.fire();
  const pd = pods.partData(state.pod);
  if (!r) { $('fireLabel').textContent = pd ? '' : 'No attack data for this pod.'; return; }
  if (r.full) { $('fireLabel').textContent = `${r.name}: ${r.max} already out.`; return; }
  $('fireLabel').textContent = `${r.air ? 'Air' : 'Ground'} pod: ${pd.per_use} per use, up to ${pd.max_alive} out, ` +
    `life ${pd.life_ticks}, lock ${pd.lock.range} / ${pd.lock.view_angle_deg}°`;
}

async function fireGun() {
  if (blocked()) return;
  const r = await attack.fire();
  const gd = attack.gunData(state.gun);
  if (!r) { if (!attack.busy) $('fireLabel').textContent = gd ? '' : 'No attack data for this gun.'; return; }
  const b = r.air ? gd.air : gd.ground;
  $('fireLabel').textContent = `${r.air ? 'Air' : 'Ground'} shot: ${b.volleys} volley${b.volleys > 1 ? 's' : ''} × ` +
    `${b.rounds_per_volley} round${b.rounds_per_volley > 1 ? 's' : ''}, range ${Math.round(b.range)}`;
}

function shotView() {
  attack.placeTarget();
  // the actual gap (the target may have been knocked further away than the distance setting)
  const rp = rig.getWorldPosition(new THREE.Vector3());
  const d = Math.max(attack.distance, Math.hypot(attack.target.x - rp.x, attack.target.z - rp.z));
  const c = rig.getWorldPosition(new THREE.Vector3()).lerp(attack.target, 0.5);
  c.y = 0.3;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.getWorldQuaternion(new THREE.Quaternion()));
  const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  // fit the robo-to-target span (plus a margin) across the narrower of the two fields of view
  const half = d * 0.65 + 2;
  const vfov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hfov = Math.atan(Math.tan(vfov) * camera.aspect);
  const dist = Math.max(6, half / Math.tan(Math.min(vfov, hfov)));
  camera.position.copy(c).addScaledVector(side, -dist).add(new THREE.Vector3(0, dist * 0.15, 0));
  controls.target.copy(c);
  camera.near = 0.05;
  camera.far = 400;
  camera.updateProjectionMatrix();
}

function menuStance(slot) {
  showPartStats(slot);
  const want = slot === 'gun' || slot === 'bomb' ? slot : 'idle';
  if (!roboAnim.current || roboAnim.current.getClip().name !== want) playMotion(want);
}

// ---- battle ground movement (notes\move-speed.md in the extract folder; READ from the DOL) ----------------------
// Max speed S blends the body's (lo, mid, hi) triple by the legs' position p (0x80006658); the steady speed is
// 0.1·S·|stick| per tick and the robo moves 0.01·speed per tick at 60 Hz (0x80049D08, 0x8004C740). The walk/run
// frame step is 30·0.035·speed / (legLength / 0.61); above 0.1·30 it runs and the step is ×0.18 (0x80049E90,
// 0x80049FFC). Run = full stick; walk = the fastest speed that still walks (any slower stick also walks).
// Back loops move at the same speed (the formula has no direction term).
const MOVE = { kSpeed: 0.1, kPos: 0.01, tick: 60, stride: 0.035, legRef: 0.61, runRate: 0.18, fps: 30 };
function legsPos() {
  const p = state.legs >= 0 && index.parts.legs.find(x => x.id === state.legs);
  return p && p.move ? p.move.pos : 100;     // no legs equipped: the body's mid value
}
function gaitFor(name) {
  const mv = index.robos[state.robo].move;
  const base = name.replace('_back', '');
  if (!mv || (base !== 'walk' && base !== 'run')) return null;
  const [lo, mid, hi] = mv.speed, p = legsPos();
  const S = Math.trunc(p <= 100 ? lo + (p * (mid - lo)) / 100 : mid + ((p - 100) * (hi - mid)) / 100);
  const legRatio = mv.legLength / MOVE.legRef;
  const vmax = MOVE.kSpeed * S;
  const walkTop = MOVE.kSpeed * legRatio / MOVE.stride;        // step / 30 == 0.1
  const v = base === 'run' ? vmax : Math.min(walkTop, vmax);
  const step = MOVE.fps * MOVE.stride * v / legRatio;
  const runs = step / MOVE.fps > MOVE.kSpeed;
  const framesPerTick = runs ? step * MOVE.runRate : step;
  return { speed: v * MOVE.kPos * MOVE.tick * (name.endsWith('_back') ? -1 : 1),   // model units / s along facing
           rate: framesPerTick * MOVE.tick / MOVE.fps };                            // × the clip's 30 fps
}

// While a walk/run loop plays (in place, as the game's pose code leaves it), its playback rate follows the game's
// frame step and the floor grid scrolls under the robo at the game's ground speed, both from the body + legs.
// Speeds are weighted by each action's blend weight, so the floor eases in and out with the cross-fade.
const GRID_CELL = GRID_SIZE / GRID_DIV;
const gridScroll = { x: 0, z: 0 };
const _floorV = new THREE.Vector3();
const _rigQ = new THREE.Quaternion();
const AIR_LIFT = 0.6;      // model units
// the midair pose and every clip the robo holds while attacking in the air (recoil, bomb throw, pod deploy)
const AIR_CLIPS = ['air', 'air_recoil', 'bomb_air', 'pod_air'];
function stepRobo(dt) {
  if (!roboAnim.mixer) return;
  let speed = 0;
  for (const [name, a] of Object.entries(roboAnim.actions)) {
    const g = gaitFor(name);
    if (!g) continue;
    a.timeScale = g.rate;
    if (a.isRunning()) speed += g.speed * a.getEffectiveWeight();
  }
  const runT = {};
  for (const n of ['run', 'run_back']) { const a = roboAnim.actions[n]; if (a && a.isRunning()) runT[n] = a.time; }
  roboAnim.mixer.update(dt);
  // run dust (READ, notes\move-effects.md): motion event at frame 25 of the run cycles spawns the legs part's
  // step effect at the right foot (bone 17)
  for (const [n, t0] of Object.entries(runT)) {
    const a = roboAnim.actions[n], ev = 25 / (roboAnim.fps || 30), t1 = a.time;
    if ((t0 < ev && t1 >= ev) || (t1 < t0 && (t0 < ev || t1 >= ev))) legFxStep();
  }
  // midair: lift the robo off the floor with the pose's blend weight. The pose is built at standing hip height and
  // its toes reach below the floor; the height is a viewer choice (the game's jump height is not read yet).
  // (the air recoil is held paused, so count scheduled rather than running actions)
  let airW = 0;
  for (const n of AIR_CLIPS) {
    const a = roboAnim.actions[n];
    if (a && a.isScheduled()) airW += a.getEffectiveWeight();
  }
  if (mover.active) rig.position.set(home.x + mover.pos.x, mover.pos.y, home.z + mover.pos.z);
  else rig.position.set(home.x, AIR_LIFT * Math.min(airW, 1) + (DOWN_POSES.includes(roboAnim.selected) ? downLift : 0), home.z);
  // the camera follows the robo across the floor; the floor's lines and fade stay centred on it
  // (height too: a 2-unit jump leaves a close view otherwise, and Return brings the view back with the robo)
  const dx = rig.position.x - home.last.x, dz = rig.position.z - home.last.z, dy = rig.position.y - home.last.y;
  if (dx || dy || dz) { camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
    controls.target.x += dx; controls.target.y += dy; controls.target.z += dz; }
  home.last.copy(rig.position);
  floorCentre.value.set(rig.position.x, rig.position.z);
  roboFloorClip.constant = -grid.position.y;          // keep y >= the floor (world)
  grid.position.x = gridScroll.x + Math.round(rig.position.x / GRID_CELL) * GRID_CELL;
  grid.position.z = gridScroll.z + Math.round(rig.position.z / GRID_CELL) * GRID_CELL;
  if (!speed) return;
  // model +z (the planted foot's direction) in world space, through the rig's turn
  _floorV.set(0, 0, speed * dt).applyQuaternion(rig.getWorldQuaternion(_rigQ));
  const wrap = v => ((v % GRID_CELL) + GRID_CELL) % GRID_CELL;
  gridScroll.x = wrap(gridScroll.x + _floorV.x);
  gridScroll.z = wrap(gridScroll.z + _floorV.z);
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
  if (slot === 'legs' && roboObj && state.robo !== undefined) updateFloor();   // legs parts change the foot height
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

const PART_ANIM_SPEED = 0.25;   // part clips play at 1/4 speed (the old speed selector's default)
function stepAnim(dt) {
  const speed = PART_ANIM_SPEED;
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
}

function bounds() {
  const box = new THREE.Box3();
  for (const o of [roboObj, ...Object.values(partObj)]) if (o) box.expandByObject(o);
  return box;
}

// ---- floor: under the lowest point of the idle loop -------------------------------------------------------------
// Skinned meshes keep bind-pose bounds, so the floor is measured on the posed vertices: the robo and its parts (legs
// parts sit under the feet) at 31 frames across the idle loop, lowest point over all of them, relative to the rig.
let floorY = null;
function idleFloor(samples = 30, clipName = 'idle', slots = null) {
  const clip = (roboObj.userData.clips || []).find(c => c.name === clipName);
  const saved = [];
  roboObj.traverse(o => { if (o.isBone) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });
  const objs = [roboObj, ...(slots ? slots.map(k => partObj[k]) : Object.values(partObj)).filter(Boolean)];
  const box = new THREE.Box3();
  let low = Infinity;
  const measure = () => {
    rig.updateMatrixWorld(true);
    followBones();
    for (const o of objs) { o.updateMatrixWorld(true); box.makeEmpty().expandByObject(o, true); if (!box.isEmpty()) low = Math.min(low, box.min.y); }
  };
  if (clip) {
    const mx = new THREE.AnimationMixer(roboObj);
    mx.clipAction(clip).play();
    for (let k = 0; k <= samples; k++) { mx.setTime(clip.duration * k / samples); measure(); }
    mx.stopAllAction();
    mx.uncacheRoot(roboObj);
  } else measure();
  // back to the pose the robo had (its own mixer re-applies the current motion)
  for (const [o, p, q, sc] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc); }
  if (roboAnim.mixer) roboAnim.mixer.update(0);
  rig.updateMatrixWorld(true);
  followBones();
  return low - rig.position.y;
}

// The Down poses lie lower than the idle feet: the robo is lifted so its body and legs part rest on the floor. Parts
// that still reach below it (pods on the back) are cut off at the floor, as the game's solid floor hides them.
const DOWN_POSES = ['down', 'down_face'];
let downLift = 0;
const roboFloorClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function updateDownLift() {
  downLift = 0;
  const down = !!roboObj && DOWN_POSES.includes(roboAnim.selected);
  for (const o of [roboObj, ...Object.values(partObj)]) if (o) eachMaterial(o, m => {
    const want = down ? [roboFloorClip] : null;
    if ((m.clippingPlanes || null) !== want && !(m.clippingPlanes && want)) { m.clippingPlanes = want; m.needsUpdate = true; }
  });
  if (!down || floorY === null) return;
  downLift = Math.max(0, floorY - idleFloor(1, roboAnim.selected, ['legs']));
}

function updateFloor() {
  if (!roboObj) return;
  // measured relative to the rig, so it holds in every stance: a midair robo is lifted above this same floor, and
  // swapping robos or legs midair moves the floor to the new robo's idle level at once
  floorY = idleFloor();
  grid.position.y = floorY;
  updateDownLift();
}

function frame(dir = [0, 0.15, 1]) {
  if (!roboObj) return;
  rig.updateMatrixWorld(true);
  const box = bounds();
  updateFloor();
  box.min.y = Math.min(box.min.y, floorY + rig.position.y);     // bind-pose bounds can miss the posed feet
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

// ---- Loading screen (as the MHGU viewers): "Loading..." over the render area, and nothing drawn, until the first robo
// is dressed and its camera set (`booted`), and again while a robo or load out swaps in, so the half-built robo is never
// seen. Counted, so nested holds (a load out switch applying a new robo) cannot leave it stuck on.
let booted = false, loadHold = 0;
function setLoading(on) {
  loadHold = Math.max(0, loadHold + (on ? 1 : -1));
  const show = !booted || loadHold > 0;
  $('loading').hidden = !show;
  document.body.classList.toggle('loading', show && booted);   // before boot the 'booting' class already locks the panels
}

const clock = new THREE.Clock();
function loop() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!booted || loadHold > 0) { clock.getDelta(); requestAnimationFrame(loop); return; }   // held: no frames advance
  if (window.__freeze) renderer.render(scene, camera);   // test hook: frames advance only through frameStep
  else frameStep(dt);
  requestAnimationFrame(loop);
}

/** One frame of the viewer (also driven by hand in tests while the page is hidden). */
function frameStep(dt) {
  resize();
  stepAnim(dt);
  moveUpdate(dt);
  stepRobo(dt);
  followBones();
  attack.shown = $('optTarget').checked;          // sinks / rises like a move (attack.js tick)
  if (!attack.busy && !bombs.busy && !pods.busy && mover.state === 'ground') attack.placeTarget();
  attack.update(dt);
  bombs.update(dt);
  pods.update(dt);
  // Turntable: orbit the camera round the target (the model stays put); 3.44 = the old 0.36 rad/s
  controls.autoRotate = $('optSpin').checked;
  controls.autoRotateSpeed = 3.44;
  controls.update(dt);
  particles.update(dt);          // after the camera moves: the quads face this frame's camera
  renderer.render(scene, camera);
}

function status(s) { $('status').textContent = s; }

// ---- UI ------------------------------------------------------------------------------------------
function label(x) { return x.name + (x.tag === 'illegal' ? ' ★' : ''); }

// Every part is listed: the game's "illegal" flag only bars parts from restricted play, so the viewer shows them all
// (still starred).
function fillParts() {
  for (const s of SLOTS) {
    const sel = $('sel-' + s);
    sel.innerHTML = '<option value="-1">— none —</option>' + index.parts[s]
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
  loadouts.bank();                       // the load out on screen keeps every change
}

// ---- Load Outs: saved robos (as the MHGU viewers' Hunter Slots) -----------------------------------------------------
// A load out is { name, state: {robo, colour, gun, bomb, pod, legs}, pose, camera }. The one on screen is banked on
// every change (and before a switch or leaving the page), so nothing needs saving by hand; clicking another switches to
// it, pose and camera included. Kept in localStorage.
const LO_KEY = 'cr-loadouts';
const loadouts = {
  list: [], index: 0, busy: false, renaming: false, ready: false,
  read() {
    try {
      const d = JSON.parse(localStorage.getItem(LO_KEY) || 'null');
      if (d && Array.isArray(d.list)) {
        this.list = d.list.filter(x => x && typeof x.name === 'string' && x.state && Number.isInteger(x.state.robo));
        this.index = Number.isInteger(d.index) && this.list[d.index] ? d.index : 0;
      }
    } catch (e) { this.list = []; }
  },
  write() {
    try { localStorage.setItem(LO_KEY, JSON.stringify({ list: this.list, index: this.index })); } catch (e) { /* private mode */ }
  },
  // The camera is kept RELATIVE TO THE ROBO: it follows the robo through jumps, dashes, the charge and the Down lift, so
  // a world-space save taken mid-move came back on reload (robo at home again) somewhere off to the side or up high.
  snapshot() {
    const r = home.last;                 // where the camera's follow last put the robo (stepRobo)
    return { state: { ...state }, pose: roboAnim.selected || 'idle',
             camera: { rel: true, pos: camera.position.clone().sub(r).toArray(), target: controls.target.clone().sub(r).toArray() } };
  },
  /** Put back a saved camera around where the robo is now. Older saves (world space, maybe mid-move) are not trusted:
   *  the robo's own framing stays. */
  restoreCamera(c) {
    if (!c || !c.rel || !Array.isArray(c.pos) || !Array.isArray(c.target)) return;
    const r = home.last;                 // where the camera's follow last put the robo (stepRobo)
    camera.position.fromArray(c.pos).add(r);
    controls.target.fromArray(c.target).add(r);
    controls.update();
  },
  bank() {
    if (!this.ready || this.busy || !this.list[this.index]) return;
    Object.assign(this.list[this.index], this.snapshot());
    this.write();
    if (!this.renaming) this.paint();
  },
  freeName() {
    for (let n = 1; ; n++) { const nm = 'Load Out ' + n; if (!this.list.some(x => x.name === nm)) return nm; }
  },
  paint() {
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    $('loadoutList').innerHTML = this.list.map((x, i) =>
      `<li class="${i === this.index ? 'on' : ''}" data-k="${i}" title="${i === this.index ? 'The load out on screen' : 'Switch to this load out'}">` +
      `<span class="n">${i + 1}.</span><span class="lab">${esc(x.name)}</span>` +
      `<span class="tag">${esc(index.robos[x.state.robo] ? index.robos[x.state.robo].name : '')}</span></li>`).join('');
    $('loDelete').disabled = this.list.length < 2;
  },
  async show(k, opt = {}) {
    const x = this.list[k];
    if (!x || this.busy || (k === this.index && !opt.force)) return;
    if (!opt.noBank) this.bank();
    this.busy = true;
    setLoading(true);
    try {
      this.index = k;
      this.paint();
      attack.clear(); bombs.clear(); pods.clear(); returnHome();
      await apply({ ...DEFAULT, ...x.state });
      if (x.pose && roboAnim.actions[x.pose]) { playMotion(x.pose, 0); $('motionSel').value = x.pose; updateDownLift(); }
      this.restoreCamera(x.camera);
    } finally { this.busy = false; setLoading(false); }
    this.bank();
  },
  /** Start-up: the saved load outs, or one from the page. A link carrying a different robo becomes a new load out. */
  init(fromHash) {
    this.read();
    const same = a => a && ['robo', 'colour', ...SLOTS].every(k => a[k] === fromHash[k]);
    const hasHash = location.hash.length > 1;
    if (!this.list.length) { this.list.push({ name: 'Load Out 1', state: { ...fromHash } }); this.index = 0; return fromHash; }
    if (hasHash && !same(this.list[this.index].state)) {
      this.list.push({ name: this.freeName(), state: { ...fromHash } });
      this.index = this.list.length - 1;
      return fromHash;
    }
    return { ...DEFAULT, ...this.list[this.index].state };
  },
};

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
  if (roboChanged) {
    setLoading(true);
    try { await setRobo(state.robo); } finally { setLoading(false); }
  } else {
    applyColour();
    for (const s of SLOTS) await setPart(s, state[s]);
  }
}

function wire() {
  // one panel open at a time: opening one closes the others
  document.querySelectorAll('.panel-head').forEach(h => h.onclick = () => {
    const p = h.parentElement, open = p.dataset.open !== 'true';
    document.querySelectorAll('.sidebar .panel').forEach(q => { q.dataset.open = 'false'; });
    p.dataset.open = open ? 'true' : 'false';
  });
  $('familySel').onchange = e => {
    const fam = roboFamilies()[+e.target.value];
    if (fam && !fam.robos.some(r => r.id === state.robo)) apply({ ...state, robo: fam.robos[0].id, colour: 0 });
  };
  for (const s of SLOTS) $('sel-' + s).onchange = async e => {
    state[s] = +e.target.value;
    writeHash();
    if (s === 'gun') attack.clear();
    if (s === 'bomb') bombs.clear();
    if (s === 'pod') pods.clear();
    await setPart(s, state[s]);
    menuStance(s);
    playPartClip(s);
  };
  // The parts menu (DOL 0x80101418) shows the gun / bomb stance while its cursor is on that category, and idle
  // on body, pod and legs; focusing a part list does the same here.
  for (const s of SLOTS) $('sel-' + s).addEventListener('focus', () => menuStance(s));
  ['optGrid', 'optWire'].forEach(id => $(id).onchange = applyView);
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
  // cycle the part stat chart through Gun / Bomb / Pod / Legs without touching the part lists
  const cycleStats = d => showPartStats(SLOTS[(SLOTS.indexOf(statSlot) + d + SLOTS.length) % SLOTS.length]);
  $('statPrev').onclick = () => cycleStats(-1);
  $('statNext').onclick = () => cycleStats(1);
  $('themeBtn').onclick = () => setTheme((themeIndex() + 1) % THEMES.length);
  $('motionSel').onchange = e => { playMotion(e.target.value, e.target.value === 'fly' ? 0.1 : undefined); updateDownLift(); loadouts.bank(); };
  $('fireBtn').onclick = fireGun;
  $('bombBtn').onclick = fireBomb;
  // Jump: held while the button / Space is down (the jump rises while held, up to the hold ticks)
  const jb = $('jumpBtn');
  jb.addEventListener('pointerdown', e => { e.preventDefault(); jumpPress(); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) jb.addEventListener(ev, () => mover.release());
  $('homeBtn').onclick = returnHome;
  $('chargeBtn').onclick = chargePress;
  $('podBtn').onclick = firePod;
  $('shotViewBtn').onclick = shotView;
  $('targetDist').oninput = e => { attack.distance = +e.target.value; $('targetDistVal').textContent = e.target.value; };
  addEventListener('keyup', e => { if (e.key === ' ') mover.release(); });
  addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); if (!e.repeat) jumpPress(); return; }
    if (k === 'c') { chargePress(); return; }
    if (k === 'f') fireGun();
    else if (k === 'b') fireBomb();
    else if (k === 'p') firePod();
  });
  $('randBtn').onclick = () => {
    const pick = a => a[Math.floor(Math.random() * a.length)].id;
    const all = s => index.parts[s];
    apply({ robo: state.robo, colour: state.colour, gun: pick(all('gun')), bomb: pick(all('bomb')),
            pod: pick(all('pod')), legs: pick(all('legs')) });
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
  $('loadoutList').onclick = e => {
    const li = e.target.closest && e.target.closest('li');
    if (li && !loadouts.renaming) loadouts.show(+li.dataset.k);
  };
  $('loCopy').onclick = () => {
    if (loadouts.busy) return;
    loadouts.bank();
    loadouts.list.push({ name: loadouts.freeName(), ...loadouts.snapshot() });
    loadouts.index = loadouts.list.length - 1;
    loadouts.paint(); loadouts.write();
  };
  $('loNew').onclick = async () => {
    if (loadouts.busy) return;
    loadouts.bank();
    loadouts.list.push({ name: loadouts.freeName(), state: { ...DEFAULT }, pose: 'idle' });
    await loadouts.show(loadouts.list.length - 1, { noBank: true });
  };
  $('loRename').onclick = () => {
    const li = $('loadoutList').querySelector('li.on');
    if (!li || loadouts.renaming) return;
    const x = loadouts.list[loadouts.index], lab = li.querySelector('.lab');
    const inp = document.createElement('input');
    inp.type = 'text'; inp.maxLength = 40; inp.value = x.name;
    loadouts.renaming = true;
    lab.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = keep => {
      if (done) return; done = true; loadouts.renaming = false;
      const v = inp.value.trim();
      if (keep && v) x.name = v.slice(0, 40);
      loadouts.paint(); loadouts.write();
    };
    inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
  };
  $('loDelete').onclick = async () => {
    if (loadouts.list.length < 2 || loadouts.busy) return;
    const x = loadouts.list[loadouts.index];
    if (!confirm(`Delete ${x.name}? Its robo and parts are lost.`)) return;
    loadouts.list.splice(loadouts.index, 1);
    const next = Math.min(loadouts.index, loadouts.list.length - 1);
    loadouts.index = -1;
    await loadouts.show(next, { noBank: true, force: true });
  };
  // the camera and pose are kept when leaving the page
  addEventListener('pagehide', () => loadouts.bank());
  document.addEventListener('visibilitychange', () => { if (document.hidden) loadouts.bank(); });
  addEventListener('hashchange', () => apply(readHash()));
}

// ---- target dummy: Oil Can with the Can parts, posed in its idle stance and drawn in the target's wireframe ----------
const DUMMY = { robo: 25, gun: 33, bomb: 31, pod: 35, legs: 10 };
async function buildDummy() {
  const r = index.robos[DUMMY.robo];
  if (!r) return;
  const robo = await loadGlb(r.glb);
  const root = new THREE.Group();
  root.add(robo);
  // its own motions (idle, falls, landing, get-up), each shown at a set frame by the reaction (react.js)
  const mixer = new THREE.AnimationMixer(robo);
  const actions = Object.fromEntries((robo.userData.clips || []).map(c => [c.name, mixer.clipAction(c)]));
  let current = null;
  const setPose = (name, frame = 0) => {
    const a = actions[name || 'idle'] || actions.idle;
    if (!a) return;
    if (current !== a) {
      if (current) current.stop();
      a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
      current = a;
    }
    a.paused = true;
    a.time = (name ? frame : 0) / 30;
    mixer.update(0);
  };
  setPose(null);
  robo.updateMatrixWorld(true);
  let sk = null;
  robo.traverse(o => { if (o.isSkinnedMesh) sk = o.skeleton; });
  const bone = role => { let f = null; robo.traverse(o => { if (!f && o.isBone && o.name.endsWith('_' + role)) f = o; }); return f; };
  const follow = [];
  for (const slot of SLOTS) {
    const p = index.parts[slot].find(x => x.id === DUMMY[slot]);
    if (!p) continue;
    const obj = await loadGlb(p.glb);
    // the same mount rule as the robo's parts (placeRoots + followBones)
    for (const m of p.roots) {
      const node = obj.getObjectByName(m.node), b = bone(MOUNT_ROLE[m.mount]);
      if (!node || !r.mounts[m.mount]) continue;
      const mount = new THREE.Matrix4().fromArray(r.mounts[m.mount]);
      node.matrixAutoUpdate = false;
      node.matrix.copy(mount);
      if (b && sk) follow.push({ node, bone: b, offset: sk.boneInverses[sk.bones.indexOf(b)].clone().multiply(mount) });
    }
    // parts held at the end of their action clip: their rest pose
    const pc = obj.userData.clips && obj.userData.clips[0];
    if (pc) { const mx = new THREE.AnimationMixer(obj); const a = mx.clipAction(pc); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play(); mx.setTime(pc.duration); }
    root.add(obj);
  }
  const inv = new THREE.Matrix4(), m = new THREE.Matrix4();
  const update = () => {
    robo.updateMatrixWorld(true);
    inv.copy(robo.matrixWorld).invert();
    for (const f of follow) { m.multiplyMatrices(inv, f.bone.matrixWorld); f.node.matrix.multiplyMatrices(m, f.offset); f.node.matrixWorldNeedsUpdate = true; }
  };
  update();
  root.updateMatrixWorld(true);
  // feet: the lowest point of the posed model
  const box = new THREE.Box3().setFromObject(root, true);
  const hr = await fetch('data/hit_reactions.json', { cache: 'no-cache' }).then(x => (x.ok ? x.json() : null)).catch(() => null);
  const body = hr && hr.bodies.find(x => x.id === DUMMY.robo);
  attack.setDummy(root, box.min.y, body ? body.hurt_radius : 0.3, { setPose, update, body });
}

async function main() {
  index = await (await fetch('data/index.json', { cache: 'no-cache' })).json();
  stats = await fetch('data/stats.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  sizeStatSprites();
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', sizeStatSprites);
  wire();
  const first = loadouts.init(readHash());
  await apply(first);
  loadouts.ready = true;
  const lo = loadouts.list[loadouts.index];
  if (lo && lo.pose && lo.pose !== 'idle' && roboAnim.actions[lo.pose]) { playMotion(lo.pose, 0); $('motionSel').value = lo.pose; updateDownLift(); }
  if (lo) loadouts.restoreCamera(lo.camera);
  loadouts.bank();
  showPartStats();
  bombs.load().then(buildDummy).catch(err => console.error('target dummy', err));
  document.body.classList.remove('booting');
  booted = true;
  setLoading(false);         // no holds and booted: the overlay goes
  requestAnimationFrame(loop);
}
main().catch(err => { status('Failed to load: ' + err.message); console.error(err); });
window.__viewer = { loadouts, setLoading, frameStep, mover, charge, chargePress, legFx, moveTick, jumpPress, updateFloor, idleFloor, get floorY() { return floorY; }, grid, attack, bombs, pods, particles, state, get index() { return index; }, partObj, partAnim, get robo() { return roboObj; }, rig, camera, roboAnim, gaitFor };
