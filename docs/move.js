// Jump, air moves and landing (READ, notes\air-moves.md in the extract folder; data/movement.json from
// tools\move_air.py). 60 ticks/s; velocity in the game's "v" units, position += 0.01 * v per tick (1 v = 0.6 units/s).
//
// The jump button always jumps on the ground (held for up to f4 ticks: a full hold peaks at 0.01 * f3 units). Each
// further press in the air spends one air move, in the body's style:
//   0  straight dash (state 7): f9 ticks of hover, then f12 + 1 ticks at 0.1 * f13 along the facing, tilted by the
//      body's pitch; no gravity while dashing.
//   1  air jump (state 6): f9 ticks of hover, then a vertical re-jump to 0.01 * f11 units.
//   2  steerable dash (state 8): as 0 but it turns toward the stick (neutral here: straight); the Lightning Sky
//      bodies and Ruhiel transform and fly (slot 10 is their change_skyer motion with the body animation).
// Landing locks the robo for int(f7 * impact + f10-after-an-air-move) ticks, impact = sqrt(fall height / 6 units).
// Collision charge (state 12, notesir-moves.md "Collision attack"): from the ground only; three phases of fixed speed
// and elevation (homing toward the target in phases 0-1, one hold tick between phases), no gravity and no control.
// Phase 1 is the hit window (once per charge, 3 ticks of hitstop); phases flagged as armour glow red. Once a
// downward phase meets the floor the robo is grounded: vertical speed stripped, horizontal eased (x0.8 above 2 v).
// Viewer stand-ins: the stick is neutral (moves go along the facing), the floor is flat and there are no walls.
import * as THREE from 'three';

const TICK = 1 / 60;
const K_POS = 0.01;

export class Mover {
  /** ctx: { fields() -> {f0..f14 by name}, body() -> body entry, facing() -> Vector3 (horizontal, world),
   *         attacking() -> bool, onPose(name, frame, fade), onState(s) } */
  constructor(ctx) {
    this.ctx = ctx;
    this.data = null;
    this.reset();
  }

