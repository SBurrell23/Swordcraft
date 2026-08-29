// Sound. Every effect in Swordcraft is synthesised at runtime with WebAudio;
// the only audio files in the project are the two music tracks.
//
// The vocabulary is small and deliberate: filtered noise bursts for impacts and
// footsteps, detuned square/saw tones for horns and fanfares, ringing sine
// partials for metal and magic. World sounds are panned and attenuated against
// the camera so a battle across the map is a distant scuffle.

const MAX_VOICES = 24;

class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.enabled = true;
    // Two independent buses. Players nearly always want the music quieter than
    // the effects, so a single master volume is the wrong control to offer.
    this.sfxVolume = readStored('swordcraft.vol.sfx', 0.75);
    this.musicVolume = readStored('swordcraft.vol.music', 0.45);
    /** Chosen battle theme, or 'shuffle' to draw one per match. */
    this.gameTheme = readStoredString('swordcraft.theme', 'shuffle');
    this.voices = 0;
    /** Camera rect, set each frame, used to place world sounds. */
    this.listener = { x: 0, y: 0, halfW: 800, halfH: 450 };
    this.lastAt = new Map();
    /** Music elements, created lazily and routed into the music bus. */
    this.tracks = null;
    this.current = null;
    this.pendingMusic = null;
  }

  /** Browsers require a user gesture before audio starts; call this from one. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxVolume;
    this.sfxGain.connect(this.master);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicVolume;
    this.musicGain.connect(this.master);

    this.noiseBuffer = this.makeNoise(2.0);
    this.attachTracks();
  }

  setSfxVolume(v) {
    this.sfxVolume = clamp01(v);
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume;
    store('swordcraft.vol.sfx', this.sfxVolume);
  }

  setMusicVolume(v) {
    this.musicVolume = clamp01(v);
    if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
    // The elements also carry their own volume, for the case where WebAudio
    // could not be routed and they are playing straight to the speakers.
    for (const t of Object.values(this.tracks || {})) {
      if (t.el && !t.routed) t.el.volume = this.musicVolume;
    }
    store('swordcraft.vol.music', this.musicVolume);
  }

  get t() { return this.ctx.currentTime; }

  makeNoise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Guards against a hundred simultaneous sword hits melting the mix. */
  budget() {
    if (this.voices >= MAX_VOICES) return false;
    this.voices++;
    setTimeout(() => { this.voices--; }, 500);
    return true;
  }

  /** Rate-limits a named effect so stacked events do not phase-cancel. */
  throttle(name, ms) {
    const now = performance.now();
    const prev = this.lastAt.get(name) || 0;
    if (now - prev < ms) return false;
    this.lastAt.set(name, now);
    return true;
  }

  // -- primitives ------------------------------------------------------------

  /** A pitched tone with an exponential decay. */
  tone(freq, dur, { type = 'sine', gain = 0.3, at = 0, dest = null, glide = 0, attack = 0.005 } = {}) {
    const ctx = this.ctx;
    const t0 = this.t + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * glide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(dest || this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
    return g;
  }

  /** A band-passed burst of noise: impacts, footsteps, wind. */
  noise(dur, { freq = 1200, q = 1, gain = 0.3, at = 0, type = 'bandpass', dest = null, sweep = 0, attack = 0.002 } = {}) {
    const ctx = this.ctx;
    const t0 = this.t + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t0);
    if (sweep) filt.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t0 + dur);
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(dest || this.sfxGain);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.03);
    return g;
  }

  /**
   * Returns a gain node placed in the stereo field for a world position, or
   * null when the sound happens too far off screen to be worth playing.
   */
  place(x, y) {
    const L = this.listener;
    const dx = (x - L.x) / (L.halfW * 2.6);
    const dy = (y - L.y) / (L.halfH * 2.6);
    const d = Math.hypot(dx, dy);
    if (d > 1) return null;
    const g = this.ctx.createGain();
    g.gain.value = Math.max(0, 1 - d) ** 1.5;
    const pan = this.ctx.createStereoPanner
      ? this.ctx.createStereoPanner()
      : null;
    if (pan) {
      pan.pan.value = Math.max(-0.85, Math.min(0.85, dx * 2));
      g.connect(pan).connect(this.sfxGain);
    } else {
      g.connect(this.sfxGain);
    }
    return g;
  }

  // -- effects ---------------------------------------------------------------

  /**
   * Plays a named effect. World effects take a position; UI effects do not.
   * @param {string} name
   * @param {number} [x] world x
   * @param {number} [y] world y
   */
  play(name, x, y) {
    if (!this.enabled || !this.ctx) return;
    let dest = this.sfxGain;
    if (x !== undefined) {
      dest = this.place(x, y);
      if (!dest) return;
    }
    if (!this.budget()) return;
    const fn = this.effects[name];
    if (fn) fn.call(this, dest);
  }
}

