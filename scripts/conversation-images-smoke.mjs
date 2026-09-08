// Isolated bridge: upload real images, but never send a prompt to a real agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-conversation-images-'));
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: join(scratch, 'state'), HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: '1', HERDR_STORY_WEBHOOK_PORT: '',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', chunk => appendFileSync(join(scratch, 'bridge.log'), chunk));
server.stderr.on('data', chunk => appendFileSync(join(scratch, 'bridge.log'), chunk));
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
const url = `http://127.0.0.1:${port}`, uploads = [], errors = [];
const bytes = [...readFileSync('public/assets/open/decor/zephilie-desk-plant.png')];
let releaseUpload, holdUpload = true, failUpload = false, attempts = 0;
let page;
try {
  for (let n = 0; n < 80; n++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/image', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    if (holdUpload) await new Promise(resolve => releaseUpload = resolve);
    if (failUpload) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Upload unavailable for test' }) });
    const response = await route.fetch(); const body = await response.json();
    assert(response.ok(), JSON.stringify(body)); uploads.push(body.path);
    await route.fulfill({ response });
  });
  const open = async (turns = []) => {
    await page.waitForFunction(() => window.hs?.studio?.agents.length);
    await page.evaluate(async turns => {
      const client = window.hs.client, original = client.call.bind(client);
      window.imageTest = { turns, prompts: [] };
      client.watchOutput = () => () => {};
      client.call = async (method, params, options) => {
        if (method === 'agent.transcript') return { available: true, turns: window.imageTest.turns };
        if (method === 'agent.read') return { read: { text: 'Ready for an image.' } };
        if (method === 'agent.prompt') { window.imageTest.prompts.push(params); return { state: 'sent' }; }
        return original(method, params, options);
      };
      await window.hs.dialog.open([...window.hs.model.agents.values()][0]);
    }, turns);
    await page.waitForFunction(() => document.querySelector('.transcript-output')?.dataset.loaded === 'true');
  };
  const paste = () => page.locator('.reply textarea').evaluate((input, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], 'plant.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, bytes);
  await page.goto(url); await open();
  await paste();
  await page.waitForFunction(() => document.querySelector('.attachment-status')?.textContent === 'uploading…');
  assert.equal(await page.evaluate(() => window.imageTest.prompts.length), 0);
  while (!releaseUpload) await new Promise(r => setTimeout(r, 10));
  holdUpload = false; releaseUpload();
  await page.waitForFunction(() => document.querySelector('.attachment-status')?.textContent === 'uploaded');
  assert.match(await page.locator('.reply-note').textContent(), /uploaded.*ready to send/i);
  await page.locator('.reply textarea').fill('Can you fix this plant?');
  await page.locator('.reply button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.prompt-echo')?.dataset.deliveryState === 'accepted');
  const echo = page.locator('.prompt-echo');
  assert(await echo.isVisible(), 'Uploaded image stays visible while saved transcript catches up');
  assert.equal(await echo.locator('.message-image small').textContent(), 'Uploaded');
  assert.equal(attempts, 1, 'Send reuses the eager upload');
  assert((await page.evaluate(() => window.imageTest.prompts[0].text)).includes(uploads[0]));
  assert.equal((await fetch(`${url}/api/image?path=${encodeURIComponent(uploads[0])}`)).status, 200);
  assert.equal((await fetch(`${url}/api/image?path=${encodeURIComponent('/etc/passwd')}`)).status, 404);

  const turns = [{ prompt: 'Can you fix this plant?', reply: 'I can see the uploaded plant image.', images: [{ name: 'plant.png', path: uploads[0], url: '/api/image?path=' + encodeURIComponent(uploads[0]) }] }];
  await page.evaluate(async turns => {
    window.imageTest.turns = turns;
    const d = window.hs.dialog; await d.refreshTranscript(d.currentAgent, d.generation);
  }, turns);
  await page.waitForFunction(() => document.querySelector('.turn-images img')?.naturalWidth > 0);
  assert.equal(await echo.isVisible(), false, 'Saved attachment replaces the temporary upload receipt');
  const card = page.locator('.turn-images .message-image').first();
  assert.equal(await card.locator('small').textContent(), 'Attached');
  await card.click();
  assert(await page.locator('.attachment-viewer').isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.attachment-viewer').count(), 0);
  assert(await page.locator('#dialog').isVisible(), 'Escape closes only the enlarged image');
  await page.evaluate(async () => { const d = window.hs.dialog, a = d.currentAgent; d.close(); await d.open(a); });
  await page.waitForFunction(() => document.querySelector('.turn-images img')?.naturalWidth > 0);

  // A full reload loses all object URLs; history still uses the saved attachment endpoint.
  await page.reload(); await open(turns);
  await page.waitForFunction(() => document.querySelector('.turn-images img')?.naturalWidth > 0);
  assert((await card.locator('img').getAttribute('src')).startsWith('/api/image?'));
  await page.screenshot({ path: join(scratch, 'conversation-images-desktop.png') });

  // A deleted old file or an inline-only image must stay acknowledged without a broken img.
  const unavailable = { prompt: 'Two older attachments', images: [{ name: 'missing.png', url: '/api/image?path=' + encodeURIComponent('/tmp/herdr-story-images/deleted-test.png') }, { name: 'Inline image' }] };
  await page.evaluate(async turn => {
    window.imageTest.turns.push(turn); const d = window.hs.dialog; await d.refreshTranscript(d.currentAgent, d.generation);
  }, unavailable);
  await page.waitForFunction(() => document.querySelectorAll('.preview-unavailable').length === 2);
  assert.equal(await page.locator('.turn:last-child img').count(), 0);
  assert.equal(await page.locator('.turn:last-child .message-image').count(), 2);
  assert((await page.locator('.turn:last-child').textContent()).includes('Attached · preview unavailable'));

  // Failed eager upload is visible; sending retries and keeps a usable confirmation.
  failUpload = true; await paste();
  await page.waitForFunction(() => document.querySelector('.attachment-status')?.textContent === 'retry on send');
  assert.match(await page.locator('.reply-note').textContent(), /upload failed/i);
  failUpload = false;
  await page.locator('.reply textarea').fill('Retry this image'); await page.locator('.reply button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.prompt-echo')?.dataset.deliveryState === 'accepted');
  assert.equal(attempts, 3);
  assert.equal(await page.locator('.prompt-echo .message-image small').textContent(), 'Uploaded');
  assert(await page.locator('.prompt-echo').isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, bottom: document.querySelector('.reply').getBoundingClientRect().bottom, height: innerHeight }));
  assert(layout.width <= layout.viewport && layout.bottom <= layout.height, JSON.stringify(layout));
  await page.screenshot({ path: join(scratch, 'conversation-images-mobile.png') });
  await page.locator('.prompt-echo .message-image').click();
  const viewer = await page.locator('.attachment-viewer').boundingBox();
  assert(viewer.width <= 390 && viewer.height <= 844, JSON.stringify(viewer));
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('PASS conversation images: real upload/status, persistent thumbnails, reload, failed upload retry, missing previews, image viewer/Escape, and mobile layout');
  console.log(`Screenshots: ${scratch}`);
} catch (error) {
  console.error({ errors, scratch });
  if (page) { await page.screenshot({ path: join(scratch, 'failure.png') }); console.error(await page.evaluate(() => ({ ready: window.__herdrReady, hs: Object.keys(window.hs || {}), loading: document.querySelector('#loading')?.textContent }))); }
  throw error;
} finally {
  await browser.close();
  for (const path of uploads) if (path?.startsWith(join(tmpdir(), 'herdr-story-images') + '/')) rmSync(path, { force: true });
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
}
