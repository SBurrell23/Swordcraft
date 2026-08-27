// Application shell: asset loading, menus, lobby, and handing off to a match.

import { loadAssets, COLORS } from './game/assets.js';
import { generateMap } from './game/mapgen.js';
import { Game } from './game/game.js';
import { Menu, randomSeed } from './ui/menu.js';
import { applySkin } from './ui/skin.js';
import { mountSettings, closeSettings } from './ui/settings.js';
import { Net, MAX_PLAYERS } from './net/peer.js';
import { MSG } from './net/protocol.js';
import { audio } from './game/audio.js';

class App {
  constructor() {
    this.menuRoot = document.getElementById('menu');
    this.hudRoot = document.getElementById('hud');
    this.canvas = document.getElementById('world');
    this.loading = document.getElementById('loading');
    this.playerName = localStorage.getItem('swordcraft.name') || defaultName();
    this.net = null;
    this.game = null;
    this.lobby = null;
    this.menu = null;
  }

  async boot() {
    const bar = this.loading.querySelector('.load-fill');
    const label = this.loading.querySelector('.load-text');
    try {
      await loadAssets((loaded, total) => {
        bar.style.width = (loaded / total * 100).toFixed(1) + '%';
        label.textContent = `Loading assets  ${loaded} / ${total}`;
      });
    } catch (err) {
      label.textContent = err.message;
      label.classList.add('error');
      return;
    }
    applySkin();
    mountSettings();
    this.loading.hidden = true;
    this.menu = new Menu(this.menuRoot, this);
    this.menu.showTitle();

    // Audio cannot start until the page has been interacted with, so ask for
    // the lobby theme now and let the first gesture actually start it.
    audio.playMusic('lobby');
    const wake = () => { audio.init(); audio.resumeMusic(); };
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });
  }

  setPlayerName(name) {
    this.playerName = name.slice(0, 16) || defaultName();
    localStorage.setItem('swordcraft.name', this.playerName);
  }

  // -- single player ---------------------------------------------------------

  startSkirmish(aiCount, difficulty, seed, colorIndex) {
    const players = [{
      id: 1, slot: colorIndex, name: this.playerName,
      color: COLORS[colorIndex], ai: false, host: true,
    }];
    let nextId = 2;
    for (let slot = 0; slot < MAX_PLAYERS && players.length <= aiCount; slot++) {
      if (slot === colorIndex) continue;
      players.push({
        id: nextId++, slot, name: 'Computer ' + (players.length),
        color: COLORS[slot], ai: true, host: false,
      });
    }
    this.launch({ seed, players, localPlayerId: 1, isHost: true, net: null, difficulty });
  }

  // -- hosting ---------------------------------------------------------------

  async startHosting() {
    this.menu.showConnecting('Opening a room…');
    this.net = new Net();
    try {
      const code = await this.net.host();
      this.lobby = {
        code,
        seed: randomSeed(),
        players: [{
          id: 1, slot: 0, name: this.playerName, color: COLORS[0],
          ai: false, host: true, peerId: null,
        }],
        nextId: 2,
      };
      this.net.addEventListener('message', (e) => this.onHostMessage(e.detail));
      this.net.addEventListener('peerclose', (e) => this.onGuestLeft(e.detail.peerId));
      this.net.addEventListener('neterror', (e) => this.menu.showTitle(e.detail.message));
      this.menu.showHostLobby(this.lobby);
    } catch (err) {
      this.closeNet();
      this.menu.showTitle(err.message);
    }
  }

  onHostMessage({ fromId, msg }) {
    if (!this.lobby || msg.t !== MSG.JOIN) return;
    if (this.lobby.players.some((p) => p.peerId === fromId)) return;
    const slot = this.freeSlot();
    if (slot < 0) { this.net.sendTo(fromId, { t: MSG.FULL }); return; }
    this.lobby.players.push({
      id: this.lobby.nextId++, slot,
      name: String(msg.name || 'Player').slice(0, 16),
      color: COLORS[slot], ai: false, host: false, peerId: fromId,
    });
    this.pushLobby();
    this.menu.renderSlots(this.lobby);
    audio.play('unitReady');
  }

  onGuestLeft(peerId) {
    if (!this.lobby) return;
    const before = this.lobby.players.length;
    this.lobby.players = this.lobby.players.filter((p) => p.peerId !== peerId);
    if (this.lobby.players.length !== before) {
      this.pushLobby();
      this.menu.renderSlots(this.lobby);
    }
  }

  freeSlot() {
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (!this.lobby.players.some((p) => p.slot === s)) return s;
    }
    return -1;
  }

  addAI(slot) {
    if (!this.lobby || this.lobby.players.some((p) => p.slot === slot)) return;
    this.lobby.players.push({
      id: this.lobby.nextId++, slot,
      name: 'Computer ' + (this.lobby.players.filter((p) => p.ai).length + 1),
      color: COLORS[slot], ai: true, host: false, peerId: null,
    });
    this.pushLobby();
    this.menu.renderSlots(this.lobby);
  }

  removeSlot(slot) {
    if (!this.lobby) return;
    const victim = this.lobby.players.find((p) => p.slot === slot);
    if (!victim || victim.host) return;
    if (victim.peerId) this.net.sendTo(victim.peerId, { t: MSG.KICK });
    this.lobby.players = this.lobby.players.filter((p) => p.slot !== slot);
    this.pushLobby();
    this.menu.renderSlots(this.lobby);
  }

  onSeedChanged(seed) {
    if (!this.lobby) return;
    this.lobby.seed = seed;
    this.pushLobby();
  }

  /** Sends every guest the lobby, tagged with which player they are. */
  pushLobby() {
    if (!this.net || !this.lobby) return;
    const payload = {
      t: MSG.LOBBY,
      code: this.lobby.code,
      seed: this.lobby.seed,
      players: this.lobby.players.map(({ peerId, ...rest }) => rest),
    };
    for (const p of this.lobby.players) {
      if (p.peerId) this.net.sendTo(p.peerId, { ...payload, you: p.id });
    }
  }

  beginMatch() {
    if (!this.lobby) return;
    if (this.lobby.players.length < 2) {
      this.menu.showHostLobby(this.lobby);
      this.toastInMenu('Add at least one opponent — a guest or an AI.');
      return;
    }
    const players = this.lobby.players.map(({ peerId, ...rest }) => rest);
    this.net.broadcast({ t: MSG.START, seed: this.lobby.seed, players });
    this.launch({
      seed: this.lobby.seed,
      players: this.lobby.players,
      localPlayerId: 1,
      isHost: true,
      net: this.net,
    });
  }

  cancelHosting() {
    this.closeNet();
    this.lobby = null;
    this.menu.showTitle();
  }

  // -- joining ---------------------------------------------------------------

  async joinGame(code) {
    if (!code || code.length < 4) { this.menu.showJoin('Enter the four-character room code.'); return; }
    this.menu.showConnecting('Connecting to ' + code + '…');
    this.net = new Net();
    this.net.addEventListener('message', (e) => this.onGuestMessage(e.detail.msg));
    this.net.addEventListener('hostgone', () => {
      if (!this.game) { this.closeNet(); this.menu.showTitle('The host closed the room.'); }
    });
    try {
      await this.net.join(code, this.playerName);
      this.menu.showConnecting('Connected. Waiting for the lobby…');
    } catch (err) {
      this.closeNet();
      this.menu.showJoin(err.message);
    }
  }

  onGuestMessage(msg) {
    if (!msg) return;
    if (msg.t === MSG.LOBBY) {
      this.lobby = { code: msg.code, seed: msg.seed, players: msg.players, you: msg.you };
      this.menu.updateGuestLobby(this.lobby);
    } else if (msg.t === MSG.START) {
      this.launch({
        seed: msg.seed,
        players: msg.players,
        localPlayerId: this.lobby ? this.lobby.you : msg.players[0].id,
        isHost: false,
        net: this.net,
      });
    } else if (msg.t === MSG.FULL) {
      this.closeNet();
      this.menu.showJoin('That game is full.');
    } else if (msg.t === MSG.KICK) {
      this.closeNet();
      this.menu.showTitle('The host removed you from the lobby.');
    }
  }

  leaveLobby() {
    this.closeNet();
    this.lobby = null;
    this.menu.showTitle();
  }

  // -- match -----------------------------------------------------------------

  launch({ seed, players, localPlayerId, isHost, net, difficulty }) {
    this.menu.hide();
    closeSettings();
    this.hudRoot.hidden = false;
    this.canvas.hidden = false;
    const map = generateMap(seed);
    this.game = new Game({
      canvas: this.canvas,
      hudRoot: this.hudRoot,
      map, players, localPlayerId, isHost, net, difficulty,
      onExit: (reason) => this.endMatch(reason),
    });
  }

  endMatch(reason) {
    this.game = null;
    audio.playMusic('lobby');
    this.canvas.hidden = true;
    this.hudRoot.hidden = true;
    this.hudRoot.innerHTML = '';
    this.closeNet();
    this.lobby = null;
    this.menu.showTitle(reason || undefined);
  }

  closeNet() {
    if (this.net) { this.net.close(); this.net = null; }
  }

  toastInMenu(text) {
    const el = document.createElement('div');
    el.className = 'menu-toast';
    el.textContent = text;
    this.menuRoot.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
}

function defaultName() {
  const first = ['Ash', 'Bram', 'Cove', 'Dain', 'Elm', 'Fen', 'Gale', 'Hale', 'Iris', 'Juno'];
  const last = ['bourne', 'crest', 'fell', 'gard', 'holt', 'mere', 'ridge', 'stone', 'vale', 'wick'];
  return first[Math.floor(Math.random() * first.length)] + last[Math.floor(Math.random() * last.length)];
}

const app = new App();
window.swordcraft = app;
app.boot();
