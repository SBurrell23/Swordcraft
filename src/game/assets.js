// Asset manifest + loader.
//
// Every sprite sheet in the Tiny Swords pack is a single horizontal strip, so a
// sheet is fully described by its frame size and frame count. The counts here
// were measured from the actual PNGs (image width / frame width).

const ROOT = 'Assets/';

/** Player colours, in seat order. The pack also ships a "Black" set. */
export const COLORS = ['Blue', 'Red', 'Yellow', 'Purple'];

/** Banner / minimap tint for each faction. */
export const COLOR_HEX = {
  Blue: '#4ea3c8', Red: '#d1584f', Yellow: '#d3c34a', Purple: '#a97ac4', Black: '#7d8794',
};

/** Animated strip descriptor. */
const strip = (src, fw, fh, frames, fps = 10, loop = true) => ({ src, fw, fh, frames, fps, loop });
/** Single-frame image descriptor; the frame box is filled in at load time. */
const still = (src) => ({ src, fw: 0, fh: 0, frames: 1, fps: 0, loop: false });

// ---------------------------------------------------------------------------
// Units. Every frame box is 192x192 except the Lancer, whose spear needs 320.
// ---------------------------------------------------------------------------

const unitAnims = (color) => {
  const u = ROOT + 'Units/' + color + ' Units/';
  const pawn = u + 'Pawn/Pawn_';
  const war = u + 'Warrior/Warrior_';
  const arc = u + 'Archer/Archer_';
  const lan = u + 'Lancer/Lancer_';
  const mon = u + 'Monk/';
  return {
    pawn: {
      idle: strip(pawn + 'Idle.png', 192, 192, 8, 8),
      run: strip(pawn + 'Run.png', 192, 192, 6, 12),
      // Carry variants, used on the walk home with a full load.
      idleWood: strip(pawn + 'Idle Wood.png', 192, 192, 8, 8),
      runWood: strip(pawn + 'Run Wood.png', 192, 192, 6, 12),
      idleGold: strip(pawn + 'Idle Gold.png', 192, 192, 8, 8),
      runGold: strip(pawn + 'Run Gold.png', 192, 192, 6, 12),
      idleMeat: strip(pawn + 'Idle Meat.png', 192, 192, 8, 8),
      runMeat: strip(pawn + 'Run Meat.png', 192, 192, 6, 12),
      // Tool variants, used walking to and working a node or a build site.
      idleAxe: strip(pawn + 'Idle Axe.png', 192, 192, 8, 8),
      runAxe: strip(pawn + 'Run Axe.png', 192, 192, 6, 12),
      chop: strip(pawn + 'Interact Axe.png', 192, 192, 6, 12),
      idlePickaxe: strip(pawn + 'Idle Pickaxe.png', 192, 192, 8, 8),
      runPickaxe: strip(pawn + 'Run Pickaxe.png', 192, 192, 6, 12),
      mine: strip(pawn + 'Interact Pickaxe.png', 192, 192, 6, 12),
      idleKnife: strip(pawn + 'Idle Knife.png', 192, 192, 8, 8),
      runKnife: strip(pawn + 'Run Knife.png', 192, 192, 6, 12),
      butcher: strip(pawn + 'Interact Knife.png', 192, 192, 4, 12),
      idleHammer: strip(pawn + 'Idle Hammer.png', 192, 192, 8, 8),
      runHammer: strip(pawn + 'Run Hammer.png', 192, 192, 6, 12),
      build: strip(pawn + 'Interact Hammer.png', 192, 192, 3, 9),
    },
    warrior: {
      idle: strip(war + 'Idle.png', 192, 192, 8, 8),
      run: strip(war + 'Run.png', 192, 192, 6, 12),
      attack1: strip(war + 'Attack1.png', 192, 192, 4, 12, false),
      attack2: strip(war + 'Attack2.png', 192, 192, 4, 12, false),
      guard: strip(war + 'Guard.png', 192, 192, 6, 8),
    },
    archer: {
      idle: strip(arc + 'Idle.png', 192, 192, 6, 8),
      run: strip(arc + 'Run.png', 192, 192, 4, 12),
      shoot: strip(arc + 'Shoot.png', 192, 192, 8, 14, false),
      // The arrow sprite is the one Archer file without the class prefix.
      arrow: still(u + 'Archer/Arrow.png'),
    },
    lancer: {
      idle: strip(lan + 'Idle.png', 320, 320, 12, 10),
      run: strip(lan + 'Run.png', 320, 320, 6, 12),
      attackRight: strip(lan + 'Right_Attack.png', 320, 320, 3, 11, false),
      attackUp: strip(lan + 'Up_Attack.png', 320, 320, 3, 11, false),
      attackDown: strip(lan + 'Down_Attack.png', 320, 320, 3, 11, false),
      attackUpRight: strip(lan + 'UpRight_Attack.png', 320, 320, 3, 11, false),
      attackDownRight: strip(lan + 'DownRight_Attack.png', 320, 320, 3, 11, false),
      guardRight: strip(lan + 'Right_Defence.png', 320, 320, 6, 8),
      guardUp: strip(lan + 'Up_Defence.png', 320, 320, 6, 8),
      guardDown: strip(lan + 'Down_Defence.png', 320, 320, 6, 8),
      guardUpRight: strip(lan + 'UpRight_Defence.png', 320, 320, 6, 8),
      guardDownRight: strip(lan + 'DownRight_Defence.png', 320, 320, 6, 8),
    },
    monk: {
      idle: strip(mon + 'Idle.png', 192, 192, 6, 8),
      run: strip(mon + 'Run.png', 192, 192, 4, 12),
      heal: strip(mon + 'Heal.png', 192, 192, 11, 12, false),
      healEffect: strip(mon + 'Heal_Effect.png', 192, 192, 11, 12, false),
    },
  };
};

