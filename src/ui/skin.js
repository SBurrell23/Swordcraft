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

  // The teal ribbon row, used as a plaque behind the game title.
  const [ry0, ry1] = RIBBON_ROWS[0];
  s.setProperty('--ribbon-src', `url(${cropDataURL(A.ui.bigRibbons, 0, ry0, 448, ry1 - ry0)})`);
  s.setProperty('--plaque-src', `url(${swordPlaque(760)})`);
}

/**
 * The Swords sheet is a horizontal 3-slice - a sword cap, a stretchable middle
 * and a pointed tail - laid out with gaps. Composes it into one plaque of the
 * requested width, used as a divider.
 */
function swordPlaque(width, row = 0) {
  const sheet = A.ui.swords;
  const y = row * 128;
  const left = [23, 128], mid = [192, 256], right = [320, 412];
  const lw = left[1] - left[0], rw = right[1] - right[0];
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = 128;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  const midW = Math.max(0, width - lw - rw);
  c.drawImage(sheet.img, left[0], y, lw, 128, 0, 0, lw, 128);
  if (midW > 0) c.drawImage(sheet.img, mid[0], y, mid[1] - mid[0], 128, lw, 0, midW, 128);
  c.drawImage(sheet.img, right[0], y, rw, 128, lw + midW, 0, rw, 128);
  return cv.toDataURL();
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

