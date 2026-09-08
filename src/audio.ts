// Sound.
//
// Two halves, from two different places:
//
//  * The music is ours — a chiptune loop synthesised with Web Audio, square-wave lead over a
//    triangle bass with noise hats, which is the palette the era's chips had. This is the loop
//    this office has always had; the extracted Game Dev Story tracks are one URL away (?bgm=gds)
//    but they are not what plays.
//  * The cues are the game's own samples, extracted alongside the other copyrighted GDS assets
//    under public/assets/gds, which is intentionally git-ignored for personal use.
//
// Browsers only permit playback after a real user gesture, so unlock() starts everything on the
// first pointer/key interaction. The mute preference survives reloads.

const KEY = 'herdr-story:muted';
const ROOT = '/assets/gds/audio';

function loadMuted() {
  try { return localStorage.getItem(KEY) === '1'; }
  catch { return false; } // Safari can deny storage in private/restricted browsing contexts.
}

type Cue = 'done' | 'blocked' | 'working' | 'points' | 'open' | 'close' | 'levelup' | 'party';

// Cooldowns are long because nothing here is triggered by the person watching: points fly out of
// every working agent every second or two, and one reconnect re-seats thirty agents at once. A
// jingle is several seconds of music, so two of them inside a few seconds is not a fanfare, it is
// a pile-up. The visible side — banner, balloon, flame — is never gated, only the noise.
// Per-sample gain trims, calibrated against the synth loop (~-46 dBFS RMS). Jingles sit around
// -47 dBFS, interface cues around -49 dBFS, and frequent points around -52 dBFS. Limit cue peaks
// to -30 dBFS as well: matching average levels alone leaves the sad jingle's transient too loud.
// The quieter education recording needs less attenuation than the other samples.
const CUES: Record<Cue, { src: string; volume: number; cooldown?: number }> = {
  party:   { src: `${ROOT}/jingles/happy.ogg`, volume: 0.034, cooldown: 45_000 },
  done:    { src: `${ROOT}/jingles/happy.ogg`, volume: 0.034, cooldown: 20_000 },
  blocked: { src: `${ROOT}/jingles/sad.ogg`, volume: 0.048, cooldown: 12_000 },
  levelup: { src: `${ROOT}/jingles/kyouiku_bara1.ogg`, volume: 0.138, cooldown: 30_000 },
  working: { src: `${ROOT}/sound_effects/z_se00.ogg`, volume: 0.037, cooldown: 5_000 },
  points:  { src: `${ROOT}/sound_effects/z_se03.ogg`, volume: 0.016, cooldown: 4_000 },
  open:    { src: `${ROOT}/sound_effects/z_se04.ogg`, volume: 0.035 },
  close:   { src: `${ROOT}/sound_effects/z_se06.ogg`, volume: 0.036 },
};
/** No two cues closer together than this, whatever they are — a status sweep would otherwise
 *  fire several different jingles on the same frame. Clicks are exempt: those are feedback. */
const FLOOR_MS = 400;
const IMMEDIATE = new Set<Cue>(['open', 'close']);
/** One jingle at a time. They are seconds long, so overlapping two makes both unintelligible. */
const LONG = new Set<Cue>(['party', 'done', 'blocked', 'levelup']);

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
const BASS = [
  ['C3', 'C3', 'G2', 'G2'],
  ['A2', 'A2', 'E2', 'E2'],
  ['F2', 'F2', 'C3', 'C3'],
  ['G2', 'G2', 'D3', 'D3'],
];
const BPM = 132;
const EIGHTH = 60 / BPM / 2;

/** ?bgm=gds swaps the synth for one of the extracted tracks, for comparison. */
const BGM = new URLSearchParams(location.search).get('bgm');
const GDS_TRACK = `${ROOT}/background_music/level1.ogg`;

