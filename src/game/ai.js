// Computer opponent.
//
// The AI is deliberately given no privileges: it sees the same world, pays the
// same costs and issues the same commands a human does through
// `Sim.applyCommand`. It runs only on the host, alongside the simulation.
//
// Its behaviour is a short build order followed by waves - it banks an army,
// throws it at the nearest enemy castle, and pulls home when its own base is
// being hit.

import { CMD, BUILDINGS, TILE, MAX_POP_CAP } from './consts.js';

/** Order in which an AI wants its first buildings. */
const BUILD_ORDER = [
  'house', 'barracks', 'outpost', 'house', 'archery', 'house',
  'tower', 'barracks', 'house', 'monastery', 'archery', 'outpost',
];

/** Army size that triggers the next attack, per wave. */
const WAVE_SIZES = [6, 9, 12, 16, 20, 24];

export class AI {
  /**
   * @param {import('./sim.js').Sim} sim
   * @param {number} playerId
   * @param {'easy'|'normal'|'hard'} difficulty
   */
  constructor(sim, playerId, difficulty = 'normal') {
    this.sim = sim;
    this.id = playerId;
    this.difficulty = difficulty;
    this.think = 1 + Math.random() * 2;
    this.wave = 0;
    this.attacking = false;
    this.orderIndex = 0;
    this.lastAttackAt = 0;
    // Easier opponents simply act less often and mass smaller armies.
    this.interval = difficulty === 'easy' ? 2.6 : difficulty === 'hard' ? 1.1 : 1.8;
    this.waveScale = difficulty === 'easy' ? 1.6 : difficulty === 'hard' ? 0.7 : 1;
  }

  update(dt) {
    this.think -= dt;
    if (this.think > 0) return;
    this.think = this.interval;

    const sim = this.sim;
    const player = sim.players.get(this.id);
    if (!player || !player.alive || sim.over) return;

    this.manageBuildings(player);
    this.manageArmy(player);
  }

  // -- economy ---------------------------------------------------------------

  manageBuildings(player) {
    const sim = this.sim;
    const mine = [...sim.buildings.values()].filter((b) => b.owner === this.id);
    const producers = mine.filter((b) => b.done && b.def.spawns && b.kind !== 'castle');

    // Decide what is wanted before deciding whether it can be paid for, so the
    // AI knows when it should be saving rather than spending.
    const needHousing = player.pop >= player.popCap - 6 && player.popCap < MAX_POP_CAP;
    let want;
    if (needHousing) {
      want = 'house';
    } else if (this.orderIndex < BUILD_ORDER.length) {
      want = BUILD_ORDER[this.orderIndex];
    } else {
      want = ['barracks', 'archery', 'tower'][this.orderIndex % 3];
    }
    let def = BUILDINGS[want];
    if (!def) return;
    // A pop-gated building cannot be sited yet; housing is the way toward it.
    if (def.requiresPop && player.pop < def.requiresPop) {
      want = 'house';
      def = BUILDINGS.house;
    }

    // Barracks and ranges spend on every unit they train, which will happily
    // consume a whole economy. When something more important is being saved
    // for, mothball them until the money is in hand.
    const banking = !sim.canAfford(player, def.cost) && (needHousing || want === 'house');
    for (const b of producers) {
      const shouldPause = banking;
      if (b.paused !== shouldPause) {
        sim.applyCommand({ t: CMD.TOGGLE_PRODUCTION, id: b.id, on: shouldPause }, this.id);
      }
    }

    const underConstruction = mine.filter((b) => !b.done).length;
    if (underConstruction >= 2) return;   // do not sprawl half-built sites
    if (!sim.canAfford(player, def.cost)) return;
    // Do not add another mouth to feed while already up against the cap.
    if (want !== 'house' && player.pop >= player.popCap - 2) return;

    const castle = mine.find((b) => b.kind === 'castle');
    if (!castle) return;
    const spot = this.findSpot(castle, def.foot, want === 'outpost');
    if (!spot) return;

    sim.applyCommand({ t: CMD.BUILD, kind: want, tx: spot[0], ty: spot[1], u: [] }, this.id);
    if (!needHousing || this.orderIndex >= BUILD_ORDER.length) this.orderIndex++;
  }

