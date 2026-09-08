// Capture the fictional, bridge-free demo. No personal artwork or live data is included.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-screenshots-'));
const out = resolve('docs/screenshots');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
let server, browser;
try {
  execFileSync('npm', ['run', 'build:public', '--', '--outDir', scratch], { stdio: 'pipe' });
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(scratch, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(scratch + sep)) { res.writeHead(403).end(); return; }
    try { const data = readFileSync(file); res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(data); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let executablePath = process.env.PW_EXE;
  if (!executablePath && !existsSync(chromium.executablePath())) {
    const cache = join(homedir(), '.cache/ms-playwright');
    if (existsSync(cache)) executablePath = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort()
      .map(d => join(cache, d, 'chrome-headless-shell-linux64/chrome-headless-shell')).filter(existsSync).pop();
  }
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1120, height: 840 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const errors = [], forbidden = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', ws => forbidden.push(ws.url()));
  page.on('request', req => { if (/\/(api|ws)(\/|\?|$)/.test(new URL(req.url()).pathname)) forbidden.push(req.url()); });
  await page.goto(`${base}/?demo=1&roster=1&live=0`);
  await page.waitForFunction(() => window.__herdrReady && document.querySelectorAll('.agent-row').length === 4);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.roster-connection').filter({ hasText: 'Fictional demo' }).waitFor();
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, 'roster.png'), animations: 'disabled' });
  await page.locator('.agent-row').filter({ hasText: 'Bea' }).click();
  await page.waitForSelector('#dialog:not([hidden])');
  await page.waitForFunction(() => document.querySelector('.terminal-output')?.textContent?.includes('Fictional')
    || document.querySelector('.terminal-output')?.textContent?.includes('fictional'));
  await page.screenshot({ path: join(out, 'conversation.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#dialog[hidden]', { state: 'attached' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(out, 'roster-mobile.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, [], 'Screenshots must not connect to a live bridge');
  console.log('Captured 3 fictional demo screenshots in docs/screenshots (no bridge or private artwork).');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
