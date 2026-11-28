// Bomb and pod preview: launches the equipped bomb / pods at the gun preview's target the way the battle code does
// (READ, notes\bomb-pod-attacks.md in the extract folder). Data: data/bomb_attacks.json, data/pod_attacks.json and
// the effect models in data/effects.json + data/models/gfx_bomb_NN.glb / gfx_pod_NN.glb (archive 0 ModelSet 0 the
// bomb / pod as 'proj', archive 1 ModelSet 0 the explosion as 'blast').
//
// Game logic, 60 ticks per second (state machine first, then the weapon update, in the same tick):
// - Bomb: the press picks an aim point A on the floor, aim% of the way from the robo to the target (ground or air
//   block by R+0x139). The launch comes 5 ticks later (button released at once; the stick does not steer A here).
//   Each bomb flies from the bomb locator to A + its offset in T = 1000 * distance / speed ticks along a sine arc,
//   then straight on until it touches the floor. It explodes on proximity (flying or landed) or after its fuse.
// - Pod: launched on the tick after the press from the torso point, along the robo's facing (the neutral stick):
//   a straight launch phase, then it hovers on a spring above the floor and homes with a turn rate and speed that
//   switch when it locks on (range + view cone). It explodes on proximity or when its life runs out.
// - Explosion (shared): 1-4 blasts spaced by an interval, the explosion point drifting along the launch's horizontal
//   velocity; each blast's radius grows to a peak then moves to an end radius; the model is scaled 0.909 r
//   (y * 0.909 * height factor) and fades over its last 10 ticks.
// Viewer stand-ins (not read): no walls, arena edge or aim steering; the target is the gun preview's sphere (hit
// centre) with its feet on the floor; the blast animation rate (0.5 frames/tick) and the bomb's (1.5) are INFERRED.
import * as THREE from 'three';
import { effectInstance } from './attack.js?v=17';

const TICK = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);
const BLAST_RATE = 0.5;        // INFERRED: HSD default; the effect pool callback 0x80217958 is not read
const BOMB_RATE = 1.5;         // INFERRED: rate 0.5, advanced in the update and both draw passes
const POD_RATE = 0.5;          // rate 0.5, advanced once per tick
const BOMB_STARTUP = 5;        // R+0xE2 = 4 at the press; the state runs from the next tick (0x8004AD9C)
const POD_STATE = 10;          // R+0xE2 = 10 (s16 0x801C6C14)

/** Game Y rotation (0x8001BD54): x' = x cos + z sin, z' = -x sin + z cos; positive turns toward up x v (the left). */
function rotY(v, a) {
  const c = Math.cos(a), s = Math.sin(a), x = v.x, z = v.z;
  return new THREE.Vector3(x * c + z * s, v.y, -x * s + z * c);
}

/** One explosion record (0x28 bytes) playing at pos, drifting by vel per tick; blasts use the 'blast' effect set. */
class Explosion {
  constructor(X, pos, vel, fx, scene, owner) {
    this.X = X; this.pos = pos.clone(); this.vel = vel.clone(); this.fx = fx; this.scene = scene;
    this.t = 0; this.active = true; this.blasts = []; this.owner = owner;
  }

  radius(t) {
    const X = this.X, G = X.grow_ticks, S = X.shrink_ticks;
    return t <= G ? (G ? t * X.radius_peak / G : X.radius_peak) : X.radius_peak + (t - G) / S * (X.radius_end - X.radius_peak);
  }

  /** 0x80044A90; returns true when a blast spawned this tick (the projectile model is then hidden). */
  update(target, onHit) {
    const X = this.X, G = X.grow_ticks, S = X.shrink_ticks, n = X.blasts, gap = X.blast_interval || 1;
    if (this.t > G + (n - 1) * gap + S) { this.active = false; this.dispose(); return false; }
    let spawned = false;
    if (this.t <= (n - 1) * gap && this.t % gap === 0) {
      const model = effectInstance(this.fx, 'blast');
      this.scene.add(model.root);
      this.blasts.push({ t: 0, pos: this.pos.clone().add(new THREE.Vector3(0, 0.03, 0)), model, frame: 0, hit: false, live: true });
      spawned = true;
    }
    this.pos.add(this.vel);
    this.t++;
    for (const b of this.blasts) {
      if (!b.live) continue;
      const r = this.radius(b.t);
      b.r = r;
      // hit test (0x800443C0): a vertical cylinder, once per blast; padded by the owner's body radius as read
      if (!b.hit && target) {
        const d = target.clone().sub(b.pos), rho = this.owner;
        const hh = r * X.height_factor + rho;
        if (d.x * d.x + d.z * d.z < (r + rho) * (r + rho) && d.y > -hh && d.y < hh) { b.hit = true; onHit({ X, from: b.pos }); }
      }
      b.t++;
      b.frame += BLAST_RATE;
      if (b.t > G + S) { b.live = false; b.model.kill(); this.scene.remove(b.model.root); }
    }
    return spawned;
  }

