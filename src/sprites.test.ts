import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BODY_COUNT, BODY_POSE, FACE, FACE_COUNT, FACE_H, FACE_W, OUTFIT_COUNT, SHORT_BODY, SHORT_BODY_STANDIN, wearableBody } from './sprites';

/** Sheet size straight out of the PNG header: 8-byte signature, length and 'IHDR', then w and h. */
function sheetSize(path: string) {
  const png = readFileSync(new URL(`../public/assets/gds/${path}`, import.meta.url));
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

// body25 is 65px wide where the rest are 102: it stops after the stand and walk columns, so the
// seated, cheering and collapsed poses all read past its right edge and draw nothing. That is what
// left a working agent's face burning away over an empty chair, so no outfit may be short again.
test('every outfit an agent can be given carries every pose the office draws', () => {
  const missing: string[] = [];
  for (let i = 0; i < BODY_COUNT; i++) {
    const body = wearableBody(i), sheet = sheetSize(`body/body${body}.png`);
    for (const [name, p] of Object.entries(BODY_POSE))
      if (p.x + p.w > sheet.w || p.y + p.h > sheet.h) missing.push(`body${body} has no ${name}`);
  }
  expect(missing).toEqual([]);
});

test('every portrait sheet carries every face cell', () => {
  for (let i = 0; i < FACE_COUNT; i++) {
    const sheet = sheetSize(`face/face_${i}.png`);
    for (const [col, row] of Object.values(FACE)) {
      expect((col + 1) * FACE_W).toBeLessThanOrEqual(sheet.w);
      expect((row + 1) * FACE_H).toBeLessThanOrEqual(sheet.h);
    }
  }
});

test('the short body sheet is swapped out and never offered as an outfit', () => {
  expect(sheetSize(`body/body${SHORT_BODY}.png`).w).toBeLessThan(sheetSize('body/body0.png').w);
  expect(wearableBody(SHORT_BODY)).toBe(SHORT_BODY_STANDIN);
  for (let i = 0; i < BODY_COUNT; i++) if (i !== SHORT_BODY) expect(wearableBody(i)).toBe(i);
  expect(OUTFIT_COUNT).toBeLessThanOrEqual(SHORT_BODY);
});
