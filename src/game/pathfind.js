// Tile-grid pathfinding.
//
// Units live in continuous world space but plan on the 64px tile grid. Water
// is impassable, so lakes and rivers funnel armies onto the land bridges.
//
// A* is not cheap when four players each order fifty units at once, so
// requests go through a budgeted queue and finished paths are cached briefly
// and shared by everyone heading to the same tile.

import { MAP_TILES, TILE } from './consts.js';
import { canStep } from './mapgen.js';

const N8 = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** Binary min-heap keyed by an f-score array; stores tile indices. */
class Heap {
  constructor(score) { this.a = []; this.score = score; }
  get size() { return this.a.length; }
  clear() { this.a.length = 0; }
  push(v) {
    const a = this.a, s = this.score;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (s[a[p]] <= s[a[i]]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, s = this.score;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && s[a[l]] < s[a[m]]) m = l;
        if (r < a.length && s[a[r]] < s[a[m]]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Navigation view over a map: terrain plus whatever currently occupies tiles
 * (buildings, resource nodes). Rebuilt lazily whenever occupancy changes.
 */
export class NavGrid {
  /** @param {import('./mapgen.js').GameMap} map */
  constructor(map) {
    this.map = map;
    this.n = MAP_TILES * MAP_TILES;
    /** 1 where something solid stands on the tile. */
    this.occupied = new Uint8Array(this.n);
    this.occupied.set(map.blocked);
    /** Bumped whenever occupancy changes, to invalidate cached paths. */
    this.version = 1;

    // Scratch buffers, reused between searches so A* allocates nothing.
    this.g = new Float64Array(this.n);
    this.f = new Float64Array(this.n);
    this.came = new Int32Array(this.n);
    this.stamp = new Int32Array(this.n);
    this.closed = new Int32Array(this.n);
    this.run = 0;
    this.heap = new Heap(this.f);

    this.cache = new Map();
    this.queue = [];
  }

  setOccupied(tx, ty, on) {
    if (tx < 0 || ty < 0 || tx >= MAP_TILES || ty >= MAP_TILES) return;
    const i = ty * MAP_TILES + tx;
    const want = on ? 1 : (this.map.blocked[i] ? 1 : 0);
    if (this.occupied[i] === want) return;
    this.occupied[i] = want;
    this.version++;
    this.cache.clear();
  }

  /** True when a unit may stand on this tile at all. */
  passable(i) {
    return !this.occupied[i] && this.map.level[i] !== 0;
  }

  /** True when a unit may step from tile `a` to adjacent tile `b`. */
  stepOk(a, b) {
    if (!this.passable(b)) return false;
    return canStep(this.map.level, a, b);
  }

  /**
   * Diagonal moves also require both shared orthogonal neighbours to be legal,
   * so units never clip a cliff corner or squeeze between two buildings.
   */
  diagonalOk(tx, ty, ox, oy, from) {
    const a = ty * MAP_TILES + (tx + ox);
    const b = (ty + oy) * MAP_TILES + tx;
    return this.stepOk(from, a) && this.stepOk(from, b);
  }

  /**
   * A* between two tile indices.
   * @returns {number[]|null} tile indices from start (exclusive) to goal
   */
  findPath(start, goal, maxExpansions = 4500) {
    if (start === goal) return [];
    const { g, f, came, closed, heap } = this;
    const run = ++this.run;
    const stamp = this.stamp;

    // If the goal itself is blocked, aim at the nearest tile that is not.
    if (!this.passable(goal)) {
      const alt = this.nearestOpen(goal, 6);
      if (alt < 0) return null;
      goal = alt;
      if (start === goal) return [];
    }

    const gx = goal % MAP_TILES, gy = (goal / MAP_TILES) | 0;
    const h = (i) => {
      const dx = Math.abs((i % MAP_TILES) - gx), dy = Math.abs(((i / MAP_TILES) | 0) - gy);
      // Octile distance: exact for 8-way movement, so A* stays admissible.
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };

    heap.clear();
    stamp[start] = run; closed[start] = 0;
    g[start] = 0; f[start] = h(start); came[start] = -1;
    heap.push(start);

    let expansions = 0;
    let best = start, bestH = f[start];

    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === run) continue;
      closed[cur] = run;

      if (cur === goal) return this.reconstruct(came, start, goal);
      if (++expansions > maxExpansions) break;

      const cx = cur % MAP_TILES, cy = (cur / MAP_TILES) | 0;
      for (const [ox, oy, cost] of N8) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= MAP_TILES || ny >= MAP_TILES) continue;
        const nb = ny * MAP_TILES + nx;
        if (closed[nb] === run) continue;
        if (!this.stepOk(cur, nb)) continue;
        if (ox && oy && !this.diagonalOk(cx, cy, ox, oy, cur)) continue;

        const ng = g[cur] + cost;
        if (stamp[nb] === run && ng >= g[nb]) continue;
        stamp[nb] = run;
        g[nb] = ng;
        f[nb] = ng + h(nb);
        came[nb] = cur;
        heap.push(nb);
        if (h(nb) < bestH) { bestH = h(nb); best = nb; }
      }
    }

