// A running match.
//
// One class covers both roles. The host owns a `Sim` and steps it on a fixed
// clock, broadcasting a snapshot every other tick; a guest owns no simulation
// at all and simply plays back the snapshot stream, interpolated. Either way
// the renderer is handed the same shape - a `view` of plain entity records -
// so nothing below this file needs to know which peer it is running on.

import { A, COLORS } from './assets.js';
import {
  TICK_DT, SNAPSHOT_EVERY, MAP_TILES, TILE, LEVEL, BUILDINGS, RESOURCES, CMD,
} from './consts.js';
import { Sim, EV } from './sim.js';
import { AI } from './ai.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { Particles } from './particles.js';
import { Hud } from '../ui/hud.js';
import { audio } from './audio.js';
import { MSG, encodeSnapshot, decodeSnapshot } from '../net/protocol.js';

/** How far behind the newest snapshot a guest renders, to hide jitter. */
const INTERP_DELAY = 0.11;

export class Game {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {HTMLElement} opts.hudRoot
   * @param {import('./mapgen.js').GameMap} opts.map
   * @param {Array} opts.players  [{id, name, color, slot, ai, peerId}]
   * @param {number} opts.localPlayerId
   * @param {boolean} opts.isHost
   * @param {import('../net/peer.js').Net|null} opts.net
   * @param {(reason: string) => void} opts.onExit
   */
  constructor(opts) {
    this.canvas = opts.canvas;
    this.map = opts.map;
    this.playerDefs = opts.players;
    this.localPlayerId = opts.localPlayerId;
    this.isHost = opts.isHost;
    this.net = opts.net || null;
    this.onExit = opts.onExit;
    this.difficulty = opts.difficulty || 'normal';

    this.colorOf = new Map(opts.players.map((p) => [p.id, p.color]));
    this.infoOf = new Map(opts.players.map((p) => [p.id, p]));
    /** peerId -> playerId, for attributing incoming commands. */
    this.peerToPlayer = new Map();
    for (const p of opts.players) if (p.peerId) this.peerToPlayer.set(p.peerId, p.id);

    this.fx = new Particles();
    this.renderer = new Renderer(this.canvas, this.map);
    this.hud = new Hud(opts.hudRoot, this);
    this.input = new Input(this.canvas, this.renderer, this);

    this.view = emptyView();
    this.running = true;
    this.paused = false;
    this.accumulator = 0;
    this.lastFrame = performance.now();
    this.snapshotCounter = 0;
    this.nodeShadow = new Map();
    this.burning = new Set();
    this.gameOver = false;

    if (this.isHost) {
      this.sim = new Sim(this.map, opts.players);
      this.ais = opts.players.filter((p) => p.ai)
        .map((p) => new AI(this.sim, p.id, this.difficulty));
      /** Commands queued from guests, applied at the top of the next tick. */
      this.pendingCommands = [];
    } else {
      this.client = new ClientWorld(this.map);
    }

    this.centerOnBase();
    this.bindNet();
    audio.init();
    audio.playMusic('game');
    audio.play('gameStart');
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  // -- networking ------------------------------------------------------------

  bindNet() {
    if (!this.net) return;
    this.onMessage = (e) => this.handleMessage(e.detail.fromId, e.detail.msg);
    this.onBinary = (e) => this.handleBinary(e.detail.buffer);
    this.onPeerClose = (e) => this.handlePeerClose(e.detail.peerId);
    this.onHostGone = () => this.finish('The host left the game.');
    this.net.addEventListener('message', this.onMessage);
    this.net.addEventListener('binary', this.onBinary);
    this.net.addEventListener('peerclose', this.onPeerClose);
    this.net.addEventListener('hostgone', this.onHostGone);
  }

  unbindNet() {
    if (!this.net) return;
    this.net.removeEventListener('message', this.onMessage);
    this.net.removeEventListener('binary', this.onBinary);
    this.net.removeEventListener('peerclose', this.onPeerClose);
    this.net.removeEventListener('hostgone', this.onHostGone);
  }

  handleMessage(fromId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.isHost) {
      if (msg.t === MSG.CMD) {
        // Commands are attributed by connection, never by anything the sender
        // claims, so a guest can only ever move its own army.
        const playerId = this.peerToPlayer.get(fromId);
        if (playerId) this.pendingCommands.push({ cmd: msg.c, playerId });
      }
      return;
    }
    if (msg.t === MSG.EVENTS) {
      for (const ev of msg.e) this.applyEvent(ev);
    } else if (msg.t === MSG.CHAT) {
      this.hud.toast(msg.from + ': ' + msg.text);
    }
  }

