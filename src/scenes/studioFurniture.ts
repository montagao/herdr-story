import type Phaser from 'phaser';
import { goalProgress, type Milestone } from '../../shared/studio';

type Point = [number, number];
export interface PixelPen { fillStyle(color: number): PixelPen; fillRect(x: number, y: number, w: number, h: number): PixelPen }
/** Scan-convert the faces into whole pixel rows, keeping the same 2:1 steps as the room art. */
function face(g: PixelPen, color: number, points: Point[]) {
  g.fillStyle(color);
  const ys = points.map(p => p[1]);
  for (let y = Math.min(...ys); y < Math.max(...ys); y++) {
    const cuts: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], scan = y + .5;
      if ((a[1] <= scan && b[1] > scan) || (b[1] <= scan && a[1] > scan))
        cuts.push(a[0] + (scan - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    cuts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i += 2) {
      const x = Math.ceil(cuts[i]);
      g.fillRect(x, y, Math.ceil(cuts[i + 1]) - x, 1);
    }
  }
}
function line(g: PixelPen, color: number, a: Point, b: Point) {
  g.fillStyle(color);
  let [x, y] = a;
  const dx = Math.abs(b[0] - x), dy = -Math.abs(b[1] - y);
  const sx = x < b[0] ? 1 : -1, sy = y < b[1] ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    g.fillRect(x, y, 1, 1);
    if (x === b[0] && y === b[1]) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}
const ink = 0x493b2e;

/** Upholstered backrest on the desk's 2:1 plane, facing the seated front-left pose. */
export function drawExecutiveChair(g: PixelPen) {
  face(g, 0x302e27, [[-18,-64],[-15,-66],[8,-55],[8,-32],[5,-30],[-18,-41]]);
  face(g, 0x3d493b, [[5,-53],[8,-55],[8,-32],[5,-30]]);
  face(g, 0x65745a, [[-16,-62],[4,-52],[4,-33],[-16,-43]]);
  face(g, 0x53634b, [[-14,-59],[2,-51],[2,-36],[-14,-44]]);
  line(g, 0x899374, [-15,-63],[5,-53]);
  line(g, 0x3e4b38, [-14,-48],[2,-40]);
}

/** A brass plaque on the front panel: upright letter stems, with a 2:1 sloping baseline. */
function drawBossPlate(g: PixelPen) {
  const at = (u: number, v: number): Point => [-28 + u, -18 + Math.floor(u / 2) + v];
  // Draw whole pixel columns so the bevel and lettering share the wood's exact plane.
  for (let u = 0; u < 31; u++) {
    const [x, y] = at(u, 0);
    g.fillStyle(0x735332).fillRect(x, y, 1, 10);
    if (u > 0 && u < 30) {
      g.fillStyle(0xe0be72).fillRect(x, y + 1, 1, 8);
      g.fillStyle(0xffe5a1).fillRect(x, y + 1, 1, 1);
    }
  }
  const B = ['11110', '10001', '10001', '11110', '10001', '10001', '11110'];
  const O = ['01110', '10001', '10001', '10001', '10001', '10001', '01110'];
  const S = ['01111', '10000', '10000', '01110', '00001', '00001', '11110'];
  g.fillStyle(0x493b2e);
  [B, O, S, S].forEach((glyph, letter) => glyph.forEach((row, v) => {
    for (let u = 0; u < row.length; u++) if (row[u] === '1') {
      const [x, y] = at(4 + letter * 6 + u, 2 + v);
      g.fillRect(x, y, 1, 1);
    }
  }));
}

