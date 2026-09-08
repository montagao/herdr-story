import Phaser from 'phaser';
import { daylight, hourOf, skyAt, type Light } from './daylight-curve';
import type { Workstation } from './OfficeScene';

/** Above every desk, tag and bubble; the glows sit one step higher still. */
const DEPTH = 1_000_000;
const REACH = 40_000;
const MINUTE = 60_000;

/**
 * Time of day over the office: one multiply-blended sheet the size of the world takes the room
 * through dawn, dusk and night, and after dark every occupied monitor throws a little light onto
 * its desk — warm while someone works there, red when they are stuck. The sky behind the room is
 * shaded to match. Local time by default; a recording or a demo can pin the hour.
 */
export class Daylight {
  private overlay?: Phaser.GameObjects.Rectangle;
  private glows = new Map<Workstation, Phaser.GameObjects.Image>();
  private fixed?: number;
  private timer?: Phaser.Time.TimerEvent;
  private stations: Workstation[] = [];

  constructor(private scene: Phaser.Scene, private sky: () => number, private redraw: () => void) {
    // Phaser probes the canvas for the newer composite modes at boot and, where the probe fails
    // (headless builds among them), quietly maps MULTIPLY back to source-over, which would paint
    // the room over instead of shading it. Every browser this office runs in supports multiply.
    const renderer = scene.game.renderer as { type: number; blendModes?: string[] };
    if (renderer.type === Phaser.CANVAS && renderer.blendModes) { renderer.blendModes[Phaser.BlendModes.MULTIPLY] = 'multiply'; renderer.blendModes[Phaser.BlendModes.ADD] = 'lighter'; }
    this.glowTexture('glow-warm', [255, 214, 140]);
    this.glowTexture('glow-red', [255, 110, 90]);
    this.timer = scene.time.addEvent({ delay: MINUTE, loop: true, callback: () => this.apply() });
    scene.events.once('shutdown', () => this.destroy());
  }
  /** A pool of light in the art's own pixels: concentric bands rasterised a row at a time, no
   *  anti-aliasing, drawn at world scale and filtered nearest, so it reads as pixel art rather
   *  than as a photographic blur laid over it. Bands are painted outside-in, so each alpha is
   *  the band's own. */
  private glowTexture(key: string, [r, g, b]: number[]) {
    if (this.scene.textures.exists(key)) return;
    const w = 60, h = 34, cx = w / 2, cy = h / 2;
    const texture = this.scene.textures.createCanvas(key, w, h)!;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, w, h);
    const bands: [rx: number, ry: number, alpha: number][] = [[30, 17, 0.14], [24, 13, 0.26], [17, 9, 0.4], [10, 5, 0.55]];
    for (const [rx, ry, alpha] of bands) {
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      for (let y = -ry; y <= ry; y++) {
        const half = Math.round(rx * Math.sqrt(1 - (y / ry) ** 2));
        if (half > 0) ctx.fillRect(cx - half, cy + y, half * 2, 1);
      }
    }
    texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    texture.refresh();
  }

  get hour() { return this.fixed ?? hourOf(new Date()); }
  get light(): Light { return daylight(this.hour); }
  /** Pin the clock (a recording, `?hour=`), or hand it back to local time. */
  setHour(hour?: number) { this.fixed = hour; this.apply(); }

  /** The room was rebuilt: lay the sheet again. */
  layout() {
    this.overlay?.destroy();
    this.overlay = this.scene.add.rectangle(-REACH / 2, -REACH / 2, REACH, REACH, 0xffffff).setOrigin(0, 0).setDepth(DEPTH).setBlendMode(Phaser.BlendModes.MULTIPLY);
    for (const glow of this.glows.values()) glow.destroy();
    this.glows.clear();
    this.apply();
  }

  /** Seating changed: a monitor lights when someone sits at it and goes dark when they leave. */
  dress(stations: Workstation[]) {
    this.stations = stations;
    const keep = new Set(stations.filter(st => st.agent));
    for (const [st, glow] of this.glows) if (!keep.has(st)) { glow.destroy(); this.glows.delete(st); }
    for (const st of keep) {
      const key = st.status === 'blocked' ? 'glow-red' : 'glow-warm';
      let glow = this.glows.get(st);
      if (!glow) { glow = this.scene.add.image(st.pc.x + 25, st.pc.y + 18, key).setDepth(DEPTH + 1).setBlendMode(Phaser.BlendModes.ADD); this.glows.set(st, glow); }
      else if (glow.texture.key !== key) glow.setTexture(key);
    }
    this.apply();
  }

  private apply() {
    const light = this.light, { tint, night } = light;
    if (this.overlay) { this.overlay.setFillStyle(tint); this.overlay.setVisible(tint !== 0xffffff); }
    // The sky sits behind the sheet, so it is shaded too; drawing it toward dusk first keeps it a sunset rather than a green.
    this.scene.cameras.main?.setBackgroundColor(skyAt(this.sky(), light));
    for (const [st, glow] of this.glows) {
      const busy = st.status === 'working' || st.status === 'blocked';
      glow.setAlpha(night * (busy ? 0.8 : 0.45) * (st.screenVisible ? 1 : 0.7)).setVisible(night > 0.02);
    }
    this.redraw();
  }

  destroy() {
    this.timer?.remove(); this.timer = undefined;
    this.overlay?.destroy(); this.overlay = undefined;
    for (const glow of this.glows.values()) glow.destroy();
    this.glows.clear();
  }
}
