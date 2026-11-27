// HSD particle program interpreter and per-particle update (READ, notes\effects.md "Particle interpreter" in the
// extract folder; interpreter / update 0x8017b4a4, RNG 0x801a5e7c). One call of update() is one game frame.
// Programs come from data/particles.json (tools\particles.py): op dicts with typed args, loops by index.
import * as THREE from 'three';

/** The game's RNG (0x801a5e7c): seed = seed*214013 + 2531011, returns (seed >> 16) / 65536. The real seed is shared
 *  with the rest of the game, so sequences can't match; the generator is the same. */
let seed = 1;
export function rnd() {
  seed = (Math.imul(seed, 214013) + 2531011) >>> 0;
  return (seed >>> 16) / 65536;
}

const clamp255 = v => Math.max(0, Math.min(255, v));

/** A colour ramp (prim, env): shown = lerp(target, base, T/N), integer maths as the game. */
class Ramp {
  constructor(init) { this.base = init.slice(); this.target = init.slice(); this.N = 0; this.T = 0; }
  shown() {
    if (!this.N) return this.base.slice();
    const k = Math.trunc((this.T << 16) / this.N);
    return this.base.map((b, i) => (this.target[i] * 65536 + k * (b - this.target[i])) >> 16);
  }
  step() { if (this.N && --this.T === 0) { this.N = 0; this.base = this.target.slice(); } }
  /** Every colour op: bake the shown colour into base, set the targets, restart. */
  set(time, chans) {
    this.base = this.shown();
    this.target = this.base.slice();
    for (const [i, v] of chans) this.target[i] = v;
    this.restart(time);
  }
  restart(time) {
    this.N = time;
    if (time) this.T = time; else { this.base = this.target.slice(); this.T = 0; }
  }
}

export class Particle {
  /** h: generator header; ops: program; gen: owning generator (or null). */
  constructor(h, ops, gen) {
    this.ops = ops; this.gen = gen; this.texg = h.texg;
    this.pc = 0; this.mark = 0; this.loopStart = 0; this.loopCount = 0;
    this.wait = ops && ops.length ? 1 : 0;
    this.life = h.life + 1;
    this.flags = h.flags_loaded >>> 0;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(...h.vel);
    this.grav = h.grav; this.fric = h.fric;
    this.size = h.size; this.sizeN = 0; this.sizeT = 0;
    this.rot = 0; this.rotN = 0; this.rotTarget = 0; this.rotSpeed = 0; this.rotAccel = 0;
    this.prim = new Ramp([255, 255, 255, 255]);
    this.env = new Ramp([0, 0, 0, 0]);
    this.image = 0;
    this.stretch = 1;            // E8 parameter (+0x88)
    this.dead = false;
  }

  /** One frame (0x8017b4a4). sys: { spawnGenerator(bank, id, p, flags), images(texg) -> count }. */
  update(sys) {
    if (this.flags & 0x800) return;
    if (this.sizeN) { this.size += (this.sizeT - this.size) / this.sizeN; this.sizeN--; }
    this.prim.step(); this.env.step();
    if (this.rotN) {
      if (this.rotAccel === 0) { this.rot += (this.rotTarget - this.rot) / this.rotN; this.rotN--; }
      else {
        this.rot += this.rotSpeed;
        this.rotSpeed += this.rotSpeed < 0 ? -this.rotAccel : this.rotAccel;
        if (--this.rotN === 0) this.rotSpeed = this.rotAccel = 0;
      }
    }
    if (this.wait && --this.wait === 0) this.interpret(sys);
    if (--this.life <= 0) { this.dead = true; return; }
    if (this.flags & 4) { if (this.gen) this.gen.tornado(this); }
    else {
      if (this.flags & 1) this.vel.y -= this.grav;
      if (this.flags & 2) this.vel.multiplyScalar(this.fric);
      this.pos.add(this.vel);
    }
  }

  stop() { this.life = 1; }

