// Swordcraft rules and tuning. Everything balance-related lives here so the
// simulation reads as logic and the numbers stay in one place.

/** World tile size in pixels. Matches the Tiny Swords tileset. */
export const TILE = 64;

/**
 * Map size in tiles. The camera shows roughly 1600x900 world pixels, so a
 * 68x68 tile map (4352px square) is about ten camera-fulls of ground.
 */
export const MAP_TILES = 68;

/** Simulation rate. The host steps at this rate; clients interpolate. */
export const TICK_HZ = 20;
export const TICK_DT = 1 / TICK_HZ;
/** How often the host broadcasts a world snapshot. */
export const SNAPSHOT_EVERY = 2; // ticks -> 10 Hz

/** Terrain is flat: a tile is either walkable ground or open water. */
export const LEVEL = { WATER: 0, GROUND: 1 };

/** Resource kinds, in HUD order. */
export const RESOURCES = ['wood', 'gold'];

export const START_RESOURCES = { wood: 360, gold: 320 };

/** Population: houses raise the cap, units consume it. */
export const BASE_POP_CAP = 20;
export const POP_PER_HOUSE = 10;
export const MAX_POP_CAP = 80;
/**
 * Drones a player may hold per base building. Without a ceiling the free
 * population is eaten by workers and there is never an army; tying the ceiling
 * to bases is what makes expanding worth the stone.
 */
export const MAX_PAWNS_PER_BASE = 14;

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * @typedef UnitDef
 * @property {string} name
 * @property {number} hp
 * @property {number} speed      world px per second
 * @property {number} radius     collision radius in px
 * @property {number} damage     per swing / shot
 * @property {number} armor      flat damage reduction
 * @property {number} range      attack range in px, measured edge to edge
 * @property {number} cooldown   seconds between attacks
 * @property {number} sight      auto-acquire radius in px
 * @property {number} pop        population cost
 * @property {number} scale      sprite draw scale
 * @property {Record<string, number>} cost  paid when the building trains it
 */

/** @type {Record<string, UnitDef>} */
export const UNITS = {
  pawn: {
    name: 'Pawn', hp: 70, speed: 108, radius: 14, damage: 5, armor: 0,
    range: 24, cooldown: 1.2, sight: 190, pop: 1, scale: 0.72,
    cost: { gold: 35 },
    blurb: 'Drone. Gathers wood and gold, and raises your buildings.',
  },
  warrior: {
    name: 'Warrior', hp: 220, speed: 112, radius: 16, damage: 26, armor: 3,
    range: 30, cooldown: 1.05, sight: 300, pop: 2, scale: 0.74,
    cost: { wood: 25, gold: 40 },
    blurb: 'Melee combat specialist with unstoppable offensive power.',
  },
  lancer: {
    name: 'Lancer', hp: 300, speed: 88, radius: 16, damage: 18, armor: 8,
    range: 56, cooldown: 1.5, sight: 300, pop: 2, scale: 0.70,
    cost: { wood: 55, gold: 30 },
    blurb: 'Defensive expert. Braces when it holds ground, blunting all damage.',
  },
  archer: {
    name: 'Archer', hp: 120, speed: 104, radius: 14, damage: 20, armor: 0,
    range: 290, cooldown: 1.6, sight: 350, pop: 2, scale: 0.72,
    cost: { wood: 45, gold: 35 },
    blurb: 'Long-range unit that eliminates targets with precision.',
  },
  monk: {
    name: 'Monk', hp: 140, speed: 104, radius: 14, damage: 0, armor: 1,
    range: 200, cooldown: 2.2, sight: 260, pop: 2, scale: 0.72,
    cost: { gold: 85 },
    heal: 45,
    blurb: 'Mystical healer devoted to restoring the health of allies.',
  },
};

/** Extra damage the Lancer's brace absorbs while it is holding position. */
export const LANCER_GUARD_ARMOR = 10;

/** Pawn gathering: seconds per trip-load and how much a load is worth. */
export const GATHER = {
  wood: { time: 3.4, amount: 12 },
  gold: { time: 4.2, amount: 11 },
};
/** Pawn build rate, in build-points per second (one pawn on one site). */
export const BUILD_RATE = 12;

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/**
 * @typedef BuildingDef
 * @property {string} name
 * @property {number} hp
 * @property {[number, number]} foot   footprint in tiles (w, h)
 * @property {number} sw               sprite width in px
 * @property {number} sh               sprite height in px
 * @property {number} scale            sprite draw scale
 * @property {Record<string, number>} cost
 * @property {string} [spawns]         unit key produced on a timer
 * @property {number} [interval]       seconds between spawns
 * @property {number} [buildPoints]    work needed to finish construction
 * @property {boolean} [dropoff]       drones deliver their loads here
 * @property {number} [requiresPop]    population needed before it may be sited
 */

