// Gun attack preview: fires the equipped gun at a target the way the battle code does (READ, notes\gun-attacks.md
// and notes\effects.md in the extract folder). Data: data/gun_attacks.json (fire blocks: ground and air) and
// data/effects.json + data/models/gfx_gun_NN.glb (projectile and muzzle flash models with their material tracks).
//
// Game logic, 60 ticks per second:
// - Fire picks the AIR block when the robo is airborne (R+0x139 == 2), else the GROUND block; every round keeps it.
// - Volleys fire at the block's tick times after the input; each spawns `rounds_per_volley` rounds at the muzzle
//   locator, heading along its world X axis.
// - A round runs through up to 5 phases (duration, speed, yaw / pitch homing limits, radius). Per tick: the fan and
//   random spread once at the start of the aim phase, homing toward the target, then pos += dir * speed.
// - The robo holds the firing pose (slot 20 ground / 21 air) through the volleys, then plays the recoil motion
//   (slot 25 <fam>_weapon_stiff / slot 22 sf_weapon_jump_stiff) frame by frame over the gun's recovery count.
// - The projectile model's local +Y points along the flight, scaled by the phase radius; its animation advances
//   30 / phase duration frames per tick. The muzzle flash shows ~9 ticks per volley at 0.5 frames per tick.
// - Guns with a trail block draw a ribbon behind each round (Trail).
// Viewer stand-ins (not read): the target is a sphere of Ray 01's hit radius (0.30) at grounded pelvis height, a set
// distance in front; there is no arena edge, no walls and no hit effects (the game's hit effect sets have no mesh).
import * as THREE from 'three';
import { Reaction } from './react.js?v=1';

const TICK = 1 / 60;
const BAMS = (2 * Math.PI) / 65536;
const UP = new THREE.Vector3(0, 1, 0);
const TARGET_RADIUS = 0.3;         // the default hit radius (Ray 01: body +0xAC x 0.01); setDummy replaces it
const MUZZLE_TICKS = 10;           // G+0x297 = 10 per volley, decremented after each gun update
const MUZZLE_RATE = 0.5;
const RISE_TICKS = 24;             // the target dummy sinking into / rising out of the floor when it moves (a viewer choice)           // anim frames per tick
// GX blend factors -> three.js
const GX_FACTOR = [THREE.ZeroFactor, THREE.OneFactor, THREE.SrcColorFactor, THREE.OneMinusSrcColorFactor,
  THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];

/** HSD FObj keys [frame, op, value, slopeIn, slopeOut] at frame f (CON step, LIN, SPL0 / SPL Hermite), as hsd.fobj_eval. */
export function fobjEval(keys, f) {
  if (!keys || !keys.length) return undefined;
  if (f <= keys[0][0]) return keys[0][2];
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], c = keys[i + 1];
    if (a[0] <= f && f < c[0]) {
      const span = c[0] - a[0], u = span ? (f - a[0]) / span : 0;
      if (a[1] === 1) return a[2];
      if (a[1] === 2) return a[2] + (c[2] - a[2]) * u;
      if (a[1] === 3 || a[1] === 4 || a[1] === 6) {
        const s0 = a[1] !== 3 ? a[4] : 0, s1 = c[1] === 4 ? c[3] : 0, u2 = u * u, u3 = u2 * u;
        return (2 * u3 - 3 * u2 + 1) * a[2] + (u3 - 2 * u2 + u) * span * s0 + (-2 * u3 + 3 * u2) * c[2] + (u3 - u2) * span * s1;
      }
      return a[2];
    }
  }
  return keys[keys.length - 1][2];
}

