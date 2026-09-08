// Frame tables for the Game Dev Story sheets. Body sheets are 6 cols x 4 rows of 17px-wide cells
// with row heights 16/17/17/16 (rows touch, so they are addressed explicitly). Faces are 16x15, 5x2.
import type Phaser from 'phaser';
import { SEAT_TEXTURES } from './seats';
import { THEMES, type Theme } from './themes';
import type { AgentInfo } from '../shared/types';

export const BODY_COUNT = 26;
export const FACE_COUNT = 36;
export const BODY_W = 16;
export const BODY_ROWS = [ { y: 0, h: 16 }, { y: 16, h: 17 }, { y: 33, h: 17 }, { y: 50, h: 16 } ];
export const FACE_W = 16, FACE_H = 15;

/** Body poses, taken from the game's own table.
 *
 *  form.GameForm.NewGamePara fills BodyFaceUke with 42 rows via AddBodyFace, and DrawHuman draws
 *  the body as DrawImage(img, X + row[0], Y + row[1], row[2], row[3], row[4], row[5]). So each
 *  pose carries its own source rect AND its own draw offset — the sheet is not a uniform grid.
 *  In particular the cells are 16 wide at x = 0, 16, 32, not 17, and the poses past x = 48 have
 *  their own sizes. Getting this wrong put a slice of the neighbouring frame in every sprite.
 *
 *  Each facing has a stand frame, two walk frames, and a short "head only" crop the game uses when
 *  the body is hidden behind furniture. Column 6 of the table is +1 or -1 and marks the facing:
 *  the y=33 and y=50 blocks are pixel-exact mirrors of y=16 and y=0 (verified: RMSE 0), so the art
 *  is ALREADY mirrored and must not be flipped again when drawn. Their FACE offset does mirror
 *  though: fx becomes -1, since the face's 12px of content sits 3px in on one frame and 1px in on
 *  its mirror. Miss that and the head sits 2px off the shoulders.
 *
 *  fx/fy are the FACE's own offset from the same anchor, from columns 6 and 7 of the table plus the
 *  +1 DrawHuman adds to the face's y. The face is not positioned relative to the body: for a
 *  standing pose the body sits at dy 14 while the face sits at 2 (the table says 1 and DrawHuman
 *  adds 1), so the head clears the shoulders
 *  by 13px and overlaps them by 2. Deriving it from the body's top, as I did before, dropped every
 *  head about 9px. */
