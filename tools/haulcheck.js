// Diagnostic: how far do self-tasked peasants walk for a load?
//   node tools/haulcheck.js [minutes]
// A peasant hauls its load to the nearest base, so the distance that matters is
// node-to-base, not node-to-wherever-it-was-standing. This prints that
// distribution, and how much unworked resource was sitting closer.
import { generateMap } from '../src/game/mapgen.js';
import { Sim } from '../src/game/sim.js';
import { AI } from '../src/game/ai.js';
import { TICK_DT, TILE, NODE_SLOTS } from '../src/game/consts.js';
import { COLORS } from '../src/game/assets.js';

const minutes = Number(process.argv[2] || 8);
const map = generateMap(Number(process.argv[3] || 12345), 4);
const players = [0, 1, 2, 3].map((slot) => ({
  id: slot + 1, slot, name: 'P' + (slot + 1), color: COLORS[slot], ai: true,
}));
const sim = new Sim(map, players);
const ais = players.map((p) => new AI(sim, p.id, 'normal'));

const hauls = [];          // tiles from node to that peasant's nearest base
let strandedSamples = 0;   // times a peasant worked far while near seams were free

for (let t = 0, ticks = Math.round((minutes * 60) / TICK_DT); t < ticks && !sim.over; t++) {
  for (const ai of ais) ai.update(TICK_DT);
  sim.step(TICK_DT);
  sim.drainEvents();

  if (t % Math.round(5 / TICK_DT)) continue;
  for (const u of sim.units.values()) {
    if (u.type !== 'peasant' || !u.autoTasked || !u.nodeId) continue;
    const node = sim.nodes.get(u.nodeId);
    const drop = sim.nearestDropoff(u);
    if (!node || !drop) continue;
    const d = Math.hypot(node.x - drop.x, node.y - drop.y) / TILE;
    hauls.push(d);
    // Was there a free seam of the same kind closer to that base?
    let nearer = 0;
    for (const n of sim.nodes.values()) {
      if (n.amount <= 0 || n.workers >= NODE_SLOTS[n.kind]) continue;
      if (Math.hypot(n.x - drop.x, n.y - drop.y) / TILE < d - 4) nearer++;
    }
    if (nearer) strandedSamples++;
  }
}

hauls.sort((a, b) => a - b);
const pct = (p) => hauls[Math.min(hauls.length - 1, Math.floor(hauls.length * p))].toFixed(1);
console.log(`${hauls.length} samples over ${minutes} minutes`);
console.log(`haul distance from the worker's own base, in tiles:`);
console.log(`  median ${pct(0.5)}   p90 ${pct(0.9)}   p99 ${pct(0.99)}   worst ${hauls[hauls.length - 1].toFixed(1)}`);
console.log(`  over 20 tiles: ${hauls.filter((d) => d > 20).length} (${(hauls.filter((d) => d > 20).length / hauls.length * 100).toFixed(1)}%)`);
console.log(`  over 30 tiles: ${hauls.filter((d) => d > 30).length} (${(hauls.filter((d) => d > 30).length / hauls.length * 100).toFixed(1)}%)`);
console.log(`samples where a free seam sat 4+ tiles closer to that base: ` +
  `${strandedSamples} (${(strandedSamples / hauls.length * 100).toFixed(1)}%)`);
