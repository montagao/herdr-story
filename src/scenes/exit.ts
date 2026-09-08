import type Phaser from 'phaser';
import type { Spot } from './wander';
import type { Theme } from '../themes';

type Vec2 = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
// Kept in step with OfficeScene's iso(): a 32x16 tile.
const iso = (c: number, r: number): Vec2 => ({ x: (c - r) * 16, y: (c + r) * 8 });
const V = (p: Vec2[]) => p as unknown as Phaser.Math.Vector2[];
const standAt = (c: number, r: number): Spot => ({ x: (c - r) * 16 - 8, y: (c + r + 1) * 8 - 20 });

/** The lobby runs two tiles into the room and three along the edge; the landing juts three tiles
 *  out. Three, not two: the tower's brick drops 16px per tile of depth, and with the 2px lip the
 *  landing's roof lands exactly one 50px storey below the office floor, so the facade continues
 *  under it without a seam. */
const LOBBY_IN = 2, LOBBY_ALONG = 3, LANDING_OUT = 3, LIP = 2;

export interface Entrance {
  /** Just inside the edge, on the lobby tiles; new agents walk in from here. */
  entrance: Spot;
  /** Out on the landing; leavers walk to it and fade before the far parapet. */
  outside: Spot;
  /** Floor and landing together, so props and furniture stay off the doorway. */
  keepOut: Rect;
  /** The stretch of the room's own parapet that the doorway replaces. */
  gap: [Vec2, Vec2];
}

/** Which tower face to paint under an edge, and whether its brick must continue the room's own
 *  right face rather than start a fresh storey on its roof line. */
export type FacePainter = (a: Vec2, b: Vec2, side: 'l' | 'r', continueRight?: boolean) => void;

/** The entrance the game's offices have: no door at all, but a notch in the roof edge. A strip of
 *  lobby tiles leads across the floor to a gap in the parapet, and beyond it a lower landing on
 *  the building's roof carries its own parapet. Visitors walk in across it and leavers walk out.
 *  `row` is the tile row along the entrance edge (column W) where the notch starts. */
export function drawEntrance(g: Phaser.GameObjects.Graphics, th: Theme, W: number, row: number, face: FacePainter): Entrance {
  const lip = (p: Vec2): Vec2 => ({ x: p.x, y: p.y + LIP });
  const A = iso(W, row), B = iso(W, row + LOBBY_ALONG);                   // the gap in the room's edge
  const L0 = iso(W - LOBBY_IN, row), L1 = iso(W - LOBBY_IN, row + LOBBY_ALONG);
  const A2 = lip(A), B2 = lip(B), T1 = lip(iso(W + LANDING_OUT, row)), T2 = lip(iso(W + LANDING_OUT, row + LOBBY_ALONG));

  // The building under the landing: its lit face continues the room's, its shaded end starts a
  // storey on its own roof line, and the two meet on a storey boundary at the corner.
  face(T2, T1, 'r', true);
  face(B2, T2, 'l');

  // Lobby tiles, a half-tile checker of two greys like the game's own lobby floor.
  g.fillStyle(0xb2b6b0).fillPoints(V([L0, A, B, L1]), true);
  g.fillStyle(0xc3c7c1);
  for (let i = 0; i < LOBBY_IN * 2; i++) for (let j = 0; j < LOBBY_ALONG * 2; j++) {
    if ((i + j) % 2) continue;
    const c = iso(W - LOBBY_IN + (i + 0.5) / 2, row + (j + 0.5) / 2);
    g.fillPoints(V([{ x: c.x - 8, y: c.y }, { x: c.x, y: c.y - 4 }, { x: c.x + 8, y: c.y }, { x: c.x, y: c.y + 4 }]), true);
  }
  g.lineStyle(1, 0x8d928c, 0.8).strokePoints(V([A, L0, L1, B]), false);   // the threshold's inner edge

  // The lip where the office floor ends and the landing's roof begins, then the roof itself:
  // dark gravel with the grid the game's roofs carry.
  g.fillStyle(th.wallLight).fillPoints(V([A, B, B2, A2]), true);
  g.fillStyle(0x6b6858).fillPoints(V([A2, T1, T2, B2]), true);
  g.lineStyle(1, 0x7a7663, 1);
  for (let k = 1; k < LANDING_OUT * 2; k++) g.strokePoints(V([lip(iso(W + k / 2, row)), lip(iso(W + k / 2, row + LOBBY_ALONG))]), false);
  for (let k = 1; k < LOBBY_ALONG * 2; k++) g.strokePoints(V([lip(iso(W, row + k / 2)), lip(iso(W + LANDING_OUT, row + k / 2))]), false);

  // The landing's parapet, the same cap as the room's, with a post at each outer corner.
  g.lineStyle(3, th.wallTrim).strokePoints(V([A2, T1, T2, B2]), false);
  for (const p of [T1, T2]) {
    g.fillStyle(0x00000033).fillRect(p.x - 3, p.y - 1, 7, 4);
    g.fillStyle(th.wallTrim).fillRect(p.x - 3, p.y - 5, 7, 5);
  }

  const mid = row + LOBBY_ALONG / 2;
  const entrance = standAt(W - 1, mid), outside = standAt(W + LANDING_OUT - 0.5, mid);
  return { entrance, outside, gap: [A, B], keepOut: { x: L1.x - 4, y: L0.y - 4, w: T1.x - L1.x + 8, h: T2.y - L0.y + 12 } };
}

/** Share the same doorway artwork with the Re-org cutscene. */
export function paintExit(shape: (colour: number, points: number[][]) => unknown) {
  // A shallow lift shaft; the open face looks back into the office.
  shape(0x536876, [[-24, 12], [-24, -40], [24, -64], [44, -54], [44, -2], [-4, 22]]);
  shape(0xd9e3e5, [[-24, -40], [24, -64], [44, -54], [-4, -30]]);
  shape(0x91a7b4, [[24, -64], [44, -54], [44, -2], [24, -12]]);
  shape(0x273d4b, [[-20, 10], [-20, -36], [20, -56], [20, -10]]);
  shape(0x3d5665, [[-16, 8], [-16, -32], [16, -48], [16, -8]]);
  shape(0xc2d0ce, [[-24, 12], [-4, 22], [36, 2], [16, -8]]);
  shape(0xe6ebe3, [[-24, 12], [-24, -40], [-20, -38], [-20, 14]]);
  shape(0xb1c3cc, [[20, -10], [20, -58], [24, -60], [24, -12]]);
  // Lit exit plaque with a pixel arrow, readable without a floating label.
  shape(0x367658, [[-10, -36], [-10, -44], [10, -54], [10, -46]]);
  shape(0xe9f5d5, [[-6, -40], [2, -44], [2, -47], [7, -46], [2, -40], [2, -43], [-6, -39]]);
}
