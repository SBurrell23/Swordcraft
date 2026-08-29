// Procedural map generation.
//
// Everything here is driven by a single 32-bit seed and the number of players,
// so the host only has to send those two numbers and every peer builds a
// byte-identical map locally.
//
// The shape of a map is:
//   * an island carved out of value noise, ringed by open sea;
//   * inland lakes and winding rivers that cut it into regions, crossed by a
//     handful of land bridges - the bridges are the chokepoints armies fight
//     over, and the water is what makes a flank cost something;
//   * one base site per player, always clear, always connected, and always
//     given a fair, symmetric allotment of nearby resources.
//
// The island is grown around the base sites rather than stamped as a square,
// which is what lets the same code produce a duelling bar for two players, a
// triangle for three and a four-cornered island for four.

import { TILE, LEVEL, NODE_AMOUNT, mapTilesFor } from './consts.js';

/** Small fast seeded PRNG (mulberry32). Identical output on every platform. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** A grid of random values, sampled with smooth interpolation. */
function lattice(rand, n) {
  const g = new Float32Array((n + 1) * (n + 1));
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return (u, v) => {
    const x = u * n, y = v * n;
    const x0 = Math.min(n - 1, Math.floor(x)), y0 = Math.min(n - 1, Math.floor(y));
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const a = g[y0 * (n + 1) + x0], b = g[y0 * (n + 1) + x0 + 1];
    const c = g[(y0 + 1) * (n + 1) + x0], d = g[(y0 + 1) * (n + 1) + x0 + 1];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  };
}

