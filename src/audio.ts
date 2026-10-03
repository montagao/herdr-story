// Sound.
//
// Three kinds, from two different places:
//
//  * The music is ours — a chiptune loop synthesised with Web Audio, square-wave lead over a
//    triangle bass with noise hats, which is the palette the era's chips had. This is the loop
//    this office has always had; the extracted Game Dev Story tracks are one URL away (?bgm=gds)
//    but they are not what plays.
//  * The cues are the game's own samples, from the Game Dev Story pack under public/assets/gds.
//    That pack is left out of public builds, so every cue is decoration: nothing may depend on it.
//  * The interface blips are ours again — a few notes on the same oscillators, in the loop's key,
//    for the presses and arrivals the game's five effects do not cover.
//
// Browsers only permit playback after a real user gesture, so unlock() starts everything on the
// first pointer/key interaction. The mute preference survives reloads.

const KEY = 'herdr-story:muted';
const ROOT = '/assets/gds/audio';

function loadMuted() {
  try { return localStorage.getItem(KEY) === '1'; }
  catch { return false; } // Safari can deny storage in private/restricted browsing contexts.
}

type Cue = 'done' | 'ship' | 'sad' | 'working' | 'points' | 'open' | 'close' | 'levelup' | 'party' | 'cash';
/** A synthesised interface sound. See BLIPS for what each is for. */
export type Blip = 'tick' | 'press' | 'back' | 'send' | 'queue' | 'ok' | 'error' | 'coin' | 'settle' | 'pop' | 'bell';

// Cooldowns are long because nothing here is triggered by the person watching: points fly out of
// every working agent every second or two, and one reconnect re-seats thirty agents at once. A
// jingle is several seconds of music, so two of them inside a few seconds is not a fanfare, it is
// a pile-up. The visible side — banner, balloon, flame — is never gated, only the noise.
// Per-sample gain trims, calibrated against the synth loop (~-46 dBFS RMS). Jingles sit around
// -47 dBFS, interface cues around -49 dBFS, and frequent points around -52 dBFS. Limit cue peaks
// to -30 dBFS as well: matching average levels alone leaves the sad jingle's transient too loud.
// The education riser is trimmed against its two audible seconds, not its silent tail.
const CUES: Record<Cue, { src: string; volume: number; cooldown?: number; maxMs?: number }> = {
  // the whole eight seconds: ceremonies, launch days and big paydays
  party:   { src: `${ROOT}/jingles/happy.ogg`, volume: 0.034, cooldown: 45_000 },
  // its first phrase only, for a shipped task: the card's own fanfare
  done:    { src: `${ROOT}/jingles/happy.ogg`, volume: 0.034, cooldown: 12_000, maxMs: 2950 },
  // one chord, for a ship that could not have its card
  ship:    { src: `${ROOT}/jingles/kyouiku_bara2.ogg`, volume: 0.03, cooldown: 3_000 },
  sad:     { src: `${ROOT}/jingles/sad.ogg`, volume: 0.048, cooldown: 12_000 },
  levelup: { src: `${ROOT}/jingles/kyouiku_bara1.ogg`, volume: 0.085, cooldown: 30_000 },
  working: { src: `${ROOT}/sound_effects/z_se00.ogg`, volume: 0.037, cooldown: 5_000 },
  points:  { src: `${ROOT}/sound_effects/z_se03.ogg`, volume: 0.016, cooldown: 4_000 },
  // the till: every sale gets heard, only a burst of them shares one ring
  cash:    { src: `${ROOT}/sound_effects/z_se05.ogg`, volume: 0.05, cooldown: 1_500 },
  // windows: the short cooldowns fold a hand-off between two windows into one click
  open:    { src: `${ROOT}/sound_effects/z_se04.ogg`, volume: 0.035, cooldown: 80 },
  close:   { src: `${ROOT}/sound_effects/z_se06.ogg`, volume: 0.036, cooldown: 150 },
};
/** Tunes that last seconds. One at a time, and only a more important one may cut in: a level-up
 *  takes the floor from the fanfare of the task that earned it. `audible` is how long the tune
 *  actually sounds — the riser's file runs four seconds of silence past its last note. */