  /**
   * Spirals out from the castle for the first legal footprint. An outpost is
   * meant to claim ground away from home, so it starts its search further out.
   * @param {boolean} [far] search from a wider radius
   */
  findSpot(castle, foot, far = false) {
    const sim = this.sim;
    const tiles = sim.map.tiles;
    for (let r = far ? 11 : 3; r < (far ? 24 : 16); r++) {
      // Sample a ring rather than every tile: cheaper, and it spreads the base.
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2 + r * 0.7;
        const tx = Math.round(castle.tx + Math.cos(a) * r);
        const ty = Math.round(castle.ty + Math.sin(a) * r);
        if (tx < 1 || ty < 1 || tx + foot[0] >= tiles || ty + foot[1] >= tiles) continue;
        if (sim.footprintFree(tx, ty, foot)) return [tx, ty];
      }
    }
    return null;
  }

  // -- military --------------------------------------------------------------

  manageArmy(player) {
    const sim = this.sim;
    const army = [];
    for (const u of sim.units.values()) {
      if (u.owner === this.id && u.type !== 'peasant') army.push(u);
    }

    // A base under attack outranks whatever else is happening.
    const threat = this.homeThreat();
    if (threat) {
      sim.applyCommand({
        t: CMD.ATTACK_MOVE, u: army.map((u) => u.id), x: threat.x, y: threat.y,
      }, this.id);
      this.attacking = false;
      return;
    }

    const need = Math.round(WAVE_SIZES[Math.min(this.wave, WAVE_SIZES.length - 1)] * this.waveScale);
    if (this.attacking) {
      // Keep the wave pointed at a live objective; reinforce it as it trickles in.
      const objective = this.pickTarget();
      if (!objective) { this.attacking = false; return; }
      sim.applyCommand({
        t: CMD.ATTACK_MOVE, u: army.map((u) => u.id), x: objective.x, y: objective.y,
      }, this.id);
      if (army.length < Math.max(2, need * 0.3)) {
        this.attacking = false;   // wave spent; regroup and rebuild
        this.wave++;
      }
      return;
    }

    if (army.length >= need) {
      const objective = this.pickTarget();
      if (objective) {
        this.attacking = true;
        sim.applyCommand({
          t: CMD.ATTACK_MOVE, u: army.map((u) => u.id), x: objective.x, y: objective.y,
        }, this.id);
      }
      return;
    }

    // Not enough to march: hold a staging line just outside the base.
    const castle = [...sim.buildings.values()].find((b) => b.owner === this.id && b.kind === 'castle');
    if (!castle) return;
    const idle = army.filter((u) => u.st === 0);
    if (idle.length) {
      const mid = (this.sim.map.tiles * TILE) / 2;
      const dx = Math.sign(mid - castle.x) || 1;
      const dy = Math.sign(mid - castle.y) || 1;
      sim.applyCommand({
        t: CMD.MOVE, u: idle.map((u) => u.id),
        x: castle.x + dx * 220, y: castle.y + dy * 220,
      }, this.id);
    }
  }

  /** An enemy standing among our own buildings, if there is one. */
  homeThreat() {
    const sim = this.sim;
    for (const b of sim.buildings.values()) {
      if (b.owner !== this.id) continue;
      const foe = sim.findTargetNear(this.id, b.x, b.y, 420);
      if (foe) return foe;
    }
    return null;
  }

  /** The nearest hostile castle, falling back to any hostile structure. */
  pickTarget() {
    const sim = this.sim;
    const castle = [...sim.buildings.values()].find((b) => b.owner === this.id && b.kind === 'castle');
    const ox = castle ? castle.x : (this.sim.map.tiles * TILE) / 2;
    const oy = castle ? castle.y : (this.sim.map.tiles * TILE) / 2;

    let best = null, bestD = Infinity, fallback = null, fallbackD = Infinity;
    for (const b of sim.buildings.values()) {
      if (b.owner === this.id) continue;
      const owner = sim.players.get(b.owner);
      if (!owner || !owner.alive) continue;
      const d = (b.x - ox) ** 2 + (b.y - oy) ** 2;
      if (b.kind === 'castle') { if (d < bestD) { bestD = d; best = b; } }
      else if (d < fallbackD) { fallbackD = d; fallback = b; }
    }
    return best || fallback;
  }
}