/** Sum of lattices at rising frequency - value-noise fbm. */
function fbm(rand, octaves) {
  const layers = octaves.map(([n, amp]) => [lattice(rand, n), amp]);
  const total = octaves.reduce((s, [, amp]) => s + amp, 0);
  return (u, v) => layers.reduce((s, [f, amp]) => s + f(u, v) * amp, 0) / total;
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Tiles around a base kept clear of water and resources. */
const BASE_CLEAR = 8;

/**
 * Where each player's base sits, as a fraction of the grid. Four players get
 * the four corners; three get a triangle; two face each other along a
 * diagonal, which is the longest walk a square grid offers.
 *
 * @param {number} tiles grid size
 * @param {number} players 1-4
 * @returns {Array<[number, number]>} base tiles
 */
export function baseSites(tiles, players) {
  const inset = Math.round(tiles * 0.15);
  const lo = inset, hi = tiles - 1 - inset;
  const mid = (tiles - 1) / 2;

  if (players <= 1) return [[lo, lo]];
  if (players === 2) return [[lo, lo], [hi, hi]];
  if (players === 3) {
    // Points of a triangle: one at the top, two along the bottom. Kept on the
    // same inset ring so no seat is closer to the middle than another.
    const r = mid - inset;
    return [
      [Math.round(mid), Math.round(mid - r)],
      [Math.round(mid + r * 0.92), Math.round(mid + r * 0.62)],
      [Math.round(mid - r * 0.92), Math.round(mid + r * 0.62)],
    ];
  }
  return [[lo, lo], [hi, lo], [hi, hi], [lo, hi]];
}

/**
 * Resource allotment around every base, in a local frame where +x points at
 * the middle of the map and +y is ninety degrees clockwise from it. Rotating
 * one layout into each seat is what makes every start exactly as rich as the
 * others, whatever shape the seats are arranged in.
 */
const BASE_LAYOUT = [
  { kind: 'gold', dx: 7, dy: -1 },
  { kind: 'gold', dx: 8, dy: 1 },
  { kind: 'gold', dx: -1, dy: 7 },
  { kind: 'gold', dx: 1, dy: 8 },
  { kind: 'gold', dx: 5, dy: -5 },
  { kind: 'gold', dx: -5, dy: 5 },
  { kind: 'wood', dx: -2, dy: 3 }, { kind: 'wood', dx: -3, dy: 1 },
  { kind: 'wood', dx: -1, dy: 5 }, { kind: 'wood', dx: -3, dy: 4 },
  { kind: 'wood', dx: 3, dy: -2 }, { kind: 'wood', dx: 1, dy: -3 },
  { kind: 'wood', dx: 5, dy: -1 }, { kind: 'wood', dx: 4, dy: -3 },
  { kind: 'wood', dx: 6, dy: 5 }, { kind: 'wood', dx: 5, dy: 7 },
  { kind: 'wood', dx: 7, dy: 6 }, { kind: 'wood', dx: 3, dy: 6 },
  { kind: 'wood', dx: 6, dy: 3 },
];

/**
 * @typedef GameMap
 * @property {number} seed
 * @property {number} tiles         grid size; varies with the number of players
 * @property {number} players       seats this map was generated for
 * @property {Uint8Array} level     LEVEL.WATER or LEVEL.GROUND per tile
 * @property {Uint8Array} blocked   1 where terrain permanently blocks movement
 * @property {Array} nodes          harvestable resource nodes
 * @property {Array} decor          purely cosmetic props
 * @property {Array} clouds         drifting overlay clouds
 * @property {Array} starts         one {tx, ty, x, y} per seat
 * @property {number} tileset       which Tilemap_colorN to draw with
 */

/**
 * Builds a complete map from a seed and a seat count.
 * @param {number} seed
 * @param {number} [players] 1-4; the grid size and base layout follow from it
 * @returns {GameMap}
 */
export function generateMap(seed, players = 4) {
  players = Math.max(1, Math.min(4, players | 0));
  const tiles = mapTilesFor(players);
  const rand = mulberry32(seed);

  const g = {
    tiles,
    rand,
    level: new Uint8Array(tiles * tiles),
    blocked: new Uint8Array(tiles * tiles),
    sites: baseSites(tiles, players),
    idx: (tx, ty) => ty * tiles + tx,
    inBounds: (tx, ty) => tx >= 0 && ty >= 0 && tx < tiles && ty < tiles,
  };

  // -- 1. Island shape -------------------------------------------------------
  shapeIsland(g);

  // -- 2. Clean the coastline before anything is cut into it ----------------
  clearBases(g);
  connectBases(g);
  removeIslands(g);
  smoothCoast(g);
  clearBases(g);

  // -- 3. Inland water -------------------------------------------------------
  carveLakes(g);
  carveRivers(g);
  clearBases(g);

  // -- 4. Guarantee every base can still reach every other -------------------
  ensureConnected(g);
  removeIslands(g);
  clearBases(g);

  // -- 5. Contents -----------------------------------------------------------
  const starts = g.sites.map(([tx, ty]) => ({
    tx, ty, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE,
  }));
  const nodes = placeResources(g);
  pruneUnreachableNodes(g, nodes);
  const decor = placeDecor(g);
  const clouds = Array.from({ length: 14 }, () => ({
    variant: (rand() * 8) | 0,
    x: rand() * tiles * TILE,
    y: rand() * tiles * TILE,
    speed: 6 + rand() * 14,
    scale: 0.7 + rand() * 0.8,
    alpha: 0.10 + rand() * 0.14,
  }));

  return {
    seed, players, tiles,
    level: g.level, blocked: g.blocked, nodes, decor, clouds, starts,
    tileset: (mulberry32(seed ^ 0x9e3779b9)() * 5) | 0,
  };
}

// ---------------------------------------------------------------------------
// Shaping helpers
// ---------------------------------------------------------------------------

/** Squared distance from a point to a line segment, in tiles. */
function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len = vx * vx + vy * vy;
  const t = len ? clamp01(((px - ax) * vx + (py - ay) * vy) / len) : 0;
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return Math.hypot(dx, dy);
}

/**
 * Grows the island around the base sites instead of stamping a square.
 *
 * The land wants to be the union of a hub in the middle, a disc at every base,
 * and a broad arm joining each base to the hub. Noise then eats into that from
 * the outside, which is what gives the coast its bays and headlands. Two
 * players get a bar, three a triangle, four a squarish island - all from the
 * same rule, because the rule is written in terms of where people start.
 */