  /** Per render frame: T(blast pos) * S(0.909 r, 0.909 r * 0.909 h, 0.909 r), alpha fade in the last 10 ticks. */
  place() {
    const X = this.X;
    for (const b of this.blasts) {
      if (!b.live || b.r === undefined) { b.model.root.visible = false; continue; }
      const sxz = Math.max(b.r * X.model_scale_xz_per_radius, 1e-4), sy = Math.max(b.r * X.model_scale_y_per_radius, 1e-4);
      b.model.root.visible = true;
      b.model.root.matrix.makeScale(sxz, sy, sxz).setPosition(b.pos);
      b.model.root.matrixWorldNeedsUpdate = true;
      const rem = X.grow_ticks + X.shrink_ticks - b.t;
      b.model.setFrame(b.frame, rem >= 10 ? 1 : (2 + rem) / 12);
    }
  }

  dispose() { for (const b of this.blasts) if (b.live) { b.live = false; b.model.kill(); this.scene.remove(b.model.root); } }
}

class ThrowBase {
  /** ctx: { scene, lib (EffectLib), sync(), part() -> {id, obj} | null, body() -> body id, airborne() -> bool,
   *         floorY() -> number, gun (the GunAttack, for its target), robo() -> {pos: feet, fwd},
   *         bone(role) -> Vector3 | null, onPose({clip, frame} | null), onHit() } */
  constructor(ctx, kind, file) {
    this.ctx = ctx; this.kind = kind; this.file = file;
    this.data = null; this.fx = null; this.acc = 0;
    this.items = []; this.explosions = []; this.seq = null;
  }

  async load() {
    if (this.data) return this.data;
    const [atk] = await Promise.all([
      fetch('data/' + this.file, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
      this.ctx.lib.load()]);
    if (atk) {
      const list = atk.bombs || atk.pods || [];
      this.data = { parts: Object.fromEntries(list.map(p => [p.id, p])), body: atk.body_factors || {} };
    }
    return this.data;
  }

  partData(id) { return this.data && this.data.parts[id]; }

  async prepare(id) {
    if (!this.fx || this.fx.id !== id) this.fx = await this.ctx.lib.get(this.kind, id);
    return this.fx;
  }

  /** The owner's body radius (0.01 * body +0xAC), which pads the blast hit test. */
  ownerRadius() {
    const b = this.data && this.data.body[String(this.ctx.body())];
    return b && b.radius !== undefined ? b.radius : 0.3;
  }

  get target() { return this.ctx.gun.target; }                       // the hit centre (R+0x1DC)
  targetFeet() { return new THREE.Vector3(this.target.x, this.ctx.floorY() + this.target.y, this.target.z); }   // R+0x20

  get busy() { return !!this.seq || this.items.length > 0 || this.explosions.length > 0; }
  get acting() { return !!this.seq; }

  clear() {
    for (const it of this.items) { it.model.kill(); this.ctx.scene.remove(it.model.root); }
    for (const e of this.explosions) e.dispose();
    this.items = []; this.explosions = [];
    if (this.seq && this.ctx.onPose) this.ctx.onPose(null);
    this.seq = null;
  }

  explode(X, pos, vel) {
    const e = new Explosion(X, pos, vel, this.fx, this.ctx.scene, this.ownerRadius());
    this.explosions.push(e);
    return e;
  }

  stepExplosions() {
    for (const e of this.explosions) if (e.active) e.update(this.ctx.gun.shown ? this.target : null, h => this.ctx.onHit && this.ctx.onHit(h));
    this.explosions = this.explosions.filter(e => e.active);
  }

  update(dt) {
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= TICK) { this.tick(); this.acc -= TICK; }
    this.place();
    for (const e of this.explosions) e.place();
  }
}

// ---- bombs ------------------------------------------------------------------------------------------------------
export class BombAttack extends ThrowBase {
  constructor(ctx) { super(ctx, 'bomb', 'bomb_attacks.json'); this.cooldown = 0; }

