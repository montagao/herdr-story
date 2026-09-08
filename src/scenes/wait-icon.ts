import type Phaser from 'phaser';

const KEY = 'office-wait-hourglass';
const CELL = 19;
// A transparent 11 × 13 sprite: single-pixel contour, shaded brass caps and pale glass.
// Keep it on the same pixel grid as the office art, including while it turns over.
const PIXELS = [
  '.#########.',
  '#HHHHHHHHH#',
  '.#BBBBBBB#.',
  '..#LGGGG#..',
  '...#LGG#...',
  '....#G#....',
  '.....#.....',
  '....#G#....',
  '...#LGG#...',
  '..#LGGGG#..',
  '.#BBBBBBB#.',
  '#HHHHHHHHH#',
  '.#########.',
];
const COLORS: Record<string, string> = {
  '#': '#3b302d', H: '#eed5a0', B: '#ad8050',
  L: '#f6f0d5', G: '#9bb8b5', S: '#e5b64e', s: '#b98136',
};

/** Bake nearest-pixel rotation frames once; no emoji fallback or blurry live transforms. */
export function waitIconTexture(scene: Phaser.Scene) {
  if (scene.textures.exists(KEY)) return KEY;
  const canvas = document.createElement('canvas');
  canvas.width = CELL * 8; canvas.height = CELL;
  const ctx = canvas.getContext('2d')!;
  for (let frame = 0; frame < 8; frame++) {
    const drain = Math.min(frame, 3);
    const angle = frame < 4 ? 0 : (frame - 3) * Math.PI / 4;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const dx = x - 9, dy = y - 9;
      const sx = Math.round(dx * cos + dy * sin) + 5;
      const sy = Math.round(-dx * sin + dy * cos) + 6;
      let pixel = PIXELS[sy]?.[sx];
      if (!pixel || pixel === '.') continue;
      if (pixel === 'G') {
        if (sy < 6 && sy >= 3 + drain) pixel = sx < 6 ? 'S' : 's';
        if (sy > 6 && sy >= 10 - drain) pixel = sx < 6 ? 'S' : 's';
        if (sx === 5 && sy === 7 && drain % 2 === 0) pixel = 'S';
      }
      ctx.fillStyle = COLORS[pixel];
      ctx.fillRect(frame * CELL + x, y, 1, 1);
    }
  }
  const texture = scene.textures.addCanvas(KEY, canvas)!;
  for (let frame = 0; frame < 8; frame++) texture.add(frame, 0, frame * CELL, 0, CELL, CELL);
  return KEY;
}
