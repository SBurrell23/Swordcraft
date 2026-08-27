// Headless soak test for the simulation.
//   node tools/simtest.js [minutes] [seed]
// Runs a four-way AI match with no renderer and reports what happened, which
// catches logic and performance problems long before a browser is involved.

import { generateMap } from '../src/game/mapgen.js';
import { Sim } from '../src/game/sim.js';
import { AI } from '../src/game/ai.js';
import { TICK_DT, ST, RESOURCES } from '../src/game/consts.js';
import { encodeSnapshot } from '../src/net/protocol.js';

const ST_NAME = Object.fromEntries(Object.entries(ST).map(([k, v]) => [v, k]));

const minutes = Number(process.argv[2] || 5);
const seed = Number(process.argv[3] || 12345);

const map = generateMap(seed);
const players = [0, 1, 2, 3].map((slot) => ({
  id: slot + 1, slot, name: 'AI ' + (slot + 1),
  color: ['Blue', 'Red', 'Yellow', 'Purple'][slot], ai: true,
}));

const sim = new Sim(map, players);
const ais = players.map((p) => new AI(sim, p.id, 'normal'));
const nodeShadow = new Map();

const ticks = Math.round((minutes * 60) / TICK_DT);
let maxTickMs = 0, totalMs = 0, maxSnapshot = 0, events = 0;
const started = Date.now();

for (let t = 0; t < ticks && !sim.over; t++) {
  const t0 = process.hrtime.bigint();
  for (const ai of ais) ai.update(TICK_DT);
  sim.step(TICK_DT);
  events += sim.drainEvents().length;
  if (t % 2 === 0) maxSnapshot = Math.max(maxSnapshot, encodeSnapshot(sim, nodeShadow).byteLength);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  maxTickMs = Math.max(maxTickMs, ms);
  totalMs += ms;

  if (t % Math.round(30 / TICK_DT) === 0) {
    const line = [...sim.players.values()].map((p) =>
      `${p.name.replace('AI ', 'P')}${p.alive ? '' : '(out)'}:` +
      `${countUnits(p.id)}u/${countBuildings(p.id)}b ` +
      RESOURCES.map((r) => r[0] + Math.round(p.res[r])).join(' ') + ' ' +
      `pop${p.pop}/${p.popCap} ${pawnSummary(p.id)}`).join('  |  ');
    console.log(`t=${(t * TICK_DT).toFixed(0).padStart(4)}s  ${line}`);
  }
}

/** Compact census of a player's drones: how many, and what they are doing. */
function pawnSummary(id) {
  const counts = new Map();
  let n = 0;
  for (const u of sim.units.values()) {
    if (u.owner !== id || u.type !== 'pawn') continue;
    n++;
    const key = ST_NAME[u.st] || u.st;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const detail = [...counts].map(([k, v]) => k.replace('GATHER_', 'G').replace('BUILD_', 'B') + v).join(',');
  return `[${n}p ${detail}]`;
}

function countUnits(id) {
  let n = 0;
  for (const u of sim.units.values()) if (u.owner === id) n++;
  return n;
}
function countBuildings(id) {
  let n = 0;
  for (const b of sim.buildings.values()) if (b.owner === id) n++;
  return n;
}

const simSeconds = sim.time;
console.log('\n--- summary ---');
console.log(`simulated ${simSeconds.toFixed(0)}s in ${((Date.now() - started) / 1000).toFixed(1)}s wall`);
console.log(`tick cost: avg ${(totalMs / Math.max(1, sim.tick)).toFixed(2)}ms, worst ${maxTickMs.toFixed(2)}ms (budget ${(TICK_DT * 1000).toFixed(0)}ms)`);
console.log(`largest snapshot: ${(maxSnapshot / 1024).toFixed(1)} KiB  ->  ${(maxSnapshot * 10 / 1024).toFixed(0)} KiB/s per peer at 10 Hz`);
console.log(`events emitted: ${events}`);
console.log(`units alive: ${sim.units.size}, buildings: ${sim.buildings.size}, projectiles: ${sim.projectiles.length}`);
console.log(`game over: ${sim.over}${sim.over ? ', winner player ' + sim.winner : ''}`);
for (const p of sim.players.values()) {
  console.log(`  ${p.name}: alive=${p.alive} units=${countUnits(p.id)} buildings=${countBuildings(p.id)}`);
}