const _m3a = new THREE.Matrix3(), _m3b = new THREE.Matrix3();
/** One effect material at frame f: colour, alpha, image swap and the TObj UV transform. */
function applyMat(inst, m, f, alphaMul = 1) {
  const T = m.tracks || {};
  const ev = (k, d) => (T[k] ? fobjEval(T[k], f) : d);
  const mat = inst.material;
  const rm = m.rm, alphaSrc = (rm >> 13) & 3;           // 1 material, 2 vertex, 3 both
  mat.opacity = (alphaSrc & 1 ? THREE.MathUtils.clamp(ev('alpha', m.alpha), 0, 1) : 1) * alphaMul;
  if (alphaMul < 1 && !mat.transparent) { mat.transparent = true; mat.needsUpdate = true; }
  if (rm & 1) mat.color.setRGB(ev('difR', m.diffuse[0] / 255), ev('difG', m.diffuse[1] / 255), ev('difB', m.diffuse[2] / 255), THREE.SRGBColorSpace);
  else mat.color.setRGB(1, 1, 1);
  if (m.tex && inst.maps.length) {
    const k = m.imgs && T.img ? THREE.MathUtils.clamp(Math.round(ev('img', 0)), 0, inst.maps.length - 1) : 0;
    const map = inst.maps[k];
    if (mat.map !== map) mat.map = map;
    // HSD texture matrix (INFERRED from the HSD library): uv' = S * R * (uv - t), S = repeat / scale
    const t = m.tex;
    const su = ev('su', t.scale[0]), sv = ev('sv', t.scale[1]);
    const sx = su ? t.repeat[0] / su : 0, sy = sv ? t.repeat[1] / sv : 0;
    map.matrix.copy(_m3a.makeScale(sx, sy)).multiply(_m3b.makeRotation(ev('rot', t.rot)))
      .multiply(_m3b.makeTranslation(-ev('tu', t.trans[0]), -ev('tv', t.trans[1])));
  }
  // two-texture materials: each TObj's blend factor and the second one's UV transform (its own TexAnim tracks)
  if (inst.tev) {
    const U = inst.tev, t1 = m.tex1, T1 = t1.tracks || {};
    const ev1 = (k, d) => (T1[k] ? fobjEval(T1[k], f) : d);
    U.blend0.value = m.tex ? ev('blend', m.tex.blend) : 0;
    U.blend1.value = ev1('blend', t1.blend);
    const su = ev1('su', t1.scale[0]), sv = ev1('sv', t1.scale[1]);
    U.map1Matrix.value.copy(_m3a.makeScale(su ? t1.repeat[0] / su : 0, sv ? t1.repeat[1] / sv : 0))
      .multiply(_m3b.makeRotation(ev1('rot', t1.rot)))
      .multiply(_m3b.makeTranslation(-ev1('tu', t1.trans[0]), -ev1('tv', t1.trans[1])));
  }
}

// ---- two-texture TEV (Stun Gun 5, Wave Laser 42) --------------------------------------------------------------------
// READ data, INFERRED combine (HSD tobj.c, notes\effects.md "Second texture"): the TObjs apply in list order, prev
// starting at the material colour x vertex colour. Colour op = flags bits 16-19 (3 BLEND: lerp(prev, tex, blending),
// 4 MODULATE, 5 REPLACE, 7 ADD, 8 SUB), alpha op = bits 20-23 (2 BLEND, 3 MODULATE, 4 REPLACE, 6 ADD, 7 SUB).
const TEV_GLSL = `
uniform sampler2D map1; uniform float blend0; uniform float blend1;
uniform int cop0; uniform int aop0; uniform int cop1; uniform int aop1;
varying vec2 vUvB;
vec4 hsdTev(vec4 p, vec4 t, int cop, int aop, float k) {
  vec3 c = p.rgb; float a = p.a;
  if (cop == 3) c = mix(p.rgb, t.rgb, k);
  else if (cop == 4) c = p.rgb * t.rgb;
  else if (cop == 5) c = t.rgb;
  else if (cop == 7) c = p.rgb + t.rgb;
  else if (cop == 8) c = p.rgb - t.rgb;
  if (aop == 2) a = mix(p.a, t.a, k);
  else if (aop == 3) a = p.a * t.a;
  else if (aop == 4) a = t.a;
  else if (aop == 6) a = p.a + t.a;
  else if (aop == 7) a = p.a - t.a;
  return clamp(vec4(c, a), 0.0, 1.0);
}`;
function twoTexture(mat, mesh, m, map1) {
  const g = mesh.geometry;
  if (!g.attributes.uvB && g.attributes.uv1) g.setAttribute('uvB', g.attributes.uv1);
  const U = {
    map1: { value: map1 }, map1Matrix: { value: new THREE.Matrix3() },
    blend0: { value: 0 }, blend1: { value: 0 },
    cop0: { value: m.tex ? (m.tex.flags >> 16) & 15 : 0 }, aop0: { value: m.tex ? (m.tex.flags >> 20) & 15 : 0 },
    cop1: { value: (m.tex1.flags >> 16) & 15 }, aop1: { value: (m.tex1.flags >> 20) & 15 },
  };
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'attribute vec2 uvB;\nvarying vec2 vUvB;\nuniform mat3 map1Matrix;\n' + sh.vertexShader
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvUvB = (map1Matrix * vec3(uvB, 1.0)).xy;');
    sh.fragmentShader = TEV_GLSL + '\n' + sh.fragmentShader
      .replace('#include <map_fragment>', `
        #if defined(USE_COLOR_ALPHA)
          diffuseColor *= vColor;
        #elif defined(USE_COLOR)
          diffuseColor.rgb *= vColor;
        #endif
        #ifdef USE_MAP
          diffuseColor = hsdTev(diffuseColor, texture2D(map, vMapUv), cop0, aop0, blend0);
        #endif
        diffuseColor = hsdTev(diffuseColor, texture2D(map1, vUvB), cop1, aop1, blend1);`)
      .replace('#include <color_fragment>', '');
  };
  mat.userData.tev = U;
  mat.customProgramCacheKey = () => 'hsd-two-texture';
  mat.needsUpdate = true;
  return U;
}

