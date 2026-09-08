import { describe, expect, test } from 'bun:test';
import { RenderBudget } from './render-budget';

describe('office render budget', () => {
  test('idle rendering halves work without slowing a delta-driven actor', () => {
    let now = 0, frames = 0, distance = 0;
    const budget = new RenderBudget((_time, delta) => { frames++; distance += 80 * delta / 1000; }, () => now);
    for (let i = 1; i <= 121; i++) { now = i * 1000 / 60; budget.step(now, 1000 / 60); }
    expect(frames).toBe(61);
    expect(distance).toBeCloseTo(80 * 121 / 60, 6);
  });

  test('interaction draws immediately and returns to idle after the activity deadline', () => {
    let now = 0, frames = 0;
    const budget = new RenderBudget(() => frames++, () => now);
    budget.step(now, 16);
    now = 16; budget.boost(100); budget.step(now, 16);
    expect(frames).toBe(2);
    expect(budget.fps).toBe(60);
    now = 117; expect(budget.fps).toBe(30);
  });

  test('resume does not replay a hidden tab interval', () => {
    let now = 0; const deltas: number[] = [];
    const budget = new RenderBudget((_time, delta) => deltas.push(delta), () => now);
    now = 16; budget.step(now, 16);
    now = 32; budget.step(now, 16);
    budget.reset();
    now = 10000; budget.step(now, 16);
    expect(deltas).toEqual([16, 16]);
  });

  test('uneven native frames preserve simulation time across repeated rate changes', () => {
    let now = 0, simulation = 0;
    const budget = new RenderBudget((_time, delta) => simulation += delta, () => now);
    for (let i = 0; i < 100; i++) {
      const delta = i % 2 ? 20 : 13; now += delta;
      if (i % 9 === 0) budget.boost(35);
      budget.step(now, delta);
    }
    now += 40; budget.step(now, 40);
    expect(simulation).toBeCloseTo(now, 6);
  });

  test('continuous interaction remains capped on a high-refresh display', () => {
    let now = 0, frames = 0;
    const budget = new RenderBudget(() => { frames++; budget.boost(); }, () => now);
    budget.boost();
    for (let i = 1; i <= 120; i++) { now = i * 1000 / 120; budget.step(now, 1000 / 120); }
    expect(frames).toBe(60);
  });
});
