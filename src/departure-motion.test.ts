import { expect, test } from 'bun:test';
import { departureDuration, departurePose } from './departure-motion';

test('every actor walks into view, waves, crosses the threshold and finishes', () => {
  for (const index of [0, 1, 25, 49]) {
    const steps = Array.from({ length: Math.ceil(departureDuration(50) / 40) + 2 }, (_, n) => departurePose(n * 40, index));
    expect(steps.some(p => p.visible && p.x > 20 && p.frame.startsWith('walk'))).toBe(true);
    expect(steps.some(p => p.visible && p.waving)).toBe(true);
    expect(steps.some(p => p.visible && p.x > 199 && p.alpha < 1)).toBe(true);
    expect(steps.at(-1)?.finished).toBe(true);
    expect(steps.at(-1)?.visible).toBe(false);
  }
  expect(departureDuration(50)).toBeLessThan(40_000);
});

test('departures are staggered and only complete after each full walk', () => {
  expect(departurePose(0, 1).visible).toBe(false);
  const firstDone = departureDuration(1) + 1;
  expect(departurePose(firstDone, 0).finished).toBe(true);
  expect(departurePose(firstDone, 1).finished).toBe(false);
  expect(departurePose(departureDuration(2) + 1, 1).finished).toBe(true);
});