/**
 * The effect bank. Each entry renders one sound into `dest`. They are written
 * as small recipes so the character of a sound is readable from the code.
 */
Audio.prototype.effects = {
  // --- combat -------------------------------------------------------------

  /** Sword on shield: a bright metallic clank with a short ring. */
  swordHit(dest) {
    this.noise(0.09, { freq: 3200, q: 1.4, gain: 0.30, sweep: 0.25, dest });
    this.tone(880 + Math.random() * 220, 0.20, { type: 'triangle', gain: 0.12, dest, glide: 0.55 });
    this.tone(2400 + Math.random() * 400, 0.14, { type: 'sine', gain: 0.07, dest });
  },

  /** Warrior's heavy swing: air, then a meaty landing. */
  swordSwing(dest) {
    this.noise(0.16, { freq: 900, q: 0.8, gain: 0.13, sweep: 2.4, dest });
  },

  /** Spear thrust: a tighter, lower, more percussive hit. */
  spearHit(dest) {
    this.noise(0.07, { freq: 1700, q: 2.2, gain: 0.26, sweep: 0.35, dest });
    this.tone(320, 0.16, { type: 'triangle', gain: 0.15, dest, glide: 0.5 });
  },

  /** Bowstring release. */
  bowShot(dest) {
    this.tone(180, 0.10, { type: 'sawtooth', gain: 0.13, dest, glide: 0.45 });
    this.noise(0.20, { freq: 2600, q: 0.7, gain: 0.10, sweep: 0.28, dest });
  },

  /** Arrow finding flesh: a dull thud with a splintery tail. */
  arrowHit(dest) {
    this.noise(0.06, { freq: 700, q: 1.6, gain: 0.24, sweep: 0.4, dest });
    this.tone(150, 0.12, { type: 'sine', gain: 0.16, dest, glide: 0.55 });
  },

  /** Arrow into stone or timber. */
  arrowThunk(dest) {
    this.noise(0.10, { freq: 380, q: 2.6, gain: 0.22, sweep: 0.5, dest });
  },

  /** A unit falls: a descending gasp of noise. */
  unitDeath(dest) {
    this.noise(0.30, { freq: 900, q: 0.9, gain: 0.16, sweep: 0.16, dest });
    this.tone(240, 0.34, { type: 'triangle', gain: 0.10, dest, glide: 0.42 });
  },

  /** Watchtower / building taking damage. */
  structureHit(dest) {
    this.noise(0.14, { freq: 260, q: 1.2, gain: 0.26, sweep: 0.55, dest });
    this.tone(90, 0.22, { type: 'square', gain: 0.10, dest, glide: 0.6 });
  },

  /** Building destroyed: a low collapse under a wide debris wash. */
  buildingDestroyed(dest) {
    this.noise(0.85, { freq: 420, q: 0.5, gain: 0.42, sweep: 0.12, dest });
    this.tone(70, 0.9, { type: 'square', gain: 0.26, dest, glide: 0.35, attack: 0.02 });
    this.tone(52, 1.1, { type: 'sine', gain: 0.22, dest, glide: 0.45, attack: 0.03 });
    for (let i = 0; i < 5; i++) {
      this.noise(0.16, { freq: 500 + Math.random() * 1800, q: 2, gain: 0.10, at: 0.10 + i * 0.09, dest });
    }
  },

  // --- work ---------------------------------------------------------------

  /** Axe into a trunk. */
  chop(dest) {
    this.noise(0.07, { freq: 520, q: 3.0, gain: 0.24, sweep: 0.45, dest });
    this.tone(190, 0.10, { type: 'triangle', gain: 0.11, dest, glide: 0.6 });
  },

  /** Pickaxe on ore: sharper, with a ringing partial. */
  mine(dest) {
    this.noise(0.06, { freq: 2400, q: 3.4, gain: 0.20, sweep: 0.4, dest });
    this.tone(1180, 0.22, { type: 'sine', gain: 0.10, dest });
    this.tone(1760, 0.16, { type: 'sine', gain: 0.05, dest });
  },

  /** Butchering a sheep. Kept brief and thumpy rather than gruesome. */
  butcher(dest) {
    this.noise(0.09, { freq: 320, q: 1.1, gain: 0.20, sweep: 0.5, dest });
  },

  /** Hammer on a build site. */
  hammer(dest) {
    this.noise(0.05, { freq: 1500, q: 2.4, gain: 0.20, sweep: 0.35, dest });
    this.tone(420, 0.09, { type: 'square', gain: 0.08, dest, glide: 0.5 });
  },

  /** Resources delivered to the castle: two rising coin-bright notes. */
  deposit(dest) {
    this.tone(1050, 0.09, { type: 'sine', gain: 0.11, dest });
    this.tone(1570, 0.13, { type: 'sine', gain: 0.09, at: 0.055, dest });
  },

  /** Foundation laid. */
  buildStart(dest) {
    this.tone(300, 0.20, { type: 'triangle', gain: 0.14, dest, glide: 1.5 });
    this.noise(0.22, { freq: 700, q: 0.8, gain: 0.12, sweep: 0.5, dest });
  },

  /** Building finished: a short, satisfied major triad. */
  buildDone(dest) {
    [523.25, 659.25, 783.99].forEach((f, i) =>
      this.tone(f, 0.34, { type: 'triangle', gain: 0.13, at: i * 0.07, dest }));
  },

  /** Monk's heal: shimmering fifths. */
  heal(dest) {
    [784, 1046.5, 1568].forEach((f, i) =>
      this.tone(f, 0.55, { type: 'sine', gain: 0.09, at: i * 0.05, dest, attack: 0.04 }));
  },

  // --- units and orders ---------------------------------------------------

  /** A new unit steps out of its building. */
  unitReady(dest) {
    this.tone(392, 0.16, { type: 'square', gain: 0.10, dest });
    this.tone(587.33, 0.24, { type: 'square', gain: 0.09, at: 0.10, dest });
  },

  /** Selecting units: a soft click with a little pitch to it. */
  select(dest) {
    this.tone(1250, 0.05, { type: 'sine', gain: 0.10, dest });
    this.noise(0.03, { freq: 3000, q: 1.5, gain: 0.05, dest });
  },

  /** Acknowledging a move order. */
  order(dest) {
    this.tone(700, 0.07, { type: 'triangle', gain: 0.10, dest, glide: 1.7 });
  },

  /** Acknowledging an attack order: same shape, angrier timbre. */
  orderAttack(dest) {
    this.tone(420, 0.10, { type: 'sawtooth', gain: 0.10, dest, glide: 1.5 });
    this.tone(630, 0.10, { type: 'sawtooth', gain: 0.06, at: 0.05, dest, glide: 1.4 });
  },

  // --- interface ----------------------------------------------------------

  click(dest) { this.tone(880, 0.04, { type: 'square', gain: 0.07, dest }); },

  hover(dest) { this.tone(1400, 0.025, { type: 'sine', gain: 0.035, dest }); },

  /** Refused action: a flat two-note fall. */
  deny(dest) {
    this.tone(220, 0.10, { type: 'square', gain: 0.10, dest });
    this.tone(165, 0.16, { type: 'square', gain: 0.10, at: 0.09, dest });
  },

  /** Alarm: one of your buildings is under attack. */
  alert(dest) {
    this.tone(880, 0.13, { type: 'square', gain: 0.13, dest });
    this.tone(660, 0.13, { type: 'square', gain: 0.13, at: 0.16, dest });
    this.tone(880, 0.20, { type: 'square', gain: 0.13, at: 0.32, dest });
  },

  /** Match start: a rough war horn made of detuned saws. */
  gameStart(dest) {
    const base = 146.83;
    [0, 0.02, -0.015].forEach((det) => {
      this.tone(base * (1 + det), 1.5, { type: 'sawtooth', gain: 0.10, dest, attack: 0.14 });
      this.tone(base * 1.5 * (1 + det), 1.3, { type: 'sawtooth', gain: 0.07, at: 0.25, dest, attack: 0.14 });
    });
    this.noise(1.6, { freq: 400, q: 0.4, gain: 0.05, type: 'lowpass', dest, attack: 0.3 });
  },

  /** Victory fanfare. */
  victory(dest) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(f, 0.9, { type: 'triangle', gain: 0.15, at: i * 0.14, dest, attack: 0.02 });
      this.tone(f * 2, 0.6, { type: 'sine', gain: 0.06, at: i * 0.14, dest });
    });
  },

  /** Defeat: the same idea, sagging. */
  defeat(dest) {
    [392, 349.23, 311.13, 261.63].forEach((f, i) =>
      this.tone(f, 1.1, { type: 'triangle', gain: 0.14, at: i * 0.2, dest, attack: 0.03 }));
    this.tone(65.41, 2.0, { type: 'sine', gain: 0.16, at: 0.5, dest, attack: 0.2 });
  },

  /** A player left the match. */
  playerLeft(dest) {
    this.tone(330, 0.3, { type: 'triangle', gain: 0.10, dest, glide: 0.6 });
  },
};