/** @type {Record<string, BuildingDef>} */
export const BUILDINGS = {
  castle: {
    name: 'Castle', hp: 3200, foot: [4, 3], sw: 320, sh: 256, scale: 0.8,
    cost: {}, spawns: 'pawn', interval: 11, buildPoints: 0, dropoff: true,
    blurb: 'Your seat of power. Trains drones. Lose it and you are out.',
  },
  outpost: {
    name: 'Outpost', hp: 1500, foot: [2, 2], sw: 128, sh: 192, scale: 0.8,
    cost: { wood: 130, gold: 90 }, spawns: 'pawn', interval: 14,
    buildPoints: 190, dropoff: true,
    blurb: 'A second base. Trains drones and takes their deliveries, so a distant seam becomes worth working.',
  },
  house: {
    name: 'House', hp: 700, foot: [2, 2], sw: 128, sh: 192, scale: 0.8,
    cost: { wood: 60 }, buildPoints: 100,
    blurb: 'Raises your population cap by ' + POP_PER_HOUSE + '.',
  },
  barracks: {
    name: 'Barracks', hp: 1300, foot: [3, 2], sw: 192, sh: 256, scale: 0.8,
    cost: { wood: 140, gold: 60 }, spawns: 'warrior', interval: 17, buildPoints: 170,
    blurb: 'Trains Warriors on a timer.',
  },
  archery: {
    name: 'Archery Range', hp: 1050, foot: [3, 2], sw: 192, sh: 256, scale: 0.8,
    cost: { wood: 120, gold: 90 }, spawns: 'archer', interval: 19, buildPoints: 170,
    blurb: 'Trains Archers on a timer.',
  },
  monastery: {
    name: 'Monastery', hp: 950, foot: [3, 2], sw: 192, sh: 320, scale: 0.8,
    cost: { wood: 100, gold: 180 }, spawns: 'monk', interval: 25, buildPoints: 200,
    requiresPop: 30,
    blurb: 'Trains Monks. Needs a settlement of 30 to support it.',
  },
  tower: {
    name: 'Watchtower', hp: 1500, foot: [2, 2], sw: 128, sh: 256, scale: 0.8,
    cost: { wood: 160, gold: 50 }, spawns: 'lancer', interval: 21, buildPoints: 190,
    blurb: 'Trains Lancers, and looses arrows at anything hostile nearby.',
  },
};

/** Watchtower's own attack. */
export const TOWER_ATTACK = { damage: 24, range: 320, cooldown: 1.7 };

/** Build menu order, and the hotkey that places each. */
export const BUILD_MENU = [
  { key: 'house', hotkey: 'H' },
  { key: 'outpost', hotkey: 'O' },
  { key: 'barracks', hotkey: 'B' },
  { key: 'archery', hotkey: 'R' },
  { key: 'tower', hotkey: 'T' },
  { key: 'monastery', hotkey: 'M' },
];

/** How many spawned units a producing building keeps queued up nearby. */
export const RALLY_SPREAD = 90;

// ---------------------------------------------------------------------------
// Resource nodes on the map
// ---------------------------------------------------------------------------

export const NODE_AMOUNT = { wood: 420, gold: 760 };
/** Pawns that can work a single node at once. */
export const NODE_SLOTS = { wood: 1, gold: 3 };

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export const CAMERA = {
  minZoom: 0.42,
  maxZoom: 1.15,
  startZoom: 0.62,
  panSpeed: 1500,      // px/sec at zoom 1 via keyboard
  edgeMargin: 14,      // px from the window edge that starts an edge-scroll
  edgeSpeed: 1150,
};

/** Command kinds a player can issue. */
export const CMD = {
  MOVE: 1, ATTACK_MOVE: 2, ATTACK: 3, STOP: 4, HOLD: 5,
  GATHER: 6, BUILD: 7, RALLY: 8, CANCEL_BUILD: 9, TOGGLE_PRODUCTION: 10,
};

/** Unit behaviour states, shared by sim and renderer. */
export const ST = {
  IDLE: 0, MOVE: 1, ATTACK_MOVE: 2, CHASE: 3, ATTACK: 4,
  GATHER_GO: 5, GATHER_WORK: 6, RETURN: 7, BUILD_GO: 8, BUILD_WORK: 9,
  HOLD: 10, HEAL: 11, DEAD: 12,
};
