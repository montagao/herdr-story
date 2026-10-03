import { closeOnEscape } from './escape';
// The game's event scenes, played in a window over the office.
//
// Game Dev Story cuts away from the floor for its big moments: the sales ranking board, the awards
// ceremony, the queue outside the shop on launch day, the team after a crunch, a training seminar,
// and the GAMEDEX convention. The art for every one of those is in the game's event sheets, cut
// out by scripts/extract-assets.sh into public/assets/gds/scenes. Each scene here is a backdrop
// from that set, the staff's own sprites acted over it, and a caption saying what the office did
// to earn it. One window at a time, never over a dialog, and a click or Escape ends it early.
// News goes stale if it cannot be shown; a ceremony waits until someone is there to see it.
// ?celebrate=0 turns these off along with the party.
import type Phaser from 'phaser';
import type { AgentInfo } from '../shared/types';
import { employeeName } from '../shared/studio';
import { BODY_POSE, FACE, FACE_W, FACE_H, ICONS, bodyKey, faceKey, lookOf, ensureAppearance } from './sprites';
import { audio, type Blip } from './audio';
import { snapShut } from './motion';
import './cutscenes.css';
import { Lifetime, anchorOfficeNotification } from './office-notification';

/** Someone drawn in a scene: a name for the caption and a body/face pair for the sprite. */
export interface Actor { name: string; look: { body: number; face: number } }
export const actorOf = (a: AgentInfo): Actor => ({ name: employeeName(a), look: lookOf(a) });

type Cue = 'party' | 'levelup' | 'done' | 'sad' | 'points';
export interface Scene {
  /** Scenes with the same id within a minute collapse into one. */
  id: string;
  stamp: string; heading: string; caption: string; detail?: string;
  width: number; height: number; duration: number; sound?: Cue;
  /** When the sound comes in, for a scene that builds up to it. A still frame plays it at once. */
  soundAt?: number;
  /** Small sounds on the scene's clock, in order. A still frame plays none of them. */
  beats?: { at: number; blip: Blip }[];
  /** The caption gives the ending away, so it is kept back until this much has played. */
  revealAt?: number;
  /** A ceremony: it waits for a sign that someone is there to watch, and does not go stale. */
  hold?: boolean;
  /** The id of the scene this one is the second half of; it follows that one straight on. */
  after?: string;
  /** Called when the scene opens, which can be long after it was asked for. */
  onShown?: () => void;
  /** Backdrop crops from public/assets/gds/scenes, by basename. */
  art: string[];
  actors?: Actor[];
  paint(c: CanvasRenderingContext2D, t: number, stage: Stage): void;
}

const ART = '/assets/gds/scenes';
const images = new Map<string, Promise<HTMLImageElement>>();
function loadArt(name: string) {
  let pending = images.get(name);
  if (!pending) {
    pending = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      // forget a failed load, so a scene missed while the bridge was down can play the next time
      image.onerror = () => { images.delete(name); reject(new Error(`Could not load ${name}`)); };
      image.src = `${ART}/${name}.png`;
    });
    images.set(name, pending);
  }
  return pending;
}