export interface BodyPose { x: number; y: number; w: number; h: number; dx: number; dy: number; fx: number; fy: number; face: string }
export const BODY_POSE: Record<string, BodyPose> = {
  // facing away from the camera
  standAway:  { x: 0,  y: 0,  w: 16, h: 16, dx: 0, dy: 14, fx: 1, fy: 2, face: 'awayR' },
  headAway:   { x: 0,  y: 0,  w: 16, h: 5,  dx: 0, dy: 14, fx: 1, fy: 2, face: 'awayR' },
  walkAway1:  { x: 16, y: 0,  w: 16, h: 16, dx: 0, dy: 14, fx: 1, fy: 3, face: 'awayR' },
  walkAway2:  { x: 32, y: 0,  w: 16, h: 16, dx: 0, dy: 14, fx: 1, fy: 3, face: 'awayR' },
  // facing the camera
  standFront: { x: 0,  y: 16, w: 16, h: 17, dx: 0, dy: 13, fx: 1, fy: 2, face: 'frontR' },
  headFront:  { x: 0,  y: 16, w: 16, h: 6,  dx: 0, dy: 13, fx: 1, fy: 2, face: 'frontR' },
  walkFront1: { x: 16, y: 16, w: 16, h: 17, dx: 0, dy: 13, fx: 1, fy: 3, face: 'frontR' },
  walkFront2: { x: 32, y: 16, w: 16, h: 17, dx: 0, dy: 13, fx: 1, fy: 3, face: 'frontR' },
  // the mirrored pair of each (the game flips these when it draws them)
  standFront2:{ x: 0,  y: 33, w: 16, h: 17, dx: 0, dy: 13, fx: -1, fy: 2, face: 'frontL' },
  walkFront3: { x: 16, y: 33, w: 16, h: 17, dx: 0, dy: 13, fx: -1, fy: 3, face: 'frontL' },
  walkFront4: { x: 32, y: 33, w: 16, h: 17, dx: 0, dy: 13, fx: -1, fy: 3, face: 'frontL' },
  standAway2: { x: 0,  y: 50, w: 16, h: 16, dx: 0, dy: 14, fx: -1, fy: 2, face: 'awayL' },
  walkAway3:  { x: 16, y: 50, w: 16, h: 16, dx: 0, dy: 14, fx: -1, fy: 3, face: 'awayL' },
  walkAway4:  { x: 32, y: 50, w: 16, h: 16, dx: 0, dy: 14, fx: -1, fy: 3, face: 'awayL' },
  // seated at a desk, leaning into the keyboard. There are three: one seen from the front and two
  // from behind. The face cell in each row is what identifies them — the away ones pair with an
  // away face, so they are the same action seen from the other side, not a slump.
  typeFront1:      { x: 65, y: 20, w: 16, h: 13, dx: 1,  dy: 12, fx: 1, fy: 1, face: 'frontR' },
  typeFront2:      { x: 65, y: 33, w: 16, h: 13, dx: 1,  dy: 12, fx: 1, fy: 1, face: 'frontR' },
  // standing, reacting, and out cold
  cheer:      { x: 81, y: 0,  w: 20, h: 21, dx: -1, dy: 6, fx: 0, fy: 0, face: 'front3' },
  cheerBig:   { x: 82, y: 21, w: 20, h: 21, dx: -3, dy: 4, fx: 0, fy: 1, face: 'front' },
  standIdle:       { x: 48, y: 0,  w: 17, h: 20, dx: 0,  dy: 10, fx: 0, fy: 2, face: 'front2' },
  standIdle2:      { x: 65, y: 0,  w: 16, h: 20, dx: 1,  dy: 10, fx: 3, fy: 2, face: 'front4' },
  sitFront:       { x: 48, y: 20, w: 17, h: 18, dx: -1, dy: 11, fx: 0, fy: 1, face: 'frontL' },
  typeAwayR:      { x: 48, y: 38, w: 17, h: 13, dx: 1,  dy: 13, fx: 0, fy: 1, face: 'awayR' },
  typeAwayL1:   { x: 48, y: 51, w: 17, h: 15, dx: 0,  dy: 12, fx: 2, fy: 1, face: 'awayL' },
  typeAwayL2:  { x: 65, y: 46, w: 17, h: 13, dx: 0,  dy: 13, fx: 2, fy: 1, face: 'awayL' },
  lieDown:        { x: 82, y: 42, w: 20, h: 24, dx: -1, dy: 5, fx: 2, fy: 1, face: 'profile' },
};

/** Face frames. Row 0 holds the four walking directions: two front and two away. The away pair is
 *  a three-quarter head, so a character walking away still shows a sliver of cheek — that is the
 *  game's own art, not a mistake; several sheets have no fully-hidden face at all.
 *
 *  Which column goes with which body block is in the table, columns 8 and 9 (the face's source
 *  rect): y=0 takes column 3, y=16 column 1, y=33 column 0, y=50 column 2. So the two away
 *  directions use awayR and awayL respectively — the opposite of the pairing I first guessed.
 *
 *  Each pose therefore carries its own `face`, read from columns 8 and 9 of its row. The seated and
 *  slumped poses do not all use a forward face: head-down takes an away face, lean takes the other
 *  front one, and slump takes the other away one. Picking a face by hand gets these wrong. */
