// Procedural map generation.
//
// Everything here is driven by a single 32-bit seed, so the host only has to
// send that seed and every peer builds a byte-identical map locally.
//
// The shape of a map is:
//   * an island carved out of value noise, ringed by open sea;
//   * inland lakes and winding rivers that cut it into regions, crossed by a
//     handful of land bridges - the bridges are the chokepoints armies fight
//     over, and the water is what makes a flank cost something;
//   * four corner base sites, always clear, always connected, and always given
//     a fair, four-way-symmetric allotment of nearby resources.

import { MAP_TILES, TILE, LEVEL, NODE_AMOUNT } from './consts.js';

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

/** A tileable lattice of random values, sampled with smoothed bilinear interp. */
function lattice(rand, n) {
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const at = (x, y) => g[(((y % n) + n) % n) * n + (((x % n) + n) % n)];
  return (u, v) => {
    const x = u * n, y = v * n;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    return lerp(
      lerp(at(x0, y0), at(x0 + 1, y0), fx),
      lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx),
      fy);
  };
}

/** Fractal sum of lattices; returns a sampler over the unit square. */
function fbm(rand, octaves) {
  const layers = octaves.map(([n, amp]) => ({ f: lattice(rand, n), amp }));
  const total = layers.reduce((s, l) => s + l.amp, 0);
  return (u, v) => layers.reduce((s, l) => s + l.f(u, v) * l.amp, 0) / total;
}

const idx = (tx, ty) => ty * MAP_TILES + tx;
const inBounds = (tx, ty) => tx >= 0 && ty >= 0 && tx < MAP_TILES && ty < MAP_TILES;

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Where each player's castle sits, inset from its corner. */
const BASE_INSET = 10;
export const CORNERS = [
  [BASE_INSET, BASE_INSET],
  [MAP_TILES - 1 - BASE_INSET, BASE_INSET],
  [MAP_TILES - 1 - BASE_INSET, MAP_TILES - 1 - BASE_INSET],
  [BASE_INSET, MAP_TILES - 1 - BASE_INSET],
];

/** Tiles around a base kept clear of water and resources. */
const BASE_CLEAR = 8;

/**
 * Resource allotment around every base, in "local" tiles where +x and +y both
 * point toward the middle of the map. Mirroring these into each corner makes
 * all four starts exactly as rich as one another.
 */
const BASE_LAYOUT = [
  { kind: 'gold', dx: 7, dy: -1 },
  { kind: 'gold', dx: 8, dy: 1 },
  { kind: 'gold', dx: -1, dy: 7 },
  { kind: 'gold', dx: 1, dy: 8 },
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
 * @property {Uint8Array} level     LEVEL.WATER or LEVEL.GROUND per tile
 * @property {Uint8Array} blocked   1 where terrain permanently blocks movement
 * @property {Array} nodes          harvestable resource nodes
 * @property {Array} decor          purely cosmetic props
 * @property {Array} clouds         drifting overlay clouds
 * @property {Array} starts         one {tx, ty, x, y} per corner
 * @property {number} tileset       which Tilemap_colorN to draw with
 */

/**
 * Builds a complete map from a seed.
 * @param {number} seed
 * @returns {GameMap}
 */
export function generateMap(seed) {
  const rand = mulberry32(seed);
  const level = new Uint8Array(MAP_TILES * MAP_TILES);
  const blocked = new Uint8Array(MAP_TILES * MAP_TILES);

  // -- 1. Island shape -------------------------------------------------------
  const land = fbm(rand, [[4, 1], [8, 0.5], [16, 0.25], [32, 0.12]]);
  const half = (MAP_TILES - 1) / 2;
  for (let ty = 0; ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      const u = tx / MAP_TILES, v = ty / MAP_TILES;
      // Square-ish falloff keeps the corners usable while drowning the rim.
      const dx = Math.abs(tx - half) / half, dy = Math.abs(ty - half) / half;
      const edge = Math.max(dx, dy);
      const falloff = Math.max(0, (edge - 0.74) / 0.26); // 0 inside, 1 at the rim
      const h = land(u, v) - falloff * 1.35;
      level[idx(tx, ty)] = h > 0.34 ? LEVEL.GROUND : LEVEL.WATER;
    }
  }

  // -- 2. Clean the coastline before anything is cut into it ----------------
  for (const [cx, cy] of CORNERS) stampDisc(level, cx, cy, BASE_CLEAR, LEVEL.GROUND);
  connectBases(level, rand);
  removeIslands(level);
  smoothCoast(level);
  for (const [cx, cy] of CORNERS) stampDisc(level, cx, cy, BASE_CLEAR, LEVEL.GROUND);

  // -- 3. Inland water -------------------------------------------------------
  carveLakes(level, rand);
  carveRivers(level, rand);
  for (const [cx, cy] of CORNERS) stampDisc(level, cx, cy, BASE_CLEAR, LEVEL.GROUND);

  // -- 4. Guarantee every base can still reach every other -------------------
  ensureConnected(level, rand);
  removeIslands(level);
  for (const [cx, cy] of CORNERS) stampDisc(level, cx, cy, BASE_CLEAR, LEVEL.GROUND);

  // -- 5. Contents -----------------------------------------------------------
  const starts = CORNERS.map(([tx, ty]) => ({
    tx, ty, x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE,
  }));
  const nodes = placeResources(level, blocked, rand);
  pruneUnreachableNodes(level, blocked, nodes);
  const decor = placeDecor(level, blocked, rand);
  const clouds = Array.from({ length: 14 }, () => ({
    variant: (rand() * 8) | 0,
    x: rand() * MAP_TILES * TILE,
    y: rand() * MAP_TILES * TILE,
    speed: 6 + rand() * 14,
    scale: 0.7 + rand() * 0.8,
    alpha: 0.10 + rand() * 0.14,
  }));

  return {
    seed, level, blocked, nodes, decor, clouds, starts,
    tileset: (mulberry32(seed ^ 0x9e3779b9)() * 5) | 0,
  };
}

