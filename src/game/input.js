// Mouse and keyboard.
//
// Selection and camera work are entirely local and instant; only the resulting
// orders travel over the wire. That is what keeps the game feeling responsive
// on a connection with real latency - the box you drag and the units that light
// up are yours immediately, and the march order catches up a moment later.

import { CMD, BUILDINGS, UNITS, TILE, CAMERA } from './consts.js';
import { audio } from './audio.js';
import { cursor } from '../ui/skin.js';

/** Maps a printable key to the physical code the bindings are written in. */
function keyToCode(key) {
  if (!key) return '';
  if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return 'Digit' + key;
  if (key === ' ') return 'Space';
  return key.length > 1 ? key : '';
}

/** Below this drag distance a press counts as a click, not a box select. */
const DRAG_THRESHOLD = 6;
const DOUBLE_CLICK_MS = 320;

export class Input {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./render.js').Renderer} renderer
   * @param {object} game  needs sendCommand(), view, localPlayerId, fx, hud
   */
  constructor(canvas, renderer, game) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.camera = renderer.camera;
    this.game = game;

    this.selection = renderer.selection;
    this.groups = new Map();

    this.mouse = { x: 0, y: 0, wx: 0, wy: 0, inside: false };
    this.drag = null;
    this.panning = null;
    this.keys = new Set();
    this.mode = 'normal';        // 'normal' | 'attackMove' | 'place' | 'rally'
    this.placeKind = null;
    this.lastClickAt = 0;
    this.lastClickId = 0;
    this.edgeScroll = true;
    this.cursorValue = '';