  async load() {
    if (!this.data) this.data = await fetch('data/movement.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    return this.data;
  }

  reset() {
    this.pos = new THREE.Vector3();      // relative to where the robo stood; y = height above the floor
    this.vel = new THREE.Vector3();      // v units, world axes
    this.state = 'ground';
    this.E2 = 0; this.E0 = 0; this.E4 = 0; this.H = 0; this.count = 0;
    this.dir = new THREE.Vector3(0, 0, 1);
    this.held = false; this.edge = false;
    this.frame = 0; this.acc = 0;
    this.info = '';
  }

  get airborne() { return this.state !== 'ground' && this.state !== 'land' && !(this.state === 'charge' && this.grounded); }
  get charging() { return this.state === 'charge'; }

  /** Collision attack entry (0x8004AE94): grounded only; dir = flat direction to the target. */
  startCharge() {
    const B = this.ctx.body();
    if (this.state !== 'ground' || !B || !B.charge) return false;
    const C = B.charge;
    const to = this.ctx.target().clone().sub(this.ctx.position()); to.y = 0;
    this.dir = to.lengthSq() > 1e-12 ? to.normalize() : this.ctx.facing().setY(0).normalize();
    this.state = 'charge';
    this.phase = 0;
    this.E2 = this.E0 = C.phases[0].ticks;
    this.grounded = false;            // flagged airborne: no gravity, lands only below floor - 0.1
    this.hit = false; this.hitstop = 0;
    this.frame = 1.0;
    this.glow = 0;
    this.anchor = this.pos.clone();
    this.ctx.onCharge && this.ctx.onCharge('start', this);
    this.ctx.onPose('charge', this.frame, 0);
    return true;
  }

  stepCharge(B) {
    const C = B.charge, ph = C.phases[this.phase];
    this.glow *= 0.95;
    if (this.E2 < 1) {
      // hold tick: velocity, frame and E2 untouched; then the next phase, or the end
      if (this.phase < 2) { this.phase++; this.E2 = this.E0 = C.phases[this.phase].ticks; }
      else {
        this.state = this.grounded ? 'ground' : 'air';
        this.E4 = 0;
        this.ctx.onCharge && this.ctx.onCharge('end', this);
        if (this.state === 'ground') this.ctx.onPose(null);
        return;
      }
    } else {
      this.frame = 20 * (this.E0 - this.E2) / this.E0 + 20 * this.phase;
      if (this.phase < 2) this.home(C);
      if (this.hitstop === 0) {
        const e = THREE.MathUtils.degToRad(ph.elev_deg), v = 0.1 * ph.speed_raw;
        this.vel.copy(this.dir).setY(0).normalize().multiplyScalar(Math.cos(e) * v);
        this.vel.y = Math.sin(e) * v;
      } else { this.vel.set(0, 0, 0); this.hitstop--; }
      this.E2--;
    }
    if (C.phases[this.phase].armour) this.glow = 1;
    if (C.phases[this.phase].anchor_frozen) this.vanish = true;   // returns (+0xD1 bit phase) ? 0 : 1
    this.ctx.onPose('charge', this.frame, 0);
  }

  /** Homing (phases 0-1): turn the flat dir toward the target by at most the body's step per tick. */
  home(C) {
    const G = this.ctx.target().clone().sub(this.ctx.position()); G.normalize(); G.y = 0;
    if (G.lengthSq() < 1e-12) return;
    const lim = C.homing_step_actual_rad, d = this.dir.clone().normalize();
    const ang = d.angleTo(G);
    if (ang <= lim) this.dir.copy(G);
    else if (d.dot(G) > 0) {
      const s = Math.sign(new THREE.Vector3().crossVectors(d, G).y) || 1;
      this.dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), s * lim);
    }
  }

  /** Physics during the charge (0x8004B0A0): airborne until below floor - 0.1, then planted / sliding. */
  integrateCharge(B) {
    if (!this.grounded) {
      this.pos.addScaledVector(this.vel, K_POS);
      if (this.pos.y < -0.1) { this.pos.y = 0; this.grounded = true; this.ctx.onCharge && this.ctx.onCharge('land', this); }
    } else {
      const h = new THREE.Vector2(this.vel.x, this.vel.z);
      if (h.length() > 2.0) h.multiplyScalar(0.8); else h.set(0, 0);
      this.vel.set(h.x, 0, h.y);
      this.pos.addScaledVector(this.vel, K_POS);
      this.pos.y = 0;
    }
    // R+0x30: the robo position, except in phases flagged to freeze it (where the impact appears)
    if (this.state === 'charge' && !B.charge.phases[this.phase].anchor_frozen) this.anchor.copy(this.pos);
    // the hit (0x800450EC): phase 1, once per charge
    const C = B.charge;
    if (this.state === 'charge' && this.phase === 1 && !this.hit && !C.no_hit_bit3) {
      const P = this.ctx.position().clone().addScaledVector(this.dir.clone().setY(0).normalize(), C.hit_point_forward_units);
      P.y += C.hit_point_up_units;
      if (P.distanceTo(this.ctx.target()) < C.hit_range_units + this.ctx.targetRadius()) {
        this.hit = true; this.hitstop = C.hitstop_ticks;
        this.ctx.onCharge && this.ctx.onCharge('hit', this);
      }
    }
  }
  get active() { return this.state !== 'ground' || this.pos.lengthSq() > 0; }

  press() { if (!this.held) this.edge = true; this.held = true; }
  release() { this.held = false; }

  /** One tick: the state function, then pos += 0.01 * vel and the floor test (0x8004B0A0). */
  tick() {
    const F = this.ctx.fields(), B = this.ctx.body();
    if (!F || !B) return;
    // R+0x1C8, the state's return value: 0 makes the battle draw (0x80038FA4) show the robo at alpha 0.5,
    // translucent: the Strike Vanisher "stealth" dash while it moves, and charge phases flagged in +0xD1
    this.vanish = false;
    const g = 0.006 * F.gravity;
    const edge = this.edge; this.edge = false;
    const s = this.state;
    if (s === 'ground') {
      if (edge) {
        // jump (0x8004A2AC): count = air jumps (style 1) or air dashes; velocity unchanged, then gravity
        this.H = F.jump_hold_ticks;
        this.count = B.dash_style === 1 ? B.air_jump_count : B.air_dash_count;
        this.state = 'air';
        this.vel.y -= g;
        this.ctx.onPose('air', 0, 16);
      } else return;
    } else if (s === 'air') {
      if (this.E2 > 0) { this.E2--; this.ctx.onPose('dash', 0.2967 * 30, 0); }
      else {
        if (this.H > 0) {
          if (this.held) { this.H--; const n = F.jump_hold_ticks; this.vel.y += 0.5 * (g * n + Math.sqrt(n * n * g * g + 8 * g * F.jump_height)) / n; }
          else this.H = 0;
        }
        if (this.count > 0 && edge) { this.airMove(F, B); return this.integrate(F, g); }
        // horizontal: no stick here, the speed is clamped to the air cap 0.1 * f5
        const h = new THREE.Vector2(this.vel.x, this.vel.z), cap = 0.1 * F.air_speed_cap;
        if (h.length() > cap) h.setLength(cap);
        this.vel.x = h.x; this.vel.z = h.y;
        this.ctx.onPose('air', 0, 0);
      }
      // the forced fall of an attack in the air (fire / bomb / pod states: vy = -4.0)
      if (this.ctx.attacking()) this.vel.y = -4.0; else this.vel.y -= g;
    } else if (s === 'charge') {
      this.stepCharge(B);
      if (this.state === 'charge') { this.integrateCharge(B); return; }
      if (this.state === 'ground') return;
    } else if (s === 'dash') {
      this.stepDash(F, B);
    } else if (s === 'airjump') {
      if (this.E2 > 0) {
        this.E2--;
        this.ctx.onPose('air_jump', 10 * (this.E0 - this.E2) / this.E0 / 30 * 30, 0);   // 10*p/30 frames
        if (this.E2 === 0) {
          this.vel.set(0, Math.sqrt(2 * g * F.air_jump_height), 0);
          this.state = 'air'; this.E4 = F.dash_land_lock;
        }
      }
    } else if (s === 'land') {
      if (this.E2 > 0) {
        this.E2--;
        this.ctx.onPose(this.landClip, 18.9 * (this.E0 - this.E2) / this.E0, 0);
      }
      if (this.E2 <= 0) { this.state = 'ground'; this.ctx.onPose(null); this.ctx.onState && this.ctx.onState('ground'); }
      return;
    }
    this.integrate(F, g);
  }

  /** Air-move entry (0x8004A7B0): startup E2 = f9, one move spent, velocity zeroed, direction = the facing. */
  airMove(F, B) {
    this.E2 = this.E0 = F.dash_startup;
    this.count--;
    this.vel.set(0, 0, 0);
    this.dir.copy(this.ctx.facing()).setY(0).normalize();
    if (B.dash_style === 1) { this.state = 'airjump'; return; }
    this.state = 'dash';
    this.H = F.dash_ticks;
    this.frame = 1.0;
    this.fly = B.dash_style === 2 && B.flies;
  }

  /** States 7 (straight) and 8 (steerable / fly). */
  stepDash(F, B) {
    const st8 = B.dash_style === 2;
    if (this.E2 > 0) {
      this.E2--;
      this.vel.set(0, 0, 0);
      if (st8) this.frame = this.frame + 0.32 >= 10 ? 9.9 : this.frame + 0.32;
      else this.frame = 9 * (this.E0 - this.E2) / this.E0 / 30;          // as read: barely leaves frame 0
      this.pose(st8);
      return;
    }
    if (this.H === 0) {
      // the dash ends: back to state 0 airborne, extra landing lock f10; this tick keeps the dash velocity
      this.state = 'air'; this.E4 = F.dash_land_lock;
      return;
    }
    // neutral stick: state 8 keeps its heading
    const v = this.dir.clone().multiplyScalar(0.1 * F.dash_speed);
    if (B.dash_pitch_deg) {
      const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.dir).normalize();
      v.applyAxisAngle(axis, THREE.MathUtils.degToRad(B.dash_pitch_deg));       // + = nose down
    }
    this.vel.copy(v);
    this.H--;
    if (B.stealth_dash && !st8) this.vanish = true;          // st7 moving ticks return body+0x5F ? 0 : 1
    if (st8) this.frame = this.frame + 0.32 >= 10 ? 9.9 : this.frame + 0.32;
    else this.frame = 8.9 / 30;
    this.pose(st8);
  }

  pose(st8) {
    // slot 10: sf_jump_dash, or on the flyers the change_skyer motion with the body animation at the same frame
    this.ctx.onPose(this.fly ? 'fly' : 'dash', this.frame, 0);
  }

  integrate(F, g) {
    this.pos.addScaledVector(this.vel, K_POS);
    // floor test (0x8004CA6C): lands once the origin is 0.1 below the floor on the way down, then snaps to it
    // (so the jump's first tick, gravity before the hold impulse, does not land it)
    if (this.airborne && this.pos.y <= -0.1 && this.vel.y < 0) {
      const impact = THREE.MathUtils.clamp(K_POS * -this.vel.y / Math.sqrt(K_POS * 2 * g * 6), 0, 1);
      const lock = Math.trunc(F.landing_lock * impact + this.E4);
      this.E4 = 0;
      this.pos.y = 0;
      this.vel.set(0, 0, 0);
      this.landClip = this.count > 0 ? 'landing' : 'landing_2';
      this.E2 = this.E0 = lock;
      this.state = 'land';
      if (!lock) { this.state = 'ground'; this.ctx.onPose(null); }
      else this.ctx.onPose(this.landClip, 0, 16);
      this.lastLanding = { impact, lock };
    }
  }

  update(dt) {
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= TICK) { this.tick(); this.acc -= TICK; }
  }
}
