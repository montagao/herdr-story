import { closeOnEscape } from './escape';
// The game's event scenes, played in a window over the office.
//
// Game Dev Story cuts away from the floor for its big moments: the sales ranking board, the awards
// ceremony, the queue outside the shop on launch day, the team after a crunch, a training seminar,
// and the GAMEDEX convention. The art for every one of those is in the game's event sheets, cut
// out by scripts/extract-assets.sh into public/assets/gds/scenes. Each scene here is a backdrop
// from that set, the staff's own sprites acted over it, and a caption saying what the office did
// to earn it. One window at a time, never over a dialog, and a click or Escape ends it early.
// ?celebrate=0 turns these off along with the party.
import type Phaser from 'phaser';
import type { AgentInfo } from '../shared/types';
import { employeeName } from '../shared/studio';
import { BODY_POSE, FACE, FACE_W, FACE_H, bodyKey, faceKey, lookFor, ensureAppearance } from './sprites';
import { audio } from './audio';
import './cutscenes.css';
import { anchorOfficeNotification } from './office-notification';

/** Someone drawn in a scene: a name for the caption and a body/face pair for the sprite. */
export interface Actor { name: string; look: { body: number; face: number } }
export const actorOf = (a: AgentInfo): Actor => ({ name: employeeName(a), look: a.office_look ?? lookFor(a.pane_id) });

type Cue = 'party' | 'levelup' | 'done' | 'blocked' | 'points';
export interface Scene {
  /** Scenes with the same id within a minute collapse into one. */
  id: string;
  stamp: string; heading: string; caption: string; detail?: string;
  width: number; height: number; duration: number; sound?: Cue;
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
      image.onload = () => resolve(image); image.onerror = () => reject(new Error(`Could not load ${name}`));
      image.src = `${ART}/${name}.png`;
    });
    images.set(name, pending);
  }
  return pending;
}

type Label = { size?: number; color?: string; stroke?: string; align?: CanvasTextAlign };
/** What a scene's paint routine draws with: the loaded backdrops, sprite and text helpers. */
export class Stage {
  private pixels = new Map<string, CanvasRenderingContext2D>();
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
  label(c: CanvasRenderingContext2D, text: string, x: number, y: number, { size = 9, color = '#ffffff', stroke, align = 'left' }: Label = {}) {
    c.font = `${size}px DotGothic16`; c.textAlign = align; c.textBaseline = 'top';
    if (stroke) { c.lineWidth = 3; c.lineJoin = 'round'; c.strokeStyle = stroke; c.strokeText(text, x, y); }
    c.fillStyle = color; c.fillText(text, x, y);
  }
  /** One colour out of a backdrop, so a fill can match the art instead of guessing at it. */
  pixel(name: string, x: number, y: number) {
    let c = this.pixels.get(name);
    if (!c) {
      const image = this.art(name), off = document.createElement('canvas');
      off.width = image.width; off.height = image.height;
      c = off.getContext('2d')!; c.drawImage(image, 0, 0); this.pixels.set(name, c);
    }
    const [r, g, b] = c.getImageData(x, y, 1, 1).data;
    return `rgb(${r},${g},${b})`;
  }
}

const GAP_MS = 2500;        // quiet time between scenes
const REPEAT_MS = 60_000;   // the same scene id is not shown twice within this
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;

export class Cutscenes {
  private root = document.createElement('div');
  private queue: Scene[] = [];
  private current?: Scene;
  private raf = 0;
  private timer = 0;
  private pumpTimer = 0;
  private lastClosed = 0;
  private waitingSince = 0;
  private recent = new Map<string, number>();
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  enabled = new URLSearchParams(location.search).get('celebrate') !== '0';
  /** True while something else has the screen; the scene waits rather than stacking on it. */
  busy = () => false;

  constructor(private textures: () => Phaser.Textures.TextureManager | undefined) {
    this.root.id = 'cutscene'; this.root.hidden = true;
    document.body.append(this.root);
    anchorOfficeNotification(this.root);
    this.root.addEventListener('click', () => this.close());
    closeOnEscape(this.root, () => this.close());
  }
  get isOpen() { return !this.root.hidden; }

  play(scene: Scene) {
    if (!this.enabled) return;
    const shown = this.recent.get(scene.id);
    if (shown && Date.now() - shown < REPEAT_MS) return;
    if (this.current?.id === scene.id || this.queue.some(s => s.id === scene.id)) return;
    this.queue.push(scene);
    while (this.queue.length > 4) this.queue.shift();
    this.pump();
  }

  private pump() {
    if (this.current || !this.queue.length) return;
    const now = Date.now();
    if (this.busy() || now - this.lastClosed < GAP_MS) {
      // a scene that has waited a minute for the screen is stale news; drop it
      if (!this.waitingSince) this.waitingSince = now;
      if (now - this.waitingSince > 60_000) { this.queue.shift(); this.waitingSince = 0; }
      clearTimeout(this.pumpTimer); this.pumpTimer = window.setTimeout(() => this.pump(), 1500);
      return;
    }
    this.waitingSince = 0;
    void this.show(this.queue.shift()!);
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
    this.recent.set(scene.id, Date.now());
    this.root.innerHTML = `<section class="cutscene-window" role="dialog" aria-label="${esc(scene.heading)}" style="--w:${scene.width};--h:${scene.height}">
      <header><span class="cutscene-stamp">${esc(scene.stamp)}</span><b>${esc(scene.heading)}</b><button type="button" data-close aria-label="Dismiss">×</button></header>
      <div class="cutscene-stage"><canvas width="${scene.width}" height="${scene.height}" role="img" aria-label="${esc(scene.caption)}"></canvas></div>
      <div class="cutscene-caption"><b>${esc(scene.caption)}</b>${scene.detail ? `<span>${esc(scene.detail)}</span>` : ''}</div>
    </section>`;
    this.root.hidden = false;
    if (scene.sound) audio.play(scene.sound);
    const canvas = this.root.querySelector('canvas')!, c = canvas.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    const stage = new Stage(loaded, textures);
    const started = performance.now();
    const paint = (t: number) => { c.clearRect(0, 0, scene.width, scene.height); scene.paint(c, t, stage); };
    if (this.reduced) paint(scene.duration);
    else {
      const tick = (now: number) => { if (this.current !== scene) return; paint(now - started); this.raf = requestAnimationFrame(tick); };
      this.raf = requestAnimationFrame(tick);
    }
    this.timer = window.setTimeout(() => this.close(), scene.duration);
  }

