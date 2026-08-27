// World renderer.
//
// The terrain is static once a map is generated, so it is baked into 1024px
// chunk canvases at load time and blitted a handful at a time. Everything that
// moves - water foam, resource nodes, units, buildings, projectiles, particles
// - is drawn live and depth-sorted by its ground y, which is what sells the
// three-quarter view.
//
// Tile art comes from the Tiny Swords tilemap, whose first 4x4 block is a
// "blob" autotile set: a 3x3 nine-slice plus narrow single-width variants
// along the fourth row and column.

import { A, drawFrame, frameAt, COLOR_HEX, COLORS } from './assets.js';
import { TILE, MAP_TILES, LEVEL, UNITS, BUILDINGS, ST, CAMERA } from './consts.js';

/** The largest share of the map, per axis, the camera may ever show. */
export const MAX_VIEW_FRACTION = 0.5;

const CHUNK = 16;                    // tiles per baked chunk
const CHUNK_PX = CHUNK * TILE;
const CHUNKS = Math.ceil(MAP_TILES / CHUNK);

/** Column offset of the ground blob set inside Tilemap_colorN.png. */
const GROUND_SET_X = 0;

/** Tool_01 is the wooden mallet; the rest of that sheet is axe, sword, pick. */
const MALLET = 0;

/** The tool a peasant swings at each kind of resource, and holds walking to it. */
const TOOL_WORK = { wood: 'chop', gold: 'mine' };
const TOOL_HOLD = { wood: 'Axe', gold: 'Pickaxe' };

/** Where a unit's feet sit relative to its frame centre, before scaling. */
const FOOT_OFFSET = { peasant: 39, warrior: 41, archer: 40, monk: 38, lancer: 40 };
/** Where a building's base sits relative to the bottom of its sprite. */
const BUILDING_BASE = {
  castle: 249, barracks: 245, archery: 240, monastery: 310, tower: 230,
  house1: 173, house2: 173, house3: 173,
};

