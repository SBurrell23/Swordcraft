// PeerJS transport.
//
// One peer hosts: it owns the room id, accepts up to three guests, runs the
// simulation and fans snapshots out over its connections. Guests hold a single
// connection to the host and speak only to it. There is no relay between
// guests, so the host is the hub of a star.
//
// Signalling uses the public PeerJS broker, so nothing needs to be deployed;
// the media path itself is a direct WebRTC data channel between browsers.

import { MSG, isBinary, toArrayBuffer } from './protocol.js';

/** Room codes avoid vowels and lookalikes so they survive being read aloud. */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const ROOM_PREFIX = 'swordcraft-v1-';
export const MAX_PLAYERS = 4;

function randomCode(len = 4) {
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

/**
 * Shared transport surface. `onMessage(fromId, data)` receives decoded objects
 * or raw ArrayBuffers; `onStatus(text)` reports connection progress.
 */
export class Net extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.isHost = false;
    this.code = '';
    /** Host: peerId -> DataConnection. Guest: just `this.hostConn`. */
    this.conns = new Map();
    this.hostConn = null;
    this.localId = 0;
    this.closed = false;
    /** peerId (or 'host') -> timestamp of the last frame received from them. */
    this.lastSeen = new Map();
    this.liveness = null;
    this.hostDropped = false;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** Creates the Peer object, retrying on an id collision when hosting. */
  createPeer(id) {
    return new Promise((resolve, reject) => {
      if (typeof window.Peer !== 'function') {
        reject(new Error('PeerJS failed to load. Check your network connection and reload.'));
        return;
      }
      const peer = id ? new window.Peer(id, PEER_OPTIONS) : new window.Peer(PEER_OPTIONS);
      const onOpen = () => { cleanup(); resolve(peer); };
      const onError = (err) => { cleanup(); peer.destroy(); reject(err); };
      const cleanup = () => { peer.off('open', onOpen); peer.off('error', onError); };
      peer.on('open', onOpen);
      peer.on('error', onError);
    });
  }

  // -- hosting ---------------------------------------------------------------

  async host() {
    this.isHost = true;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      try {
        this.peer = await this.createPeer(ROOM_PREFIX + code);
        this.code = code;
        break;
      } catch (err) {
        if (err && err.type === 'unavailable-id' && attempt < 5) continue;
        throw friendlyError(err);
      }
    }
    this.localId = 1;

    this.peer.on('connection', (conn) => this.acceptGuest(conn));
    this.startLiveness();
    this.peer.on('error', (err) => this.emit('neterror', friendlyError(err)));
    this.peer.on('disconnected', () => {
      if (!this.closed) this.peer.reconnect();
    });
    return this.code;
  }

  acceptGuest(conn) {
    conn.on('open', () => {
      if (this.conns.size >= MAX_PLAYERS - 1) {
        conn.send({ t: MSG.FULL });
        setTimeout(() => conn.close(), 400);
        return;
      }
      this.conns.set(conn.peer, conn);
      this.lastSeen.set(conn.peer, performance.now());
      this.watchConnection(conn, conn.peer);
      this.emit('peeropen', { peerId: conn.peer });
    });
    conn.on('data', (data) => this.receive(conn.peer, data));
    conn.on('close', () => this.dropPeer(conn.peer, conn));
    conn.on('error', () => this.dropPeer(conn.peer, conn));
  }

  // -- joining ---------------------------------------------------------------

  async join(code, name) {
    this.isHost = false;
    this.code = code.trim().toUpperCase();
    try {
      this.peer = await this.createPeer(null);
    } catch (err) {
      throw friendlyError(err);
    }
    this.peer.on('error', (err) => this.emit('neterror', friendlyError(err)));

    const conn = this.peer.connect(ROOM_PREFIX + this.code, {
      reliable: true,
      serialization: 'binary',
      metadata: { name },
    });
    this.hostConn = conn;

    await new Promise((resolve, reject) => {
      // A room that does not exist never opens, so fail on a timer as well as
      // on the broker's own error.
      const timer = setTimeout(() => {
        reject(new Error('No game found with code ' + this.code + '.'));
      }, 12000);
      conn.on('open', () => { clearTimeout(timer); resolve(); });
      conn.on('error', (err) => { clearTimeout(timer); reject(friendlyError(err)); });
      this.peer.on('error', (err) => {
        if (err && err.type === 'peer-unavailable') {
          clearTimeout(timer);
          reject(new Error('No game found with code ' + this.code + '.'));
        }
      });
    });

    conn.on('data', (data) => this.receive('host', data));
    conn.on('close', () => this.dropPeer('host', conn));
    conn.send({ t: MSG.JOIN, name });
    this.lastSeen.set('host', performance.now());
    this.watchConnection(conn, 'host');
    this.startLiveness();
  }

  // -- liveness --------------------------------------------------------------

  /**
   * Decides when a peer has really gone.
   *
   * A closed browser tab does not reliably fire a WebRTC close event, so
   * something has to notice. The obvious answer - have each side ping on a
   * timer - is wrong on its own: browsers throttle timers in background tabs to
   * about once a minute, so a player who merely alt-tabs would be kicked.
   *
   * The reliable signal is the peer connection's own ICE state, which is
   * maintained by the network stack and keeps running while the page is
   * hidden. That is the primary check; the heartbeat stays only as a slow
   * backstop for a peer whose transport claims health but has stopped talking.
   */
  watchConnection(conn, id) {
    const pc = conn.peerConnection;
    if (!pc) return;
    let graceTimer = null;
    const dead = () => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      this.dropPeer(id, conn);
    };
    const check = () => {
      const state = pc.connectionState || pc.iceConnectionState;
      if (state === 'failed' || state === 'closed') { dead(); return; }
      if (state === 'disconnected') {
        // A blip on a mobile network recovers; a closed tab does not.
        if (!graceTimer) graceTimer = setTimeout(dead, DISCONNECT_GRACE);
      } else if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };
    pc.addEventListener('connectionstatechange', check);
    pc.addEventListener('iceconnectionstatechange', check);
  }

  /** Tears down one peer exactly once, whichever signal noticed first. */
  dropPeer(id, conn) {
    if (this.isHost) {
      if (!this.conns.has(id)) return;
      this.conns.delete(id);
      this.lastSeen.delete(id);
      try { conn.close(); } catch { /* already gone */ }
      this.emit('peerclose', { peerId: id });
    } else {
      if (this.hostDropped) return;
      this.hostDropped = true;
      this.emit('hostgone', {});
    }
  }

  startLiveness() {
    if (this.liveness) return;
    this.liveness = setInterval(() => {
      if (this.closed) return;
      const now = performance.now();
      if (this.isHost) {
        for (const [peerId, conn] of [...this.conns]) {
          const seen = this.lastSeen.get(peerId) || 0;
          if (now - seen > SILENCE_TIMEOUT) this.dropPeer(peerId, conn);
        }
      } else {
        // Guests are otherwise silent between orders, so announce ourselves.
        this.sendToHost({ t: MSG.PING });
        const seen = this.lastSeen.get('host') || 0;
        if (now - seen > SILENCE_TIMEOUT) this.dropPeer('host', this.hostConn);
      }
    }, HEARTBEAT_MS);
  }

  // -- traffic ---------------------------------------------------------------

  receive(fromId, data) {
    this.lastSeen.set(fromId, performance.now());
    if (isBinary(data)) {
      this.emit('binary', { fromId, buffer: toArrayBuffer(data) });
    } else if (data && typeof data === 'object') {
      this.emit('message', { fromId, msg: data });
    }
  }

  /** Host: send to one guest. */
  /** Peer ids still connected, host side. */
  peerIds() { return [...this.conns.keys()]; }

  sendTo(peerId, payload) {
    const conn = this.conns.get(peerId);
    if (conn && conn.open) safeSend(conn, payload);
  }

  /** Host: send to every guest. */
  broadcast(payload, exceptPeerId = null) {
    for (const [peerId, conn] of this.conns) {
      if (peerId === exceptPeerId) continue;
      if (conn.open) safeSend(conn, payload);
    }
  }

  /** Guest: send to the host. */
  sendToHost(payload) {
    if (this.hostConn && this.hostConn.open) safeSend(this.hostConn, payload);
  }

  /** Works from either side. */
  send(payload) {
    if (this.isHost) this.broadcast(payload);
    else this.sendToHost(payload);
  }

  close() {
    this.closed = true;
    if (this.liveness) { clearInterval(this.liveness); this.liveness = null; }
    for (const conn of this.conns.values()) { try { conn.close(); } catch { /* closing anyway */ } }
    this.conns.clear();
    if (this.hostConn) { try { this.hostConn.close(); } catch { /* closing anyway */ } }
    if (this.peer) { try { this.peer.destroy(); } catch { /* closing anyway */ } }
    this.peer = null;
  }
}