const TUNES: Partial<Record<Cue, { rank: number; audible: number }>> = {
  levelup: { rank: 2, audible: 2000 },
  party:   { rank: 1, audible: 8000 },
  done:    { rank: 1, audible: 3150 },
  sad:     { rank: 1, audible: 5500 },
};
/** Background texture. It waits for any tune to finish, and no two of these land closer together
 *  than the floor — a status sweep would otherwise fire a run of them on the same frame. */
const AMBIENT = new Set<Cue>(['working', 'points']);
const FLOOR_MS = 400;
/** How far the loop drops under a tune. The jingles are in another key, so the two cannot share
 *  the room; never to zero, because a bus that reads silent looks muted. */
const DUCK = 0.12;

// --- interface blips --------------------------------------------------------

type Voice = [offsetMs: number, note: string, lengthMs: number];
/** Voice gains are on the loop's scale (lead .18, bass .30), which puts these near -51 dBFS: under
 *  the window clicks, over the points. `gap` is the least time between two of the same blip, and
 *  `yields` means it stays out of the way of a tune. Keep this list short: too many is noise. */
const BLIPS: Record<Exclude<Blip, 'bell'>, { wave: OscillatorType; gain: number; gap: number; yields?: boolean; notes: Voice[] }> = {
  // tabs, filters, chips, switches
  tick:   { wave: 'triangle', gain: 0.16, gap: 50, yields: true, notes: [[0, 'G5', 35]] },
  // a primary button with no sound of its own
  press:  { wave: 'square', gain: 0.10, gap: 60, yields: true, notes: [[0, 'E5', 40], [45, 'G5', 60]] },
  // dismissing a card or a menu
  back:   { wave: 'triangle', gain: 0.16, gap: 60, yields: true, notes: [[0, 'G5', 40], [45, 'E5', 60]] },
  // a prompt on its way, before the bridge answers
  send:   { wave: 'square', gain: 0.11, gap: 250, notes: [[0, 'C5', 40], [45, 'E5', 40], [90, 'G5', 40], [135, 'C6', 90]] },
  queue:  { wave: 'triangle', gain: 0.18, gap: 150, notes: [[0, 'E5', 40], [70, 'E5', 50]] },
  // saved, copied, hired, back online
  ok:     { wave: 'square', gain: 0.09, gap: 400, notes: [[0, 'G5', 50], [60, 'C6', 140]] },
  error:  { wave: 'square', gain: 0.10, gap: 800, notes: [[0, 'A3', 70], [100, 'A3', 110]] },
  coin:   { wave: 'square', gain: 0.10, gap: 120, yields: true, notes: [[0, 'B5', 60], [60, 'E6', 220]] },
  // a turn that ended without shipping anything
  settle: { wave: 'triangle', gain: 0.14, gap: 4000, yields: true, notes: [[0, 'A5', 40], [50, 'G5', 40], [100, 'E5', 80]] },
  // something small arriving: a toast, a card, a badge
  pop:    { wave: 'triangle', gain: 0.14, gap: 120, yields: true, notes: [[0, 'D5', 30], [35, 'A5', 50]] },
};
/** The service bell on the front desk: an agent needs you. Two strikes, and it is exempt from
 *  every other gate — it is half a second long and it is the one sound that must not be lost. */
const BELL_GAP_MS = 2500;

// --- the office loop --------------------------------------------------------

