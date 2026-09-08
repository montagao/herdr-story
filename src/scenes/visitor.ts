import Phaser from 'phaser';
import { BODY_POSE, BODY_COUNT, FACE_COUNT, bodyKey, faceKey, ensureAppearance } from '../sprites';
import { walkerDepth } from './depth';
import { WALK, headingFor, type Spot } from './wander';
import { speechBubble } from './bubble';

export type VisitorKind = 'fan' | 'mascot';
const SPEED = 34;          // px per second: visitors are in less of a hurry than staff
const STEP_MS = 190;

/** Someone who is not staff: a fan trying the product, or the mascot with good news. They come in
 *  over the landing, stop at reception to say their piece, and leave the way they came. A fan is a
 *  random body and face from the game's sheets; the mascot is Kairo-kun himself, one frame,
 *  bobbing as he walks because his sheet has no walk cycle. */
export class Visitor {
  readonly node: Phaser.GameObjects.Container;
  private body?: Phaser.GameObjects.Image; private face?: Phaser.GameObjects.Image;
  private frame = 0; private nextStep = 0;
  private mover?: Phaser.Time.TimerEvent;
  private bubble?: Phaser.GameObjects.Container;
  private constructor(private scene: Phaser.Scene, readonly kind: VisitorKind, at: Spot, look?: { body: number; face: number }) {
    this.node = scene.add.container(at.x, at.y).setDepth(walkerDepth(at.y));
    if (kind === 'mascot') this.node.add(scene.add.image(-2, -2, 'kairokun').setOrigin(0, 0));
    else {
      this.body = scene.add.image(0, 0, bodyKey(look!.body), 'standFront').setOrigin(0, 0);
      this.face = scene.add.image(0, 0, faceKey(look!.face), 'frontR').setOrigin(0, 0);
      this.node.add([this.body, this.face]); this.pose('standFront');
    }
  }
  static async create(scene: Phaser.Scene, kind: VisitorKind, at: Spot) {
    const look = { body: Math.floor(Math.random() * BODY_COUNT), face: Math.floor(Math.random() * FACE_COUNT) };
    if (kind === 'fan') await ensureAppearance(scene.textures, look);
    return new Visitor(scene, kind, at, look);
  }
  private pose(frame: string) {
    if (!this.body || !this.face) return;
    const p = BODY_POSE[frame] ?? BODY_POSE.standFront;
    this.body.setFrame(frame).setPosition(p.dx, p.dy);
    this.face.setFrame(p.face).setPosition(p.fx, p.fy);
  }
  place(x: number, y: number) { this.node.setPosition(x, y).setDepth(walkerDepth(y)); this.bubble?.setPosition(x + 6, y - 35 - 4 - 10); }
  say(text: string, ms = 2600) {
    this.bubble?.destroy();
    this.bubble = speechBubble(this.scene, this.node.x + 6, this.node.y - 35, text, walkerDepth(this.node.y) + 4000);
    this.scene.time.delayedCall(ms, () => { this.bubble?.destroy(); this.bubble = undefined; });
  }
  /** Walk the path point by point; the last leg fades them out when `fade` is set. */
  walk(path: Spot[], fade: boolean, done: () => void) {
    const route = [...path];
    let last = this.scene.time.now;
    this.mover?.remove();
    this.mover = this.scene.time.addEvent({ delay: 33, loop: true, callback: () => {
      const now = this.scene.time.now, dt = Math.min(100, now - last); last = now;
      let distance = SPEED * dt / 1000;
      while (distance > 0) {
        const target = route[0];
        if (!target) { this.mover?.remove(); this.mover = undefined; this.pose('standFront'); done(); return; }
        const dx = target.x - this.node.x, dy = target.y - this.node.y;
        const d = Math.hypot(dx, dy), move = Math.min(d, distance);
        if (d > 0) this.place(this.node.x + dx / d * move, this.node.y + dy / d * move);
        if (fade && route.length === 1) this.node.setAlpha(Math.min(1, Math.hypot(target.x - this.node.x, target.y - this.node.y) / 12));
        distance -= move;
        if (d > 0 && now > this.nextStep) {
          this.nextStep = now + STEP_MS;
          const frames = headingFor(dx, dy);
          this.pose(frames[this.frame++ % frames.length]);
          if (this.kind === 'mascot') this.node.first && (this.node.first as Phaser.GameObjects.Image).setY(this.frame % 2 ? -3 : -2);
        }
        if (move < d) break;
        route.shift();
      }
    } });
  }
  destroy() { this.mover?.remove(); this.bubble?.destroy(); this.node.destroy(); }
}
