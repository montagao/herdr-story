/** The office's day, as a colour the room is multiplied by and how much the screens glow. Noon
 *  is untouched; dawn and dusk warm the room; night cools and darkens it. Hours are local and
 *  fractional, so the light slides rather than steps. Pure, for tests and for the recorder. */
export interface Light { tint: number; night: number; sky: number; skyMix: number }
const DAY = 0xffffff, DAWN = 0xffd9bc, DUSK = 0xffb98a, NIGHT = 0x6e7fc2;
/** The sky keeps its own colours: a multiplied daytime blue goes green at sunset, not orange. */
const DAWN_SKY = 0xffc9a8, DUSK_SKY = 0xf59a6a, NIGHT_SKY = 0x16224a;
/** Keyframes by hour: the room's tint, how much of the night's glow is on, and the sky. */
const KEYS: [hour: number, tint: number, night: number, sky: number, skyMix: number][] = [
  [0, NIGHT, 1, NIGHT_SKY, 0.92], [5, NIGHT, 1, NIGHT_SKY, 0.92], [6.5, DAWN, 0.45, DAWN_SKY, 0.6], [8, DAY, 0, DAY, 0],
  [17, DAY, 0, DAY, 0], [18.5, DUSK, 0.45, DUSK_SKY, 0.75], [20, NIGHT, 1, NIGHT_SKY, 0.92], [24, NIGHT, 1, NIGHT_SKY, 0.92],
];
const channel = (c: number, shift: number) => (c >> shift) & 0xff;
function mix(a: number, b: number, t: number) {
  const lerp = (shift: number) => Math.round(channel(a, shift) + (channel(b, shift) - channel(a, shift)) * t);
  return (lerp(16) << 16) | (lerp(8) << 8) | lerp(0);
}
export function daylight(hour: number): Light {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < KEYS.length; i++) {
    const [h0, tint0, night0, sky0, mix0] = KEYS[i - 1], [h1, tint1, night1, sky1, mix1] = KEYS[i];
    if (h > h1) continue;
    const t = h1 === h0 ? 0 : (h - h0) / (h1 - h0);
    return { tint: mix(tint0, tint1, t), night: night0 + (night1 - night0) * t, sky: mix(sky0, sky1, t), skyMix: mix0 + (mix1 - mix0) * t };
  }
  return { tint: NIGHT, night: 1, sky: NIGHT_SKY, skyMix: 0.92 };
}
/** The sky over the office at this light: the theme's own blue, drawn toward sunset or night. */
export function skyAt(themeSky: number, light: Light) { return mix(themeSky, light.sky, light.skyMix); }
/** Multiply one colour by another, as the overlay does to the room, for the sky behind it. */
export function shade(colour: number, tint: number) {
  const mul = (shift: number) => Math.round(channel(colour, shift) * channel(tint, shift) / 255);
  return (mul(16) << 16) | (mul(8) << 8) | mul(0);
}
export function hourOf(now: Date) { return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600; }
/** `?hour=19.5` or `?hour=19:30` fixes the office's clock; anything else leaves it on local time. */
export function hourOverride(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('hour');
  if (!raw) return undefined;
  const clock = /^(\d{1,2}):(\d{2})$/.exec(raw);
  const value = clock ? Number(clock[1]) + Number(clock[2]) / 60 : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 24 ? value : undefined;
}
