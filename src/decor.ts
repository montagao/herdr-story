// Office props, where to load them from, and where to put them.
//
// The room sheets the game ships (assets/raw/.../office/floor*.png) each carry a strip of loose
// furniture below the room itself: plants, benches, whiteboards, shelves, vending machines.
// scripts/extract-decor.js cuts those out into public/assets/gds/decor with a manifest.
// Independently licensed packs live under public/assets/open and provide their own manifest.
//
// Placement is seeded so a given office always looks the same: same seed, same room.
import type Phaser from 'phaser';

export interface Prop {
  id: string;
  w: number;
  h: number;
  /** Optional independently licensed asset URL. Older extracted props use the default base. */
  src?: string;
  /** Override the size heuristic when a small object belongs against a wall. */
  zone?: 'wall' | 'aisle';
}

// Display names stay separate from texture IDs so existing room layouts keep working.
const PROP_NAMES: Readonly<Record<string, string>> = {
  floor0_550_23: 'White coffee table',
  floor1_551_24: 'Cream coffee table',
  floor11_550_20: 'Coffee and snacks table',
  floor12_550_23: 'Glass coffee table',
  floor13_550_24: 'Wooden coffee table',
  floor14_550_21: 'Robot display table',
  floor16_550_23: 'Gift display table',
  floor17_551_24: 'Tea table',
  floor18_208_40: 'Notice board',
  floor18_244_45: 'Potted tree',
  floor2_208_0: 'Wooden coffee table',
  floor3_287_0: 'Pair of potted plants',
  floor35_550_16: 'Treasure display table',
  floor5_550_23: 'Rustic coffee table',
  'zephilie-office-stool': 'Blue office stool',
  'zephilie-wastebasket': 'Wastebasket',
  'zephilie-retro-terminal': 'Free agent terminal',
  'zephilie-foliage-plant': 'Tall potted tree',
  'zephilie-desk-plant': 'Bamboo plant',
  'zephilie-wide-plant': 'Trailing plant',
  'zephilie-leafy-plant': 'Spider plant',
};

/** Shared by room tooltips and the furniture catalog; never expose extraction filenames. */
export function propName(id?: string): string {
  return id && Object.hasOwn(PROP_NAMES, id) ? PROP_NAMES[id] : 'Decoration';
}

/** mulberry32: small, fast, and stable across runs — the same seed gives the same office. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string into a seed, so an office can be keyed off something stable. */
export function seedFrom(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface Rect { x: number; y: number; w: number; h: number }

export function loadProps(load: Phaser.Loader.LoaderPlugin, props: Prop[], base = '/assets/gds/decor') {
  for (const p of props) load.image(`decor:${p.id}`, p.src ?? `${base}/${p.id}.png`);
}

/** Fix vector props to the same native pixel grid as the sprites before the camera scales them.
 * Canvas otherwise redraws SVG diagonals smoothly at each zoom, even with pixelArt enabled. */
export function preparePropTextures(textures: Phaser.Textures.TextureManager, props: Prop[]) {
  for (const p of props) {
    const key = `decor:${p.id}`;
    if (!p.src?.endsWith('.svg') || !textures.exists(key)) continue;
    const canvas = document.createElement('canvas'); canvas.width = p.w; canvas.height = p.h;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    context.drawImage(textures.get(key).getSourceImage() as HTMLImageElement, 0, 0, p.w, p.h);
    textures.remove(key); textures.addCanvas(key, canvas);
  }
}

/** What a prop is, for the room planner: a table belongs in the lounge, a plant at the end of a
 *  desk bank or along a wall, a machine against a wall. The extracted ids say nothing, so the
 *  sheet is classified by hand here; anything new falls back on its size. */
export type PropKind = 'table' | 'bench' | 'plant' | 'sign' | 'machine' | 'small';
const PROP_KINDS: Record<string, PropKind> = {
  floor0_550_23: 'table', floor1_551_24: 'table', floor11_550_20: 'table', floor12_550_23: 'table', floor13_550_24: 'table',
  floor14_550_21: 'table', floor16_550_23: 'table', floor17_551_24: 'table', floor35_550_16: 'table', floor5_550_23: 'table',
  floor2_208_0: 'bench', floor18_208_40: 'sign', floor18_244_45: 'plant', floor3_287_0: 'plant',
  'zephilie-foliage-plant': 'plant', 'zephilie-desk-plant': 'plant', 'zephilie-wide-plant': 'plant', 'zephilie-leafy-plant': 'plant',
  'zephilie-retro-terminal': 'machine', 'zephilie-office-stool': 'small', 'zephilie-wastebasket': 'small',
};
export function propKind(p: Prop): PropKind {
  return PROP_KINDS[p.id] ?? (p.w >= 45 ? 'table' : p.h > p.w ? 'plant' : 'small');
}