/** Broad walnut executive desk, green blotter, brass nameplate and a quiet cup of coffee. */
export function drawExecutiveDesk(g: PixelPen) {
  face(g, ink, [[-33,-22],[-7,-35],[33,-15],[33,-2],[7,11],[-33,-9]]);
  face(g, 0x68482f, [[7,-2],[32,-14],[32,-3],[7,9]]);
  face(g, 0x97643e, [[-32,-21],[7,-2],[7,9],[-32,-10]]);
  face(g, 0xc1935c, [[-32,-23],[-7,-35],[32,-16],[7,-3]]);
  line(g, 0xe5be7c, [-31,-23],[7,-4]);
  face(g, 0x294d42, [[-18,-23],[-6,-29],[14,-19],[2,-13]]);
  line(g, 0x537b5e, [-17,-23],[2,-14]);
  drawBossPlate(g);
  face(g, 0xe8daba, [[3,-27],[8,-29],[20,-23],[15,-20]]);
  line(g, 0xa49d8b, [7,-26],[16,-22]);
  g.fillStyle(ink).fillRect(20,-20,6,5);
  g.fillStyle(0xf0e7cd).fillRect(20,-21,5,4).fillRect(25,-20,2,2);
  g.fillStyle(0x5c3d2d).fillRect(21,-21,3,1);
}

/** A wheeled, wood-framed board on the same 2:1 plane as the office furniture.
 * Tiny marker strokes show real checklist state; readable titles live in the hover and editor. */
export function drawWhiteboard(g: Phaser.GameObjects.Graphics, color: number, goal?: Milestone) {
  // Rear braces, uprights, and short feet. Dark edges and single-pixel highlights match the desks.
  face(g, ink, [[-19,-33],[-15,-31],[-15,-13],[-19,-15]]);
  face(g, 0x967147, [[-18,-32],[-16,-31],[-16,-14],[-18,-15]]);
  face(g, ink, [[15,-16],[19,-14],[19,-1],[15,-3]]);
  face(g, 0x967147, [[16,-15],[18,-14],[18,-2],[16,-3]]);
  for (const [x,y] of [[-17,-14],[17,-2]]) {
    face(g, ink, [[x-5,y],[x+1,y-3],[x+5,y-1],[x-1,y+2]]);
    line(g, 0xb4aa8b, [x-4,y],[x+1,y-2]);
    g.fillStyle(ink).fillRect(x-3,y+1,2,2).fillRect(x+3,y-1,2,2);
  }
  // The slim end face and bevel give the board thickness without a floating panel silhouette.
  face(g, ink, [[-21,-52],[-17,-54],[21,-35],[21,-10],[17,-8],[-21,-27]]);
  face(g, 0x795536, [[17,-33],[20,-35],[20,-11],[17,-9]]);
  face(g, 0xd3ae72, [[-20,-52],[-17,-53],[20,-35],[17,-33]]);
  face(g, 0xac8050, [[-20,-51],[17,-33],[17,-10],[-20,-28]]);
  line(g, 0xe6c993, [-20,-51],[16,-33]);
  face(g, 0x796949, [[-18,-49],[15,-33],[15,-13],[-18,-29]]);
  face(g, 0xeee8ce, [[-17,-48],[14,-33],[14,-15],[-17,-30]]);
  line(g, 0xfff5dc, [-16,-47],[13,-33]);

  // Board-local coordinates keep every magnet, mark and progress segment on the sloping face.
  const at = (u: number, v: number): Point => [-15 + u, -46 + Math.floor(u / 2) + v];
  const stroke = (shade: number, u: number, v: number, length: number) => line(g, shade, at(u,v), at(u+length,v));
  stroke(color, 1, 1, 24);
  stroke(color, 1, 2, 24);
  const rows = goal ? Math.min(3, Math.max(1, goal.checklist.length)) : 0;
  for (let i=0; i<rows; i++) {
    const v = 5 + i*4, done = goal!.checklist[i]?.done ?? false;
    face(g, 0xa6a48a, [at(1,v),at(4,v),at(4,v+3),at(1,v+3)]);
    face(g, done ? color : 0xfff5dc, [at(2,v+1),at(4,v+1),at(4,v+3),at(2,v+3)]);
    stroke(done ? 0x8b977e : 0x6a725e, 7, v+1, [16,12,14][i]);
  }
  if (goal) {
    stroke(0xc8c8ac, 1, 17, 24);
    const filled = Math.round(24 * goalProgress(goal) / 100);
    if (filled) stroke(color, 1, 17, filled);
  }
  // Shallow marker tray, with a capped pen and felt eraser.
  face(g, ink, [[-21,-28],[-18,-30],[18,-12],[15,-10]]);
  line(g, 0xd1b07c, [-20,-28],[15,-11]);
  line(g, color, [-12,-25],[-7,-23]);
  line(g, 0x555e50, [5,-17],[10,-15]);
}

