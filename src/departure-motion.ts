// A short lobby procession. Every selected agent gets a full walk, even in a large group.
const ROUTE = [{ x: -18, y: 74 }, { x: 92, y: 129 }, { x: 186, y: 82 }, { x: 210, y: 94 }];
const WALK = [
  ['standFront', 'walkFront1', 'standFront', 'walkFront2'],
  ['standAway', 'walkAway1', 'standAway', 'walkAway2'],
  ['standFront', 'walkFront1', 'standFront', 'walkFront2'],
];
const SPEED = 54, GAP = 680, WAVE = 650;
const lengths = ROUTE.slice(1).map((p, i) => Math.hypot(p.x - ROUTE[i].x, p.y - ROUTE[i].y));
export const departureDuration = (count: number) => Math.max(0, count - 1) * GAP + lengths.reduce((a, b) => a + b, 0) / SPEED * 1000 + WAVE;

export function departurePose(elapsed: number, index: number) {
  let time = elapsed - index * GAP;
  const base = { ...ROUTE[0], frame: 'standFront', visible: time >= 0, finished: false, alpha: 1, waving: false };
  if (time < 0) return base;
  for (let leg = 0; leg < lengths.length; leg++) {
    const ms = lengths[leg] / SPEED * 1000;
    if (time < ms) {
      const a = ROUTE[leg], b = ROUTE[leg + 1], t = time / ms;
      return { ...base, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
        frame: WALK[leg][Math.floor(time / 140) % 4], alpha: leg === 2 ? Math.min(1, (1 - t) * 3) : 1 };
    }
    time -= ms;
    if (leg === 0) {
      if (time < WAVE) return { ...base, ...ROUTE[1], frame: 'cheer', waving: true };
      time -= WAVE;
    }
  }
  return { ...base, ...ROUTE.at(-1)!, visible: false, finished: true, alpha: 0 };
}