function shapeIsland(g) {
  const { tiles, rand, level, sites, idx } = g;
  const land = fbm(rand, [[4, 1], [8, 0.5], [16, 0.25], [32, 0.12]]);
  const mid = (tiles - 1) / 2;

  const hubR = tiles * 0.34;
  const armHalf = tiles * 0.24;
  const siteR = tiles * 0.28;
  // How far past the shape the coast may still reach. Generous, because a
  // cramped island turns every match into the same fight over one bridge.
  const spread = tiles * 0.26;
  const rim = tiles * 0.44;   // beyond this it is open sea no matter what

  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      // Distance outside the union of hub, base discs and connecting arms.
      let d = Math.hypot(tx - mid, ty - mid) - hubR;
      for (const [sx, sy] of sites) {
        d = Math.min(d, Math.hypot(tx - sx, ty - sy) - siteR);
        d = Math.min(d, distToSegment(tx, ty, sx, sy, mid, mid) - armHalf);
      }
      const shape = clamp01(d / spread);
      // A hard rim as well, so no seed ever runs the island into the border.
      const edge = Math.max(Math.abs(tx - mid), Math.abs(ty - mid)) / mid;
      const border = clamp01((edge - rim / mid) / (1 - rim / mid));
      const falloff = Math.max(shape, border * border);

      const h = land(tx / tiles, ty / tiles) - falloff * 1.45;
      level[idx(tx, ty)] = h > 0.33 ? LEVEL.GROUND : LEVEL.WATER;
    }
  }
}

function stampDisc(g, cx, cy, r, value) {
  const ri = Math.ceil(r);
  for (let ty = cy - ri; ty <= cy + ri; ty++) {
    for (let tx = cx - ri; tx <= cx + ri; tx++) {
      if (!g.inBounds(tx, ty)) continue;
      if ((tx - cx) ** 2 + (ty - cy) ** 2 <= r * r) g.level[g.idx(tx, ty)] = value;
    }
  }
}

const clearBases = (g) => {
  for (const [cx, cy] of g.sites) stampDisc(g, cx, cy, BASE_CLEAR, LEVEL.GROUND);
};

const nearAnyBase = (g, tx, ty, r) =>
  g.sites.some(([cx, cy]) => (tx - cx) ** 2 + (ty - cy) ** 2 <= r * r);

/** Carves a wandering isthmus between two tiles so bases are never marooned. */
function carveCorridor(g, ax, ay, bx, by) {
  const { tiles, rand } = g;
  let x = ax, y = ay;
  let guard = tiles * 4;
  while ((x !== bx || y !== by) && guard-- > 0) {
    stampDisc(g, x, y, 2 + ((rand() * 2) | 0), LEVEL.GROUND);
    // Step toward the target, wobbling so the result is not a ruler line.
    const dx = Math.sign(bx - x), dy = Math.sign(by - y);
    if (dx && (!dy || rand() < 0.5)) x += dx; else if (dy) y += dy;
    if (rand() < 0.18) { x += (rand() * 3 | 0) - 1; y += (rand() * 3 | 0) - 1; }
    x = Math.max(2, Math.min(tiles - 3, x));
    y = Math.max(2, Math.min(tiles - 3, y));
  }
}

/** Land-connects every base to the map centre. */
function connectBases(g) {
  const mid = (g.tiles / 2) | 0;
  stampDisc(g, mid, mid, 7, LEVEL.GROUND);
  for (const [cx, cy] of g.sites) {
    if (!pathExists(g, cx, cy, mid, mid)) carveCorridor(g, cx, cy, mid, mid);
  }
}

/** Re-links any base the lakes and rivers have cut off. */
function ensureConnected(g) {
  const [ax, ay] = g.sites[0];
  for (let i = 1; i < g.sites.length; i++) {
    const [bx, by] = g.sites[i];
    if (pathExists(g, ax, ay, bx, by)) continue;
    carveCorridor(g, bx, by, ax, ay);
  }
}

/** Flood fill over land tiles. */
function pathExists(g, ax, ay, bx, by) {
  const { level, idx, inBounds, tiles } = g;
  if (level[idx(ax, ay)] === LEVEL.WATER || level[idx(bx, by)] === LEVEL.WATER) return false;
  const seen = new Uint8Array(level.length);
  const q = [idx(ax, ay)];
  seen[q[0]] = 1;
  const goal = idx(bx, by);
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    if (i === goal) return true;
    const tx = i % tiles, ty = (i / tiles) | 0;
    for (const [ox, oy] of N4) {
      const nx = tx + ox, ny = ty + oy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (seen[j] || level[j] === LEVEL.WATER) continue;
      seen[j] = 1; q.push(j);
    }
  }
  return false;
}