/**
 * Background music.
 *
 * The tracks are ordinary <audio> elements routed into the music bus, which is
 * what lets one volume slider govern a streamed MP3 and the synthesised
 * effects alike. Playback cannot begin before the page has been interacted
 * with, so `play` is safe to call early and simply takes effect once the
 * context is running.
 */
/**
 * Battle music. One is picked in the sound panel and remembered; "Shuffle"
 * draws a different one at the start of each match, which is the setting worth
 * defaulting to when there are five of them.
 */
export const GAME_THEMES = [
  { key: 'breeze', name: 'Windy Breeze', src: 'audio/game-theme.mp3' },
  { key: 'banners', name: 'Banners High', src: 'audio/game-themes/game theme 1.mp3' },
  { key: 'siege', name: 'The Long Siege', src: 'audio/game-themes/game theme 2.mp3' },
  { key: 'salt', name: 'Salt and Timber', src: 'audio/game-themes/game theme 3.mp3' },
  { key: 'bridge', name: 'Last Bridge Standing', src: 'audio/game-themes/game theme 4.mp3' },
];

const TRACKS = {
  lobby: 'audio/lobby-theme.mp3',
  game: GAME_THEMES[0].src,
};

/** The theme that should be playing, resolving "shuffle" to an actual track. */
Audio.prototype.pickGameTheme = function pickGameTheme() {
  if (this.gameTheme === 'shuffle') {
    return GAME_THEMES[Math.floor(Math.random() * GAME_THEMES.length)];
  }
  return GAME_THEMES.find((t) => t.key === this.gameTheme) || GAME_THEMES[0];
};

