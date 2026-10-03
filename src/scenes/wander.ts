// Idle agents get up and walk around — on the floor grid, around the furniture.
//
// A room where thirty of thirty-one agents sit perfectly still reads as a screenshot, not an
// office. So an idle agent occasionally leaves its desk, walks to a table or a plant, stands
// around for a bit — chatting if someone else is already there — and walks back. Anything that is
// not idle stays at its desk, and an agent that gets work while it is out hurries straight back.
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
import { reducedMotion } from '../motion';
import type { Workstation } from './OfficeScene';

export interface Spot { x: number; y: number }
/** Somewhere to stand about, and what it is in front of when that is worth a remark. */
export interface Hangout extends Spot { kind?: string }
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
const HURRY = 64;          // back to a desk where work has just landed
const STEP_MS = 190;       // how often the walk frame advances
const BRISK_MS = 130;      // and at anything faster than a stroll
const MAX_OUT = 4;         // any more and the office looks like a fire drill
const CHAT_DIST = 34;      // how close two of them have to be to talk
const REPLY_MS = 3400;     // a line stays up for 2.8s; the answer waits for it to clear, and a breath

type Phase = 'out' | 'linger' | 'back' | 'sit' | 'reception' | 'goodbye' | 'door';

interface Roamer {
  st: Workstation;
  phase: Phase;
  path: Spot[];            // person positions to walk through, in order
  until: number;           // when lingering, the goodbye or the beat before sitting ends
  frame: number;
  nextStep: number;
  nextLine: number;
  /** The walk cycle in use, so a corner turns them at once rather than at the next footfall. */
  heading?: string[];
  /** The last thing they said to a friend, so the next line is a different one. */
  lastLine?: string;
  /** Standing alone: when the stance next changes, and whether a hand is up. */
  nextStance?: number;
  handUp?: boolean;
  /** Something to say to themselves about whatever they stopped at. */
  remark?: string;
  /** Where a newcomer stepped onto the landing; they come into view over their first steps. */
  from?: Spot;
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
/** How far a walk is, from where it starts through every point of its path. */
const lengthOf = (from: Spot, path: Spot[]) => path.reduce((d, p, i) => { const prev = path[i - 1] ?? from; return d + Math.hypot(p.x - prev.x, p.y - prev.y); }, 0);

export class Wander {
  private out: Roamer[] = [];
  private nextTry = 0;
  /** Every deadline here is kept on this clock, which only runs while the floor does. Scene time
   *  follows the wall clock and leaps across a sleeping loop (any window sleeps it), so deadlines
   *  kept in it all came due on the frame the window closed, and the whole floor set off at once. */
  private clock = 0;
  spots: Hangout[] = [];
  /** Out on the landing, when the scene has one: newcomers start there instead of at the door. */
  landing?: Spot;
  /** Someone leaving has stopped at the counter to say goodbye. */
  onGoodbye?: (st: Workstation) => void;
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

  /** The nearest free tile to a point, a few tiles around; a seat sits inside its own desk's
   *  footprint, so the walk starts from the aisle beside it. Nearest on screen, not first in tile
   *  order: that sent the near row sideways through a neighbour's chair to reach the floor. */
  private nearestFree(p: Spot) {
    const t = tileOf(p);
    if (this.free(t.c, t.r)) return t;
    let best: { c: number; r: number } | null = null, least = Infinity;
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
      const c = t.c + dc, r = t.r + dr;
      if (!this.free(c, r)) continue;
      const at = standAt(c, r), d = Math.hypot(at.x - p.x, at.y - p.y);
      if (d < least) { least = d; best = { c, r }; }
    }
    return best;
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

  /** The way back to a chair: along the floor to the aisle beside the desk, then one last step
   *  off the grid into the seat, the way the door walk ends on the landing. Most seats stand on
   *  their own desk's footprint, and stopping at the nearest floor tile left the sitter to blink
   *  the rest of the way. place() keeps the desk's draw order for that step (see depth.ts). */
  private wayHome(from: Spot, st: Workstation) {
    const path = this.pathTo(from, st.seat);
    if (path && !this.isFree(st.seat)) path.push({ ...st.seat });
    return path;
  }

  /** A new agent comes in through the entrance and walks to its desk, instead of appearing in
   *  its chair: over the landing where there is one, fading in the way a leaver fades out, and at
   *  a pace that has them seated in a few seconds however big the room. The game's visitors do
   *  the same walk in reverse. The floor keeps its own clock now, so the scene's is not used. */
  enter(st: Workstation, door: Spot, _now?: number) {
    if (reducedMotion() || this.out.some((r) => r.st === st)) return;
    const home = this.wayHome(door, st);
    if (!home) return;
    const from = this.landing ?? door, path = this.landing ? [door, ...home] : home;
    st.place(from.x, from.y);
    if (this.landing) st.person.setAlpha(0);
    this.out.push({ st, phase: 'back', path, until: 0, frame: 0, nextStep: 0, nextLine: 0,
      from: this.landing, speed: Math.max(40, Math.min(90, lengthOf(from, path) / 7)) });
  }

