// Start a mock bridge, open the office, fire every scene from the test-events tray, screenshot each.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import fs from 'node:fs';
const out = process.argv[2] ?? '/tmp';
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), stateDir = mkdtempSync(join(tmpdir(), 'hs-scenes-'));
const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env, HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: stateDir }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', d => { const t = String(d); if (/error/i.test(t)) process.stderr.write(t); });
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const exe = fs.readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort().map((d) => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/?zoom=1&debug`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__herdrReady && window.hs?.model?.agents?.size > 0, null, { timeout: 30000 });
  await page.waitForTimeout(3000);
  const windowed = ['Sales report', 'Awards', 'Launch day', 'Crunch', 'Training', 'Convention'];
  for (const caption of windowed) {
    await page.evaluate(() => window.hs.scenes.close());
    await page.waitForTimeout(100);
    await page.evaluate(() => { const s = window.hs.scenes; s.lastClosed = 0; s.recent.clear(); });
    await page.locator('#event-debug-tray button', { hasText: caption }).first().click();
    await page.waitForFunction(() => !document.getElementById('cutscene').hidden, null, { timeout: 8000 });
    await page.waitForTimeout(1900);
    const open = await page.evaluate(() => ({ heading: document.querySelector('.cutscene-window header b')?.textContent, caption: document.querySelector('.cutscene-caption b')?.textContent }));
    console.log(caption, JSON.stringify(open));
    await page.screenshot({ path: `${out}/scene-${caption.replace(/\s+/g, '-').toLowerCase()}.png` });
  }
  await page.evaluate(() => window.hs.scenes.close());
  // in-office gags
  await page.locator('#event-debug-tray button', { hasText: 'Boom' }).first().click();
  await page.waitForTimeout(260);
  await page.screenshot({ path: `${out}/gag-boom.png` });
  await page.locator('#event-debug-tray button', { hasText: 'Crunch' }).first().click();
  await page.waitForTimeout(700);
  await page.evaluate(() => window.hs.scenes.close());
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/gag-collapse.png` });
  await page.locator('#event-debug-tray button', { hasText: 'Visitor' }).first().click();
  for (let i = 1; i <= 4; i++) { await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/gag-visitor${i}.png` }); }
  console.log('visitor', JSON.stringify(await page.evaluate(() => { const v = window.hs.office.visitor; return v ? { kind: v.kind, x: Math.round(v.node.x), y: Math.round(v.node.y) } : null; })));
} finally { await browser.close(); child.kill(); }