/** A data channel can close between the `open` check and the write. */
function safeSend(conn, payload) {
  try { conn.send(payload); } catch { /* peer went away mid-send */ }
}

/**
 * Heartbeat cadence, how long a "disconnected" transport is given to recover,
 * and the backstop for a peer that is silent but whose transport looks healthy.
 * The backstop is generous on purpose: browsers throttle timers in hidden tabs
 * to roughly once a minute, and a player who alt-tabs has not left.
 */
const HEARTBEAT_MS = 2000;
const DISCONNECT_GRACE = 12000;
const SILENCE_TIMEOUT = 90000;

/** Public broker + public STUN. Enough for peers behind ordinary home NATs. */
const PEER_OPTIONS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

function friendlyError(err) {
  const type = err && err.type;
  const messages = {
    'peer-unavailable': 'No game found with that code. Check it and try again.',
    'network': 'Lost contact with the matchmaking server. Check your connection.',
    'server-error': 'The matchmaking server is unreachable right now. Try again shortly.',
    'browser-incompatible': 'This browser does not support WebRTC data channels.',
    'unavailable-id': 'That room code is already taken.',
    'webrtc': 'Could not open a direct connection to the other player.',
  };
  const e = new Error(messages[type] || (err && err.message) || 'Connection failed.');
  e.type = type;
  return e;
}