    // Unreachable or budget exhausted: walk as far toward it as we can.
    return best === start ? null : this.reconstruct(came, start, best);
  }

  reconstruct(came, start, goal) {
    const out = [];
    for (let i = goal; i !== start && i >= 0; i = came[i]) out.push(i);
    out.reverse();
    return out;
  }

  /** Spiral outward from a tile looking for somewhere a unit could stand. */
  nearestOpen(i, maxRadius = 8) {
    if (this.passable(i)) return i;
    const cx = i % MAP_TILES, cy = (i / MAP_TILES) | 0;
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= MAP_TILES || ny >= MAP_TILES) continue;
          const j = ny * MAP_TILES + nx;
          if (this.passable(j)) return j;
        }
      }
    }
    return -1;
  }

  /**
   * The closest tile a unit can stand on immediately outside a footprint.
   * Resource nodes and buildings both block their own tiles, so this - not the
   * target's centre - is what a worker should actually be routed to.
   *
   * @returns {number} tile index, or -1 if nothing beside it is standable
   */
  nearestApproach(tx, ty, foot, fromX, fromY, maxRing = 3) {
    for (let ring = 1; ring <= maxRing; ring++) {
      let best = -1, bestD = Infinity;
      const x0 = tx - ring, x1 = tx + foot[0] - 1 + ring;
      const y0 = ty - ring, y1 = ty + foot[1] - 1 + ring;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          // Only the perimeter of this ring is new.
          if (x > x0 && x < x1 && y > y0 && y < y1) continue;
          if (x < 0 || y < 0 || x >= MAP_TILES || y >= MAP_TILES) continue;
          const i = y * MAP_TILES + x;
          if (!this.passable(i)) continue;
          const d = ((x + 0.5) * TILE - fromX) ** 2 + ((y + 0.5) * TILE - fromY) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Straight-line walkability between two world points, used to shorten paths
   * and to let units skip waypoints they can already see past.
   */
  lineOfWalk(x0, y0, x1, y1) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (TILE * 0.5));
    if (steps <= 1) return true;
    let prev = tileIndexAt(x0, y0);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const i = tileIndexAt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      if (i === prev) continue;
      const px = prev % MAP_TILES, py = (prev / MAP_TILES) | 0;
      const nx = i % MAP_TILES, ny = (i / MAP_TILES) | 0;
      if (Math.abs(px - nx) + Math.abs(py - ny) > 1) {
        // Cutting a corner: both orthogonal neighbours must also be open.
        if (!this.stepOk(prev, py * MAP_TILES + nx)) return false;
        if (!this.stepOk(prev, ny * MAP_TILES + px)) return false;
      }
      if (!this.stepOk(prev, i)) return false;
      prev = i;
    }
    return true;
  }

  /** Drops waypoints that a straight walk already covers. */
  smooth(path, fromX, fromY) {
    if (path.length < 2) return path;
    const out = [];
    let cx = fromX, cy = fromY;
    let i = 0;
    while (i < path.length) {
      // Look ahead for the furthest waypoint still in plain sight.
      let j = path.length - 1;
      for (; j > i; j--) {
        const [wx, wy] = tileCenter(path[j]);
        if (this.lineOfWalk(cx, cy, wx, wy)) break;
      }
      out.push(path[j]);
      [cx, cy] = tileCenter(path[j]);
      i = j + 1;
    }
    return out;
  }

  // -- Budgeted request queue ------------------------------------------------

  /**
   * Queues a path request. The callback fires within a few ticks with the
   * smoothed waypoint list (or null if there is no way through).
   */
  request(fromX, fromY, goalTile, callback, priority = 0) {
    this.queue.push({ fromX, fromY, goalTile, callback, priority });
  }

  /** Serves up to `budget` queued requests. Called once per simulation tick. */
  serve(budget = 12) {
    if (!this.queue.length) return;
    // Highest priority first; combat repathing should not wait behind workers.
    if (this.queue.length > budget) this.queue.sort((a, b) => b.priority - a.priority);
    const batch = this.queue.splice(0, budget);
    for (const req of batch) {
      const start = tileIndexAt(req.fromX, req.fromY);
      const key = start * this.n + req.goalTile;
      let path = this.cache.get(key);
      if (path === undefined) {
        path = this.findPath(start, req.goalTile);
        if (path) path = this.smooth(path, req.fromX, req.fromY);
        if (this.cache.size > 900) this.cache.clear();
        this.cache.set(key, path);
      }
      req.callback(path ? path.slice() : null);
    }
  }

  clearQueue() { this.queue.length = 0; }
}

/** World position -> tile index. */
export function tileIndexAt(x, y) {
  const tx = Math.max(0, Math.min(MAP_TILES - 1, (x / TILE) | 0));
  const ty = Math.max(0, Math.min(MAP_TILES - 1, (y / TILE) | 0));
  return ty * MAP_TILES + tx;
}

/** Tile index -> world centre. */
export function tileCenter(i) {
  return [((i % MAP_TILES) + 0.5) * TILE, (((i / MAP_TILES) | 0) + 0.5) * TILE];
}
