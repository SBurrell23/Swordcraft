// In-game interface.
//
// The HUD is DOM rather than canvas: it keeps hit-testing trivial (the world
// canvas simply never sees clicks that land on a panel) and lets the pixel-art
// frames be 9-sliced by CSS. The nine pieces of each frame are laid out with
// gaps in the source sheets, so they are repacked once at boot into tight data
// URLs that `border-image` can use directly.

import { A, ICON, COLOR_HEX, cropDataURL } from '../game/assets.js';
import { BUILDINGS, UNITS, BUILD_MENU, SELECT_GROUPS, RESOURCES, TILE, MAX_POP_CAP } from '../game/consts.js';
import { audio } from '../game/audio.js';
import { avatarURL, scrollBarURL } from './skin.js';

/** Which pack icon stands for each resource. */
export const RES_ICON = { wood: ICON.wood, gold: ICON.gold };

export class Hud {
  /**
   * @param {HTMLElement} root
   * @param {object} game
   */
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.toasts = [];
    this.lastAlertAt = 0;
    this.costFlash = new Map();
    this.build();
  }

  // -- construction ----------------------------------------------------------

  build() {
    this.root.innerHTML = `
      <div id="topbar">
        <div class="res-group">
          ${RESOURCES.map((r) => `
            <div class="res" data-res="${r}" title="${r}">
              <img class="icon" alt="" src="${iconURL(RES_ICON[r])}">
              <span class="amount" data-amount="${r}">0</span>
            </div>`).join('')}
          <div class="res pop" title="Population">
            <img class="icon" alt="" src="${iconURL(ICON.shield)}">
            <span class="amount" data-amount="pop">0/0</span>
            <span class="pop-max" hidden>MAX</span>
          </div>
        </div>
        <div id="playerchips"></div>
        <button id="menuBtn" class="pixel-btn small" title="Menu (Esc)">Menu</button>
      </div>

      <div id="bottombar">
        <div id="minimapPanel" class="slate-panel">
          <canvas id="minimap" width="240" height="240"></canvas>
        </div>

        <div id="selectionPanel" class="slate-panel">
          <div class="sel-main">
            <div id="selEmpty" class="sel-empty">Nothing selected</div>
            <div id="selSingle" class="sel-single" hidden>
              <img id="selPortrait" alt="">
              <div class="sel-body">
                <div id="selName" class="sel-name"></div>
                <div id="selHpWrap" class="sel-hp"><div id="selHp"></div></div>
                <div id="selBlurb" class="sel-blurb"></div>
                <div id="selExtra" class="sel-extra"></div>
              </div>
              <div class="sel-actions">
                <button id="prodBtn" class="pixel-btn tiny" hidden></button>
                <button id="razeBtn" class="pixel-btn tiny danger" hidden></button>
              </div>
            </div>
            <div id="selGroup" class="sel-group" hidden></div>
          </div>
          <div class="sel-quick">
            ${SELECT_GROUPS.map((g) => `
              <button class="pixel-btn tiny" data-select="${g.key}" title="${g.title}">
                <span class="q-label">${g.label}</span><b data-count="${g.key}">0</b>
              </button>`).join('')}
          </div>
        </div>

        <div id="buildPanel" class="slate-panel">
          <div class="panel-title">Build</div>
          <div id="buildButtons"></div>
        </div>
      </div>

      <div id="toasts"></div>
      <div id="modeHint" hidden></div>
    `;

    this.el = {
      amounts: Object.fromEntries([...RESOURCES, 'pop'].map((k) =>
        [k, this.root.querySelector(`[data-amount="${k}"]`)])),
      chips: this.root.querySelector('#playerchips'),
      minimap: this.root.querySelector('#minimap'),
      selEmpty: this.root.querySelector('#selEmpty'),
      selSingle: this.root.querySelector('#selSingle'),
      selPortrait: this.root.querySelector('#selPortrait'),
      selName: this.root.querySelector('#selName'),
      selHp: this.root.querySelector('#selHp'),
      selBlurb: this.root.querySelector('#selBlurb'),
      selExtra: this.root.querySelector('#selExtra'),
      selGroup: this.root.querySelector('#selGroup'),
      buildButtons: this.root.querySelector('#buildButtons'),
      toasts: this.root.querySelector('#toasts'),
      modeHint: this.root.querySelector('#modeHint'),
      menuBtn: this.root.querySelector('#menuBtn'),
      prodBtn: this.root.querySelector('#prodBtn'),
      razeBtn: this.root.querySelector('#razeBtn'),
      topbar: this.root.querySelector('#topbar'),
      popMax: this.root.querySelector('.pop-max'),
      counts: Object.fromEntries(SELECT_GROUPS.map((g) =>
        [g.key, this.root.querySelector(`[data-count="${g.key}"]`)])),
    };
    this.prodTarget = 0;

    this.buildButtons();
    this.bindMinimap();
    this.el.menuBtn.addEventListener('click', () => { audio.play('click'); this.game.toggleMenu(); });
    this.el.prodBtn.addEventListener('click', () => { audio.play('click'); this.game.toggleProduction(); });
    this.el.razeBtn.addEventListener('click', () => this.onRazeClicked());
    for (const b of this.root.querySelectorAll('[data-select]')) {
      b.addEventListener('click', () => {
        audio.play('click');
        this.game.selectAllOfKind(b.dataset.select);
      });
      b.addEventListener('mouseenter', () => audio.play('hover'));
    }
    this.mmCtx = this.el.minimap.getContext('2d');
    this.mmCtx.imageSmoothingEnabled = false;

    this.layoutTopbar();
    this.onResize = () => this.layoutTopbar();
    window.addEventListener('resize', this.onResize);
  }

  /**
   * Re-composes the scroll behind the resource readout at the bar's real size.
   * The art is placed rather than stretched, so this has to be redone whenever
   * the window changes width.
   */
  layoutTopbar() {
    const bar = this.el.topbar;
    if (!bar) return;
    // Keep the art at a fixed scale and vary the width instead: scaling the
    // pieces down thins the curl until it reads as a dashed line, not a roll.
    // The right-hand gap leaves the sound button its corner.
    const room = Math.max(360, Math.min(window.innerWidth - 140, 1080));
    const scroll = scrollBarURL(room, 0.5);
    bar.style.width = scroll.width + 'px';
    bar.style.height = scroll.height + 'px';
    bar.style.backgroundImage = `url(${scroll.url})`;
    // Keep the readout on the flat parchment, clear of the curl and the ends.
    bar.style.paddingLeft = Math.round(scroll.capLeft * 0.9) + 'px';
    bar.style.paddingRight = Math.round(scroll.capRight * 0.9) + 'px';
    bar.style.paddingBottom = (scroll.height - scroll.contentHeight) + 'px';
  }

  buildButtons() {
    this.el.buildButtons.innerHTML = BUILD_MENU.map(({ key, hotkey }) => {
      const def = BUILDINGS[key];
      const cost = RESOURCES.filter((r) => def.cost[r])
        .map((r) => `<span class="c"><img alt="" src="${iconURL(RES_ICON[r])}">${def.cost[r]}</span>`)
        .join('');
      // A population requirement is a cost like any other, so it is shown
      // alongside the resources rather than discovered by a failed click.
      const pop = def.requiresPop
        ? `<span class="c pop"><img alt="" src="${iconURL(ICON.shield)}">${def.requiresPop}</span>`
        : '';
      const needs = def.requiresPop ? ` — needs ${def.requiresPop} population` : '';
      return `
        <button class="pixel-btn build-btn" data-build="${key}" title="${def.name}${needs} — ${def.blurb}">
          <span class="bb-key">${hotkey}</span>
          <span class="bb-name">${def.name}</span>
          <span class="bb-cost">${cost}${pop}</span>
        </button>`;
    }).join('');
    for (const b of this.el.buildButtons.querySelectorAll('[data-build]')) {
      b.addEventListener('click', () => {
        audio.play('click');
        this.game.input.beginPlacement(b.dataset.build);
      });
      b.addEventListener('mouseenter', () => audio.play('hover'));
    }
  }

  bindMinimap() {
    const mm = this.el.minimap;
    let dragging = false;
    const jump = (e) => {
      const r = mm.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      const cam = this.game.renderer.camera;
      const span = this.game.map.tiles * TILE;
      cam.x = Math.max(0, Math.min(1, fx)) * span;
      cam.y = Math.max(0, Math.min(1, fy)) * span;
      cam.clamp();
    };
    mm.addEventListener('mousedown', (e) => { dragging = true; jump(e); e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (dragging) jump(e); });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // -- per-frame -------------------------------------------------------------

  update(view, dt) {
    const me = this.game.myPlayer();
    if (me) {
      for (const r of RESOURCES) {
        const el = this.el.amounts[r];
        const v = Math.floor(me.res[r] || 0);
        if (el.textContent !== String(v)) el.textContent = v;
      }
      this.el.amounts.pop.textContent = `${me.pop}/${me.popCap}`;
      // Two different problems wearing the same number. Full but able to build
      // another house reads as a red count - go build one. Full at the hard
      // ceiling reads as MAX, because no house is going to help.
      const full = me.pop >= me.popCap;
      const maxed = full && me.popCap >= MAX_POP_CAP;
      const chip = this.el.amounts.pop.parentElement;
      chip.classList.toggle('capped', full);
      chip.classList.toggle('maxed', maxed);
      chip.title = maxed ? `Population ${me.pop}/${me.popCap} - the hard ceiling; houses will not raise it`
        : full ? `Population ${me.pop}/${me.popCap} - build a house to train more`
          : 'Population';
      this.el.popMax.hidden = !maxed;
    }
    this.updateAffordability(me);
    this.updateQuickCounts(view);
    this.updateChips(view);
    this.drawMinimap(view);
    this.tickToasts(dt);
  }

  updateAffordability(me) {
    if (!me) return;
    for (const b of this.el.buildButtons.querySelectorAll('[data-build]')) {
      const def = BUILDINGS[b.dataset.build];
      const affordable = RESOURCES.every((r) => (me.res[r] || 0) >= (def.cost[r] || 0));
      // A pop requirement locks the button outright; being short of resources
      // only greys it, since that resolves on its own in a few seconds.
      const locked = !!def.requiresPop && me.pop < def.requiresPop;
      b.classList.toggle('unaffordable', !affordable && !locked);
      b.classList.toggle('locked', locked);
      b.disabled = locked;
      const popChip = b.querySelector('.c.pop');
      if (popChip) popChip.classList.toggle('unmet', locked);
      const flash = this.costFlash.get(b.dataset.build) || 0;
      b.classList.toggle('flash', performance.now() < flash);
    }
  }

  /**
   * Live counts on the quick-select buttons. Knowing you have eleven soldiers
   * before you click is half of why the button is useful.
   */
  updateQuickCounts(view) {
    const byRole = { worker: 0, melee: 0, ranged: 0, caster: 0 };
    for (const u of view.units) {
      if (u.owner !== this.game.localPlayerId) continue;
      const def = UNITS[u.type];
      if (def && byRole[def.role] !== undefined) byRole[def.role]++;
    }
    for (const g of SELECT_GROUPS) {
      const el = this.el.counts[g.key];
      if (!el) continue;
      const n = g.roles.reduce((sum, r) => sum + byRole[r], 0);
      if (el.textContent !== String(n)) el.textContent = n;
    }
  }

  updateChips(view) {
    const players = view.players;
    if (this.chipSignature === signature(players)) return;
    this.chipSignature = signature(players);
    this.el.chips.innerHTML = players.map((p) => {
      const def = this.game.playerInfo(p.id);
      const color = def ? COLOR_HEX[def.color] : '#888';
      return `<div class="chip ${p.alive ? '' : 'dead'}" style="--c:${color}">
          <img class="face" alt="" src="${avatarURL(def ? def.slot : p.id)}">
          <span class="pname">${escapeHtml(def ? def.name : 'Player')}</span>
          ${p.alive ? '' : '<span class="skull">defeated</span>'}
        </div>`;
    }).join('');
  }

  drawMinimap(view) {
    const ctx = this.mmCtx;
    const size = this.el.minimap.width;
    const r = this.game.renderer;
    if (!r.minimap) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(r.minimap, 0, 0, size, size);

    const k = size / (this.game.map.tiles * TILE);
    for (const b of view.buildings) {
      const def = BUILDINGS[b.kind];
      ctx.fillStyle = COLOR_HEX[b.colorName] || '#fff';
      const s = Math.max(3, def.foot[0] * TILE * k);
      ctx.fillRect(b.tx * TILE * k, b.ty * TILE * k, s, Math.max(3, def.foot[1] * TILE * k));
    }
    for (const u of view.units) {
      ctx.fillStyle = COLOR_HEX[u.colorName] || '#fff';
      ctx.fillRect(u.x * k - 1, u.y * k - 1, 2.5, 2.5);
    }

    const cam = r.camera;
    const v = cam.view();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(v.x0 * k, v.y0 * k, (v.x1 - v.x0) * k, (v.y1 - v.y0) * k);
  }

  // -- selection panel -------------------------------------------------------

  showSelection(entities) {
    const { selEmpty, selSingle, selGroup } = this.el;
    this.selectionIds = entities.map((e) => e.id).join(',');
    if (!entities.length) {
      selEmpty.hidden = false;
      selSingle.hidden = true;
      selGroup.hidden = true;
      return;
    }
    selEmpty.hidden = true;

    if (entities.length === 1) {
      selSingle.hidden = false;
      selGroup.hidden = true;
      this.showSingle(entities[0]);
      return;
    }

    selSingle.hidden = true;
    selGroup.hidden = false;
    // Group by type so a mixed army reads as counts, not a wall of portraits.
    const counts = new Map();
    for (const e of entities) {
      const key = e.type || e.kind;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    selGroup.innerHTML = [...counts.entries()].map(([key, n]) => {
      const def = UNITS[key] || BUILDINGS[key];
      return `<div class="gchip" title="${def ? def.name : key}">
          <span class="gname">${def ? def.name : key}</span>
          <span class="gcount">x${n}</span>
        </div>`;
    }).join('');
  }

  /**
   * Updates the live numbers on an unchanged selection. Called every frame, so
   * it touches values only - never innerHTML.
   */
  refreshSelection(entities) {
    if (entities.length !== 1) return;
    const e = entities[0];
    const def = e.type ? UNITS[e.type] : BUILDINGS[e.kind];
    if (!def) return;
    const frac = Math.max(0, Math.min(1, e.hp / def.hp));
    this.el.selHp.style.width = (frac * 100).toFixed(1) + '%';
    this.el.selHp.style.background = frac > 0.6 ? '#67c46b' : frac > 0.3 ? '#e0b84a' : '#d1584f';
    this.el.selExtra.textContent = this.extraText(e, def);
    this.syncProductionButton(e);
    this.syncRazeButton(e);
  }

  showSingle(e) {
    const isUnit = !!e.type;
    const def = isUnit ? UNITS[e.type] : BUILDINGS[e.kind];
    this.el.selName.textContent = def.name;
    this.el.selBlurb.textContent = def.blurb || '';
    const frac = Math.max(0, Math.min(1, e.hp / def.hp));
    this.el.selHp.style.width = (frac * 100).toFixed(1) + '%';
    this.el.selHp.style.background = frac > 0.6 ? '#67c46b' : frac > 0.3 ? '#e0b84a' : '#d1584f';

    const portrait = isUnit ? unitPortrait(e) : buildingPortrait(e);
    if (portrait) this.el.selPortrait.src = portrait;
    this.el.selExtra.textContent = this.extraText(e, def);
    this.syncProductionButton(e);
    this.syncRazeButton(e);
  }

  extraText(e, def) {
    const parts = [`${Math.ceil(e.hp)} / ${def.hp} hp`];
    if (e.type) {
      if (def.damage) parts.push(`${def.damage} dmg`);
      if (def.heal) parts.push(`${def.heal} heal`);
      if (def.armor) parts.push(`${def.armor} armour`);
    } else if (!e.done) {
      parts.push(`under construction — ${Math.round(e.progress * 100)}%`);
    } else if (def.spawns) {
      const cost = RESOURCES.filter((r) => UNITS[def.spawns].cost[r])
        .map((r) => `${UNITS[def.spawns].cost[r]} ${r}`).join(', ');
      parts.push(`trains ${UNITS[def.spawns].name} (${cost})`);
      if (e.paused) parts.push('production halted');
    }
    return parts.join('  ·  ');
  }

  onRazeClicked() {
    audio.play('buildingDestroyed');
    this.game.demolishSelected();
  }

  /**
   * A producing building gets a halt/resume control. Training spends resources
   * on a timer, so being able to shut it off is what lets a player bank for
   * something else.
   */
  syncProductionButton(e) {
    const btn = this.el.prodBtn;
    const mine = e.owner === this.game.localPlayerId;
    const def = e.type ? null : BUILDINGS[e.kind];
    const canToggle = !!def && def.spawns && e.done && mine;
    btn.hidden = !canToggle;
    if (!canToggle) { this.prodTarget = 0; return; }
    this.prodTarget = e.id;
    // Short enough to stay on one line: two of these stack in a fixed-height
    // column, and a label that wraps pushes the one below it out of the panel.
    btn.textContent = e.paused ? 'Resume (P)' : 'Halt (P)';
    btn.title = e.paused ? 'Resume training at this building (P)'
      : 'Stop training here so the cost can be banked elsewhere (P)';
    btn.classList.toggle('danger', !e.paused);
  }

  /** The demolish control, shown for any of your own buildings but the castle. */
  syncRazeButton(e) {
    const btn = this.el.razeBtn;
    const canRaze = !e.type && e.kind !== 'castle' && e.owner === this.game.localPlayerId;
    btn.hidden = !canRaze;
    if (!canRaze) return;
    btn.textContent = 'Demolish';
    btn.title = e.done ? 'Pull this building down for half its cost back'
      : 'Cancel this site; the cost is refunded in full';
  }

  // -- feedback --------------------------------------------------------------

  setMode(mode) {
    const hint = this.el.modeHint;
    const text = {
      attackMove: 'Attack-move: click a destination  ·  right-click or Esc to cancel',
      place: 'Placing a building: click to site it  ·  hold Shift to keep placing  ·  Esc to cancel',
      rally: 'Set rally point: click a destination',
    }[mode];
    hint.hidden = !text;
    if (text) hint.textContent = text;
  }

  flashCost(kind) {
    this.costFlash.set(kind, performance.now() + 500);
  }

  toast(text, tone = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + tone;
    el.textContent = text;
    this.el.toasts.appendChild(el);
    this.toasts.push({ el, t: 0, life: 3.2 });
  }

  /** Rate-limited "your base is under attack" warning. */
  alertUnderAttack(x, y) {
    const now = performance.now();
    if (now - this.lastAlertAt < 9000) return;
    this.lastAlertAt = now;
    this.toast('Your base is under attack!', 'danger');
    audio.play('alert');
    this.attackPing = { x, y, t: 0 };
  }

  tickToasts(dt) {
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.t += dt;
      if (t.t > t.life) { t.el.remove(); this.toasts.splice(i, 1); continue; }
      if (t.t > t.life - 0.6) t.el.style.opacity = String((t.life - t.t) / 0.6);
    }
  }

  /** End-of-match banner. */
  showResult(won, text) {
    const wrap = document.createElement('div');
    wrap.id = 'resultOverlay';
    wrap.innerHTML = `
      <div class="result-card special-panel">
        <div class="result-title ${won ? 'win' : 'lose'}">${won ? 'Victory' : 'Defeat'}</div>
        <div class="result-sub">${escapeHtml(text)}</div>
        <div class="result-actions">
          <button class="pixel-btn" id="resultWatch">Keep watching</button>
          <button class="pixel-btn primary" id="resultQuit">Back to menu</button>
        </div>
      </div>`;
    this.root.appendChild(wrap);
    wrap.querySelector('#resultWatch').addEventListener('click', () => { audio.play('click'); wrap.remove(); });
    wrap.querySelector('#resultQuit').addEventListener('click', () => { audio.play('click'); this.game.quitToMenu(); });
  }
}

