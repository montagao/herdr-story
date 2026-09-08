// Isolated browser regression: the bridge is mocked and every save goes to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-revenue-settings-'));
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
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000);
  page.on("pageerror", error => { errors.push(error.message); console.error(error.stack); });
  const requests = [];
  await page.route('**/api/revenue?*', async route => {
    const range = new URL(route.request().url()).searchParams.get('range'); requests.push(range);
    await route.fulfill({ json: { source: 'both', amount: 3392, currency: 'usd', label: `2 sources · ${range} (UTC)`, calendarRanges: true,
      parts: [{ source: 'stripe', amount: 2568, currency: 'usd', note: 'Net after Stripe fees' }, { source: 'revenuecat', amount: 824, currency: 'usd', note: 'Gross before taxes and store fees' }] } });
  });
  await page.goto(url); await ready(page);
  await page.waitForFunction(() => document.querySelector('.hud-amount').textContent.includes('3,392'));
  await page.locator('.hud-amount').hover();
  assert.equal(await page.locator('.hud-break').isVisible(), true);
  assert.equal(await page.locator('.hud-break button, .hud-break input, .hud-break select, .hud-break a').count(), 0);
  assert.equal(await page.locator('.hud-funds > button.hud-range, .hud-caption button.hud-range').count(), 0);
  assert.equal(await page.locator('.hud-break').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  await page.screenshot({ path: join(scratch, 'breakdown.png') });
  await page.getByRole('button', { name: 'Revenue settings', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Revenue settings' }).isVisible(), true);
  assert.equal(await page.evaluate(() => window.hs.office.canInteract()), false);
  await page.getByLabel('Reporting period').selectOption('7d');
  await page.waitForFunction(() => document.querySelector('.hud-range-label')?.textContent === '7d');
  assert.ok(requests.includes('7d'));
  assert.equal(await page.evaluate(() => localStorage.getItem('herdr-revenue-range')), '7d');
  await page.screenshot({ path: join(scratch, 'settings.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Revenue settings' }).isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Revenue settings');
  assert.equal(await page.evaluate(() => window.hs.office.canInteract()), true);
  await page.getByRole('button', { name: 'Revenue settings', exact: true }).click();
  assert.equal(await page.getByLabel('Reporting period').inputValue(), '7d');
  await page.getByRole('button', { name: 'Manage payment sources' }).click();
  await page.waitForSelector('#billing-setup:not([hidden])');
  assert.equal(await page.getByRole('dialog', { name: 'Revenue settings' }).isVisible(), false);
  await page.locator('#billing-setup .setup-x').click();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.hud-range-label')?.textContent === '7d');
  assert.deepEqual(errors, []);
  console.log('PASS read-only hover, settings dialog, period persistence, source setup, Escape and office input blocking');
  console.log(`Screenshots: ${scratch}`);
} finally { await browser.close(); for (const child of children) await stop(child); }
