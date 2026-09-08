import { expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, Settings, clockLabel, readSettings } from './settings';

class Memory { data = new Map<string, string>(); getItem(k: string) { return this.data.get(k) ?? null; } setItem(k: string, v: string) { this.data.set(k, v); } }

test('anything saved becomes a full, sane settings object', () => {
  expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
  expect(readSettings('{not json')).toEqual(DEFAULT_SETTINGS);
  expect(readSettings(JSON.stringify({ followDay: false, hour: 30, nameTags: 'sometimes', music: 4, effects: -1, wander: 'no' })))
    .toEqual({ ...DEFAULT_SETTINGS, followDay: false, hour: 24, music: 1, effects: 0 });
  expect(readSettings(JSON.stringify({ nameTags: 'always', lowPower: true, hour: 19.5 }))).toMatchObject({ nameTags: 'always', lowPower: true, hour: 19.5 });
});
test('a change is saved, announced once, and ignored when nothing changed', () => {
  const store = new Memory(), settings = new Settings(store);
  expect(settings.stored).toBe(false);
  const seen: number[] = [];
  const stop = settings.on(v => seen.push(v.hour));
  settings.set({ hour: 19.5, followDay: false });
  settings.set({ hour: 19.5 });
  expect(seen).toEqual([19.5]);
  expect(new Settings(store).value).toMatchObject({ hour: 19.5, followDay: false });
  expect(new Settings(store).stored).toBe(true);
  stop(); settings.set({ hour: 8 });
  expect(seen).toEqual([19.5]);
});
test('the fixed light reads as a clock', () => {
  expect(clockLabel(0)).toBe('12:00 AM'); expect(clockLabel(19.5)).toBe('7:30 PM'); expect(clockLabel(12)).toBe('12:00 PM'); expect(clockLabel(24)).toBe('12:00 AM');
});