  handleBinary(buffer) {
    if (this.isHost || !buffer) return;
    const snap = decodeSnapshot(buffer);
    if (snap) this.client.apply(snap);
  }

  handlePeerClose(peerId) {
    if (!this.isHost) return;
    const playerId = this.peerToPlayer.get(peerId);
    if (!playerId) return;
    this.peerToPlayer.delete(peerId);
    const info = this.infoOf.get(playerId);
    this.hud.toast((info ? info.name : 'A player') + ' left the game.');
    audio.play('playerLeft');
    this.sim.removePlayer(playerId);
  }

  /** Called by input. On the host this applies straight away. */
  sendCommand(cmd) {
    if (this.gameOver) return;
    if (this.isHost) this.sim.applyCommand(cmd, this.localPlayerId);
    else this.net?.sendToHost({ t: MSG.CMD, c: cmd });
  }

  // -- main loop -------------------------------------------------------------

  frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.isHost) this.stepHost(dt);
    else this.client.advance(dt);

    this.buildView();
    this.pruneSelection();
    this.input.update(dt);
    this.fx.update(dt);
    this.syncFires();
    this.breakSurf(dt);

    const cam = this.renderer.camera;
    audio.listener.x = cam.x;
    audio.listener.y = cam.y;
    const v = cam.view();
    audio.listener.halfW = v.hw;
    audio.listener.halfH = v.hh;

    this.renderer.draw(this.view, this.fx, dt, this.localPlayerId);
    this.input.drawOverlay(this.renderer.ctx);
    this.hud.update(this.view, dt);
  }

  stepHost(dt) {
    if (this.paused) return;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 5) {
      this.accumulator -= TICK_DT;
      steps++;

      for (const { cmd, playerId } of this.pendingCommands) this.sim.applyCommand(cmd, playerId);
      this.pendingCommands.length = 0;

      // Remember the pre-step pose so rendering can interpolate between ticks.
      for (const u of this.sim.units.values()) { u.px = u.x; u.py = u.y; }
      for (const p of this.sim.projectiles) { p.px = p.x; p.py = p.y; }

      for (const ai of this.ais) ai.update(TICK_DT);
      this.sim.step(TICK_DT);

      const events = this.sim.drainEvents();
      for (const ev of events) this.applyEvent(ev);
      if (events.length && this.net) this.net.broadcast({ t: MSG.EVENTS, e: events });

      this.snapshotCounter++;
      if (this.net && this.snapshotCounter % SNAPSHOT_EVERY === 0) {
        this.net.broadcast(encodeSnapshot(this.sim, this.nodeShadow));
      }
    }
    this.tickAlpha = Math.max(0, Math.min(1, this.accumulator / TICK_DT));
  }

  // -- view ------------------------------------------------------------------

  /** Assembles the plain-record view the renderer and UI read from. */
  buildView() {
    const v = this.view;
    v.units.length = 0;
    v.buildings.length = 0;
    v.projectiles.length = 0;
    v.nodes.length = 0;
    v.players.length = 0;

    if (this.isHost) {
      const a = this.tickAlpha || 0;
      for (const u of this.sim.units.values()) {
        v.units.push({
          id: u.id, owner: u.owner, type: u.type, colorName: this.colorOf.get(u.owner),
          x: u.px === undefined ? u.x : u.px + (u.x - u.px) * a,
          y: u.py === undefined ? u.y : u.py + (u.y - u.py) * a,
          hp: u.hp, st: u.st, frame: u.frame, dir: u.dir, flip: u.flip,
          carryKind: u.carryKind, guarding: u.guarding, workKind: u.workKind,
        });
      }
      for (const b of this.sim.buildings.values()) {
        v.buildings.push({
          id: b.id, owner: b.owner, kind: b.kind, colorName: this.colorOf.get(b.owner),
          tx: b.tx, ty: b.ty, x: b.x, y: b.y, hp: b.hp,
          done: b.done, variant: b.variant, paused: b.paused,
          produce: b.def.interval
            ? 1 - Math.max(0, Math.min(1, b.spawnT / b.def.interval)) : 0,
          progress: b.def.buildPoints ? Math.min(1, b.progress / b.def.buildPoints) : 1,
        });
      }
      for (const p of this.sim.projectiles) {
        v.projectiles.push({
          x: p.px === undefined ? p.x : p.px + (p.x - p.px) * a,
          y: p.py === undefined ? p.y : p.py + (p.y - p.py) * a,
          dir: p.dir, colorName: this.colorOf.get(p.owner),
        });
      }
      for (const n of this.sim.nodes.values()) v.nodes.push(n);
      for (const p of this.sim.players.values()) {
        v.players.push({ id: p.id, alive: p.alive, pop: p.pop, popCap: p.popCap, res: p.res });
      }
    } else {
      this.client.sample(v, this.colorOf);
    }
    return v;
  }

  /**
   * Occasional surf on a stretch of visible coast. Purely atmosphere, but it
   * keeps the sea from reading as a flat colour behind the island.
   */
  breakSurf(dt) {
    this.surfT = (this.surfT || 0.6) - dt;
    if (this.surfT > 0) return;
    this.surfT = 0.5 + Math.random() * 0.9;
    const tiles = this.renderer.surfTiles;
    if (!tiles.length) return;
    const v = this.renderer.camera.view();
    // A handful of tries rather than a filter pass over the whole coastline.
    for (let attempt = 0; attempt < 8; attempt++) {
      const t = tiles[(Math.random() * tiles.length) | 0];
      if (t.x < v.x0 || t.x > v.x1 || t.y < v.y0 || t.y > v.y1) continue;
      this.fx.splash(t.x, t.y, 0.4 + Math.random() * 0.25);
      return;
    }
  }

  /** Structures below half health burn; the fire follows them until repaired. */
  syncFires() {
    for (const b of this.view.buildings) {
      const def = BUILDINGS[b.kind];
      const hurt = b.done && b.hp < def.hp * 0.5;
      if (hurt) {
        this.fx.igniteBuilding(b.id, b.x, b.y - 20, def.foot[0] * TILE, def.foot[1] * TILE);
        this.burning.add(b.id);
      } else if (this.burning.has(b.id)) {
        this.fx.extinguish(b.id);
        this.burning.delete(b.id);
      }
    }
  }

  // -- events ----------------------------------------------------------------

  applyEvent(ev) {
    const mine = ev.p === this.localPlayerId;
    switch (ev.e) {
      case EV.MELEE_HIT:
        this.fx.impact(ev.x, ev.y, ev.dx, ev.dy, ev.w ? '#cfe9ff' : '#ffe9b0');
        audio.play(ev.w ? 'spearHit' : 'swordHit', ev.x, ev.y);
        break;
      case EV.ARROW_FIRE:
        audio.play('bowShot', ev.x, ev.y);
        break;
      case EV.ARROW_HIT:
        this.fx.impact(ev.x, ev.y, ev.dx, ev.dy, '#ffd9a0');
        audio.play('arrowHit', ev.x, ev.y);
        break;
      case EV.UNIT_DIED:
        this.fx.deathPuff(ev.x, ev.y, tintFor(this.colorOf.get(ev.p)));
        audio.play('unitDeath', ev.x, ev.y);
        break;
      case EV.BUILDING_HIT:
        this.renderer.flashBuilding(ev.id);
        this.fx.impact(ev.x, ev.y, ev.dx, ev.dy, '#e8d9b8');
        audio.play(ev.w === 2 ? 'arrowThunk' : 'structureHit', ev.x, ev.y);
        if (ev.p === undefined) this.maybeAlert(ev);
        break;
      case EV.BUILDING_DIED:
        this.fx.explosion(ev.x, ev.y - 20, true);
        this.fx.dustBurst(ev.x, ev.y, 1.6);
        this.fx.extinguish(ev.id);
        this.burning.delete(ev.id);
        audio.play('buildingDestroyed', ev.x, ev.y);
        break;
      case EV.BUILD_PLACED:
        if (!ev.ok && mine) { audio.play('deny'); this.hud.toast('Cannot build there.', 'danger'); }
        else if (ev.ok) { this.fx.dustBurst(ev.x, ev.y, 1.1); }
        break;
      case EV.BUILD_DONE:
        this.fx.dustBurst(ev.x, ev.y, 1.4);
        audio.play('buildDone', ev.x, ev.y);
        break;
      case EV.UNIT_SPAWNED:
        this.fx.dustBurst(ev.x, ev.y, 0.7);
        if (mine) audio.play('unitReady', ev.x, ev.y);
        break;
      case EV.HAMMER:
        this.fx.spark(ev.x, ev.y, (Math.random() - 0.5) * 90, -130, {
          color: '#e8d9b8', size: 3, life: 0.35, gravity: 500, fade: true,
        });
        audio.play('hammer', ev.x, ev.y);
        break;
      case EV.GATHER_TICK:
        if (ev.k === 'wood') { this.fx.woodChips(ev.x, ev.y - 30); audio.play('chop', ev.x, ev.y); }
        else if (ev.k === 'gold') { this.fx.goldSparks(ev.x, ev.y - 20); audio.play('mine', ev.x, ev.y); }
        else { this.fx.spark(ev.x, ev.y - 16, (Math.random() - 0.5) * 60, -80, { color: '#e08a86', size: 3, life: 0.4, fade: true }); audio.play('butcher', ev.x, ev.y); }
        break;
      case EV.DEPOSIT:
        this.fx.deposit(ev.x, ev.y, ev.k);
        if (mine) {
          this.fx.floatText(ev.x, ev.y - 26, '+' + ev.a, resourceColor(ev.k), 14);
          audio.play('deposit', ev.x, ev.y);
        }
        break;
      case EV.HEAL:
        this.fx.healMotes(ev.x, ev.y);
        this.fx.floatText(ev.x, ev.y - 50, '+' + ev.a, '#9ef7c4', 13);
        audio.play('heal', ev.x, ev.y);
        break;
      case EV.NODE_DEPLETED:
        this.fx.dustBurst(ev.x, ev.y, 0.8);
        break;
      case EV.PLAYER_DEFEATED: {
        const info = this.infoOf.get(ev.p);
        this.hud.toast((info ? info.name : 'A player') + ' has been eliminated.', 'danger');
        // Losing your castle ends your match even though the others fight on.
        if (ev.p === this.localPlayerId && !this.gameOver) {
          this.gameOver = true;
          audio.play('defeat');
          this.hud.showResult(false, 'Your castle has fallen. You can watch the rest play out.');
        }
        break;
      }
      case EV.GAME_OVER:
        this.handleGameOver(ev.p);
        break;
      default:
        break;
    }
  }

  /** Raises the alarm when something of ours is being hit off-screen. */
  maybeAlert(ev) {
    for (const b of this.view.buildings) {
      if (b.id !== ev.id || b.owner !== this.localPlayerId) continue;
      this.hud.alertUnderAttack(b.x, b.y);
      return;
    }
  }

  handleGameOver(winnerId) {
    // A player already shown their defeat still deserves to see who won.
    if (this.gameOver && winnerId !== this.localPlayerId) {
      const info = this.infoOf.get(winnerId);
      this.hud.toast((info ? info.name : 'Nobody') + ' has won the match.');
      return;
    }
    if (this.gameOver) return;
    this.gameOver = true;
    const won = winnerId === this.localPlayerId;
    const info = this.infoOf.get(winnerId);
    audio.play(won ? 'victory' : 'defeat');
    this.hud.showResult(won,
      won ? 'The last castle standing is yours.'
        : (info ? info.name + ' holds the last castle.' : 'No one is left standing.'));
  }

  // -- queries used by input and HUD -----------------------------------------

  myPlayer() {
    return this.view.players.find((p) => p.id === this.localPlayerId) || null;
  }
  myColor() { return this.colorOf.get(this.localPlayerId) || COLORS[0]; }
  playerInfo(id) { return this.infoOf.get(id) || null; }

  canAfford(cost) {
    const me = this.myPlayer();
    if (!me) return false;
    return RESOURCES.every((r) => (me.res[r] || 0) >= (cost[r] || 0));
  }

  /**
   * Client-side check for the placement ghost. The host re-validates before
   * anything is actually built, so this only has to be close enough to give
   * honest feedback under the cursor.
   */
  footprintLooksFree(tx, ty, foot) {
    if (tx < 1 || ty < 1 || tx + foot[0] >= MAP_TILES || ty + foot[1] >= MAP_TILES) return false;
    for (let y = 0; y < foot[1]; y++) {
      for (let x = 0; x < foot[0]; x++) {
        const i = (ty + y) * MAP_TILES + (tx + x);
        if (this.map.level[i] === LEVEL.WATER) return false;
        if (this.map.blocked[i]) return false;
      }
    }
    for (const b of this.view.buildings) {
      const def = BUILDINGS[b.kind];
      if (tx < b.tx + def.foot[0] && tx + foot[0] > b.tx
        && ty < b.ty + def.foot[1] && ty + foot[1] > b.ty) return false;
    }
    return true;
  }

  onSelectionChanged() {
    this.hud.showSelection(this.selectedEntities());
  }

  selectedEntities() {
    const sel = [];
    for (const u of this.view.units) if (this.renderer.selection.has(u.id)) sel.push(u);
    for (const b of this.view.buildings) if (this.renderer.selection.has(b.id)) sel.push(b);
    return sel;
  }

  /**
   * Drops anything that has died out of the selection and keeps the readout in
   * step, so the panel never describes a unit that is no longer on the field.
   */
  pruneSelection() {
    const selection = this.renderer.selection;
    if (!selection.size) return;
    const alive = this.selectedEntities();
    if (alive.length !== selection.size) {
      selection.clear();
      for (const e of alive) selection.add(e.id);
      this.hud.showSelection(alive);
      return;
    }
    this.hud.refreshSelection(alive);
  }

  centerOnBase() {
    const cam = this.renderer.camera;
    const info = this.infoOf.get(this.localPlayerId);
    const slot = info ? info.slot : 0;
    const start = this.map.starts[slot];
    cam.x = start.x;
    cam.y = start.y;
    cam.clamp();
  }

  /** Halts or resumes training at every producing building selected. */
  toggleProduction() {
    for (const b of this.view.buildings) {
      if (!this.renderer.selection.has(b.id) || b.owner !== this.localPlayerId) continue;
      if (!BUILDINGS[b.kind].spawns || !b.done) continue;
      this.sendCommand({ t: CMD.TOGGLE_PRODUCTION, id: b.id, on: !b.paused });
    }
  }

  /**
   * Pulls down every owned building in the selection. The HUD arms this behind
   * a confirmation, because there is no undo for it.
   */
  demolishSelected() {
    for (const b of this.view.buildings) {
      if (!this.renderer.selection.has(b.id) || b.owner !== this.localPlayerId) continue;
      if (b.kind === 'castle') continue;
      this.sendCommand({ t: CMD.DEMOLISH, id: b.id });
    }
  }

  toggleMenu() {
    const existing = document.getElementById('pauseOverlay');
    if (existing) { existing.remove(); return; }
    const el = document.createElement('div');
    el.id = 'pauseOverlay';
    el.innerHTML = `
      <div class="pause-card special-panel">
        <div class="pause-title">Swordcraft</div>
        <div class="pause-help">
          <div><b>Left drag</b> select  ·  <b>Right click</b> move / attack / gather</div>
          <div><b>A</b> attack-move  ·  <b>S</b> stop  ·  <b>G</b> hold ground  ·  <b>Tab</b> select army</div>
          <div><b>H O B R T M</b> house / outpost / barracks / range / tower / monastery</div>
          <div><b>Y</b> set rally  ·  <b>P</b> halt or resume training  ·  <b>F</b> centre on selection</div>
          <div><b>Space</b> centre on base  ·  <b>Delete</b> cancel construction</div>
          <div><b>Ctrl+1-9</b> make group  ·  <b>1-9</b> recall group</div>
          <div><b>Arrows / screen edge / middle drag</b> pan  ·  <b>Wheel</b> zoom</div>
        </div>
        <p class="pause-note">Music and effect levels are on the gear button in the corner.</p>
        <div class="pause-actions">
          <button class="pixel-btn" id="pauseResume">Resume</button>
          <button class="pixel-btn danger" id="pauseQuit">Leave match</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#pauseResume').addEventListener('click', () => { audio.play('click'); el.remove(); });
    el.querySelector('#pauseQuit').addEventListener('click', () => { audio.play('click'); this.quitToMenu(); });
  }

  quitToMenu() { this.finish(null); }

  finish(reason) {
    if (!this.running) return;
    this.running = false;
    this.unbindNet();
    this.fx.clear();
    document.getElementById('pauseOverlay')?.remove();
    document.getElementById('resultOverlay')?.remove();
    this.onExit(reason);
  }
}

// ---------------------------------------------------------------------------

/** Snapshot playback for a guest. */
class ClientWorld {
  constructor(map) {
    this.map = map;
    this.prev = null;
    this.curr = null;
    this.prevAt = 0;
    this.currAt = 0;
    this.clock = 0;
    this.nodes = new Map();
    for (const n of map.nodes) this.nodes.set(n.id, { ...n });
  }

  apply(snap) {
    this.prev = this.curr;
    this.prevAt = this.currAt;
    this.curr = snap;
    this.currAt = this.clock;
    if (!this.prev) { this.prev = snap; this.prevAt = this.clock - 0.1; }
    for (const n of snap.nodes) {
      const node = this.nodes.get(n.id);
      if (!node) continue;
      node.amount = n.amount;
      // The host frees the tile when a seam runs dry; mirror that locally so a
      // guest's build-placement preview agrees with what the host will accept.
      if (n.amount <= 0) this.map.blocked[node.ty * MAP_TILES + node.tx] = 0;
    }
  }

  advance(dt) { this.clock += dt; }

  /** Fills `v` with entities interpolated to a moment slightly in the past. */
  sample(v, colorOf) {
    if (!this.curr) return;
    const target = this.clock - INTERP_DELAY;
    const span = Math.max(0.001, this.currAt - this.prevAt);
    const a = Math.max(0, Math.min(1, (target - this.prevAt) / span));

    const prevUnits = new Map();
    if (this.prev) for (const u of this.prev.units) prevUnits.set(u.id, u);

    for (const u of this.curr.units) {
      const p = prevUnits.get(u.id);
      v.units.push({
        ...u,
        colorName: colorOf.get(u.owner),
        x: p ? p.x + (u.x - p.x) * a : u.x,
        y: p ? p.y + (u.y - p.y) * a : u.y,
      });
    }
    for (const b of this.curr.buildings) {
      v.buildings.push({
        ...b,
        colorName: colorOf.get(b.owner),
        x: (b.tx + BUILDINGS[b.kind].foot[0] / 2) * TILE,
        y: (b.ty + BUILDINGS[b.kind].foot[1] / 2) * TILE,
      });
    }
    for (const p of this.curr.projectiles) {
      v.projectiles.push({ ...p, colorName: colorOf.get(p.owner) });
    }
    for (const n of this.nodes.values()) v.nodes.push(n);
    for (const p of this.curr.players) v.players.push(p);
  }
}

function emptyView() {
  return { units: [], buildings: [], projectiles: [], nodes: [], players: [] };
}

function tintFor(color) {
  return { Blue: '#8fd3ea', Red: '#eda19b', Yellow: '#ebe19b', Purple: '#d3b7e6' }[color] || '#cfd8dc';
}

function resourceColor(kind) {
  return kind === 'gold' ? '#ffd54a' : '#c9a06a';
}