/** Warm enamel, recessed drawers, brass label holders and a small stack of manila folders. */
export function drawCabinet(g: Phaser.GameObjects.Graphics) {
  face(g, ink, [[-14,-38],[-5,-43],[14,-33],[14,-6],[5,-1],[-14,-11]]);
  face(g, 0x707468, [[5,-28],[13,-32],[13,-7],[5,-3]]);
  face(g, 0xb2b09a, [[-13,-37],[5,-28],[5,-3],[-13,-12]]);
  face(g, 0xe4ddc1, [[-13,-38],[-5,-42],[13,-33],[5,-29]]);
  line(g, 0xf5ecd1, [-12,-38],[5,-30]);
  line(g, 0x959785, [11,-30],[11,-8]);
  for (const offset of [0,8,16]) {
    const y=-35+offset;
    face(g, 0x656556, [[-11,y],[3,y+7],[3,y+13],[-11,y+6]]);
    face(g, 0xc9c7ad, [[-10,y+1],[2,y+7],[2,y+11],[-10,y+5]]);
    line(g, 0xeee5c9, [-10,y+1],[1,y+6]);
    line(g, 0x8a7046, [-6,y+4],[-2,y+6]);
    line(g, 0xf0d59a, [-6,y+3],[-3,y+4]);
  }
  g.fillStyle(ink).fillRect(-11,-11,2,3).fillRect(4,-3,2,3).fillRect(11,-7,2,3);
  face(g, 0x9d8056, [[-8,-41],[-3,-44],[6,-39],[6,-37],[1,-34],[-8,-39]]);
  face(g, 0xe1c591, [[-8,-42],[-3,-45],[6,-40],[1,-37]]);
  line(g, 0xf4deb3, [-6,-41],[1,-38]);
}

/** Walnut display case; contents sit on the same isometric plane as the neighbouring desks. */
export function drawTrophyShelf(g: Phaser.GameObjects.Graphics, count: number) {
  face(g, ink, [[-22,-35],[-12,-40],[22,-23],[22,-6],[11,0],[-22,-17]]);
  face(g, 0x765035, [[11,-18],[21,-23],[21,-7],[11,-2]]);
  face(g, 0xa87848, [[-21,-33],[11,-17],[11,-2],[-21,-18]]);
  face(g, 0xc9975b, [[-21,-35],[-12,-39],[21,-23],[11,-18]]);
  line(g, 0xe3b677, [-20,-35],[11,-20]);
  line(g, 0x664329, [-20,-32],[10,-17]);
  // Two dark recesses, with a central upright and a raised lower shelf.
  face(g, 0x4e3d2d, [[-18,-29],[-5,-23],[-5,-15],[-18,-21]]);
  face(g, 0x4e3d2d, [[-2,-21],[8,-16],[8,-8],[-2,-13]]);
  line(g, 0xd3a36b, [-19,-20],[9,-6]);
  line(g, 0x8b623e, [14,-16],[19,-19]);
  line(g, 0x8b623e, [14,-10],[19,-13]);
  g.fillStyle(ink).fillRect(-19,-18,3,3).fillRect(8,-3,3,3).fillRect(18,-8,3,3);
  // Bound journals keep an empty case furnished without inventing earned awards.
  for (let i=0;i<3;i++) {
    const x=-17+i*3, y=-28+i;
    face(g, [0x75816a,0xa16f47,0xa79972][i], [[x,y],[x+2,y+1],[x+2,y+7],[x,y+6]]);
    g.fillStyle(0xddc38c).fillRect(x,y+2,2,1);
  }
  // A small brass plate replaces the illegible sentence; details remain in the hover label.
  face(g, 0xe0be72, [[0,-17],[5,-15],[5,-12],[0,-14]]);
  if (!count) {
    face(g, 0x77583e, [[-8,-34],[-3,-37],[4,-33],[-1,-30]]);
    face(g, 0xb49b6b, [[-8,-35],[-3,-38],[4,-34],[-1,-31]]);
  }
}