/**
 * Chooses the battle theme. The <audio> element is reused rather than replaced,
 * because it is already wired into the music bus and re-routing it would need a
 * second createMediaElementSource on the same element - which throws.
 */
Audio.prototype.setGameTheme = function setGameTheme(key) {
  this.gameTheme = key;
  try { localStorage.setItem('swordcraft.theme', key); } catch { /* private mode */ }
  if (!this.tracks) return;
  const chosen = this.pickGameTheme();
  const track = this.tracks.game;
  if (track.src === chosen.src) return;
  track.src = chosen.src;
  track.el.src = chosen.src;
  if (this.current === 'game') {
    const started = track.el.play();
    if (started && started.catch) started.catch(() => { this.pendingMusic = 'game'; });
  }
};

Audio.prototype.initTracks = function initTracks() {
  if (this.tracks) return;
  this.tracks = {};
  for (const [name, src] of Object.entries(TRACKS)) {
    const el = new window.Audio();
    el.src = name === 'game' ? this.pickGameTheme().src : src;
    el.loop = true;
    el.preload = 'auto';
    el.volume = this.musicVolume;
    this.tracks[name] = { el, src, routed: false };
  }
};

/** Routes each element through the music bus, once a context exists. */
Audio.prototype.attachTracks = function attachTracks() {
  this.initTracks();
  for (const t of Object.values(this.tracks)) {
    if (t.routed || !this.ctx) continue;
    try {
      this.ctx.createMediaElementSource(t.el).connect(this.musicGain);
      t.routed = true;
      t.el.volume = 1;          // the bus handles level from here
    } catch {
      // Already routed, or the browser refused; the element keeps its own
      // volume and plays direct, which still works.
    }
  }
};

/** Starts one track and stops the other. */
Audio.prototype.playMusic = function playMusic(name) {
  this.initTracks();
  if (this.current === name) return;
  this.current = name;
  for (const [key, t] of Object.entries(this.tracks)) {
    if (key === name) continue;
    t.el.pause();
    t.el.currentTime = 0;
  }
  const track = this.tracks[name];
  if (!track) return;
  // Shuffle picks again every time the battle music starts, so a rematch is
  // not the same track over and over.
  if (name === 'game' && this.gameTheme === 'shuffle') {
    const chosen = this.pickGameTheme();
    if (track.src !== chosen.src) { track.src = chosen.src; track.el.src = chosen.src; }
  }
  const started = track.el.play();
  // Autoplay before a gesture rejects; the next init() picks it up again.
  if (started && started.catch) started.catch(() => { this.pendingMusic = name; });
};

Audio.prototype.stopMusic = function stopMusic() {
  this.current = null;
  this.pendingMusic = null;
  if (!this.tracks) return;
  for (const t of Object.values(this.tracks)) { t.el.pause(); t.el.currentTime = 0; }
};

/** Retries a track that autoplay blocked. Called from the first gesture. */
Audio.prototype.resumeMusic = function resumeMusic() {
  if (!this.pendingMusic) return;
  const name = this.pendingMusic;
  this.pendingMusic = null;
  this.current = null;
  this.playMusic(name);
};

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function readStoredString(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;   // private mode, or storage disabled
  }
}

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : clamp01(parseFloat(raw));
  } catch {
    return fallback;   // storage disabled; defaults are fine
  }
}

function store(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* not important */ }
}

/** The single shared audio engine. */
export const audio = new Audio();
