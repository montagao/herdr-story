// Cluster and seat geometry taken from the game's own code (IL2CPP extraction of Game Dev Story
// 2.6.9), not from eyeballing screenshots.
//
// form.GameForm.DeskZahyou (int[3][9][2], built in .cctor at RVA 0xe6e234) holds one seat anchor
// per desk for each office layout: index 0 is the CEO desk, 1-4 and 5-8 are two clusters of four.
// Every cluster in every layout uses the same four anchors, in game pixels:
//
//     (0,0)  (16,8)  (36,-18)  (52,-10)
//
// Unused desks are parked off-screen by storing a 10x x-coordinate.
//
// CallDeskChange, CallChairChange and CallPCChange each position their object as
// DeskZahyou[seat] + a constant pair taken from DeskImgData/ChairImgData/PCImgData, and
// DrawObj seats the person at DeskZahyou[seat] + (15,-10). So all four objects hang off the SAME
// seat anchor with fixed offsets; every seat in a cluster is the identical composition, and the
// visual differences between seats come only from their anchors and the person's facing.
//
// Offsets below are the top-left of each sprite's source rect relative to the seat anchor.
export interface Vec { x: number; y: number }

/** Seat anchors of one cluster, from DeskZahyou. */
export interface Anchor extends Vec { mirror: boolean }
/** Seat anchors of one cluster, from DeskZahyou. The two back desks are mirrored, so the bank is
 *  back to back: their monitors show us their backs and their occupants face the camera. */
export const ANCHORS: Anchor[] = [
  // A bank is two rows running along the (36,-18) direction, the rows offset by (16,8).
  // The far row is the one with the smaller y within each pair; its occupants face the camera and
  // its monitors turn away from us, so we see their backs.
  { x: 0,  y: 0,   mirror: true },
  { x: 36, y: -18, mirror: true },
  { x: 16, y: 8,   mirror: false },
  { x: 52, y: -10, mirror: false },
];

/** One step further along the bank: the desk after (36,-18) is another (36,-18) on. */
export const BANK_STEP: Vec = { x: 72, y: -36 };

/**
 * Seat anchors for a cluster of `pairs` four-desk banks. A project gets one cluster however many
 * agents it has, so the bank simply runs on: pairs of desks continue up the (36,-18) diagonal
 * rather than the project being split across separate pods.
 */
export function anchorsFor(pairs: number): Anchor[] {
  const out: Anchor[] = [];
  for (let k = 0; k < Math.max(1, pairs); k++)
    for (const a of ANCHORS) out.push({ x: a.x + k * BANK_STEP.x, y: a.y + k * BANK_STEP.y, mirror: a.mirror });
  return out;
}

/** Object offsets from the seat anchor, in game px (top-left of the source rect). */
// Desk and chair offsets are read straight out of the game's tables; the monitor is measured
// off a screenshot, where the two unoccluded screens fix the scale exactly (their separation is
// the (36,-18) anchor step, giving 3.389x).
//
// Resolving which static blob is which table: the .cctor loads each row through a metadata-usage
// slot, and the relocations for those slots give six tokens whose order is
// Desk[2] < Desk[1] < Chair[1] < Desk[0] < Chair[0] < Chair[2]. Ranking the eight 56-int blobs by
// field index and dropping the two the desk/chair tables never touch reproduces that order
// exactly, which pins DeskImgData, ChairImgData and (by elimination) PCImgData.
// DeskImgData[type][7..8] = (0,0); ChairImgData[type][10..11] = (1,-7) for two of the three
// chair tiers and (4,-10) for the third.
export const OFFSETS = {
  // Crop top-left relative to the seat anchor, in game px.
  //
  // The desk and monitor come from the game's own composed reference art,
  // graphics/game/desk0_origin.png: a 3x3 sheet of desk tier x orientation with the monitor,
  // keyboard and mouse already sitting on the desk. Our desk_002 and pc_001 frames match its
  // bottom row pixel for pixel (100% on both), and in it the monitor frame sits exactly 11px
  // below the desk frame — so with the desk at -23 the monitor goes at -12, on both sides of a
  // bank. Only the frames differ: see seatSprites.
  //
  // The chair and person are still measured off a screenshot; the game has no composed reference
  // with a person in it.
  desk:   { x: 0, y: -23 },   // content box 50x40+0+23
  pc:     { x: 0, y: -12 },   // desk0_origin: pc frame = desk frame + (0,11)
  chair:  { x: 24, y: 3 },   // to the occupant's lower right, so their back stays visible
  person: { x: 21, y: -1 },  // seated in that chair, hands on the keyboard
};

