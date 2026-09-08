// Isolated browser regression: the bridge is mocked and every save goes to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-settings-browser-'));
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
const call = (p, method, params) => p.evaluate(async ({ method, params }) => {
  try { return { result: await window.hs.client.call(method, params) }; }
  catch (error) { return { error: error.message }; }
}, { method, params });
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await ready(page);
  await page.locator('#hire-agent').click();
  await page.waitForFunction(() => document.querySelector('[name="effort"]').options.length > 1);
  await page.locator('[name="model"]').fill('gpt-5.6-sol');
  await page.locator('[name="effort"]').selectOption('high');
  await page.locator('[name="kind"]').selectOption('gemini');
  assert.equal(await page.locator('.hire-settings').isVisible(), false);
  await page.locator('[name="kind"]').selectOption('codex');
  await page.waitForFunction(() => document.querySelector('[name="effort"]').options.length > 1);
  assert.equal(await page.locator('[name="model"]').inputValue(), '');
  await page.locator('[name="name"]').fill('Settings test');
  await page.locator('[name="model"]').fill('gpt-5.6-sol');
  await page.locator('[name="effort"]').selectOption('high');
  await page.screenshot({ path: join(scratch, 'hire-settings.png') });
  await page.locator('.hire-form button[type="submit"]').click();
  await page.waitForFunction(() => [...window.hs.model.agents.values()].some(a => a.office_name === 'Settings test'));
  const hired = await page.evaluate(() => [...window.hs.model.agents.values()].find(a => a.office_name === 'Settings test'));
  assert.equal(hired.name, 'settings-test');
  assert.equal(hired.model, 'gpt-5.6-sol');
  await page.waitForFunction(() => document.querySelector('.hire-win') === null || document.querySelector('.hire-win').closest('[hidden]'));
  await page.evaluate(pane => window.hs.dialog.open(window.hs.model.agents.get(pane)), hired.pane_id);
  await page.locator('.conversation-details > summary').click();
  await page.locator('.live-agent-settings summary').click();
  await page.waitForFunction(() => document.querySelector('[name="effort"]').options.length > 1);
  await page.locator('[name="model"]').fill('gpt-5.6-terra');
  await page.locator('[data-apply-setting="model"]').click();
  await page.waitForFunction(() => document.querySelector('.agent-settings-note').textContent.includes('Mock settings applied'));
  await page.waitForFunction(pane => window.hs.model.agents.get(pane).model === 'gpt-5.6-terra', hired.pane_id);
  await page.locator('[name="effort"]').selectOption('medium');
  await page.locator('[data-apply-setting="effort"]').click();
  await page.waitForFunction(() => document.querySelector('.agent-settings-note').textContent.includes('medium effort'));
  await page.screenshot({ path: join(scratch, 'live-settings.png') });
  const invalid = await call(page, 'agent.settings.update', { target: hired.pane_id, model: 'x\n/exit' });
  assert.match(invalid.error, /valid model/);
  const missing = await call(page, 'agent.settings.update', { target: 'missing', effort: 'high' });
  assert.match(missing.error, /no longer active/);
  const claude = await page.evaluate(() => [...window.hs.model.agents.values()].find(a => a.agent === 'claude' && a.agent_status === 'working'));
  assert.ok(claude);
  const busy = await call(page, 'agent.settings.update', { target: claude.pane_id, model: 'sonnet' });
  assert.match(busy.error, /ready for input/);
  const readPort = await freePort(); await startBridge(readPort, join(scratch, 'read-only'), false);
  for (const method of ['agent.settings.update', 'agent.settings.picker', 'agent.hire']) {
    const response = await fetch(`http://127.0.0.1:${readPort}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call', id: method, method, params: { target: hired.pane_id, model: 'sonnet' } }) });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(errors, []);
  console.log('PASS hiring model/effort, provider switching, live changes, validation, busy Claude and read-only protection');
  console.log(`Settings screenshots: ${scratch}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
  console.error(`Failure artifacts: ${scratch}`); throw error;
} finally { await browser.close(); for (const child of children) await stop(child); }
