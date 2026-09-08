// Sprite debug page: ?lab=people
//
// Shows every named body frame with a face on it, and a row of looping animations, so poses can be
// checked without hunting for an agent in the office. Params:
//   ?lab=people&body=6&face=20   pick the sheets (default: a spread of pairs)
//   &fx=0&fy=-4                  nudge the face offset
//   &speed=250                   ms per animation frame
//
// It also builds the two compound seats layer by layer, through the same seats.ts code path the
// office uses, next to the game's own composed art (graphics/game/desk0_origin.png) so the two
// can be compared without hunting for a desk in the office.
import Phaser from 'phaser';
import { BODY_POSE, FACE, bodyKey, defineFrames, faceKey, loadSheets } from '../sprites';
import { OFFSETS, poseFor, seatSprites } from '../seats';

/** Looping animations, named for what they actually look like on the sheet. */
export const ANIMS: { name: string; frames: string[]; face: string }[] = [
  { name: 'stand bk',  frames: ['standAway'],                                  face: 'awayR' },
  { name: 'walk bk',   frames: ['standAway', 'walkAway1', 'standAway', 'walkAway2'], face: 'awayR' },
  { name: 'stand fr',  frames: ['standFront'],                                 face: 'frontR' },
  { name: 'walk fr',   frames: ['standFront', 'walkFront1', 'standFront', 'walkFront2'], face: 'frontR' },
  { name: 'walk fr2',  frames: ['standFront2', 'walkFront3', 'standFront2', 'walkFront4'], face: 'frontL' },
  { name: 'walk bk2',  frames: ['standAway2', 'walkAway3', 'standAway2', 'walkAway4'], face: 'awayL' },
  { name: 'type fr',   frames: ['typeFront1', 'typeFront2'],                    face: 'frontR' },
  { name: 'type bk',   frames: ['typeAwayL1', 'typeAwayL2'],                    face: 'awayL' },
  { name: 'type bk2',  frames: ['typeAwayR'],                                   face: 'awayR' },
  { name: 'cheer',     frames: ['cheer', 'cheerBig'],                          face: 'front3' },
  { name: 'stand idle',frames: ['standIdle', 'standIdle2'],                     face: 'front' },
  { name: 'sit fr',    frames: ['sitFront'],                                    face: 'frontL' },

  { name: 'lie down',  frames: ['lieDown'],                                     face: 'profile' },
];

export class PeopleScene extends Phaser.Scene {
  constructor() { super('people'); }
  preload() {
    loadSheets(this.load);
    // the game's own composed desk sheet, for the reference column
    this.load.image('desk0_origin', '/assets/gds/office/desk0_origin.png');
  }

