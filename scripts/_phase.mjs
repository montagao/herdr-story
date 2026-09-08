import { chromium } from 'playwright';
import fs from 'node:fs';
const exe = fs.readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort()
  .map((d) => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto('http://localhost:5173/?zoom=2', { waitUntil: 'load' });
await p.waitForTimeout(4000);
await p.evaluate(() => {
  const sc = window.hs.game.scene.getScene('office');
  // the drawn boxes of every cluster, recomputed the way buildRoom does
  const mod = window.__boxes = [];
  for (const pl of sc.placed) { const pairs = Math.max(1, Math.ceil(pl.pod.seats.length / 4)); const ac = 3 + pl.col * 8, ar = 3 + pl.row * 8; const a = { x: (ac - ar) * 16, y: (ac + ar) * 8 }; mod.push({ x: a.x - 6, y: a.y + 2 - 36 * (pairs - 1), w: 112 + 72 * (pairs - 1), h: 90 + 36 * (pairs - 1) }); }
  // bump the odds: send four out right away
  const w = sc.wander; w.nextTry = 0;
});
const hits = []; let shots = 0;
for (let i = 0; i < 400; i++) {
  await p.waitForTimeout(150);
  const r = await p.evaluate(() => {
    const sc = window.hs.game.scene.getScene('office'), w = sc.wander;
    return w.out.map((o) => { const fx = o.st.person.x + 8, fy = o.st.person.y + 20; const fromSeat = Math.hypot(o.st.person.x - o.st.seat.x, o.st.person.y - o.st.seat.y);
      const inBox = window.__boxes.some((b) => fx > b.x && fx < b.x + b.w && fy > b.y && fy < b.y + b.h);
      return { pane: o.st.agent?.pane_id, phase: o.phase, left: o.path.length, fromSeat: Math.round(fromSeat), inBox, free: w.isFree(o.st.person), x: o.st.person.x, y: o.st.person.y }; });
  });
  for (const o of r) if (o.inBox && o.fromSeat > 30) {
    hits.push(o);
    if (shots < 3) { await p.evaluate(([x, y]) => window.hs.game.scene.getScene('office').cameras.main.centerOn(x, y), [o.x, o.y]); await p.waitForTimeout(60); await p.screenshot({ path: `/tmp/phase${shots}.png` }); shots++; console.log('offender:', JSON.stringify(o)); }
  }
}
console.log(`hits (feet inside a drawn cluster box, >30px from own seat): ${hits.length}; by phase:`, JSON.stringify(hits.reduce((m, o) => (m[o.phase] = (m[o.phase] || 0) + 1, m), {})), 'onSolid:', hits.filter((o) => !o.free).length);
await b.close();
