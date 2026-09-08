import { expect, test } from 'bun:test';
import { CHAIR_TIERS, DESK_TIERS, SEAT_TEXTURES, chairFor, deskFor, seatSprites } from './seats';

test('furniture climbs with level and never skips a tier on the way up', () => {
  expect(chairFor(1)).toBe('chair_000'); expect(chairFor(2)).toBe('chair_000');
  expect(chairFor(3)).toBe('chair_002'); expect(chairFor(8)).toBe('chair_019');
  expect(chairFor(12)).toBe('chair_023'); expect(chairFor(40)).toBe('chair_029');
  expect(deskFor(1)).toBe('desk_000'); expect(deskFor(4)).toBe('desk_002'); expect(deskFor(9)).toBe('desk_022');
  expect(chairFor(0)).toBe('chair_000');
  for (const tiers of [CHAIR_TIERS, DESK_TIERS]) for (let i = 1; i < tiers.length; i++) expect(tiers[i][0]).toBeGreaterThan(tiers[i - 1][0]);
});
test('a seat is dressed for its level on both sides of the bank', () => {
  const near = seatSprites(false, 9), far = seatSprites(true, 9), fresh = seatSprites(false);
  expect(near.chair.key).toBe('chair_022'); expect(near.chairFront?.key).toBe('chair_022'); expect(near.desk.key).toBe('desk_022');
  expect(far.chair.key).toBe('chair_022'); expect(far.desk.key).toBe('desk_022'); expect(far.chairFront).toBeUndefined();
  expect(fresh.chair.key).toBe('chair_000'); expect(fresh.desk.key).toBe('desk_000');
  expect(SEAT_TEXTURES.chairs).toContain('chair_029'); expect(SEAT_TEXTURES.desks).toContain('desk_000');
});