// ---------------------------------------------------------------------------

const portraitCache = new Map();

/** Crops a unit's idle frame out of its sheet for the selection portrait. */
function unitPortrait(u) {
  const key = 'u:' + u.colorName + ':' + u.type;
  if (portraitCache.has(key)) return portraitCache.get(key);
  const anims = A.unit[u.colorName];
  if (!anims) return null;
  const sheet = anims[u.type].idle;
  // The Lancer's 320px box is mostly empty air above the spear; trim to the
  // same visual crop as everyone else.
  const box = sheet.fh;
  const inset = box === 320 ? 96 : 40;
  const url = cropDataURL(sheet, inset, inset, box - inset * 2, box - inset * 2);
  portraitCache.set(key, url);
  return url;
}

function buildingPortrait(b) {
  const key = 'b:' + b.colorName + ':' + b.kind + (b.variant || '');
  if (portraitCache.has(key)) return portraitCache.get(key);
  const set = A.building[b.colorName];
  if (!set) return null;
  const sheet = set[b.kind === 'house' ? 'house' + (b.variant || 1) : b.kind];
  if (!sheet) return null;
  const size = Math.min(sheet.img.width, sheet.img.height);
  const url = cropDataURL(sheet,
    (sheet.img.width - size) / 2, sheet.img.height - size, size, size);
  portraitCache.set(key, url);
  return url;
}

const iconCache = new Map();
/** A single 64x64 icon as its own data URL, for use in <img>. */
export function iconURL(index) {
  if (iconCache.has(index)) return iconCache.get(index);
  const url = cropDataURL(A.ui.icons[index], 0, 0, 64, 64);
  iconCache.set(index, url);
  return url;
}

function signature(players) {
  return players.map((p) => p.id + ':' + (p.alive ? 1 : 0)).join(',');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