// ---------------------------------------------------------------------------
// Shaping helpers
// ---------------------------------------------------------------------------

function stampDisc(level, cx, cy, r, value) {
  const ri = Math.ceil(r);
  for (let ty = cy - ri; ty <= cy + ri; ty++) {
    for (let tx = cx - ri; tx <= cx + ri; tx++) {
      if (!inBounds(tx, ty)) continue;
      if ((tx - cx) ** 2 + (ty - cy) ** 2 <= r * r) level[idx(tx, ty)] = value;
    }
  }
}

const nearAnyBase = (tx, ty, r) =>
  CORNERS.some(([cx, cy]) => (tx - cx) ** 2 + (ty - cy) ** 2 <= r * r);

/** Carves a wandering isthmus between two tiles so bases are never marooned. */
function carveCorridor(level, ax, ay, bx, by, rand) {
  let x = ax, y = ay;
  let guard = MAP_TILES * 4;
  while ((x !== bx || y !== by) && guard-- > 0) {
    stampDisc(level, x, y, 2 + ((rand() * 2) | 0), LEVEL.GROUND);
    // Step toward the target, wobbling so the result is not a ruler line.
    const dx = Math.sign(bx - x), dy = Math.sign(by - y);
    if (dx && (!dy || rand() < 0.5)) x += dx; else if (dy) y += dy;
    if (rand() < 0.18) { x += (rand() * 3 | 0) - 1; y += (rand() * 3 | 0) - 1; }
    x = Math.max(2, Math.min(MAP_TILES - 3, x));
    y = Math.max(2, Math.min(MAP_TILES - 3, y));
  }
}

/** Land-connects every base to the map centre. */
function connectBases(level, rand) {
  const mid = (MAP_TILES / 2) | 0;
  stampDisc(level, mid, mid, 6, LEVEL.GROUND);
  for (const [cx, cy] of CORNERS) {
    if (!pathExists(level, cx, cy, mid, mid)) carveCorridor(level, cx, cy, mid, mid, rand);
  }
}

/** Re-links any base the lakes and rivers have cut off. */
function ensureConnected(level, rand) {
  const [ax, ay] = CORNERS[0];
  for (let i = 1; i < CORNERS.length; i++) {
    const [bx, by] = CORNERS[i];
    if (pathExists(level, ax, ay, bx, by)) continue;
    carveCorridor(level, bx, by, ax, ay, rand);
  }
}

