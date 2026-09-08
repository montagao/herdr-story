// DOM and conversation tests use only a temporary mock bridge; no real agent receives a prompt.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const directory = mkdtempSync(join(tmpdir(), 'herdr-terminal-lines-'));
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: directory, HERDR_STORY_MOCK_STATIC: '1',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().map(n => `${cache}/${n}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw Error(logs);
    try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.waitForFunction(() => window.hs?.office?.pods?.length);
  const result = await page.evaluate(async () => {
    const { dialog, client, model } = window.hs;
    const agent = [...model.agents.values()].find(a => a.agent === 'codex' && a.agent_session?.kind === 'id');
    if (!agent) throw Error('Expected a mock Codex session');
    const key = dialog.queueKey(agent), original = client.call.bind(client);
    let pending = [{ id: 'native-next', clientId: '', text: 'Still waiting' }], unavailable = false, checks = 0;
    client.call = async (method, params, options) => {
      if (method === 'agent.queue.status') { checks++; if (unavailable) throw Error('Disconnected'); return { pending }; }
      return original(method, params, options);
    };
    const old = { id: 'queue-old', text: 'Already handled', state: 'queued', queuedAt: 1 };
    const next = { id: 'queue-next', text: 'Still waiting', state: 'queued', queuedAt: 2 };
    dialog.queueHistory.set(key, [old, next]);
    dialog.syncQueues([], [], Date.now(), [...model.agents.values()]);
    if (old.state !== 'queued') throw Error('A bridge restart incorrectly marked a native queue failed');
    await dialog.open(agent);
    for (let i = 0; i < 100 && dialog.queueStatusPending.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const retained = [...document.querySelectorAll('.queued-prompt')].map(e => e.dataset.queueId);
    unavailable = true; await dialog.refreshNativeQueue(agent);
    const failureRetained = !!dialog.findQueued('queue-next');
    unavailable = false; pending = []; await dialog.refreshNativeQueue(agent);
    const cleared = document.querySelector('.prompt-queue').hidden && !dialog.findQueued('queue-next');
    // A newly acknowledged submission is outside an older status request's snapshot.
    const first = { id: 'queue-first', text: 'Consumed', state: 'queued', queuedAt: Date.now() };
    const newer = { id: 'queue-newer', text: 'Just submitted', state: 'queuing', queuedAt: Date.now() };
    dialog.queueHistory.set(key, [first, newer]);
    let release;
    client.call = (method, params, options) => method === 'agent.queue.status'
      ? new Promise(resolve => release = () => resolve({ pending: [] })) : original(method, params, options);
    const check = dialog.refreshNativeQueue(agent); newer.state = 'queued'; release(); await check;
    const newerRetained = !!dialog.findQueued(newer.id) && !dialog.findQueued(first.id);
    dialog.queueHistory.delete(key); dialog.saveQueueHistory();
    await dialog.open(agent);
    const reopenedClear = document.querySelector('.prompt-queue').hidden;
    return { retained, failureRetained, cleared, newerRetained, reopenedClear, checks };
  });
  assert.deepEqual(result.retained, ['queue-next']);
  for (const key of ['failureRetained', 'cleared', 'newerRetained', 'reopenedClear']) assert.equal(result[key], true, key);
  assert(result.checks >= 3); assert.deepEqual(errors, []);
  console.log('PASS native queue reconciliation, restart recovery, pending retention, failed-status protection, in-flight acknowledgement race, and cleared queue after reopening');

} finally {
  await browser.close();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
  rmSync(directory, { recursive: true, force: true });
}