    this.bind();
    this.refreshCursor();
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mouseenter', () => { this.mouse.inside = true; });
    c.addEventListener('mouseleave', () => { this.mouse.inside = false; });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code || keyToCode(e.key)));
    window.addEventListener('blur', () => { this.keys.clear(); this.panning = null; this.drag = null; });
  }

  get view() { return this.game.view; }
  get me() { return this.game.localPlayerId; }

  // -- pointer ---------------------------------------------------------------

  updateMouseWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - r.left;
    this.mouse.y = e.clientY - r.top;
    const [wx, wy] = this.camera.screenToWorld(this.mouse.x, this.mouse.y);
    this.mouse.wx = wx;
    this.mouse.wy = wy;
  }

  onMouseDown(e) {
    this.updateMouseWorld(e);
    audio.init();

    if (e.button === 1) {
      e.preventDefault();
      this.panning = { sx: this.mouse.x, sy: this.mouse.y, cx: this.camera.x, cy: this.camera.y };
      return;
    }

    if (e.button === 2) {
      if (this.mode !== 'normal') { this.setMode('normal'); return; }
      this.issueContextOrder(e);
      return;
    }

    if (e.button !== 0) return;

    if (this.mode === 'place') { this.tryPlace(e); return; }
    if (this.mode === 'attackMove') { this.issueAttackMove(); this.setMode('normal'); return; }
    if (this.mode === 'rally') { this.issueRally(); this.setMode('normal'); return; }

    this.drag = { sx: this.mouse.x, sy: this.mouse.y, x: this.mouse.x, y: this.mouse.y, moved: false };
  }

  onMouseMove(e) {
    this.updateMouseWorld(e);
    if (this.panning) {
      this.camera.x = this.panning.cx - (this.mouse.x - this.panning.sx) / this.camera.zoom;
      this.camera.y = this.panning.cy - (this.mouse.y - this.panning.sy) / this.camera.zoom;
      this.camera.clamp();
    }
    if (this.drag) {
      this.drag.x = this.mouse.x;
      this.drag.y = this.mouse.y;
      if (Math.hypot(this.drag.x - this.drag.sx, this.drag.y - this.drag.sy) > DRAG_THRESHOLD) {
        this.drag.moved = true;
      }
    }
    this.renderer.hoverId = this.pickEntity(this.mouse.wx, this.mouse.wy)?.id || 0;
    if (this.mode === 'place') this.updatePlacementGhost();
  }

  onMouseUp(e) {
    if (e.button === 1) { this.panning = null; return; }
    if (e.button !== 0 || !this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.moved) this.boxSelect(drag, e.shiftKey);
    else this.clickSelect(e);
  }

  onWheel(e) {
    e.preventDefault();
    const before = this.camera.screenToWorld(this.mouse.x, this.mouse.y);
    const factor = Math.exp(-e.deltaY * 0.0014);
    this.camera.zoom = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, this.camera.zoom * factor));
    // Keep the world point under the cursor pinned while zooming.
    const after = this.camera.screenToWorld(this.mouse.x, this.mouse.y);
    this.camera.x += before[0] - after[0];
    this.camera.y += before[1] - after[1];
    this.camera.clamp();
  }

  // -- selection -------------------------------------------------------------

  /** Nearest unit, else building, under a world point. */
  pickEntity(wx, wy) {
    let best = null, bestD = Infinity;
    for (const u of this.view.units) {
      const r = UNITS[u.type].radius + 10;
      const d = (u.x - wx) ** 2 + (u.y - wy - 12) ** 2;
      if (d < r * r && d < bestD) { bestD = d; best = u; }
    }
    if (best) return best;
    for (const b of this.view.buildings) {
      const def = BUILDINGS[b.kind];
      const x0 = b.tx * TILE, y0 = b.ty * TILE;
      if (wx >= x0 && wy >= y0 && wx < x0 + def.foot[0] * TILE && wy < y0 + def.foot[1] * TILE) return b;
    }
    return null;
  }

  clickSelect(e) {
    const hit = this.pickEntity(this.mouse.wx, this.mouse.wy);
    const now = performance.now();
    const isDouble = hit && hit.id === this.lastClickId && now - this.lastClickAt < DOUBLE_CLICK_MS;
    this.lastClickAt = now;
    this.lastClickId = hit ? hit.id : 0;

    if (!hit) {
      if (!e.shiftKey) this.setSelection([]);
      return;
    }
    // Double-click grabs every visible unit of the same type you own.
    if (isDouble && hit.type && hit.owner === this.me) {
      const vis = this.camera.view();
      const same = this.view.units.filter((u) => u.owner === this.me && u.type === hit.type
        && u.x > vis.x0 && u.x < vis.x1 && u.y > vis.y0 && u.y < vis.y1);
      this.setSelection(same.map((u) => u.id));
      return;
    }
    if (e.shiftKey) {
      if (this.selection.has(hit.id)) this.selection.delete(hit.id);
      else this.selection.add(hit.id);
      this.game.onSelectionChanged();
      return;
    }
    this.setSelection([hit.id]);
  }

  boxSelect(drag, additive) {
    const [ax, ay] = this.camera.screenToWorld(Math.min(drag.sx, drag.x), Math.min(drag.sy, drag.y));
    const [bx, by] = this.camera.screenToWorld(Math.max(drag.sx, drag.x), Math.max(drag.sy, drag.y));
    const own = [];
    const other = [];
    for (const u of this.view.units) {
      if (u.x < ax || u.x > bx || u.y < ay || u.y > by) continue;
      (u.owner === this.me ? own : other).push(u.id);
    }
    // Your own troops always win a mixed box; you rarely mean to grab theirs.
    let picked = own.length ? own : other;
    if (!picked.length) {
      for (const b of this.view.buildings) {
        const def = BUILDINGS[b.kind];
        const cx = (b.tx + def.foot[0] / 2) * TILE, cy = (b.ty + def.foot[1] / 2) * TILE;
        if (cx >= ax && cx <= bx && cy >= ay && cy <= by && b.owner === this.me) { picked = [b.id]; break; }
      }
    }
    if (additive) {
      for (const id of picked) this.selection.add(id);
      this.game.onSelectionChanged();
      if (picked.length) audio.play('select');
    } else {
      this.setSelection(picked);
    }
  }

  setSelection(ids) {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.game.onSelectionChanged();
    if (ids.length) audio.play('select');
  }

  /** Selected entities that are actually ours and still alive. */
  ownSelected() {
    const out = [];
    for (const u of this.view.units) if (this.selection.has(u.id) && u.owner === this.me) out.push(u);
    return out;
  }

  ownSelectedBuildings() {
    const out = [];
    for (const b of this.view.buildings) if (this.selection.has(b.id) && b.owner === this.me) out.push(b);
    return out;
  }

  // -- orders ----------------------------------------------------------------

  issueContextOrder() {
    const units = this.ownSelected();
    const buildings = this.ownSelectedBuildings();

    // Right-clicking with only a production building selected sets its rally.
    if (!units.length && buildings.length) {
      for (const b of buildings) {
        this.game.sendCommand({ t: CMD.RALLY, id: b.id, x: this.mouse.wx, y: this.mouse.wy });
      }
      this.game.fx.moveMarker(this.mouse.wx, this.mouse.wy, 'rgba(255,235,150,0.9)');
      audio.play('order');
      return;
    }
    if (!units.length) return;

    const hit = this.pickEntity(this.mouse.wx, this.mouse.wy);
    if (hit && hit.owner !== this.me && hit.owner !== 0) {
      this.game.sendCommand({ t: CMD.ATTACK, u: units.map((u) => u.id), id: hit.id });
      this.game.fx.moveMarker(hit.x, hit.y, 'rgba(255,120,110,0.95)');
      audio.play('orderAttack');
      return;
    }

    const node = this.pickNode(this.mouse.wx, this.mouse.wy);
    const pawns = units.filter((u) => u.type === 'pawn');
    if (node && pawns.length) {
      this.game.sendCommand({ t: CMD.GATHER, u: pawns.map((u) => u.id), id: node.id });
      this.game.fx.moveMarker(node.x, node.y, 'rgba(150,230,255,0.9)');
      audio.play('order');
      const rest = units.filter((u) => u.type !== 'pawn');
      if (rest.length) {
        this.game.sendCommand({ t: CMD.MOVE, u: rest.map((u) => u.id), x: this.mouse.wx, y: this.mouse.wy });
      }
      return;
    }

    this.game.sendCommand({ t: CMD.MOVE, u: units.map((u) => u.id), x: this.mouse.wx, y: this.mouse.wy });
    this.game.fx.moveMarker(this.mouse.wx, this.mouse.wy, 'rgba(150,255,170,0.9)');
    audio.play('order');
  }

  pickNode(wx, wy) {
    for (const n of this.view.nodes) {
      if (n.amount <= 0) continue;
      if (Math.abs(n.x - wx) < TILE * 0.6 && Math.abs(n.y - wy) < TILE * 0.6) return n;
    }
    return null;
  }

  issueAttackMove() {
    const units = this.ownSelected();
    if (!units.length) return;
    this.game.sendCommand({ t: CMD.ATTACK_MOVE, u: units.map((u) => u.id), x: this.mouse.wx, y: this.mouse.wy });
    this.game.fx.moveMarker(this.mouse.wx, this.mouse.wy, 'rgba(255,120,110,0.95)');
    audio.play('orderAttack');
  }

  issueRally() {
    for (const b of this.ownSelectedBuildings()) {
      this.game.sendCommand({ t: CMD.RALLY, id: b.id, x: this.mouse.wx, y: this.mouse.wy });
    }
    this.game.fx.moveMarker(this.mouse.wx, this.mouse.wy, 'rgba(255,235,150,0.9)');
  }

  // -- building placement ----------------------------------------------------

  beginPlacement(kind) {
    const def = BUILDINGS[kind];
    if (!def) return;
    const player = this.game.myPlayer();
    if (player && !this.game.canAfford(def.cost)) { audio.play('deny'); this.game.hud.flashCost(kind); return; }
    this.placeKind = kind;
    this.setMode('place');
    this.updatePlacementGhost();
  }

  updatePlacementGhost() {
    const def = BUILDINGS[this.placeKind];
    if (!def) return;
    // Centre the footprint on the cursor.
    const tx = Math.round(this.mouse.wx / TILE - def.foot[0] / 2);
    const ty = Math.round(this.mouse.wy / TILE - def.foot[1] / 2);
    this.renderer.placing = {
      kind: this.placeKind, tx, ty,
      color: this.game.myColor(),
      valid: this.game.footprintLooksFree(tx, ty, def.foot),
    };
  }

  tryPlace(e) {
    const p = this.renderer.placing;
    if (!p) return;
    if (!p.valid || !this.game.canAfford(BUILDINGS[p.kind].cost)) { audio.play('deny'); return; }
    const pawns = this.ownSelected().filter((u) => u.type === 'pawn').map((u) => u.id);
    this.game.sendCommand({ t: CMD.BUILD, kind: p.kind, tx: p.tx, ty: p.ty, u: pawns });
    audio.play('buildStart', (p.tx + 1) * TILE, (p.ty + 1) * TILE);
    // Shift keeps the tool up for laying down a row of the same thing.
    if (!e.shiftKey) this.setMode('normal');
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'place') { this.renderer.placing = null; this.placeKind = null; }
    this.game.hud.setMode(mode);
    this.refreshCursor();
  }

  /** The pack's own pointer art, switched to suit the current tool. */
  refreshCursor() {
    let art = 'arrow';
    if (this.mode === 'attackMove' || this.mode === 'rally') art = 'hand';
    else if (this.mode === 'place') {
      art = this.renderer.placing && this.renderer.placing.valid ? 'hand' : 'deny';
    }
    const next = cursor(art, this.mode === 'normal' ? 'default' : 'crosshair');
    if (next !== this.cursorValue) {
      this.cursorValue = next;
      this.canvas.style.cursor = next;
    }
  }

  // -- keyboard --------------------------------------------------------------

  onKeyDown(e) {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    // `code` is layout-independent and is what the bindings below use, but
    // fall back to `key` for input sources that only report the character.
    const code = e.code || keyToCode(e.key);
    this.keys.add(code);
    audio.init();

    if (code === 'Escape') {
      if (this.mode !== 'normal') this.setMode('normal');
      else this.game.toggleMenu();
      e.preventDefault();
      return;
    }

    // Control groups.
    if (/^Digit[1-9]$/.test(code)) {
      const slot = code.slice(5);
      if (e.ctrlKey || e.metaKey) {
        this.groups.set(slot, [...this.selection]);
        this.game.hud.toast('Group ' + slot + ' set');
      } else {
        const ids = this.groups.get(slot);
        if (ids && ids.length) {
          const live = new Set([...this.view.units, ...this.view.buildings].map((x) => x.id));
          this.setSelection(ids.filter((id) => live.has(id)));
          if (e.repeat === false && this.selection.size) this.centerOnSelection();
        }
      }
      e.preventDefault();
      return;
    }

    switch (code) {
      case 'KeyA':
        if (this.ownSelected().length) { this.setMode('attackMove'); }
        break;
      case 'KeyS':
        this.sendToSelected({ t: CMD.STOP });
        break;
      case 'KeyG':
        this.sendToSelected({ t: CMD.HOLD });
        break;
      case 'KeyH': this.beginPlacement('house'); break;
      case 'KeyO': this.beginPlacement('outpost'); break;
      case 'KeyB': this.beginPlacement('barracks'); break;
      case 'KeyR': this.beginPlacement('archery'); break;
      case 'KeyT': this.beginPlacement('tower'); break;
      case 'KeyM': this.beginPlacement('monastery'); break;
      case 'KeyY': // rally point for selected buildings
        if (this.ownSelectedBuildings().length) this.setMode('rally');
        break;
      case 'KeyP': this.game.toggleProduction(); break;
      case 'KeyF': this.centerOnSelection(); break;
      case 'Space': this.game.centerOnBase(); e.preventDefault(); break;
      case 'Tab': this.selectAllArmy(); e.preventDefault(); break;
      case 'Delete': this.cancelSelectedConstruction(); break;
      default: break;
    }
  }

  sendToSelected(cmd) {
    const units = this.ownSelected();
    if (!units.length) return;
    this.game.sendCommand({ ...cmd, u: units.map((u) => u.id) });
    audio.play('order');
  }

  selectAllArmy() {
    const ids = this.view.units
      .filter((u) => u.owner === this.me && u.type !== 'pawn')
      .map((u) => u.id);
    this.setSelection(ids);
  }

  cancelSelectedConstruction() {
    for (const b of this.ownSelectedBuildings()) {
      if (!b.done) this.game.sendCommand({ t: CMD.CANCEL_BUILD, id: b.id });
    }
  }

  centerOnSelection() {
    let n = 0, sx = 0, sy = 0;
    for (const u of this.view.units) if (this.selection.has(u.id)) { sx += u.x; sy += u.y; n++; }
    for (const b of this.view.buildings) if (this.selection.has(b.id)) { sx += b.x; sy += b.y; n++; }
    if (!n) return;
    this.camera.x = sx / n;
    this.camera.y = sy / n;
    this.camera.clamp();
  }

  // -- per-frame -------------------------------------------------------------

  update(dt) {
    const cam = this.camera;
    // Camera keys are the arrows only. Letters are reserved for orders, which
    // is what keeps A for attack-move and S for stop unambiguous.
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('ArrowDown')) dy += 1;
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    let speed = CAMERA.panSpeed;

    if (!dx && !dy && this.edgeScroll && this.mouse.inside && !this.panning && !this.drag) {
      const m = CAMERA.edgeMargin;
      if (this.mouse.x < m) dx -= 1;
      else if (this.mouse.x > cam.vw - m) dx += 1;
      if (this.mouse.y < m) dy -= 1;
      else if (this.mouse.y > cam.vh - m) dy += 1;
      speed = CAMERA.edgeSpeed;
    }

    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      const step = (speed / cam.zoom) * dt;
      cam.x += (dx / len) * step;
      cam.y += (dy / len) * step;
      cam.clamp();
    }
    if (this.mode === 'place') this.updatePlacementGhost();
    this.refreshCursor();
  }

  /** Draws the drag rectangle. Called after the world transform is popped. */
  drawOverlay(ctx) {
    if (!this.drag || !this.drag.moved) return;
    const x = Math.min(this.drag.sx, this.drag.x);
    const y = Math.min(this.drag.sy, this.drag.y);
    const w = Math.abs(this.drag.x - this.drag.sx);
    const h = Math.abs(this.drag.y - this.drag.sy);
    ctx.save();
    ctx.strokeStyle = 'rgba(160,255,180,0.95)';
    ctx.fillStyle = 'rgba(160,255,180,0.13)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  }
}
