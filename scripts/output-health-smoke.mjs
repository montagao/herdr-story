// Uses a dedicated read-only fake backend; it never connects to live Herdr agents or storage.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = await new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
const server = spawn('bun', ['scripts/output-health-fixture.ts'], { env: { ...process.env, OUTPUT_HEALTH_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', data => log = (log + String(data)).slice(-8000));
const url = `http://127.0.0.1:${port}`;
const metrics = async () => (await fetch(`${url}/fixture/metrics`)).json();
const control = async value => { assert((await fetch(`${url}/fixture/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })).ok); };
async function waitFor(check, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(100); }
  throw new Error('Fixture condition timed out');
}
let browser;
try {
  await waitFor(async () => { try { return (await fetch(`${url}/api/state`)).ok; } catch { return false; } });
  const base = `${process.env.HOME}/.cache/ms-playwright`;
  const executablePath = process.env.PW_EXE || readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort()
    .map(d => `${base}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], packets = []; page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', event => { try { packets.push(JSON.parse(String(event.payload))); } catch {} }));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hs?.model.agents.size);
  await page.locator('.agent-row[data-pane="fixture:quiet"]').click();
  await page.waitForFunction(() => document.querySelector('.terminal-output')?.dataset.loaded === 'true' && window.hs.client.outputFresh('fixture:quiet'));
  await pause(1000);
  const initial = await metrics();
  const quietStarted = Date.now();
  // More than two 5s fallback timers must pass without generating a browser read RPC.
  for (let second = 0; second < 11; second++) {
    await pause(1000); assert(await page.evaluate(() => window.hs.client.outputFresh('fixture:quiet')), 'Quiet stream remains healthy');
  }
  const quiet = await metrics();
  assert.equal(quiet.rpcReads.length, initial.rpcReads.length, 'Healthy quiet chat issues zero fallback reads after opening');
  const visible = quiet.backendReads.filter(read => read.source === 'visible');
  const gaps = visible.slice(1).map((read, index) => Math.round(read.at - visible[index].at));
  assert(gaps.some(gap => gap >= 4500), `Quiet backend reads reach the 5s backoff: ${gaps}`);
  assert(quiet.backendReads.length - initial.backendReads.length <= 4, 'Quiet backend polling is reduced');
  assert(packets.filter(packet => packet.type === 'output.health').length >= 3);
  assert.equal(packets.filter(packet => packet.type === 'output').length, 1, 'Health checks do not retransmit terminal text');
  console.log(`Quiet chat stayed fresh for ${Date.now() - quietStarted}ms with zero fallback reads; backend intervals ${gaps.join(', ')}ms.`);

  await control({ failed: true });
  await waitFor(async () => (await metrics()).rpcReads.length > quiet.rpcReads.length, 18000);
  assert.equal(await page.evaluate(() => window.hs.client.outputFresh('fixture:quiet')), false, 'Failed reads cannot keep the stream fresh');
  await page.waitForFunction(() => document.querySelector('.terminal-status')?.textContent.includes('unavailable'));
  assert((await page.locator('.terminal-output').textContent()).includes('Quiet agent output'), 'Failed reads retain the previous screen');
  await control({ failed: false });
  await page.waitForFunction(() => window.hs.client.outputFresh('fixture:quiet'));

  const beforeDisconnect = await metrics();
  await control({ connectAllowed: false, disconnect: true });
  await waitFor(async () => (await metrics()).rpcReads.some((read, index) => index >= beforeDisconnect.rpcReads.length && read.transport === 'http'), 10000);
  assert.equal(await page.evaluate(() => window.hs.client.outputStreaming), false, 'Disconnected output uses HTTP fallback');
  await control({ connectAllowed: true });
  await page.waitForFunction(() => window.hs.client.outputFresh('fixture:quiet'), null, { timeout: 12000 });
  const recovered = await metrics();
  await pause(5500);
  assert.equal((await metrics()).rpcReads.length, recovered.rpcReads.length, 'Reconnected quiet stream stops fallback reads again');
  assert.deepEqual(errors, [], 'Browser has no uncaught errors');
  console.log('PASS quiet heartbeat, idle backoff, failed-read fallback, disconnected HTTP fallback and reconnect recovery');
} catch (error) { console.error(log); throw error; }
finally {
  await browser?.close();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
}
