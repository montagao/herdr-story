import { closeOnEscape } from './escape';
import type Phaser from 'phaser';
import type { AgentInfo } from '../shared/types';
import { employeeName } from '../shared/studio';
import { BODY_POSE, FACE, FACE_W, FACE_H, bodyKey, faceKey, lookFor } from './sprites';
import type { Theme } from './themes';
import { paintExit } from './scenes/exit';
import { departurePose } from './departure-motion';
import { JANITOR_LOOK } from './scenes/regulars-art';
import { JANITOR_ANCHOR_X, paintJanitor } from './scenes/janitor-art';
import './departure-cutscene.css';

const W = 256, H = 160;
const colour = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
type Actor = { agent: AgentInfo; body: CanvasImageSource; face: CanvasImageSource; checkedOut: boolean };

/** A self-contained sprite scene: the office stays frozen behind its game window. */
export class DepartureCutscene {
  private root = document.createElement('div');
  private stopEscape?: () => void;
  private canvas = document.createElement('canvas');
  private backdrop = document.createElement('canvas');
  private actors: Actor[] = [];
  private elapsed = 0;
  private previous = 0;
  private frame = 0;
  private raf = 0;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private complete = false;
  private resolve?: () => void;
  private onExit = (_id: string) => {};
  constructor(private textures: Phaser.Textures.TextureManager, private theme: Theme) {}

  play(agents: AgentInfo[], onExit: (paneId: string) => void): Promise<void> {
    this.onExit = onExit;
    this.actors = agents.map(agent => {
      const look = agent.office_look ?? lookFor(agent.pane_id);
      return { agent, body: this.source(bodyKey(look.body), 'body0'), face: this.source(faceKey(look.face), 'face0'), checkedOut: false };
    });
    this.root.id = 'reorg-cutscene';
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Re-org departure cutscene'); this.root.setAttribute('data-block-office-input', '');
    this.root.innerHTML = `<section class="departure-window"><header><span>Re-org</span><b data-heading>Clocking out</b><button type="button" data-close aria-label="Skip cutscene and view results">×</button></header>
      <div class="departure-stage"></div><div class="departure-caption" role="status"><b data-caption>Findings filed. Time to head out.</b><span data-detail></span></div>
      <div class="departure-roll" aria-label="Selected agents"></div><footer><span data-count></span><button type="button" data-play ${this.reduced ? '' : 'hidden'}>Play animation</button><button type="button" data-continue>Skip animation</button></footer></section>`;
    this.canvas.width = this.backdrop.width = W; this.canvas.height = this.backdrop.height = H;
    this.canvas.setAttribute('role', 'img'); this.canvas.setAttribute('aria-label', 'Gus the janitor guides selected agents past reception and out the door');
    this.canvas.dataset.janitor = 'gus';
    this.root.querySelector('.departure-stage')!.append(this.canvas);
    for (const actor of this.actors) {
      const chip = document.createElement('span'); chip.dataset.pane = actor.agent.pane_id;
      chip.textContent = employeeName(actor.agent); this.root.querySelector('.departure-roll')!.append(chip);
    }
    this.paintBackdrop(); document.body.append(this.root);
    this.stopEscape = closeOnEscape(this.root, () => this.close());
    this.root.querySelector('[data-close]')!.addEventListener('click', () => this.close());
    this.root.querySelector('[data-continue]')!.addEventListener('click', () => this.close());
    this.root.querySelector('[data-play]')!.addEventListener('click', () => {
      this.root.querySelector<HTMLButtonElement>('[data-continue]')!.focus({ preventScroll: true });
      this.reduced = false; this.root.querySelector<HTMLButtonElement>('[data-play]')!.hidden = true;
      this.root.querySelector('[data-continue]')!.textContent = 'Skip animation'; this.raf = requestAnimationFrame(this.tick);
    });
    this.root.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button')].filter(b => !b.hidden);
      const first = buttons[0], last = buttons.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    this.root.querySelector<HTMLButtonElement>('[data-continue]')!.focus({ preventScroll: true });
    this.draw();
    if (this.reduced) {
      this.root.querySelector('[data-caption]')!.textContent = 'Recaps saved. The team is ready to leave.';
      this.root.querySelector('[data-continue]')!.textContent = 'View results';
    } else this.raf = requestAnimationFrame(this.tick);
    return new Promise(resolve => { this.resolve = resolve; });
  }

