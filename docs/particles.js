// HSD particle runtime: generators, emission and draw (READ, notes\effects.md "Emitter and draw" and "Particle
// interpreter" in the extract folder). Data: data/particles.json (tools\particles.py). Effect joints spawn
// generators through their PTCL keys (effects.json "ptcl"); see attack.js effectInstance.
//
// Per game frame (0x80075c14): every particle updates (ptcl_interp.js), then every generator: follows its joint,
// adds to its rate accumulator and emits whole particles, counts down its life. Draw: screen-aligned quads of
// half-extent `size`, colour from the TEV mode (prim, prim x tex, or lerp(env, prim, tex)), blend from flags bits
// 22-23, z test without z write, ordered by priority bucket then newest first.
// tex2 sprite meshes are drawn as a coverage mask over the quad (same shape, hard edges).
// Not drawn (INFERRED unimportant for weapons): fog, alpha-compare ramps, col2a/col2b and lit (bank 4) particles.
import * as THREE from 'three';
import { Particle, rnd } from './ptcl_interp.js?v=1';

const TICK = 1 / 60;
const EPS = 1.1754944e-38;
const MAX_PARTICLES = 6000;
const CELL = 48;                         // atlas cell (images are 32 or 48 square, RGBA8)

function gatan2(y, x) { return Math.abs(x) < EPS ? (y >= 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan2(y, x); }

/** Rdir: maps local +Z onto normalize(v) (0x8017f4b8). */
function dirMatrix(v) {
  const n = v.clone().normalize();
  const A = gatan2(n.y, n.z), d = n.y * Math.sin(A) + n.z * Math.cos(A), K = gatan2(n.x, d);
  const sA = Math.sin(A), cA = Math.cos(A), sK = Math.sin(K), cK = Math.cos(K);
  return new THREE.Matrix3().set(cK, 0, sK, -sA * sK, cA, sA * cK, -cA * sK, -sA, cA * cK);
}

/** The application frame a local generator's particles live in (AppSRT). cam: +0x72 = 1, world = C*p + T. */
class AppSRT {
  constructor(node) { this.node = node; this.cam = true; this.rot = false; this.scale = false; }
  matrix(camera, out) {
    const T = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
    if (this.node) { this.node.updateWorldMatrix(true, false); this.node.matrixWorld.decompose(T, Q, S); }
    if (this.cam) return out.extractRotation(camera.matrixWorld).setPosition(T);
    return out.compose(T, this.rot ? Q : new THREE.Quaternion(), this.scale ? S : new THREE.Vector3(1, 1, 1));
  }
}

class Generator {
  constructor(sys, bank, id, g, node, parent) {
    this.sys = sys; this.bank = bank; this.id = id; this.h = g.h; this.ops = g.ops;
    const h = g.h;
    this.flags = h.flags_loaded >>> 0;
    this.rate = h.rate; this.life = h.gen_life; this.live = 0; this.dead = false;
    this.node = node || null;
    this.follow = !!node && !parent;            // the PTCL callback's 0x100 follow; spawned children keep still
    this.pos = new THREE.Vector3();
    this.B = new THREE.Matrix3();
    this.app = null;
    if (parent && parent.app) this.app = parent.app;
    else if (this.flags & 0x20000) this.app = new AppSRT(node);
    if (parent) this.pos.copy(parent.pos);
    // 0x100 only sets the accumulator's starting value
    if (this.flags & 0x100) this.acc = this.rate >= 0 ? 0.99999988 : (1 + this.rate > EPS ? 1 : 0);
    else this.acc = this.rate >= 0 ? rnd() : 0;
    this.speedT = 0;                            // gen+0x60 (tornado)
  }

  // 0xF5 (gen+0x16 |= 0x2000) and 0xF6 (0x1000) on a generator with an AppSRT. READ (draw decode): 0x2000 makes the
  // AppSRT take the joint's rotation (Euler extractor 0x8019ef8c) and F5 also clears +0x72 (no longer camera space);
  // 0x1000 takes its scale (0x8019f600). The interpreter decode named them the other way round; see the note.
  set followRot(v) { if (v && this.app) { this.app.rot = true; this.app.cam = false; } }
  set followScale(v) { if (v && this.app) this.app.scale = true; }

  /** 0xB2: pos into world through the AppSRT, then detach it. */
  appToWorld(p) {
    if (p.app && !p.app.cam) { p.pos.applyMatrix4(p.app.matrix(this.sys.camera, new THREE.Matrix4())); p.app = null; }
  }

  /** Tornado position (0x8017e144), rebuilt each frame from the live generator. */
  tornado(p) {
    const h = this.h;
    const sA = Math.sin(p.grav), cA = Math.cos(p.grav), sB = Math.sin(p.fric), cB = Math.cos(p.fric);
    p.vel.z += this.speedT;
    p.vel.x += h.grav;
    const r = (p.vel.z * Math.tan(Math.abs(h.angle)) + Math.abs(h.radius)) * p.vel.y;
    const lx = r * Math.cos(p.vel.x), ly = r * Math.sin(p.vel.x), hh = p.vel.z;
    p.pos.set(lx * cB + hh * sB, hh * sA * cB - lx * sA * sB + ly * cA, hh * cA * cB - lx * cA * sB - ly * sA).add(this.pos);
  }

  /** One frame of the generator walk (0x80180728). */
  tick() {
    if (this.follow && this.node) {
      if (!attached(this.node)) { this.kill(); }
      else if (!this.app) {
        this.node.updateWorldMatrix(true, false);
        const m = this.node.matrixWorld;
        this.pos.setFromMatrixPosition(m);
        // emission frame: the joint's world rotation with each column normalised (scale ignored)
        const e = m.elements, cols = [0, 4, 8].map(o => new THREE.Vector3(e[o], e[o + 1], e[o + 2]).normalize());
        this.B.set(cols[0].x, cols[1].x, cols[2].x, cols[0].y, cols[1].y, cols[2].y, cols[0].z, cols[1].z, cols[2].z);
      }
    }
    this.acc += this.rate < 0 ? -this.rate : this.rate * rnd();
    if (this.acc >= 1) this.emit();
    if (this.life && --this.life === 0) this.kill();
  }

  /** Death step (also psKillGenerators): linger while particles live, still following the joint. */
  kill() {
    if (this.live > 0) { this.rate = 0; this.life = 1; this.acc = 0; }
    else this.dead = true;
  }

  emit() {
    const h = this.h, shape = h.kind & 15, vel = new THREE.Vector3(...h.vel), speed = vel.length();
    let M = this.B.clone();
    if (shape !== 1 && speed > EPS) M = M.multiply(dirMatrix(vel));
    const N = Math.trunc(this.acc);
    const [az0p, az1p, hgt] = h.param;
    const az0 = az0p, az1 = az1p || 2 * Math.PI;
    let step = 0, az = 0;
    if (h.angle < 0) {
      if ([0, 3, 4, 6, 7].includes(shape)) { step = (az1 - az0) / N; az = az0 + step * rnd(); }
      else { step = 2 * Math.PI / N; az = 2 * Math.PI * rnd(); }
    }
    while (this.acc >= 1) {
      this.acc -= 1;
      if (this.sys.count >= MAX_PARTICLES) continue;
      const p = new Particle(h, this.ops, this);
      p.bank = this.bank; p.app = this.app; p.bucket = (this.flags >>> 25) & 7;
      const lp = new THREE.Vector3(), lv = new THREE.Vector3();
      if (shape === 8) {
        const th = (az0p === 0 ? Math.PI : Math.abs(az0p)) * rnd(), ph = 2 * Math.PI * rnd();
        const r = h.radius >= 0 ? h.radius * rnd() : -h.radius;
        const dir = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)).applyMatrix3(M);
        let spd = speed * (az0p < 0 ? -1 : 1);
        lv.copy(dir).multiplyScalar(spd);
        if (h.radius >= 0 && spd < 0 && h.radius) lv.multiplyScalar(r / h.radius);
        p.pos.copy(this.pos).addScaledVector(dir, r);
        p.vel.copy(lv);
      } else if (shape === 2) {
        const f = h.radius >= 0 ? rnd() : 1;
        let a;
        if (h.angle < 0) { a = az; az += step; } else a = 2 * Math.PI * rnd();
        const axis = new THREE.Vector3(0, 0, 1).applyMatrix3(M);
        const A2 = gatan2(axis.y, axis.z), d = axis.y * Math.sin(A2) + axis.z * Math.cos(A2), B2 = gatan2(axis.x, d);
        p.pos.set(0, 0, 0); p.vel.set(a, f, 0); p.grav = A2; p.fric = B2; p.flags |= 4;
        this.speedT = speed;
      } else {
        // 0 disc, 3/4 disc variants, 6 cone, 7 cylinder (1 line and 5 box are unused by these banks)
        let f, r;
        if (h.radius >= 0) { f = rnd(); if (shape === 3 || shape === 4) f = Math.sqrt(f); r = f * h.radius; }
        else { f = 1; r = -h.radius; }
        const a = Math.abs(h.angle);
        let azi;
        if (h.angle < 0) { azi = az; az += step; } else azi = az0 + (az1 - az0) * rnd();
        let el;
        if (shape === 7) el = Math.PI / 2 + a;
        else if (shape === 6) el = Math.abs(r) < EPS ? (hgt >= 0 ? a : Math.PI + a) : Math.PI / 2 - Math.atan2(hgt, r) + a;
        else el = f * a;
        lp.set(r * Math.cos(azi), r * Math.sin(azi), 0);
        if (shape === 6 || shape === 7) { const t = rnd(); if (shape === 6) { lp.x *= 1 - t; lp.y *= 1 - t; } lp.z = t * hgt; }
        lv.set(Math.sin(el) * Math.cos(azi), Math.sin(el) * Math.sin(azi), Math.cos(el)).multiplyScalar(speed);
        if (shape === 3) lv.multiplyScalar(f);
        p.pos.copy(lp.applyMatrix3(M)).add(this.pos);
        p.vel.copy(lv.applyMatrix3(M));
      }
      this.live++;
      this.sys.add(p);
      p.update(this.sys);                           // its program runs at once (the birth update)
    }
  }
}

