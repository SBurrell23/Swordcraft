// Turns the pixel-art UI sheets into CSS.
//
// The pack lays each frame out as nine pieces spaced apart inside one image,
// which `border-image` cannot use directly. Repacking them into tight sprites
// once at boot lets every panel and button in the game be a plain CSS border,
// which is both cheaper and far less code than drawing frames by hand.

import { A, NINE, RIBBON_ROWS, nineSliceDataURL, cropDataURL } from '../game/assets.js';

let applied = false;

/** Installs every skin variable on :root. Safe to call more than once. */
export function applySkin() {
  if (applied) return;
  applied = true;
  const s = document.documentElement.style;

  const panels = {
    wood: [A.ui.woodTable, NINE.woodTable],
    banner: [A.ui.banner, NINE.banner],
    paper: [A.ui.paper, NINE.paper],
    special: [A.ui.specialPaper, NINE.specialPaper],
    btn: [A.ui.btnBlue, NINE.btn],
    'btn-down': [A.ui.btnBluePressed, NINE.btnPressed],
    'btn-red': [A.ui.btnRed, NINE.btn],
    'btn-red-down': [A.ui.btnRedPressed, NINE.btnPressed],
  };
  for (const [name, [sheet, slices]] of Object.entries(panels)) {
    const { url, slice } = nineSliceDataURL(sheet, slices);
    s.setProperty(`--${name}-src`, `url(${url})`);
    s.setProperty(`--${name}-slice`, slice.join(' '));
  }

  // The teal ribbon row, kept for anywhere a coloured label is wanted.
  const [ry0, ry1] = RIBBON_ROWS[0];
  s.setProperty('--ribbon-src', `url(${cropDataURL(A.ui.bigRibbons, 0, ry0, 448, ry1 - ry0)})`);
}

// ---------------------------------------------------------------------------
// Composed pieces
// ---------------------------------------------------------------------------

/**
 * The Banner sheet's nine pieces, by source rectangle. It is a parchment sheet
 * whose bottom edge is a curled roll - which is what makes a scroll out of it.
 */
const BANNER_X = [[28, 128], [192, 256], [320, 404]];
const BANNER_Y = [[60, 128], [192, 256], [320, 431]];
const scrollCache = new Map();

/**
 * Composes a horizontal scroll: parchment with a rolled edge along the bottom
 * and a curled end at each corner, sized to the bar it has to sit behind.
 *
 * This is drawn into a canvas rather than left to CSS `border-image` on
 * purpose. `border-image` stretches its slices to whatever border width it is
 * given, and squeezing 100px of pixel art into a 20px border is exactly what
 * made the old bar look muddy. Here the pieces are scaled once, by a fixed
 * factor, and the middle column is *repeated* - so the grain keeps its size no
 * matter how wide the window gets.
 *
 * @param {number} width  target width in CSS pixels
 * @param {number} scale  how much of the source art's native size to keep
 * @returns {{url: string, width: number, height: number, capLeft: number, capRight: number}}
 */
export function scrollBarURL(width, scale = 0.5) {
  const key = Math.round(width) + '@' + scale;
  const hit = scrollCache.get(key);
  if (hit) return hit;

  const img = A.ui.banner.img;
  const w = BANNER_X.map(([a, b]) => Math.round((b - a) * scale));
  const h = BANNER_Y.map(([a, b]) => Math.round((b - a) * scale));
  // One middle row is enough height for a readout; the bottom row is the curl.
  const tiles = Math.max(1, Math.ceil((width - w[0] - w[2]) / w[1]));

  const cv = document.createElement('canvas');
  cv.width = w[0] + tiles * w[1] + w[2];
  cv.height = h[0] + h[1] + h[2];
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;

  const put = (col, row, dx, dy, dw, dh) => {
    const [sx0, sx1] = BANNER_X[col];
    const [sy0, sy1] = BANNER_Y[row];
    c.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, dx, dy, dw, dh);
  };

  let y = 0;
  for (let row = 0; row < 3; row++) {
    put(0, row, 0, y, w[0], h[row]);
    for (let i = 0; i < tiles; i++) put(1, row, w[0] + i * w[1], y, w[1], h[row]);
    put(2, row, w[0] + tiles * w[1], y, w[2], h[row]);
    y += h[row];
  }

  const out = {
    url: cv.toDataURL(),
    width: cv.width,
    height: cv.height,
    capLeft: w[0],
    capRight: w[2],
    // The curled bottom row is decoration; content should stay above it.
    contentHeight: h[0] + h[1],
  };
  if (scrollCache.size > 24) scrollCache.clear();
  scrollCache.set(key, out);
  return out;
}


/**
 * Cursor art, cropped to its content and scaled up, with a hotspot chosen to
 * match where each pointer actually points. Browsers cap cursor images at
 * 128px, so 2x of a ~32px crop is as large as is safe.
 */
const CURSOR_ART = {
  // [sheet key, sx, sy, sw, sh, hotspot x, hotspot y] in source pixels
  arrow: ['cursorArrow', 22, 17, 22, 30, 1, 1],
  hand: ['cursorHand', 20, 17, 27, 32, 12, 2],
  deny: ['cursorDeny', 16, 13, 32, 36, 16, 18],
};
const cursorCache = new Map();

/**
 * A ready-to-assign CSS cursor value.
 * @param {'arrow'|'hand'|'deny'} name
 * @param {string} fallback native cursor to fall back on
 */
export function cursor(name, fallback = 'auto') {
  let value = cursorCache.get(name);
  if (!value) {
    const [key, sx, sy, sw, sh, hx, hy] = CURSOR_ART[name];
    const scale = 1;
    const cv = document.createElement('canvas');
    cv.width = sw * scale; cv.height = sh * scale;
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.drawImage(A.ui[key].img, sx, sy, sw, sh, 0, 0, sw * scale, sh * scale);
    value = `url(${cv.toDataURL()}) ${hx * scale} ${hy * scale}`;
    cursorCache.set(name, value);
  }
  return `${value}, ${fallback}`;
}

const avatarCache = new Map();

/**
 * A portrait for a player, chosen deterministically from their seat so the
 * same face follows them on every peer's screen.
 */
export function avatarURL(seed) {
  const i = ((seed * 7 + 3) % A.ui.avatars.length + A.ui.avatars.length) % A.ui.avatars.length;
  let url = avatarCache.get(i);
  if (!url) {
    url = cropDataURL(A.ui.avatars[i], 16, 24, 224, 200);
    avatarCache.set(i, url);
  }
  return url;
}

