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
    this.lastSkirmish = { ai: aiCount, level: difficulty, color: colorIndex };
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
    if (!this.lobby) return;
    if (msg.t === MSG.SEAT) {
      const who = this.lobby.players.find((p) => p.peerId === fromId);
      if (who) this.takeSeat(Number(msg.slot), who.id);
      return;
    }
    if (msg.t !== MSG.JOIN) return;
    if (this.lobby.players.some((p) => p.peerId === fromId)) return;
    const slot = this.freeSlot();
    if (slot < 0) { this.net.sendTo(fromId, { t: MSG.FULL }); return; }
    this.lobby.players.push({
      id: this.lobby.nextId++, slot,
      name: String(msg.name || 'Player').slice(0, 16),
      color: COLORS[slot], ai: false, host: false, peerId: fromId,
    });
    this.pushLobby();
    this.refreshLobbyView();
    audio.play('unitReady');
  }

  onGuestLeft(peerId) {
    if (!this.lobby) return;
    const before = this.lobby.players.length;
    this.lobby.players = this.lobby.players.filter((p) => p.peerId !== peerId);
    if (this.lobby.players.length !== before) {
      this.pushLobby();
      this.refreshLobbyView();
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
    this.refreshLobbyView();
  }

  removeSlot(slot) {
    if (!this.lobby) return;
    const victim = this.lobby.players.find((p) => p.slot === slot);
    if (!victim || victim.host) return;
    if (victim.peerId) this.net.sendTo(victim.peerId, { t: MSG.KICK });
    this.lobby.players = this.lobby.players.filter((p) => p.slot !== slot);
    this.pushLobby();
    this.refreshLobbyView();
  }

  /**
   * Moves a player into an open seat. Colour is the seat, so this is also how
   * somebody changes colour - and the host arbitrates, because two guests
   * clicking the same empty slot at once must not both get it.
   * @param {number} slot
   * @param {number} [playerId] whom to seat; defaults to whoever asked
   */
  takeSeat(slot, playerId = null) {
    if (!this.lobby) return;
    if (!this.isHostSide()) {
      // A guest cannot move itself: it asks, and re-renders when the host says.
      this.net?.send({ t: MSG.SEAT, slot });
      return;
    }
    const id = playerId ?? 1;
    const who = this.lobby.players.find((p) => p.id === id);
    if (!who || slot < 0 || slot >= MAX_PLAYERS) return;
    if (this.lobby.players.some((p) => p.slot === slot)) return;   // taken
    who.slot = slot;
    who.color = COLORS[slot];
    this.refreshLobbyView();
    this.pushLobby();
  }

  /**
   * Repaints the seat list and, with it, the map preview - the island's size
   * and shape follow the seat count, so a seat change is a map change.
   */
  refreshLobbyView() {
    if (!this.lobby) return;
    this.menu.renderSlots(this.lobby);
    this.menu.paintPreview(this.lobby.seed, Math.max(2, this.lobby.players.length));
  }

  /** True when this client owns the lobby state rather than mirroring it. */
  isHostSide() { return !!(this.lobby && this.lobby.code && this.lobby.you === undefined); }

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
      // The host may go back to the lobby before this guest has closed its
      // result card. Keep the state, but do not paint a menu over a live match.
      if (!this.game) this.menu.updateGuestLobby(this.lobby);
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
    // The island's size and shape follow the seat count, so it has to be
    // generated with the same number every peer agreed on in the lobby.
    const map = generateMap(seed, players.length);
    this.game = new Game({
      canvas: this.canvas,
      hudRoot: this.hudRoot,
      map, players, localPlayerId, isHost, net, difficulty,
      onExit: (reason) => this.endMatch(reason),
    });
  }

  /**
   * Ends the match and puts the player back where another one starts from,
   * rather than at the front door. A skirmish returns to its own setup screen
   * with the settings it just used; a networked game returns to the lobby with
   * everyone still connected, so a rematch does not mean swapping codes again.
   */
  endMatch(reason) {
    this.game = null;
    audio.playMusic('lobby');
    this.canvas.hidden = true;
    this.hudRoot.hidden = true;
    this.hudRoot.innerHTML = '';

    const hosting = this.net && this.lobby && this.isHostSide();
    const guesting = this.net && this.lobby && !this.isHostSide();

    if (hosting) {
      // Drop anybody whose connection went away during the match, then put the
      // room back on screen for everyone still in it.
      const live = this.net.peerIds ? new Set(this.net.peerIds()) : null;
      if (live) this.lobby.players = this.lobby.players.filter((p) => !p.peerId || live.has(p.peerId));
      this.lobby.seed = randomSeed();
      this.menu.showHostLobby(this.lobby);
      this.pushLobby();
      if (reason) this.toastInMenu(reason);
      return;
    }
    if (guesting) {
      // Wait where we are; the host's next lobby push repaints this screen.
      this.menu.showGuestLobby(this.lobby);
      if (reason) this.toastInMenu(reason);
      return;
    }

    this.closeNet();
    this.lobby = null;
    this.menu.showSkirmish(this.lastSkirmish || {});
    if (reason) this.toastInMenu(reason);
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
