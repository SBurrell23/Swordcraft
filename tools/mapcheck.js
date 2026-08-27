// Offline sanity check for the map generator.
//   node tools/mapcheck.js [seedCount]
// Prints an ASCII preview of the first map plus connectivity and fairness
// stats for the rest. Water is impassable, so the thing worth checking is that
// the lakes and rivers never cut a base off from the fight.
import { generateMap, CORNERS, canStep } from '../src/game/mapgen.js';
import { MAP_TILES, LEVEL } from '../src/game/consts.js';

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const idx = (x, y) => y * MAP_TILES + x;

function reachableFrom(map, sx, sy) {
  const seen = new Uint8Array(map.level.length);
  const q = [idx(sx, sy)];
  seen[q[0]] = 1;
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const tx = i % MAP_TILES, ty = (i / MAP_TILES) | 0;
    for (const [ox, oy] of N4) {
      const nx = tx + ox, ny = ty + oy;
      if (nx < 0 || ny < 0 || nx >= MAP_TILES || ny >= MAP_TILES) continue;
      const j = idx(nx, ny);
      if (seen[j] || !canStep(map.level, i, j)) continue;
      seen[j] = 1; q.push(j);
    }
  }
  return seen;
}

const count = Number(process.argv[2] || 8);
let firstShown = false;

for (let s = 0; s < count; s++) {
  const seed = 1000 + s * 7919;
  const t0 = Date.now();
  const map = generateMap(seed);
  const ms = Date.now() - t0;

  const reach = reachableFrom(map, CORNERS[0][0], CORNERS[0][1]);
  const cornersOk = CORNERS.every(([x, y]) => reach[idx(x, y)]);

  let water = 0, land = 0, landReach = 0;
  for (let i = 0; i < map.level.length; i++) {
    if (map.level[i] === LEVEL.WATER) { water++; continue; }
    land++;
    if (reach[i]) landReach++;
  }
  const byKind = { wood: 0, gold: 0 };
  for (const n of map.nodes) byKind[n.kind]++;
  const rocks = map.decor.filter((d) => d.kind === 'waterRock').length;

  // Per-corner fairness: nodes within 12 tiles of each base.
  const near = CORNERS.map(([cx, cy]) => {
    const c = { wood: 0, gold: 0 };
    for (const n of map.nodes) {
      if ((n.tx - cx) ** 2 + (n.ty - cy) ** 2 <= 144) c[n.kind]++;
    }
    return `${c.wood}w/${c.gold}g`;
  });

  console.log(
    `seed ${seed}  ${ms}ms  corners=${cornersOk ? 'OK ' : 'FAIL'}  ` +
    `water=${water} land=${land} reachable=${landReach}/${land} ` +
    `nodes=${map.nodes.length} (${byKind.wood}w ${byKind.gold}g) ` +
    `waterRocks=${rocks}  near=[${near.join(' ')}]`);

  if (!firstShown) {
    firstShown = true;
    const nodeAt = new Map();
    for (const n of map.nodes) nodeAt.set(idx(n.tx, n.ty), n.kind[0].toUpperCase());
    let out = '';
    for (let y = 0; y < MAP_TILES; y++) {
      for (let x = 0; x < MAP_TILES; x++) {
        const i = idx(x, y);
        const isCorner = CORNERS.some(([cx, cy]) => Math.abs(cx - x) < 2 && Math.abs(cy - y) < 2);
        if (isCorner) out += '@';
        else if (nodeAt.has(i)) out += nodeAt.get(i);
        else if (map.level[i] === LEVEL.WATER) out += '~';
        else if (!reach[i]) out += '!';        // land no base can walk to
        else out += '.';
      }
      out += '\n';
    }
    console.log(out);
  }
}