function attached(o) { while (o.parent) o = o.parent; return o.isScene === true; }

export class ParticleSystem {
  constructor(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.data = null; this.gens = []; this.parts = []; this.acc = 0;
    this.meshes = null; this.cells = {};
  }

  get count() { return this.parts.length; }

  async load() {
    if (this.data) return this.data;
    const d = await fetch('data/particles.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (!d) return null;
    // one atlas for every image of every bank
    const imgs = [];
    for (const [bn, b] of Object.entries(d.banks)) {
      b.texg.forEach((g, gi) => g.images.forEach((f, k) => imgs.push({ key: `${bn}/${gi}/${k}`, f, w: g.w, h: g.h, mesh: g.mesh[k] })));
    }
    const cols = 16, rows = Math.ceil(imgs.length / cols);
    const cv = document.createElement('canvas');
    cv.width = cols * CELL; cv.height = rows * CELL;
    const cx = cv.getContext('2d');
    await Promise.all(imgs.map((im, i) => new Promise(res => {
      const el = new Image();
      el.onload = () => { cx.drawImage(el, (i % cols) * CELL, Math.floor(i / cols) * CELL); res(); };
      el.onerror = res;
      el.src = 'data/tex/' + im.f;
    })));
    // tex2 coverage: an image with a sprite mesh is drawn as that mesh (textured or not), which can crop opaque
    // texels; rasterised here into a mask atlas with the same layout (images without a mesh are fully covered)
    const mk = document.createElement('canvas');
    mk.width = cv.width; mk.height = cv.height;
    const mx = mk.getContext('2d');
    mx.fillStyle = '#000'; mx.fillRect(0, 0, mk.width, mk.height);
    mx.fillStyle = '#fff';
    imgs.forEach((im, i) => {
      const x = (i % cols) * CELL, y = Math.floor(i / cols) * CELL;
      // half-texel inset so linear filtering does not bleed across cells
      this.cells[im.key] = { r: [(x + 0.5) / cv.width, (y + 0.5) / cv.height, (im.w - 1) / cv.width, (im.h - 1) / cv.height] };
      if (!im.mesh) { mx.fillRect(x, y, im.w, im.h); return; }
      for (const st of im.mesh) {
        const P = []; for (let k = 0; k < st.xy.length; k += 2) P.push([x + st.xy[k] * im.w, y + st.xy[k + 1] * im.h]);
        for (let k = 0; k + 2 < P.length; k++) {           // GX triangle strip
          mx.beginPath(); mx.moveTo(...P[k]); mx.lineTo(...P[k + 1]); mx.lineTo(...P[k + 2]); mx.closePath(); mx.fill();
        }
      }
    });
    const mask = new THREE.CanvasTexture(mk);
    mask.flipY = false; mask.colorSpace = THREE.NoColorSpace; mask.generateMipmaps = false;
    mask.minFilter = THREE.LinearFilter; mask.magFilter = THREE.LinearFilter;
    this.mask = mask;
    const tex = new THREE.CanvasTexture(cv);
    tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    this.atlas = tex;
    this.meshes = [0, 1, 2, 3].map(bl => this.makeMesh(bl));
    this.data = d;
    return d;
  }

  makeMesh(blend) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.atlas }, mask: { value: this.mask } },
      vertexShader: `attribute vec4 cell; attribute vec4 prim; attribute vec4 env; attribute vec2 mode; attribute vec2 quv;
        varying vec2 vUv; varying vec2 vQuv; varying vec4 vCell; varying vec4 vPrim; varying vec4 vEnv; varying vec2 vMode;
        void main() { vUv = uv; vQuv = quv; vCell = cell; vPrim = prim; vEnv = env; vMode = mode;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D map; uniform sampler2D mask;
        varying vec2 vUv; varying vec2 vQuv; varying vec4 vCell; varying vec4 vPrim; varying vec4 vEnv; varying vec2 vMode;
        float mir(float x) { return 1.0 - abs(mod(x, 2.0) - 1.0); }
        void main() {
          vec2 t = clamp(vUv, 0.0, 1.0);
          float wrap = vMode.y;
          if (mod(wrap, 2.0) >= 1.0) t.x = mir(2.0 * vUv.x);          // flag 0x20: mirror S, s' = 2s
          if (wrap >= 2.0) t.y = mir(2.0 * vUv.y + 1.0);              // flag 0x40: mirror T, t' = 2t + 1
          vec4 tx = texture2D(map, vCell.xy + t * vCell.zw);
          vec4 c;
          if (vMode.x < 0.5) c = vPrim;                                  // untextured
          else if (vMode.x < 1.5) c = vPrim * tx;                        // 0x400: prim x tex
          else if (vMode.x < 2.5) c = mix(vEnv, vPrim, tx);              // 0x480: lerp(env, prim, tex)
          // the sprite mesh's coverage, in quad space (x right, y down; not flipped)
          c.a *= texture2D(mask, vCell.xy + clamp(vQuv, 0.0, 1.0) * vCell.zw).r;
          ${blend < 2 ? 'if (c.a < 1.0 / 255.0) discard;' : ''}
          gl_FragColor = c;
        }`,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    });
    mat.blending = THREE.CustomBlending;
    if (blend === 0) { mat.blendSrc = THREE.SrcAlphaFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor; }
    else if (blend === 1) { mat.blendSrc = THREE.SrcAlphaFactor; mat.blendDst = THREE.OneFactor; }
    else if (blend === 2) { mat.blendEquation = THREE.ReverseSubtractEquation; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneFactor; }
    else { mat.blendSrc = THREE.DstColorFactor; mat.blendDst = THREE.ZeroFactor; }
    const geo = new THREE.BufferGeometry();
    const n = MAX_PARTICLES * 6;
    const attr = (k, size) => geo.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage));
    attr('position', 3); attr('uv', 2); attr('cell', 4); attr('prim', 4); attr('env', 4); attr('mode', 2); attr('quv', 2);
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5 + blend;
    this.scene.add(mesh);
    return mesh;
  }

  images(texg) { return 64; }      // image validity is checked at draw time (cells)

  gen(bank, id) {
    const b = this.data && this.data.banks[String(bank)];
    return b && b.gens[String(id)];
  }

  /** A PTCL key on an effect joint: a generator that follows `node`. */
  spawn(bank, id, node) {
    const g = this.gen(bank, id);
    if (!g) return null;
    const gen = new Generator(this, bank, id, g, node, null);
    this.gens.push(gen);
    return gen;
  }

  /** Spawn ops (0xF0 / 0xEF / 0xA5): a generator at the particle, sharing its AppSRT; bits 25-27 := flags & 7. */
  spawnGenerator(bank, id, p, flags) {
    const g = this.gen(bank, id);
    if (!g) return;
    const gen = new Generator(this, bank, id, g, p.gen ? p.gen.node : null, p);
    if (flags !== undefined) gen.flags = (gen.flags & ~(7 << 25)) | ((flags & 7) << 25);
    this.gens.push(gen);
  }

  /** psKillGenerators: every generator on `node` or below dies (lingering while its particles live). */
  kill(node) {
    for (const g of this.gens) {
      if (!g.node || g.dead) continue;
      let o = g.node;
      while (o && o !== node) o = o.parent;
      if (o) g.kill();
    }
  }

  add(p) { this.parts.push(p); }

  clear() { this.gens = []; this.parts = []; }

  tick() {
    // particles first (0x8017e79c); children born in this pass were already updated once
    const born = this.parts.length;
    for (let i = 0; i < born; i++) this.parts[i].update(this);
    for (const p of this.parts) if (p.dead && !p.counted && p.gen) { p.counted = true; p.gen.live--; }
    this.parts = this.parts.filter(p => !p.dead);
    for (let i = 0; i < this.gens.length; i++) { const g = this.gens[i]; if (!g.dead) g.tick(); }
    for (const p of this.parts) if (p.dead && !p.counted && p.gen) { p.counted = true; p.gen.live--; }
    this.parts = this.parts.filter(p => !p.dead);
    for (const g of this.gens) if (!g.dead && g.life === 1 && g.rate === 0 && g.live <= 0) g.dead = true;
    this.gens = this.gens.filter(g => !g.dead);
  }

  update(dt) {
    if (!this.data) return;
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= TICK) { this.tick(); this.acc -= TICK; }
    this.draw();
  }

  draw() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const R = new THREE.Vector3(e[0], e[1], e[2]).normalize(), U = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const fill = [0, 0, 0, 0];
    const bufs = this.meshes.map(m => m.geometry.attributes);
    const M = new THREE.Matrix4();
    const P = new THREE.Vector3(), Q = new THREE.Vector3(), V = new THREE.Vector3();
    const r = new THREE.Vector3(), u = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3();
    // order: priority bucket ascending, newest first
    const order = this.parts.map((p, i) => i).sort((a, b) => (this.parts[a].bucket - this.parts[b].bucket) || (b - a));
    for (const i of order) {
      const p = this.parts[i];
      if (p.dead) continue;
      const blend = (p.flags >>> 22) & 3, k = fill[blend];
      if (k >= MAX_PARTICLES) continue;
      const toWorld = v => (p.app ? v.applyMatrix4(p.app.matrix(cam, M)) : v);
      toWorld(P.copy(p.pos));
      const stretch = !!(p.flags & 0x100000);
      if (stretch || p.flags & 0x200000) toWorld(Q.copy(p.pos).sub(p.vel));
      // rotation: clockwise on screen; 0x200000 turns the quad's top along the screen motion
      let th = Math.abs(p.rot) > 0.01 ? p.rot : 0;
      if (p.flags & 0x200000) { V.subVectors(P, Q); th += gatan2(V.dot(R), V.dot(U)); }
      const c = Math.cos(th), s = Math.sin(th);
      r.copy(R).multiplyScalar(c).addScaledVector(U, -s);
      u.copy(U).multiplyScalar(c).addScaledVector(R, s);
      A.copy(r).add(u).multiplyScalar(p.size);
      B.copy(r).sub(u).multiplyScalar(p.size);
      const tail = stretch ? Q : P;
      const verts = [tail.clone().sub(A), P.clone().sub(B), P.clone().add(A), tail.clone().add(B)];
      const fu = p.flags & 0x40000 ? 1 : 0, fv = p.flags & 0x80000 ? 1 : 0;
      const QUV = [[0, 1], [0, 0], [1, 0], [1, 1]];
      const uvs = [[0, 1], [0, 0], [1, 0], [1, 1]].map(([x, y]) => [fu ? 1 - x : x, fv ? 1 - y : y]);
      const cell = this.cells[`${p.bank}/${p.texg}/${p.image}`] || this.cells[`${p.bank}/${p.texg}/0`];
      const textured = !!(p.flags & 0x400) && cell;
      const mode = textured ? ((p.flags & 0x80) ? 2 : 1) : 0;
      const wrap = (p.flags & 0x20 ? 1 : 0) + (p.flags & 0x40 ? 2 : 0);
      const prim = p.prim.shown().map(x => x / 255), env = p.env.shown().map(x => x / 255);
      const ab = bufs[blend];
      const tri = [0, 1, 2, 0, 2, 3];
      for (let t = 0; t < 6; t++) {
        const vi = tri[t], o = k * 6 + t;
        const v = verts[vi];
        ab.position.array.set([v.x, v.y, v.z], o * 3);
        ab.uv.array.set(uvs[vi], o * 2);
        ab.quv.array.set(QUV[vi], o * 2);
        ab.cell.array.set(cell ? cell.r : [0, 0, 0, 0], o * 4);
        const pa = stretch && (vi === 0 || vi === 3) ? prim[3] * p.stretch : prim[3];
        ab.prim.array.set([prim[0], prim[1], prim[2], pa], o * 4);
        ab.env.array.set(env, o * 4);
        ab.mode.array.set([mode, wrap], o * 2);
      }
      fill[blend] = k + 1;
    }
    this.meshes.forEach((m, bl) => {
      const g = m.geometry;
      g.setDrawRange(0, fill[bl] * 6);
      for (const a of Object.values(g.attributes)) { a.needsUpdate = true; a.clearUpdateRanges?.(); a.addUpdateRange?.(0, fill[bl] * 6 * a.itemSize); }
    });
  }
}
