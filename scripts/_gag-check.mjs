import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import fs from 'node:fs';
const out = process.argv[2] ?? '/tmp';
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), stateDir = mkdtempSync(join(tmpdir(), 'hs-gags-'));
const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env, HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: stateDir }, stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const exe = fs.readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort().map((d) => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/?zoom=2&celebrate=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__herdrReady && window.hs?.model?.agents?.size > 0, null, { timeout: 30000 });
  await page.waitForTimeout(3000);
  // boom at reception
  await page.evaluate(() => { const o = window.hs.office; o.cameras.main.centerOn(o.receptionSpot.x, o.receptionSpot.y - 20); o.previewBoom(); });
  await page.waitForTimeout(230);
  console.log('boom objects:', JSON.stringify(await page.evaluate(() => window.hs.office.children.list.filter(c => c.texture && /^boom/.test(c.texture.key)).map(c => c.texture.key))));
  await page.screenshot({ path: `${out}/gag-boom.png` });
  await page.waitForTimeout(1500);
  // collapse
  const collapse = await page.evaluate(() => {
    const o = window.hs.office; const st = o.pods.flatMap(p => p.stations).find(s => s.agent && !s.away);
    o.cameras.main.centerOn(st.person.x, st.person.y); st.collapse();
    return { frame: st.body.frame.name, status: st.status, collapsed: st.collapsed };
  });
  console.log('collapse:', JSON.stringify(collapse));
  await page.waitForTimeout(600);
  console.log('collapse after 600ms:', JSON.stringify(await page.evaluate(() => { const st = window.hs.office.pods.flatMap(p => p.stations).find(s => s.agent && !s.away); return { frame: st.body.frame.name }; })));
  await page.screenshot({ path: `${out}/gag-collapse.png` });
  await page.waitForTimeout(4500);
  console.log('collapse after 5s:', JSON.stringify(await page.evaluate(() => { const st = window.hs.office.pods.flatMap(p => p.stations).find(s => s.agent && !s.away); return { frame: st.body.frame.name }; })));
  // visitor
  await page.evaluate(() => { const o = window.hs.office; o.cameras.main.centerOn(o.receptionSpot.x + 20, o.receptionSpot.y - 20); void o.visit('mascot', 'A new subscriber!'); });
  for (let i = 1; i <= 5; i++) {
    await page.waitForTimeout(1400);
    const v = await page.evaluate(() => { const v = window.hs.office.visitor; return v ? { kind: v.kind, x: Math.round(v.node.x), y: Math.round(v.node.y), alpha: v.node.alpha, bubble: !!v.bubble } : null; });
    console.log('visitor', i, JSON.stringify(v));
    await page.screenshot({ path: `${out}/gag-visitor${i}.png` });
  }
} finally { await browser.close(); child.kill(); }
