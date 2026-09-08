// Isolated browser regression: the bridge is mocked and every save goes to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-recap-browser-'));
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const children = [];
const freePort = () => new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
async function startBridge(port, stateDir, writable = true) {
  const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env, HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: stateDir,
    HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: writable ? '1' : '0', STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { const res = await fetch(`http://127.0.0.1:${port}/health`); if (res.ok) { assert.equal((await res.json()).mock, true); return child; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Mock bridge did not start: ${output}`);
}
const stop = child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); child.once('exit', resolve); child.kill(); });
const port = await freePort(), url = `http://127.0.0.1:${port}/`, stateDir = join(scratch, 'state');
let server = await startBridge(port, stateDir);
const browser = await chromium.launch({ executablePath });
const errors = [];
let page;
const ready = async p => { await p.waitForFunction(() => window.hs?.studio?.state?.employees.length && window.hs.office.furnishings.items.length); };
const addMemory = async title => {
  const res = await fetch(`${url}api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call', id: title, method: 'studio.change', params: { op: 'entry.save', title, kind: 'note', notes: '', contributors: [], url: '', project: '' } }) });
  assert.equal(res.status, 200); const body = await res.json(); assert.ok(!body.error, JSON.stringify(body));
};
const hide = p => p.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange'));
  return localStorage.getItem('herdr-story:seen-at');
});
try {
  const context = await browser.newContext();
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await ready(page);
  assert.equal(await page.locator('#studio-recap').isVisible(), false);
  const leftAt = await hide(page);
  assert.ok(Number(leftAt) > 0);
  await addMemory('Completed while the tab was hidden');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.evaluate(() => localStorage.getItem('herdr-story:seen-at')), leftAt, 'Closing a hidden tab preserves departure time');
  await page.close();
  await addMemory('Completed after closing the page');
  page = await context.newPage(); await page.goto(url); await ready(page);
  await page.waitForFunction(() => !document.querySelector('#studio-recap').hidden);
  assert.match(await page.locator('#studio-recap').innerText(), /2 new memories/);
  await page.locator('[data-recap]').click();
  assert.match(await page.locator('.journal-entries').innerText(), /Completed while the tab was hidden/);
  assert.match(await page.locator('.journal-entries').innerText(), /Completed after closing the page/);
  await page.locator('#studio-panel [data-close]').click();
  assert.equal(await page.locator('#studio-recap').isVisible(), false, 'Opening the recap counts as having looked');
  await hide(page);
  await addMemory('Completed while switched to another tab');
  await page.waitForFunction(() => window.hs.studio.state.journal.some(e => e.title === 'Completed while switched to another tab'));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.match(await page.locator('#studio-recap').innerText(), /1 new memory/);
  await page.screenshot({ path: join(scratch, 'recap-return.png') });
  await page.locator('[data-dismiss]').click();
  await hide(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(await page.locator('#studio-recap').isVisible(), false, 'No recap without new activity');
  const slow = await browser.newContext();
  await slow.addInitScript(() => {
    localStorage.setItem('herdr-story:seen-at', String(Date.now() - 60_000));
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      set onmessage(handler) {
        super.onmessage = event => {
          if (JSON.parse(event.data).type === 'snapshot') window.releaseSnapshot = () => handler.call(this, event);
          else handler.call(this, event);
        };
      }
    };
  });
  const loading = await slow.newPage(); await loading.goto(url);
  await loading.waitForFunction(() => window.hs?.studio && window.releaseSnapshot);
  await loading.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.releaseSnapshot();
  });
  await ready(loading);
  assert.equal(await loading.locator('#studio-recap').isVisible(), true, 'Visibility changes before the first snapshot preserve the previous visit');
  await slow.close();
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS hidden-tab closure, reopen in same browser, tab return, pageshow restore, dismissal and no new activity');
  console.log(`Recap screenshots: ${scratch}`);
} finally { await browser.close(); for (const child of children) await stop(child); }
