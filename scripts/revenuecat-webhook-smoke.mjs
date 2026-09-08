// Local mock only: signed webhook -> durable journal -> browser notification -> restart recovery.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-revenuecat-'));
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), hookPort = await freePort();
const url = `http://127.0.0.1:${port}`, hookUrl = `http://127.0.0.1:${hookPort}/webhooks/revenuecat`;
const authorization = 'Bearer isolated-revenuecat-test', secret = 'isolated-signing-secret';
const children = [];
async function start(writable = true) {
  const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
    HERDR_STORY_PORT: String(port), HERDR_STORY_STATE_DIR: join(scratch, 'state'), HERDR_STORY_HOST: '127.0.0.1',
    HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: writable ? '1' : '0', HERDR_STORY_WEBHOOK_MOCK: '1',
    HERDR_STORY_WEBHOOK_PORT: String(hookPort), REVENUECAT_WEBHOOK_AUTH: authorization,
    REVENUECAT_WEBHOOK_SIGNING_SECRET: secret, REVENUECAT_WEBHOOK_PUBLIC_URL: 'https://hooks.example.test/webhooks/revenuecat',
    REVENUECAT_WEBHOOK_INTEGRATION_ID: '',
    STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(log);
    try { const r = await fetch(`${url}/health`); if (r.ok) { assert.equal((await r.json()).mock, true); return child; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(log);
}
const stop = c => new Promise(resolve => { if (c.exitCode !== null || c.signalCode !== null) return resolve(); c.once('exit', resolve); c.kill(); });
async function send(id, type = 'INITIAL_PURCHASE', patch = {}) {
  const body = JSON.stringify({ api_version: '1.0', event: { id, type, event_timestamp_ms: Date.now(),
    environment: 'PRODUCTION', store: 'APP_STORE', product_id: 'Lantern monthly', price: 9.99,
    currency: 'AUD', price_in_purchased_currency: 14.99, period_type: 'NORMAL', ...patch } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return fetch(hookUrl, { method: 'POST', headers: { authorization, 'content-type': 'application/json',
    'x-revenuecat-webhook-signature': `t=${timestamp},v1=${signature}` }, body });
}
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', e => errors.push(e.message));
let revenueReads = 0;
await page.route('**/api/revenue*', route => {
  if (new URL(route.request().url()).pathname !== '/api/revenue') return route.continue();
  revenueReads++; return route.fulfill({ json: { source: 'revenuecat', amount: 3399, currency: 'usd', label: 'RevenueCat', rangeSelectable: true } });
});
const ready = async () => { await page.waitForFunction(() => window.__herdrReady && window.hs?.office?.furnishings?.items.length); };
const instrument = () => page.evaluate(() => {
  window.paymentCalls = [];
  const office = window.hs.office, money = office.money.bind(office);
  office.money = e => { window.paymentCalls.push(e); money(e); };
});
try {
  let child = await start();
  for (const path of ['/', '/api/state', '/api/call', '/api/revenuecat/webhook', '/ws'])
    assert.equal((await fetch(`http://127.0.0.1:${hookPort}${path}`)).status, 404);
  assert.equal((await fetch(hookUrl, { method: 'POST' })).status, 401);
  await page.goto(url); await ready(); await instrument();
  const before = revenueReads;
  assert.equal((await send('purchase_1')).status, 200);
  await page.waitForSelector('[data-money="revenuecat:purchase_1"]');
  await page.waitForFunction(() => window.paymentCalls.length === 1);
  assert.equal(await page.locator('[data-money="revenuecat:purchase_1"]').textContent().then(t => t.includes('RevenueCat')), true);
  await page.waitForFunction(() => window.hs.studio.state.journal.some(e => e.moneyId === 'revenuecat:purchase_1' && e.source === 'revenuecat'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(scratch, 'payment.png') });
  assert.equal((await send('purchase_1')).status, 200);
  assert.equal((await send('dashboard_test', 'TEST')).status, 200);
  assert.equal((await send('sandbox_purchase', 'RENEWAL', { environment: 'SANDBOX' })).status, 200);
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate(() => window.paymentCalls.length), 1);
  assert.ok(revenueReads > before, 'Webhook refreshes API total');
  assert.match(await page.locator('.hud-amount').textContent(), /3,399/, 'AUD event must not be added to USD total');
  assert.equal((await send('trial_1', 'INITIAL_PURCHASE', { period_type: 'TRIAL', price: 0, price_in_purchased_currency: 0 })).status, 200);
  await page.waitForSelector('[data-money="revenuecat:trial_1"]');
  assert.equal(await page.evaluate(() => window.paymentCalls.at(-1).kind), 'trial_started');
  await page.evaluate(() => window.hs.billingSetup.open());
  await page.locator('[data-pick="revenuecat"]').click();
  await page.waitForFunction(() => document.querySelector('.setup-hook-status')?.textContent.includes('Receiving events'));
  await page.getByRole('button', { name: 'Connect notifications in RevenueCat' }).click();
  await page.waitForFunction(() => document.querySelector('.setup-hook-registration-status')?.textContent.includes('Configure the RevenueCat API key'));
  assert.equal(await page.getByRole('button', { name: 'Connect notifications in RevenueCat' }).isEnabled(), true);
  await page.locator('.setup-webhook').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(scratch, 'webhook-settings.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.setup-webhook').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('.setup-win').evaluate(e => e.getBoundingClientRect().width <= innerWidth));
  await page.screenshot({ path: join(scratch, 'webhook-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  const status = await (await fetch(`${url}/api/revenuecat/webhook`)).json();
  assert.equal(status.received, 4); assert.ok(status.lastTestAt); assert.ok(!JSON.stringify(status).includes(authorization));
  const copy = await (await fetch(`${url}/api/revenuecat/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(copy.authorization, authorization);
  await stop(child); child = await start(false);
  await page.reload(); await ready(); await instrument();
  await page.waitForSelector('[data-money="revenuecat:purchase_1"]');
  assert.equal((await send('purchase_1')).status, 200);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.paymentCalls.length), 0);
  assert.equal((await fetch(`${url}/api/revenuecat/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(await page.evaluate(() => window.hs.studio.state.journal.filter(e => e.moneyId === 'revenuecat:purchase_1').length), 1);
  assert.deepEqual(errors, []);
  console.log(`PASS signed delivery, Sales/coins/journal, currency-safe HUD, dedup, test/sandbox isolation, status, restart, read-only. Screenshots: ${scratch}`);
} finally { await browser.close(); for (const child of children) await stop(child); }