export class Camera {
  constructor() {
    this.x = 0; this.y = 0;
    this.zoom = CAMERA.startZoom;
    this.vw = 1; this.vh = 1;
  }
  /** Visible world rectangle. */
  view() {
    const hw = this.vw / (2 * this.zoom), hh = this.vh / (2 * this.zoom);
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh, hw, hh };
  }
  /**
   * The furthest out the camera may pull. Seeing the whole island at once
   * turns the game into a spreadsheet, so the view is capped at half the map
   * on each axis - which means the floor depends on the window size.
   */
  minZoom() {
    const half = (MAP_TILES * TILE) * MAX_VIEW_FRACTION;
    return Math.max(CAMERA.minZoom, this.vw / half, this.vh / half);
  }

  clampZoom() {
    this.zoom = Math.max(this.minZoom(), Math.min(CAMERA.maxZoom, this.zoom));
  }

  clamp() {
    this.clampZoom();
    const { hw, hh } = this.view();
    const w = MAP_TILES * TILE;
    // When the map is smaller than the viewport on an axis, centre on it.
    this.x = hw * 2 >= w ? w / 2 : Math.max(hw, Math.min(w - hw, this.x));
    this.y = hh * 2 >= w ? w / 2 : Math.max(hh, Math.min(w - hh, this.y));
  }
  screenToWorld(sx, sy) {
    return [this.x + (sx - this.vw / 2) / this.zoom, this.y + (sy - this.vh / 2) / this.zoom];
  }
  worldToScreen(wx, wy) {
    return [(wx - this.x) * this.zoom + this.vw / 2, (wy - this.y) * this.zoom + this.vh / 2];
  }
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./mapgen.js').GameMap} map
   */
  constructor(canvas, map) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.map = map;
    this.camera = new Camera();
    this.chunks = [];
    this.shoreTiles = [];
    /** Water tiles that touch land; ambient surf breaks on these. */
    this.surfTiles = [];
    this.minimap = null;
    this.waterColor = '#1c6c86';
    this.time = 0;
    this.hoverId = 0;
    /** A resource node under the cursor, when no unit or building is. */
    this.hoverNode = null;
    /** Set by input: {kind, tx, ty, valid} while a building is being sited. */
    this.placing = null;
    this.selection = new Set();
    /** Building id -> time until which it flashes from a hit. */
    this.flash = new Map();
    this.bakeTerrain();
  }

  // -- terrain baking --------------------------------------------------------

  tileset() { return A.terrain.tileset[this.map.tileset % A.terrain.tileset.length]; }

  level(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= MAP_TILES || ty >= MAP_TILES) return LEVEL.WATER;
    return this.map.level[ty * MAP_TILES + tx];
  }
  isLand(tx, ty) { return this.level(tx, ty) !== LEVEL.WATER; }

  /**
   * Picks a tile from the 4x4 blob set. Columns 0-2 are the left edge, middle
   * and right edge; column 3 is the narrow one-tile-wide variant. Rows work
   * the same way vertically, so (column, row) covers all sixteen cases.
   */
  blobTile(tx, ty) {
    const n = this.isLand(tx, ty - 1), s = this.isLand(tx, ty + 1);
    const w = this.isLand(tx - 1, ty), e = this.isLand(tx + 1, ty);
    const col = (w && e) ? 1 : e ? 0 : w ? 2 : 3;
    const row = (n && s) ? 1 : s ? 0 : n ? 2 : 3;
    return [col, row];
  }

  bakeTerrain() {
    const ts = this.tileset();
    this.waterColor = sampleColor(A.terrain.water.img);

    for (let cy = 0; cy < CHUNKS; cy++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const cv = document.createElement('canvas');
        cv.width = CHUNK_PX; cv.height = CHUNK_PX;
        const c = cv.getContext('2d');
        c.imageSmoothingEnabled = false;
        // Chunks stay transparent over water so the surf can show beneath them.
        for (let ty = cy * CHUNK; ty < Math.min(MAP_TILES, (cy + 1) * CHUNK); ty++) {
          for (let tx = cx * CHUNK; tx < Math.min(MAP_TILES, (cx + 1) * CHUNK); tx++) {
            if (!this.isLand(tx, ty)) continue;
            const [col, row] = this.blobTile(tx, ty);
            c.drawImage(ts.img, (GROUND_SET_X + col) * TILE, row * TILE, TILE, TILE,
              (tx - cx * CHUNK) * TILE, (ty - cy * CHUNK) * TILE, TILE, TILE);
          }
        }
        this.chunks.push({ cx, cy, canvas: cv });
      }
    }

    // Shore tiles get animated foam; the water side of the same edge gets surf.
    for (let ty = 0; ty < MAP_TILES; ty++) {
      for (let tx = 0; tx < MAP_TILES; tx++) {
        if (!this.isLand(tx, ty)) continue;
        let coastal = false;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (this.isLand(tx + ox, ty + oy)) continue;
          coastal = true;
          this.surfTiles.push({ x: (tx + ox + 0.5) * TILE, y: (ty + oy + 0.5) * TILE });
        }
        if (coastal) {
          this.shoreTiles.push({
            x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE,
            phase: ((tx * 5 + ty * 11) % 16) / 8,
          });
        }
      }
    }

    const cv = document.createElement('canvas');
    paintMinimap(this.map, cv);
    this.minimap = cv;
  }

  /** Called when a hit event arrives, so the structure blinks. */
  flashBuilding(id) { this.flash.set(id, this.time + 0.12); }

  // -- frame -----------------------------------------------------------------

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.dpr = dpr;
    this.camera.vw = w;
    this.camera.vh = h;
    // The zoom floor is derived from the viewport, which is not known until
    // now - so without this the first frames render further out than the rules
    // allow and only snap in once something moves the camera.
    this.camera.clamp();
  }

  /**
   * @param {object} view      entity view for this frame
   * @param {import('./particles.js').Particles} fx
   * @param {number} dt
   * @param {number} localPlayerId
   */
  draw(view, fx, dt, localPlayerId) {
    this.time += dt;
    const ctx = this.ctx;
    const cam = this.camera;
    this.resize();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this.waterColor;
    ctx.fillRect(0, 0, cam.vw, cam.vh);

    ctx.save();
    ctx.translate(cam.vw / 2, cam.vh / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
    const vis = cam.view();

    this.drawFoam(ctx, vis);
    this.drawChunks(ctx, vis);
    this.drawWaterDecor(ctx, vis);
    fx.drawGround(ctx, vis);
    this.drawSelectionRings(ctx, vis, view, localPlayerId);
    this.drawSorted(ctx, vis, view, localPlayerId);
    this.drawHoverReticle(ctx, view);
    this.drawProjectiles(ctx, vis, view);
    fx.drawTop(ctx, vis, this.time);
    this.drawBars(ctx, vis, view);
    this.drawPlacement(ctx);
    this.drawClouds(ctx, vis);

    ctx.restore();
  }

  drawChunks(ctx, vis) {
    const c0 = Math.max(0, Math.floor(vis.x0 / CHUNK_PX));
    const c1 = Math.min(CHUNKS - 1, Math.floor(vis.x1 / CHUNK_PX));
    const r0 = Math.max(0, Math.floor(vis.y0 / CHUNK_PX));
    const r1 = Math.min(CHUNKS - 1, Math.floor(vis.y1 / CHUNK_PX));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const chunk = this.chunks[r * CHUNKS + c];
        if (chunk) ctx.drawImage(chunk.canvas, c * CHUNK_PX, r * CHUNK_PX);
      }
    }
  }

  /**
   * Animated surf, drawn under the land layer. The foam sprite is a filled
   * pale square inside a ring; at half scale the square is exactly one tile,
   * so the land tile covers it and only the ring breaks out along the water.
   */
  drawFoam(ctx, vis) {
    const foam = A.terrain.foam;
    ctx.save();
    ctx.globalAlpha = 0.9;
    for (const s of this.shoreTiles) {
      if (s.x < vis.x0 - 110 || s.x > vis.x1 + 110 || s.y < vis.y0 - 110 || s.y > vis.y1 + 110) continue;
      drawFrame(ctx, foam, frameAt(foam, this.time * 0.5 + s.phase), s.x, s.y, 0.5);
    }
    ctx.restore();
  }

  drawWaterDecor(ctx, vis) {
    for (const d of this.map.decor) {
      if (d.kind !== 'waterRock' && d.kind !== 'duck') continue;
      if (!inRect(vis, d.x, d.y, 80)) continue;
      if (d.kind === 'duck') {
        const s = A.decor.duck;
        drawFrame(ctx, s, frameAt(s, this.time * 0.7 + d.phase), d.x, d.y + Math.sin(this.time * 1.6) * 2, 1.0);
      } else {
        const s = A.decor.waterRocks[d.variant];
        drawFrame(ctx, s, frameAt(s, this.time * 0.6 + d.phase), d.x, d.y, 1.0);
      }
    }
  }

  drawSelectionRings(ctx, vis, view, localPlayerId) {
    if (!this.selection.size) return;
    ctx.save();
    ctx.lineWidth = 2;
    for (const u of view.units) {
      if (!this.selection.has(u.id)) continue;
      if (!inRect(vis, u.x, u.y, 60)) continue;
      const r = UNITS[u.type].radius + 5;
      ctx.strokeStyle = u.owner === localPlayerId ? 'rgba(150,255,170,0.95)' : 'rgba(255,150,150,0.9)';
      ctx.beginPath();
      ctx.ellipse(u.x, u.y + 2, r, r * 0.5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Builds one depth-sorted list of everything standing on the ground and
   * draws it back to front, so a unit in front of a tree occludes it.
   */
  drawSorted(ctx, vis, view, localPlayerId) {
    const list = [];

    for (const d of this.map.decor) {
      if (d.kind === 'waterRock' || d.kind === 'duck') continue;
      if (!inRect(vis, d.x, d.y, 140)) continue;
      list.push({ y: d.y, kind: 'decor', d });
    }
    for (const n of view.nodes) {
      if (n.amount <= 0) continue;
      if (!inRect(vis, n.x, n.y, 200)) continue;
      list.push({ y: n.y, kind: 'node', n });
    }
    for (const b of view.buildings) {
      const def = BUILDINGS[b.kind];
      if (!inRect(vis, b.x, b.y, 340)) continue;
      list.push({ y: (b.ty + def.foot[1]) * TILE, kind: 'building', b });
    }
    for (const u of view.units) {
      if (!inRect(vis, u.x, u.y, 160)) continue;
      list.push({ y: u.y, kind: 'unit', u });
    }

    list.sort((a, b) => a.y - b.y);

    for (const item of list) {
      switch (item.kind) {
        case 'decor': this.drawDecor(ctx, item.d); break;
        case 'node': this.drawNode(ctx, item.n); break;
        case 'building': this.drawBuilding(ctx, item.b, localPlayerId); break;
        case 'unit': this.drawUnit(ctx, item.u); break;
        default: break;
      }
    }
  }

  drawDecor(ctx, d) {
    if (d.kind === 'bush') {
      const s = A.decor.bushes[d.variant];
      drawFrame(ctx, s, frameAt(s, this.time * 0.5 + d.phase), d.x, d.y - 10 * d.scale, d.scale);
    } else if (d.kind === 'rock') {
      const s = A.decor.rocks[d.variant];
      drawFrame(ctx, s, 0, d.x, d.y - 8 * d.scale, d.scale);
    } else {
      const s = A.res.stumps[d.variant];
      drawFrame(ctx, s, 0, d.x, d.y - 30 * d.scale, d.scale);
    }
  }

  drawNode(ctx, n) {
    if (n.kind === 'wood') {
      const s = A.res.trees[n.variant];
      const foot = s.fh === 256 ? 113 : 74;
      const scale = 0.58;
      drawFrame(ctx, s, frameAt(s, this.time * 0.6 + n.phase), n.x, n.y - foot * scale, scale);
      return;
    }
    // The rock visibly shrinks through the six stone sizes as it is mined.
    const step = Math.max(0, Math.min(5, Math.round((n.amount / n.max) * 5)));
    drawFrame(ctx, A.res.goldStones[step], 0, n.x, n.y - 12, 0.75);
    const glow = A.res.goldStoneGlows[step];
    ctx.save();
    ctx.globalAlpha = 0.55 + Math.sin(this.time * 2 + n.phase) * 0.2;
    drawFrame(ctx, glow, frameAt(glow, this.time + n.phase), n.x, n.y - 12, 0.75);
    ctx.restore();
  }

  /** The sprite key for a building, folding house variants and the outpost. */
  spriteKey(b) {
    if (b.kind === 'house') return b.variant === 2 ? 'house2' : 'house1';
    if (b.kind === 'outpost') return 'house3';
    return b.kind;
  }

  drawBuilding(ctx, b, localPlayerId) {
    const def = BUILDINGS[b.kind];
    const key = this.spriteKey(b);
    const sheet = A.building[b.colorName] && A.building[b.colorName][key];
    if (!sheet) return;

    const bottom = (b.ty + def.foot[1]) * TILE + 8;
    const baseY = BUILDING_BASE[key] ?? def.sh;
    const scale = def.scale;
    const cx = (b.tx + def.foot[0] / 2) * TILE;
    const cy = bottom - (baseY - def.sh / 2) * scale;

    ctx.save();
    if (!b.done) {
      // A site under construction rises out of the ground as work proceeds.
      const k = Math.max(0.15, b.progress);
      const h = def.sh * scale;
      const shown = h * k;
      ctx.globalAlpha = 0.55 + 0.45 * k;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - def.sw * scale, cy + h / 2 - shown, def.sw * scale * 2, shown);
      ctx.clip();
      drawFrame(ctx, sheet, 0, cx, cy, scale);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,240,200,0.5)';
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.strokeRect(b.tx * TILE + 4, b.ty * TILE + 4, def.foot[0] * TILE - 8, def.foot[1] * TILE - 8);
      ctx.setLineDash([]);
      // The builder's mallet down at the site, so a foundation reads as a
      // place being worked. Always the mallet - an axe or pickaxe lying at a
      // construction site reads as a resource, which is misleading.
      drawFrame(ctx, A.res.tools[MALLET], 0,
        b.tx * TILE + 14, (b.ty + def.foot[1]) * TILE - 6, 0.7);
    } else if ((this.flash.get(b.id) || 0) > this.time) {
      ctx.filter = 'brightness(1.7)';
      drawFrame(ctx, sheet, 0, cx, cy, scale);
    } else {
      drawFrame(ctx, sheet, 0, cx, cy, scale);
    }
    ctx.restore();

    if (this.selection.has(b.id)) {
      ctx.save();
      ctx.strokeStyle = b.owner === localPlayerId ? 'rgba(150,255,170,0.95)' : 'rgba(255,150,150,0.9)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(b.tx * TILE + 3, b.ty * TILE + 3, def.foot[0] * TILE - 6, def.foot[1] * TILE - 6);
      ctx.restore();
    }
  }

  drawUnit(ctx, u) {
    const def = UNITS[u.type];
    const anims = A.unit[u.colorName];
    if (!anims) return;
    const sheet = pickUnitSheet(anims, u);
    if (!sheet) return;

    const scale = def.scale;
    const cy = u.y - (FOOT_OFFSET[u.type] || 40) * scale;

    // Contact shadow.
    const sh = A.terrain.shadow;
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.drawImage(sh.img, 57, 56, 79, 80, u.x - def.radius * 1.3, u.y - def.radius * 0.5,
      def.radius * 2.6, def.radius * 1.1);
    ctx.restore();

    drawFrame(ctx, sheet, u.frame, u.x, cy, scale, u.flip);
  }

  /**
   * Frames whatever the cursor is over with the pack's corner brackets. With
   * sprites this small and this densely packed, "which one am I about to
   * click" is a real question, and this answers it without a tooltip.
   *
   * Resource nodes get the same treatment at a smaller size, because nothing
   * else on the map tells a new player that a tree is something they can put a
   * peasant on.
   */
  drawHoverReticle(ctx, view) {
    const node = this.hoverNode;
    if (node) {
      this.drawBrackets(ctx, node.x - 26, node.y - 34, node.x + 26, node.y + 12, 9);
      return;
    }
    if (!this.hoverId) return;

    const u = view.units.find((e) => e.id === this.hoverId);
    if (u) {
      const r = UNITS[u.type].radius;
      this.drawBrackets(ctx, u.x - r * 1.3, u.y - r * 3, u.x + r * 1.3, u.y + r * 0.6, 10);
      return;
    }
    const b = view.buildings.find((e) => e.id === this.hoverId);
    if (!b) return;
    const def = BUILDINGS[b.kind];
    this.drawBrackets(ctx, b.tx * TILE - 3, b.ty * TILE - 3,
      (b.tx + def.foot[0]) * TILE + 3, (b.ty + def.foot[1]) * TILE + 3, 13);
  }

  /**
   * Draws the four corner brackets of Cursor_04 at a fixed size around a
   * rectangle. Scaling the whole 128px sprite to the target instead would make
   * the brackets grow with the thing they frame, which is what made them
   * overbearing on a castle.
   */
  drawBrackets(ctx, x0, y0, x1, y1, size) {
    const art = A.ui.cursorTarget.img;
    const sw = 21, sh = 25;                 // one bracket in the source sheet
    const h = size * (sh / sw);
    // Source corners, then destination corners in the same order.
    const src = [[3, 3], [104, 3], [3, 100], [104, 100]];
    const dst = [[x0, y0], [x1 - size, y0], [x0, y1 - h], [x1 - size, y1 - h]];
    ctx.save();
    ctx.globalAlpha = 0.95;
    for (let i = 0; i < 4; i++) {
      ctx.drawImage(art, src[i][0], src[i][1], sw, sh, dst[i][0], dst[i][1], size, h);
    }
    ctx.restore();
  }

  drawProjectiles(ctx, vis, view) {
    for (const p of view.projectiles) {
      if (!inRect(vis, p.x, p.y, 60)) continue;
      const arrow = A.unit[p.colorName || COLORS[0]].archer.arrow;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.dir);
      ctx.drawImage(arrow.img, -arrow.fw / 2, -arrow.fh / 2);
      ctx.restore();
    }
  }

  /** Health and production readouts, drawn last so nothing occludes them. */
  drawBars(ctx, vis, view) {
    const showText = this.camera.zoom > 0.5;
    for (const b of view.buildings) {
      if (!inRect(vis, b.x, b.y, 260)) continue;
      const def = BUILDINGS[b.kind];
      const cx = (b.tx + def.foot[0] / 2) * TILE;
      const w = Math.min(120, def.foot[0] * TILE * 0.8);
      let y = b.ty * TILE - 12;

      const frac = b.hp / def.hp;
      if (frac < 0.999 || this.selection.has(b.id) || this.hoverId === b.id) {
        this.healthBar(ctx, cx - w / 2, y, w, 8, frac, COLOR_HEX[b.colorName]);
        y -= 11;
      }
      if (!b.done) {
        this.progressBar(ctx, cx - w / 2, y, w, 6, b.progress, '#7fc9e8');
        continue;
      }
      // How long until the next unit walks out. Worth knowing about your own
      // buildings and, since there is no fog here, about everyone else's too.
      if (def.spawns) this.productionBar(ctx, cx, y, w, b, def, showText);
    }

    for (const u of view.units) {
      if (!inRect(vis, u.x, u.y, 90)) continue;
      const def = UNITS[u.type];
      const frac = u.hp / def.hp;
      if (frac >= 0.999 && !this.selection.has(u.id) && this.hoverId !== u.id) continue;
      this.healthBar(ctx, u.x - 15, u.y - 46 - def.radius, 30, 5, frac, COLOR_HEX[u.colorName]);
    }
  }

  productionBar(ctx, cx, y, w, b, def, showText) {
    this.progressBar(ctx, cx - w / 2, y, w, 6, b.paused ? 0 : b.produce,
      b.paused ? '#7d7086' : '#e6c25a');
    if (!showText) return;
    const remaining = Math.max(0, def.interval * (1 - b.produce));
    const label = b.paused ? 'halted' : Math.ceil(remaining) + 's';
    // The countdown is information, not scenery, so it is sized in screen
    // pixels rather than world ones and stays legible at any zoom.
    const px = 12 / this.camera.zoom;
    ctx.save();
    ctx.font = `700 ${px}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = px * 0.3;
    ctx.strokeStyle = 'rgba(20,18,28,0.92)';
    ctx.strokeText(label, cx, y - 3);
    ctx.fillStyle = b.paused ? '#c3b6cc' : '#f7e6ae';
    ctx.fillText(label, cx, y - 3);
    ctx.restore();
  }

  healthBar(ctx, x, y, w, h, frac, teamColor) {
    ctx.save();
    ctx.fillStyle = 'rgba(18,16,24,0.82)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = '#2b2733';
    ctx.fillRect(x, y, w, h);
    const f = Math.max(0, Math.min(1, frac));
    ctx.fillStyle = f > 0.6 ? '#67c46b' : f > 0.3 ? '#e0b84a' : '#d1584f';
    ctx.fillRect(x, y, w * f, h);
    // A thin team stripe along the top, so allegiance reads at a glance.
    ctx.fillStyle = teamColor || '#888';
    ctx.fillRect(x, y - 1, w, 1.5);
    ctx.restore();
  }

  progressBar(ctx, x, y, w, h, frac, color) {
    ctx.save();
    ctx.fillStyle = 'rgba(18,16,24,0.82)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = '#3a3550';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
    ctx.restore();
  }

  drawPlacement(ctx) {
    const p = this.placing;
    if (!p) return;
    const def = BUILDINGS[p.kind];
    const key = p.kind === 'house' ? 'house1' : p.kind === 'outpost' ? 'house3' : p.kind;
    const sheet = A.building[p.color] && A.building[p.color][key];
    const bottom = (p.ty + def.foot[1]) * TILE + 8;
    const baseY = BUILDING_BASE[key] ?? def.sh;
    const cx = (p.tx + def.foot[0] / 2) * TILE;
    const cy = bottom - (baseY - def.sh / 2) * def.scale;

    ctx.save();
    if (sheet) drawFrame(ctx, sheet, 0, cx, cy, def.scale, false, 0.6);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.valid ? 'rgba(120,235,140,0.95)' : 'rgba(235,110,100,0.95)';
    ctx.fillStyle = p.valid ? 'rgba(120,235,140,0.16)' : 'rgba(235,110,100,0.2)';
    ctx.fillRect(p.tx * TILE, p.ty * TILE, def.foot[0] * TILE, def.foot[1] * TILE);
    ctx.strokeRect(p.tx * TILE, p.ty * TILE, def.foot[0] * TILE, def.foot[1] * TILE);
    ctx.restore();
  }

  drawClouds(ctx, vis) {
    ctx.save();
    for (const c of this.map.clouds) {
      const w = MAP_TILES * TILE;
      const x = (c.x + this.time * c.speed) % (w + 1200) - 600;
      if (x < vis.x0 - 700 || x > vis.x1 + 700) continue;
      if (c.y < vis.y0 - 400 || c.y > vis.y1 + 400) continue;
      const img = A.decor.clouds[c.variant].img;
      ctx.globalAlpha = c.alpha;
      ctx.drawImage(img, x - img.width * c.scale / 2, c.y - img.height * c.scale / 2,
        img.width * c.scale, img.height * c.scale);
    }
    ctx.restore();
  }
}

/** Chooses the strip for a unit's current state. */
function pickUnitSheet(anims, u) {
  const a = anims[u.type];
  if (!a) return null;
  const moving = u.st === ST.MOVE || u.st === ST.ATTACK_MOVE || u.st === ST.CHASE
    || u.st === ST.RETURN || u.st === ST.GATHER_GO || u.st === ST.BUILD_GO;

  if (u.type === 'peasant') {
    // Anything to do with a build site is done hammer in hand, walk included.
    if (u.st === ST.BUILD_WORK) return a.build;
    if (u.st === ST.BUILD_GO) return moving ? a.runHammer : a.idleHammer;
    if (u.st === ST.GATHER_WORK) return a[TOOL_WORK[u.workKind] || 'chop'];
    // A full load is carried in both hands, so it beats the tool.
    if (u.carryKind) {
      const suffix = u.carryKind === 2 ? 'Gold' : 'Wood';
      return moving ? a['run' + suffix] : a['idle' + suffix];
    }
    const tool = TOOL_HOLD[u.workKind];
    if (tool) return moving ? a['run' + tool] : a['idle' + tool];
    return moving ? a.run : a.idle;
  }

  if (u.type === 'warrior') {
    if (u.st === ST.ATTACK) return (u.id & 1) ? a.attack1 : a.attack2;
    if (u.st === ST.HOLD) return a.guard;
    return moving ? a.run : a.idle;
  }

  if (u.type === 'archer') {
    if (u.st === ST.ATTACK) return a.shoot;
    return moving ? a.run : a.idle;
  }

  if (u.type === 'monk') {
    if (u.st === ST.HEAL) return a.heal;
    return moving ? a.run : a.idle;
  }

  if (u.type === 'lancer') {
    // The lancer has a strip per facing; pick from its aim angle.
    const suffix = lancerSuffix(u.dir, u.flip);
    if (u.st === ST.ATTACK) return a['attack' + suffix] || a.attackRight;
    if (u.st === ST.HOLD) return a['guard' + suffix] || a.guardRight;
    return moving ? a.run : a.idle;
  }
  return a.idle;
}

/** Maps an aim angle onto the Lancer's five directional strips. */
function lancerSuffix(dir, flip) {
  // Fold the left half onto the right; the sprite is mirrored for west.
  let a = dir;
  if (flip) a = Math.PI - a;
  a = Math.atan2(Math.sin(a), Math.cos(a));
  const deg = (a * 180) / Math.PI;
  if (deg < -67.5) return 'Up';
  if (deg < -22.5) return 'UpRight';
  if (deg < 22.5) return 'Right';
  if (deg < 67.5) return 'DownRight';
  return 'Down';
}

function inRect(vis, x, y, pad) {
  return x > vis.x0 - pad && x < vis.x1 + pad && y > vis.y0 - pad && y < vis.y1 + pad;
}

/** Reads the dominant colour out of a tile image, for the water backdrop. */
function sampleColor(img) {
  const cv = document.createElement('canvas');
  cv.width = 1; cv.height = 1;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.drawImage(img, 0, 0, img.width, img.height, 0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return `rgb(${r},${g},${b})`;
}

/**
 * Paints a one-pixel-per-tile overview of a map. Used for the in-game minimap
 * and for the lobby's map preview, so what you pick is what you play.
 */
export function paintMinimap(map, canvas) {
  canvas.width = MAP_TILES;
  canvas.height = MAP_TILES;
  const c = canvas.getContext('2d');
  const img = c.createImageData(MAP_TILES, MAP_TILES);
  const put = (i, r, g, b) => {
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  };
  for (let i = 0; i < MAP_TILES * MAP_TILES; i++) {
    if (map.level[i] === LEVEL.WATER) put(i, 26, 82, 104);
    else put(i, 96, 134, 76);
  }
  c.putImageData(img, 0, 0);
  for (const n of map.nodes) {
    c.fillStyle = n.kind === 'gold' ? '#e0c14a' : '#2f6b3f';
    c.fillRect(n.tx, n.ty, 1, 1);
  }
  // Mark the four starting corners.
  c.fillStyle = '#ffffff';
  for (const s of map.starts) c.fillRect(s.tx - 1, s.ty - 1, 3, 3);
  return canvas;
}
