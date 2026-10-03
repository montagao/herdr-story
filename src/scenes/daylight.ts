import Phaser from 'phaser';
import { daylight, hourOf, skyAt, type Light } from './daylight-curve';
import { reducedMotion } from '../motion';
import type { Workstation } from './OfficeScene';

/** Above every desk, tag and bubble; the glows sit one step higher still. */
const DEPTH = 1_000_000;
const REACH = 40_000;
const MINUTE = 60_000;

/**
 * Time of day over the office: one multiply-blended sheet the size of the world takes the room
 * through dawn, dusk and night, and after dark every occupied monitor throws a little light onto
 * its desk — warm while someone works there, red when they are stuck. The sheet dims the '!' over
 * a stuck desk along with everything else, so that red glow is the sign that carries at night: it
 * throbs. The sky behind the room is shaded to match. Local time by default; a recording or a
 * demo can pin the hour.
 */
export class Daylight {
  private overlay?: Phaser.GameObjects.Rectangle;
  private glows = new Map<Workstation, Phaser.GameObjects.Image>();
  private fixed?: number;
  private timer?: Phaser.Time.TimerEvent;
  private stations: Workstation[] = [];
  /** How much of the night's glow is on, as of the last apply(). */
  private night = 0;
  private beat = -1;

  constructor(private scene: Phaser.Scene, private sky: () => number, private redraw: () => void) {
    // Phaser probes the canvas for the newer composite modes at boot and, where the probe fails
    // (headless builds among them), quietly maps MULTIPLY back to source-over, which would paint
    // the room over instead of shading it. Every browser this office runs in supports multiply.
    const renderer = scene.game.renderer as { type: number; blendModes?: string[] };
    if (renderer.type === Phaser.CANVAS && renderer.blendModes) { renderer.blendModes[Phaser.BlendModes.MULTIPLY] = 'multiply'; renderer.blendModes[Phaser.BlendModes.ADD] = 'lighter'; }
    this.glowTexture('glow-warm', [255, 214, 140]);
    this.glowTexture('glow-red', [255, 110, 90]);
    this.timer = scene.time.addEvent({ delay: MINUTE, loop: true, callback: () => this.apply() });
    scene.events.on('update', this.tick, this);
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
    // glow() gives each its colour, here and on every beat after
    for (const st of keep) if (!this.glows.has(st)) this.glows.set(st, this.scene.add.image(st.pc.x + 25, st.pc.y + 18, 'glow-warm').setDepth(DEPTH + 1).setBlendMode(Phaser.BlendModes.ADD));
    this.apply();
  }

  private apply() {
    const light = this.light, { tint } = light;
    this.night = light.night;
    if (this.overlay) { this.overlay.setFillStyle(tint); this.overlay.setVisible(tint !== 0xffffff); }
    // The sky sits behind the sheet, so it is shaded too; drawing it toward dusk first keeps it a sunset rather than a green.
    this.scene.cameras.main?.setBackgroundColor(skyAt(this.sky(), light));
    this.glow();
    this.redraw();
  }

  /** After dark the glows keep the desks' own time, eight beats a second on the scene clock. */
  private tick(time: number) {
    const beat = Math.floor(time / 125);
    if (beat === this.beat || this.night <= 0.02) return;
    this.beat = beat;
    this.glow();
  }

  /** Each glow as its desk stands on this beat. A lit screen dips with its own picture, one beat
   *  in five; a desk waiting on the owner throbs, a second up and a second down; and a status
   *  that changed between seatings shows at once instead of at the next agent list. Only alpha
   *  and texture, on frames the office draws anyway: asking for a redraw from here would hold the
   *  whole room at full rate all night. */
  private glow() {
    const beat = reducedMotion() ? -1 : this.beat;
    for (const [st, glow] of this.glows) {
      const stuck = st.status === 'blocked', busy = stuck || st.status === 'working';
      const key = stuck ? 'glow-red' : 'glow-warm';
      if (glow.texture.key !== key) glow.setTexture(key);
      const pulse = beat < 0 || !busy ? 1 : stuck ? ((beat >> 3) % 2 ? 1 : 0.68) : (beat >> 2) % 5 ? 1 : 0.9;
      glow.setAlpha(this.night * (busy ? 0.8 : 0.45) * (st.screenVisible ? 1 : 0.7) * pulse).setVisible(this.night > 0.02);
    }
  }

  destroy() {
    this.scene.events.off('update', this.tick, this);
    this.timer?.remove(); this.timer = undefined;
    this.overlay?.destroy(); this.overlay = undefined;
    for (const glow of this.glows.values()) glow.destroy();
    this.glows.clear();
  }
}