/** Draw order within one seat; across seats, anchor y dominates.
 *  The monitor stands on the desk and the person is in front of it: in the game their head and
 *  shoulder cover its left edge, which is why two of the four screens read as clipped.
 *  The game splits a chair into ChairMainObjec and ChairSubObjec so part of it draws behind the
 *  occupant and part in front. We have one chair sprite, so we put it behind a person who faces
 *  us and in front of one who has their back to us, which is what those two halves achieve. */
// DrawObj sorts by ObjecY, and each object's Y is the seat anchor plus its own offset:
// person -10, chair -7, desk 0, monitor last. One order therefore serves every seat.
// The game splits a chair into ChairMainObjec (seat and base, behind the occupant) and
// ChairSubObjec (the backrest's near edge, in front): the sheet's fourth frame is exactly that
// edge, cut at the same origin as the whole chair. So the near seat draws 'back' under the person
// and 'side' over them, and the occupant's back stays visible between the two.
export const SUB = { desk: 0, pc: 1, chair: 2, person: 3, chairFront: 4 };
/** Mirrored seat: the occupant sits behind the desk facing us, so they draw before it. */
export const SUB_M = { chair: 0, person: 1, desk: 2, pc: 3 };
const DESK_W = 50;
/** Mirror an x offset about the desk's width. */
const mx = (x: number, w: number) => DESK_W - x - w;  // The occupant faces away, so their back is toward us and the chair's backrest sits in
// front of it: the chair draws last. This is what the game's ChairMainObjec/ChairSubObjec
// split achieves with two half-chairs.
export function subFor(_i: number) { return SUB; }

/** Where each sprite's opaque content starts inside our extracted crop, so the crop can be
 *  placed such that its CONTENT lands on the game's offset. */
export const CONTENT = {
  desk:  { x: 0,  y: 23 },  // desk_002 frame 0: content 50x40+0+23
  pc:    { x: 11, y: 3 },   // pc_001 screen frames: content 28x28+11+3
  chair: { x: 0,  y: 7 },   // chair_002 frame 0: content 21x25+0+7
};

export interface SeatSprite { key: string; frame: string; dx: number; dy: number; sort: number; flip?: boolean }

/** Our own keyboard for the far side of a bank, generated by scripts/make-keyboard.mjs from the
 *  original's own cross-section. No seat uses it any more: on the far desks it stuck out beside
 *  the occupant instead of sitting under their hands. Kept for the sprite debug page. */
export const FAR_KEYBOARD = { key: 'kb_far', frame: '__BASE', dx: 10, dy: 6, sort: 2.5 };

/** Furniture by rank, the way the game's item shop upgrades a studio: every desk starts on the
 *  folding chair and the plain white table, and each tier is bought with shipped work (a level
 *  is three completions). The sheets are the game's own, and all of them share one cell layout —
 *  chair frames stand on the cell's base, desks keep their top at row 23 — so a swap needs no
 *  new offsets. Frames are named by defineFrames for every key listed here. */