  interpret(sys) {
    const ops = this.ops;
    let w = 0;
    while (w === 0 && this.pc < ops.length && this.life !== 1) {
      const o = ops[this.pc++];
      switch (o.op) {
        case 'wait':
          w = o.frames;
          if (o.tex !== undefined) { this.image = o.tex; if (o.tex < sys.images(this.texg)) this.flags |= 0x400; }
          break;
        case 'pos_set': if (o.x !== undefined) this.pos.x = o.x; if (o.y !== undefined) this.pos.y = o.y; if (o.z !== undefined) this.pos.z = o.z; break;
        case 'pos_add': this.pos.x += o.x || 0; this.pos.y += o.y || 0; this.pos.z += o.z || 0; break;
        case 'vel_set': if (o.x !== undefined) this.vel.x = o.x; if (o.y !== undefined) this.vel.y = o.y; if (o.z !== undefined) this.vel.z = o.z; break;
        case 'vel_add': this.vel.x += o.x || 0; this.vel.y += o.y || 0; this.vel.z += o.z || 0; break;
        case 'size': this.sizeN = o.time; this.sizeT = o.size; if (!o.time) this.size = o.size; break;
        case 'size_rand': this.sizeN = o.time; this.sizeT = o.size + o.range * rnd(); if (!o.time) this.size = this.sizeT; break;
        case 'tex_off': this.flags &= ~0x400; break;
        case 'gravity': this.grav = o.g; if (o.g !== 0) this.flags |= 1; else this.flags &= ~1; break;
        case 'friction': this.fric = o.f; if (o.f !== 1) this.flags |= 2; else this.flags &= ~2; break;
        case 'kill_rand': if (Math.trunc(100 * rnd()) <= o.chance) this.stop(); break;
        case 'vel_cone_rand': coneReaim(this.vel, this.vel.clone(), o.angle); break;
        case 'flag_set_0080': this.flags |= 0x80; break;
        case 'flag_set_0060': this.flags |= 0x60; break;
        case 'flag_set_10000000': this.flags |= 0x10000000; break;
        case 'pos_to_world': if (this.gen && this.gen.appToWorld) this.gen.appToWorld(this); break;
        case 'rot_target_add': this.rotN = o.time; this.rotTarget += o.delta; if (!o.time) this.rot = this.rotTarget; break;
        case 'tex_rand': this.image = o.base + Math.trunc(o.range * rnd()); if (this.image < sys.images(this.texg)) this.flags |= 0x400; break;
        case 'speed_rand': {
          const s = o.base + o.range * rnd(), l = this.vel.length();
          if (l > 1e-10) this.vel.multiplyScalar(s / l);
          break;
        }
        case 'prim': case 'env': {
          const chans = [];
          ['r', 'g', 'b', 'a'].forEach((c, i) => { if (o[c] !== undefined) chans.push([i, o[c]]); });
          this[o.op].set(o.time, chans);
          break;
        }
        case 'flip_u': this.flags = flip(this.flags, 0x40000, o.mode); break;
        case 'flip_v': this.flags = flip(this.flags, 0x80000, o.mode); break;
        case 'dir_rot_on': this.flags |= 0x200000; break;
        case 'dir_rot_off': this.flags &= ~0x200000; break;
        case 'dir_stretch': if (o.v >= 0) { this.flags |= 0x100000; this.stretch = o.v; } else this.flags &= ~0x100000; break;
        case 'color_rand_mask': {
          const r = () => (o.steps ? Math.trunc((o.steps + 1) * rnd()) / o.steps : rnd());
          const rc = r(), ra = r();
          const d = [o.r, o.g, o.b, o.a].map((s, i) => (s === undefined ? 0 : 2 * s * (i < 3 ? rc : ra)));
          for (const [bit, ramp] of [[0x10, this.prim], [0x20, this.env]]) {
            ramp.base = ramp.shown();
            if (o.mask & bit) ramp.target = ramp.target.map((v, i) => clamp255(Math.trunc(v + d[i])));
            ramp.restart(ramp.N);
          }
          break;
        }
        case 'rot_rand': {
          const d = o.base + o.range * (o.steps ? Math.trunc((o.steps + 1) * rnd()) / o.steps : rnd());
          this.rot += d; this.rotTarget += d;
          break;
        }
        case 'gen_flag_2000': if (this.gen) this.gen.followRot = true; break;     // 0xF5
        case 'gen_flag_1000': if (this.gen) this.gen.followScale = true; break;   // 0xF6
        case 'spawn_generator_aux': case 'spawn_generator': case 'spawn_generator_flags':
          sys.spawnGenerator(this.gen ? this.gen.bank : 0, o.id, this, o.flags);
          break;
        case 'loop_start': this.loopCount = o.count || 256; this.loopStart = this.pc; break;
        case 'loop_end': if (--this.loopCount !== 0) this.pc = this.loopStart; break;
        case 'mark': this.mark = this.pc; break;
        case 'jump_mark': this.pc = this.mark; break;
        case 'end': case 'stop': this.stop(); break;
        default: break;          // ops no weapon effect uses (see the note); treated as no-ops here
      }
    }
    this.wait = w;
  }
}

function flip(flags, bit, mode) {
  switch (mode & 3) {
    case 0: return flags & ~bit;
    case 1: return flags | bit;
    case 2: return flags ^ bit;
    default: return rnd() >= 0.5 ? flags | bit : flags & ~bit;
  }
}

/** Cone re-aim (0x8017af48): a random direction within `angle` of axis v, keeping |vel|. */
export function coneReaim(vel, v, angle) {
  const eps = 1.1754944e-38;
  const a = Math.abs(v.z) >= eps ? Math.atan2(v.y, v.z) : (v.y >= 0 ? Math.PI / 2 : -Math.PI / 2);
  const q = v.y * Math.sin(a) + v.z * Math.cos(a);
  const b = Math.abs(q) >= eps ? Math.atan2(v.x, q) : (v.x >= 0 ? Math.PI / 2 : -Math.PI / 2);
  const s = vel.length(), phi = 2 * Math.PI * rnd();
  const x = s * Math.sin(angle) * Math.cos(phi), y = s * Math.sin(angle) * Math.sin(phi), z = s * Math.cos(angle);
  vel.set(x * Math.cos(b) + z * Math.sin(b),
    z * Math.sin(a) * Math.cos(b) - x * Math.sin(a) * Math.sin(b) + y * Math.cos(a),
    z * Math.cos(a) * Math.cos(b) - x * Math.cos(a) * Math.sin(b) - y * Math.sin(a));
}
