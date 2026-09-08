import { describe, expect, test } from 'bun:test';
import { anchorsFor, seatSprites } from '../seats';
import { floorDepth, walkerDepth } from './depth';

// The same geometry OfficeScene and Wander use: 32x16 iso tiles, a desk's floor from anchor+10
// to anchor+44, a walker's foot point 20px below their container.
const TW = 32, TH = 16;
const iso = (c: number, r: number) => ({ x: (c - r) * TW / 2, y: (c + r) * TH / 2 });
const bank = (pairs: number) => anchorsFor(pairs).map(a => ({ ax: iso(3, 3).x + a.x, ay: iso(3, 3).y + a.y, mirror: a.mirror }));
const floorBox = (s: { ax: number; ay: number }) => ({ x: s.ax - 4, y: s.ay + 10, w: 58, h: 34 });
const inside = (px: number, py: number, b: { x: number; y: number; w: number; h: number }) => px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;

describe('floor depth convention', () => {
  test('a desk keys off its seat anchor, as the game sorts', () => {
    expect(floorDepth(100 + 10)).toBe(1000);
  });

  test('walkers on the free tile row behind a desk sort behind it, rows in front sort in front', () => {
    const seats = bank(2), boxes = seats.map(floorBox);
    let behind = 0, ahead = 0;
    for (let r = 0; r < 24; r++) for (let c = 0; c < 24; c++) {
      const cx = (c - r) * TW / 2, cy = (c + r + 1) * TH / 2;      // tile centre = foot point
      if (boxes.some(b => inside(cx, cy, b))) continue;             // not walkable
      const depth = walkerDepth(cy - 20);
      for (const s of seats) {
        if (cx < s.ax - 4 || cx >= s.ax + 54) continue;             // not in the desk's column
        const deskDepth = s.ay * 10 + seatSprites(s.mirror).desk.sort;
        if (cy < s.ay + 10) { expect(depth).toBeLessThan(deskDepth); behind++; }
        if (cy >= s.ay + 44) { expect(depth).toBeGreaterThan(deskDepth); ahead++; }
      }
    }
    expect(behind).toBeGreaterThan(0); expect(ahead).toBeGreaterThan(0);
  });

  test('a far-row occupant standing at their seat stays behind the desk and monitor', () => {
    const [seat] = bank(1);
    const sp = seatSprites(true);
    const standing = seat.ay * 10 + sp.person.sort;   // place() keeps the seat order inside the desk's floor
    expect(standing).toBeLessThan(seat.ay * 10 + sp.desk.sort);
    expect(standing).toBeLessThan(seat.ay * 10 + sp.pc.sort);
    expect(standing).toBeGreaterThan(seat.ay * 10 + sp.chair.sort);
    // and the first step up and away, out of the floor box, sorts behind everything on the desk
    const off = walkerDepth(seat.ay - 11);
    expect(off).toBeLessThan(seat.ay * 10 + sp.chair.sort);
  });

  test('props: the row just below the footprint is in front, the row just above is behind', () => {
    const base = 200, prop = floorDepth(base - 12) - 1;   // footprint base-12 .. base+2
    expect(walkerDepth(base + 3 - 20)).toBeGreaterThan(prop);
    expect(walkerDepth(base - 13 - 20)).toBeLessThan(prop);
  });
});