  /** Clock an agent out in view: leave the desk, stop at reception, then cross the doorway. As
   *  with enter, the caller's scene time is no longer what the walk is timed by. */
  leave(st: Workstation, reception: Spot, door: Spot, outside: Spot, _now: number, done: () => void, delay = 0) {
    const current = this.out.find((r) => r.st === st);
    if (current) this.out.splice(this.out.indexOf(current), 1);
    const from = st.away ? { x: st.person.x, y: st.person.y } : { ...st.seat };
    const path = this.pathTo(from, reception) ?? [reception];
    st.setStatus('idle', false);       // extinguish work effects; this walk owns the person now
    st.place(from.x, from.y);
    st.person.setAlpha(1);             // someone still fading in at the door turns round in full view
    this.out.push({ st, phase: 'reception', path, until: 0, frame: 0, nextStep: 0,
      nextLine: 0, door, outside, done, startsAt: this.clock + delay,
      speed: Math.max(48, Math.min(110, lengthOf(from, path) / 8)) });
  }

  /** Send everyone home and forget them; the room is about to be rebuilt. A departure interrupted
   *  by a structural rebuild must still release its retained model entry after the rebuild. */
  clear() {
    const finish = this.out.flatMap((r) => r.done ? [r.done] : []);
    for (const r of this.out) if (!r.done) { r.st.person.setAlpha(1); r.st.sitAgain(); }
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
  update(_time: number, dt: number) {
    const now = this.clock += dt;
    if (this.enabled) this.maybeSendSomeone(now);
    for (const r of [...this.out]) this.step(r, now, dt);
  }

  private maybeSendSomeone(now: number) {
    if (now < this.nextTry) return;
    this.nextTry = now + 2500 + Math.random() * 4000;
    if (!this.spots.length || !this.W || this.out.length >= MAX_OUT || reducedMotion()) return;
    const idle = this.stations().filter((st) => st.status === 'idle' && !st.away && st.agent);
    if (!idle.length || Math.random() > 0.55) return;
    const st = idle[Math.floor(Math.random() * idle.length)];
    // if somebody is already standing about, join them half the time, on whichever side of them
    // is free — that is where talking comes from; otherwise pick any spot a route exists to that
    // nobody else has taken
    const mate = this.out.find((o) => o.phase === 'linger');
    const taken = (p: Spot) => this.out.some((o) => {
      const at = (o.phase === 'out' && o.path.at(-1)) || o.st.person;
      return Math.hypot(at.x - p.x, at.y - p.y) < 12;
    });
    let path: Spot[] | null = null, spot: Hangout | undefined;
    if (mate && Math.random() < 0.5) {
      const beside = [22, -22].map((dx) => ({ x: mate.st.person.x + dx, y: mate.st.person.y + 6 })).find((p) => !taken(p));
      if (beside) path = this.pathTo(st.seat, beside);
    }
    for (let i = 0; !path && i < 8; i++) {
      spot = this.spots[Math.floor(Math.random() * this.spots.length)];
      path = taken(spot) ? null : this.pathTo(st.seat, spot);
    }
    if (!path) return;
    // once in a while they have a word for whatever they went to look at
    const remarks = MUSINGS[spot?.kind ?? ''];
    this.out.push({ st, phase: 'out', path, until: 0, frame: 0, nextStep: 0, nextLine: 0,
      remark: remarks && Math.random() < 0.34 ? remarks[Math.floor(Math.random() * remarks.length)] : undefined });
    st.place(st.seat.x, st.seat.y);   // stands up where they were sitting
  }

  private goHome(r: Roamer) {
    r.phase = 'back';
    r.path = this.wayHome(r.st.person, r.st) ?? [{ ...r.st.seat }];   // no route: cut straight across rather than strand them
  }

  /** Whoever is standing about within talking distance, or within `reach`. */
  private near(r: Roamer, reach = CHAT_DIST) {
    const at = r.st.person;
    return this.out.filter((o) => o !== r && o.phase === 'linger' && Math.hypot(o.st.person.x - at.x, o.st.person.y - at.y) < reach);
  }
  /** A line is going up here: nobody around the same spot speaks until it has had `ms`. Wider
   *  than talking distance, because two people either side of a third are in one conversation. */
  private hush(r: Roamer, now: number, ms: number) {
    for (const o of this.near(r, CHAT_DIST * 2)) o.nextLine = Math.max(o.nextLine, now + ms);
  }

  private step(r: Roamer, now: number, dt: number) {
    const st = r.st;
    if (now < (r.startsAt ?? 0)) return;
    // work landed, or the desk emptied: go back to it
    const leaving = r.phase === 'reception' || r.phase === 'goodbye' || r.phase === 'door';
    if (st.status !== 'idle' && r.phase !== 'back' && r.phase !== 'sit' && !leaving) this.goHome(r);

    if (r.phase === 'sit') {
      if (now > r.until) { st.sitAgain(); this.out.splice(this.out.indexOf(r), 1); }
      return;
    }

    if (r.phase === 'goodbye') {
      // a wave on the way out: the game's hand-to-the-head frame, up and down
      st.setPose(Math.floor((r.until - now) / 200) % 2 ? 'standIdle' : 'standIdle2');
      if (now > r.until) {
        r.phase = 'door';
        r.path = this.pathTo(st.person, r.door!) ?? [r.door!];
        r.path.push(r.outside!);       // the final ungridded step carries them through the wall
      }
      return;
    }

    if (r.phase === 'linger') {
      const mates = this.near(r);
      if (mates.length) {
        // turn to face whoever they are talking to, and take it in turns: a line goes up, and
        // nobody in earshot answers until it has come down again
        const mate = mates[0];
        st.setPose(headingFor(mate.st.person.x - st.person.x, mate.st.person.y - st.person.y)[0]);
        if (now > r.nextLine) {
          this.say(st, r.lastLine = smalltalk(st.agent, mate.st.agent, r.lastLine));
          r.nextLine = now + 5600 + Math.random() * 2000;
          this.hush(r, now, REPLY_MS + Math.random() * 500);
        }
      } else if (now > (r.nextStance ?? 0)) {
        // alone: the game's own standing-idle stance, with a hand to the head now and then
        if (r.remark) { this.say(st, r.remark); r.remark = undefined; }
        r.handUp = !r.handUp;
        st.setPose(r.handUp ? 'standIdle2' : 'standIdle');
        r.nextStance = now + (r.handUp ? 600 : 2500 + Math.random() * 1500);
      }
      if (now > r.until) this.goHome(r);
      return;
    }

    const speed = r.speed ?? (r.phase === 'back' && st.status !== 'idle' ? HURRY : SPEED);
    let distance = (speed * Math.min(dt, 100)) / 1000;
    while (distance > 0) {
      const target = r.path[0];
      if (!target) { this.arrive(r, now); return; }
      const dx = target.x - st.person.x, dy = target.y - st.person.y;
      const d = Math.hypot(dx, dy), move = Math.min(d, distance);
      if (d > 0) st.place(st.person.x + (dx / d) * move, st.person.y + (dy / d) * move);
      if (r.from) {
        const seen = Math.hypot(st.person.x - r.from.x, st.person.y - r.from.y) / 12;
        st.person.setAlpha(Math.min(1, seen));
        if (seen >= 1) r.from = undefined;
      }
      if (r.phase === 'door' && r.path.length === 1) {
        // The last step crosses into the dark doorway, beyond the visible office.
        st.person.setAlpha(Math.min(1, Math.hypot(target.x - st.person.x, target.y - st.person.y) / 12));
      }
      distance -= move;
      if (d > 0) {
        const frames = headingFor(dx, dy);
        // a corner: face the new way now, on the same foot, instead of sliding sideways until the next step
        if (frames !== r.heading) { if (r.heading) st.setPose(frames[(r.frame + frames.length - 1) % frames.length]); r.heading = frames; }
        if (now > r.nextStep) {
          r.nextStep = now + (speed > SPEED ? BRISK_MS : STEP_MS);
          st.setPose(frames[r.frame++ % frames.length]);
        }
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
      r.nextStance = now + 1200; r.handUp = true;
      // whoever walks up speaks first, once they have stopped; the one already there answers
      r.nextLine = now + 500;
      this.hush(r, now, 500 + REPLY_MS);
    } else if (r.phase === 'reception') {
      r.phase = 'goodbye';
      r.until = now + 1400;
      this.say(r.st, 'bye!');
      this.onGoodbye?.(r.st);
    } else if (r.phase === 'door') {
      r.st.person.setVisible(false);
      this.out.splice(this.out.indexOf(r), 1);
      r.done?.();
    } else {
      // one beat on their feet, facing the desk, rather than dropping into the chair mid-stride
      r.phase = 'sit';
      r.until = now + 140;
      r.st.setPose(r.st.pose.stand);
    }
  }
}

/** What someone says to themselves in front of a piece of furniture. */
const MUSINGS: Record<string, string[]> = {
  plant: ['needs water?', 'new leaf!'],
  whiteboard: ['big plans', 'so many goals'],
  cabinet: ['filing...'],
  trophy: ['shiny...'],
  machine: ['beep boop'],
  table: ['coffee...', 'snack time'],
  bench: ['five minutes'],
  sign: ['any news?'],
  boss: ['morning, boss'],
};

/** Two agents by the coffee table. Grounded in what they are actually working on, with just
 *  enough filler that it does not read like two status lines being shouted at each other. Never
 *  the line they said last. */
function smalltalk(me: AgentInfo | null, them: AgentInfo | null, last?: string): string {
  const mine = me ? clip(titleOf(me), 28) : '';
  const theirs = them ? projectName(projectOf(them)) : '';
  const lines = [
    mine && `just wrapped ${mine}`,
    mine && `was on ${mine}`,
    theirs && `how's ${theirs} going?`,
    theirs && `you still on ${theirs}?`,
    'coffee?',
    'break time',
  ].filter((line) => line && line !== last) as string[];
  return lines[Math.floor(Math.random() * lines.length)];
}