/** Effect models from data/effects.json + data/models/gfx_<kind>_NN.glb, shared by guns, bombs and pods. */
export class EffectLib {
  constructor(loadGlb) {
    this.loadGlb = loadGlb;
    this.data = null;
    this.cache = new Map();
  }

  async load() {
    if (!this.data) {
      this.data = await fetch('data/effects.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    }
    return this.data;
  }

  /** kind 'gun' | 'bomb' | 'pod' -> { template, entry, textures, swaps } (cached per part). */
  async get(kind, id) {
    const key = kind + id;
    if (this.cache.has(key)) return this.cache.get(key);
    const e = this.data && this.data[kind] && this.data[kind][String(id)];
    if (!e) return null;
    const template = await this.loadGlb(e.glb);
    const textures = {};
    template.traverse(o => {
      if (o.isMesh && o.material.map) textures[o.name] = o.material.map;
    });
    // images for texture swaps share the first image's sampler settings
    const loader = new THREE.TextureLoader();
    const swaps = {};
    for (const set of Object.values(e)) {
      for (const m of (set && set.mats) || []) {
        if (!m.imgs) continue;
        const base = textures[m.node];
        swaps[m.node] = m.imgs.map(f => {
          const t = loader.load('data/tex/' + f);
          t.flipY = false;
          t.colorSpace = THREE.SRGBColorSpace;
          if (base) { t.wrapS = base.wrapS; t.wrapT = base.wrapT; t.magFilter = base.magFilter; t.minFilter = base.minFilter; }
          return t;
        });
      }
    }
    // second TObj images (Stun Gun, Wave Laser), with their own wrap modes
    const second = {};
    const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
    for (const set of Object.values(e)) {
      for (const m of (set && set.mats) || []) {
        if (!m.tex1) continue;
        const t = await loader.loadAsync('data/tex/' + m.tex1.img).catch(() => new THREE.Texture());
        t.flipY = false;
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = WRAP[m.tex1.wrap[0]] ?? THREE.ClampToEdgeWrapping;
        t.wrapT = WRAP[m.tex1.wrap[1]] ?? THREE.ClampToEdgeWrapping;
        t.needsUpdate = true;
        second[m.node] = t;
      }
    }
    const fx = { kind, id, template, entry: e, textures, swaps, second };
    this.cache.set(key, fx);
    return fx;
  }
}

// The particle runtime (particles.js), set by the app: effect joints with PTCL keys spawn generators through it.
let PTCL = null;
export function setParticles(sys) { PTCL = sys; }

/** A fresh copy of one effect set ('proj', 'muzzle', 'blast') with its own materials, textures and clip. */
export function effectInstance(fx, set) {
  const { template, entry, textures, swaps } = fx;
  const root = template.getObjectByName(set).clone(true);
  root.matrixAutoUpdate = false;
  const insts = [];
  for (const m of entry[set].mats) {
    const mesh = root.getObjectByName(m.node);
    if (!mesh || !mesh.isMesh) continue;
    const mat = mesh.material.clone();
    mesh.material = mat;
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    if (m.rm & 0x40000000) { mat.transparent = true; mat.depthWrite = false; }
    if (m.pe && m.pe.type === 1) {
      mat.blending = THREE.CustomBlending;
      mat.blendSrc = GX_FACTOR[m.pe.src] ?? THREE.SrcAlphaFactor;
      mat.blendDst = GX_FACTOR[m.pe.dst] ?? THREE.OneMinusSrcAlphaFactor;
    }
    const src = swaps[m.node] || (textures[m.node] ? [textures[m.node]] : []);
    const maps = src.map(t => { const c = t.clone(); c.matrixAutoUpdate = false; return c; });
    if (maps.length) mat.map = maps[0];
    const tev = m.tex1 && fx.second && fx.second[m.node] ? twoTexture(mat, mesh, m, fx.second[m.node]) : null;
    insts.push({ m, material: mat, maps, tev });
  }
  const clip = (template.userData.clips || []).find(c => c.name === entry[set].clip);
  let mixer = null;
  if (clip) {
    mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(clip).play();
  }
  const end = entry[set].end || 0;
  // visibility tracks (READ, JObj track 11, CON keys): value <= 0.5 hides the joint; before the first key the
  // joint's own hidden flag holds
  const vis = (entry[set].vis || []).map(v => ({ node: root.getObjectByName(v.node), v }))
    .filter(x => x.node);
  // PTCL keys (READ, track 40): each key spawns its generator on that joint when the animation reaches its frame
  // (start frame -1 / 0 on the first update); the generator then follows the joint
  const keys = (entry[set].ptcl || []).map(k => ({ node: root.getObjectByName(k.node), keys: k.keys }))
    .filter(x => x.node);
  let prev = -Infinity;
  const fire = ff => {
    if (!PTCL || !keys.length) return;
    if (ff < prev) prev = -Infinity;                       // restarted
    for (const { node, keys: ks } of keys) {
      for (const [kf, bank, id] of ks) if ((prev === -Infinity ? kf <= ff : kf > prev && kf <= ff)) PTCL.spawn(bank, id, node);
    }
    prev = ff;
  };
  const setFrame = (f, alphaMul = 1) => {
    const ff = Math.min(f, end);
    for (const i of insts) applyMat(i, i.m, ff, alphaMul);
    if (mixer) mixer.setTime(ff / 60);
    for (const { node, v } of vis) {
      let show = !v.hidden;
      for (const k of v.keys) if (k[0] <= ff) show = k[1] > 0.5;
      node.visible = show;
    }
    fire(ff);
  };
  setFrame(0);
  // psKillGenerators on the effect's joints (live particles finish on their own)
  const kill = () => { if (PTCL) PTCL.kill(root); };
  return { root, setFrame, end, kill };
}

// ---- ribbon trail (READ, notes\gun-attacks.md "Trail"; 0x80076B2C sampling, 0x800764D0 draw) -------------------
// A section is sampled every 2nd draw frame (one draw per tick assumed) into a 40-entry ring, at most L kept. Each
// section joins the previous sample's matrix to the current one: centre and +/-X edges, X = normalize(dir x up) *
// radius * width * taper. The first section starts at the muzzle. Colours: -X edge c0, centre c1, +X edge c2; alpha =
// trunc(max(a - a/L * age, 0.2)), age 1 at the newest end. Drawn as two quads per section (strip 4,5,3,5,2,0,1),
// vertex colour, normal alpha blending, z test on, no z write, double-sided. Pods use the same trail (only pod 25).
const RING = 40;
const _c = new THREE.Color();
function rgba(hex) {
  const v = parseInt(hex, 16);
  _c.setRGB(((v >>> 24) & 255) / 255, ((v >>> 16) & 255) / 255, ((v >>> 8) & 255) / 255, THREE.SRGBColorSpace);
  return [_c.r, _c.g, _c.b, v & 255];
}

export class Trail {
  constructor(spec, scene) {
    this.L = spec.length_sections;
    this.width = spec.half_width;
    this.cols = [rgba(spec.color_edge_neg_x), rgba(spec.color_centre), rgba(spec.color_edge_pos_x)];
    this.ring = new Array(RING);
    this.counter = 0; this.head = 0; this.count = 0; this.tail = 0;
    this.mtx = [null, null];
    const n = RING * 12;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true,
      depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.scene = scene;
    scene.add(this.mesh);
  }

  dispose() { this.scene.remove(this.mesh); this.geo.dispose(); this.mesh.material.dispose(); }

  /** One draw frame. M = {c: centre, x: X column (normalize(dir x up) * radius)}; start() gives the first section's
   *  far end (the muzzle). */
  sample(M, start) {
    if (++this.counter & 1) return;
    const cur = this.head & 1, prev = cur ^ 1;
    this.mtx[cur] = { c: M.c.clone(), x: M.x.clone() };
    if (this.count === 0) this.mtx[prev] = { c: start(), x: M.x.clone() };
    const e = this.tail + this.count;
    const tap = k => THREE.MathUtils.clamp(Math.sqrt(k / 6), 0.05, 1) * this.width;
    const sc = tap(e + 1), sp = tap(e);
    const C = this.mtx[cur], P = this.mtx[prev];
    const at = (m, k) => m.c.clone().addScaledVector(m.x, k);
    this.ring[this.head] = [at(C, -sc), at(P, -sp), P.c.clone(), at(P, sp), at(C, sc), C.c.clone()];
    this.count = Math.min(this.count + 1, this.L);
    this.head = (this.head + 1) % RING;
    this.tail = (this.head - this.count + RING) % RING;
    this.build();
  }

  build() {
    const TRI = [4, 5, 3, 3, 5, 2, 5, 2, 0, 2, 0, 1];      // the strip's non-degenerate triangles
    const COL = [0, 0, 1, 2, 2, 1];                         // v0..v5: -X, -X, centre, +X, +X, centre
    const CUR = [true, false, false, false, true, true];    // v0, v4, v5 are at the current end
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      const sec = this.ring[(this.tail + i) % RING];
      for (const v of TRI) {
        const p = sec[v], c = this.cols[COL[v]];
        const k = this.count - i + (CUR[v] ? 0 : 1);
        const a = Math.trunc(Math.max(c[3] - (c[3] / this.L) * k, 0.2));
        this.pos.set([p.x, p.y, p.z], w * 3);
        this.col.set([c[0], c[1], c[2], a / 255], w * 4);
        w++;
      }
    }
    this.geo.setDrawRange(0, w);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

export class GunAttack {
  /** ctx: { scene, loadGlb(file), sync(), gun() -> {id, obj} | null, airborne() -> bool, floorY() -> number,
   *         origin() -> {pos: Vector3, fwd: Vector3}, onFire(air), onPose({clip, frame} | null), onDone() } */
  constructor(ctx) {
    this.ctx = ctx;
    this.lib = ctx.lib || new EffectLib(ctx.loadGlb);
    this.data = null;
    this.fx = null;           // EffectLib entry for the gun
    this.rounds = [];
    this.hits = [];           // hit effects playing (their particles)
    this.seq = null;
    this.acc = 0;
    this.distance = 10;
    this.flash = null;
    this.hitFlash = 0;
    this.target = new THREE.Vector3();
    this.targetGroup = this.makeTarget();
    ctx.scene.add(this.targetGroup);
  }

  async load() {
    if (this.data) return this.data;
    const [atk, eff] = await Promise.all([
      fetch('data/gun_attacks.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
      this.lib.load()]);
    if (atk && eff) this.data = { guns: Object.fromEntries(atk.guns.map(g => [g.id, g])) };
    return this.data;
  }

  gunData(id) { return this.data && this.data.guns[id]; }

  makeTarget() {
    const g = new THREE.Group();
    this.targetRadius = TARGET_RADIUS;
    this.targetMat = new THREE.MeshBasicMaterial({ color: 0xffc23a, wireframe: true, transparent: true, opacity: 0.8 });
    // stand-in until the dummy robo loads: a sphere of the hit radius at the hit centre
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(TARGET_RADIUS, 16, 10), this.targetMat);
    g.add(this.sphere);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(TARGET_RADIUS * 0.9, TARGET_RADIUS * 1.15, 32),
      new THREE.MeshBasicMaterial({ color: 0xffc23a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    g.add(this.ring);
    this.pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]),
      new THREE.LineBasicMaterial({ color: 0xffc23a, transparent: true, opacity: 0.4 }));
    g.add(this.pole);
    this.dummy = null;
    // the target dummy is cut off at the floor, so it can rise up out of the grid when it moves
    this.floorClip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.targetMat.clippingPlanes = [this.floorClip];
    this.up = 1;                 // 0 = below the floor, 1 = standing; moves 1 / RISE_TICKS per tick
    this.pending = null;         // a new spot to move to: sink here first, then rise there
    this.placed = false;
    g.visible = false;
    return g;
  }

  /** The target robo (a posed model drawn in the target's wireframe), its feet height below its own origin in
   *  model units (footY, negative) and its hit radius (body +0xAC x 0.01). Replaces the sphere and pole. */
  setDummy(obj, footY, radius, rig) {
    if (this.dummy) this.targetGroup.remove(this.dummy);
    obj.traverse(o => { if (o.isMesh) { o.material = this.targetMat; o.frustumCulled = false; } });
    this.dummy = obj;
    this.dummyFootY = footY;
    this.rig = rig || null;
    this.react = rig && rig.body ? new Reaction(rig.body, (clip, f) => rig.setPose(clip, f)) : null;
    this.spot = this.target.clone();
    const box = new THREE.Box3().setFromObject(obj, true);
    this.dummyHeight = box.isEmpty() ? 2 : box.max.y - box.min.y;
    this.placed = false;
    this.targetRadius = radius;
    this.targetGroup.add(obj);
    this.sphere.visible = false;
    this.pole.visible = false;
    this.ring.scale.setScalar(radius / TARGET_RADIUS);
    this.placeTarget();
  }

  /** The target point: grounded pelvis height (y = 0), `distance` in front of the robo. */
  placeTarget() {
    const { pos, fwd } = this.ctx.origin();
    // hit centre at grounded pelvis height (y = 0), `distance` in front of the robo; a new spot makes the dummy rise
    // up out of the floor there instead of jumping to it
    const x = pos.x + fwd.x * this.distance, z = pos.z + fwd.z * this.distance;
    // while it reacts to a hit the target stays where the hit took it; after, it goes back to its spot
    if (this.react && !this.react.idle && this.react.state !== 'stand') return;
    const base = this.spot || this.target;
    const moved = Math.hypot(x - base.x, z - base.z) > 1e-3 || (this.react && this.react.pos.lengthSq() > 1e-8);
    if (!this.dummy || !this.placed) {
      // first placement: straight there (the dummy then rises from below the floor)
      this.placed = !!this.dummy;
      if (this.dummy) this.up = 0;
      this.moveTo(x, z, fwd);
    } else this.pending = moved ? { x, z, fwd } : null;    // the dummy sinks, moves, then rises (tick)
    const drop = -this.ctx.floorY();                 // from the hit centre down to its own feet
    this.ring.position.y = -drop + 0.002;
    this.pole.scale.y = Math.max(drop, 0.001);
    this.floorY = -drop;
    this.placeDummy();
  }

  moveTo(x, z, fwd) {
    this.target.set(x, 0, z);
    if (this.spot) this.spot.set(x, 0, z);
    if (this.react) this.react.reset();
    this.targetGroup.position.copy(this.target);
    // stand facing the robo (model -z toward it)
    this.faceAngle = Math.atan2(fwd.x, fwd.z);
    if (this.dummy) this.dummy.rotation.y = this.faceAngle;
  }

  /** A hit on the target: its reaction (react.js) from the hit's down value and recipe values.
   *  h: { down, v: [7], dir } or { down, v, from } (pushed away from `from`); null = a flash only. */
  hitTarget(h) {
    this.hitFlash = 15;
    if (!h || !this.react) return;
    const dir = h.dir ? h.dir.clone() : this.target.clone().sub(h.from);
    // the dummy's current facing: model -z at rotation.y
    const a = this.dummy.rotation.y, facing = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
    this.react.hit({ down: h.down, v: h.v, dir, facing });
  }

  /** The dummy's height: standing, or part way below the floor. Sinking plays the rise backwards. */
  placeDummy() {
    if (!this.dummy || this.floorY === undefined) return;
    const k = this.up;
    const e = 1 - (1 - k) * (1 - k) * (1 - k);
    const r = this.react ? this.react.pos : null;
    this.dummy.position.y = this.floorY - this.dummyFootY - (1 - e) * (this.dummyHeight + 0.05) + (r ? r.y : 0);
    if (r && this.spot) {
      // the reaction moves the whole target (dummy, ring, hit centre) off its spot
      this.targetGroup.position.set(this.spot.x + r.x, 0, this.spot.z + r.z);
      this.target.set(this.spot.x + r.x, r.y, this.spot.z + r.z);
      if (this.react.facing) this.dummy.rotation.y = Math.atan2(-this.react.facing.x, -this.react.facing.z);
      else if (this.faceAngle !== undefined) this.dummy.rotation.y = this.faceAngle;
    }
    if (this.rig) this.rig.update();
    this.floorClip.constant = -this.floorY;                       // keep y >= the floor (world; the group sits at y 0)
  }

  async prepare(id) {
    if (!this.fx || this.fx.id !== id) this.fx = await this.lib.get('gun', id);
    return this.fx;
  }

  instance(set) { return effectInstance(this.fx, set); }

  get busy() { return !!this.seq; }

  /** The robo is still in the fire state (volleys or recovery), so no other weapon can start. */
  get acting() { return !!this.seq && !this.seq.done; }

  async fire() {
    await this.load();
    const gun = this.ctx.gun();
    if (!gun || this.seq) return null;
    const gd = this.gunData(gun.id);
    if (!gd) return null;
    await this.prepare(gun.id);
    const air = this.ctx.airborne();
    const block = air ? gd.air : gd.ground;          // (the target is placed by the app while the robo is settled)
    this.seq = { t: 0, gun: gd, id: gun.id, block, air, volleys: block.volley_frames.slice(), next: 0 };
    this.ctx.onFire(air);
    return { air, name: gd.name };
  }

  clear() {
    for (const r of this.rounds) { r.model.kill(); this.ctx.scene.remove(r.model.root); if (r.trail) r.trail.dispose(); }
    for (const h of this.hits) { h.inst.kill(); this.ctx.scene.remove(h.inst.root); }
    this.rounds = []; this.hits = [];
    if (this.seq && this.ctx.onDone) this.ctx.onDone();
    this.seq = null;
    if (this.flash) { this.ctx.scene.remove(this.flash.inst.root); this.flash = null; }
  }

  muzzle() {
    const gun = this.ctx.gun();
    const node = gun && this.seq && gun.obj.getObjectByName(this.seq.gun.muzzle.node);
    if (!node) return null;
    if (this.ctx.sync) this.ctx.sync();          // parts follow their bones: bring the gun onto the posed arm
    node.updateWorldMatrix(true, false);
    return node;
  }

  spawnVolley() {
    const node = this.muzzle();
    if (!node || !this.fx) return;
    const pos = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    const dir = new THREE.Vector3().setFromMatrixColumn(node.matrixWorld, 0).normalize();
    if (this.seq.id === 24) dir.copy(this.target).sub(pos).normalize();   // aims at the target
    const b = this.seq.block;
    for (let r = 0; r < b.rounds_per_volley; r++) {
      const model = this.instance('proj');
      this.ctx.scene.add(model.root);
      const tr = this.seq.gun.trail;
      this.rounds.push({ block: b, phase: 0, timer: 0, round: r, state: 1, frame: 0,
        pos: pos.clone(), old: pos.clone(), dir: dir.clone(), model, ahead: this.seq.gun.homing_only_ahead,
        trail: tr && tr.enabled ? new Trail(tr, this.ctx.scene) : null, M: null });
    }
    // muzzle flash: one instance, restarted each volley
    if (!this.flash) {
      this.flash = { inst: this.instance('muzzle'), ticks: 0, frame: 0 };
      this.ctx.scene.add(this.flash.inst.root);
    }
    this.flash.ticks = MUZZLE_TICKS;
    this.flash.frame = 0;
  }

  stepRound(p) {
    const b = p.block;
    const ph = b.phases[p.phase];
    if (p.state === 2) {
      if (++p.timer > ph.linger) p.state = 0;
      return;
    }
    // fan and random spread, once, on the first tick of the aim phase
    if (p.phase === b.aim_phase && p.timer === 0) {
      if (!p.dir.lengthSq()) p.dir.set(0, 0, 1);
      const L = new THREE.Vector3().crossVectors(UP, p.dir).normalize();
      const U = new THREE.Vector3().crossVectors(L, p.dir).normalize();
      const fan = (b.fan_base_bams - b.fan_step_bams * p.round) * BAMS;
      if (fan) p.dir.applyAxisAngle(b.fan_axis === 'yaw' ? U : L, fan);
      if (b.random_spread_bams) {
        const rnd = () => Math.random() * 2 - 1;
        p.dir.applyAxisAngle(L, b.random_spread_bams * BAMS * rnd());
        p.dir.applyAxisAngle(U, b.random_spread_bams * BAMS * rnd());
      }
    }
    // homing toward the target point
    const v = new THREE.Vector3().subVectors(this.target, p.pos);
    if (v.lengthSq() > 0 && (!p.ahead || v.dot(p.dir) > 0) && (ph.homing_yaw_rad || ph.homing_pitch_rad)) {
      v.normalize();
      const a = new THREE.Vector3(v.x, 0, v.z), c = new THREE.Vector3(p.dir.x, 0, p.dir.z);
      if (a.lengthSq() > 1e-12 && c.lengthSq() > 1e-12) {
        const th = a.angleTo(c);
        const s = new THREE.Vector3().crossVectors(a, c).y < 0 ? 1 : -1;
        const al = s * Math.min(th, ph.homing_yaw_rad);
        const x = p.dir.x, z = p.dir.z;
        p.dir.x = x * Math.cos(al) + z * Math.sin(al);
        p.dir.z = -x * Math.sin(al) + z * Math.cos(al);
      }
      const d = Math.atan2(p.dir.y, Math.hypot(p.dir.x, p.dir.z)) - Math.atan2(v.y, Math.hypot(v.x, v.z));
      const lim = ph.homing_pitch_rad;
      const ax = new THREE.Vector3().crossVectors(UP, p.dir);
      if (ax.lengthSq() > 1e-12) p.dir.applyAxisAngle(ax.normalize(), THREE.MathUtils.clamp(d, -lim, lim));
      p.dir.normalize();
    }
    // move
    p.old.copy(p.pos);
    p.pos.addScaledVector(p.dir, ph.speed);
    p.frame += 30 / ph.duration;
    // floor, then the target (swept along this tick's segment)
    const floor = this.ctx.floorY();
    if (p.pos.y < floor) {
      // floor hit: the wall/floor effect (archive 1 ModelSet 1) at the contact point; the round stops at old
      const u = (p.old.y - floor) / ((p.old.y - p.pos.y) || 1);
      this.hitEffect('wall', new THREE.Vector3().lerpVectors(p.old, p.pos, u));
      p.pos.copy(p.old); p.state = 2; p.timer = 0; p.model.kill(); return;
    }
    const seg = new THREE.Line3(p.old, p.pos), cp = new THREE.Vector3();
    seg.closestPointToPoint(this.target, true, cp);
    if (cp.distanceTo(this.target) < this.targetRadius + ph.radius) {
      // robo hit: the hit effect (archive 1 ModelSet 0) at centre + normalize(pos - centre) * radius
      const at = cp.clone().sub(this.target);
      if (at.lengthSq() < 1e-12) at.copy(p.dir).negate();
      this.hitEffect('hit', at.normalize().multiplyScalar(this.targetRadius).add(this.target));
      // the target's reaction: this phase's down value and the 7 recipe values (+0x1A..+0x26), pushed along the round
      this.hitTarget({ down: ph.down, v: [ph.hit_1a, ...ph.hit_params], dir: p.dir });
      p.pos.copy(cp); p.state = 2; p.timer = 0; p.model.kill(); return;
    }
    // phase advance
    if (++p.timer >= ph.duration) {
      p.timer = 0;
      do p.phase++; while (p.phase < 5 && !b.phases[p.phase]?.duration);
      if (p.phase > 4 || !b.phases[p.phase]) p.state = 0;
    }
  }

  /** A hit effect from the effect pool (0x800798CC): the set's bare joint at the point, no rotation, restarted; its
   *  PTCL key spawns the bank 6 generator there. */
  hitEffect(set, pos) {
    if (!this.fx || !this.fx.entry[set]) return;
    const inst = effectInstance(this.fx, set);
    inst.root.matrix.makeTranslation(pos.x, pos.y, pos.z);
    inst.root.matrixWorldNeedsUpdate = true;
    this.ctx.scene.add(inst.root);
    inst.root.updateMatrixWorld(true);
    inst.setFrame(0);
    this.hits.push({ inst, ttl: 600 });
  }

  tick() {
    const s = this.seq;
    if (s) {
      // volleys at the block's tick times after the input; the sequence ends after the recovery
      while (s.next < s.volleys.length && s.t >= s.volleys[s.next]) { this.spawnVolley(); s.next++; }
      const last = s.volleys[s.volleys.length - 1] || 0;
      // The recovery count starts on the last volley's tick in the air, or after the ground hold (at least 1 tick)
      // on the ground (0x80043268-0x80043340). The robo's fire state runs before the gun update, so it sees the count
      // from the next tick: R ticks of the recoil motion at frame 20 * k / R, k = 0..R-1 (0x80049550-0x80049740).
      const R = s.block.recovery_frames;
      const start = last + (s.air ? 0 : Math.max(s.gun.ground_hold_frames || 0, 1));
      const k = s.t - start - 1;
      if (this.ctx.onPose) this.ctx.onPose(k >= 0 && k < R ? { clip: s.air ? 'air_recoil' : 'recoil', frame: 20 * k / R } : null);
      s.done = s.next >= s.volleys.length && s.t >= start + R;
      if (s.next >= s.volleys.length && s.t >= start + R && !this.rounds.length) { this.seq = null; if (this.ctx.onDone) this.ctx.onDone(); }
      else s.t++;
    }
    for (const p of this.rounds) this.stepRound(p);
    this.hits = this.hits.filter(h => {
      if (--h.ttl > 0) return true;
      h.inst.kill(); this.ctx.scene.remove(h.inst.root); return false;
    });
    this.rounds = this.rounds.filter(p => {
      if (p.state === 0 || p.pos.lengthSq() > 120 * 120) {
        p.model.kill();
        this.ctx.scene.remove(p.model.root);
        if (p.trail) p.trail.dispose();          // a freed slot's trail is reset: what is left vanishes at once
        return false;
      }
      return true;
    });
    // trail sampling (once per draw frame): the projectile matrix is rebuilt only in state 1, so a stopped round keeps
    // adding zero-length sections at its last flying position while the tail retracts
    let muzzle = null;
    for (const p of this.rounds) {
      if (!p.trail) continue;
      if (p.state === 1) {
        const ph = p.block.phases[Math.min(p.phase, 4)];
        const x = new THREE.Vector3().crossVectors(p.dir, UP);
        if (x.lengthSq() < 1e-12) x.set(1, 0, 0);
        p.M = { c: p.pos.clone(), x: x.normalize().multiplyScalar(ph.radius) };
      }
      if (p.M && (p.state === 1 || p.trail.count)) p.trail.sample(p.M, () => {
        if (!muzzle) {
          const n = this.muzzle();
          muzzle = n ? new THREE.Vector3().setFromMatrixPosition(n.matrixWorld) : p.pos.clone();
        }
        return muzzle.clone();
      });
    }
    if (this.flash) {
      this.flash.frame += MUZZLE_RATE;
      if (this.flash.ticks > 0) this.flash.ticks--;
    }
    if (this.hitFlash > 0) this.hitFlash--;
    // the target dummy: sink while a new spot is pending, move there once below the floor, then rise
    if (this.react) this.react.tick();
    if (this.pending) {
      this.up = Math.max(0, this.up - 1 / RISE_TICKS);
      if (this.up === 0) { const p = this.pending; this.pending = null; this.moveTo(p.x, p.z, p.fwd); }
    } else this.up = Math.min(1, this.up + 1 / RISE_TICKS);
  }

  /** Per render frame: run whole ticks, then place the models. */
  update(dt) {
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= TICK) { this.tick(); this.acc -= TICK; }
    const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
    for (const p of this.rounds) {
      const ph = p.block.phases[Math.min(p.phase, 4)];
      const root = p.model.root;
      root.visible = p.state === 1;
      if (!root.visible) continue;
      const s = ph.radius;
      Y.copy(p.dir).normalize();
      X.crossVectors(Y, UP);
      if (X.lengthSq() < 1e-12) X.set(1, 0, 0);
      X.normalize();
      Z.crossVectors(X, Y).normalize();
      root.matrix.makeBasis(X.multiplyScalar(s), Y.multiplyScalar(s), Z.multiplyScalar(s)).setPosition(p.pos);
      root.matrixWorldNeedsUpdate = true;
      p.model.setFrame(p.frame);
    }
    if (this.flash) {
      const node = this.muzzle();
      const show = this.flash.ticks > 0 && node;
      this.flash.inst.root.visible = !!show;
      if (show) {
        this.flash.inst.root.matrix.copy(node.matrixWorld);
        this.flash.inst.root.matrixWorldNeedsUpdate = true;
        this.flash.inst.setFrame(this.flash.frame);
      }
    }
    this.targetMat.color.set(this.hitFlash > 0 ? 0xff4a3a : 0xffc23a);
    this.placeDummy();
  }
}