/** Drowns every landmass except the one holding the bases. */
function removeIslands(g) {
  const { level, idx, inBounds, tiles, sites } = g;
  const label = new Int32Array(level.length).fill(-1);
  let next = 0;
  for (let i = 0; i < level.length; i++) {
    if (level[i] === LEVEL.WATER || label[i] >= 0) continue;
    const id = next++;
    const q = [i]; label[i] = id;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      const tx = c % tiles, ty = (c / tiles) | 0;
      for (const [ox, oy] of N4) {
        const nx = tx + ox, ny = ty + oy;
        if (!inBounds(nx, ny)) continue;
        const j = idx(nx, ny);
        if (label[j] >= 0 || level[j] === LEVEL.WATER) continue;
        label[j] = id; q.push(j);
      }
    }
  }
  const keep = label[idx(sites[0][0], sites[0][1])];
  for (let i = 0; i < level.length; i++) {
    if (level[i] !== LEVEL.WATER && label[i] !== keep) level[i] = LEVEL.WATER;
  }
}

/** Cellular-automaton pass that rounds off jagged one-tile coastal spikes. */
function smoothCoast(g) {
  const { level, idx, tiles } = g;
  for (let pass = 0; pass < 2; pass++) {
    const copy = level.slice();
    for (let ty = 1; ty < tiles - 1; ty++) {
      for (let tx = 1; tx < tiles - 1; tx++) {
        const i = idx(tx, ty);
        let landCount = 0;
        for (const [ox, oy] of N8) if (copy[idx(tx + ox, ty + oy)] !== LEVEL.WATER) landCount++;
        // Filling at 5 rather than 6 leaves fewer pinprick coves, which is a
        // little more land and a lot fewer one-tile bays a unit can wedge into.
        if (copy[i] === LEVEL.WATER && landCount >= 5) level[i] = LEVEL.GROUND;
        else if (copy[i] !== LEVEL.WATER && landCount <= 2) level[i] = LEVEL.WATER;
      }
    }
  }
  // Hard border of water so the island never touches the map edge.
  for (let i = 0; i < tiles; i++) {
    for (const j of [0, 1, tiles - 2, tiles - 1]) {
      level[idx(i, j)] = LEVEL.WATER;
      level[idx(j, i)] = LEVEL.WATER;
    }
  }
}

// ---------------------------------------------------------------------------
// Inland water
// ---------------------------------------------------------------------------

/** Ragged inland lakes, well clear of anybody's base. */
function carveLakes(g) {
  const { tiles, rand, level, idx, inBounds } = g;
  const count = 2 + ((rand() * 3) | 0);
  const shape = fbm(rand, [[7, 1], [15, 0.5]]);
  for (let n = 0; n < count; n++) {
    let cx = 0, cy = 0, ok = false;
    for (let attempt = 0; attempt < 40 && !ok; attempt++) {
      cx = 8 + ((rand() * (tiles - 16)) | 0);
      cy = 8 + ((rand() * (tiles - 16)) | 0);
      ok = level[idx(cx, cy)] === LEVEL.GROUND && !nearAnyBase(g, cx, cy, BASE_CLEAR + 5);
    }
    if (!ok) continue;
    const r = 3 + rand() * 3.5;
    const ri = Math.ceil(r) + 2;
    for (let ty = cy - ri; ty <= cy + ri; ty++) {
      for (let tx = cx - ri; tx <= cx + ri; tx++) {
        if (!inBounds(tx, ty) || nearAnyBase(g, tx, ty, BASE_CLEAR + 1)) continue;
        // Perturb the radius with noise so the shore is not a circle.
        const wobble = (shape(tx / tiles, ty / tiles) - 0.5) * 3.4;
        if ((tx - cx) ** 2 + (ty - cy) ** 2 <= (r + wobble) ** 2) {
          level[idx(tx, ty)] = LEVEL.WATER;
        }
      }
    }
  }
}

/**
 * Rivers, each left with a few land bridges across it.
 *
 * The bridge is the point of the exercise: a river with no crossing is just a
 * wall, but a river crossed several times gives an attacker a choice and gives
 * a defender something worth holding.
 */