  create() {
    defineFrames(this.textures);
    // bottom row of desk0_origin is the desk_002 tier: [monitor back] [lit screen] [corner desk]
    { const t = this.textures.get('desk0_origin');
      if (!t.has('far')) { t.add('far', 0, 0, 95, 50, 48); t.add('near', 0, 50, 95, 50, 48); } }
    const q = new URLSearchParams(location.search);
    const fx = Number(q.get('fx') ?? 0), fy = Number(q.get('fy') ?? 0);   // nudge on top of the table's own offset
    const speed = Number(q.get('speed') ?? 260);
    const bodies = q.has('body') ? [Number(q.get('body'))] : [6, 0, 12, 19];
    const faces = q.has('face') ? [Number(q.get('face'))] : [20, 3, 11, 27];

    const cam = this.cameras.main;
    cam.setBackgroundColor('#5b4436');

    const label = (x: number, y: number, t: string, colour = '#e8e2d4') =>
      this.add.text(x, y, t, { fontFamily: 'DotGothic16', fontSize: '7px', color: colour }).setResolution(4);

    // one animated character; returns its height so rows can stack
    const character = (x: number, y: number, b: number, f: number, anim: typeof ANIMS[number]) => {
      const body = this.add.image(x, y, bodyKey(b), anim.frames[0]).setOrigin(0, 0);
      const face = this.add.image(0, 0, faceKey(f), BODY_POSE[anim.frames[0]].face).setOrigin(0, 0);
      // each pose carries its own draw offset, so the feet stay put as the frame changes
      const place = (n: string) => {
        const p = BODY_POSE[n];
        body.setPosition(x + p.dx, y + p.dy);
        face.setFrame(p.face).setPosition(x + p.fx + fx, y + p.fy + fy);
      };
      place(anim.frames[0]);
      if (anim.frames.length > 1) {
        let i = 0;
        this.time.addEvent({ delay: speed, loop: true, callback: () => {
          i = (i + 1) % anim.frames.length; body.setFrame(anim.frames[i]); place(anim.frames[i]);
        } });
      }
    };

    // --- animations: one column per animation, one row per body/face pair
    const X0 = 56, colW = 46, rowH = 46;   // X0 leaves room for the row labels
    label(4, 2, 'ANIMATIONS   ?lab=people&body=N&face=N&speed=MS&fx=N&fy=N');
    ANIMS.forEach((a, c) => label(X0 + c * colW - 18, 12, a.name));
    bodies.forEach((b, r) => {
      const f = faces[r % faces.length];
      const y = 34 + r * rowH;
      label(4, y - 12, `body${b}\nface${f}`);
      ANIMS.forEach((a, c) => character(X0 + c * colW, y, b, f, a));
    });

    // --- compound seats: what the office actually draws, one layer at a time
    // A seat is desk + monitor + occupant + chair hung off one anchor. Everything here comes from
    // seatSprites()/poseFor() so this page cannot drift from the office, and the last column is
    // the game's own composed cell drawn over the same anchor for comparison.
    const ctop = 34 + bodies.length * rowH + 16;
    label(4, ctop - 12, "COMPOUND SEATS  (seats.ts, same code path as the office; last column is the game's own art)");
    const STAGES = [
      { name: 'desk', mask: 0b0001 },
      { name: '+ monitor', mask: 0b0011 },
      { name: '+ occupant', mask: 0b0111 },
      { name: '+ chair', mask: 0b1111 },
    ];
    const seatW = 74, seatH = 108;
    STAGES.forEach((st, c) => label(X0 + c * seatW - 6, ctop + 2, st.name, '#f1e4c8'));
    label(X0 + STAGES.length * seatW - 6, ctop + 2, 'game reference', '#9fd8f2');
    label(X0 + (STAGES.length + 1) * seatW - 6, ctop + 2, 'overlaid', '#9fd8f2');
    const seat = (ax: number, ay: number, mirror: boolean, mask: number, base: number, alpha = 1) => {
      const sp = seatSprites(mirror), pose = poseFor(mirror);
      const put = (l: { key: string; frame: string; dx: number; dy: number; sort: number }) =>
        this.add.image(ax + l.dx, ay + l.dy, l.key, l.frame).setOrigin(0, 0).setDepth(base + l.sort);
      if (mask & 0b0001) put(sp.desk).setAlpha(alpha);
      if (mask & 0b0010) {
        if (sp.kb) put(sp.kb).setAlpha(alpha);   // ours, not the game's — see FAR_KEYBOARD
        const pc = put(sp.pc).setAlpha(alpha);
        if (sp.screen) { let i = 0; this.time.addEvent({ delay: speed, loop: true, callback: () => pc.setFrame('on' + (i = (i + 1) % 5)) }); }
      }
      if (mask & 0b0100) {
        const person = this.add.container(ax + sp.person.x, ay + sp.person.y).setDepth(base + sp.person.sort);
        const body = this.add.image(0, 0, bodyKey(bodies[0]), pose.typing[0]).setOrigin(0, 0);
        const face = this.add.image(0, 0, faceKey(faces[0]), pose.face).setOrigin(0, 0);
        person.add([body, face]);
        const place = (n: string) => {
          const p = BODY_POSE[n];
          body.setFrame(n).setPosition(p.dx, p.dy);
          face.setFrame(p.face).setPosition(p.fx + fx, p.fy + fy);
        };
        place(pose.typing[0]);
        let i = 0;
        this.time.addEvent({ delay: speed, loop: true, callback: () => place(pose.typing[i = (i + 1) % 2]) });
      }
      if (mask & 0b1000) { put(sp.chair); if (sp.chairFront) put(sp.chairFront); }
    };
    [true, false].forEach((mirror, r) => {
      const sp = seatSprites(mirror), pose = poseFor(mirror);
      const y = ctop + 14 + r * seatH, ay = y + 52;
      label(4, y + 26, mirror
        ? 'far row\nfaces us\nmonitor back'
        : 'near row\nback to us\nlit screen');
      STAGES.forEach((st, c) => seat(X0 + c * seatW, ay, mirror, st.mask, 100 + (r * 8 + c) * 10));
      // the game's own cell over the same anchor: its desk content sits 8px down inside the cell
      const refFrame = mirror ? 'far' : 'near';
      this.add.image(X0 + STAGES.length * seatW, ay - 8, 'desk0_origin', refFrame).setOrigin(0, 0).setDepth(90);
      // and once more with our desk and monitor half-lit on top: any offset error doubles an edge
      const ox = X0 + (STAGES.length + 1) * seatW;
      this.add.image(ox, ay - 8, 'desk0_origin', refFrame).setOrigin(0, 0).setDepth(90);
      seat(ox, ay, mirror, 0b0011, 200 + r * 10, 0.5);
      label(X0, ay + 46,
        `desk ${sp.desk.frame} (${sp.desk.dx},${sp.desk.dy})   pc ${sp.pc.frame} (${sp.pc.dx},${sp.pc.dy})   ` +
        `chair ${sp.chair.frame} (${sp.chair.dx},${sp.chair.dy})   occupant (${sp.person.x},${sp.person.y}) ${pose.typing.join('/')}` +
        (sp.kb ? `   kb_far (${sp.kb.dx},${sp.kb.dy}) ours` : ''),
        '#b9ae9c');
    });
    label(4, ctop + 14 + 2 * seatH - 4,
      `anchor offsets from seats.ts OFFSETS: desk (${OFFSETS.desk.x},${OFFSETS.desk.y}) ` +
      `pc (${OFFSETS.pc.x},${OFFSETS.pc.y}) chair (${OFFSETS.chair.x},${OFFSETS.chair.y}) ` +
      `person (${OFFSETS.person.x},${OFFSETS.person.y})`, '#b9ae9c');

    // --- every body frame, static, with the face on it, so names can be checked
    const top = ctop + 14 + 2 * seatH + 20;
    label(4, top - 12, 'ALL BODY FRAMES (name below each, face overlaid at the current offset)');
    const b0 = bodies[0], f0 = faces[0];
    Object.entries(BODY_POSE).forEach(([name, p], i) => {
      const x = 20 + (i % 12) * 34, y = top + 26 + Math.floor(i / 12) * 44;
      this.add.image(x, y + p.dy, bodyKey(b0), name).setOrigin(0.5, 0);
      this.add.image(x - 8 + p.fx + fx, y + p.fy + fy, faceKey(f0), p.face).setOrigin(0, 0);
      label(x - 15, y + 36, `${name}\n${p.x},${p.y} ${p.w}x${p.h}`);
    });

    // --- every face frame
    const ftop = top + 26 + Math.ceil(Object.keys(BODY_POSE).length / 12) * 44 + 16;
    label(4, ftop - 10, 'ALL FACE FRAMES');
    Object.keys(FACE).forEach((name, i) => {
      const x = 20 + i * 34, y = ftop + 6;
      this.add.image(x, y, faceKey(f0), name).setOrigin(0.5, 0);
      label(x - 15, y + 17, name);
    });

    label(4, ftop + 34, `rects and offsets from the game's own AddBodyFace table   face offset (${fx},${fy})`, '#b9ae9c');

    // fit the whole sheet, then allow dragging if it is still taller than the window
    const W = Math.max(X0 + ANIMS.length * colW, X0 + 6 * 74) + 10, H = ftop + 48;
    const fit = Math.min(cam.width / W, cam.height / H);
    cam.setZoom(Math.max(1, Math.min(4, fit)));
    cam.centerOn(W / 2, H / 2);   // fit the sheet, then drag or wheel to explore
    let drag = false, from = { x: 0, y: 0 }, camFrom = { x: 0, y: 0 };
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { drag = true; from = { x: p.x, y: p.y }; camFrom = { x: cam.scrollX, y: cam.scrollY }; });
    this.input.on('pointerup', () => (drag = false));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!drag || !p.isDown) return;
      cam.setScroll(camFrom.x - (p.x - from.x) / cam.zoom, camFrom.y - (p.y - from.y) / cam.zoom);
    });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) =>
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.5, 8)));
  }
}
