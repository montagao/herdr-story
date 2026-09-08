// Every action below targets an isolated mock bridge and temporary studio, never a live agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const scratch = mkdtempSync(join(tmpdir(), 'herdr-performance-'));
const port = await new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const n = socket.address().port; socket.close(() => resolve(n)); }); });
const historyDelay = 3000;
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: join(scratch, 'state'),
  HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_MOCK_HISTORY_DELAY_MS: String(historyDelay), HERDR_STORY_WRITE: '1', HERDR_STORY_POLL_MS: '150',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog = (serverLog + String(data)).slice(-8000); });
const url = `http://127.0.0.1:${port}`;
const peers = []; let browser;
const call = async (method, params) => {
  const response = await fetch(`${url}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call', method, params }) });
  const body = await response.json(); assert(!body.error, body.error?.message); return body.result;
};
async function peer(deltas = true) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`), records = [];
  ws.on('message', data => records.push({ ...JSON.parse(String(data)), receivedAt: performance.now() }));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const value = { ws, records, send: message => ws.send(JSON.stringify(message)), async wait(predicate, timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const found = records.find(predicate); if (found) return found; await pause(20); }
    throw new Error(`Socket condition timed out; messages: ${records.map(r => r.type).join(', ')}`);
  } };
  peers.push(value); if (deltas) value.send({ type: 'hello', deltas: true }); return value;
}
try {
  let state;
  for (let i = 0; i < 80; i++) {
    try { const res = await fetch(`${url}/api/state`); state = await res.json(); if (state.agents?.length) break; } catch {}
    await pause(100);
  }
  assert(state?.agents?.length, `Mock bridge starts: ${serverLog}`);
  const target = state.agents.find(agent => agent.agent_status === 'idle').pane_id;
  const first = await peer(), second = await peer(), legacy = await peer(false);
  await Promise.all([first.wait(m => m.type === 'snapshot'), second.wait(m => m.type === 'snapshot')]);
  for (const client of [first, second]) client.send({ type: 'output.subscribe', target });
  const [a, b] = await Promise.all([first.wait(m => m.type === 'output'), second.wait(m => m.type === 'output')]);
  assert.equal(a.text, b.text, 'Both subscribers see the same shared screen');
  await pause(1000);
  assert.equal(first.records.filter(m => m.type === 'output').length, 1, 'Unchanged output is not repeatedly transmitted');
  assert.equal(second.records.filter(m => m.type === 'output').length, 1);

  const started = performance.now();
  first.send({ type: 'call', id: 'slow-history', method: 'agent.read', params: { target, source: 'recent_unwrapped', lines: 77 } });
  await pause(80);
  // This read queues behind slow history. Cancellation removes it without blocking a visible read.
  first.send({ type: 'call', id: 'cancel-history', method: 'agent.read', params: { target, source: 'recent', lines: 78 } });
  first.send({ type: 'cancel', id: 'cancel-history' });
  const visibleAt = performance.now();
  const visible = await call('agent.read', { target, source: 'visible' });
  assert.equal(typeof visible.read.text, 'string');
  assert(performance.now() - visibleAt < 1000, 'Visible screen bypasses delayed background history');
  const promptAt = performance.now();
  await call('agent.prompt', { target, text: 'Isolated responsiveness fixture', message_id: 'performance-fixture-prompt' });
  const working = await first.wait(m => m.type === 'agents.patch' && m.receivedAt >= promptAt
    && m.upsert.some(agent => agent.pane_id === target && agent.agent_status === 'working'), 2200);
  const statusMs = working.receivedAt - promptAt;
  await legacy.wait(m => m.type === 'agents' && m.agents.some(agent => agent.pane_id === target && agent.agent_status === 'working'));
  assert(!legacy.records.some(m => m.type === 'agents.patch' || m.type === 'studio.patch'), 'Legacy tabs retain full updates');
  assert(statusMs < 1800, `Working status arrives while history is pending (${statusMs}ms)`);
  assert(!first.records.some(m => m.id === 'slow-history' && m.type === 'result'), 'Status did not wait behind scrollback');
  const pushed = await second.wait(m => m.type === 'output' && m.text.includes('Isolated responsiveness fixture'));
  assert(pushed.receivedAt - promptAt < 1800, 'Live output updates while history is pending');
  const history = await first.wait(m => m.type === 'result' && m.id === 'slow-history', 6000);
  assert(history.receivedAt - started >= historyDelay - 100, 'Mock history fixture actually delays the read');
  assert(!history.error, history.error?.message);
  await pause(100);
  assert(!first.records.some(m => m.id === 'cancel-history' && m.type === 'result'), 'Cancelled read sends no late result');
  await first.wait(m => m.type === 'studio.patch', 6000);

  const cache = `${process.env.HOME}/.cache/ms-playwright`;
  const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort()
    .map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], browserMessages = []; page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', event => { try { browserMessages.push(JSON.parse(String(event.payload))); } catch {} }));
  let releaseGraphics;
  const graphicsGate = new Promise(resolve => releaseGraphics = resolve);
  await page.route('**/phaser.esm-*.js', async route => { await graphicsGate; await route.continue(); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.hs?.model.agents.size);
  const openStart = performance.now();
  await page.locator(`.agent-row[data-pane="${target}"]`).click();
  await page.waitForFunction(() => document.querySelector('.terminal-output')?.dataset.loaded === 'true');
  const openMs = performance.now() - openStart;
  assert(await page.evaluate(() => !window.hs.game), 'Roster and chat work while the Phaser bundle is held');
  releaseGraphics();
  await page.waitForFunction(() => window.hs?.game);

  assert(openMs < 1800, `Chat opens before delayed history (${openMs}ms)`);
  await page.waitForFunction(() => window.herdrPerformance?.().some(entry => entry.name === 'herdr.chat.first-output'));
  await page.evaluate(() => {
    const client = window.hs.client, watch = client.outputWatch, original = watch.callback;
    window.streamReconnected = false; window.previousSocket = client.ws;
    watch.callback = value => { if (client.ws !== window.previousSocket) window.streamReconnected = true; original(value); };
    client.ws.close();
  });
  await page.waitForFunction(() => window.streamReconnected && window.hs.client.outputStreaming, null, { timeout: 8000 });
  assert((await page.locator('.terminal-output').textContent()).includes('Isolated responsiveness fixture'));
  assert(browserMessages.filter(message => message.type === 'hello' && message.deltas === true).length >= 2, 'Browser negotiates deltas on initial connect and reconnect');
  const measurements = await page.evaluate(() => window.herdrPerformance());
  assert(measurements.length <= 120, 'Instrumentation stays bounded');
  assert(measurements.some(entry => entry.name === 'herdr.rpc.agent.read.visible'));
  assert(measurements.every(entry => !JSON.stringify(entry).includes('Isolated responsiveness fixture')), 'Measurements exclude terminal content');
  assert.deepEqual(errors, [], 'Browser has no uncaught errors');
  console.log(JSON.stringify({ delayedHistoryMs: Math.round(history.receivedAt - started), statusDuringHistoryMs: Math.round(statusMs),
    liveOutputDuringHistoryMs: Math.round(pushed.receivedAt - promptAt), chatOpenMs: Math.round(openMs),
    firstOutputMs: Math.round(measurements.find(entry => entry.name === 'herdr.chat.first-output').durationMs) }));
  console.log('PASS isolated delayed-history priority, status deltas, shared output deduplication, cancelled reads, studio deltas, browser stream reconnect and bounded performance measurements');
} catch (error) { console.error(serverLog); throw error; }
finally {
  await browser?.close(); for (const { ws } of peers) ws.close();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
  rmSync(scratch, { recursive: true, force: true });
}