export const FACE: Record<string, [number, number]> = {
  frontL: [0, 0], frontR: [1, 0], awayL: [2, 0], awayR: [3, 0],
  front: [0, 1], profile: [1, 1], front2: [2, 1], front4: [3, 1], front3: [4, 1],
};
// Frame 1's seat sits right of its backrest and frame 2's left, so 1 faces SE and 2 SW —
// the opposite of how they were named here before.
export const CHAIR = { w: 21, h: 32, frames: ['back', 'faceSE', 'faceSW', 'side'] };
export const DESK = { w: 50, h: 64, frames: ['alongSE', 'alongSW', 'extra'] }; // 150px sheets hold three 50px frames
export const PC = { w: 50, h: 32, frames: ['back', 'on0', 'on1', 'on2', 'on3', 'on4'] };

/** Small stat icons on main00 (gamepad, coin, art, sound, bug, disk). */
export const ICONS: Record<string, [number, number, number, number]> = { gamepad: [132, 115, 16, 14], coin: [150, 114, 16, 16], art: [168, 114, 16, 16], sound: [186, 114, 16, 16], bug: [204, 114, 17, 16], disk: [134, 130, 15, 10], levelup: [14, 161, 53, 12] };

/** The "hard at work" flame the game draws behind a busy dev: four frames on main00, bottom row. */
export const FLAME = { x: 108, y: 180, w: 33, h: 60, frames: ['flame0', 'flame1', 'flame2', 'flame3'] };

export function bodyKey(i: number) { return `body${i}`; }
export function faceKey(i: number) { return `face${i}`; }

export function loadSheets(load: Phaser.Loader.LoaderPlugin, base = '/assets/gds', selected?: { looks: { body: number; face: number }[]; theme: Theme }) {
  const bodies = selected ? new Set([0, 8, ...selected.looks.map(l => l.body)]) : Array.from({ length: BODY_COUNT }, (_, i) => i);
  const faces = selected ? new Set([0, 6, 12, ...selected.looks.map(l => l.face)]) : Array.from({ length: FACE_COUNT }, (_, i) => i);
  for (const i of bodies) load.image(bodyKey(i), `${base}/body/body${i}.png`);
  for (const i of faces) load.image(faceKey(i), `${base}/face/face_${i}.png`);
  for (const k of [...SEAT_TEXTURES.desks, ...SEAT_TEXTURES.chairs, ...SEAT_TEXTURES.pcs, 'kb_far']) load.image(k, `${base}/office/${k}.png`);
  for (const k of ['sky', 'carpet', 'bang', 'main00', 'main01', 'interface0', 'emoji', 'kairokun']) load.image(k, `${base}/ui/${k}.png`);
  // the explosion from event6, for a payment that blew up or a pane that crashed
  for (let i = 0; i < 3; i++) load.image(`boom${i}`, `${base}/scenes/boom_${i}.png`);
  for (const t of selected ? [selected.theme] : THEMES) { load.image(t.carpet, `${base}/ui/${t.carpet}.png`);
    load.image(`${t.facade}_r`, `${base}/ui/${t.facade}_r.png`); load.image(`${t.facade}_l`, `${base}/ui/${t.facade}_l.png`); }
  // the eight work balloons DrawFukidashi shows over a dev, cut out of main01
  // Sprite URLs are cached for a day; invalidate the old clipped, white-fringed burst.
  for (let i = 0; i < 8; i++) load.image(`balloon${i}`, `${base}/ui/balloon_${i}.png${i === 0 ? '?v=2' : ''}`);
  load.image('reception', `${base}/office/reception_002.png`);
  // bugEff_: three 33x27 frames of bug bubbles, drawn by DrawObj over a desk mid-development
  load.spritesheet('bugbubble', `${base}/ui/bugbubble.png`, { frameWidth: 33, frameHeight: 27 });
}

