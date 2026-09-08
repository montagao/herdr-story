// Isolated UI regression: prompt calls are captured, never sent to a real agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const scratch = mkdtempSync(join(tmpdir(), 'herdr-pasted-text-'));
const port = await new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const n = socket.address().port; socket.close(() => resolve(n)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: join(scratch, 'state'), HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: '1',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
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
  const pane = await page.evaluate(async () => {
    const agent = window.hs.studio.agents.find(a => (a.display_agent || a.agent) === 'claude');
    window.promptCalls = []; window.rejectNextPrompt = false;
    const client = window.hs.client, original = client.call.bind(client);
    client.call = async (method, params) => {
      if (['agent.prompt', 'agent.queue'].includes(method)) {
        window.promptCalls.push({ method, params });
        if (window.rejectNextPrompt) { window.rejectNextPrompt = false; throw Error('Test send failure'); }
        return { state: method === 'agent.queue' ? 'queued' : 'sent' };
      }
      return original(method, params);
    };
    await window.hs.dialog.open(agent); return agent.pane_id;
  });
  const input = page.locator('.reply textarea');
  const fullWidth = async state => {
    const dimensions = await input.evaluate(input => {
      const form = input.closest('.reply'), rect = input.getBoundingClientRect();
      const available = innerWidth <= 820 ? form.clientWidth : parseFloat(getComputedStyle(form).gridTemplateColumns);
      return { actual: rect.width, available, right: rect.right, formRight: form.getBoundingClientRect().right };
    });
    assert(dimensions.actual >= dimensions.available - 4, `${state}: prompt fills its column (${JSON.stringify(dimensions)})`);
    assert(dimensions.right <= dimensions.formRight + 1, `${state}: prompt stays within composer`);
  };
  await fullWidth('Empty desktop prompt');
  await input.fill('x'.repeat(600)); await input.press('End'); await input.press('y');
  assert.equal(await input.evaluate(e => document.activeElement === e), true, 'Crossing the fold threshold keeps typing focused');
  await input.press('z'); assert.equal((await input.inputValue()).length, 602);
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i}: keep every word, including <script> and **Markdown**.`).join('\n');
  const paste = async (text, locator = input) => locator.evaluate((input, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await input.fill('Before REPLACE after'); await input.evaluate(e => e.setSelectionRange(7, 14));
  await paste(long); const exact = `Before ${long} after`;
  assert.equal(await input.inputValue(), exact);
  assert.equal(await page.locator('.pasted-draft').getAttribute('open'), null);
  assert.equal(await input.isVisible(), false);
  assert((await page.locator('.pasted-draft summary').innerText()).includes('60 lines'));
  await page.locator('.pasted-draft summary').click(); assert(await input.isVisible());
  await fullWidth('Expanded long draft');
  await input.fill(`${exact}\nEdited`); await page.locator('.reply button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.prompt-echo:last-child > div:first-child span').textContent === 'accepted');
  await fullWidth('Empty prompt after sending long text');
  await page.screenshot({ path: join(scratch, 'desktop-prompt.png') });
  assert.equal(await page.evaluate(() => window.promptCalls.at(-1).params.text), `${exact}\nEdited`);
  assert.equal(await page.locator('.prompt-echo:last-child .pasted-text').getAttribute('open'), null);
  assert((await page.locator('.prompt-echo:last-child').boundingBox()).height < 110);
  await page.locator('.prompt-echo:last-child summary').click();
  assert.equal(await page.locator('.prompt-echo:last-child .prompt-full-text').textContent(), `${exact}\nEdited`);
  assert((await page.locator('.prompt-echo:last-child .prompt-full-text').boundingBox()).height <= 180);
  assert.equal(await page.locator('.prompt-echo script').count(), 0);
  await page.locator('.prompt-echo:last-child summary').click();
  console.log('PASS paste selection, compact draft, editing, exact sent text, bounded expansion, and safe literal text');

  await input.fill(''); await paste(long); await page.locator('.reply [data-queue]').click();
  await page.waitForFunction(() => window.promptCalls.at(-1).method === 'agent.queue');
  assert.equal(await page.evaluate(() => window.promptCalls.at(-1).params.text), long);
  assert.equal(await page.locator('.queued-prompt .pasted-text').getAttribute('open'), null);
  await page.evaluate(async pane => { window.hs.dialog.close(); await window.hs.dialog.open(window.hs.model.agents.get(pane)); }, pane);
  assert.equal(await page.locator('.queued-prompt .prompt-full-text').textContent(), long);
  assert.equal(await page.locator('.queued-prompt .pasted-text').getAttribute('open'), null);
  await page.evaluate(() => { window.rejectNextPrompt = true; });
  await paste(long); await page.locator('.reply button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.reply-note').textContent.includes('Test send failure'));
  assert.equal(await input.inputValue(), long);
  assert.equal(await page.locator('.pasted-draft').getAttribute('open'), null);
  await page.locator('.pasted-draft summary').click(); await input.fill('Keep this');
  await fullWidth('Short prompt after editing a long draft');
  await paste('x'.repeat(20001)); assert.equal(await input.inputValue(), 'Keep this');
  assert((await page.locator('.reply-note').innerText()).includes('Nothing was pasted'));
  console.log('PASS queued text survives reopening, failed sends restore the complete compact draft, and oversized pastes are rejected intact');

  await input.evaluate(input => {
    const data = new DataTransfer(); data.setData('text/plain', 'image caption '.repeat(100));
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'test.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.equal(await page.locator('.reply-attachment').count(), 1); assert.equal(await input.inputValue(), 'Keep this');
  await page.locator('.remove-image').click();
  await input.fill(''); await paste(long);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.pasted-draft summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(scratch, 'mobile.png') });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('.reply button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.prompt-echo:last-child > div:first-child span').textContent === 'accepted');
  await fullWidth('Empty mobile prompt after sending');
  assert((await page.locator('.prompt-echo:last-child').boundingBox()).height < 130);
  await page.screenshot({ path: join(scratch, 'mobile-sent.png') });
  await page.evaluate(() => window.hs.dialog.close()); await page.locator('#hire-agent').click();
  const task = page.locator('.hire-task textarea'); await paste(long, task);
  assert.equal(await task.inputValue(), long); assert.equal(await task.isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('PASS image paste coexistence, compact mobile rendering, and first-task composer; no browser errors');
  console.log(`Screenshots: ${scratch}`);
} finally {
  await browser.close();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
}
