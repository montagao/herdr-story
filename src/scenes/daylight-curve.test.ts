import { expect, test } from 'bun:test';
import { daylight, hourOf, hourOverride, shade, skyAt } from './daylight-curve';

test('noon leaves the room alone and midnight is the full night', () => {
  expect(daylight(12)).toEqual({ tint: 0xffffff, night: 0, sky: 0xffffff, skyMix: 0 });
  expect(daylight(0)).toEqual({ tint: 0x6e7fc2, night: 1, sky: 0x16224a, skyMix: 0.92 });
  expect(daylight(24)).toEqual(daylight(0));
  expect(daylight(-1)).toEqual(daylight(23));
});
test('dusk warms before it darkens, and the night comes on smoothly', () => {
  const late = daylight(18.5), evening = daylight(19.25), night = daylight(20);
  expect(late.tint).toBe(0xffb98a); expect(late.night).toBeCloseTo(0.45);
  expect(evening.night).toBeGreaterThan(late.night); expect(evening.night).toBeLessThan(night.night);
  expect((evening.tint >> 16) & 0xff).toBeLessThan(0xff); expect((evening.tint >> 16) & 0xff).toBeGreaterThan(0x6e);
  expect(night.night).toBe(1);
});
test('the sky keeps the theme blue by day and goes to sunset, then night', () => {
  expect(skyAt(0x62f5ff, daylight(12))).toBe(0x62f5ff);
  const dusk = skyAt(0x62f5ff, daylight(18.5)), night = skyAt(0x62f5ff, daylight(22));
  expect((dusk >> 16) & 0xff).toBeGreaterThan(dusk & 0xff);          // red over blue at sunset
  expect(night & 0xff).toBeGreaterThan((night >> 16) & 0xff);        // blue over red at night
  expect(night & 0xff).toBeLessThan(0x70);                            // and dark
  expect(shade(0x62f5ff, 0xffffff)).toBe(0x62f5ff);
  expect(shade(0x62f5ff, 0x6e7fc2)).toBe(0x2a7ac2);
  expect(shade(0xffffff, 0x000000)).toBe(0);
});
test('the clock is fractional, and ?hour= pins it in either notation', () => {
  expect(hourOf(new Date(2026, 8, 7, 19, 30, 0))).toBeCloseTo(19.5);
  expect(hourOverride('?hour=19.5')).toBe(19.5);
  expect(hourOverride('?demo=1&hour=07:15')).toBeCloseTo(7.25);
  expect(hourOverride('?hour=25')).toBeUndefined();
  expect(hourOverride('?hour=soon')).toBeUndefined();
  expect(hourOverride('?demo=1')).toBeUndefined();
});
