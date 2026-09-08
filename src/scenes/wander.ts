// Idle agents get up and walk around — on the floor grid, around the furniture.
//
// A room where thirty of thirty-one agents sit perfectly still reads as a screenshot, not an
// office. So an idle agent occasionally leaves its desk, walks to a table or a plant, stands
// around for a bit — chatting if someone else is already there — and walks back. Anything that is
// not idle stays at its desk, and an agent that gets work while it is out heads straight back.
//
// Movement is the game's: humans step tile to tile toward TargetX/TargetY along the four
// isometric headings. The floor is an occupancy grid built from every object's footprint (desk
// clusters, props, the reception), routes are A* over it, and nobody cuts through a desk.
//
// Everything here drives the same person sprite the desk owns, so an agent keeps its face and its
// name wherever it is standing.
import type { AgentInfo } from '../../shared/types';
import { titleOf } from '../../shared/types';
import { projectOf } from '../model/office';
import { projectName } from '../../shared/studio';
import { clip } from '../feed/feed';
import type { Workstation } from './OfficeScene';

export interface Spot { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

const TW = 32, TH = 16;   // iso tile on screen; kept in step with OfficeScene

/** Four walk cycles, one per isometric heading. The face comes with the body frame. */
export const WALK = {
  se: ['standFront', 'walkFront1', 'standFront', 'walkFront2'],
  sw: ['standFront2', 'walkFront3', 'standFront2', 'walkFront4'],
  ne: ['standAway', 'walkAway1', 'standAway', 'walkAway2'],
  nw: ['standAway2', 'walkAway3', 'standAway2', 'walkAway4'],
};
export const headingFor = (dx: number, dy: number) => (dy >= 0 ? (dx >= 0 ? WALK.se : WALK.sw) : (dx >= 0 ? WALK.ne : WALK.nw));

const SPEED = 26;          // px per second; a 16px person crossing a 1000px room
const STEP_MS = 190;       // how often the walk frame advances
const MAX_OUT = 4;         // any more and the office looks like a fire drill
const CHAT_DIST = 34;      // how close two of them have to be to talk

type Phase = 'out' | 'linger' | 'back' | 'reception' | 'goodbye' | 'door';

interface Roamer {
  st: Workstation;
  phase: Phase;
  path: Spot[];            // person positions to walk through, in order
  until: number;           // when lingering ends
  frame: number;
  nextStep: number;
  nextLine: number;
  door?: Spot;
  outside?: Spot;
  done?: () => void;
  speed?: number;
  startsAt?: number;
}

/** The person container's position when their feet are at a tile's centre. */
const standAt = (c: number, r: number): Spot => ({ x: (c - r) * (TW / 2) - 8, y: (c + r + 1) * (TH / 2) - 20 });
/** The tile a person is standing on, from their container position. */
const tileOf = (p: Spot) => { const fx = p.x + 8, fy = p.y + 20; return { c: Math.floor(fx / TW + fy / TH), r: Math.floor(fy / TH - fx / TW) }; };

export class Wander {
  private out: Roamer[] = [];
  private nextTry = 0;
  spots: Spot[] = [];
  private W = 0; private H = 0;
  private solid = new Uint8Array(0);

  constructor(private stations: () => Workstation[], private say: (st: Workstation, text: string) => void) {}

  /** Rebuild the floor grid: a tile is solid when its centre lies inside any footprint. */
  setGrid(W: number, H: number, footprints: Box[]) {
    this.W = W; this.H = H;
    this.solid = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const cx = (c - r) * (TW / 2), cy = (c + r + 1) * (TH / 2);
      if (footprints.some((b) => cx >= b.x && cx < b.x + b.w && cy >= b.y && cy < b.y + b.h)) this.solid[r * W + c] = 1;
    }
  }

  /** How much of the floor is walkable; for the debug page and tests. */
  get gridStats() { let n = 0; for (const v of this.solid) n += v; return { tiles: this.solid.length, solid: n }; }
  isFree(p: Spot) { const t = tileOf(p); return this.free(t.c, t.r); }

  private free(c: number, r: number) { return c >= 0 && r >= 0 && c < this.W && r < this.H && !this.solid[r * this.W + c]; }