class GameAudio {
  private active = new Set<HTMLAudioElement>();
  private lastPlayed = new Map<Cue, number>();
  private lastAny = -Infinity;
  private jingle?: HTMLAudioElement;
  private unlocked = false;
  muted = loadMuted();
  /** 0..1 trims on top of the calibrated gains, from the settings window. */
  music = 1;
  effects = 1;

  // synthesised music
  private ctx?: AudioContext;
  private musicGain?: GainNode;
  private noise?: AudioBuffer;
  private timer?: number;
  private nextNote = 0;   // when the next eighth is due, in context time
  private step = 0;       // eighth-note counter into the loop
  // the sampled alternative, only built when ?bgm=gds asked for it
  private track?: HTMLAudioElement;

  /** Must be called directly from a pointer or keyboard event to satisfy autoplay policies. */
  unlock() {
    this.unlocked = true;
    if (!this.muted) this.startMusic();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch {}
    if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(muted ? 0 : MUSIC_GAIN * this.music, this.ctx.currentTime, 0.05);
    if (this.track) this.track.muted = muted;
    for (const sound of this.active) sound.muted = muted;
    if (!muted && this.unlocked) this.startMusic();
  }

  setLevels(music: number, effects: number) {
    this.music = Math.min(1, Math.max(0, music)); this.effects = Math.min(1, Math.max(0, effects));
    if (this.musicGain && this.ctx) this.musicGain.gain.setTargetAtTime(this.muted ? 0 : MUSIC_GAIN * this.music, this.ctx.currentTime, 0.05);
    if (this.track) this.track.volume = this.music;
  }

  /** Play a sampled one-shot. Cooldowns prevent a busy office from stacking the same cue. */
  play(name: Cue) {
    if (!this.unlocked || this.muted) return;
    const cue = CUES[name];
    const now = performance.now();
    if (cue.cooldown && now - (this.lastPlayed.get(name) ?? -Infinity) < cue.cooldown) return;
    if (!IMMEDIATE.has(name) && now - this.lastAny < FLOOR_MS) return;
    if (LONG.has(name) && this.jingle && !this.jingle.ended && !this.jingle.paused) return;
    this.lastPlayed.set(name, now);
    if (!IMMEDIATE.has(name)) this.lastAny = now;

    const sound = new window.Audio(cue.src);
    sound.preload = 'auto';
    sound.volume = cue.volume * this.effects;
    this.active.add(sound);
    const release = () => this.active.delete(sound);
    sound.addEventListener('ended', release, { once: true });
    sound.addEventListener('error', release, { once: true });
    if (LONG.has(name)) this.jingle = sound;
    void sound.play().catch(release);
  }

  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.track?.pause();
    void this.ctx?.close();
    this.ctx = undefined;
    for (const sound of this.active) sound.pause();
    this.active.clear();
  }

  private startMusic() {
    if (BGM === 'gds') {
      if (!this.track) {
        this.track = new window.Audio(GDS_TRACK);
        this.track.loop = true;
        this.track.preload = 'auto';
        this.track.volume = 0.22;
      }
      this.track.muted = this.muted;
      if (this.track.paused) void this.track.play().catch(() => {});
      return;
    }
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = this.ctx = new Ctor();
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.muted ? 0 : MUSIC_GAIN * this.music;
    this.musicGain.connect(ctx.destination);
    // one second of white noise, reused for every percussive hit
    const n = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
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
      const lead = LEAD[bar][beat];
      if (lead) this.tone(t, hz(lead), EIGHTH * 0.85, 'square', 0.18, mus);
      if (beat % 2 === 0) this.tone(t, hz(BASS[bar][beat / 2]), EIGHTH * 1.4, 'triangle', 0.30, mus);
      this.hit(t, 0.035, beat % 2 ? 0.09 : 0.05, mus, 6000);       // offbeat hats sit louder
      this.nextNote += EIGHTH;
      this.step++;
    }
  }
}

/** Where the music bus sits when unmuted. Sampled cues are gain-matched to this loop above. */
const MUSIC_GAIN = 0.10;

export const audio = new GameAudio();