const buildingImages = (color) => {
  const b = ROOT + 'Buildings/' + color + ' Buildings/';
  return {
    castle: still(b + 'Castle.png'),
    barracks: still(b + 'Barracks.png'),
    archery: still(b + 'Archery.png'),
    monastery: still(b + 'Monastery.png'),
    tower: still(b + 'Tower.png'),
    house1: still(b + 'House1.png'),
    house2: still(b + 'House2.png'),
    house3: still(b + 'House3.png'),
  };
};

// ---------------------------------------------------------------------------
// Shared (colour-independent) assets
// ---------------------------------------------------------------------------

const FX = {
  dustSmall: strip(ROOT + 'Particle FX/Dust_01.png', 64, 64, 8, 16, false),
  dustBig: strip(ROOT + 'Particle FX/Dust_02.png', 64, 64, 10, 16, false),
  explosion1: strip(ROOT + 'Particle FX/Explosion_01.png', 192, 192, 8, 16, false),
  explosion2: strip(ROOT + 'Particle FX/Explosion_02.png', 192, 192, 10, 16, false),
  fire1: strip(ROOT + 'Particle FX/Fire_01.png', 64, 64, 8, 12),
  fire2: strip(ROOT + 'Particle FX/Fire_02.png', 64, 64, 10, 12),
  fire3: strip(ROOT + 'Particle FX/Fire_03.png', 64, 64, 12, 12),
  splash: strip(ROOT + 'Particle FX/Water Splash.png', 192, 192, 9, 16, false),
};

const TERRAIN = {
  // Five ground-colour variants; each generated map picks one.
  tileset: [1, 2, 3, 4, 5].map((n) => still(ROOT + 'Terrain/Tileset/Tilemap_color' + n + '.png')),
  water: still(ROOT + 'Terrain/Tileset/Water Background color.png'),
  foam: strip(ROOT + 'Terrain/Tileset/Water Foam.png', 192, 192, 16, 10),
  shadow: still(ROOT + 'Terrain/Tileset/Shadow.png'),
};

