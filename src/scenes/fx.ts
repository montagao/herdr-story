// How things on the floor move.
//
// The windows have their tokens in motion.css; these are the same ideas for the canvas. Whatever
// appears lands with one small overshoot, whatever jumps comes down the way it went up, and
// whatever floats off stays readable until the moment it goes. Everything here runs on scene
// tweens and timers, never setTimeout or CSS, so a sleeping office and the replay clock hold it
// still, and all of it stands down under reduced motion.
import type Phaser from 'phaser';
import { reducedMotion } from '../motion';

/** Landing, the --pop-ms of the floor: a bubble, a badge, a coin. */
export const POP_MS = 120;
/** Answering the pointer, like --quick-ms. */
export const QUICK_MS = 90;
/** Leaving: opaque until now, then gone. */
const FADE_MS = 220;

type Placed = Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Transform;
type Fading = Placed & { alpha: number };

/** Land something: it starts at `from` of its size and overshoots a little on the way to full. */
export function popIn(scene: Phaser.Scene, target: Placed, from = 0.6) {
  if (reducedMotion()) return;
  target.setScale(from);
  scene.tweens.add({ targets: target, scale: 1, duration: POP_MS, ease: 'Back.out' });
}

/** Let something small go. It stays fully readable for `hold`, then lifts `rise` px and is gone
 *  in a moment: a fade that starts on the first frame spends most of its life too faint to read. */
export function floatOff(scene: Phaser.Scene, target: Fading, hold: number, rise = 6, done?: () => void) {
  const finish = () => { done?.(); target.destroy(); };
  if (reducedMotion()) { scene.time.delayedCall(hold + FADE_MS, finish); return; }
  scene.tweens.add({ targets: target, y: `-=${rise}`, alpha: 0, delay: hold, duration: FADE_MS, ease: 'Quad.in', onComplete: finish });
}

/** Hop: up `lift` px and back down the same curve, so it reads as a jump rather than a slide.
 *  A small hop is a quick one, as if they all shared one gravity. */
export function hop(scene: Phaser.Scene, target: Placed, lift = 6, times = 1) {
  if (reducedMotion()) return;
  scene.tweens.add({ targets: target, y: target.y - lift, duration: Math.round(180 * Math.sqrt(lift / 6)), yoyo: true, repeat: times - 1, ease: 'Quad.out' });
}

/** Cut a named frame from one of the game's sheets the first time it is wanted. */
export function cut(scene: Phaser.Scene, key: string, name: string, x: number, y: number, w: number, h: number) {
  const texture = scene.textures.get(key);
  if (!texture.has(name)) texture.add(name, 0, x, y, w, h);
  return name;
}

/** A few of the game's own five-pixel stars around a spot: each grows, shrinks and is gone. */
export function sparkles(scene: Phaser.Scene, x: number, y: number, depth: number, count = 6, spread = 16) {
  if (reducedMotion()) return;
  const frame = cut(scene, 'main01', 'sparkle', 4, 0, 5, 5);
  for (let i = 0; i < count; i++) {
    const turn = (i / count) * Math.PI * 2 + 0.4;
    const star = scene.add.image(Math.round(x + Math.cos(turn) * spread), Math.round(y + Math.sin(turn) * spread * 0.5), 'main01', frame).setDepth(depth).setScale(0);
    scene.tweens.add({ targets: star, scale: 1, y: star.y - 3, duration: 180, delay: i * 60, yoyo: true, ease: 'Quad.out', onComplete: () => star.destroy() });
  }
}

/** Corner brackets around whatever the pointer is on, drawn about the graphics' own origin so
 *  they can be scaled from the middle. Tint does nothing on the canvas renderer, so this is the
 *  floor's highlight; each arm is rimmed in dark, like the name tags, to read on carpet and flame. */
export function drawBrackets(g: Phaser.GameObjects.Graphics, w: number, h: number, colour = 0xf2cf60, arm = 6) {
  g.clear();
  for (const [fill, rim] of [[0x222a35, 1], [colour, 0]]) {
    g.fillStyle(fill);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x = sx * w / 2, y = sy * h / 2;
      g.fillRect(Math.min(x, x - sx * arm) - rim, (sy < 0 ? y : y - 1) - rim, arm + rim * 2, 1 + rim * 2);
      g.fillRect((sx < 0 ? x : x - 1) - rim, Math.min(y, y - sy * arm) - rim, 1 + rim * 2, arm + rim * 2);
    }
  }
  return g;
}
