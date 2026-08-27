// Worst case for the population cap:
//   node tools/popstress.js [seconds]
// Fills every player to MAX_POP_CAP with a realistic army mix and runs them
// into each other, so the cost of a full-cap fight is measured rather than
// guessed. A four-way match that actually reaches the ceiling is rare in a
// soak test - the AIs kill each other first - but two humans can arrange it.

import { generateMap } from '../src/game/mapgen.js';
import { Sim } from '../src/game/sim.js';
import { TICK_DT, MAX_POP_CAP, UNITS, CMD, TILE, MAP_TILES } from '../src/game/consts.js';
import { encodeSnapshot } from '../src/net/protocol.js';
import { COLORS } from '../src/game/assets.js';

const seconds = Number(process.argv[2] || 60);
const seed = Number(process.argv[3] || 4242);

const map = generateMap(seed);
const players = [0, 1, 2, 3].map((slot) => ({
  id: slot + 1, slot, name: 'P' + (slot + 1),
  color: COLORS[slot], ai: true,
}));
const sim = new Sim(map, players);

// The armies are placed on top of each other in the middle of the map rather
// than in their corners: crossing the island would eat the whole run, and it is
// the fight itself - targeting, projectiles, collision - that costs anything.
const mid = (MAP_TILES * TILE) / 2;
const arena = findOpenGround(mid, mid);

/** Nearest tile centre to (x, y) that a unit can stand on. */
function findOpenGround(x, y) {
  for (let r = 0; r < MAP_TILES; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const px = x + dx * TILE, py = y + dy * TILE;
        if (sim.walkableAt(px, py, { x: px, y: py })) return [px, py];
      }
    }
  }
  throw new Error('no open ground near the middle of the map');
}

// 14 peasants + soldiers until the cap is spent - the shape a maxed player has.
const MIX = ['warrior', 'archer', 'lancer', 'monk'];
for (const p of sim.players.values()) {
  const face = (p.slot / 4) * Math.PI * 2;
  const home = [arena[0] + Math.cos(face) * TILE * 5, arena[1] + Math.sin(face) * TILE * 5];
  let pop = 0, i = 0;
  while (pop + 2 <= MAX_POP_CAP) {
    const type = pop < 14 ? 'peasant' : MIX[i++ % MIX.length];
    const a = i * 2.399, r = 20 + Math.sqrt(i) * 22;
    sim.addUnit(p.id, type, home[0] + Math.cos(a) * r, home[1] + Math.sin(a) * r);
    pop += UNITS[type].pop;
  }
  p.res.wood = 5000; p.res.gold = 5000;
  p.popCap = MAX_POP_CAP;
}
sim.recomputePop();
for (const p of sim.players.values()) p.popCap = MAX_POP_CAP;

// Everyone attack-moves into the middle, so all four armies meet at once.
for (const p of sim.players.values()) {
  const ids = [...sim.units.values()]
    .filter((u) => u.owner === p.id && u.type !== 'peasant').map((u) => u.id);
  sim.applyCommand(p.id, { t: CMD.ATTACK_MOVE, u: ids, x: arena[0], y: arena[1] });
}

const counts = {};
for (const u of sim.units.values()) counts[u.owner] = (counts[u.owner] || 0) + 1;
console.log('seeded', [...sim.units.values()].length, 'units;',
  [...sim.players.values()].map((p) => `${p.name} ${p.pop}/${p.popCap} (${counts[p.id]}u)`).join('  '));

const ticks = Math.round(seconds / TICK_DT);
const shadow = new Map();
let worst = 0, total = 0, maxSnap = 0, peakUnits = 0, peakId = 0;
for (let t = 0; t < ticks && !sim.over; t++) {
  const t0 = process.hrtime.bigint();
  sim.step(TICK_DT);
  sim.drainEvents();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  worst = Math.max(worst, ms); total += ms;
  if (t % 2 === 0) maxSnap = Math.max(maxSnap, encodeSnapshot(sim, shadow).byteLength);
  peakUnits = Math.max(peakUnits, sim.units.size);
  for (const u of sim.units.values()) peakId = Math.max(peakId, u.id);
  if (t % Math.round(10 / TICK_DT) === 0) {
    console.log(`t=${String(Math.round(t * TICK_DT)).padStart(4)}s  units=${sim.units.size}` +
      `  projectiles=${sim.projectiles.length}  worstTick=${worst.toFixed(2)}ms`);
  }
}
console.log('\n--- summary ---');
console.log(`peak units: ${peakUnits}, highest id in play: ${peakId}`);
console.log(`tick cost: avg ${(total / ticks).toFixed(2)}ms, worst ${worst.toFixed(2)}ms (budget ${(TICK_DT * 1000).toFixed(0)}ms)`);
console.log(`largest snapshot: ${(maxSnap / 1024).toFixed(1)} KiB  ->  ${(maxSnap * 10 / 1024).toFixed(0)} KiB/s per peer at 10 Hz`);
