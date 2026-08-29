// Wire format.
//
// Lobby traffic, commands and effect events are small and bursty, so they ride
// as plain objects. World snapshots are neither: at ten a second with four
// players' armies on the field, JSON would be a few hundred kilobytes per
// second per peer. Those get a hand-packed binary layout instead, which brings
// a full 240-unit snapshot down to about four kilobytes.

import { RESOURCES } from '../game/consts.js';

/** Message discriminators for object messages. */
export const MSG = {
  JOIN: 'join',
  LOBBY: 'lobby',
  START: 'start',
  CMD: 'cmd',
  EVENTS: 'events',
  CHAT: 'chat',
  PING: 'ping',
  PONG: 'pong',
  SEAT: 'seat',
  KICK: 'kick',
  FULL: 'full',
  LEAVE: 'leave',
};

/** First byte of a binary frame. */
const SNAPSHOT = 1;

const UNIT_TYPES = ['peasant', 'warrior', 'lancer', 'archer', 'monk'];
const BUILDING_KINDS = ['castle', 'house', 'barracks', 'archery', 'monastery', 'tower', 'outpost'];

/** Which resource a peasant is currently working, for its tool animation. */
const WORK_KINDS = ['', 'wood', 'gold'];
const WORK_INDEX = { wood: 1, gold: 2 };

const UNIT_INDEX = Object.fromEntries(UNIT_TYPES.map((t, i) => [t, i]));
const BUILDING_INDEX = Object.fromEntries(BUILDING_KINDS.map((k, i) => [k, i]));

const BYTES_PER_UNIT = 14;
const BYTES_PER_BUILDING = 11;
const BYTES_PER_PROJECTILE = 6;
const BYTES_PER_PLAYER = 12;
const BYTES_PER_NODE = 4;

/**
 * Packs the authoritative state into a transferable buffer.
 * @param {import('../game/sim.js').Sim} sim
 * @param {Map<number, number>} nodeShadow last-sent amount per node id
 * @returns {ArrayBuffer}
 */
export function encodeSnapshot(sim, nodeShadow) {
  // Only resource nodes whose amount actually moved are worth resending.
  const changedNodes = [];
  for (const n of sim.nodes.values()) {
    if (nodeShadow.get(n.id) !== n.amount) {
      changedNodes.push(n);
      nodeShadow.set(n.id, n.amount);
    }
  }

  const units = [...sim.units.values()];
  const buildings = [...sim.buildings.values()];
  const players = [...sim.players.values()];
  const projectiles = sim.projectiles;

  const size = 16
    + players.length * BYTES_PER_PLAYER
    + units.length * BYTES_PER_UNIT
    + buildings.length * BYTES_PER_BUILDING
    + projectiles.length * BYTES_PER_PROJECTILE
    + changedNodes.length * BYTES_PER_NODE;

  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;

  v.setUint8(o, SNAPSHOT); o += 1;
  v.setUint8(o, players.length); o += 1;
  v.setUint32(o, sim.tick); o += 4;
  v.setUint16(o, units.length); o += 2;
  v.setUint16(o, buildings.length); o += 2;
  v.setUint16(o, projectiles.length); o += 2;
  v.setUint16(o, changedNodes.length); o += 2;
  v.setUint16(o, 0); o += 2; // reserved, keeps the header 16 bytes

  for (const p of players) {
    v.setUint8(o, p.id); o += 1;
    v.setUint8(o, p.alive ? 1 : 0); o += 1;
    v.setUint16(o, Math.min(65535, p.pop)); o += 2;
    v.setUint16(o, Math.min(65535, p.popCap)); o += 2;
    for (const r of RESOURCES) {
      v.setUint16(o, Math.max(0, Math.min(65535, Math.round(p.res[r] || 0)))); o += 2;
    }
  }

  for (const u of units) {
    v.setUint16(o, u.id); o += 2;
    v.setUint8(o, u.owner); o += 1;
    v.setUint8(o, UNIT_INDEX[u.type]); o += 1;
    v.setInt16(o, Math.round(u.x)); o += 2;
    v.setInt16(o, Math.round(u.y)); o += 2;
    v.setUint16(o, Math.max(0, Math.round(u.hp))); o += 2;
    v.setUint8(o, u.st); o += 1;
    v.setUint8(o, u.frame & 0xff); o += 1;
    v.setUint8(o, angleToByte(u.dir)); o += 1;
    v.setUint8(o, (u.flip ? 1 : 0) | (u.carryKind << 1) | (u.guarding ? 8 : 0)
      | (WORK_INDEX[u.workKind] || 0) << 4); o += 1;
  }

  for (const b of buildings) {
    v.setUint16(o, b.id); o += 2;
    v.setUint8(o, b.owner); o += 1;
    v.setUint8(o, BUILDING_INDEX[b.kind]); o += 1;
    v.setUint8(o, b.tx); o += 1;
    v.setUint8(o, b.ty); o += 1;
    v.setUint16(o, Math.max(0, Math.round(b.hp))); o += 2;
    const pct = b.def.buildPoints
      ? Math.round(Math.min(1, b.progress / b.def.buildPoints) * 255) : 255;
    v.setUint8(o, pct); o += 1;
    v.setUint8(o, (b.done ? 1 : 0) | (b.variant << 1) | (b.paused ? 16 : 0)); o += 1;
    // How far along the next unit is, so every peer shows the same countdown.
    const spawn = b.def.interval
      ? 1 - Math.max(0, Math.min(1, b.spawnT / b.def.interval)) : 0;
    v.setUint8(o, Math.round(spawn * 255)); o += 1;
  }

  for (const p of projectiles) {
    v.setInt16(o, Math.round(p.x)); o += 2;
    v.setInt16(o, Math.round(p.y)); o += 2;
    v.setUint8(o, angleToByte(p.dir)); o += 1;
    v.setUint8(o, p.owner); o += 1;
  }

  for (const n of changedNodes) {
    v.setUint16(o, n.id); o += 2;
    v.setUint16(o, Math.max(0, n.amount)); o += 2;
  }

  return buf;
}

