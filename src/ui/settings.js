// The sound panel.
//
// Mounted once at boot and pinned to the corner, so it is reachable from the
// title screen, the lobby and the middle of a match alike. Levels persist in
// localStorage, so a player sets them once rather than every session.

import { audio } from '../game/audio.js';
import { A, ICON, cropDataURL } from '../game/assets.js';

let panel = null;

/** Creates the gear button and its panel, and wires them to the audio buses. */
export function mountSettings() {
  if (panel) return;

  const gearIcon = cropDataURL(A.ui.icons[ICON.gear], 0, 0, 64, 64);
  const noteIcon = cropDataURL(A.ui.icons[ICON.music], 0, 0, 64, 64);

  const host = document.createElement('div');
  host.id = 'settingsHost';
  host.innerHTML = `
    <button id="settingsBtn" title="Sound (S)" aria-label="Sound settings">
      <img alt="" src="${gearIcon}">
    </button>
    <div id="settingsPanel" class="paper-panel" hidden>
      <div class="settings-title">
        <img alt="" src="${noteIcon}"><span>Sound</span>
      </div>
      <label class="slider-row">
        <span>Music</span>
        <input type="range" id="volMusic" min="0" max="100" step="1">
        <b id="volMusicVal">0</b>
      </label>
      <label class="slider-row">
        <span>Effects</span>
        <input type="range" id="volSfx" min="0" max="100" step="1">
        <b id="volSfxVal">0</b>
      </label>
      <button class="pixel-btn tiny" id="settingsClose">Close</button>
    </div>`;
  document.body.appendChild(host);

  const btn = host.querySelector('#settingsBtn');
  panel = host.querySelector('#settingsPanel');
  const music = host.querySelector('#volMusic');
  const sfx = host.querySelector('#volSfx');
  const musicVal = host.querySelector('#volMusicVal');
  const sfxVal = host.querySelector('#volSfxVal');

  const sync = () => {
    music.value = Math.round(audio.musicVolume * 100);
    sfx.value = Math.round(audio.sfxVolume * 100);
    musicVal.textContent = music.value;
    sfxVal.textContent = sfx.value;
  };
  sync();

  music.addEventListener('input', () => {
    audio.init();
    audio.setMusicVolume(music.value / 100);
    musicVal.textContent = music.value;
  });
  sfx.addEventListener('input', () => {
    audio.init();
    audio.setSfxVolume(sfx.value / 100);
    sfxVal.textContent = sfx.value;
    // Play something so the level being set is audible while dragging.
    audio.play('click');
  });

  btn.addEventListener('click', () => {
    audio.init();
    audio.play('click');
    sync();
    panel.hidden = !panel.hidden;
  });
  host.querySelector('#settingsClose').addEventListener('click', () => {
    audio.play('click');
    panel.hidden = true;
  });

  // Clicking anywhere else closes it, but not a click inside the panel itself.
  document.addEventListener('pointerdown', (e) => {
    if (panel.hidden || host.contains(e.target)) return;
    panel.hidden = true;
  }, true);
}

/** Hides the panel, e.g. when a match starts. */
export function closeSettings() {
  if (panel) panel.hidden = true;
}
