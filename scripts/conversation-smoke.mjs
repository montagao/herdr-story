// Isolated UI regression: prompt calls are captured, never sent to a real agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const scratch = mkdtempSync(join(tmpdir(), 'herdr-conversation-'));
const port = await new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const n = socket.address().port; socket.close(() => resolve(n)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: join(scratch, 'state'), HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: '1',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '', HERDR_STORY_WEBHOOK_PORT: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
const base = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${base}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
const url = `http://127.0.0.1:${port}`;
try {
  let started = false;
  for (let n = 0; n < 80; n++) {
    try { if ((await fetch(`${url}/health`)).ok) { started = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(started, 'Mock bridge starts');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(12000);
  await page.goto(url);
  await page.waitForFunction(() => window.hs?.studio?.agents.length);
  const panes = await page.evaluate(async () => {
    const agents = [...window.hs.model.agents.values()].slice(0, 2);
    const client = window.hs.client, original = client.call.bind(client);
    window.ux = { calls: [], uploads: 0, pending: [], delay: false, fail: false };
    client.watchOutput = () => () => {};
    client.uploadImage = async () => { window.ux.uploads++; await new Promise(r => setTimeout(r, 100)); return '/tmp/test-image.png'; };
    client.call = async (method, params, options) => {
      if (method === 'agent.read') return { read: { text: Array.from({length: 100}, (_, i) => `Output ${params.target} line ${i}`).join('\n') } };
      if (method === 'agent.message.status') return { state: 'confirmed' };
      if (method === 'agent.prompt') {
        window.ux.calls.push(params);
        if (window.ux.uncertain) { window.ux.uncertain = false; throw Object.assign(Error('Delivery unconfirmed'), { code: 'uncertain' }); }
        if (window.ux.fail) { window.ux.fail = false; throw Error('Test delivery failure'); }
        if (window.ux.delay) await new Promise(resolve => window.ux.pending.push(resolve));
        return { state: 'sent' };
      }
      return original(method, params, options);
    };
    await window.hs.dialog.open(agents[0]); return agents.map(a => a.pane_id);
  });
  const input = page.locator('.reply textarea');
  // The window opens on the conversation face by default; these checks exercise the screen face.
  await page.locator('[data-view="screen"]').click();
  assert.equal(await page.locator('.conversation-details').getAttribute('open'), null);
  assert((await page.locator('.terminal-output').boundingBox()).height > 350, 'Conversation gets most of the window');
  await input.fill('Keep my draft');
  await page.locator('.terminal-output').evaluate(pre => pre.scrollTop = 80);
  await page.evaluate(async pane => window.hs.dialog.open(window.hs.model.agents.get(pane)), panes[1]);
  await input.fill('Second draft');
  await page.locator('.recent-conversations button').last().click();
  assert.equal(await input.inputValue(), 'Keep my draft');
  assert.equal(await page.locator('.terminal-output').evaluate(pre => pre.scrollTop), 80);
  assert.equal(await page.locator('.recent-conversations button').count(), 2);
  await page.evaluate(() => window.ux.delay = true);
  await input.fill('First request'); await page.locator('.reply button[type=submit]').click();
  await page.waitForFunction(() => window.ux.pending.length === 1);
  assert.equal(await page.locator('.reply button[type=submit]').isDisabled(), false);
  await input.fill('Next draft while sending');
  assert.equal(await page.locator('.prompt-echo:last-child > div > span').textContent(), 'sending…');
  await page.evaluate(() => { window.ux.delay = false; window.ux.pending.shift()(); });
  await page.waitForFunction(() => document.querySelector('.prompt-echo:last-child > div > span').textContent === 'accepted');
  assert.equal(await input.inputValue(), 'Next draft while sending');
  await page.evaluate(() => window.ux.fail = true);
  await input.fill('Retry me'); await page.locator('.reply button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.prompt-echo:last-child > div > span').textContent === 'failed');
  const retryId = await page.evaluate(() => window.ux.calls.at(-1).message_id);
  assert(retryId, 'Prompt has an idempotency key');
  await page.locator('.prompt-echo:last-child button').click();
  await page.waitForFunction(() => document.querySelector('.prompt-echo:last-child > div > span').textContent === 'accepted');
  assert.equal(await page.evaluate(() => window.ux.calls.at(-1).message_id), retryId);
  await input.evaluate(input => {
    const data = new DataTransfer(); data.items.add(new File(['image'], 'shot.png', {type: 'image/png'}));
    input.dispatchEvent(new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true}));
  });
  await page.waitForFunction(() => document.querySelector('.attachment-status').textContent === 'uploaded');
  assert.equal(await page.evaluate(() => window.ux.uploads), 1, 'Attachment uploads before send');
  await page.evaluate(() => window.hs.dialog.close());
  await page.evaluate(async pane => window.hs.dialog.open(window.hs.model.agents.get(pane)), panes[0]);
  assert.equal(await page.locator('.reply-attachment').count(), 1, 'Attachment survives closing');
  await input.fill('Inspect image'); await page.locator('.reply button[type=submit]').click();
  await page.waitForFunction(() => window.ux.calls.at(-1).text.includes('/tmp/test-image.png'));
  assert.equal(await page.evaluate(() => window.ux.uploads), 1, 'Send reuses pre-upload');
  assert.equal(await page.locator('.prompt-echo').count(), 3, 'Recent messages survive reopening');
  await page.evaluate(() => window.ux.uncertain = true);
  await input.fill('Delivery needs reconciliation'); await page.locator('.reply button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.prompt-echo:last-child > div > span').textContent === 'uncertain');
  assert.equal(await input.inputValue(), '', 'An uncertain send is not restored as an unsafe new draft');
  const sentBeforeCheck = await page.evaluate(() => window.ux.calls.length);
  await page.locator('.prompt-echo:last-child button').click();
  await page.waitForFunction(() => document.querySelector('.prompt-echo:last-child > div > span').textContent === 'accepted');
  assert.equal(await page.evaluate(() => window.ux.calls.length), sentBeforeCheck, 'Checking delivery never resends a prompt');
  await page.evaluate(pane => window.hs.dialog.syncQueues([{id:'uncertain-ui-queue',target:pane,text:'Check before retry',state:'failed',error:'Delivery unconfirmed',queued_at:Date.now()}],[],Date.now(),[...window.hs.model.agents.values()]),panes[0]);
  await page.locator('.queue-retry').click();
  assert.equal(await input.inputValue(), '', 'Inspecting an uncertain queue never prepares a duplicate prompt');
  assert((await page.locator('.reply-note').textContent()).includes('will not be resent'));
  await page.locator('.queue-clear').click();
  await page.waitForFunction(() => !document.querySelector('[data-queue-id="uncertain-ui-queue"]'));
  await page.screenshot({path: join(scratch, 'conversation-desktop.png')});
  await page.setViewportSize({width: 390, height: 844});
  await input.fill('Mobile draft');
  const layout = await page.evaluate(() => {
    const form = document.querySelector('.reply').getBoundingClientRect();
    const pre = document.querySelector('.terminal-output').getBoundingClientRect();
    return {bottom:form.bottom,height:innerHeight,width:document.documentElement.scrollWidth,viewport:innerWidth,output:pre.height};
  });
  assert(layout.bottom <= layout.height && layout.width <= layout.viewport, JSON.stringify(layout));
  assert(layout.output > 100, 'Output remains readable on mobile');
  await page.screenshot({path: join(scratch, 'conversation-mobile.png')});
  await page.evaluate(() => {
    const d = window.hs.dialog, token = d.showLaunch('Creating workspace…');
    if (!d.launchActive(token)) throw Error('Launch token should be active');
    d.close(); d.showLaunch('Starting agent…', token);
    if (!document.getElementById('dialog').hidden) throw Error('Late launch update reopened dismissed window');
  });
  assert.deepEqual(errors, []);
  console.log('PASS conversation layout, draft/scroll/recent retention, non-blocking send, same-ID retries, eager reusable uploads, mobile composer, and launch focus guard');
  console.log(`Screenshots: ${scratch}`);
} finally {
  await browser.close();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
}