  /** The nearest free tile to a point, searching outward a few rings; a seat sits inside its own
   *  desk's footprint, so the walk starts from the aisle beside it. */
  private nearestFree(p: Spot) {
    const t = tileOf(p);
    if (this.free(t.c, t.r)) return t;
    for (let d = 1; d <= 4; d++) for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++)
      if (Math.max(Math.abs(dr), Math.abs(dc)) === d && this.free(t.c + dc, t.r + dr)) return { c: t.c + dc, r: t.r + dr };
    return null;
  }

  /** A* over the four tile neighbours, which on screen are the four iso headings. */
  private route(a: { c: number; r: number }, b: { c: number; r: number }): { c: number; r: number }[] | null {
    const W = this.W, key = (c: number, r: number) => r * W + c;
    const h = (c: number, r: number) => Math.abs(c - b.c) + Math.abs(r - b.r);
    const g = new Map<number, number>([[key(a.c, a.r), 0]]);
    const from = new Map<number, number>();
    const open: { c: number; r: number; f: number }[] = [{ c: a.c, r: a.r, f: h(a.c, a.r) }];
    const closed = new Set<number>();
    while (open.length) {
      open.sort((p, q) => p.f - q.f);
      const cur = open.shift()!;
      const k = key(cur.c, cur.r);
      if (cur.c === b.c && cur.r === b.r) {
        const path = [{ c: cur.c, r: cur.r }];
        for (let at = k; from.has(at); ) { at = from.get(at)!; path.push({ c: at % W, r: Math.floor(at / W) }); }
        return path.reverse();
      }
      if (closed.has(k)) continue;
      closed.add(k);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = cur.c + dc, nr = cur.r + dr;
        if (!this.free(nc, nr)) continue;
        const nk = key(nc, nr), ng = g.get(k)! + 1;
        if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); from.set(nk, k); open.push({ c: nc, r: nr, f: ng + h(nc, nr) }); }
      }
      if (closed.size > 4000) return null;   // a room this big would be a bug, not a walk
    }
    return null;
  }

  /** Person positions from here to there: onto the grid, along the route, off at the far end. */
  pathTo(from: Spot, to: Spot): Spot[] | null {
    const a = this.nearestFree(from), b = this.nearestFree(to);
    if (!a || !b) return null;
    const r = this.route(a, b);
    if (!r) return null;
    // finish on the exact spot only if it is floor; a spot beside a friend can land on a table
    return [...r.map((t) => standAt(t.c, t.r)), ...(this.isFree(to) ? [to] : [])];
  }

  /** A new agent comes in through the entrance and walks to its desk, instead of appearing in
   *  its chair. The game's visitors do the same walk in reverse. */
  enter(st: Workstation, from: Spot, now: number) {
    if (this.out.some((r) => r.st === st)) return;
    const path = this.pathTo(from, st.seat);
    if (!path) return;
    st.place(from.x, from.y);
    this.out.push({ st, phase: 'back', path, until: 0, frame: 0, nextStep: now, nextLine: 0 });
  }

  /** Clock an agent out in view: leave the desk, stop at reception, then cross the doorway. */
  leave(st: Workstation, reception: Spot, door: Spot, outside: Spot, now: number, done: () => void, delay = 0) {
    const current = this.out.find((r) => r.st === st);
    if (current) this.out.splice(this.out.indexOf(current), 1);
    const from = st.away ? { x: st.person.x, y: st.person.y } : { ...st.seat };
    const path = this.pathTo(from, reception) ?? [reception];
    st.setStatus('idle', false);       // extinguish work effects; this walk owns the person now
    st.place(from.x, from.y);
    this.out.push({ st, phase: 'reception', path, until: 0, frame: 0, nextStep: now,
      nextLine: 0, door, outside, done, startsAt: now + delay,
      speed: Math.max(48, Math.min(110, path.reduce((d, p, i) => {
        const prev = path[i - 1] ?? from;
        return d + Math.hypot(p.x - prev.x, p.y - prev.y);
      }, 0) / 8)) });
  }

  /** Send everyone home and forget them; the room is about to be rebuilt. A departure interrupted
   *  by a structural rebuild must still release its retained model entry after the rebuild. */
  clear() {
    const finish = this.out.flatMap((r) => r.done ? [r.done] : []);
    for (const r of this.out) if (!r.done) r.st.sitAgain();
    this.out = [];
    for (const done of finish) queueMicrotask(done);
  }

  /** A cutscene has shown these actors crossing the door; release their office desks too. */
  finishDepartures(paneIds: Set<string>) {
    const finished = this.out.filter(r => r.done && r.st.agent && paneIds.has(r.st.agent.pane_id));
    this.out = this.out.filter(r => !finished.includes(r));
    for (const r of finished) r.done?.();
  }

  /** Off, nobody new gets up; whoever is out finishes their walk. */
  enabled = true;
  update(now: number, dt: number) {
    if (this.enabled) this.maybeSendSomeone(now);
    for (const r of [...this.out]) this.step(r, now, dt);
  }

  private maybeSendSomeone(now: number) {
    if (now < this.nextTry) return;
    this.nextTry = now + 2500 + Math.random() * 4000;
    if (!this.spots.length || !this.W || this.out.length >= MAX_OUT) return;
    const idle = this.stations().filter((st) => st.status === 'idle' && !st.away && st.agent);
    if (!idle.length || Math.random() > 0.55) return;
    const st = idle[Math.floor(Math.random() * idle.length)];
    // if somebody is already standing about, join them half the time — that is where talking
    // comes from; otherwise pick any spot a route exists to
    const mate = this.out.find((o) => o.phase === 'linger');
    let path: Spot[] | null = null;
    if (mate && Math.random() < 0.5) path = this.pathTo(st.seat, { x: mate.st.person.x + 22, y: mate.st.person.y + 6 });
    for (let i = 0; !path && i < 8; i++) path = this.pathTo(st.seat, this.spots[Math.floor(Math.random() * this.spots.length)]);
    if (!path) return;
    this.out.push({ st, phase: 'out', path, until: 0, frame: 0, nextStep: 0, nextLine: now + 1200 });
    st.place(st.seat.x, st.seat.y);   // stands up where they were sitting
  }

  private goHome(r: Roamer) {
    r.phase = 'back';
    r.path = this.pathTo(r.st.person, r.st.seat) ?? [r.st.seat];   // no route: cut straight across rather than strand them
  }

  private step(r: Roamer, now: number, dt: number) {
    const st = r.st;
    if (now < (r.startsAt ?? 0)) return;
    // work landed, or the desk emptied: go back to it
    const leaving = r.phase === 'reception' || r.phase === 'goodbye' || r.phase === 'door';
    if (st.status !== 'idle' && r.phase !== 'back' && !leaving) this.goHome(r);

    if (r.phase === 'goodbye') {
      if (now > r.until) {
        r.phase = 'door';
        r.path = this.pathTo(st.person, r.door!) ?? [r.door!];
        r.path.push(r.outside!);       // the final ungridded step carries them through the wall
      }
      return;
    }

    if (r.phase === 'linger') {
      const mate = this.out.find((o) => o !== r && o.phase === 'linger'
        && Math.hypot(o.st.person.x - st.person.x, o.st.person.y - st.person.y) < CHAT_DIST);
      if (mate) {
        // turn to face whoever they are talking to, and take it in turns
        const frames = headingFor(mate.st.person.x - st.person.x, mate.st.person.y - st.person.y);
        st.setPose(frames[0]);
        if (now > r.nextLine) { r.nextLine = now + 2600 + Math.random() * 2200; this.say(st, smalltalk(st.agent, mate.st.agent)); }
      }
      if (now > r.until) this.goHome(r);
      return;
    }

    let distance = ((r.speed ?? SPEED) * Math.min(dt, 100)) / 1000;
    while (distance > 0) {
      const target = r.path[0];
      if (!target) { this.arrive(r, now); return; }
      const dx = target.x - st.person.x, dy = target.y - st.person.y;
      const d = Math.hypot(dx, dy), move = Math.min(d, distance);
      if (d > 0) st.place(st.person.x + (dx / d) * move, st.person.y + (dy / d) * move);
      if (r.phase === 'door' && r.path.length === 1) {
        // The last step crosses into the dark doorway, beyond the visible office.
        st.person.setAlpha(Math.min(1, Math.hypot(target.x - st.person.x, target.y - st.person.y) / 12));
      }
      distance -= move;
      if (d > 0 && now > r.nextStep) {
        r.nextStep = now + (leaving ? 130 : STEP_MS);
        const frames = headingFor(dx, dy);
        st.setPose(frames[r.frame++ % frames.length]);
      }
      if (move < d) break;
      r.path.shift();
      if (!r.path.length) { this.arrive(r, now); return; }
    }
  }

  private arrive(r: Roamer, now: number) {
    if (r.phase === 'out') {
      r.phase = 'linger';
      r.until = now + 5000 + Math.random() * 7000;
      r.st.setPose(WALK.sw[0]);
    } else if (r.phase === 'reception') {
      r.phase = 'goodbye';
      r.until = now + 1400;
      r.st.setPose(WALK.ne[0]);
      this.say(r.st, 'bye!');
    } else if (r.phase === 'door') {
      r.st.person.setVisible(false);
      this.out.splice(this.out.indexOf(r), 1);
      r.done?.();
    } else {
      r.st.sitAgain();
      this.out.splice(this.out.indexOf(r), 1);
    }
  }
}

/** Two agents by the coffee table. Grounded in what they are actually working on, with just
 *  enough filler that it does not read like two status lines being shouted at each other. */
function smalltalk(me: AgentInfo | null, them: AgentInfo | null): string {
  const mine = me ? clip(titleOf(me), 28) : '';
  const theirs = them ? projectName(projectOf(them)) : '';
  const lines = [
    mine && `just wrapped ${mine}`,
    mine && `was on ${mine}`,
    theirs && `how's ${theirs} going?`,
    theirs && `you still on ${theirs}?`,
    'coffee?',
    'break time',
  ].filter(Boolean) as string[];
  return lines[Math.floor(Math.random() * lines.length)];
}
