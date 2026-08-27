// The authoritative simulation.
//
// Exactly one peer - the host - runs this. Clients send commands, receive
// snapshots, and never advance the world themselves. That keeps four players
// in agreement without asking floating-point maths to be deterministic across
// browsers, which it is not.
//
// The sim owns: units, buildings, projectiles, resource nodes, player economy
// and victory. It emits `events` for anything cosmetic (a sword landing, a
// building falling) so every peer can play the same effects at the same moment.

import {
  TILE, MAP_TILES, UNITS, BUILDINGS, GATHER, BUILD_RATE, CMD, ST,
  START_RESOURCES, BASE_POP_CAP, POP_PER_HOUSE, MAX_POP_CAP, RESOURCES,
  TOWER_ATTACK, LANCER_GUARD_ARMOR, RALLY_SPREAD, NODE_SLOTS, LEVEL,
  MAX_PEASANTS_PER_BASE, DEMOLISH_REFUND,
} from './consts.js';
import { NavGrid, tileIndexAt, tileCenter } from './pathfind.js';

/**
 * How close a peasant must get to a footprint to work it. A shade over one tile,
 * so a worker standing on any adjacent tile - including a diagonal one - counts
 * as having arrived.
 */
const BUILD_RANGE = TILE * 1.1;
const DELIVER_RANGE = TILE * 1.1;

/** Cell size for the unit lookup grid. Comfortably above the largest range. */
const HASH = 128;
const HASH_W = Math.ceil((MAP_TILES * TILE) / HASH);

let nextId = 1;

/** Event kinds broadcast to peers for effects and sound. */
export const EV = {
  MELEE_HIT: 1, ARROW_FIRE: 2, ARROW_HIT: 3, UNIT_DIED: 4, BUILDING_HIT: 5,
  BUILDING_DIED: 6, BUILD_PLACED: 7, BUILD_DONE: 8, UNIT_SPAWNED: 9,
  GATHER_TICK: 10, DEPOSIT: 11, HEAL: 12, PLAYER_DEFEATED: 13, GAME_OVER: 14,
  NODE_DEPLETED: 15, HAMMER: 16,
};

export class Sim {
  /**
   * @param {import('./mapgen.js').GameMap} map
   * @param {Array<{id:number,name:string,color:string,slot:number,ai:boolean}>} playerDefs
   */
  constructor(map, playerDefs) {
    nextId = 1;
    this.map = map;
    this.nav = new NavGrid(map);
    this.tick = 0;
    this.time = 0;
    this.events = [];
    this.over = false;
    this.winner = null;

    /** @type {Map<number, object>} */
    this.units = new Map();
    /** @type {Map<number, object>} */
    this.buildings = new Map();
    /** @type {Array} */
    this.projectiles = [];
    /** @type {Map<number, object>} */
    this.nodes = new Map();
    for (const n of map.nodes) this.nodes.set(n.id, { ...n, workers: 0 });

    this.players = new Map();
    for (const p of playerDefs) {
      this.players.set(p.id, {
        id: p.id, name: p.name, color: p.color, slot: p.slot, ai: !!p.ai,
        res: { ...START_RESOURCES },
        pop: 0, popCap: BASE_POP_CAP,
        alive: true,
        houses: 0,
        placedThisTick: 0,
      });
    }

    this.hash = new Map();
    this.scanCursor = 0;

    for (const p of this.players.values()) this.spawnStartingBase(p);
    this.recomputePop();
  }

  // -- setup -----------------------------------------------------------------