type Label = { size?: number; color?: string; stroke?: string; align?: CanvasTextAlign };
/** What a scene's paint routine draws with: the loaded backdrops, sprite and text helpers. */
export class Stage {
  constructor(private loaded: Map<string, HTMLImageElement>, private textures?: Phaser.Textures.TextureManager) {}
  art(name: string) { return this.loaded.get(name)!; }
  /** A body and face from the office's own sheets, drawn the way DrawHuman does. */
  sprite(c: CanvasRenderingContext2D, actor: Actor, x: number, y: number, frame: string) {
    const tx = this.textures;
    if (!tx) return;
    const p = BODY_POSE[frame] ?? BODY_POSE.standFront;
    const source = (key: string, fallback: string) => tx.get(tx.exists(key) ? key : fallback).getSourceImage() as CanvasImageSource;
    const body = source(bodyKey(actor.look.body), 'body0'), face = source(faceKey(actor.look.face), 'face0');
    c.drawImage(body, p.x, p.y, p.w, p.h, Math.round(x + p.dx), Math.round(y + p.dy), p.w, p.h);
    const [col, row] = FACE[p.face];
    c.drawImage(face, col * FACE_W, row * FACE_H, FACE_W, FACE_H, Math.round(x + p.fx), Math.round(y + p.fy), FACE_W, FACE_H);
  }
  /** A rect cut from one of the office's own sheets, when the office has it loaded. */
  cut(c: CanvasRenderingContext2D, key: string, [sx, sy, w, h]: readonly number[], x: number, y: number) {
    const tx = this.textures;
    if (tx?.exists(key)) c.drawImage(tx.get(key).getSourceImage() as CanvasImageSource, sx, sy, w, h, Math.round(x), Math.round(y), w, h);
  }
  label(c: CanvasRenderingContext2D, text: string, x: number, y: number, { size = 9, color = '#ffffff', stroke, align = 'left' }: Label = {}) {
    c.font = `${size}px DotGothic16`; c.textAlign = align; c.textBaseline = 'top';
    if (stroke) { c.lineWidth = 3; c.lineJoin = 'round'; c.strokeStyle = stroke; c.strokeText(text, x, y); }
    c.fillStyle = color; c.fillText(text, x, y);
  }
}

const GAP_MS = 2500;        // quiet time between scenes
const CHAIN_MS = 450;       // and between the two halves of one ceremony
const REST_MS = 3000;       // the office is left clear this long after anything else had the screen
const POLL_MS = 500;
const STALE_MS = 60_000;
const REPEAT_MS = 60_000;   // the same scene id is not shown twice within this
const PRESENT_MS = 300_000; // a press, key or scroll this recent means someone is at the desk
const SETTLE_MS = 1500;     // a ceremony that waited for them starts this long after they stop
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;
/** The trophy cup on main01, the one the studio's trophy shelf uses. */
const TROPHY = [0, 177, 16, 16];

export class Cutscenes {
  private root = document.createElement('div');
  /** Scenes waiting their turn, and when each was asked for. */
  private queue: { scene: Scene; at: number }[] = [];
  private current?: Scene;
  private raf = 0;
  private life = new Lifetime(() => this.end(true));
  private pumpTimer = 0;
  private lastClosed = 0;
  private restUntil = 0;
  /** The scene that last played to its end, so its second half can follow straight on. */
  private ended?: string;
  private lastInput = 0;
  /** A ceremony is waiting for someone to come back. */
  private absent = false;
  replay = false;
  private replayElapsed = 0;
  private replayPaint?: (at: number) => void;
  advance(delta: number) {
    if (!this.replay || !this.current || !this.replayPaint) return;
    this.replayElapsed += delta;
    this.replayPaint(this.reduced ? this.current.duration : this.replayElapsed);
    if (this.replayElapsed >= this.current.duration) this.close();
  }
  get pending() { return !!this.current || this.queue.length > 0; }
  reset() { this.queue = []; clearTimeout(this.pumpTimer); this.recent.clear(); this.lastClosed = 0; this.close(); }
  private recent = new Map<string, number>();
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  enabled = new URLSearchParams(location.search).get('celebrate') !== '0';
  /** True while something else has the screen; the scene waits rather than stacking on it. */
  busy = () => false;
  /** The scene was sent away by hand, so whatever tune it started should stop with it. */
  onDismiss?: () => void;