/** Flood fill over land tiles. */
function pathExists(level, ax, ay, bx, by) {
  if (level[idx(ax, ay)] === LEVEL.WATER || level[idx(bx, by)] === LEVEL.WATER) return false;
  const seen = new Uint8Array(level.length);
  const q = [idx(ax, ay)];
  seen[q[0]] = 1;
  const goal = idx(bx, by);
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    if (i === goal) return true;
    const tx = i % MAP_TILES, ty = (i / MAP_TILES) | 0;
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
function removeIslands(level) {
  const label = new Int32Array(level.length).fill(-1);
  let next = 0;
  for (let i = 0; i < level.length; i++) {
    if (level[i] === LEVEL.WATER || label[i] >= 0) continue;
    const id = next++;
    const q = [i]; label[i] = id;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      const tx = c % MAP_TILES, ty = (c / MAP_TILES) | 0;
      for (const [ox, oy] of N4) {
        const nx = tx + ox, ny = ty + oy;
        if (!inBounds(nx, ny)) continue;
        const j = idx(nx, ny);
        if (label[j] >= 0 || level[j] === LEVEL.WATER) continue;
        label[j] = id; q.push(j);
      }
    }
  }
  const keep = label[idx(CORNERS[0][0], CORNERS[0][1])];
  for (let i = 0; i < level.length; i++) {
    if (level[i] !== LEVEL.WATER && label[i] !== keep) level[i] = LEVEL.WATER;
  }
}

/** Cellular-automaton pass that rounds off jagged one-tile coastal spikes. */
function smoothCoast(level) {
  for (let pass = 0; pass < 2; pass++) {
    const copy = level.slice();
    for (let ty = 1; ty < MAP_TILES - 1; ty++) {
      for (let tx = 1; tx < MAP_TILES - 1; tx++) {
        const i = idx(tx, ty);
        let landCount = 0;
        for (const [ox, oy] of N8) if (copy[idx(tx + ox, ty + oy)] !== LEVEL.WATER) landCount++;
        if (copy[i] === LEVEL.WATER && landCount >= 6) level[i] = LEVEL.GROUND;
        else if (copy[i] !== LEVEL.WATER && landCount <= 2) level[i] = LEVEL.WATER;
      }
    }
  }
  // Hard border of water so the island never touches the map edge.
  for (let i = 0; i < MAP_TILES; i++) {
    for (const j of [0, 1, MAP_TILES - 2, MAP_TILES - 1]) {
      level[idx(i, j)] = LEVEL.WATER;
      level[idx(j, i)] = LEVEL.WATER;
    }
  }
}

// ---------------------------------------------------------------------------
// Inland water
// ---------------------------------------------------------------------------