/**
 * Unpacks a snapshot into plain arrays for the client-side world.
 * @param {ArrayBuffer} buf
 */
export function decodeSnapshot(buf) {
  const v = new DataView(buf);
  let o = 0;
  if (v.getUint8(o) !== SNAPSHOT) return null;
  o += 1;
  const playerCount = v.getUint8(o); o += 1;
  const tick = v.getUint32(o); o += 4;
  const unitCount = v.getUint16(o); o += 2;
  const buildingCount = v.getUint16(o); o += 2;
  const projectileCount = v.getUint16(o); o += 2;
  const nodeCount = v.getUint16(o); o += 2;
  o += 2; // reserved

  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const p = { id: v.getUint8(o), alive: !!v.getUint8(o + 1), pop: v.getUint16(o + 2), popCap: v.getUint16(o + 4), res: {} };
    o += 6;
    for (const r of RESOURCES) { p.res[r] = v.getUint16(o); o += 2; }
    players.push(p);
  }

  const units = [];
  for (let i = 0; i < unitCount; i++) {
    const flags = v.getUint8(o + 13);
    units.push({
      id: v.getUint16(o),
      owner: v.getUint8(o + 2),
      type: UNIT_TYPES[v.getUint8(o + 3)],
      x: v.getInt16(o + 4),
      y: v.getInt16(o + 6),
      hp: v.getUint16(o + 8),
      st: v.getUint8(o + 10),
      frame: v.getUint8(o + 11),
      dir: byteToAngle(v.getUint8(o + 12)),
      flip: !!(flags & 1),
      carryKind: (flags >> 1) & 3,
      guarding: !!(flags & 8),
      workKind: WORK_KINDS[(flags >> 4) & 3],
    });
    o += BYTES_PER_UNIT;
  }

  const buildings = [];
  for (let i = 0; i < buildingCount; i++) {
    const flags = v.getUint8(o + 9);
    buildings.push({
      id: v.getUint16(o),
      owner: v.getUint8(o + 2),
      kind: BUILDING_KINDS[v.getUint8(o + 3)],
      tx: v.getUint8(o + 4),
      ty: v.getUint8(o + 5),
      hp: v.getUint16(o + 6),
      progress: v.getUint8(o + 8) / 255,
      done: !!(flags & 1),
      variant: (flags >> 1) & 7,
      paused: !!(flags & 16),
      produce: v.getUint8(o + 10) / 255,
    });
    o += BYTES_PER_BUILDING;
  }

  const projectiles = [];
  for (let i = 0; i < projectileCount; i++) {
    projectiles.push({
      x: v.getInt16(o), y: v.getInt16(o + 2),
      dir: byteToAngle(v.getUint8(o + 4)), owner: v.getUint8(o + 5),
    });
    o += BYTES_PER_PROJECTILE;
  }

  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({ id: v.getUint16(o), amount: v.getUint16(o + 2) });
    o += BYTES_PER_NODE;
  }

  return { tick, players, units, buildings, projectiles, nodes };
}

const angleToByte = (a) => Math.round(((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * 255) & 0xff;
const byteToAngle = (b) => (b / 255) * Math.PI * 2;

/** True when a received payload is a binary snapshot rather than an object. */
export function isBinary(data) {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

/** Normalises whatever PeerJS hands us into an ArrayBuffer. */
export function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}