  spawnStartingBase(player) {
    const start = this.map.starts[player.slot];
    const castle = this.addBuilding(player.id, 'castle', start.tx - 2, start.ty - 1, true);
    // Face the rally point toward the middle of the map.
    const mid = (MAP_TILES * TILE) / 2;
    const dx = Math.sign(mid - castle.x) || 1;
    const dy = Math.sign(mid - castle.y) || 1;
    castle.rallyX = castle.x + dx * 150;
    castle.rallyY = castle.y + dy * 150;

    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.addUnit(player.id, 'peasant',
        castle.x + Math.cos(a) * 130 + dx * 40,
        castle.y + Math.sin(a) * 100 + dy * 60);
    }
  }

  // -- entity construction ---------------------------------------------------

  addUnit(ownerId, type, x, y) {
    const def = UNITS[type];
    const u = {
      id: nextId++, owner: ownerId, type, def,
      x, y, vx: 0, vy: 0,
      hp: def.hp, maxHp: def.hp,
      st: ST.IDLE,
      dir: 0, flip: false,
      path: null, pi: 0,
      goalX: x, goalY: y,
      targetId: 0, nodeId: 0, buildId: 0,
      cooldown: 0, animT: 0, frame: 0,
      pendingHit: false,
      carryKind: 0, carryAmount: 0,
      workKind: '', autoTasked: false,
      workT: 0,
      approachTries: 0,
      scanT: Math.random() * 0.5,
      repathT: 0,
      stuckT: 0,
      lastX: x, lastY: y,
      guarding: false,
      awaitingPath: false,
      autoT: Math.random(),
    };
    this.units.set(u.id, u);
    return u;
  }

  /** Places a building. `finished` skips the construction phase (starting castle). */
  addBuilding(ownerId, kind, tx, ty, finished = false) {
    const def = BUILDINGS[kind];
    tx = Math.max(0, Math.min(MAP_TILES - def.foot[0], tx));
    ty = Math.max(0, Math.min(MAP_TILES - def.foot[1], ty));
    const b = {
      id: nextId++, owner: ownerId, kind, def,
      tx, ty,
      x: (tx + def.foot[0] / 2) * TILE,
      y: (ty + def.foot[1] / 2) * TILE,
      maxHp: def.hp,
      hp: finished ? def.hp : Math.max(1, def.hp * 0.12),
      done: finished,
      progress: finished ? def.buildPoints : 0,
      spawnT: def.interval || 0,
      rallyX: 0, rallyY: 0,
      cooldown: 0,
      // Houses alternate between two sprites so a village is not identical huts;
      // the third house sprite is reserved for the outpost.
      variant: kind === 'house' ? 1 + ((tx * 7 + ty * 13) % 2) : 0,
      paused: false,
      builders: 0,
      hitFlash: 0,
    };
    if (!b.rallyX) {
      b.rallyX = b.x;
      b.rallyY = b.y + (def.foot[1] / 2 + 1.4) * TILE;
    }
    this.buildings.set(b.id, b);
    this.setFootprint(b, true);
    if (kind === 'house' && finished) this.recomputePop();
    return b;
  }

  setFootprint(b, on) {
    for (let y = 0; y < b.def.foot[1]; y++) {
      for (let x = 0; x < b.def.foot[0]; x++) this.nav.setOccupied(b.tx + x, b.ty + y, on);
    }
  }

  removeBuilding(b) {
    this.setFootprint(b, false);
    this.buildings.delete(b.id);
    this.recomputePop();
  }

  // -- economy ---------------------------------------------------------------

  recomputePop() {
    for (const p of this.players.values()) { p.pop = 0; p.houses = 0; }
    for (const u of this.units.values()) {
      const p = this.players.get(u.owner);
      if (p) p.pop += u.def.pop;
    }
    for (const b of this.buildings.values()) {
      if (b.kind === 'house' && b.done) {
        const p = this.players.get(b.owner);
        if (p) p.houses++;
      }
    }
    for (const p of this.players.values()) {
      p.popCap = Math.min(MAX_POP_CAP, BASE_POP_CAP + p.houses * POP_PER_HOUSE);
    }
  }

  canAfford(player, cost) {
    return RESOURCES.every((r) => (player.res[r] || 0) >= (cost[r] || 0));
  }

  charge(player, cost) {
    for (const r of RESOURCES) if (cost[r]) player.res[r] -= cost[r];
  }

  refund(player, cost, fraction = 1) {
    for (const r of RESOURCES) if (cost[r]) player.res[r] += Math.round(cost[r] * fraction);
  }

  // -- commands --------------------------------------------------------------

  /**
   * Applies one player command. Every field is re-validated against the
   * authoritative state, so a tampered or stale client cannot move another
   * player's units or conjure resources.
   */
  applyCommand(cmd, playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.alive || this.over) return;

    const mine = (ids) => (ids || [])
      .map((id) => this.units.get(id))
      .filter((u) => u && u.owner === playerId && u.hp > 0);

    switch (cmd.t) {
      case CMD.MOVE: {
        const units = mine(cmd.u);
        this.issueFormationMove(units, cmd.x, cmd.y, ST.MOVE);
        break;
      }
      case CMD.ATTACK_MOVE: {
        const units = mine(cmd.u);
        this.issueFormationMove(units, cmd.x, cmd.y, ST.ATTACK_MOVE);
        break;
      }
      case CMD.ATTACK: {
        const target = this.entity(cmd.id);
        if (!target || target.owner === playerId) break;
        for (const u of mine(cmd.u)) {
          this.clearWork(u);
          u.targetId = target.id;
          u.guarding = false;
          this.setState(u, ST.CHASE);
          this.moveTo(u, target.x, target.y, 1);
        }
        break;
      }
      case CMD.STOP: {
        for (const u of mine(cmd.u)) {
          this.clearWork(u);
          u.targetId = 0;
          u.guarding = false;
          u.path = null;
          this.setState(u, ST.IDLE);
        }
        break;
      }
      case CMD.HOLD: {
        for (const u of mine(cmd.u)) {
          this.clearWork(u);
          u.path = null;
          u.guarding = true;
          this.setState(u, ST.HOLD);
        }
        break;
      }
      case CMD.GATHER: {
        const node = this.nodes.get(cmd.id);
        if (!node || node.amount <= 0) break;
        for (const u of mine(cmd.u)) {
          if (u.type !== 'peasant') continue;
          this.assignNode(u, node);
        }
        break;
      }
      case CMD.BUILD: {
        this.tryPlaceBuilding(player, cmd.kind, cmd.tx, cmd.ty, mine(cmd.u));
        break;
      }
      case CMD.RALLY: {
        const b = this.buildings.get(cmd.id);
        if (!b || b.owner !== playerId) break;
        b.rallyX = clampWorld(cmd.x);
        b.rallyY = clampWorld(cmd.y);
        break;
      }
      case CMD.TOGGLE_PRODUCTION: {
        const b = this.buildings.get(cmd.id);
        if (!b || b.owner !== playerId || !b.def.spawns) break;
        b.paused = cmd.on === undefined ? !b.paused : !!cmd.on;
        break;
      }
      case CMD.DEMOLISH: {
        const b = this.buildings.get(cmd.id);
        // Your castle is your life in this game; it is not yours to knock down.
        if (!b || b.owner !== playerId || b.kind === 'castle') break;
        if (!b.done) {
          // Still a foundation: this is a cancellation, refunded by progress.
          this.refund(player, b.def.cost, 1 - b.progress / Math.max(1, b.def.buildPoints));
        } else {
          this.refund(player, b.def.cost, DEMOLISH_REFUND);
        }
        for (const u of this.units.values()) if (u.buildId === b.id) this.clearWork(u);
        this.destroyBuilding(b);
        break;
      }
      case CMD.CANCEL_BUILD: {
        const b = this.buildings.get(cmd.id);
        if (!b || b.owner !== playerId || b.done || b.kind === 'castle') break;
        this.refund(player, b.def.cost, 1 - b.progress / Math.max(1, b.def.buildPoints));
        for (const u of this.units.values()) if (u.buildId === b.id) this.clearWork(u);
        this.removeBuilding(b);
        break;
      }
      default: break;
    }
  }

  entity(id) { return this.units.get(id) || this.buildings.get(id) || null; }

  /**
   * Spreads a group order over a loose grid around the click, so fifty units
   * do not all fight for one tile.
   */
  issueFormationMove(units, x, y, state) {
    if (!units.length) return;
    x = clampWorld(x); y = clampWorld(y);
    const spacing = 42;
    const cols = Math.max(1, Math.ceil(Math.sqrt(units.length)));
    // Order by distance so the group keeps its shape instead of crossing over.
    const sorted = units.slice().sort((a, b) =>
      (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2));
    sorted.forEach((u, i) => {
      const col = i % cols, row = (i / cols) | 0;
      const ox = (col - (cols - 1) / 2) * spacing;
      const oy = (row - (Math.ceil(units.length / cols) - 1) / 2) * spacing;
      this.clearWork(u);
      u.targetId = 0;
      u.guarding = false;
      this.setState(u, state);
      this.moveTo(u, x + ox, y + oy, 1);
    });
  }

  tryPlaceBuilding(player, kind, tx, ty, selected) {
    const def = BUILDINGS[kind];
    const refuse = () => this.emit(EV.BUILD_PLACED, { ok: 0, p: player.id });
    if (!def || kind === 'castle') return;
    // Some structures need a settlement behind them before they make sense.
    if (def.requiresPop && player.pop < def.requiresPop) { refuse(); return; }
    if (!this.canAfford(player, def.cost)) { refuse(); return; }
    if (!this.footprintFree(tx, ty, def.foot)) { refuse(); return; }
    // A site nobody can stand beside can never be built, so it is not a legal
    // place to put one - better to refuse the click than bank the cost in a
    // foundation that will sit there forever.
    if (!this.hasApproach(tx, ty, def.foot)) { refuse(); return; }

    this.charge(player, def.cost);
    const b = this.addBuilding(player.id, kind, tx, ty, false);
    this.emit(EV.BUILD_PLACED, { ok: 1, p: player.id, x: b.x, y: b.y, id: b.id });

    // Send the selected peasants, or failing that the nearest few idle ones.
    let crew = selected.filter((u) => u.type === 'peasant');
    if (!crew.length) crew = this.nearestIdlePeasants(player.id, b.x, b.y, 3);
    for (const u of crew.slice(0, 5)) this.assignBuild(u, b);
  }

  /** True when a footprint sits on open, unoccupied, dry ground. */
  footprintFree(tx, ty, foot) {
    if (tx < 0 || ty < 0 || tx + foot[0] > MAP_TILES || ty + foot[1] > MAP_TILES) return false;
    for (let y = 0; y < foot[1]; y++) {
      for (let x = 0; x < foot[0]; x++) {
        const i = (ty + y) * MAP_TILES + (tx + x);
        if (this.map.level[i] === LEVEL.WATER) return false;
        if (this.nav.occupied[i]) return false;
      }
    }
    return true;
  }

  /** True when at least one tile beside a footprint can be stood on. */
  hasApproach(tx, ty, foot) {
    const centre = ((ty + foot[1] / 2) * TILE);
    return this.nav.nearestApproach(tx, ty, foot, (tx + foot[0] / 2) * TILE, centre, 1) >= 0;
  }

  nearestIdlePeasants(ownerId, x, y, count) {
    const out = [];
    for (const u of this.units.values()) {
      if (u.owner !== ownerId || u.type !== 'peasant') continue;
      if (u.st === ST.BUILD_WORK || u.st === ST.BUILD_GO) continue;
      out.push(u);
    }
    out.sort((a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2));
    return out.slice(0, count);
  }

  // -- unit tasking ----------------------------------------------------------

  setState(u, st) {
    if (u.st !== st) { u.st = st; u.animT = 0; u.frame = 0; u.pendingHit = false; }
  }

  clearWork(u) {
    if (u.nodeId) {
      const n = this.nodes.get(u.nodeId);
      if (n && n.workers > 0) n.workers--;
      u.nodeId = 0;
    }
    if (u.buildId) {
      const b = this.buildings.get(u.buildId);
      if (b && b.builders > 0) b.builders--;
      u.buildId = 0;
    }
    u.workKind = '';
    u.workT = 0;
  }

  assignNode(u, node, auto = false) {
    this.clearWork(u);
    u.nodeId = node.id;
    u.workKind = node.kind;
    // Peasants that chose their own job re-think it after every delivery; ones a
    // player pointed at a seam stay there until it runs dry.
    u.autoTasked = auto;
    u.approachTries = 0;
    node.workers++;
    this.setState(u, ST.GATHER_GO);
    this.approach(u, node.tx, node.ty, [1, 1]);
  }

  assignBuild(u, b) {
    this.clearWork(u);
    u.buildId = b.id;
    u.approachTries = 0;
    b.builders++;
    this.setState(u, ST.BUILD_GO);
    this.approach(u, b.tx, b.ty, b.def.foot);
  }

  /**
   * Routes a worker to a tile it can genuinely stand on beside a footprint.
   * Aiming at the target's own tile does not work: nodes and buildings block
   * their tiles, and a naive fallback can pick somewhere the worker arrives at
   * and still cannot reach from.
   *
   * @returns {boolean} false when nothing beside the target is standable
   */
  approach(u, tx, ty, foot) {
    const tile = this.nav.nearestApproach(tx, ty, foot, u.x, u.y);
    if (tile < 0) return false;
    const [gx, gy] = tileCenter(tile);
    this.moveTo(u, gx, gy, 0);
    return true;
  }

  /** Sets a movement goal and asks the pathfinder for a route. */
  moveTo(u, x, y, priority = 0) {
    u.goalX = clampWorld(x);
    u.goalY = clampWorld(y);
    u.path = null;
    u.pi = 0;
    u.stuckT = 0;
    u.awaitingPath = true;
    const goalTile = this.nav.nearestOpen(tileIndexAt(u.goalX, u.goalY), 8);
    if (goalTile < 0) { u.awaitingPath = false; return; }
    const [gx, gy] = tileCenter(goalTile);
    u.goalX = gx; u.goalY = gy;
    this.nav.request(u.x, u.y, goalTile, (path) => {
      u.awaitingPath = false;
      u.path = path;
      u.pi = 0;
    }, priority);
  }

  // -- main loop -------------------------------------------------------------

  step(dt) {
    if (this.over) return;
    this.tick++;
    this.time += dt;

    this.rebuildHash();
    this.nav.serve(14);

    for (const u of this.units.values()) this.updateUnit(u, dt);
    for (const b of this.buildings.values()) this.updateBuilding(b, dt);
    this.updateProjectiles(dt);
    this.resolveCollisions();
    this.checkVictory();
  }

  rebuildHash() {
    this.hash.clear();
    for (const u of this.units.values()) {
      if (u.hp <= 0) continue;
      const key = ((u.y / HASH) | 0) * HASH_W + ((u.x / HASH) | 0);
      let cell = this.hash.get(key);
      if (!cell) { cell = []; this.hash.set(key, cell); }
      cell.push(u);
    }
  }

  /** Every unit within `r` of a point. */
  near(x, y, r, out = []) {
    out.length = 0;
    const c0 = ((x - r) / HASH) | 0, c1 = ((x + r) / HASH) | 0;
    const r0 = ((y - r) / HASH) | 0, r1 = ((y + r) / HASH) | 0;
    for (let ry = r0; ry <= r1; ry++) {
      for (let cx = c0; cx <= c1; cx++) {
        const cell = this.hash.get(ry * HASH_W + cx);
        if (cell) for (const u of cell) out.push(u);
      }
    }
    return out;
  }

  // -- units -----------------------------------------------------------------

  updateUnit(u, dt) {
    if (u.hp <= 0) return;
    // A building can go up on top of a worker, sealing it inside solid tiles
    // with no legal step out. Nothing should ever be entombed, so lift anyone
    // who is and set them down alongside.
    const here = tileIndexAt(u.x, u.y);
    if (!this.nav.passable(here)) {
      const out = this.nav.nearestOpen(here, 6);
      if (out >= 0) {
        const [ox, oy] = tileCenter(out);
        u.x = ox; u.y = oy;
        u.path = null;
        u.stuckT = 0;
      }
    }
    u.animT += dt;
    u.cooldown = Math.max(0, u.cooldown - dt);
    u.scanT -= dt;

    switch (u.st) {
      case ST.IDLE: this.updateIdle(u, dt); break;
      case ST.MOVE: this.updateMove(u, dt, false); break;
      case ST.ATTACK_MOVE: this.updateMove(u, dt, true); break;
      case ST.HOLD: this.updateHold(u, dt); break;
      case ST.CHASE: this.updateChase(u, dt); break;
      case ST.ATTACK: this.updateAttack(u, dt); break;
      case ST.HEAL: this.updateHeal(u, dt); break;
      case ST.GATHER_GO: this.updateGatherGo(u, dt); break;
      case ST.GATHER_WORK: this.updateGatherWork(u, dt); break;
      case ST.RETURN: this.updateReturn(u, dt); break;
      case ST.BUILD_GO: this.updateBuildGo(u, dt); break;
      case ST.BUILD_WORK: this.updateBuildWork(u, dt); break;
      default: break;
    }
    this.advanceAnim(u, dt);
  }

  updateIdle(u, dt) {
    if (u.type === 'peasant') {
      // Peasants never stand around: pick up work on their own.
      u.autoT -= dt;
      if (u.autoT <= 0) { u.autoT = 0.7; this.autoAssignPeasant(u); }
      return;
    }
    if (u.type === 'monk') { if (this.tryHeal(u)) return; }
    if (u.scanT <= 0) {
      u.scanT = 0.35 + Math.random() * 0.2;
      const foe = this.findTarget(u, u.def.sight);
      if (foe) { u.targetId = foe.id; this.setState(u, ST.CHASE); }
    }
  }

  updateHold(u, dt) {
    if (u.type === 'monk' && this.tryHeal(u)) return;
    if (u.cooldown <= 0 && u.scanT <= 0) {
      u.scanT = 0.25;
      const foe = this.findTarget(u, u.def.range + u.def.radius + 30);
      if (foe) { u.targetId = foe.id; this.beginAttack(u, foe); }
    }
  }

  updateMove(u, dt, aggressive) {
    if (aggressive && u.scanT <= 0) {
      u.scanT = 0.3 + Math.random() * 0.2;
      const foe = this.findTarget(u, u.def.sight);
      if (foe) {
        u.targetId = foe.id;
        u.returnX = u.goalX; u.returnY = u.goalY;   // remember the objective
        this.setState(u, ST.CHASE);
        return;
      }
    }
    if (this.followPath(u, dt)) this.setState(u, ST.IDLE);
  }

  updateChase(u, dt) {
    const target = this.entity(u.targetId);
    if (!target || target.hp <= 0) {
      u.targetId = 0;
      // An attack-move unit resumes its march once the fight is over.
      if (u.returnX !== undefined) {
        const rx = u.returnX, ry = u.returnY;
        u.returnX = undefined;
        this.setState(u, ST.ATTACK_MOVE);
        this.moveTo(u, rx, ry, 1);
      } else {
        this.setState(u, ST.IDLE);
      }
      return;
    }
    const reach = this.reachDistance(u);
    const d = this.surfaceDistance(u, target);
    if (d <= reach) {
      u.path = null;
      if (u.cooldown <= 0) { this.beginAttack(u, target); return; }
      this.face(u, target.x, target.y);
      return;
    }
    // Repath periodically; a moving target invalidates the old route fast.
    u.repathT -= dt;
    if (u.repathT <= 0 || !u.path) {
      u.repathT = 0.55 + Math.random() * 0.3;
      const dist = Math.hypot(target.x - u.goalX, target.y - u.goalY);
      if (dist > 60 || !u.path) this.moveTo(u, target.x, target.y, 2);
    }
    this.followPath(u, dt);
  }

  updateAttack(u, dt) {
    const target = this.entity(u.targetId);
    if (!target || target.hp <= 0) { this.setState(u, ST.CHASE); return; }
    this.face(u, target.x, target.y);

    const strip = attackDuration(u);
    if (!u.pendingHit && u.animT >= strip * 0.45) {
      u.pendingHit = true;
      this.landBlow(u, target);
    }
    if (u.animT >= strip) {
      if (u.guarding) this.setState(u, ST.HOLD);
      else this.setState(u, ST.CHASE);
    }
  }

  updateHeal(u, dt) {
    const target = this.units.get(u.targetId);
    const strip = 11 / 12;
    if (!target || target.hp <= 0 || target.hp >= target.maxHp) {
      if (u.animT < strip) return;
      this.setState(u, ST.IDLE);
      return;
    }
    this.face(u, target.x, target.y);
    if (!u.pendingHit && u.animT >= strip * 0.55) {
      u.pendingHit = true;
      const amount = Math.min(UNITS.monk.heal, target.maxHp - target.hp);
      target.hp += amount;
      this.emit(EV.HEAL,
        { x: target.x, y: target.y, id: target.id, p: u.owner, a: Math.round(amount) });
    }
    if (u.animT >= strip) this.setState(u, ST.IDLE);
  }

  // -- gathering -------------------------------------------------------------

  /**
   * Idle peasants choose their own job. Rather than sending everyone at whatever
   * is scarcest - which starves the other two lines entirely - each peasant joins
   * whichever resource is furthest below its fair share of the workforce.
   */
  autoAssignPeasant(u) {
    const player = this.players.get(u.owner);
    if (!player) return;

    const working = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    let total = 0;
    for (const w of this.units.values()) {
      if (w.owner !== u.owner || w.type !== 'peasant' || !w.workKind || w.id === u.id) continue;
      working[w.workKind]++;
      total++;
    }

    // Scarcity sets the target split; a stockpile of one resource quietly
    // moves peasants onto the other two.
    let sum = 0;
    const weight = {};
    for (const r of RESOURCES) {
      weight[r] = 1 / (1 + (player.res[r] || 0) / 260);
      sum += weight[r];
    }
    const order = RESOURCES.slice().sort((a, b) => {
      const da = weight[a] / sum - (total ? working[a] / total : 0);
      const db = weight[b] / sum - (total ? working[b] / total : 0);
      return db - da;
    });

    // Take the best-ranked kind that actually has a reachable free node, so a
    // player whose gold has run out does not leave peasants standing idle.
    let fallback = null, fallbackD = Infinity;
    for (const kind of order) {
      let best = null, bestD = Infinity;
      for (const n of this.nodes.values()) {
        if (n.amount <= 0 || n.workers >= NODE_SLOTS[n.kind]) continue;
        const d = (n.x - u.x) ** 2 + (n.y - u.y) ** 2;
        if (n.kind === kind) { if (d < bestD) { bestD = d; best = n; } }
        else if (d < fallbackD) { fallbackD = d; fallback = n; }
      }
      // A seam on the far side of the island is worse than a near second choice.
      if (best && bestD < fallbackD * 6) { this.assignNode(u, best, true); return; }
      if (best) { this.assignNode(u, best, true); return; }
    }
    if (fallback) this.assignNode(u, fallback, true);
  }

  updateGatherGo(u, dt) {
    const node = this.nodes.get(u.nodeId);
    if (!node || node.amount <= 0) { this.clearWork(u); this.setState(u, ST.IDLE); return; }
    const d = Math.hypot(node.x - u.x, node.y - u.y);
    if (d < TILE * 1.5) {
      u.path = null;
      this.face(u, node.x, node.y);
      u.workT = 0;
      this.setState(u, ST.GATHER_WORK);
      return;
    }
    if (this.followPath(u, dt)) {
      // Standing where we meant to and the seam is still out of reach: this one
      // cannot be worked from anywhere we can get to, so take a different job
      // rather than pacing back and forth forever.
      if (d < TILE * 2.4) { this.setState(u, ST.GATHER_WORK); u.workT = 0; return; }
      if (++u.approachTries > 2 || !this.approach(u, node.tx, node.ty, [1, 1])) {
        this.clearWork(u);
        this.setState(u, ST.IDLE);
      }
    }
  }

  updateGatherWork(u, dt) {
    const node = this.nodes.get(u.nodeId);
    if (!node || node.amount <= 0) { this.clearWork(u); this.setState(u, ST.IDLE); return; }
    this.face(u, node.x, node.y);
    const g = GATHER[node.kind];
    u.workT += dt;
    // One visible strike per animation cycle, for effects and sound.
    const strikeEvery = g.time / 3;
    if (Math.floor(u.workT / strikeEvery) > Math.floor((u.workT - dt) / strikeEvery)) {
      this.emit(EV.GATHER_TICK, { x: node.x, y: node.y, k: node.kind });
    }
    if (u.workT >= g.time) {
      const got = Math.min(g.amount, node.amount);
      node.amount -= got;
      u.carryKind = RESOURCES.indexOf(node.kind) + 1;
      u.carryAmount = got;
      u.workT = 0;
      if (node.amount <= 0) {
        this.emit(EV.NODE_DEPLETED, { id: node.id, x: node.x, y: node.y, k: node.kind });
        // A spent node stops blocking the tile, opening the ground back up.
        this.nav.setOccupiedRaw(node.tx, node.ty, 0);
      }
      this.setState(u, ST.RETURN);
      u.approachTries = 0;
      const drop = this.nearestDropoff(u);
      if (drop) this.approach(u, drop.tx, drop.ty, drop.def.foot);
      else { this.clearWork(u); this.setState(u, ST.IDLE); }
    }
  }

  updateReturn(u, dt) {
    const drop = this.nearestDropoff(u);
    if (!drop) { this.setState(u, ST.IDLE); return; }
    const d = this.footprintDistance(u.x, u.y, drop.tx, drop.ty, drop.def.foot);
    if (d <= DELIVER_RANGE) {
      const player = this.players.get(u.owner);
      const kind = RESOURCES[u.carryKind - 1];
      if (player && kind) {
        player.res[kind] += u.carryAmount;
        this.emit(EV.DEPOSIT, { x: drop.x, y: drop.y - 20, k: kind, a: u.carryAmount, p: u.owner });
      }
      u.carryKind = 0; u.carryAmount = 0;
      u.path = null;
      // A self-directed peasant reconsiders here, which is what keeps all three
      // income lines balanced as the economy shifts underneath it.
      if (u.autoTasked) {
        this.autoAssignPeasant(u);
        if (u.nodeId) return;
        this.clearWork(u);
        this.setState(u, ST.IDLE);
        return;
      }
      // Straight back to the seam, or to a new job if it ran dry.
      const node = this.nodes.get(u.nodeId);
      if (node && node.amount > 0) {
        this.setState(u, ST.GATHER_GO);
        u.approachTries = 0;
        this.approach(u, node.tx, node.ty, [1, 1]);
      } else {
        this.clearWork(u);
        this.setState(u, ST.IDLE);
      }
      return;
    }
    if (this.followPath(u, dt)) {
      if (++u.approachTries > 3) { u.approachTries = 0; this.setState(u, ST.IDLE); return; }
      this.approach(u, drop.tx, drop.ty, drop.def.foot);
    }
  }

  /** Loads go to the nearest finished base - a castle, or any outpost. */
  nearestDropoff(u) {
    let best = null, bestD = Infinity;
    for (const b of this.buildings.values()) {
      if (b.owner !== u.owner || !b.done || !b.def.dropoff) continue;
      const d = (b.x - u.x) ** 2 + (b.y - u.y) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  // -- construction ----------------------------------------------------------

  updateBuildGo(u, dt) {
    const b = this.buildings.get(u.buildId);
    if (!b || b.done) { this.clearWork(u); this.setState(u, ST.IDLE); return; }
    if (this.footprintDistance(u.x, u.y, b.tx, b.ty, b.def.foot) <= BUILD_RANGE) {
      u.path = null;
      this.face(u, b.x, b.y);
      this.setState(u, ST.BUILD_WORK);
      return;
    }
    if (this.followPath(u, dt)) {
      // Arrived at the reserved spot but still short: try another way in a few
      // times before giving the job up, since another peasant may be in the way.
      if (++u.approachTries > 6 || !this.approach(u, b.tx, b.ty, b.def.foot)) {
        this.clearWork(u);
        this.setState(u, ST.IDLE);
      }
    }
  }

  updateBuildWork(u, dt) {
    const b = this.buildings.get(u.buildId);
    if (!b || b.done) { this.clearWork(u); this.setState(u, ST.IDLE); return; }
    this.face(u, b.x, b.y);
    b.progress += BUILD_RATE * dt;
    // Health rises with the frame going up, so a raw site is fragile.
    const k = Math.min(1, b.progress / b.def.buildPoints);
    b.hp = Math.max(b.hp, b.maxHp * (0.12 + 0.88 * k));

    u.workT += dt;
    if (u.workT > 0.34) {
      u.workT = 0;
      this.emit(EV.HAMMER, { x: b.x, y: b.y + 10 });
    }
    if (b.progress >= b.def.buildPoints) {
      b.done = true;
      b.hp = b.maxHp;
      b.spawnT = b.def.interval || 0;
      this.recomputePop();
      this.emit(EV.BUILD_DONE, { id: b.id, x: b.x, y: b.y, p: b.owner });
      for (const w of this.units.values()) if (w.buildId === b.id) { this.clearWork(w); this.setState(w, ST.IDLE); }
    }
  }

  // -- buildings -------------------------------------------------------------

  updateBuilding(b, dt) {
    if (b.hitFlash > 0) b.hitFlash -= dt;
    if (!b.done) {
      // Nobody working it? Pull in a peasant rather than letting it sit forever.
      if (b.builders <= 0) {
        b.idleT = (b.idleT || 0) + dt;
        if (b.idleT > 1.5) {
          b.idleT = 0;
          const crew = this.nearestIdlePeasants(b.owner, b.x, b.y, 1);
          if (crew.length) this.assignBuild(crew[0], b);
        }
      }
      return;
    }

    const player = this.players.get(b.owner);
    if (!player) return;

    if (b.def.spawns && !b.paused) {
      b.spawnT -= dt;
      if (b.spawnT <= 0) {
        const def = UNITS[b.def.spawns];
        // Training costs resources as well as time, which is what gives both
        // income lines something to be spent on.
        const peasantCount = b.def.spawns === 'peasant' ? this.countPeasants(b.owner) : -1;
        // The peasant ceiling scales with how many bases you hold, so an outpost
        // buys real economy rather than just a second spawn point.
        const peasantCeiling = this.countBases(b.owner) * MAX_PEASANTS_PER_BASE;
        const atPeasantCeiling = peasantCount >= peasantCeiling;
        // A player with a base but no peasants and no gold cannot dig itself out.
        // Rather than leave them alive but inert, raise one last peasant free.
        const lastHope = peasantCount === 0;
        if (!atPeasantCeiling
          && (lastHope || (player.pop + def.pop <= player.popCap && this.canAfford(player, def.cost)))) {
          if (!lastHope) this.charge(player, def.cost);
          b.spawnT = b.def.interval;
          const spot = this.spawnSpot(b);
          const u = this.addUnit(b.owner, b.def.spawns, spot[0], spot[1]);
          this.recomputePop();
          this.emit(EV.UNIT_SPAWNED, { id: u.id, x: u.x, y: u.y, p: b.owner, t: b.def.spawns });
          // March to the rally point; peasants just start working instead.
          if (u.type !== 'peasant') {
            this.setState(u, ST.MOVE);
            this.moveTo(u, b.rallyX + (Math.random() - 0.5) * RALLY_SPREAD,
              b.rallyY + (Math.random() - 0.5) * RALLY_SPREAD, 0);
          }
        } else {
          b.spawnT = 1.0; // blocked on population or resources; retry shortly
        }
      }
    }

    if (b.kind === 'tower') {
      b.cooldown = Math.max(0, b.cooldown - dt);
      if (b.cooldown <= 0) {
        const foe = this.findTargetNear(b.owner, b.x, b.y, TOWER_ATTACK.range);
        if (foe) {
          b.cooldown = TOWER_ATTACK.cooldown;
          this.fireArrow(b, foe, TOWER_ATTACK.damage);
        }
      }
    }
  }

  countPeasants(ownerId) {
    let n = 0;
    for (const u of this.units.values()) if (u.owner === ownerId && u.type === 'peasant') n++;
    return n;
  }

  /** Finished castles and outposts, which together set the peasant ceiling. */
  countBases(ownerId) {
    let n = 0;
    for (const b of this.buildings.values()) {
      if (b.owner === ownerId && b.done && b.def.dropoff) n++;
    }
    return n;
  }

  spawnSpot(b) {
    const cx = b.x, cy = b.y + (b.def.foot[1] / 2) * TILE + 24;
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const r = 20 + Math.random() * 46;
      const x = clampWorld(cx + Math.cos(a) * r);
      const y = clampWorld(cy + Math.sin(a) * r * 0.7);
      if (this.nav.passable(tileIndexAt(x, y))) return [x, y];
    }
    return [clampWorld(cx), clampWorld(cy)];
  }

  // -- combat ----------------------------------------------------------------

  /**
   * Distance from a point to the edge of a tile footprint, zero inside it.
   *
   * Buildings are rectangles, and measuring them as circles from the centre is
   * wrong in the worst place: a worker routed to a diagonal corner tile sits
   * further from the centre than one on a flat side, so a centre-radius test
   * says it has not arrived and it turns around. That was the bug behind
   * peasants walking up to a site and wandering off again.
   */
  footprintDistance(x, y, tx, ty, foot) {
    const x0 = tx * TILE, y0 = ty * TILE;
    const x1 = x0 + foot[0] * TILE, y1 = y0 + foot[1] * TILE;
    const dx = Math.max(x0 - x, 0, x - x1);
    const dy = Math.max(y0 - y, 0, y - y1);
    return Math.hypot(dx, dy);
  }

  /** Surface-to-surface distance between a unit and any entity. */
  surfaceDistance(u, target) {
    if (target.def.foot) {
      return this.footprintDistance(u.x, u.y, target.tx, target.ty, target.def.foot);
    }
    return Math.max(0, Math.hypot(target.x - u.x, target.y - u.y) - target.def.radius);
  }

  /** How close `u` must be, surface to surface, before it can strike. */
  reachDistance(u) {
    return u.def.range + u.def.radius;
  }

  findTarget(u, radius) {
    return this.findTargetNear(u.owner, u.x, u.y, radius);
  }

  /** Nearest hostile unit, or hostile building if no unit is in reach. */
  findTargetNear(ownerId, x, y, radius) {
    let best = null, bestD = radius * radius;
    for (const other of this.near(x, y, radius)) {
      if (other.owner === ownerId || other.hp <= 0) continue;
      const d = (other.x - x) ** 2 + (other.y - y) ** 2;
      if (d < bestD) { bestD = d; best = other; }
    }
    if (best) return best;
    for (const b of this.buildings.values()) {
      if (b.owner === ownerId || b.hp <= 0) continue;
      const d = this.footprintDistance(x, y, b.tx, b.ty, b.def.foot);
      if (d < radius && d * d < bestD) { bestD = d * d; best = b; }
    }
    return best;
  }

  /** Monks look for the most hurt ally in range. */
  tryHeal(u) {
    if (u.cooldown > 0) return false;
    let best = null, worst = 1;
    for (const other of this.near(u.x, u.y, u.def.range)) {
      if (other.owner !== u.owner || other.hp <= 0 || other.id === u.id) continue;
      const frac = other.hp / other.maxHp;
      if (frac < 0.98 && frac < worst) { worst = frac; best = other; }
    }
    if (!best) return false;
    u.targetId = best.id;
    u.cooldown = u.def.cooldown;
    this.setState(u, ST.HEAL);
    return true;
  }

  beginAttack(u, target) {
    if (u.type === 'monk') return;
    u.cooldown = u.def.cooldown;
    u.pendingHit = false;
    this.face(u, target.x, target.y);
    this.setState(u, ST.ATTACK);
  }

  landBlow(u, target) {
    if (!target || target.hp <= 0) return;
    if (u.type === 'archer') {
      this.fireArrow(u, target, u.def.damage);
      return;
    }
    this.damage(target, u.def.damage, u);
    const dx = target.x - u.x, dy = target.y - u.y;
    const isBuilding = !!target.def.foot;
    this.emit(isBuilding ? EV.BUILDING_HIT : EV.MELEE_HIT, {
      id: target.id, x: target.x - dx * 0.25, y: target.y - dy * 0.25, dx, dy,
      w: u.type === 'lancer' ? 1 : 0,
    });
  }

  fireArrow(from, target, damage) {
    const sx = from.x, sy = from.y - (from.def.foot ? 60 : 22);
    this.projectiles.push({
      x: sx, y: sy, ox: sx, oy: sy,
      targetId: target.id, owner: from.owner, damage,
      speed: 620, t: 0,
      dir: Math.atan2(target.y - sy, target.x - sx),
    });
    this.emit(EV.ARROW_FIRE, { x: sx, y: sy, dx: target.x - sx, dy: target.y - sy });
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      const target = this.entity(p.targetId);
      if (!target || target.hp <= 0 || p.t > 4) { this.projectiles.splice(i, 1); continue; }
      const aimY = target.def.foot ? target.y - 30 : target.y - 14;
      const dx = target.x - p.x, dy = aimY - p.y;
      const d = Math.hypot(dx, dy);
      const step = p.speed * dt;
      p.dir = Math.atan2(dy, dx);
      if (d <= step) {
        this.damage(target, p.damage, null);
        const isBuilding = !!target.def.foot;
        this.emit(isBuilding ? EV.BUILDING_HIT : EV.ARROW_HIT,
          { id: target.id, x: target.x, y: aimY, dx, dy, w: 2 });
        this.projectiles.splice(i, 1);
        continue;
      }
      p.x += (dx / d) * step;
      p.y += (dy / d) * step;
    }
  }

  damage(target, amount, attacker) {
    if (target.hp <= 0) return;
    let armor = target.def.armor || 0;
    // A braced Lancer is markedly harder to shift.
    if (target.guarding && target.type === 'lancer') armor += LANCER_GUARD_ARMOR;
    const dealt = Math.max(1, amount - armor);
    target.hp -= dealt;

    if (target.def.foot) {
      target.hitFlash = 0.12;
    } else if (target.st === ST.IDLE && attacker) {
      // Struck out of nowhere: fight back rather than stand there.
      target.targetId = attacker.id;
      this.setState(target, ST.CHASE);
    }

    if (target.hp <= 0) {
      target.hp = 0;
      if (target.def.foot) this.destroyBuilding(target);
      else this.killUnit(target);
    }
  }

  killUnit(u) {
    this.clearWork(u);
    this.emit(EV.UNIT_DIED, { x: u.x, y: u.y, p: u.owner, t: u.type });
    this.units.delete(u.id);
    for (const other of this.units.values()) if (other.targetId === u.id) other.targetId = 0;
    this.recomputePop();
  }

  destroyBuilding(b) {
    this.emit(EV.BUILDING_DIED, {
      id: b.id, x: b.x, y: b.y, p: b.owner, k: b.kind,
      w: b.def.foot[0] * TILE, h: b.def.foot[1] * TILE,
    });
    for (const u of this.units.values()) {
      if (u.buildId === b.id) this.clearWork(u);
      if (u.targetId === b.id) u.targetId = 0;
    }
    this.removeBuilding(b);
  }

  // -- movement --------------------------------------------------------------

  /** @returns {boolean} true once the unit has arrived. */
  followPath(u, dt) {
    if (u.awaitingPath) {
      // Drift toward the goal while the route is still being computed.
      this.stepToward(u, u.goalX, u.goalY, dt, 0.45);
      return false;
    }
    if (!u.path || u.pi >= u.path.length) {
      const d = Math.hypot(u.goalX - u.x, u.goalY - u.y);
      if (d < 16) { u.path = null; return true; }
      // No route: nudge straight at it, and give up if that gets us nowhere.
      this.stepToward(u, u.goalX, u.goalY, dt, 1);
      u.stuckT += dt;
      if (u.stuckT > 1.4) { u.path = null; u.stuckT = 0; return true; }
      return false;
    }

    let [wx, wy] = tileCenter(u.path[u.pi]);
    const last = u.pi === u.path.length - 1;
    if (last) { wx = u.goalX; wy = u.goalY; }

    const d = Math.hypot(wx - u.x, wy - u.y);
    if (d < (last ? 15 : 26)) {
      u.pi++;
      if (u.pi >= u.path.length) { u.path = null; return true; }
      return false;
    }
    this.stepToward(u, wx, wy, dt, 1);

    // Detect a unit wedged against geometry and ask for a fresh route.
    const moved = Math.hypot(u.x - u.lastX, u.y - u.lastY);
    u.lastX = u.x; u.lastY = u.y;
    if (moved < u.def.speed * dt * 0.25) {
      u.stuckT += dt;
      if (u.stuckT > 1.0) {
        u.stuckT = 0;
        this.moveTo(u, u.goalX, u.goalY, 1);
      }
    } else {
      u.stuckT = Math.max(0, u.stuckT - dt);
    }
    return false;
  }

  stepToward(u, x, y, dt, scale) {
    const dx = x - u.x, dy = y - u.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) return;
    const speed = u.def.speed * scale;
    const step = Math.min(d, speed * dt);
    const nx = u.x + (dx / d) * step;
    const ny = u.y + (dy / d) * step;
    // Never let steering push a unit off a cliff or into the sea.
    if (this.walkableAt(nx, ny, u)) { u.x = nx; u.y = ny; }
    else if (this.walkableAt(nx, u.y, u)) u.x = nx;
    else if (this.walkableAt(u.x, ny, u)) u.y = ny;
    u.vx = dx / d; u.vy = dy / d;
    this.face(u, x, y);
  }

  /** A world point is walkable when its tile is dry, in bounds, and clear. */
  walkableAt(x, y, u) {
    if (x < TILE * 0.4 || y < TILE * 0.4) return false;
    if (x > MAP_TILES * TILE - TILE * 0.4 || y > MAP_TILES * TILE - TILE * 0.4) return false;
    const to = tileIndexAt(x, y);
    if (!this.nav.passable(to)) return false;
    const from = tileIndexAt(u.x, u.y);
    if (from === to) return true;
    return this.nav.stepOk(from, to);
  }

  face(u, x, y) {
    const dx = x - u.x, dy = y - u.y;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      u.dir = Math.atan2(dy, dx);
      if (Math.abs(dx) > 1) u.flip = dx < 0;
    }
  }

  /**
   * Soft body separation. Units shoulder each other aside instead of stacking,
   * which is what makes a group read as a crowd rather than one sprite.
   */
  resolveCollisions() {
    const list = [];
    for (const u of this.units.values()) {
      if (u.hp <= 0) continue;
      const r = u.def.radius;
      this.near(u.x, u.y, r * 2 + 16, list);
      for (const other of list) {
        if (other.id <= u.id) continue;
        const dx = other.x - u.x, dy = other.y - u.y;
        const minD = r + other.def.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 < 0.0001) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) * 0.5;
        const nx = dx / d, ny = dy / d;
        // Workers yield to fighters, so a battle line is not jostled apart.
        const uStatic = u.st === ST.GATHER_WORK || u.st === ST.BUILD_WORK || u.st === ST.HOLD;
        const oStatic = other.st === ST.GATHER_WORK || other.st === ST.BUILD_WORK || other.st === ST.HOLD;
        const uw = uStatic && !oStatic ? 0.12 : oStatic && !uStatic ? 0.88 : 0.5;
        this.nudge(u, -nx * push * 2 * uw, -ny * push * 2 * uw);
        this.nudge(other, nx * push * 2 * (1 - uw), ny * push * 2 * (1 - uw));
      }
    }
  }

  nudge(u, dx, dy) {
    const nx = u.x + dx, ny = u.y + dy;
    if (this.walkableAt(nx, ny, u)) { u.x = nx; u.y = ny; return; }
    if (this.walkableAt(nx, u.y, u)) u.x = nx;
    else if (this.walkableAt(u.x, ny, u)) u.y = ny;
  }

  // -- animation -------------------------------------------------------------

  /**
   * The host advances every animation clock and ships the frame index in the
   * snapshot, so all four screens show the identical frame of the identical
   * swing. It costs one byte per unit and removes a whole class of desync.
   */
  advanceAnim(u, dt) {
    const fps = animFps(u);
    u.frame = Math.floor(u.animT * fps) & 0xff;
  }

  // -- victory ---------------------------------------------------------------

  checkVictory() {
    let alive = 0, last = null;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      let hasCastle = false;
      for (const b of this.buildings.values()) {
        if (b.owner === p.id && b.kind === 'castle' && b.hp > 0) { hasCastle = true; break; }
      }
      if (!hasCastle) {
        p.alive = false;
        this.emit(EV.PLAYER_DEFEATED, { p: p.id });
        // Their army goes with them.
        for (const u of [...this.units.values()]) if (u.owner === p.id) this.killUnit(u);
        for (const b of [...this.buildings.values()]) if (b.owner === p.id) this.destroyBuilding(b);
        continue;
      }
      alive++; last = p;
    }
    if (alive <= 1 && this.players.size > 1) {
      this.over = true;
      this.winner = last ? last.id : 0;
      this.emit(EV.GAME_OVER, { p: this.winner });
    }
  }

  /** Drops a player who disconnected: their base falls, the match continues. */
  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.alive) return;
    p.alive = false;
    for (const u of [...this.units.values()]) if (u.owner === playerId) this.killUnit(u);
    for (const b of [...this.buildings.values()]) if (b.owner === playerId) this.destroyBuilding(b);
    this.checkVictory();
  }

  emit(kind, data) { this.events.push({ e: kind, ...data }); }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }
}

