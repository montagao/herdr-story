// Isolated browser regression: the bridge is mocked and every save goes to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-recap-money-'));
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
await startBridge(port, stateDir);
const browser = await chromium.launch({ executablePath });
const errors = [];
let page;
const ready = async p => { await p.waitForFunction(() => window.hs?.studio?.state?.employees.length && window.hs.office.furnishings.items.length); };
try {
  const added = await fetch(`${url}api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    type: 'call', id: 'recap-fixture', method: 'studio.change', params: { op: 'entry.save', title: 'Completed recap fixture', kind: 'note', notes: '', contributors: [], url: '', project: '' },
  }) });
  assert.ok(!(await added.json()).error);
  page = await browser.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await ready(page);
  await page.evaluate(() => {
    const { studio, client } = window.hs;
    studio.recapSince = Date.now() - 3600_000;
    studio.state.journalTotal = studio.state.journal.length + 1000;
    const call = client.call.bind(client);
    window.summaryRequests = [];
    client.call = async (method, params, ...args) => {
      if (method !== 'studio.journal' || !params.moneySummary) return call(method, params, ...args);
      const result = await call(method, params, ...args);
      return new Promise((resolve, reject) => window.summaryRequests.push({
        resolve: (amount = 42) => resolve({ ...result, money: { totals: [{ currency: 'eur', amount: 35 }], payments: 1, refunds: 0, billingEvents: 1,
          usd: { amount, estimated: true, rateDate: '2026-09-07' } } }),
        unavailable: () => resolve({ ...result, money: { totals: [{ currency: 'eur', amount: 35 }], payments: 1, refunds: 0, billingEvents: 1, conversionUnavailable: true } }),
        missing: () => { delete result.money; resolve(result); },
        reject: () => reject(new Error('Request timed out')),
      }));
    };
    studio.openRecap();
  });
  const card = page.locator('.recap-card').first();
  const pending = count => page.waitForFunction(n => window.summaryRequests.length === n, count);
  const settle = async action => {
    await page.evaluate(action);
    await page.waitForFunction(() => !window.hs.studio.historyLoading);
  };
  await pending(1);
  assert.match(await card.innerText(), /Converting/);
  // A live update rebuilds the same panel while the conversion is pending.
  await page.evaluate(() => window.hs.studio.render());
  await settle(() => window.summaryRequests[0].resolve());
  assert.match(await card.innerText(), /42\.00/);
  assert.doesNotMatch(await card.innerText(), /Converting|Updating/);

  await page.locator('[data-recap-range="7d"]').click(); await pending(2);
  await page.locator('[data-tab="people"]').click();
  await settle(() => window.summaryRequests[1].resolve(999));
  await page.locator('[data-tab="journal"]').click(); await pending(3);
  await settle(() => window.summaryRequests[2].resolve(52));
  assert.match(await card.innerText(), /52\.00/);
  assert.doesNotMatch(await card.innerText(), /999/);

  // Closing and reopening a cached pending panel must also paint the result.
  await page.locator('[data-recap-range="30d"]').click(); await pending(4);
  await page.locator('#studio-panel [data-close]').click();
  await settle(() => window.summaryRequests[3].resolve(62));
  await page.evaluate(() => window.hs.studio.open('journal'));
  assert.match(await card.innerText(), /62\.00/);

  await page.locator('[data-recap-range="24h"]').click(); await pending(5);
  await settle(() => window.summaryRequests[4].reject());
  assert.match(await card.innerText(), /Total unavailable/);
  assert.doesNotMatch(await card.innerText(), /Converting/);
  await page.locator('[data-retry-recap]').click(); await pending(6);
  await settle(() => window.summaryRequests[5].resolve(72));
  assert.match(await card.innerText(), /72\.00/);

  await page.locator('[data-recap-range="today"]').click(); await pending(7);
  await settle(() => window.summaryRequests[6].unavailable());
  assert.match(await card.innerText(), /Exchange rates unavailable/);
  assert.match(await card.innerText(), /EUR/);
  assert.doesNotMatch(await card.innerText(), /Converting/);
  // Exhausted history is still allowed to retry the total.
  await page.locator('[data-retry-recap]').click(); await pending(8);
  await settle(() => window.summaryRequests[7].missing());
  assert.doesNotMatch(await card.innerText(), /Converting/);
  assert.equal(await page.locator('[data-retry-recap]').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('PASS recap redraw, tab switch, close/reopen, timeout and retry, unavailable rates and missing summary');
} finally { await browser.close(); for (const child of children) await stop(child); }
