// Particle and effect system.
//
// Three kinds of thing live here:
//   * sheet effects - the pack's Dust / Fire / Explosion / Water Splash strips,
//     played once (or looped, for burning buildings);
//   * sparks - cheap procedural quads for embers, splinters, coins and motes;
//   * overlays - floating numbers and expanding rings for order feedback.
//
// Effects are purely cosmetic. They run on every peer independently and are
// never part of the simulation, so they can be as loud as they like.

import { A, drawFrame, frameAt } from './assets.js';

const MAX_SPARKS = 900;

export class Particles {
  constructor() {
    /** @type {Array} sheet-driven animations */
    this.anims = [];
    /** @type {Array} procedural quads */
    this.sparks = [];
    /** @type {Array} floating text and rings */
    this.overlays = [];
    /** Looping fires keyed by the building they belong to. */
    this.fires = new Map();
  }

  clear() {
    this.anims.length = 0;
    this.sparks.length = 0;
    this.overlays.length = 0;
    this.fires.clear();
  }

  // -- emitters --------------------------------------------------------------

  /** Plays one pass of a sheet strip at a world position. */
  sheet(name, x, y, { scale = 1, alpha = 1, rot = 0, flip = false, fade = false, dy = 0 } = {}) {
    const s = A.fx[name];
    if (!s) return;
    this.anims.push({ s, x, y, t: 0, scale, alpha, rot, flip, fade, vy: dy });
  }

  /** Boots kicking up grit. Cheap enough to fire from every running unit. */
  footDust(x, y) {
    this.sheet(Math.random() < 0.5 ? 'dustSmall' : 'dustBig', x, y + 4, {
      scale: 0.34 + Math.random() * 0.16,
      alpha: 0.5,
      flip: Math.random() < 0.5,
    });
  }

