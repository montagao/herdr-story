import Phaser from 'phaser';
import { bodyKey, faceKey } from '../sprites';
import { walkerDepth } from './depth';
import { type Spot, type Wander } from './wander';
import { fromOfficeCanvas } from './Furnishings';
import { JANITOR_LOOK, paintCat, type CatPose } from './regulars-art';
import { JANITOR_ANCHOR_X, JANITOR_WIDTH, JANITOR_HEIGHT, janitorKey, paintJanitor, type JanitorDirection, type JanitorMode } from './janitor-art';

type Regular = { kind: 'cat' | 'janitor'; node: Phaser.GameObjects.Container; image: Phaser.GameObjects.Image;
  hint: Phaser.GameObjects.Text;
  path: Spot[]; until: number; phase: 'rest' | 'walk'; flip: boolean; away: boolean; hovered: boolean };
interface Options {
  canInteract(): boolean; onCat?(): void; onJanitor?(): void;
  desks(): Spot[];
}
function texture(scene: Phaser.Scene, key: string, draw: (c: CanvasRenderingContext2D) => void, width = 36, height = 34) {
  if (scene.textures.exists(key)) return;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  draw(canvas.getContext('2d')!); scene.textures.addCanvas(key, canvas);
}

/** Two permanent residents share the staff's obstacle grid; neither is a live agent. */
export class OfficeRegulars {
  readonly actors: Regular[] = [];
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private petUntil = 0;
  constructor(private scene: Phaser.Scene, private floor: Wander, private options: Options) {
    for (const pose of ['stand', 'walk', 'sleep', 'happy'] as CatPose[]) for (let step = 0; step < 2; step++) for (const away of [false, true]) {
      texture(scene, `office-cat:${pose}:${step}:${away}`, c => paintCat(c, pose, step, away));
    }
    const body = scene.textures.get(bodyKey(JANITOR_LOOK.body)).getSourceImage() as CanvasImageSource;
    const face = scene.textures.get(faceKey(JANITOR_LOOK.face)).getSourceImage() as CanvasImageSource;
    for (const direction of ['se', 'sw', 'ne', 'nw'] as JanitorDirection[]) for (const mode of ['stand', 'walk', 'sweep'] as JanitorMode[]) {
      for (let step = 0; step < (mode === 'sweep' ? 8 : mode === 'walk' ? 4 : 1); step++)
        texture(scene, janitorKey(mode, direction, step), c => paintJanitor(c, body, face, mode, direction, step), JANITOR_WIDTH, JANITOR_HEIGHT);
    }
  }
  rebuild(at: Spot) {
    const old = this.actors.map(a => ({ kind: a.kind, x: a.node.x, y: a.node.y }));
    this.clear();
    for (const kind of ['cat', 'janitor'] as const) {
      const desired = old.find(a => a.kind === kind) ?? (kind === 'cat' ? this.options.desks()[0] ?? at : at);
      const route = this.floor.pathTo(desired, desired) ?? this.floor.pathTo(at, at);
      const spot = route?.[0]; if (!spot) continue;
      const node = this.scene.add.container(spot.x, spot.y).setDepth(walkerDepth(spot.y));
      const image = this.scene.add.image(kind === 'cat' ? -4 : -JANITOR_ANCHOR_X, 0, kind === 'cat' ? 'office-cat:stand:0:false' : janitorKey('stand', 'se', 0)).setOrigin(0);
      node.add(image);
      const action = kind === 'cat' ? this.options.onCat : this.options.onJanitor;
      const hint = this.scene.add.text(0, 0, kind === 'cat' ? 'Miso · Office cat\nPet & discover a memory' : `Gus · Janitor\n${action ? 'Review idle desks · Re-org' : 'Keeping the office tidy'}`, {
        fontFamily: 'DotGothic16', fontSize: '8px', color: '#29475d', backgroundColor: '#f4f8fa', align: 'center',
      }).setOrigin(.5, 1).setPadding(4, 3).setResolution(2).setDepth(100_000).setVisible(false);
      const a: Regular = { kind, node, image, hint, path: [], until: this.scene.time.now + (kind === 'cat' ? 6500 : 2500), phase: 'rest', flip: false, away: false, hovered: false };
      node.setInteractive(new Phaser.Geom.Rectangle(kind === 'cat' ? -5 : -12, kind === 'cat' ? 5 : 0, kind === 'cat' ? 35 : 44, kind === 'cat' ? 20 : 36), Phaser.Geom.Rectangle.Contains);
      node.input!.cursor = action ? 'pointer' : 'default';
      node.on('pointerover', () => { if (this.options.canInteract()) { a.hovered = true; hint.setVisible(true); } });
      node.on('pointerout', () => { a.hovered = false; hint.setVisible(false); });
      node.on('pointerup', (p: Phaser.Input.Pointer) => {
        if (!this.options.canInteract() || !fromOfficeCanvas(this.scene, p) || Math.hypot(p.x - p.downX, p.y - p.downY) > 5) return;
        this.hideHints(); action?.();
      });
      this.actors.push(a); this.draw(a, this.scene.time.now);
    }
  }
  hideHints() { for (const a of this.actors) { a.hovered = false; a.hint.setVisible(false); } }
  pet() { this.petUntil = this.scene.time.now + 5500; }
  update(now: number, delta: number) {
    for (const a of this.actors) {
      if (!this.reduced.matches && !a.hovered) {
        if (!a.path.length && now > a.until) this.nextWalk(a, now);
        let distance = Math.min(delta, 100) * (a.kind === 'cat' ? 23 : 18) / 1000;
        while (distance > 0 && a.path.length) {
          const to = a.path[0], dx = to.x - a.node.x, dy = to.y - a.node.y, d = Math.hypot(dx, dy);
          const move = Math.min(d, distance);
          if (d > 0) { a.node.setPosition(a.node.x + dx / d * move, a.node.y + dy / d * move); a.flip = dx < 0; a.away = dy < 0; }
          distance -= move;
          if (d > move) break;
          a.path.shift();
          if (!a.path.length) { a.phase = 'rest'; a.until = now + (a.kind === 'cat' ? 12_000 : 5000) + Math.random() * 6000; }
        }
      }
      this.draw(a, now);
    }
  }
  private nextWalk(a: Regular, now: number) {
    a.until = now + 5000;
    const destinations = a.kind === 'cat' ? [...this.options.desks(), ...this.floor.spots] : [...this.floor.spots, ...this.options.desks()];
    // Prefer nearby aisles so residents are visible regularly, even in a large office.
    const candidates = destinations.filter(p => Math.hypot(p.x - a.node.x, p.y - a.node.y) > 16)
      .sort((p, q) => Math.hypot(p.x - a.node.x, p.y - a.node.y) - Math.hypot(q.x - a.node.x, q.y - a.node.y)).slice(0, 8);
    while (candidates.length) {
      const to = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0];
      const path = this.floor.pathTo(a.node, to);
      if (path && path.some(p => Math.hypot(p.x - a.node.x, p.y - a.node.y) > 8)) { a.path = path; a.phase = 'walk'; break; }
    }
  }
  private draw(a: Regular, now: number) {
    const still = this.reduced.matches, step = still ? 0 : Math.floor(now / (a.kind === 'cat' ? 180 : 190)) % 4;
    a.node.setDepth(walkerDepth(a.node.y)); a.hint.setPosition(a.node.x + 8, a.node.y - 5);
    if (a.kind === 'cat') {
      const pose: CatPose = now < this.petUntil ? 'happy' : a.phase === 'walk' && !still ? 'walk' : 'sleep';
      a.image.setTexture(`office-cat:${pose}:${step % 2}:${a.away}`).setFlipX(a.flip);
      // Keep the little body centred when the padded texture flips.
      a.image.setX(a.flip ? -16 : -4);
    } else {
      const direction: JanitorDirection = a.away ? a.flip ? 'nw' : 'ne' : a.flip ? 'sw' : 'se';
      const mode: JanitorMode = still || a.hovered ? 'stand' : a.phase === 'walk' ? 'walk' : 'sweep';
      const frame = mode === 'sweep' ? Math.floor(now / 220) % 8 : mode === 'walk' ? step : 0;
      a.image.setTexture(janitorKey(mode, direction, frame));
    }
  }
  private clear() { for (const a of this.actors) { a.hint.destroy(); a.node.destroy(); } this.actors.length = 0; }
  destroy() { this.clear(); }
}
