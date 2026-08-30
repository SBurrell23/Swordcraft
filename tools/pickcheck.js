// Does a self-directed peasant take the near seam or jog across the island?
//   node tools/pickcheck.js
// Builds a contrived board: the resource the player is short of sits far away,
// a seam of the other kind sits right next to the base. A peasant should take
// the near one - the whole point is that a preference is not a compulsion.
import { generateMap } from '../src/game/mapgen.js';
import { Sim } from '../src/game/sim.js';
import { TILE } from '../src/game/consts.js';
import { COLORS } from '../src/game/assets.js';

const map = generateMap(4242, 2);
const sim = new Sim(map, [
  { id: 1, slot: 0, name: 'P1', color: COLORS[0], ai: false },
  { id: 2, slot: 1, name: 'P2', color: COLORS[1], ai: true },
]);

const me = sim.players.get(1);
let castle = null;
for (const b of sim.buildings.values()) if (b.owner === 1 && b.kind === 'castle') castle = b;

// Strip the map of resources so only the two we plant are in play.
for (const n of [...sim.nodes.values()]) sim.nodes.delete(n.id);

let nextId = 9000;
const plant = (kind, tilesAway, dir) => {
  const n = {
    id: nextId++, kind,
    tx: Math.round(castle.tx + dir[0] * tilesAway), ty: Math.round(castle.ty + dir[1] * tilesAway),
    x: castle.x + dir[0] * tilesAway * TILE, y: castle.y + dir[1] * tilesAway * TILE,
    amount: 9999, max: 9999, variant: 0, phase: 0, workers: 0,
  };
  sim.nodes.set(n.id, n);
  return n;
};

// A preference is a tilt, not a compulsion: the wanted resource wins while it
// is roughly comparable in distance, and loses once it is a trek.
const cases = [
  { label: 'want wood: wood 30 out, gold 4 away  ', wood: 30, gold: 4, short: 'wood', expect: 'gold' },
  { label: 'want wood: wood 6 out, gold 4 away   ', wood: 6, gold: 4, short: 'wood', expect: 'wood' },
  { label: 'want wood: wood 12 out, gold 4 away  ', wood: 12, gold: 4, short: 'wood', expect: 'gold' },
  { label: 'want gold: gold 28 out, wood 3 away  ', wood: 3, gold: 28, short: 'gold', expect: 'wood' },
  { label: 'want gold: gold 5 out, wood 4 away   ', wood: 4, gold: 5, short: 'gold', expect: 'gold' },
];

let failures = 0;
for (const c of cases) {
  for (const n of [...sim.nodes.values()]) sim.nodes.delete(n.id);
  plant('wood', c.wood, [1, 0]);
  plant('gold', c.gold, [0, 1]);
  // Make the "short" resource the one the weighting will want most.
  me.res.wood = c.short === 'wood' ? 0 : 4000;
  me.res.gold = c.short === 'gold' ? 0 : 4000;

  let peasant = null;
  for (const u of sim.units.values()) if (u.owner === 1 && u.type === 'peasant') peasant = u;
  peasant.x = castle.x; peasant.y = castle.y;
  sim.clearWork(peasant);
  sim.autoAssignPeasant(peasant);

  const chose = sim.nodes.get(peasant.nodeId);
  const dist = chose ? Math.round(Math.hypot(chose.x - castle.x, chose.y - castle.y) / TILE) : -1;
  const ok = chose && chose.kind === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.label} expect ${c.expect} -> ` +
    `took ${chose ? chose.kind : 'nothing'} at ${dist} tiles`);
}

console.log(failures ? `${failures} case(s) chose badly` : 'every case took the sensible seam');
process.exit(failures ? 1 : 0);