/** Ragged inland lakes, well clear of anybody's base. */
function carveLakes(level, rand) {
  const count = 3 + ((rand() * 4) | 0);
  const shape = fbm(rand, [[7, 1], [15, 0.5]]);
  for (let n = 0; n < count; n++) {
    let cx = 0, cy = 0, ok = false;
    for (let attempt = 0; attempt < 40 && !ok; attempt++) {
      cx = 8 + ((rand() * (MAP_TILES - 16)) | 0);
      cy = 8 + ((rand() * (MAP_TILES - 16)) | 0);
      ok = level[idx(cx, cy)] === LEVEL.GROUND && !nearAnyBase(cx, cy, BASE_CLEAR + 5);
    }
    if (!ok) continue;
    const r = 3 + rand() * 4;
    const ri = Math.ceil(r) + 2;
    for (let ty = cy - ri; ty <= cy + ri; ty++) {
      for (let tx = cx - ri; tx <= cx + ri; tx++) {
        if (!inBounds(tx, ty) || nearAnyBase(tx, ty, BASE_CLEAR + 1)) continue;
        // Perturb the radius with noise so the shore is not a circle.
        const wobble = (shape(tx / MAP_TILES, ty / MAP_TILES) - 0.5) * 3.4;
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
 * wall, but a river crossed three times gives an attacker a choice and gives a
 * defender something worth holding.
 */
function carveRivers(level, rand) {
  const count = 2 + ((rand() * 3) | 0);
  for (let n = 0; n < count; n++) {
    // Run roughly across the island, so a river actually divides something.
    const horizontal = rand() < 0.5;
    let x = horizontal ? 3 : 8 + ((rand() * (MAP_TILES - 16)) | 0);
    let y = horizontal ? 8 + ((rand() * (MAP_TILES - 16)) | 0) : 3;
    const endX = horizontal ? MAP_TILES - 4 : 8 + ((rand() * (MAP_TILES - 16)) | 0);
    const endY = horizontal ? 8 + ((rand() * (MAP_TILES - 16)) | 0) : MAP_TILES - 4;

    const width = 1 + rand() * 0.7;
    let sinceBridge = 6 + ((rand() * 8) | 0);
    let bridgeLeft = 0;
    let guard = MAP_TILES * 3;

    while (guard-- > 0 && (Math.abs(x - endX) > 1 || Math.abs(y - endY) > 1)) {
      if (bridgeLeft > 0) {
        bridgeLeft--;                       // leave these tiles dry: a crossing
      } else if (!nearAnyBase(x, y, BASE_CLEAR + 3)) {
        stampDisc(level, x, y, width, LEVEL.WATER);
        if (--sinceBridge <= 0) {
          sinceBridge = 9 + ((rand() * 8) | 0);
          bridgeLeft = 4;
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
      x = Math.max(2, Math.min(MAP_TILES - 3, x));
      y = Math.max(2, Math.min(MAP_TILES - 3, y));
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

function placeable(level, blocked, tx, ty) {
  if (!inBounds(tx, ty)) return false;
  const i = idx(tx, ty);
  return level[i] !== LEVEL.WATER && !blocked[i];
}

function placeResources(level, blocked, rand) {
  nextNodeId = 1;
  const nodes = [];
  const put = (kind, tx, ty) => {
    if (!placeable(level, blocked, tx, ty)) return false;
    if (nearAnyBase(tx, ty, 3.2)) return false; // keep the castle plaza clear
    nodes.push(makeNode(kind, tx, ty, rand));
    blocked[idx(tx, ty)] = 1;
    return true;
  };

  // Fair, mirrored allotment around each of the four corners.
  for (let ci = 0; ci < 4; ci++) {
    const [cx, cy] = CORNERS[ci];
    const sx = cx < MAP_TILES / 2 ? 1 : -1;
    const sy = cy < MAP_TILES / 2 ? 1 : -1;
    for (const p of BASE_LAYOUT) {
      // Nudge until it lands somewhere legal, so noisy terrain cannot starve
      // a corner of its guaranteed income.
      for (let attempt = 0; attempt < 14; attempt++) {
        const jx = attempt ? (rand() * 5 | 0) - 2 : 0;
        const jy = attempt ? (rand() * 5 | 0) - 2 : 0;
        if (put(p.kind, cx + sx * p.dx + jx, cy + sy * p.dy + jy)) break;
      }
    }
  }

  // Scattered clusters over the rest of the island.
  for (let n = 0; n < 52; n++) {
    const kind = rand() < 0.62 ? 'wood' : 'gold';
    const tx = 3 + ((rand() * (MAP_TILES - 6)) | 0);
    const ty = 3 + ((rand() * (MAP_TILES - 6)) | 0);
    if (!placeable(level, blocked, tx, ty)) continue;
    const size = kind === 'wood' ? 3 + ((rand() * 7) | 0) : 1 + ((rand() * 3) | 0);
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
function pruneUnreachableNodes(level, blocked, nodes) {
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

function placeDecor(level, blocked, rand) {
  const decor = [];

  // Rocks breaking the surface, thick along every shore and scattered beyond.
  // Rivers and lakes give the island a great deal of shoreline, and this is
  // what stops all that water reading as a flat colour.
  for (let ty = 2; ty < MAP_TILES - 2; ty++) {
    for (let tx = 2; tx < MAP_TILES - 2; tx++) {
      if (level[idx(tx, ty)] !== LEVEL.WATER) continue;
      const coastal = N8.some(([ox, oy]) => level[idx(tx + ox, ty + oy)] !== LEVEL.WATER);
      if (rand() > (coastal ? 0.34 : 0.07)) continue;
      decor.push({
        kind: 'waterRock', variant: (rand() * 4) | 0,
        x: (tx + 0.2 + rand() * 0.6) * TILE,
        y: (ty + 0.2 + rand() * 0.6) * TILE,
        phase: rand() * 4,
      });
    }
  }

  // Ground clutter.
  for (let n = 0; n < 340; n++) {
    const tx = 1 + ((rand() * (MAP_TILES - 2)) | 0);
    const ty = 1 + ((rand() * (MAP_TILES - 2)) | 0);
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
    const tx = 2 + ((rand() * (MAP_TILES - 4)) | 0);
    const ty = 2 + ((rand() * (MAP_TILES - 4)) | 0);
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
