import { BODY_POSE, FACE, FACE_W, FACE_H } from '../sprites';

export type JanitorDirection = 'se' | 'sw' | 'ne' | 'nw';
export type JanitorMode = 'stand' | 'walk' | 'sweep';
export const JANITOR_WIDTH = 48, JANITOR_HEIGHT = 36, JANITOR_ANCHOR_X = 12;
export const janitorKey = (mode: JanitorMode, direction: JanitorDirection, step: number) => `office-janitor:${mode}:${direction}:${step}`;

/** One complete pose: the hand is placed on the shaft, then the sleeve joins it to the shoulder.
 * Mirroring the entire drawing keeps that grip intact in all four isometric directions. */
export function paintJanitor(c: CanvasRenderingContext2D, body: CanvasImageSource, face: CanvasImageSource,
  mode: JanitorMode, direction: JanitorDirection, step: number) {
  const away = direction === 'ne' || direction === 'nw', flip = direction === 'sw' || direction === 'nw';
  const frames = away ? ['standAway', 'walkAway1', 'standAway', 'walkAway2'] : ['standFront', 'walkFront1', 'standFront', 'walkFront2'];
  const p = BODY_POSE[frames[mode === 'walk' ? step % 4 : 0]];
  const r = (color: string, x: number, y: number, w: number, h: number) => { c.fillStyle = color; c.fillRect(x, y, w, h); };
  // Integer strokes retain the same pixel size as the original body and face sheets.
  const line = (color: string, x0: number, y0: number, x1: number, y1: number, width = 1) => {
    const count = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= count; i++) r(color, Math.round(x0 + (x1 - x0) * i / (count || 1)), Math.round(y0 + (y1 - y0) * i / (count || 1)), width, width);
  };
  c.save(); c.imageSmoothingEnabled = false;
  c.translate(JANITOR_ANCHOR_X + (flip ? 16 : 0), 0); c.scale(flip ? -1 : 1, 1);
  r('#263c4040', 2, 30, 14, 2);
  // The stock walk swings both arms. Replace only the carrying arm so the old hand doesn't
  // peek out below the new grip. Keep the torso, free arm, legs, and face from the game sheet.
  c.save(); c.beginPath(); c.rect(-4, 0, 17, 36); c.rect(13, 0, 24, 15); c.rect(13, 25, 24, 11); c.clip();
  c.drawImage(body, p.x, p.y, p.w, p.h, p.dx, p.dy, p.w, p.h); c.restore();
  r('#243e4a', 12, 16, 1, 8); r('#268aa0', 11, 16, 1, 7);
  const [col, row] = FACE[p.face];
  c.drawImage(face, col * FACE_W, row * FACE_H, FACE_W, FACE_H, p.fx, p.fy, FACE_W, FACE_H);

  const sweep = mode === 'sweep';
  const stroke = [18, 19, 21, 23, 24, 23, 21, 19][step % 8];
  const footX = sweep ? stroke : 19, footY = (sweep ? 29 + Math.floor((stroke - 18) / 2) : mode === 'walk' ? 27 : 29);
  const bob = mode === 'walk' && step % 2 ? 1 : 0;
  const top = { x: 15, y: 10 + bob }, neck = { x: footX, y: footY - 3 };
  const gripY = 19 + bob, gripX = Math.round(top.x + (neck.x - top.x) * (gripY - top.y) / (neck.y - top.y));
  // A tilted wooden shaft and a small bristle head on the floor's 2:1 diagonal.
  line('#584b39', top.x, top.y, neck.x, neck.y, 2);
  line('#c5a16b', top.x, top.y, neck.x, neck.y);
  for (let u = 0; u < 8; u++) {
    const x = footX - 3 + u, y = footY - 4 + Math.floor((u - 3) / 2);
    r('#62523b', x, y, 1, 5);
    r(u % 3 === 0 ? '#b99a59' : '#d7bb78', x, y + 2, 1, u % 2 ? 3 : 2);
    r('#7e9994', x, y, 1, 1);
  }
  // Bent elbow and closed hand follow the computed shaft position on every frame.
  line('#243e4a', 11, 17, 13, 20, 3); line('#243e4a', 13, 20, gripX - 1, gripY, 3);
  line('#3193ab', 12, 17, 14, 20, 1); line('#3193ab', 14, 20, gripX - 1, gripY, 2);
  r('#805b43', gripX - 1, gripY - 1, 4, 3); r('#f2c995', gripX - 1, gripY - 1, 3, 2);
  c.restore();
}
