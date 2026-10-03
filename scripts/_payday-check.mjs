import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import fs from 'node:fs';
const out = process.argv[2] ?? '/tmp';
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), stateDir = mkdtempSync(join(tmpdir(), 'hs-payday-'));
const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env, HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: stateDir }, stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const exe = fs.readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort().map((d) => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/?zoom=2&debug`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__herdrReady && window.hs?.model?.agents?.size > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const o = window.hs.office; o.cameras.main.centerOn(o.receptionSpot.x - 60, o.receptionSpot.y - 120); });
  await page.locator('#event-debug-tray button', { hasText: 'Pay $250' }).first().click();
  await page.locator('.event-debug-toggle').click();   // the open tray suspends the scene, as any modal does
  const state = () => page.evaluate(() => { const o = window.hs.office; const v = o.visitor; return { visitor: v ? { kind: v.kind, x: Math.round(v.node.x), y: Math.round(v.node.y), coin: !!v.coin } : null, party: !document.getElementById('party').hidden, partyTask: document.querySelector('#party .party-task')?.textContent, ticker: !document.getElementById('sales-ticker').hidden, tickerTotal: document.querySelector('.ticker-total')?.textContent, flash: document.querySelector('.hud-funds')?.classList.contains('flash'), cheering: o.pods.flatMap(p => p.stations).filter(s => s.agent && s.body.frame.name === 'cheer').length, confetti: o.children.list.filter(c => c.texture?.key === 'confetti-px').length }; });
  for (let i = 1; i <= 9; i++) {
    await page.waitForTimeout(900);
    const s = await state();
    console.log(i, JSON.stringify(s));
    if (i === 2 || s.confetti > 0 || i === 9) await page.screenshot({ path: `${out}/payday-${i}.png` });
  }
} finally { await browser.close(); child.kill(); }
