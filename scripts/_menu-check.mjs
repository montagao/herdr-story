import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import fs from 'node:fs';
const out = process.argv[2] ?? '/tmp';
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), stateDir = mkdtempSync(join(tmpdir(), 'hs-menu-'));
const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env, HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: stateDir }, stdio: ['ignore', 'pipe', 'pipe'] });
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const exe = fs.readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort().map((d) => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/?zoom=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__herdrReady && window.hs?.studio?.state?.employees?.length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2000);
  const row = page.locator('.agent-row').first();
  const name = await row.locator('.agent-line b').textContent();
  await row.hover();
  await page.locator('.agent-menu').first().click();
  await page.waitForSelector('.roster-menu');
  console.log('items:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.roster-menu [role=menuitem]')].map(b => b.textContent + (b.disabled ? ' (disabled)' : '')))));
  await page.screenshot({ path: `${out}/menu-open.png`, clip: { x: 900, y: 380, width: 380, height: 360 } });
  await page.locator('.roster-menu [role=menuitem]', { hasText: 'Pin to the top' }).click();
  await page.waitForFunction(n => document.querySelector('.agent-row .agent-line b')?.textContent.startsWith('★'), name, { timeout: 8000 }).catch(() => {});
  console.log('after pin, first row:', await page.locator('.agent-row .agent-line b').first().textContent());
  // rename via the inline field
  await page.locator('.agent-row').first().click({ button: 'right' });
  await page.waitForSelector('.roster-menu');
  await page.locator('.roster-menu [role=menuitem]', { hasText: 'Rename' }).click();
  await page.screenshot({ path: `${out}/menu-rename.png`, clip: { x: 900, y: 380, width: 380, height: 360 } });
  await page.fill('.roster-menu-edit input', 'Ada Lovelace');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.agent-row .agent-line b')].some(b => b.textContent.includes('Ada Lovelace')), null, { timeout: 8000 });
  console.log('renamed:', await page.locator('.agent-row .agent-line b').first().textContent());
  console.log('menu closed:', await page.locator('.roster-menu').count() === 0);
} finally { await browser.close(); child.kill(); }