const RESOURCES = {
  trees: [
    strip(ROOT + 'Terrain/Resources/Wood/Trees/Tree1.png', 192, 256, 8, 7),
    strip(ROOT + 'Terrain/Resources/Wood/Trees/Tree2.png', 192, 256, 8, 7),
    strip(ROOT + 'Terrain/Resources/Wood/Trees/Tree3.png', 192, 192, 8, 7),
    strip(ROOT + 'Terrain/Resources/Wood/Trees/Tree4.png', 192, 192, 8, 7),
  ],
  stumps: [1, 2, 3, 4].map((n) => still(ROOT + 'Terrain/Resources/Wood/Trees/Stump ' + n + '.png')),
  goldMine: still(ROOT + 'Terrain/Resources/Gold/Gold Resource/Gold_Resource.png'),
  goldMineGlow: strip(ROOT + 'Terrain/Resources/Gold/Gold Resource/Gold_Resource_Highlight.png', 128, 128, 6, 8),
  goldStones: [1, 2, 3, 4, 5, 6].map((n) => still(ROOT + 'Terrain/Resources/Gold/Gold Stones/Gold Stone ' + n + '.png')),
  goldStoneGlows: [1, 2, 3, 4, 5, 6].map((n) =>
    strip(ROOT + 'Terrain/Resources/Gold/Gold Stones/Gold Stone ' + n + '_Highlight.png', 128, 128, 6, 8)),
  sheepIdle: strip(ROOT + 'Terrain/Resources/Meat/Sheep/Sheep_Idle.png', 128, 128, 6, 7),
  sheepMove: strip(ROOT + 'Terrain/Resources/Meat/Sheep/Sheep_Move.png', 128, 128, 4, 9),
  sheepGrass: strip(ROOT + 'Terrain/Resources/Meat/Sheep/Sheep_Grass.png', 128, 128, 12, 7),
  meat: still(ROOT + 'Terrain/Resources/Meat/Meat Resource/Meat Resource.png'),
  wood: still(ROOT + 'Terrain/Resources/Wood/Wood Resource/Wood Resource.png'),
  tools: [1, 2, 3, 4].map((n) => still(ROOT + 'Terrain/Resources/Tools/Tool_0' + n + '.png')),
};

const DECOR = {
  bushes: [1, 2, 3, 4].map((n) => strip(ROOT + 'Terrain/Decorations/Bushes/Bushe' + n + '.png', 128, 128, 8, 6)),
  rocks: [1, 2, 3, 4].map((n) => still(ROOT + 'Terrain/Decorations/Rocks/Rock' + n + '.png')),
  waterRocks: [1, 2, 3, 4].map((n) =>
    strip(ROOT + 'Terrain/Decorations/Rocks in the Water/Water Rocks_0' + n + '.png', 64, 64, 16, 8)),
  clouds: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => still(ROOT + 'Terrain/Decorations/Clouds/Clouds_0' + n + '.png')),
  duck: strip(ROOT + 'Terrain/Decorations/Rubber Duck/Rubber duck.png', 32, 32, 3, 5),
};

