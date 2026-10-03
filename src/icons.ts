// Icons drawn on a 16x16 pixel lattice.
//
// The feed is the one part of this that is not made of game sprites, and an emoji glyph next to
// the DotGothic type looked like it had wandered in from another app. These are plain axis-aligned
// rectangles on whole pixels with shape-rendering="crispEdges", so at 16px they land exactly on
// the grid the rest of the office is drawn on.

type Rect = [x: number, y: number, w: number, h: number];

/** Body and cone, symmetric about y=8: a 4x5 box that steps out to a 13-tall mouth. */
const SPEAKER: Rect[] = [[1, 6, 4, 5], [5, 4, 1, 9], [6, 3, 1, 11], [7, 2, 1, 13]];
/** Two arcs. Each needs a clear column either side or they read as one solid blob at 16px. */
const WAVES: Rect[] = [[10, 5, 1, 7], [11, 7, 1, 3], [13, 3, 1, 11], [14, 6, 1, 5]];
/** A cross of 2x2 blocks through (11,8), over the span the waves occupied. */
const CROSS: Rect[] = [
  [9, 6, 2, 2], [10, 7, 2, 2], [11, 8, 2, 2], [12, 9, 2, 2],
  [9, 9, 2, 2], [10, 8, 2, 2], [11, 7, 2, 2], [12, 6, 2, 2],
];

const draw = (rs: Rect[]) => rs.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('');

/** Four tiles in a grid — a gallery of rooms to pick from. */
const GALLERY: Rect[] = [[2, 2, 5, 5], [9, 2, 5, 5], [2, 9, 5, 5], [9, 9, 5, 5]];

export function galleryIcon() {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">`
    + draw(GALLERY) + '</svg>';
}

export function soundIcon(on: boolean) {
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">`
    + draw(SPEAKER) + draw(on ? WAVES : CROSS) + '</svg>';
}

/** A diagonal arrow pointing up and to the right. The pixel font has no diagonals, so the furniture
 *  nudge pad draws its own; the other three corners are this one mirrored. */
const NORTH_EAST: Rect[] = [[6, 2, 8, 2], [12, 2, 2, 8], [10, 4, 2, 2], [8, 6, 2, 2], [6, 8, 2, 2], [4, 10, 2, 2], [2, 12, 2, 2]];
const mirror = (rs: Rect[], x: boolean, y: boolean): Rect[] => rs.map(([rx, ry, w, h]) => [x ? 16 - rx - w : rx, y ? 16 - ry - h : ry, w, h]);

/** Studio furniture, on the same lattice: a whiteboard on legs, a person, a filing cabinet, a
 *  trophy cup, a sofa, and the four corner brackets of a "fit to view" frame. Arranging has its own
 *  sign rather than the room's sofa: on a phone the dock shows icons alone, and two sofas in one
 *  row said nothing about which was which. */
const STUDIO: Record<string, Rect[]> = {
  sweep: [[10, 1, 2, 3], [9, 4, 2, 2], [8, 6, 2, 2], [5, 8, 6, 2], [4, 10, 8, 2], [3, 12, 3, 3], [7, 12, 2, 3], [10, 12, 3, 3]],
  boards: [[1, 2, 14, 1], [1, 11, 14, 1], [1, 2, 1, 10], [14, 2, 1, 10], [4, 5, 8, 1], [4, 8, 5, 1], [7, 12, 2, 3], [5, 14, 6, 1]],
  people: [[6, 1, 4, 4], [5, 5, 6, 1], [3, 7, 10, 2], [2, 9, 12, 5]],
  journal: [[3, 1, 10, 1], [3, 1, 1, 14], [12, 1, 1, 14], [3, 14, 10, 1], [3, 5, 10, 1], [3, 10, 10, 1], [7, 3, 2, 1], [7, 7, 2, 1], [7, 12, 2, 1]],
  trophies: [[4, 1, 8, 6], [2, 2, 2, 3], [12, 2, 2, 3], [7, 7, 2, 3], [5, 10, 6, 2], [3, 12, 10, 2]],
  // four arrows out from the middle: pick a thing up and put it somewhere else
  arrange: [[7, 0, 2, 1], [6, 1, 4, 1], [5, 2, 6, 1], [5, 13, 6, 1], [6, 14, 4, 1], [7, 15, 2, 1], [0, 7, 1, 2], [1, 6, 1, 4], [2, 5, 1, 6], [15, 7, 1, 2], [14, 6, 1, 4], [13, 5, 1, 6], [7, 3, 2, 10], [3, 7, 10, 2]],
  room: [[2, 2, 12, 3], [1, 5, 3, 7], [12, 5, 3, 7], [4, 8, 8, 4], [2, 12, 2, 2], [12, 12, 2, 2]],
  fit: [[1, 1, 5, 1], [1, 1, 1, 5], [10, 1, 5, 1], [14, 1, 1, 5], [1, 14, 5, 1], [1, 10, 1, 5], [10, 14, 5, 1], [14, 10, 1, 5], [7, 7, 2, 2]],
  check: [[2, 8, 2, 2], [4, 10, 2, 2], [6, 12, 2, 2], [8, 10, 2, 2], [10, 8, 2, 2], [12, 6, 2, 2], [14, 4, 2, 2], [8, 8, 2, 2], [10, 6, 2, 2], [12, 4, 2, 2]],
  coin: [[5, 1, 6, 1], [3, 2, 2, 1], [11, 2, 2, 1], [2, 3, 1, 2], [13, 3, 1, 2], [1, 5, 1, 6], [14, 5, 1, 6], [2, 11, 1, 2], [13, 11, 1, 2], [3, 13, 2, 1], [11, 13, 2, 1], [5, 14, 6, 1], [7, 3, 2, 10], [5, 5, 5, 1], [6, 10, 5, 1]],
  recap: [[7, 1, 2, 1], [5, 2, 6, 1], [4, 3, 8, 5], [3, 8, 10, 2], [2, 10, 12, 1], [6, 12, 4, 1], [7, 13, 2, 1]],
  note: [[3, 1, 9, 1], [3, 1, 1, 14], [3, 14, 10, 1], [12, 4, 1, 11], [11, 1, 1, 4], [11, 4, 2, 1], [5, 6, 6, 1], [5, 9, 6, 1], [5, 12, 4, 1]],
  alert: [[7, 2, 2, 8], [7, 12, 2, 2]],
  ne: NORTH_EAST, nw: mirror(NORTH_EAST, true, false), se: mirror(NORTH_EAST, false, true), sw: mirror(NORTH_EAST, true, true),
};

export function studioIcon(kind: keyof typeof STUDIO | string, size = 16) {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">`
    + draw(STUDIO[kind] ?? STUDIO.boards) + '</svg>';
}
