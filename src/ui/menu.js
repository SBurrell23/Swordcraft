// Title screen, lobby and join flow.
//
// Screens are plain innerHTML swaps into one container. There is no router and
// no framework: the whole front end is five states, and the App drives them.

import { A, COLORS, COLOR_HEX, cropDataURL } from '../game/assets.js';
import { avatarURL } from './skin.js';
import { UNITS, BUILDINGS, RESOURCES } from '../game/consts.js';
import { RES_ICON } from './hud.js';
import { generateMap } from '../game/mapgen.js';
import { paintMinimap } from '../game/render.js';
import { audio } from '../game/audio.js';
import { escapeHtml, iconURL } from './hud.js';
import { MAX_PLAYERS } from '../net/peer.js';

export class Menu {
  /** @param {HTMLElement} root @param {object} app */
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.previewSeed = 0;
  }

  show(html) {
    this.root.hidden = false;
    this.root.innerHTML = html;
    for (const b of this.root.querySelectorAll('button')) {
      b.addEventListener('mouseenter', () => audio.play('hover'));
      b.addEventListener('click', () => audio.play('click'));
    }
  }

  hide() { this.root.hidden = true; this.root.innerHTML = ''; }

  // -- title -----------------------------------------------------------------

  showTitle(error) {
    const name = this.app.playerName;
    this.show(`
      <div class="screen title-screen">
        <h1 class="game-title">Swordcraft</h1>
        ${error ? `<div class="error-note">${escapeHtml(error)}</div>` : ''}
        <div class="panel banner-panel title-panel">
          <label class="field">
            <span>Your name</span>
            <input id="nameInput" maxlength="16" value="${escapeHtml(name)}" autocomplete="off">
          </label>
          <div class="menu-buttons">
            <button class="pixel-btn primary" id="btnSkirmish">Skirmish vs AI</button>
            <button class="pixel-btn" id="btnHost">Host a game</button>
            <button class="pixel-btn" id="btnJoin">Join a game</button>
            <button class="pixel-btn" id="btnHelp">How to play</button>
          </div>
        </div>
        <p class="credit">Art: Tiny Swords by Pixel Frog · Every sound effect synthesised in the browser</p>
      </div>`);

    const nameInput = this.root.querySelector('#nameInput');
    nameInput.addEventListener('input', () => { this.app.setPlayerName(nameInput.value); });
    this.root.querySelector('#btnSkirmish').addEventListener('click', () => this.showSkirmish());
    this.root.querySelector('#btnHost').addEventListener('click', () => this.app.startHosting());
    this.root.querySelector('#btnJoin').addEventListener('click', () => this.showJoin());
    this.root.querySelector('#btnHelp').addEventListener('click', () => this.showHelp());
  }

  // -- skirmish --------------------------------------------------------------

  showSkirmish() {
    const seed = randomSeed();
    this.show(`
      <div class="screen">
        <h2 class="screen-title">Skirmish</h2>
        <div class="panel banner-panel lobby-panel">
          <div class="lobby-cols">
            <div class="lobby-left">
              <div class="field-row">
                <label class="field"><span>Opponents</span>
                  <select id="aiCount">
                    <option value="1">1 AI</option>
                    <option value="2">2 AI</option>
                    <option value="3" selected>3 AI</option>
                  </select>
                </label>
                <label class="field"><span>Difficulty</span>
                  <select id="aiLevel">
                    <option value="easy">Easy</option>
                    <option value="normal" selected>Normal</option>
                    <option value="hard">Hard</option>
                  </select>
                </label>
              </div>
              <label class="field"><span>Your colour</span>
                <div class="color-row" id="colorRow"></div>
              </label>
              <div class="brief">
                <h4>A match in short</h4>
                <ul>
                  <li>Your castle trains drones on its own; they pick jobs and
                      gather wood and gold without orders.</li>
                  <li>Spend that on houses for population and on the buildings
                      that train your army.</li>
                  <li>Training costs resources every time, so halt a building
                      (<b>P</b>) when you would rather bank.</li>
                  <li>Raise an <b>Outpost</b> to claim a distant seam: it takes
                      deliveries and raises your drone ceiling.</li>
                  <li>Rivers and lakes cut the island up. Hold the bridges.</li>
                  <li>Raze every rival castle to win.</li>
                </ul>
              </div>
            </div>
            <div class="lobby-right">
              ${this.mapPreviewHtml(seed)}
            </div>
          </div>
          <div class="menu-buttons row">
            <button class="pixel-btn" id="btnBack">Back</button>
            <button class="pixel-btn primary" id="btnPlay">Start match</button>
          </div>
        </div>
      </div>`);

    this.selectedColor = 0;
    this.renderColorRow();
    this.bindPreview(seed);
    this.root.querySelector('#btnBack').addEventListener('click', () => this.showTitle());
    this.root.querySelector('#btnPlay').addEventListener('click', () => {
      const count = Number(this.root.querySelector('#aiCount').value);
      const level = this.root.querySelector('#aiLevel').value;
      this.app.startSkirmish(count, level, this.previewSeed, this.selectedColor);
    });
  }

  renderColorRow() {
    const row = this.root.querySelector('#colorRow');
    if (!row) return;
    row.innerHTML = COLORS.map((c, i) => `
      <button class="swatch-btn ${i === this.selectedColor ? 'on' : ''}" data-color="${i}"
        style="--c:${COLOR_HEX[c]}" title="${c}"></button>`).join('');
    for (const b of row.querySelectorAll('[data-color]')) {
      b.addEventListener('click', () => {
        this.selectedColor = Number(b.dataset.color);
        audio.play('click');
        this.renderColorRow();
      });
    }
  }

  // -- map preview -----------------------------------------------------------

  mapPreviewHtml(seed) {
    return `
      <div class="map-preview">
        <canvas id="mapCanvas" width="68" height="68"></canvas>
        <div class="seed-row">
          <label class="field seed"><span>Seed</span>
            <input id="seedInput" value="${seed}" maxlength="10" autocomplete="off">
          </label>
          <button class="pixel-btn small" id="btnReroll">Reroll</button>
        </div>
        <div class="map-stats" id="mapStats"></div>
      </div>`;
  }

  bindPreview(seed) {
    const input = this.root.querySelector('#seedInput');
    const reroll = this.root.querySelector('#btnReroll');
    if (!input) return;
    const refresh = () => {
      const v = Math.abs(parseInt(input.value, 10) || 1) >>> 0;
      this.previewSeed = v;
      this.paintPreview(v);
      this.app.onSeedChanged?.(v);
    };
    input.addEventListener('change', refresh);
    reroll?.addEventListener('click', () => { input.value = randomSeed(); refresh(); });
    this.previewSeed = seed;
    this.paintPreview(seed);
  }

  paintPreview(seed) {
    const canvas = this.root.querySelector('#mapCanvas');
    if (!canvas) return;
    const map = generateMap(seed);
    paintMinimap(map, canvas);
    const stats = this.root.querySelector('#mapStats');
    if (stats) {
      let water = 0;
      for (const v of map.level) if (v === 0) water++;
      const land = map.level.length - water;
      stats.textContent =
        `${map.nodes.length} resource sites · ${Math.round((land / map.level.length) * 100)}% land`;
    }
  }

  setPreviewSeed(seed) {
    const input = this.root.querySelector('#seedInput');
    if (input) input.value = seed;
    this.previewSeed = seed;
    this.paintPreview(seed);
  }

  // -- hosting ---------------------------------------------------------------

  showHostLobby(state) {
    const seed = state.seed;
    this.show(`
      <div class="screen">
        <h2 class="screen-title">Your game</h2>
        <div class="panel banner-panel lobby-panel">
          <div class="code-row">
            <span class="code-label">Room code</span>
            <span class="room-code" id="roomCode">${escapeHtml(state.code)}</span>
            <button class="pixel-btn small" id="btnCopy">Copy</button>
          </div>
          <p class="hint">Share the code. Friends pick <b>Join a game</b> and type it in.</p>
          <div class="lobby-cols">
            <div class="lobby-left">
              <div class="slot-list" id="slotList"></div>
            </div>
            <div class="lobby-right">
              ${this.mapPreviewHtml(seed)}
            </div>
          </div>
          <div class="menu-buttons row">
            <button class="pixel-btn" id="btnCancel">Cancel</button>
            <button class="pixel-btn primary" id="btnStart">Start match</button>
          </div>
        </div>
      </div>`);

    this.bindPreview(seed);
    this.root.querySelector('#btnCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.code);
        this.root.querySelector('#btnCopy').textContent = 'Copied';
        setTimeout(() => {
          const b = this.root.querySelector('#btnCopy');
          if (b) b.textContent = 'Copy';
        }, 1400);
      } catch {
        // Clipboard permission denied; the code is on screen regardless.
      }
    });
    this.root.querySelector('#btnCancel').addEventListener('click', () => this.app.cancelHosting());
    this.root.querySelector('#btnStart').addEventListener('click', () => this.app.beginMatch());
    this.renderSlots(state);
  }

  /** @param {boolean} canEdit only the host may fill or clear slots */
  renderSlots(state, canEdit = true) {
    const list = this.root.querySelector('#slotList');
    if (!list) return;
    const rows = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const p = state.players.find((x) => x.slot === slot);
      const color = COLORS[slot];
      if (p) {
        rows.push(`
          <div class="slot filled" style="--c:${COLOR_HEX[color]}">
            <img class="face" alt="" src="${avatarURL(slot)}">
            <span class="slot-name">${escapeHtml(p.name)}</span>
            <span class="slot-tag">${p.host ? 'host' : p.ai ? 'computer' : 'connected'}</span>
            ${p.host || !canEdit ? '' : `<button class="pixel-btn tiny" data-remove="${slot}">Remove</button>`}
          </div>`);
      } else {
        rows.push(`
          <div class="slot empty" style="--c:${COLOR_HEX[color]}">
            <span class="swatch"></span>
            <span class="slot-name">Open slot</span>
            ${canEdit ? `<button class="pixel-btn tiny" data-addai="${slot}">Add AI</button>` : ''}
          </div>`);
      }
    }
    list.innerHTML = rows.join('');
    for (const b of list.querySelectorAll('[data-addai]')) {
      b.addEventListener('click', () => { audio.play('click'); this.app.addAI(Number(b.dataset.addai)); });
    }
    for (const b of list.querySelectorAll('[data-remove]')) {
      b.addEventListener('click', () => { audio.play('click'); this.app.removeSlot(Number(b.dataset.remove)); });
    }
  }

  // -- joining ---------------------------------------------------------------

  showJoin(error) {
    this.show(`
      <div class="screen">
        <h2 class="screen-title">Join a game</h2>
        <div class="panel banner-panel join-panel">
          <label class="field"><span>Room code</span>
            <input id="codeInput" maxlength="4" placeholder="ABCD" autocomplete="off" spellcheck="false">
          </label>
          ${error ? `<div class="error-note">${escapeHtml(error)}</div>` : ''}
          <div class="menu-buttons row">
            <button class="pixel-btn" id="btnBack">Back</button>
            <button class="pixel-btn primary" id="btnGo">Connect</button>
          </div>
        </div>
      </div>`);
    const input = this.root.querySelector('#codeInput');
    input.focus();
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    const go = () => this.app.joinGame(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    this.root.querySelector('#btnGo').addEventListener('click', go);
    this.root.querySelector('#btnBack').addEventListener('click', () => this.showTitle());
  }

  showConnecting(text) {
    this.show(`
      <div class="screen">
        <div class="panel banner-panel status-panel">
          <div class="spinner"></div>
          <div class="status-text">${escapeHtml(text)}</div>
        </div>
      </div>`);
  }

  showGuestLobby(state) {
    this.show(`
      <div class="screen">
        <h2 class="screen-title">Waiting for the host</h2>
        <div class="panel banner-panel lobby-panel">
          <div class="code-row">
            <span class="code-label">Room code</span>
            <span class="room-code">${escapeHtml(state.code)}</span>
          </div>
          <div class="lobby-cols">
            <div class="lobby-left"><div class="slot-list" id="slotList"></div></div>
            <div class="lobby-right">
              <div class="map-preview">
                <canvas id="mapCanvas" width="68" height="68"></canvas>
                <div class="map-stats" id="mapStats"></div>
              </div>
            </div>
          </div>
          <p class="hint">The host starts the match when everyone is in.</p>
          <div class="menu-buttons row">
            <button class="pixel-btn" id="btnLeave">Leave</button>
          </div>
        </div>
      </div>`);
    this.renderSlots(state, false);
    this.paintPreview(state.seed);
    this.root.querySelector('#btnLeave').addEventListener('click', () => this.app.leaveLobby());
  }

  updateGuestLobby(state) {
    if (!this.root.querySelector('#slotList')) { this.showGuestLobby(state); return; }
    this.renderSlots(state, false);
    if (this.previewSeed !== state.seed) {
      this.previewSeed = state.seed;
      this.paintPreview(state.seed);
    }
  }

  // -- help ------------------------------------------------------------------

  showHelp() {
    const unitRows = Object.entries(UNITS).map(([key, def]) => `
      <div class="help-row">
        <img alt="" src="${unitIcon(key)}">
        <div><b>${def.name}</b><span>${escapeHtml(def.blurb)}</span></div>
      </div>`).join('');
    const buildRows = Object.entries(BUILDINGS).filter(([k]) => k !== 'castle').map(([key, def]) => {
      const cost = RESOURCES.filter((r) => def.cost[r])
        .map((r) => `<img alt="" class="ci" src="${iconURL(RES_ICON[r])}">${def.cost[r]}`)
        .join(' ');
      return `<div class="help-row">
        <div><b>${def.name}</b> <span class="cost">${cost}</span><span>${escapeHtml(def.blurb)}</span></div>
      </div>`;
    }).join('');

    this.show(`
      <div class="screen">
        <h2 class="screen-title">How to play</h2>
        <div class="panel banner-panel help-panel">
          <div class="help-cols">
            <section>
              <h3>The goal</h3>
              <p>Destroy every other player's castle. Lose your own and you are out.</p>
              <h3>Economy</h3>
              <p>Pawns are drones: left idle they pick whichever resource you are
                 shortest of and work it without being told, and they rethink it after
                 every delivery. Right-click a tree or a gold seam to direct one
                 yourself.</p>
              <h3>Expanding</h3>
              <p>An Outpost is a second base. It trains drones, takes their deliveries
                 so a far-off seam stops being a long walk, and raises the number of
                 drones you may hold.</p>
              <h3>Terrain</h3>
              <p>Rivers and lakes cut the island into regions joined by a handful of
                 land bridges. Those crossings are where the fighting happens.</p>
            </section>
            <section>
              <h3>Units</h3>
              ${unitRows}
            </section>
            <section>
              <h3>Buildings</h3>
              ${buildRows}
              <h3>Controls</h3>
              <div class="help-keys">
                <div><b>Left drag</b> box select</div>
                <div><b>Right click</b> move, attack, or gather</div>
                <div><b>A</b> attack-move · <b>S</b> stop · <b>G</b> hold</div>
                <div><b>Tab</b> select whole army · <b>P</b> halt training</div>
                <div><b>H O B R T M</b> place buildings</div>
                <div><b>Ctrl+1-9</b> / <b>1-9</b> control groups</div>
                <div><b>Arrows</b>, screen edge, or middle-drag to pan · <b>wheel</b> to zoom</div>
              </div>
            </section>
          </div>
          <div class="menu-buttons row">
            <button class="pixel-btn primary" id="btnBack">Back</button>
          </div>
        </div>
      </div>`);
    this.root.querySelector('#btnBack').addEventListener('click', () => this.showTitle());
  }
}

const unitIconCache = new Map();
/** A cropped idle frame, used as a small illustration in the help screen. */
function unitIcon(type) {
  if (unitIconCache.has(type)) return unitIconCache.get(type);
  const sheet = A.unit.Blue[type].idle;
  const box = sheet.fh;
  const inset = box === 320 ? 96 : 44;
  const url = cropDataURL(sheet, inset, inset, box - inset * 2, box - inset * 2);
  unitIconCache.set(type, url);
  return url;
}

export function randomSeed() {
  return (crypto.getRandomValues(new Uint32Array(1))[0] % 900000) + 100000;
}