const UI_ROOT = ROOT + 'UI Elements/UI Elements/';
const UI = {
  woodTable: still(UI_ROOT + 'Wood Table/WoodTable.png'),
  woodSlots: still(UI_ROOT + 'Wood Table/WoodTable_Slots.png'),
  banner: still(UI_ROOT + 'Banners/Banner.png'),
  bannerSlots: still(UI_ROOT + 'Banners/Banner_Slots.png'),
  paper: still(UI_ROOT + 'Papers/RegularPaper.png'),
  specialPaper: still(UI_ROOT + 'Papers/SpecialPaper.png'),
  bigRibbons: still(UI_ROOT + 'Ribbons/BigRibbons.png'),
  smallRibbons: still(UI_ROOT + 'Ribbons/SmallRibbons.png'),
  swords: still(UI_ROOT + 'Swords/Swords.png'),
  smallBarBase: still(UI_ROOT + 'Bars/SmallBar_Base.png'),
  smallBarFill: still(UI_ROOT + 'Bars/SmallBar_Fill.png'),
  bigBarBase: still(UI_ROOT + 'Bars/BigBar_Base.png'),
  bigBarFill: still(UI_ROOT + 'Bars/BigBar_Fill.png'),
  btnBlue: still(UI_ROOT + 'Buttons/BigBlueButton_Regular.png'),
  btnBluePressed: still(UI_ROOT + 'Buttons/BigBlueButton_Pressed.png'),
  btnRed: still(UI_ROOT + 'Buttons/BigRedButton_Regular.png'),
  btnRedPressed: still(UI_ROOT + 'Buttons/BigRedButton_Pressed.png'),
  sqBlue: still(UI_ROOT + 'Buttons/SmallBlueSquareButton_Regular.png'),
  sqBluePressed: still(UI_ROOT + 'Buttons/SmallBlueSquareButton_Pressed.png'),
  sqRed: still(UI_ROOT + 'Buttons/SmallRedSquareButton_Regular.png'),
  sqRedPressed: still(UI_ROOT + 'Buttons/SmallRedSquareButton_Pressed.png'),
  roundBlue: still(UI_ROOT + 'Buttons/SmallBlueRoundButton_Regular.png'),
  roundRed: still(UI_ROOT + 'Buttons/SmallRedRoundButton_Regular.png'),
  tinyBlue: still(UI_ROOT + 'Buttons/TinySquareBlueButton.png'),
  tinyRed: still(UI_ROOT + 'Buttons/TinySquareRedButton.png'),
  cursorArrow: still(UI_ROOT + 'Cursors/Cursor_01.png'),
  cursorHand: still(UI_ROOT + 'Cursors/Cursor_02.png'),
  cursorDeny: still(UI_ROOT + 'Cursors/Cursor_03.png'),
  cursorTarget: still(UI_ROOT + 'Cursors/Cursor_04.png'),
  icons: Array.from({ length: 12 }, (_, i) =>
    still(UI_ROOT + 'Icons/Icon_' + String(i + 1).padStart(2, '0') + '.png')),
  avatars: Array.from({ length: 25 }, (_, i) =>
    still(UI_ROOT + 'Human Avatars/Avatars_' + String(i + 1).padStart(2, '0') + '.png')),
};

/** Zero-based indices into `A.ui.icons`, named for readability. */
export const ICON = {
  wood: 1, gold: 2, meat: 3, sword: 4, shield: 5,
  cursor: 6, arrow: 7, cancel: 8, gear: 9, info: 10, music: 11,
};

/**
 * 9-slice source rectangles, measured from each sheet's alpha channel: three
 * column x-ranges and three row y-ranges naming the nine pieces.
 */
export const NINE = {
  woodTable: { xs: [[44, 128], [192, 256], [320, 404]], ys: [[43, 128], [192, 256], [320, 423]] },
  banner: { xs: [[28, 128], [192, 256], [320, 404]], ys: [[60, 128], [192, 256], [320, 431]] },
  paper: { xs: [[12, 64], [128, 192], [256, 308]], ys: [[20, 64], [128, 192], [256, 301]] },
  specialPaper: { xs: [[9, 64], [128, 192], [256, 311]], ys: [[20, 64], [128, 192], [256, 299]] },
  btn: { xs: [[19, 64], [128, 192], [256, 301]], ys: [[17, 64], [128, 192], [256, 303]] },
  btnPressed: { xs: [[14, 64], [128, 192], [256, 306]], ys: [[28, 64], [128, 192], [256, 305]] },
};

/** Row y-ranges of the five colours in BigRibbons.png. */
export const RIBBON_ROWS = [[20, 123], [148, 251], [276, 379], [404, 507], [532, 635]];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** The populated asset tree. Only valid once `loadAssets()` has resolved. */
export const A = {
  unit: {}, building: {}, fx: FX, terrain: TERRAIN, res: RESOURCES, decor: DECOR, ui: UI,
};