  async fire() {
    await this.load();
    const part = this.ctx.part();
    if (!part || this.seq || this.cooldown > 0) return null;
    const bd = this.partData(part.id);
    if (!bd) return null;
    await this.prepare(part.id);
    // press (0x8003F248 modes 0/1): the aim block by R+0x139; A = lerp(robo, target, aim%), on the floor
    const air = this.ctx.airborne();
    const aim = air ? bd.air : bd.ground;
    const p = aim.aim_percent / 100;
    const A = this.ctx.robo().pos.clone().lerp(this.targetFeet(), p);
    A.y = this.ctx.floorY();
    this.seq = { t: 0, bd, id: part.id, air, A };
    return { air, name: bd.name, block: aim };
  }

  /** The launch point: the bomb-model-1 locator (R+0x8F8). Model 1 shares model 0's mount, so its rest position and
   *  X axis in bomb root space are carried through the equipped bomb's root0 matrix. */
  locator(bd) {
    const part = this.ctx.part();
    const root = part && part.obj.getObjectByName('root0');
    if (!root) return null;
    if (this.ctx.sync) this.ctx.sync();
    root.updateWorldMatrix(true, false);
    const L = bd.launch_locator;
    const pos = new THREE.Vector3(...L.rest_pos_in_root).applyMatrix4(root.matrixWorld);
    const dir = new THREE.Vector3(...L.rest_x_axis_in_root).transformDirection(root.matrixWorld);
    return { pos, dir };
  }

  launch() {
    const s = this.seq, bd = s.bd;
    const air = this.ctx.airborne();               // the launch block is chosen again at the release
    const block = air ? bd.air : bd.ground;
    const loc = this.locator(bd);
    if (!loc) return;
    for (const [i, b] of block.bombs.entries()) {
      if (i >= bd.bombs_per_launch) break;
      const fwd = new THREE.Vector3(loc.dir.x, 0, loc.dir.z);
      if (fwd.lengthSq() < 1e-12) fwd.set(0, 0, 1);
      fwd.normalize();
      const left = new THREE.Vector3(fwd.z, 0, -fwd.x);                // fwd turned +90 deg about Y
      const goal = s.A.clone().add(new THREE.Vector3(0, 0.0001, 0)).addScaledVector(left, b.side_offset)
        .addScaledVector(fwd, b.forward_offset);
      const T = Math.max(1, Math.trunc(10 * (100 * goal.distanceTo(loc.pos)) / block.speed_raw));
      const model = effectInstance(this.fx, 'proj');
      this.ctx.scene.add(model.root);
      this.items.push({ state: 1, block, b, pos: loc.pos.clone(), start: loc.pos.clone(), goal, dir: loc.dir.clone(),
        T, timer: 0, ftimer: 0, model, frame: 0, expl: null, id: s.id, prox: bd.proximity_radius });
    }
    this.cooldown = block.cooldown_ticks;
  }

  near(pos, r, id) {
    if (!this.ctx.gun.shown) return false;                              // no target shown: nothing to go off near
    const c = this.target;
    if (c.distanceTo(pos) < r) return true;
    return id === 14 && c.distanceTo(pos.clone().sub(UP)) < r;          // Tomahawk B: also 1 unit below
  }

  doExplode(it) {
    it.state = 3;
    it.model.kill();
    const d = new THREE.Vector3(it.dir.x, 0, it.dir.z);
    if (d.lengthSq() < 1e-12) d.set(0, 0, 1);
    d.normalize().multiplyScalar(0.001 * it.block.speed_raw);
    let pos = it.pos;
    if (it.id === 27) {                                                 // Smash: above the robo's head
      const g = new THREE.Vector3(it.goal.x - it.start.x, 0, it.goal.z - it.start.z).normalize();
      const hand = this.ctx.bone('hand_R') || it.start;
      pos = hand.clone().addScaledVector(g, 2.05);
      pos.y += 2.45;
    }
    it.expl = this.explode(it.block.explosion, pos, d);
  }