const A4 = 440;
const SEMI: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** "C4", "F#3" -> Hz. Anything unparseable is silence. */
function hz(note: string): number {
  const m = /^([A-G]#?)(-?\d)$/.exec(note);
  if (!m) return 0;
  return A4 * 2 ** ((SEMI[m[1]] + (Number(m[2]) + 1) * 12 - 69) / 12);
}

/** Bars of the loop: eight eighth-notes of lead over four quarter-notes of bass.
 *  C - Am - F - G, which is about as cheerful as four chords get. */
const LEAD = [
  ['E5', 'G5', 'A5', 'G5', 'E5', 'D5', 'E5', ''],
  ['C5', 'E5', 'A5', 'G5', 'E5', 'C5', 'D5', ''],
  ['F5', 'A5', 'C6', 'A5', 'G5', 'F5', 'E5', ''],
  ['D5', 'G5', 'B5', 'G5', 'D5', 'E5', 'D5', ''],
];
/** A second tune over the same chords. The loop goes A A B A, so the pass that has played all day
 *  comes back as a homecoming every half minute instead of five hundred times an hour. */
const LEAD_B = [
  ['G5', 'E5', 'C5', 'E5', 'G5', 'A5', 'G5', ''],
  ['A5', 'E5', 'C5', 'E5', 'A5', 'C6', 'A5', ''],
  ['A5', 'F5', 'C5', 'F5', 'A5', 'G5', 'F5', ''],
  ['G5', 'D5', 'B4', 'D5', 'G5', 'B5', 'D6', ''],
];
const BASS = [
  ['C3', 'C3', 'G2', 'G2'],
  ['A2', 'A2', 'E2', 'E2'],
  ['F2', 'F2', 'C3', 'C3'],
  ['G2', 'G2', 'D3', 'D3'],
];
const BPM = 132;
const EIGHTH = 60 / BPM / 2;
/** Eighths in one pass of the four bars. */
const PASS = 32;

/** ?bgm=gds swaps the synth for one of the extracted tracks, for comparison; ?bgm=classic keeps
 *  the loop to its original single pass. */
const BGM = new URLSearchParams(location.search).get('bgm');
const GDS_TRACK = `${ROOT}/background_music/level1.ogg`;
const GDS_TRACK_GAIN = 0.22;

class GameAudio {
  private active = new Set<HTMLAudioElement>();
  private lastPlayed = new Map<Cue, number>();
  private lastBlip = new Map<Blip, number>();
  private lastAmbient = -Infinity;
  private tune?: HTMLAudioElement;
  private tuneRank = 0;
  private tuneUntil = -Infinity;
  private duckTimer?: number;
  private duck = 1;
  private unlocked = false;
  muted = loadMuted();
  /** 0..1 trims on top of the calibrated gains, from the settings window. */
  music = 1;
  effects = 1;

  // synthesised music and blips
  private ctx?: AudioContext;
  private musicGain?: GainNode;
  private sfxGain?: GainNode;
  private noise?: AudioBuffer;
  private timer?: number;
  private nextNote = 0;   // when the next eighth is due, in context time
  private step = 0;       // eighth-note counter into the loop
  // the sampled alternative, only built when ?bgm=gds asked for it
  private track?: HTMLAudioElement;

  /** Must be called directly from a pointer or keyboard event to satisfy autoplay policies. */
  unlock() {
    if (!this.unlocked) this.warm();
    this.unlocked = true;
    if (!this.muted) this.startMusic();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch {}
    this.applyLevels(0.05);
    if (this.track) this.track.muted = muted;
    for (const sound of this.active) sound.muted = muted;
    if (!muted && this.unlocked) this.startMusic();
  }

  setLevels(music: number, effects: number) {
    this.music = Math.min(1, Math.max(0, music)); this.effects = Math.min(1, Math.max(0, effects));
    this.applyLevels(0.05);
  }

  private musicLevel() { return this.muted ? 0 : MUSIC_GAIN * this.music * this.duck; }
  private sfxLevel() { return this.muted ? 0 : MUSIC_GAIN * this.effects; }
  private applyLevels(timeConstant: number) {
    if (this.ctx) {
      this.musicGain?.gain.setTargetAtTime(this.musicLevel(), this.ctx.currentTime, timeConstant);
      this.sfxGain?.gain.setTargetAtTime(this.sfxLevel(), this.ctx.currentTime, timeConstant);
    }
    if (this.track) this.track.volume = GDS_TRACK_GAIN * this.music * this.duck;
  }
  private quiet() { return !this.unlocked || this.muted || !!(window as unknown as { __quiet?: boolean }).__quiet; }

  /** Play a sampled one-shot; says whether it was let through. Cooldowns prevent a busy office
   *  from stacking the same cue, and the tune rules keep two jingles from sharing the air. */
  play(name: Cue): boolean {
    if (this.quiet()) return false;
    const cue = CUES[name], tune = TUNES[name];
    const now = performance.now();
    if (cue.cooldown && now - (this.lastPlayed.get(name) ?? -Infinity) < cue.cooldown) return false;
    if (AMBIENT.has(name)) {
      if (now < this.tuneUntil || now - this.lastAmbient < FLOOR_MS) return false;
      this.lastAmbient = now;
    } else if (tune && now < this.tuneUntil) {
      if (tune.rank <= this.tuneRank) return false;
      if (this.tune) this.hush(this.tune, 120);
    }
    this.lastPlayed.set(name, now);

    const sound = new window.Audio(cue.src);
    sound.preload = 'auto';
    sound.volume = cue.volume * this.effects;
    // the points pip is the most repeated sound in the office; a semitone either way keeps it
    // from ticking like a clock
    if (name === 'points') { sound.preservesPitch = false; sound.playbackRate = 0.94 + Math.random() * 0.12; }
    this.active.add(sound);
    const release = () => { this.active.delete(sound); if (this.tune === sound) this.tuneOver(); };
    sound.addEventListener('ended', release, { once: true });
    sound.addEventListener('error', release, { once: true });
    sound.addEventListener('pause', release, { once: true });
    if (tune) {
      this.tune = sound; this.tuneRank = tune.rank; this.tuneUntil = now + tune.audible;
      this.duckFor(tune.audible);
    }
    if (cue.maxMs) window.setTimeout(() => { if (this.active.has(sound)) this.hush(sound, 200); }, cue.maxMs);
    void sound.play().catch(release);
    return true;
  }

  /** Play a synthesised interface sound. Costs nothing to start — no fetch, no decode — and is
   *  silent wherever the samples would be: before the first gesture, muted, or effects at zero. */
  blip(name: Blip) {
    if (this.quiet() || this.effects <= 0) return;
    const now = performance.now();
    const spec = name === 'bell' ? undefined : BLIPS[name];
    if (now - (this.lastBlip.get(name) ?? -Infinity) < (spec ? spec.gap : BELL_GAP_MS)) return;
    if (spec?.yields && now < this.tuneUntil) return;
    // the till has just rung for the same money: one sound for one sale
    if (name === 'coin' && now - (this.lastPlayed.get('cash') ?? -Infinity) < 800) return;
    const ctx = this.context();
    if (!ctx || !this.sfxGain) return;
    if (ctx.state !== 'running') return;   // context() has already asked it to resume
    this.lastBlip.set(name, now);
    const at = ctx.currentTime + 0.005;
    if (spec) { for (const [offset, note, length] of spec.notes) this.tone(at + offset / 1000, hz(note), length / 1000, spec.wave, spec.gain, this.sfxGain); return; }
    // two strikes: the fundamental rings on, the octave partial is the clapper's bright edge
    [[0, 0.26, 0.12], [0.16, 0.34, 0.16]].forEach(([offset, ring, edge]) => {
      this.tone(at + offset, hz('E6'), ring, 'square', 0.11, this.sfxGain!);
      this.tone(at + offset, hz('E7'), edge, 'triangle', 0.08, this.sfxGain!);
    });
  }

  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    clearTimeout(this.duckTimer);
    this.track?.pause();
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined; this.musicGain = undefined; this.sfxGain = undefined;
    for (const sound of this.active) sound.pause();
    this.active.clear();
  }

  /** Fetch each sample once at the first gesture, so the first click of each kind is not late. */
  private warm() {
    for (const src of new Set(Object.values(CUES).map((cue) => cue.src))) {
      try { const sound = new window.Audio(); sound.preload = 'auto'; sound.src = src; sound.load(); }
      catch { /* no audio element, no cues */ }
    }
  }

  /** Stop whatever tune is playing: the window that started it was sent away by hand. */
  hushTune(ms = 180) { if (this.tune) this.hush(this.tune, ms); }

  /** Fade a sample out and stop it, rather than cutting it mid-note. */
  private hush(sound: HTMLAudioElement, ms: number) {
    const from = sound.volume, steps = Math.max(1, Math.round(ms / 25));
    let n = 0;
    const fade = window.setInterval(() => {
      n++;
      sound.volume = Math.max(0, from * (1 - n / steps));
      if (n >= steps) { clearInterval(fade); sound.pause(); }
    }, 25);
  }

  /** The loop steps back while a tune plays and returns on a downbeat when it is done. The timer
   *  is the backstop: a sample that never loads, or one with a silent tail, must still hand back. */
  private duckFor(ms: number) {
    this.duck = DUCK;
    this.applyLevels(0.03);
    clearTimeout(this.duckTimer);
    this.duckTimer = window.setTimeout(() => this.tuneOver(), ms + 150);
  }
  private tuneOver() {
    clearTimeout(this.duckTimer);
    this.tune = undefined; this.tuneRank = 0;
    this.tuneUntil = Math.min(this.tuneUntil, performance.now());
    if (this.duck === 1) return;
    this.duck = 1;
    this.step = Math.ceil(this.step / PASS) * PASS;
    this.applyLevels(0.12);
  }

  /** The shared context, built on first need. The music bus is created before the effects bus on
   *  purpose: the replay smoke test takes the context's first gain node to be the music's. */
  private context(): AudioContext | undefined {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {}); return this.ctx; }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;
    const ctx = this.ctx = new Ctor();
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.musicLevel();
    this.musicGain.connect(ctx.destination);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.sfxLevel();
    this.sfxGain.connect(ctx.destination);
    // one second of white noise, reused for every percussive hit
    const n = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
    return ctx;
  }

  private startMusic() {
    if (BGM === 'gds') {
      if (!this.track) {
        this.track = new window.Audio(GDS_TRACK);
        this.track.loop = true;
        this.track.preload = 'auto';
      }
      this.track.volume = GDS_TRACK_GAIN * this.music * this.duck;
      this.track.muted = this.muted;
      if (this.track.paused) void this.track.play().catch(() => {});
      return;
    }
    const ctx = this.context();
    if (!ctx || this.timer) return;
    this.nextNote = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private tone(at: number, f: number, dur: number, type: OscillatorType, gain: number, out: GainNode) {
    if (!this.ctx || !f) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, at);
    // a hard attack and a quick decay: no envelope hardware on the chips this imitates
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out); o.start(at); o.stop(at + dur + 0.02);
  }

  private hit(at: number, dur: number, gain: number, out: GainNode, hp = 4000) {
    if (!this.ctx || !this.noise) return;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    s.buffer = this.noise; s.loop = true;
    f.type = 'highpass'; f.frequency.value = hp;
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f); f.connect(g); g.connect(out); s.start(at); s.stop(at + dur + 0.02);
  }

  /** Look a tenth of a second ahead and queue whatever falls in it; setInterval is far too
   *  jittery to trigger notes directly. */
  private schedule() {
    const ctx = this.ctx, mus = this.musicGain;
    if (!ctx || !mus || ctx.state !== 'running') return;
    while (this.nextNote < ctx.currentTime + 0.12) {
      const t = this.nextNote, s = this.step;
      const bar = Math.floor(s / 8) % LEAD.length, beat = s % 8;
      // the third pass in every four takes the other tune
      const tune = BGM !== 'classic' && Math.floor(s / PASS) % 4 === 2 ? LEAD_B : LEAD;
      const lead = tune[bar][beat];
      if (lead) this.tone(t, hz(lead), EIGHTH * 0.85, 'square', 0.18, mus);
      if (beat % 2 === 0) this.tone(t, hz(BASS[bar][beat / 2]), EIGHTH * 1.4, 'triangle', 0.30, mus);
      this.hit(t, 0.035, beat % 2 ? 0.09 : 0.05, mus, 6000);       // offbeat hats sit louder
      this.nextNote += EIGHTH;
      this.step++;
    }
  }
}

/** Where the music bus sits when unmuted. Sampled cues are gain-matched to this loop above, and
 *  the interface blips ride an effects bus at the same level. */
const MUSIC_GAIN = 0.10;

export const audio = new GameAudio();