for (const c of COLORS) {
  A.unit[c] = unitAnims(c);
  A.building[c] = buildingImages(c);
}

/** Walks the manifest tree and yields every leaf descriptor. */
function* eachDescriptor(node) {
  if (node && typeof node === 'object') {
    if (typeof node.src === 'string') { yield node; return; }
    for (const v of Object.values(node)) yield* eachDescriptor(v);
  }
}

/**
 * Loads every image the manifest references, mutating each descriptor in place
 * to carry its `img`. Descriptors built with `still()` get their frame box
 * filled in from the decoded image.
 *
 * @param {(loaded: number, total: number) => void} [onProgress]
 */
export async function loadAssets(onProgress) {
  const descriptors = [...eachDescriptor(A)];
  const cache = new Map(); // The same file appears more than once; decode once.
  let loaded = 0;

  const decode = (src) => {
    let p = cache.get(src);
    if (p) return p;
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load asset: ' + src));
      // Paths contain spaces and parentheses, so encode each path segment.
      img.src = src.split('/').map(encodeURIComponent).join('/');
    });
    cache.set(src, p);
    return p;
  };

  // Let every request settle before reporting, so one bad path names itself
  // instead of being buried under the progress of everything still in flight.
  const failures = [];
  await Promise.all(descriptors.map(async (d) => {
    try {
      d.img = await decode(d.src);
      if (!d.fw) { d.fw = d.img.width / d.frames; d.fh = d.img.height; }
    } catch (err) {
      failures.push(d.src);
    }
    loaded += 1;
    if (onProgress) onProgress(loaded, descriptors.length);
  }));

  if (failures.length) {
    throw new Error(`Missing ${failures.length} asset(s), starting with: ${failures[0]}`);
  }
}

/**
 * Draws one frame of a strip centred on (x, y). Sprites in this pack all face
 * right, so `flip` covers westward facing.
 */
export function drawFrame(ctx, sheet, frame, x, y, scale = 1, flip = false, alpha = 1) {
  const { img, fw, fh, frames } = sheet;
  const f = ((frame | 0) % frames + frames) % frames;
  const w = fw * scale, h = fh * scale;
  ctx.save();
  if (alpha !== 1) ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(img, f * fw, 0, fw, fh, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/** Frame index for a strip played from t = 0 seconds. */
export function frameAt(sheet, t) {
  const i = Math.floor(t * sheet.fps);
  return sheet.loop ? i % sheet.frames : Math.min(i, sheet.frames - 1);
}

/**
 * Repacks a 9-slice sheet, whose pieces are spread out with gaps, into a tight
 * image; returns a data URL plus the matching CSS `border-image-slice`.
 */
export function nineSliceDataURL(sheet, slices) {
  const { xs, ys } = slices;
  const w = xs.reduce((s, r) => s + (r[1] - r[0]), 0);
  const h = ys.reduce((s, r) => s + (r[1] - r[0]), 0);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  let dy = 0;
  for (const yr of ys) {
    let dx = 0;
    for (const xr of xs) {
      c.drawImage(sheet.img, xr[0], yr[0], xr[1] - xr[0], yr[1] - yr[0], dx, dy, xr[1] - xr[0], yr[1] - yr[0]);
      dx += xr[1] - xr[0];
    }
    dy += yr[1] - yr[0];
  }
  return {
    url: cv.toDataURL(),
    slice: [ys[0][1] - ys[0][0], xs[2][1] - xs[2][0], ys[2][1] - ys[2][0], xs[0][1] - xs[0][0]],
  };
}

/** Crops a sub-rectangle of a loaded sheet into a standalone data URL. */
export function cropDataURL(sheet, sx, sy, sw, sh) {
  const cv = document.createElement('canvas');
  cv.width = sw; cv.height = sh;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.drawImage(sheet.img, sx, sy, sw, sh, 0, 0, sw, sh);
  return cv.toDataURL();
}
