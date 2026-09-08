#!/usr/bin/env node
// Draws the keyboard the game leaves out.
//
// pc_001's 'back' frame — a monitor seen from behind — carries a mouse but no keyboard: from that
// angle the keys would sit where the occupant's own body is, so Kairosoft never drew them. Our far
// desks show more of the mat than the game's do, and the bare green reads as an unfinished desk,
// so this generates one.
//
// The keyboard in the 'on0' frame turns out to be a single cross-section swept along the desk's
// (2,-1) axis: every scanline across it reads the same run of colours, shifted two pixels per row.
// STRIPE below is that run, lifted pixel for pixel off `convert pc_001.png rgba:-` at y=22, so the
// palette and the shading are the game's. What is ours is the sweep: the original's lower corner
// is hidden behind its own monitor, and a keyboard on the far side of a desk needs to be whole.
//
// Writes public/assets/gds/office/kb_far.png.
import { execSync } from 'node:child_process';

/** One scanline across the original keyboard, back edge to front: top face, key rows, lip, base. */
const STRIPE = [
  [40, 40, 44],
  [146, 135, 131], [169, 157, 153], [156, 146, 143],
  [226, 214, 208],                                    // upper key row
  [146, 135, 131], [192, 180, 176], [169, 157, 153],
  [208, 191, 182],                                    // lower key row
  [85, 84, 83], [122, 104, 96],                       // front lip, and its shadow on the desk
  [40, 40, 44], [40, 40, 44],
];
const STEP = 0.25;                 // a stripe is one pixel along a scanline, which is 0.25 across
const WD = STRIPE.length * STEP;   // 3.25
// The original runs about 6 units long, but that keyboard has the whole front of a desk to lie
// on. This one has to fit between the desk's back edge and the monitor standing on the mat, so it
// is shortened to 4 — any longer and it hangs off the desk.
const L = 4;
const W = Math.ceil(2 * (L + WD)) + 1, H = Math.ceil(L + WD) + 1;
const ORIGIN = { x: 0, y: Math.ceil(L) };   // the slab's back corner, so the shape fits the canvas

const px = new Uint8Array(W * H * 4);
const put = (x, y, c) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4;
  px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
};

/** Screen point -> slab coordinates. The axes are (2,-1) along the slab and (2,1) across it. */
const uv = (x, y) => {
  const dx = x - ORIGIN.x, dy = y - ORIGIN.y;
  return { u: (dx / 2 - dy) / 2, v: (dx / 2 + dy) / 2 };
};

for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const { u, v } = uv(x, y);
  if (u < 0 || u >= L || v < 0 || v >= WD) continue;
  put(x, y, STRIPE[Math.min(STRIPE.length - 1, Math.floor(v / STEP))]);
}

// the sweep leaves the two ends open; close them the way every Kairosoft object is closed
const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && px[(y * W + x) * 4 + 3] > 0;
const edges = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (solid(x, y)) continue;
  if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) edges.push([x, y]);
}
for (const [x, y] of edges) put(x, y, STRIPE[0]);

const out = 'public/assets/gds/office/kb_far.png';
execSync(`convert -size ${W}x${H} -depth 8 rgba:- ${out}`, { input: Buffer.from(px) });
console.log(`${out}  ${W}x${H}`);