  /** A unit lands hard, a building settles: a bigger cloud. */
  dustBurst(x, y, scale = 1) {
    this.sheet('dustBig', x, y, { scale: 0.7 * scale, alpha: 0.75, flip: Math.random() < 0.5 });
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spark(x, y, Math.cos(a) * 55 * scale, Math.sin(a) * 26 * scale - 20, {
        color: '#cbbfa5', size: 3 + Math.random() * 3, life: 0.5, gravity: 40, fade: true,
      });
    }
  }

  explosion(x, y, big = false) {
    this.sheet(big ? 'explosion2' : 'explosion1', x, y, { scale: big ? 1.15 : 0.75 });
    const n = big ? 26 : 12;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (60 + Math.random() * 220) * (big ? 1.4 : 1);
      this.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp * 0.6 - 90, {
        color: ['#ffd98a', '#ff9b45', '#d9603b', '#7c4a3a'][(Math.random() * 4) | 0],
        size: 3 + Math.random() * 5, life: 0.55 + Math.random() * 0.6, gravity: 420, fade: true, drag: 1.4,
      });
    }
    this.ring(x, y, big ? 190 : 110, big ? 0.55 : 0.38, 'rgba(255,214,150,0.75)');
  }

  splash(x, y, scale = 0.7) {
    this.sheet('splash', x, y, { scale });
  }

  /** Sets a building alight; the fire follows it and scales with the damage. */
  igniteBuilding(id, x, y, w, h) {
    if (this.fires.has(id)) { const f = this.fires.get(id); f.x = x; f.y = y; return; }
    const flames = [];
    const count = 2 + ((w * h) / 12000 | 0);
    for (let i = 0; i < count; i++) {
      flames.push({
        ox: (Math.random() - 0.5) * w * 0.7,
        oy: (Math.random() - 0.35) * h * 0.4,
        sheet: ['fire1', 'fire2', 'fire3'][(Math.random() * 3) | 0],
        phase: Math.random() * 2,
        scale: 0.55 + Math.random() * 0.5,
      });
    }
    this.fires.set(id, { x, y, flames, smokeAt: 0 });
  }

  extinguish(id) { this.fires.delete(id); }

  /** A blow lands: a spray of sparks in the direction of the hit. */
  impact(x, y, dirX, dirY, color = '#ffe9b0') {
    const base = Math.atan2(dirY, dirX);
    for (let i = 0; i < 7; i++) {
      const a = base + (Math.random() - 0.5) * 1.5;
      const sp = 90 + Math.random() * 190;
      this.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 40, {
        color, size: 2 + Math.random() * 3, life: 0.3 + Math.random() * 0.25, gravity: 500, fade: true,
      });
    }
    this.ring(x, y, 34, 0.22, 'rgba(255,255,255,0.5)');
  }

  /** Wood chips flying off a tree. */
  woodChips(x, y) {
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      this.spark(x, y, Math.cos(a) * 120, Math.sin(a) * 120, {
        color: ['#a9743f', '#7d5230', '#c99b5e'][(Math.random() * 3) | 0],
        size: 2 + Math.random() * 3, life: 0.5, gravity: 620, fade: true, spin: true,
      });
    }
  }

  /** Sparks off a gold seam. */
  goldSparks(x, y) {
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      this.spark(x, y, Math.cos(a) * 130, Math.sin(a) * 130, {
        color: ['#ffe066', '#ffc93c', '#fff6cc'][(Math.random() * 3) | 0],
        size: 2 + Math.random() * 2.5, life: 0.45, gravity: 640, fade: true, glow: true,
      });
    }
  }

  /** Healing motes drifting upward around a unit. */
  healMotes(x, y) {
    for (let i = 0; i < 8; i++) {
      this.spark(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.3) * 34,
        (Math.random() - 0.5) * 26, -40 - Math.random() * 60, {
        color: ['#bfffd8', '#8ef0c0', '#ffffff'][(Math.random() * 3) | 0],
        size: 2 + Math.random() * 3, life: 0.9, gravity: -30, fade: true, glow: true,
      });
    }
  }

  /** A unit dies: a short puff, no gore. */
  deathPuff(x, y, tint = '#cfd8dc') {
    this.sheet('dustBig', x, y, { scale: 0.55, alpha: 0.8 });
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spark(x, y, Math.cos(a) * 70, Math.sin(a) * 40 - 60, {
        color: tint, size: 2 + Math.random() * 4, life: 0.7, gravity: 240, fade: true,
      });
    }
  }

  /** Coins arcing into the castle when a pawn cashes in. */
  deposit(x, y, kind) {
    const color = kind === 'gold' ? '#ffd54a' : kind === 'wood' ? '#b07a45' : '#e2807c';
    for (let i = 0; i < 5; i++) {
      this.spark(x, y, (Math.random() - 0.5) * 70, -110 - Math.random() * 70, {
        color, size: 3 + Math.random() * 2, life: 0.6, gravity: 340, fade: true, glow: kind === 'gold',
      });
    }
  }

  /** Generic procedural quad. */
  spark(x, y, vx, vy, o = {}) {
    if (this.sparks.length >= MAX_SPARKS) return;
    this.sparks.push({
      x, y, vx, vy,
      color: o.color || '#ffffff',
      size: o.size || 3,
      life: o.life || 0.5,
      t: 0,
      gravity: o.gravity ?? 300,
      drag: o.drag ?? 0.6,
      fade: o.fade !== false,
      glow: !!o.glow,
      rot: o.spin ? Math.random() * Math.PI : 0,
      spin: o.spin ? (Math.random() - 0.5) * 14 : 0,
    });
  }

  /** Expanding ring, used for order markers and impact shocks. */
  ring(x, y, radius, life, color, width = 2) {
    this.overlays.push({ kind: 'ring', x, y, r0: radius * 0.15, r1: radius, life, t: 0, color, width });
  }

  /** Click marker under a move order. */
  moveMarker(x, y, color) {
    this.ring(x, y, 46, 0.45, color, 3);
    this.ring(x, y, 28, 0.35, 'rgba(255,255,255,0.7)', 2);
  }

  /** Floating text, e.g. "+12" over the castle. */
  floatText(x, y, text, color = '#fff', size = 15) {
    this.overlays.push({ kind: 'text', x, y, text, color, size, life: 1.1, t: 0, vy: -34 });
  }

  // -- lifecycle -------------------------------------------------------------

  update(dt) {
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt;
      if (a.vy) a.y += a.vy * dt;
      if (a.t * a.s.fps >= a.s.frames) this.anims.splice(i, 1);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.t += dt;
      if (p.t >= p.life) { this.sparks.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      const damp = 1 - Math.min(1, p.drag * dt);
      p.vx *= damp; p.vy *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const o = this.overlays[i];
      o.t += dt;
      if (o.t >= o.life) { this.overlays.splice(i, 1); continue; }
      if (o.vy) o.y += o.vy * dt;
    }
    // Burning buildings cough smoke on their own schedule.
    for (const f of this.fires.values()) {
      f.smokeAt -= dt;
      if (f.smokeAt <= 0) {
        f.smokeAt = 0.22 + Math.random() * 0.3;
        this.spark(f.x + (Math.random() - 0.5) * 40, f.y - 10,
          (Math.random() - 0.5) * 22, -46 - Math.random() * 30, {
          color: 'rgba(70,66,74,0.55)', size: 8 + Math.random() * 9, life: 1.5, gravity: -14, drag: 1.1,
        });
      }
    }
  }

  /**
   * Draws everything below the unit layer (ground dust, ring markers).
   * Callers set up the world transform first.
   */
  drawGround(ctx, view) {
    for (const o of this.overlays) {
      if (o.kind !== 'ring') continue;
      if (!inView(view, o.x, o.y, 200)) continue;
      const k = o.t / o.life;
      const r = o.r0 + (o.r1 - o.r0) * k;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.width;
      ctx.beginPath();
      ctx.ellipse(o.x, o.y, r, r * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Draws everything above the unit layer. */
  drawTop(ctx, view, time) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;

    for (const f of this.fires.values()) {
      if (!inView(view, f.x, f.y, 220)) continue;
      for (const fl of f.flames) {
        const s = A.fx[fl.sheet];
        drawFrame(ctx, s, frameAt(s, time + fl.phase), f.x + fl.ox, f.y + fl.oy, fl.scale, false, 0.92);
      }
    }

    for (const a of this.anims) {
      if (!inView(view, a.x, a.y, 260)) continue;
      const k = a.t * a.s.fps / a.s.frames;
      const alpha = a.fade ? a.alpha * (1 - k) : a.alpha;
      if (a.rot) {
        ctx.save();
        ctx.translate(a.x, a.y);
        ctx.rotate(a.rot);
        drawFrame(ctx, a.s, frameAt(a.s, a.t), 0, 0, a.scale, a.flip, alpha);
        ctx.restore();
      } else {
        drawFrame(ctx, a.s, frameAt(a.s, a.t), a.x, a.y, a.scale, a.flip, alpha);
      }
    }
    ctx.restore();

    ctx.save();
    for (const p of this.sparks) {
      if (!inView(view, p.x, p.y, 60)) continue;
      const k = p.t / p.life;
      ctx.globalAlpha = p.fade ? 1 - k * k : 1;
      ctx.fillStyle = p.color;
      if (p.glow) {
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 8;
      } else {
        ctx.shadowBlur = 0;
      }
      const s = p.size * (p.fade ? 1 - k * 0.4 : 1);
      if (p.rot) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-s / 2, -s / 2, s, s * 0.6);
        ctx.restore();
      } else {
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
    }
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    for (const o of this.overlays) {
      if (o.kind !== 'text') continue;
      if (!inView(view, o.x, o.y, 120)) continue;
      const k = o.t / o.life;
      ctx.globalAlpha = 1 - k * k;
      ctx.font = `700 ${o.size}px "Trebuchet MS", system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(20,18,28,0.85)';
      ctx.strokeText(o.text, o.x, o.y);
      ctx.fillStyle = o.color;
      ctx.fillText(o.text, o.x, o.y);
    }
    ctx.restore();
  }
}

function inView(view, x, y, pad) {
  return x > view.x0 - pad && x < view.x1 + pad && y > view.y0 - pad && y < view.y1 + pad;
}