/** Cut named frames into the loaded textures. Call once after preload. */
export function defineFrames(textures: Phaser.Textures.TextureManager) {
  const awards = textures.get('main01');
  if (!awards.has('studio-trophy')) awards.add('studio-trophy', 0, 0, 177, 16, 16);
  for (let i = 0; i < BODY_COUNT; i++) {
    if (!textures.exists(bodyKey(i))) continue;
    const t = textures.get(bodyKey(i));
    if (t.has('standFront')) continue;
    for (const [name, p] of Object.entries(BODY_POSE)) t.add(name, 0, p.x, p.y, p.w, p.h);
  }
  for (let i = 0; i < FACE_COUNT; i++) {
    if (!textures.exists(faceKey(i))) continue;
    const t = textures.get(faceKey(i));
    if (t.has('front')) continue;
    for (const [name, [c, r]] of Object.entries(FACE)) t.add(name, 0, c * FACE_W, r * FACE_H, FACE_W, FACE_H);
  }
  { const t = textures.get('main00');
    if (!t.has('coin')) for (const [n, [x, y, w, h]] of Object.entries(ICONS)) t.add(n, 0, x, y, w, h);
    if (!t.has('flame0')) FLAME.frames.forEach((n, i) => t.add(n, 0, FLAME.x + i * FLAME.w, FLAME.y, FLAME.w, FLAME.h)); }
  for (const k of SEAT_TEXTURES.chairs) { if (!textures.exists(k)) continue; const t = textures.get(k); if (!t.has('back')) CHAIR.frames.forEach((n, i) => t.add(n, 0, i * CHAIR.w, 0, CHAIR.w, CHAIR.h)); }
  for (const k of SEAT_TEXTURES.desks) { if (!textures.exists(k)) continue; const t = textures.get(k); if (!t.has('alongSE')) DESK.frames.forEach((n, i) => t.add(n, 0, i * DESK.w, 0, DESK.w, DESK.h)); }
  for (const k of SEAT_TEXTURES.pcs) { if (!textures.exists(k)) continue; const t = textures.get(k); if (!t.has('back')) PC.frames.forEach((n, i) => t.add(n, 0, (i % 2) * PC.w, Math.floor(i / 2) * PC.h, PC.w, PC.h)); }
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** Stable look per pane: which body sheet + face sheet. */
const officeLooks = new Map<string, { body: number; face: number }>();
export function setOfficeLooks(agents: AgentInfo[]) { for (const a of agents) if (a.office_look) officeLooks.set(a.pane_id, a.office_look); }
export function lookFor(paneId: string) {
  const custom = officeLooks.get(paneId); if (custom) return custom;
  const h = hash(paneId);
  return { body: h % BODY_COUNT, face: (h >>> 8) % FACE_COUNT };
}

/** Optional looks/themes load independently of the sleeping game loop and coalesce by texture. */
const pendingTextures = new WeakMap<Phaser.Textures.TextureManager, Map<string, Promise<void>>>();
function ensureImage(textures: Phaser.Textures.TextureManager, key: string, url: string): Promise<void> {
  if (textures.exists(key)) return Promise.resolve();
  let pending = pendingTextures.get(textures);
  if (!pending) { pending = new Map(); pendingTextures.set(textures, pending); }
  const existing = pending.get(key); if (existing) return existing;
  const request = new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => { if (!textures.exists(key)) textures.addImage(key, image); resolve(); };
    image.onerror = () => reject(new Error(`Could not load ${key}`));
    image.src = url;
  }).finally(() => pending!.delete(key));
  pending.set(key, request); return request;
}
export function ensureAppearance(textures: Phaser.Textures.TextureManager, look: { body: number; face: number }) {
  return Promise.all([
    ensureImage(textures, bodyKey(look.body), `/assets/gds/body/body${look.body}.png`),
    ensureImage(textures, faceKey(look.face), `/assets/gds/face/face_${look.face}.png`),
  ]).then(() => defineFrames(textures));
}
export function ensureTheme(textures: Phaser.Textures.TextureManager, theme: Theme) {
  return Promise.all([theme.carpet, `${theme.facade}_r`, `${theme.facade}_l`]
    .map(key => ensureImage(textures, key, `/assets/gds/ui/${key}.png`)));
}
