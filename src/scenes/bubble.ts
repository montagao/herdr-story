import Phaser from 'phaser';
import { popIn } from './fx';

/** The speech balloon the office uses everywhere: a white rounded box with a grey rim and a small
 *  tail, popping in from 60%. `tipY` is where the tail's point lands; the box hangs above it, and
 *  the balloon's size is the box's, so whatever stacks on top of it knows where it ends. */
export function speechBubble(scene: Phaser.Scene, x: number, tipY: number, text: string, depth: number) {
  const t = scene.add.text(0, 0, text, { fontFamily: 'DotGothic16', fontSize: '10px', color: '#1a2430', align: 'center', wordWrap: { width: 96 } }).setOrigin(0.5, 0.5).setResolution(2);
  const w = Math.ceil(t.width) + 10, h = Math.ceil(t.height) + 6;
  const g = scene.add.graphics();
  g.fillStyle(0x7f8c99).fillRoundedRect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2, 4);
  g.fillStyle(0xffffff).fillRoundedRect(-w / 2, -h / 2, w, h, 3);
  g.fillStyle(0xffffff).fillTriangle(-3, h / 2 - 1, 4, h / 2 - 1, 0, h / 2 + 4);
  const bubble = scene.add.container(x, tipY - 4 - h / 2, [g, t]).setSize(w + 2, h + 2).setDepth(depth);
  popIn(scene, bubble);
  return bubble;
}

/** Aim a balloon's tail at a new spot: whoever is speaking has moved. */
export function pointBubble(bubble: Phaser.GameObjects.Container, x: number, tipY: number) {
  return bubble.setPosition(x, tipY - 3 - bubble.height / 2);
}