function carveRivers(g) {
  const { tiles, rand } = g;
  const count = 1 + ((rand() * 3) | 0);
  for (let n = 0; n < count; n++) {
    // Run roughly across the island, so a river actually divides something.
    const horizontal = rand() < 0.5;
    let x = horizontal ? 3 : 8 + ((rand() * (tiles - 16)) | 0);
    let y = horizontal ? 8 + ((rand() * (tiles - 16)) | 0) : 3;
    const endX = horizontal ? tiles - 4 : 8 + ((rand() * (tiles - 16)) | 0);
    const endY = horizontal ? 8 + ((rand() * (tiles - 16)) | 0) : tiles - 4;

    const width = 1 + rand() * 0.6;
    let sinceBridge = 5 + ((rand() * 6) | 0);
    let bridgeLeft = 0;
    let guard = tiles * 3;

    while (guard-- > 0 && (Math.abs(x - endX) > 1 || Math.abs(y - endY) > 1)) {
      if (bridgeLeft > 0) {
        bridgeLeft--;                       // leave these tiles dry: a crossing
      } else if (!nearAnyBase(g, x, y, BASE_CLEAR + 3)) {
        stampDisc(g, x, y, width, LEVEL.WATER);
        if (--sinceBridge <= 0) {
          sinceBridge = 7 + ((rand() * 7) | 0);
          bridgeLeft = 5;
        }
      }

      // Meander: mostly toward the mouth, sometimes sideways.
      const dx = Math.sign(endX - x), dy = Math.sign(endY - y);
      if (rand() < 0.72) {
        if (horizontal) x += dx || 1; else y += dy || 1;
      } else if (horizontal) {
        y += rand() < 0.5 ? 1 : -1;
      } else {
        x += rand() < 0.5 ? 1 : -1;
      }
      x = Math.max(2, Math.min(tiles - 3, x));
      y = Math.max(2, Math.min(tiles - 3, y));
    }
  }
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

let nextNodeId = 1;

function makeNode(kind, tx, ty, rand) {
  return {
    id: nextNodeId++,
    kind, tx, ty,
    x: (tx + 0.5) * TILE,
    y: (ty + 0.5) * TILE,
    amount: NODE_AMOUNT[kind],
    max: NODE_AMOUNT[kind],
    variant: (rand() * (kind === 'wood' ? 4 : 6)) | 0,
    phase: rand() * 6,
    workers: 0,
  };
}

function placeable(g, tx, ty) {
  if (!g.inBounds(tx, ty)) return false;
  const i = g.idx(tx, ty);
  return g.level[i] !== LEVEL.WATER && !g.blocked[i];
}

function placeResources(g) {
  const { tiles, rand, blocked, idx, sites } = g;
  nextNodeId = 1;
  const nodes = [];
  const put = (kind, tx, ty) => {
    tx = Math.round(tx); ty = Math.round(ty);
    if (!placeable(g, tx, ty)) return false;
    if (nearAnyBase(g, tx, ty, 3.2)) return false; // keep the castle plaza clear
    nodes.push(makeNode(kind, tx, ty, rand));
    blocked[idx(tx, ty)] = 1;
    return true;
  };

  // Fair, mirrored allotment around each base. The layout is written once in a
  // local frame and rotated into each seat, so it works for a triangle just as
  // well as for four corners.
  const mid = (tiles - 1) / 2;
  for (const [cx, cy] of sites) {
    const ang = Math.atan2(mid - cy, mid - cx);   // local +x points at the middle
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (const p of BASE_LAYOUT) {
      // Nudge until it lands somewhere legal, so noisy terrain cannot starve
      // a seat of its guaranteed income.
      for (let attempt = 0; attempt < 14; attempt++) {
        const jx = attempt ? (rand() * 5 | 0) - 2 : 0;
        const jy = attempt ? (rand() * 5 | 0) - 2 : 0;
        const ox = p.dx * ca - p.dy * sa;
        const oy = p.dx * sa + p.dy * ca;
        if (put(p.kind, cx + ox + jx, cy + oy + jy)) break;
      }
    }
  }

  // Scattered clusters over the rest of the island, scaled to its area so a
  // small map is not a barren one. Gold seams outnumber wood clusters less
  // heavily than they used to: gold was the only resource anybody thought
  // about, and the cure is partly more of it on the ground.
  const scatter = Math.round(52 * (tiles / 68) ** 2);
  for (let n = 0; n < scatter; n++) {
    const kind = rand() < 0.52 ? 'wood' : 'gold';
    const tx = 3 + ((rand() * (tiles - 6)) | 0);
    const ty = 3 + ((rand() * (tiles - 6)) | 0);
    if (!placeable(g, tx, ty)) continue;
    const size = kind === 'wood' ? 3 + ((rand() * 7) | 0) : 2 + ((rand() * 3) | 0);
    for (let k = 0; k < size; k++) {
      put(kind, tx + ((rand() * 7) | 0) - 3, ty + ((rand() * 7) | 0) - 3);
    }
  }
  return nodes;
}

/**
 * Drops any resource node with no free orthogonal neighbour. Dense clusters
 * otherwise bury their own interior, leaving seams a worker can see but can
 * never stand beside.
 */
function pruneUnreachableNodes(g, nodes) {
  const { level, blocked, idx, inBounds } = g;
  for (let pass = 0; pass < 3; pass++) {
    let removed = 0;
    for (let k = nodes.length - 1; k >= 0; k--) {
      const n = nodes[k];
      const open = N4.some(([ox, oy]) => {
        const nx = n.tx + ox, ny = n.ty + oy;
        return inBounds(nx, ny) && level[idx(nx, ny)] !== LEVEL.WATER && !blocked[idx(nx, ny)];
      });
      if (open) continue;
      blocked[idx(n.tx, n.ty)] = 0;
      nodes.splice(k, 1);
      removed++;
    }
    if (!removed) break;   // freeing one tile can open up its neighbours
  }
}

function placeDecor(g) {
  const { tiles, rand, level, blocked, idx } = g;
  const decor = [];

  // Rocks breaking the surface, thick along every shore and scattered beyond.
  // Rivers and lakes give the island a great deal of shoreline, and this is
  // what stops all that water reading as a flat colour.
  for (let ty = 2; ty < tiles - 2; ty++) {
    for (let tx = 2; tx < tiles - 2; tx++) {
      if (level[idx(tx, ty)] !== LEVEL.WATER) continue;
      const coastal = N8.some(([ox, oy]) => level[idx(tx + ox, ty + oy)] !== LEVEL.WATER);
      if (rand() > (coastal ? 0.15 : 0.02)) continue;
      decor.push({
        kind: 'waterRock', variant: (rand() * 4) | 0,
        x: (tx + 0.2 + rand() * 0.6) * TILE,
        y: (ty + 0.2 + rand() * 0.6) * TILE,
        phase: rand() * 4,
      });
    }
  }

  // Ground clutter, scaled to the island so a big map is not sparse.
  const clutter = Math.round(340 * (tiles / 68) ** 2);
  for (let n = 0; n < clutter; n++) {
    const tx = 1 + ((rand() * (tiles - 2)) | 0);
    const ty = 1 + ((rand() * (tiles - 2)) | 0);
    const i = idx(tx, ty);
    if (level[i] === LEVEL.WATER || blocked[i]) continue;
    const x = (tx + rand()) * TILE;
    const y = (ty + rand()) * TILE;
    const roll = rand();
    if (roll < 0.55) {
      decor.push({ kind: 'bush', variant: (rand() * 4) | 0, x, y, phase: rand() * 4, scale: 0.45 + rand() * 0.25 });
    } else if (roll < 0.85) {
      decor.push({ kind: 'rock', variant: (rand() * 4) | 0, x, y, scale: 0.5 + rand() * 0.3 });
    } else {
      decor.push({ kind: 'stump', variant: (rand() * 4) | 0, x, y, scale: 0.45 + rand() * 0.2 });
    }
  }

  // One rubber duck per map, bobbing somewhere out at sea. Worth finding.
  for (let attempt = 0; attempt < 200; attempt++) {
    const tx = 2 + ((rand() * (tiles - 4)) | 0);
    const ty = 2 + ((rand() * (tiles - 4)) | 0);
    if (level[idx(tx, ty)] !== LEVEL.WATER) continue;
    decor.push({ kind: 'duck', variant: 0, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE, phase: rand() * 4 });
    break;
  }
  return decor;
}

/** True when a unit may step between two adjacent tiles. */
export function canStep(level, from, to) {
  return level[from] !== LEVEL.WATER && level[to] !== LEVEL.WATER;
}