// ---------------------------------------------------------------------------

/** Length in seconds of a unit's attack animation. */
function attackDuration(u) {
  switch (u.type) {
    case 'warrior': return 4 / 12;
    case 'lancer': return 3 / 11;
    case 'archer': return 8 / 14;
    default: return 4 / 12;
  }
}

/** Frames per second for whatever the unit is currently doing. */
function animFps(u) {
  switch (u.st) {
    case ST.MOVE: case ST.ATTACK_MOVE: case ST.CHASE: case ST.RETURN:
    case ST.GATHER_GO: case ST.BUILD_GO:
      return 12;
    case ST.ATTACK: return u.type === 'archer' ? 14 : u.type === 'lancer' ? 11 : 12;
    case ST.HEAL: return 12;
    case ST.GATHER_WORK: return 12;
    case ST.BUILD_WORK: return 9;
    default: return 8;
  }
}

function clampWorld(v) {
  return Math.max(TILE * 0.6, Math.min(MAP_TILES * TILE - TILE * 0.6, v));
}

/**
 * Clears a tile's static blocker (a depleted resource node) as well as its
 * dynamic occupancy, so the ground genuinely opens up again.
 */
NavGrid.prototype.setOccupiedRaw = function setOccupiedRaw(tx, ty, on) {
  if (tx < 0 || ty < 0 || tx >= MAP_TILES || ty >= MAP_TILES) return;
  const i = ty * MAP_TILES + tx;
  this.map.blocked[i] = on ? 1 : 0;
  this.occupied[i] = on ? 1 : 0;
  this.version++;
  this.cache.clear();
};