  constructor(private textures: () => Phaser.Textures.TextureManager | undefined) {
    this.root.id = 'cutscene'; this.root.hidden = true;
    document.body.append(this.root);
    anchorOfficeNotification(this.root);
    const dismiss = () => { this.onDismiss?.(); audio.blip('back'); this.close(); };
    this.root.addEventListener('click', dismiss);
    closeOnEscape(this.root, dismiss);
    // A ceremony plays to someone, not to an empty room: any press, key or scroll says they are here.
    const input = () => { this.lastInput = Date.now(); if (this.absent) this.pump(); };
    for (const type of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(type, input, { capture: true, passive: true });
    // Coming back to the tab is not the moment either: a few seconds, and a waiting card goes first.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.restUntil = Date.now() + REST_MS; this.pump(); } });
  }
  get isOpen() { return !this.root.hidden; }

  play(scene: Scene) {
    if (!this.enabled) return;
    const shown = this.recent.get(scene.id);
    if (!this.replay && shown && Date.now() - shown < REPEAT_MS) return;
    if (this.current?.id === scene.id) return;
    // a ceremony can wait a long while, so the same news asked for again replaces what was waiting
    const queued = this.queue.findIndex(q => q.scene.id === scene.id), entry = { scene, at: Date.now() };
    if (queued >= 0) { this.queue[queued] = entry; return; }
    this.queue.push(entry);
    while (this.queue.length > 4) this.queue.shift();
    this.pump();
  }

  private pump() {
    clearTimeout(this.pumpTimer);
    if (this.current || !this.queue.length) return;
    if (this.replay) { void this.show(this.queue.shift()!.scene); return; }
    const now = Date.now();
    const later = (ms: number) => { this.pumpTimer = window.setTimeout(() => this.pump(), ms); };
    // a scene that has waited a minute for the screen is stale news; drop it. A ceremony keeps.
    // ...for the rest of its own day: 'shipped today' is not news the next morning.
    const today = new Date(now).toDateString();
    this.queue = this.queue.filter(({ scene, at }) => scene.hold ? new Date(at).toDateString() === today : now - at < STALE_MS);
    if (!this.queue.some(({ scene }) => scene.hold)) this.absent = false;
    // Nobody sees a hidden tab: whatever is left waits for the tab to come back.
    if (document.hidden || !this.queue.length) return;
    if (this.busy()) { this.restUntil = now + REST_MS; later(POLL_MS); return; }
    // An ordinary scene may go ahead of a ceremony that is still waiting for its audience.
    const here = now - this.lastInput < PRESENT_MS;
    const index = this.queue.findIndex(({ scene }) => here || !scene.hold);
    if (index < 0) { this.absent = true; return; }
    const { scene } = this.queue[index];
    const gap = scene.after && scene.after === this.ended ? CHAIN_MS : GAP_MS;
    // not on top of the click that brought them back
    const settled = scene.hold && this.absent ? this.lastInput + SETTLE_MS : 0;
    const wait = Math.max(this.lastClosed + gap, this.restUntil, settled) - now;
    if (wait > 0) { later(wait); return; }
    if (scene.hold) this.absent = false;
    this.queue.splice(index, 1);
    void this.show(scene);
  }

  private async show(scene: Scene) {
    this.current = scene;
    const textures = this.textures();
    const loaded = new Map<string, HTMLImageElement>();
    try {
      await Promise.all([
        ...scene.art.map(async name => { loaded.set(name, await loadArt(name)); }),
        ...(scene.actors ?? []).map(actor => textures ? ensureAppearance(textures, actor.look).catch(() => {}) : Promise.resolve()),
      ]);
    } catch { this.current = undefined; this.pump(); return; }
    if (this.current !== scene) return;
    // A window may have opened while the art loaded (closing the last scene is what starts the
    // next one loading): go back to the head of the queue rather than open over it.
    if (!this.replay && this.busy()) {
      this.current = undefined; this.queue.unshift({ scene, at: Date.now() });
      clearTimeout(this.pumpTimer); this.pumpTimer = window.setTimeout(() => this.pump(), POLL_MS);
      return;
    }
    this.recent.set(scene.id, Date.now());
    // A replay and reduced motion both show the scene as stills, which have nothing to build up to.
    const still = this.replay || this.reduced;
    this.root.innerHTML = `<section class="cutscene-window" role="dialog" aria-label="${esc(scene.heading)}" style="--w:${scene.width};--h:${scene.height}">
      <header><span class="cutscene-stamp">${esc(scene.stamp)}</span><b>${esc(scene.heading)}</b><button type="button" data-close aria-label="Dismiss">×</button></header>
      <div class="cutscene-stage"><canvas width="${scene.width}" height="${scene.height}" role="img" aria-label="${esc(scene.caption)}"></canvas></div>
      <div class="cutscene-caption${scene.revealAt && !still ? ' held' : ''}"><b>${esc(scene.caption)}</b>${scene.detail ? `<span>${esc(scene.detail)}</span>` : ''}</div>
    </section>`;
    this.root.hidden = false;
    scene.onShown?.();
    const builds = !still && !!scene.soundAt;
    if (scene.sound && !builds) audio.play(scene.sound);
    const canvas = this.root.querySelector('canvas')!, c = canvas.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    const stage = new Stage(loaded, textures);
    const started = performance.now();
    const paint = (t: number) => { c.clearRect(0, 0, scene.width, scene.height); scene.paint(c, t, stage); };
    if (this.replay) { this.replayElapsed = 0; this.replayPaint = paint; paint(this.reduced ? scene.duration : 0); }
    else if (this.reduced) paint(scene.duration);
    else {
      const caption = this.root.querySelector('.cutscene-caption')!, beats = scene.beats ?? [];
      let beat = 0, sounded = !builds;
      const tick = (now: number) => {
        if (this.current !== scene) return;
        const t = now - started;
        if (!sounded && t >= scene.soundAt!) { sounded = true; audio.play(scene.sound!); }
        while (beat < beats.length && t >= beats[beat].at) audio.blip(beats[beat++].blip);
        if (t >= (scene.revealAt ?? 0)) caption.classList.remove('held');
        paint(t);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    }
    if (!this.replay) { this.life.start(scene.duration); this.life.watch(this.root.querySelector('.cutscene-window')!); }
  }

  close() { this.end(false); }
  /** `ranOut` is the scene reaching its end by itself, as against being dismissed or displaced. */
  private end(ranOut: boolean) {
    this.replayPaint = undefined;
    cancelAnimationFrame(this.raf); this.life.stop();
    if (!this.root.hidden) this.lastClosed = Date.now();
    if (!this.replay) snapShut(this.root.querySelector('.cutscene-window'));
    this.root.hidden = true; this.root.innerHTML = '';
    if (this.current) this.ended = ranOut ? this.current.id : undefined;
    this.current = undefined;
    this.pump();
  }
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

// ---------- the scenes ----------

export interface RankRow { name: string; value: string; color: string }
/** The ranking board (event8): the week's projects by what they brought in, or shipped. */
export function salesReport(label: string, rows: RankRow[], metric: 'sales' | 'shipments'): Scene {
  const top = rows[0], board = rows.slice(0, 4);
  // The board counts down: last place first, then a held breath before the winner.
  const landsAt = (i: number) => 400 + (board.length - 1 - i) * 450 + (i === 0 && board.length > 1 ? 300 : 0);
  return {
    id: `report:${label}`, stamp: 'WEEKLY REPORT', heading: metric === 'sales' ? `Sales ranking · ${label}` : `Shipments · ${label}`,
    caption: top ? `${top.name} leads the week with ${top.value}` : 'A quiet week on the charts',
    detail: rows.length > 1 ? rows.slice(1, 4).map(r => `${r.name} ${r.value}`).join(' · ') : undefined,
    width: 207, height: 122, duration: 8000, art: ['ranking_board'], hold: true,
    // the fanfare and the caption are the winner's, so both wait for the top row
    sound: top ? 'done' : undefined, soundAt: top ? landsAt(0) : undefined, revealAt: top ? landsAt(0) : undefined,
    beats: board.slice(1).map((_, k) => ({ at: landsAt(board.length - 1 - k), blip: 'tick' as const })),
    paint(c, t, s) {
      c.drawImage(s.art('ranking_board'), 0, 0);
      s.label(c, `${metric === 'sales' ? 'SALES RANKING' : 'SHIPMENTS'} · ${label}`, 104, 7, { size: 10, align: 'center' });
      board.forEach((r, i) => {
        const since = t - landsAt(i);
        if (since < 0) return;
        const y = 25 + i * 24;
        if (since < 120) { c.fillStyle = '#ffe9a8'; c.fillRect(31, y + 1, 174, 22); }   // each row lands with a flash
        s.label(c, String(i + 1), 16, y + 5, { size: 12, align: 'center' });
        c.fillStyle = r.color; c.fillRect(37, y + 8, 6, 6);
        s.label(c, clip(r.name, 22), 47, y + 6, { size: 9, color: '#3a2a20' });
        s.label(c, r.value, 198, y + 6, { size: 10, color: '#b31d0c', align: 'right' });
      });
      if (!rows.length) s.label(c, 'nothing on the board this week', 104, 62, { size: 9, color: '#8a5a4a', align: 'center' });
    },
  };
}

/** The walk toward the camera and to the right, as scenes/wander.ts steps it. */
const WALK_ON = ['standFront', 'walkFront1', 'standFront', 'walkFront2'];
/** The colours of the confetti the office floor throws for a big sale. */
const CONFETTI = ['#f2c94c', '#e8608a', '#5cc7f0', '#7ad37a', '#ffffff', '#f29d4c'];

/** The auditorium (event5): the winner walks on to the podium, the hosts beside them. */
export function awardsNight(winner: Actor, title: string, reason: string): Scene {
  const arrive = 1200, cheer = arrive + 400;
  return {
    id: `awards:${title}:${winner.name}`, stamp: 'AWARDS NIGHT', heading: title,
    caption: `${winner.name} takes the stage`, detail: reason,
    width: 240, height: 171, duration: 7500, sound: 'party', art: ['awards_hall', 'awards_hosts'], actors: [winner], hold: true,
    paint(c, t, s) {
      c.drawImage(s.art('awards_hall'), 0, 0);
      if (t >= arrive) { c.save(); c.globalAlpha = 0.16; c.fillStyle = '#fff4c8'; c.beginPath(); c.ellipse(150, 118, 40, 12, 0, 0, Math.PI * 2); c.fill(); c.restore(); }
      c.drawImage(s.art('awards_hosts'), 190, 101);
      const jump = Math.floor(t / 320) % 2;
      if (t < arrive) s.sprite(c, winner, 40 + Math.round(100 * t / arrive), 92, WALK_ON[Math.floor(t / 190) % 4]);
      else s.sprite(c, winner, 140, 92, t < cheer ? 'standFront' : jump ? 'cheerBig' : 'cheer');
      if (t >= cheer) {
        // the trophy goes up with their arms, and the hall lets go of its confetti
        s.cut(c, 'main01', TROPHY, 142, 78 - jump);
        CONFETTI.forEach((color, k) => {
          c.fillStyle = color;
          for (let i = k; i < 24; i += CONFETTI.length) c.fillRect((i * 37) % 240, Math.floor(((t - cheer) * (0.03 + (i % 5) * 0.006) + i * 23) % 118), 2, 2);
        });
      }
      s.label(c, 'STUDIO AWARDS', 120, 12, { size: 12, color: '#ffe9a8', stroke: '#2a1c08', align: 'center' });
      s.label(c, clip(title, 34), 120, 30, { size: 9, color: '#ffffff', stroke: '#2a1c08', align: 'center' });
    },
  };
}

/** The shop front and the queue (event3): a launch, or the best day the till has seen. */
export function launchDay(headline: string, caption: string, detail?: string): Scene {
  return {
    id: `launch:${headline}`, stamp: 'LAUNCH DAY', heading: headline, caption, detail,
    width: 200, height: 124, duration: 7500, sound: 'party', art: ['shop_front', 'shop_queue', 'shop_sign'],
    paint(c, t, s) {
      c.drawImage(s.art('shop_front'), 0, 0);
      // the line shuffles toward the doors on the left; it is tiled so it never runs out
      const shift = Math.floor(t / 110) % 200;
      c.drawImage(s.art('shop_queue'), -shift, 81); c.drawImage(s.art('shop_queue'), 200 - shift, 81);
      c.drawImage(s.art('shop_sign'), 168, 72);
      s.label(c, clip(headline, 30), 100, 5, { size: 11, stroke: '#12224a', align: 'center' });
    },
  };
}

/** The office after dark (event1): one person still at it, and the faces of a long night. */
export function crunchTime(actor: Actor, minutes: number, task: string): Scene {
  return {
    id: `crunch:${actor.name}`, stamp: 'CRUNCH TIME', heading: `${actor.name} is deep in it`,
    caption: `${minutes} minutes on the same task`, detail: task || undefined,
    width: 200, height: 123, duration: 6500, sound: 'sad', art: ['crunch_room', 'crunch_faces'], actors: [actor],
    paint(c, t, s) {
      c.drawImage(s.art('crunch_room'), 0, 0);
      s.sprite(c, actor, 10, 46, 'standIdle2');
      if (Math.floor(t / 650) % 3 === 0) { c.fillStyle = 'rgba(18,8,40,.3)'; c.fillRect(0, 0, 200, 81); }   // the lights flicker
      c.fillStyle = '#ffffff'; c.fillRect(0, 81, 200, 42);
      c.drawImage(s.art('crunch_faces'), 4, 81);
      s.label(c, 'CRUNCH TIME', 100, 6, { size: 12, color: '#f2d9ff', stroke: '#2a1040', align: 'center' });
    },
  };
}

/** The seminar room (event7): one of the staff at a screen, and the bar filling up. `levelUp`
 *  ends it on the game's own banner, for a seminar that was a promotion. */
export function trainingSeminar(actor: Actor, heading: string, caption: string, detail?: string, levelUp = false): Scene {
  // the bar fills in sixteen chunks and lands as the riser does, two seconds in
  const full = 1900;
  return {
    id: `training:${actor.name}:${heading}`, stamp: 'TRAINING', heading, caption, detail,
    width: 201, height: 127, duration: 5500, sound: 'levelup', beats: [{ at: full, blip: 'ok' }], art: ['training_room', 'training_bar'], actors: [actor],
    paint(c, t, s) {
      const complete = t >= full, done = complete ? 1 : Math.floor(t / full * 16) / 16;
      c.drawImage(s.art('training_room'), 0, 0);
      s.sprite(c, actor, 34, 58, complete ? 'cheer' : 'standAway');
      // The bar is drawn a third full. Empty it with a slice of its own trough, then fill it with a
      // column of its own blue, so the fill is seen to move from the first chunk.
      const bar = s.art('training_bar'), filled = Math.round(161 * done);
      c.drawImage(bar, 18, 110);
      c.drawImage(bar, 100, 2, 60, 13, 20, 112, 60, 13);
      if (complete && t < full + 120) { c.fillStyle = '#ffffff'; c.fillRect(20, 112, filled, 13); }
      else if (filled) c.drawImage(bar, 4, 2, 1, 13, 20, 112, filled, 13);
      s.label(c, complete ? 'COMPLETE!' : `${Math.round(done * 100)}%`, 100, 113, { size: 9, color: done > 0.55 ? '#ffffff' : '#2a3a9a', align: 'center' });
      s.label(c, 'SEMINAR', 100, 6, { size: 11, color: '#4a5a6a', align: 'center' });
      if (complete && levelUp) s.cut(c, 'main00', ICONS.levelup, 17, 40);
    },
  };
}

/** GAMEDEX (event4): the shipping crews on the show floor under the studio's screen. */
export function conventionDay(actors: Actor[], projects: string[]): Scene {
  const crew = actors.slice(0, 6);
  return {
    id: `expo:${new Date().toDateString()}`, stamp: 'GAMEDEX', heading: `${projects.length} projects shipped today`,
    caption: projects.slice(0, 4).join(' · '), detail: crew.map(a => a.name).join(', '),
    width: 240, height: 227, duration: 8000, sound: 'party', art: ['expo_hall', 'expo_sign', 'expo_crowd'], actors: crew, hold: true,
    paint(c, t, s) {
      c.drawImage(s.art('expo_hall'), 0, 0);
      s.label(c, `${projects.length} SHIPPED`, 120, 80, { size: 11, color: '#3a4a5a', align: 'center' });
      s.label(c, 'TODAY', 120, 94, { size: 9, color: '#6a7a8a', align: 'center' });
      crew.forEach((actor, i) => {
        const x = 120 - (crew.length - 1) * 14 + i * 28;
        s.sprite(c, actor, x, 118, Math.floor(t / 500 + i) % 3 === 0 ? 'cheer' : 'standFront');
      });
      c.drawImage(s.art('expo_sign'), 26, 170);
      c.drawImage(s.art('expo_crowd'), 20, 196);
    },
  };
}