  private source(key: string, fallback = key): CanvasImageSource {
    return this.textures.get(this.textures.exists(key) ? key : fallback).getSourceImage() as CanvasImageSource;
  }
  private paintBackdrop() {
    const c = this.backdrop.getContext('2d')!; c.imageSmoothingEnabled = false;
    c.fillStyle = colour(this.theme.wallLight); c.fillRect(0, 0, W, H);
    c.fillStyle = colour(this.theme.wallDark); c.fillRect(0, 18, W, 54);
    c.fillStyle = colour(this.theme.wallTrim); c.fillRect(0, 69, W, 4);
    const carpet = c.createPattern(this.source(this.theme.carpet, 'carpet'), 'repeat');
    c.fillStyle = carpet ?? '#98764c'; c.fillRect(0, 73, W, H - 73);
    // Window, blinds, and an office sign above the familiar reception sprite.
    c.fillStyle = colour(this.theme.wallTrim); c.fillRect(13, 23, 63, 41);
    c.fillStyle = colour(this.theme.wallWindow); c.fillRect(16, 26, 57, 34);
    c.fillStyle = '#dbe9dc'; c.fillRect(16, 40, 57, 2); c.fillRect(43, 26, 3, 34);
    c.fillStyle = '#677f86'; c.fillRect(85, 23, 59, 12);
    c.fillStyle = '#fcffec'; c.font = '7px DotGothic16'; c.fillText('RECEPTION', 91, 32);
    const desk = this.source('reception') as HTMLImageElement;
    c.drawImage(desk, 71, 39, 76, 58);
    // A small planter, kept out of the path.
    c.fillStyle = '#d8cbb0'; c.fillRect(17, 120, 12, 12); c.fillStyle = '#8b7558'; c.fillRect(19, 132, 8, 3);
    c.fillStyle = '#35653b'; c.fillRect(18, 108, 11, 11); c.fillRect(13, 111, 8, 5); c.fillRect(23, 105, 4, 17);
    c.fillStyle = '#67a051'; c.fillRect(18, 108, 4, 6); c.fillRect(25, 108, 6, 4);
    paintExit((tint, points) => {
      c.fillStyle = colour(tint); c.beginPath();
      points.forEach(([x, y], i) => i ? c.lineTo(199 + x, 86 + y) : c.moveTo(199 + x, 86 + y)); c.closePath(); c.fill();
    });
  }
  private tick = (now: number) => {
    if (!document.hidden) this.elapsed += this.previous ? Math.min(64, now - this.previous) : 0;
    this.previous = now; this.draw();
    if (!this.complete) this.raf = requestAnimationFrame(this.tick);
  };
  private draw() {
    const c = this.canvas.getContext('2d')!; c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, W, H); c.drawImage(this.backdrop, 0, 0);
    const poses = this.actors.map((actor, i) => ({ actor, janitor: false, pose: this.reduced
      ? { ...departurePose(0, 0), x: 44 + i % 6 * 25, y: 134 - i % 6 * 7, frame: 'standFront', visible: i < 6 }
      : departurePose(this.elapsed, i) }));
    for (const { actor, pose } of poses) if (pose.finished) this.checkOut(actor);
    // Gus walks alongside the procession to the door, then sweeps while the team files out.
    // He is a guide, so he never counts as a selected/closed agent.
    const progress = this.reduced ? 1 : Math.min(1, this.elapsed / 2300);
    const guide = { actor: { body: this.source(bodyKey(JANITOR_LOOK.body), 'body0'), face: this.source(faceKey(JANITOR_LOOK.face), 'face0') }, janitor: true,
      pose: { x: 125 + progress * 46, y: 150 - progress * 23, frame: progress < 1 ? ['standAway', 'walkAway1', 'standAway', 'walkAway2'][Math.floor(this.elapsed / 190) % 4] : 'standFront', alpha: 1, visible: true, waving: false } };
    for (const { actor, pose, janitor } of [...poses.filter(p => p.pose.visible), guide].sort((a, b) => a.pose.y - b.pose.y)) {
      const p = BODY_POSE[pose.frame], x = Math.round(pose.x - 8), y = Math.round(pose.y - 30);
      c.globalAlpha = pose.alpha;
      if (janitor) {
        const mode = this.reduced ? 'stand' : progress < 1 ? 'walk' : 'sweep';
        c.save(); c.translate(x - JANITOR_ANCHOR_X, y);
        paintJanitor(c, actor.body, actor.face, mode, progress < 1 ? 'ne' : 'se', Math.floor(this.elapsed / (mode === 'walk' ? 190 : 220)) % (mode === 'walk' ? 4 : 8));
        c.restore();
        c.fillStyle = '#284a5d'; c.fillRect(x - 4, y - 11, 25, 9);
        c.fillStyle = '#fcffec'; c.font = '7px DotGothic16'; c.fillText('GUS', x + 1, y - 4);
      } else {
        c.fillStyle = '#30251f55'; c.fillRect(x + 1, y + 29, 16, 3);
        c.drawImage(actor.body, p.x, p.y, p.w, p.h, x + p.dx, y + p.dy, p.w, p.h);
        const [col, row] = FACE[p.face];
        c.drawImage(actor.face, col * FACE_W, row * FACE_H, FACE_W, FACE_H, x + p.fx, y + p.fy, FACE_W, FACE_H);
      }
      if (pose.waving) {
        c.fillStyle = '#fcffec'; c.fillRect(x - 5, y - 12, 30, 10); c.fillRect(x + 8, y - 2, 3, 3);
        c.fillStyle = '#294d57'; c.font = '7px DotGothic16'; c.fillText('bye!', x, y - 4);
      }
    }
    c.globalAlpha = 1;
    const done = this.actors.filter(a => a.checkedOut).length;
    this.root.querySelector('[data-count]')!.textContent = `${done} / ${this.actors.length} checked out`;
    this.canvas.dataset.frame = String(++this.frame); this.canvas.dataset.departed = String(done);
    const current = poses.find(p => p.pose.waving) ?? poses.find(p => p.pose.visible && !p.actor.checkedOut && p.pose.x > 0);
    if (current && !this.reduced) {
      this.root.querySelector('[data-caption]')!.textContent = `${employeeName(current.actor.agent)} ${current.pose.waving ? 'says goodbye.' : 'is heading out.'}`;
      this.root.querySelector('[data-detail]')!.textContent = current.actor.agent.workspace_name || current.actor.agent.cwd?.split('/').at(-1) || '';
    }
    if (done === this.actors.length) {
      this.complete = true; this.root.dataset.complete = 'true';
      this.root.querySelector('[data-heading]')!.textContent = 'Re-org complete';
      this.root.querySelector('[data-caption]')!.textContent = 'Everyone’s out. Their work stays with you.';
      this.root.querySelector('[data-detail]')!.textContent = 'Prompts, findings, and artifacts saved to the Journal.';
      this.root.querySelector('[data-continue]')!.textContent = 'View results';
      this.root.querySelector('[data-close]')!.setAttribute('aria-label', 'View Re-org results');
    }
  }
  private checkOut(actor: Actor) {
    if (actor.checkedOut) return;
    actor.checkedOut = true; this.onExit(actor.agent.pane_id);
    const chip = [...this.root.querySelectorAll<HTMLElement>('[data-pane]')].find(el => el.dataset.pane === actor.agent.pane_id)!;
    chip.dataset.done = 'true'; chip.textContent = `✓ ${employeeName(actor.agent)}`;
  }
  private close() {
    this.stopEscape?.();
    cancelAnimationFrame(this.raf);
    for (const actor of this.actors) this.checkOut(actor);
    this.root.remove(); this.resolve?.(); this.resolve = undefined;
  }
}