export const CHAIR_TIERS: [level: number, key: string][] = [
  [1, 'chair_000'],   // grey folding chair
  [3, 'chair_002'],   // padded office chair
  [5, 'chair_003'],   // blue mesh
  [7, 'chair_019'],   // dark leather
  [9, 'chair_022'],   // racing chair
  [12, 'chair_023'],  // white gaming chair
  [15, 'chair_029'],  // the gold throne
];
export const DESK_TIERS: [level: number, key: string][] = [
  [1, 'desk_000'],    // white table
  [4, 'desk_002'],    // wood with a green blotter
  [9, 'desk_022'],    // walnut executive
];
const tierFor = (tiers: [number, string][], level: number) => tiers.reduce((key, [from, k]) => level >= from ? k : key, tiers[0][1]);
export const chairFor = (level: number) => tierFor(CHAIR_TIERS, level);
export const deskFor = (level: number) => tierFor(DESK_TIERS, level);
/** Every furniture sheet the office can show, for loading and frame cutting. */
export const SEAT_TEXTURES = { chairs: CHAIR_TIERS.map(t => t[1]), desks: DESK_TIERS.map(t => t[1]), pcs: ['pc_000', 'pc_001', 'pc_002'] };

/** Draw offsets for our crops (top-left origin) plus a sort key, for one seat anchor. */
export function seatSprites(mirror = false, level = 1): { desk: SeatSprite; pc: SeatSprite; chair: SeatSprite; chairFront?: SeatSprite; kb?: SeatSprite; person: Vec & { sort: number; flip: boolean }; screen: boolean } {
  const chair = chairFor(level), desk = deskFor(level);
  if (mirror) {
    const S = SUB_M;
    return {
      // desk0_origin pairs the monitor's back view with the alongSE desk — pedestal on the right
      desk:  { key: desk,  frame: 'alongSE', dx: OFFSETS.desk.x,  dy: OFFSETS.desk.y, sort: S.desk },
      // the monitor faces away from us, so the game draws its back rather than a mirrored screen
      pc:    { key: 'pc_001',    frame: 'back',    dx: OFFSETS.pc.x,    dy: OFFSETS.pc.y,   sort: S.pc },
      // the occupant is on the far side of the desk, so their feet sit at its back edge
      // this occupant faces us, so their chair's back points away: we see its front
      chair: { key: chair, frame: 'faceSE', dx: 5, dy: -16, sort: S.chair },
      // No keyboard: the game's back-view monitor frame has none, and our kb_far strip on the mat
      // between the occupant and the monitor read as a slab jutting out beside them.
      person: { x: 8, y: -9, sort: S.person, flip: false },   // face skin measured at far anchor+(8.6,-5.5)
      screen: false,   // we see the monitor's back, so there is no lit screen to animate
    };
  }
  return {
    // and pairs the lit screen with alongSW — the mirrored desk, pedestal on the left
    desk:   { key: desk,  frame: 'alongSW', dx: OFFSETS.desk.x,  dy: OFFSETS.desk.y,  sort: SUB.desk },
    pc:     { key: 'pc_001',    frame: 'on0',     dx: OFFSETS.pc.x,    dy: OFFSETS.pc.y,    sort: SUB.pc },
    chair:  { key: chair, frame: 'back',    dx: OFFSETS.chair.x, dy: OFFSETS.chair.y, sort: SUB.chair },
    chairFront: { key: chair, frame: 'side', dx: OFFSETS.chair.x, dy: OFFSETS.chair.y, sort: SUB.chairFront },
    person: { x: OFFSETS.person.x, y: OFFSETS.person.y, sort: SUB.person, flip: false },
    screen: true,
  };
}

/** Poses. Back-row seats face the camera, front-row seats have their back to it. */
// Seated workers use the game's own typing pose (a 16x13 lean into the keyboard); the same body
// serves both facings and only the face frame differs, which is how the game does it.
export const POSE = {
  facing: { flip: false, typing: ['typeFront1', 'typeFront2'] as [string, string], stand: 'standFront', face: 'frontR', glance: ['front', 'frontL'] },
  // a worker facing away types with the away-facing pose, not the forward one
  away:   { flip: false, typing: ['typeAwayL1', 'typeAwayL2'] as [string, string], stand: 'standAway', face: 'awayL', glance: ['profile'] },
};
export function poseFor(mirror: boolean) {
  // A seat's occupant always faces their own monitor. On a normal desk that is up-left, away from
  // the camera; on a mirrored desk it is down-right, so we see their face.
  return mirror ? POSE.facing : POSE.away;
}
