// A robo's reaction to hits (READ, notes\hit-reactions.md in the extract folder; data/hit_reactions.json). Used for the
// target dummy. 60 ticks/s; velocity in v units, position += 0.01 * v per tick.
//
// Each hit adds its down value to the meter (which falls 1 per tick). Below the body's threshold the robo staggers
// (state 13) along the hit's first recipe (v0 speed, v1 elevation, v2 ticks, v3 gravity); at or over it, or with down
// value -1 (the charge), it is knocked down (state 14): launched by the second recipe (v4 speed, v5 elevation, v6
// gravity), falls (sf_fall_front if hit from the front, sf_fall_back from behind), lies at frame 29, stands up on frames
// 30-59 in the last 30 ticks of the down timer, then gets up (state 16, the body's *_powerup, 30 ticks) immune; the
// immunity lasts 60 ticks past that. A hit while down relaunches it without resetting the timer.
import * as THREE from 'three';

const K_POS = 0.01;
const UP = new THREE.Vector3(0, 1, 0);

export class Reaction {
  /** body: hit_reactions.json entry; onPose(clip, frame) shows the robo's motion. */
  constructor(body, onPose) {
    this.body = body; this.onPose = onPose;
    this.reset();
  }

  reset() {
    this.state = 'stand';
    this.pos = new THREE.Vector3();     // offset from the robo's spot; y above the floor
    this.vel = new THREE.Vector3();
    this.facing = null;                 // world facing after a launch (null: keep facing the attacker)
    this.meter = 0; this.immune = 0;
    this.E2 = 0; this.E0 = 0; this.grounded = true; this.flip = true; this.v = null;
  }

  get idle() { return this.state === 'stand' && this.pos.lengthSq() < 1e-8; }

  /** hit: { down, v: [v0..v6], dir: world Vector3 (pushed away from the attacker), facing: current world facing } */
  hit(h) {
    if (this.immune > 0 || this.state === 'getup') return false;
    const B = this.body;
    const dir = h.dir.clone().setY(0);
    if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
    dir.normalize();
    this.v = h.v;
    const facing = this.facing || h.facing;
    if (this.state === 'down') { this.launch(dir, facing); return true; }   // juggle: the timer keeps running
    this.meter = h.down === -1 ? Infinity : this.meter + h.down;
    if (this.meter < B.down_threshold) {
      this.state = 'stagger';
      this.E2 = this.E0 = Math.trunc(h.v[2] * B.stagger_pct / 100);
      const e = THREE.MathUtils.degToRad(h.v[1]);
      this.vel.copy(dir).multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e)).multiplyScalar(h.v[0] * B.knockback_pct / 1000);
      this.grounded = false;
    } else {
      this.state = 'down';
      this.E2 = this.E0 = B.down_ticks;
      this.grounded = false;
      this.meter = 0;
      this.launch(dir, facing);
    }
    return true;
  }

  launch(dir, facing) {
    // R+0x14A: hit from the front (facing against the push) -> fall_front, and keep facing the attacker
    this.flip = facing.dot(dir) < 0;
    this.facing = this.flip ? dir.clone().negate() : dir.clone();
    const e = THREE.MathUtils.degToRad(this.v[5]);
    this.vel.copy(dir).multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e)).multiplyScalar(this.v[4] * this.body.knockback_pct / 1000);
    this.grounded = false;
  }

  tick() {
    if (this.meter > 0 && this.meter !== Infinity) this.meter--;
    if (this.immune > 0 && this.state !== 'getup') this.immune--;
    const s = this.state;
    if (s === 'stand') return this.physics(0);
    if (s === 'stagger') {
      if (--this.E2 < 1) { this.state = 'stand'; this.onPose(null); return this.physics(0); }
      if (!this.grounded) this.onPose(this.flip ? 'fall_front' : 'fall_back', 0);
      else this.onPose('landing', 18.9 * (this.E0 - this.E2) / this.E0);
      return this.physics(this.v[3]);
    }
    if (s === 'down') {
      this.E2--;
      if (this.E2 < 1) {
        this.state = 'getup'; this.vel.set(0, 0, 0); this.E2 = this.E0 = 30; this.immune = 60;
        this.onPose('getup', 0);
        return this.physics(0);
      }
      const clip = this.flip ? 'fall_front' : 'fall_back';
      if (!this.grounded) { this.E0 = this.E2; this.onPose(clip, 0); }
      else {
        const t = this.E0 - this.E2;
        this.onPose(clip, this.E2 < 31 ? 30 + (30 - this.E2) : t < 30 ? t : 29);
      }
      return this.physics(this.v[6]);
    }
    if (s === 'getup') {
      this.immune = 60;
      this.E2--;
      this.onPose('getup', 20 * (this.E0 - this.E2) / this.E0);
      if (this.E2 < 1) { this.state = 'stand'; this.onPose(null); }
      return this.physics(0);
    }
  }

  /** 0x8004B0A0 for a flat floor: gravity from the state, airborne until below floor - 0.1, then eased to a stop. */
  physics(grav) {
    if (!this.grounded) {
      this.vel.y -= 0.006 * grav;
      this.pos.addScaledVector(this.vel, K_POS);
      if (this.pos.y < -0.1) { this.pos.y = 0; this.vel.y = 0; this.grounded = true; this.landed = true; }
    } else {
      const h = new THREE.Vector2(this.vel.x, this.vel.z);
      if (h.length() > 2.0) h.multiplyScalar(0.8); else h.set(0, 0);
      this.vel.set(h.x, 0, h.y);
      this.pos.addScaledVector(this.vel, K_POS);
      this.pos.y = 0;
    }
  }
}
