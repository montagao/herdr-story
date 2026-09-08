// Small pixel shapes share the office's integer grid, palette, and nearest-neighbour rendering.
// The same drawings appear on the floor and in the NPC windows.
export const JANITOR_LOOK = { body: 8, face: 12 };
export type CatPose = 'stand' | 'walk' | 'sleep' | 'happy';
export function paintCat(c: CanvasRenderingContext2D, pose: CatPose = 'stand', step = 0, away = false) {
  const r = (color: string, x: number, y: number, w: number, h: number) => { c.fillStyle = color; c.fillRect(x, y, w, h); };
  const edge = '#694c3e', fur = '#cf9453', light = '#efd092', cream = '#fff0ca';
  r('#37484b44', 3, 19, 19, 2);
  if (pose === 'sleep') {
    r(edge, 4, 13, 17, 5); r(edge, 6, 18, 13, 1); r(edge, 7, 11, 11, 2);
    r(fur, 5, 13, 15, 5); r(light, 8, 12, 9, 3);
    r(edge, 4, 10, 1, 3); r(edge, 4, 11, 2, 3); r(edge, 10, 10, 1, 3); r(edge, 9, 11, 2, 3); r(fur, 5, 12, 6, 5);
    r(cream, 5, 16, 5, 2); r(edge, 5, 14, 2, 1); r(edge, 9, 14, 2, 1);
    r(edge, 14, 15, 7, 3); r(light, 13, 15, 7, 2); r(light, 11, 17, 4, 1);
    return;
  }
  const bob = pose === 'walk' ? step % 2 : 0;
  c.save(); c.translate(0, -bob);
  // Raised tail, low body and a slightly turned head: a cat, at half an employee's height.
  r(edge, 2, 7 + step % 2, 2, 8); r(fur, 3, 9, 2, 7);
  r(edge, 4, 12, 14, 6); r(edge, 6, 10, 10, 2);
  r(fur, 5, 12, 12, 5); r(light, 7, 11, 9, 3);
  r(edge, 12, 7, 1, 3); r(edge, 12, 8, 2, 3); r(edge, 20, 7, 1, 3); r(edge, 19, 8, 2, 3);
  r(edge, 12, 9, 10, 7); r(fur, 13, 9, 8, 6);
  r(light, 14, 9, 5, 3); r('#ce9980', 13, 9, 1, 1); r('#ce9980', 19, 9, 1, 1);
  r('#aa713f', 7, 11, 2, 3); r('#aa713f', 11, 11, 2, 3);
  if (!away) {
    r(cream, 15, 13, 6, 3); r(edge, 14, 11, 1, pose === 'happy' ? 1 : 2);
    r(edge, 19, 11, 1, pose === 'happy' ? 1 : 2); r('#ae7470', 18, 14, 2, 1);
  } else r('#aa713f', 16, 9, 2, 4);
  r('#568e86', 13, 16, 6, 1); r('#f3d878', 18, 16, 1, 2);
  const stride = pose === 'walk' ? (step % 2 ? 1 : -1) : 0;
  r(edge, 5 + stride, 17, 3, 3); r(edge, 14 - stride, 17, 3, 3);
  r(cream, 5 + stride, 19, 3, 1); r(cream, 14 - stride, 19, 3, 1);
  c.restore();
}