  stepBomb(it) {
    const floor = this.ctx.floorY();
    if (it.state === 1) {
      const prev = it.pos.clone();
      it.frame += BOMB_RATE;
      if (it.timer < it.T) {
        it.timer++;
        const D = it.goal.clone().sub(it.start), L = D.length(), d = D.divideScalar(L || 1);
        const side = new THREE.Vector3().crossVectors(UP, d).normalize();
        const arcup = new THREE.Vector3().crossVectors(d, side);
        const h = 0.003 * L * Math.sin(Math.PI * it.timer / it.T);
        it.pos.copy(it.start).addScaledVector(d, L * it.timer / it.T)
          .addScaledVector(arcup, h * it.b.arc_height_raw).addScaledVector(side, h * it.b.arc_side_raw);
        const nd = it.pos.clone().sub(prev);
        if (nd.lengthSq() > 0) it.dir.copy(nd.normalize());
      } else {
        it.pos.addScaledVector(it.dir, 0.001 * it.block.speed_raw);
        if (it.id === 28) it.dir.set(0.005 * it.dir.x, -0.01, 0.005 * it.dir.z);   // Double Mine sinks
      }
      // the floor is the only surface here: contact on the prev -> pos segment lands the bomb
      if (it.pos.y < floor && prev.y >= floor) {
        const u = (prev.y - floor) / ((prev.y - it.pos.y) || 1);
        it.pos.lerpVectors(prev, it.pos, u);
        it.state = 2; it.ftimer = 0;
      } else if (it.pos.y < floor) { it.pos.y = floor; it.state = 2; it.ftimer = 0; }
      if (it.pos.y >= 30) { it.state = 2; it.ftimer = 0; }
      if (this.near(it.pos, it.prox, it.id)) this.doExplode(it);
    } else if (it.state === 2) {
      it.frame += BOMB_RATE;
      const old = it.ftimer++;
      if (old < it.block.fuse_ticks) { if (this.near(it.pos, it.prox, 0)) this.doExplode(it); } else this.doExplode(it);
    }
  }

  tick() {
    const s = this.seq;
    if (s) {
      // robo state 4: the bomb stance (slot 16) or sf_bomb_jump (17) until the launch
      if (this.ctx.onPose) this.ctx.onPose({ clip: s.air ? 'bomb_air' : 'bomb', frame: 0 });
      // R+0xE2 counts 4 -> 0 on ticks 1-4; on tick 5 it is < 1 and the (released) button launches
      if (++s.t >= BOMB_STARTUP) { this.launch(); this.seq = null; if (this.ctx.onPose) this.ctx.onPose(null); }
    }
    for (const it of this.items) this.stepBomb(it);
    this.stepExplosions();
    for (const it of this.items) if (it.state === 3 && it.expl && it.expl.blasts.length) it.model.root.visible = false;
    this.items = this.items.filter(it => {
      const gone = it.state === 3 ? !it.expl.active : it.pos.lengthSq() > 120 * 120;
      if (gone) { it.model.kill(); this.ctx.scene.remove(it.model.root); }
      return !gone;
    });
    if (this.cooldown > 0) this.cooldown--;
  }

  /** Bomb matrix (0x80038500): +Y along the flight tangent, X = normalize(dir x up), Z = X x dir, scale 1. */
  place() {
    const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
    for (const it of this.items) {
      const root = it.model.root;
      if (it.state === 3) continue;
      root.visible = true;
      Y.copy(it.dir).normalize();
      X.crossVectors(Y, UP);
      if (X.lengthSq() < 1e-12) X.set(1, 0, 0);
      X.normalize();
      Z.crossVectors(X, Y).normalize();
      root.matrix.makeBasis(X, Y, Z).setPosition(it.pos);
      root.matrixWorldNeedsUpdate = true;
      it.model.setFrame(it.frame);
    }
  }
}

// ---- pods -------------------------------------------------------------------------------------------------------
export class PodAttack extends ThrowBase {
  constructor(ctx) { super(ctx, 'pod', 'pod_attacks.json'); }

  async fire() {
    await this.load();
    const part = this.ctx.part();
    if (!part || this.seq) return null;
    const pd = this.partData(part.id);
    if (!pd) return null;
    if (this.items.length >= pd.max_alive) return { full: true, name: pd.name, max: pd.max_alive };
    await this.prepare(part.id);
    this.seq = { t: 0, pd, id: part.id, air: this.ctx.airborne() };
    return { air: this.seq.air, name: pd.name, pd };
  }

  /** Launcher 0x8003D7E0: per_use pods from the torso point along the facing, with the fan and launch pitch. */
  launch() {
    const s = this.seq, pd = s.pd, air = s.air;
    const blk = air ? pd.air : pd.ground;
    const start = this.ctx.bone('torso') || this.ctx.robo().pos.clone().add(new THREE.Vector3(0, 1, 0));
    const f = this.ctx.robo().fwd.clone().setY(0).normalize();
    const pitch = THREE.MathUtils.degToRad(blk.pitch_deg);
    for (const p of blk.pods) {
      if (p.index >= pd.per_use || this.items.length >= 3) break;
      const h = rotY(f, THREE.MathUtils.degToRad(p.velocity_yaw_deg));
      const vel = h.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(UP, Math.sin(pitch)).normalize()
        .multiplyScalar(blk.launch_speed);
      const heading = rotY(f, -THREE.MathUtils.degToRad(p.heading_yaw_deg));
      const model = effectInstance(this.fx, 'proj');
      this.ctx.scene.add(model.root);
      this.items.push({ state: 1, pos: start.clone(), vel, heading, launch: blk.launch_ticks, life: pd.life_ticks,
        locked: false, pause: 0, model, frame: 0, expl: null, pd });
    }
  }

