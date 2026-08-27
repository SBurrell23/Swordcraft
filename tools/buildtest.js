// Regression test for the thing that was broken: a peasant told to raise a
// building walking up to it and then wandering off.
//
//   node tools/buildtest.js [seeds]
//
// For each seed it sites one of every building on every legal spot it can find
// around a base, and asserts the crew actually finishes it. The failure it
// guards against was a centre-radius arrival test, which a worker standing on a
// diagonal corner tile could never satisfy - so the interesting cases are the
// sites whose only approach is a corner.

import { generateMap } from '../src/game/mapgen.js';
import { Sim } from '../src/game/sim.js';
import { TICK_DT, BUILDINGS, CMD, MAP_TILES } from '../src/game/consts.js';

const seeds = Number(process.argv[2] || 6);
const KINDS = ['house', 'outpost', 'barracks', 'archery', 'tower'];
/** Generous: a two-tile building is ~190 build points at 12/sec per peasant. */
const PATIENCE_SECONDS = 90;

let attempted = 0, finished = 0, refused = 0;
const failures = [];

// First, the geometry directly: a worker on ANY tile touching a footprint -
// including the four diagonal corners - must read as having arrived. This is
// the precise thing the old centre-radius test got wrong.
{
  const map = generateMap(1);
  const sim = new Sim(map, [{ id: 1, slot: 0, name: 'P1', color: 'Black', ai: false }]);
  const TILE = 64;
  for (const [kind, def] of Object.entries(BUILDINGS)) {
    const [fw, fh] = def.foot;
    const tx = 20, ty = 20;
    for (let y = ty - 1; y <= ty + fh; y++) {
      for (let x = tx - 1; x <= tx + fw; x++) {
        const inside = x >= tx && x < tx + fw && y >= ty && y < ty + fh;
        if (inside) continue;
        const touching = x >= tx - 1 && x <= tx + fw && y >= ty - 1 && y <= ty + fh;
        if (!touching) continue;
        const d = sim.footprintDistance((x + 0.5) * TILE, (y + 0.5) * TILE, tx, ty, def.foot);
        if (d > TILE * 1.1) {
          failures.push(`${kind}: a worker on the adjacent tile ${x - tx},${y - ty} `
            + `reads as ${d.toFixed(0)}px away and would never start work`);
        }
      }
    }
  }
}

for (let s = 0; s < seeds; s++) {
  const seed = 4000 + s * 1237;
  const map = generateMap(seed);

  for (const kind of KINDS) {
    const def = BUILDINGS[kind];
    const sim = new Sim(map, [{ id: 1, slot: 0, name: 'P1', color: 'Black', ai: false }]);
    const player = sim.players.get(1);
    // Plenty of everything, so only reachability is under test.
    for (const r of Object.keys(player.res)) player.res[r] = 100000;
    player.popCap = 200;

    const spot = findSpot(sim, def.foot);
    if (!spot) continue;

    const before = sim.buildings.size;
    sim.applyCommand({ t: CMD.BUILD, kind, tx: spot[0], ty: spot[1], u: [] }, 1);
    if (sim.buildings.size === before) { refused++; continue; }
    attempted++;

    const site = [...sim.buildings.values()].find((b) => b.kind === kind && !b.done);
    let done = false;
    for (let t = 0; t < PATIENCE_SECONDS / TICK_DT && !done; t++) {
      sim.step(TICK_DT);
      sim.drainEvents();
      done = !!site && site.done;
    }

    if (done) {
      finished++;
    } else {
      const progress = site ? Math.round((site.progress / def.buildPoints) * 100) : -1;
      failures.push(`seed ${seed} ${kind} at ${spot} stalled at ${progress}%`);
    }
  }
}

console.log(`sited ${attempted} buildings across ${seeds} maps`);
console.log(`finished: ${finished}`);
console.log(`refused as unreachable at placement time: ${refused}`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
console.log('every sited building was completed by its crew');

/** First legal footprint on a ring around the starting base. */
function findSpot(sim, foot) {
  const [cx, cy] = [sim.map.starts[0].tx, sim.map.starts[0].ty];
  for (let r = 4; r < 14; r++) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const tx = Math.round(cx + Math.cos(a) * r);
      const ty = Math.round(cy + Math.sin(a) * r);
      if (tx < 1 || ty < 1 || tx + foot[0] >= MAP_TILES || ty + foot[1] >= MAP_TILES) continue;
      if (sim.footprintFree(tx, ty, foot) && sim.hasApproach(tx, ty, foot)) return [tx, ty];
    }
  }
  return null;
}