  close() {
    cancelAnimationFrame(this.raf); clearTimeout(this.timer);
    if (!this.root.hidden) this.lastClosed = Date.now();
    this.root.hidden = true; this.root.innerHTML = '';
    this.current = undefined;
    this.pump();
  }
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

// ---------- the scenes ----------

export interface RankRow { name: string; value: string; color: string }
/** The ranking board (event8): the week's projects by what they brought in, or shipped. */
export function salesReport(label: string, rows: RankRow[], metric: 'sales' | 'shipments'): Scene {
  const top = rows[0];
  return {
    id: `report:${label}`, stamp: 'WEEKLY REPORT', heading: metric === 'sales' ? `Sales ranking · ${label}` : `Shipments · ${label}`,
    caption: top ? `${top.name} leads the week with ${top.value}` : 'A quiet week on the charts',
    detail: rows.length > 1 ? rows.slice(1, 4).map(r => `${r.name} ${r.value}`).join(' · ') : undefined,
    width: 207, height: 122, duration: 8000, sound: top ? 'done' : undefined, art: ['ranking_board'],
    paint(c, t, s) {
      c.drawImage(s.art('ranking_board'), 0, 0);
      s.label(c, `${metric === 'sales' ? 'SALES RANKING' : 'SHIPMENTS'} · ${label}`, 104, 7, { size: 10, align: 'center' });
      rows.slice(0, 4).forEach((r, i) => {
        if (t < 300 + i * 450) return;
        const y = 25 + i * 24;
        s.label(c, String(i + 1), 16, y + 5, { size: 12, align: 'center' });
        c.fillStyle = r.color; c.fillRect(37, y + 8, 6, 6);
        s.label(c, clip(r.name, 22), 47, y + 6, { size: 9, color: '#3a2a20' });
        s.label(c, r.value, 198, y + 6, { size: 10, color: '#b31d0c', align: 'right' });
      });
      if (!rows.length) s.label(c, 'nothing on the board this week', 104, 62, { size: 9, color: '#8a5a4a', align: 'center' });
    },
  };
}

/** The auditorium (event5): the winner at the podium, the hosts beside them. */
export function awardsNight(winner: Actor, title: string, reason: string): Scene {
  return {
    id: `awards:${title}:${winner.name}`, stamp: 'AWARDS NIGHT', heading: title,
    caption: `${winner.name} takes the stage`, detail: reason,
    width: 240, height: 171, duration: 7500, sound: 'party', art: ['awards_hall', 'awards_hosts'], actors: [winner],
    paint(c, t, s) {
      c.drawImage(s.art('awards_hall'), 0, 0);
      if (t > 500) { c.save(); c.globalAlpha = 0.16; c.fillStyle = '#fff4c8'; c.beginPath(); c.ellipse(150, 118, 40, 12, 0, 0, Math.PI * 2); c.fill(); c.restore(); }
      c.drawImage(s.art('awards_hosts'), 190, 101);
      s.sprite(c, winner, 140, 92, t > 1300 && Math.floor(t / 420) % 2 ? 'cheer' : 'standFront');
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
    width: 200, height: 123, duration: 6500, sound: 'blocked', art: ['crunch_room', 'crunch_faces'], actors: [actor],
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

/** The seminar room (event7): one of the staff at a screen, and the bar filling up. */
export function trainingSeminar(actor: Actor, heading: string, caption: string, detail?: string): Scene {
  const duration = 7000;
  return {
    id: `training:${actor.name}:${heading}`, stamp: 'TRAINING', heading, caption, detail,
    width: 201, height: 127, duration, sound: 'levelup', art: ['training_room', 'training_bar'], actors: [actor],
    paint(c, t, s) {
      c.drawImage(s.art('training_room'), 0, 0);
      s.sprite(c, actor, 34, 58, 'standAway');
      c.drawImage(s.art('training_bar'), 18, 110);
      const done = Math.min(1, t / (duration - 900));
      c.fillStyle = s.pixel('training_bar', 10, 8);
      c.fillRect(20, 112, Math.round(161 * done), 13);
      s.label(c, `${Math.round(done * 100)}%`, 100, 113, { size: 9, color: done > 0.55 ? '#ffffff' : '#2a3a9a', align: 'center' });
      s.label(c, 'SEMINAR', 100, 6, { size: 11, color: '#4a5a6a', align: 'center' });
    },
  };
}

/** GAMEDEX (event4): the shipping crews on the show floor under the studio's screen. */
export function conventionDay(actors: Actor[], projects: string[]): Scene {
  const crew = actors.slice(0, 6);
  return {
    id: `expo:${new Date().toDateString()}`, stamp: 'GAMEDEX', heading: `${projects.length} projects shipped today`,
    caption: projects.slice(0, 4).join(' · '), detail: crew.map(a => a.name).join(', '),
    width: 240, height: 227, duration: 8000, sound: 'party', art: ['expo_hall', 'expo_sign', 'expo_crowd'], actors: crew,
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