  proximity(it) {
    if (!this.ctx.gun.shown) return false;
    const pr = it.pd.proximity, d = this.targetFeet().sub(it.pos);
    if (d.x * d.x + d.z * d.z >= pr.radius * pr.radius) return false;
    return pr.asymmetric ? d.y > -0.65 && d.y < pr.height : Math.abs(d.y) < pr.height;
  }

  doExplode(it) {
    it.state = 2;
    it.model.root.visible = false;
    it.model.kill();
    it.expl = this.explode(it.pd.explosion, it.pos, new THREE.Vector3(it.vel.x, 0, it.vel.z));
  }

  stepPod(it) {
    if (it.state !== 1) return;
    const pd = it.pd, floor = this.ctx.floorY();
    it.frame += POD_RATE;
    let k = it.locked ? 1 : 0;
    if (it.launch < 1) {
      // no target shown: no lock and nothing to turn toward (v = the heading itself)
      const v = this.ctx.gun.shown ? this.targetFeet().sub(it.pos) : it.heading.clone().multiplyScalar(1e3); v.y = 0;
      const ang = v.lengthSq() ? THREE.MathUtils.radToDeg(v.angleTo(it.heading)) : 0;
      const locked = pd.lock.enabled && v.length() < pd.lock.range && ang < pd.lock.view_angle_deg;
      if (locked && !it.locked) it.pause = pd.lock.pause_ticks;
      it.locked = locked; k = locked ? 1 : 0;
      const left = new THREE.Vector3().crossVectors(UP, it.heading);
      const a = Math.atan2(left.dot(v), it.heading.dot(v));
      it.heading = rotY(it.heading, a * pd.turn_fraction_per_tick[k]).setY(0).normalize();
      if (it.pause < 1) { it.vel.x = it.heading.x * pd.speed[k]; it.vel.z = it.heading.z * pd.speed[k]; }
      else { it.pause--; it.vel.set(0, 0, 0); }
      it.vel.y -= 0.003;
      it.pos.add(it.vel);
      if (this.proximity(it)) { this.doExplode(it); return; }
      if (--it.life === 0) { this.doExplode(it); return; }
    } else {
      it.pos.add(it.vel);
      it.launch--;
      if (pd.id !== 30 && this.proximity(it)) { this.doExplode(it); return; }   // Umbrella: none while launching
    }
    if (it.pos.y <= floor) it.pos.y = floor;
    if (it.launch < 1) {
      it.vel.y += 0.01 * ((pd.hover_target[k] + floor) - it.pos.y);
      it.vel.y *= 0.9;
    }
  }

  tick() {
    const s = this.seq;
    if (s) {
      // robo state 5: sf_pod (18) / sf_pod_jump (19) at frame 10 * progress / 30; the launch on its first tick
      const E2 = POD_STATE - s.t;
      if (this.ctx.onPose) this.ctx.onPose({ clip: s.air ? 'pod_air' : 'pod', frame: (10 * (POD_STATE - E2) / POD_STATE) / 30 });
      if (s.t === 0) this.launch();
      if (++s.t >= POD_STATE) { this.seq = null; if (this.ctx.onPose) this.ctx.onPose(null); }
    }
    for (const it of this.items) this.stepPod(it);
    this.stepExplosions();
    this.items = this.items.filter(it => {
      const gone = it.state === 2 ? !it.expl.active : it.pos.lengthSq() > 120 * 120;
      if (gone) { it.model.kill(); this.ctx.scene.remove(it.model.root); }
      return !gone;
    });
  }

  /** Pod matrix (0x80038760): +Z = heading, +Y up, never pitched or rolled; uniform scale record +0x113 / 100. */
  place() {
    for (const it of this.items) {
      if (it.state !== 1) continue;
      const Z = it.heading.clone().setY(0).normalize(), Y = UP.clone();
      const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
      const sc = it.pd.model_scale;
      it.model.root.matrix.makeBasis(X.multiplyScalar(sc), Y.multiplyScalar(sc), Z.multiplyScalar(sc)).setPosition(it.pos);
      it.model.root.matrixWorldNeedsUpdate = true;
      it.model.setFrame(it.frame);
    }
  }
}
