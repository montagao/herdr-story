// Exercise the terminal against an isolated mock bridge; never start a live agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-free-agent-'));
const projects = join(scratch, 'projects'); mkdirSync(projects);
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const children = [];
const freePort = () => new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
async function start(writable, cwd = projects) {
  const port = await freePort();
  const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
    HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: join(scratch, String(port)),
    HERDR_STORY_PROJECTS_DIR: cwd, HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: writable ? '1' : '0',
    STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw Error(output);
    try { const response = await fetch(`${url}/health`); if (response.ok) { assert.equal((await response.json()).mock, true); return url; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Mock did not start: ${output}`);
}
const call = async (url, method, params = {}) => (await fetch(`${url}/api/call`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call', id: 'test', method, params }),
})).json();
const ready = async page => {
  await page.waitForFunction(() => window.hs?.studio?.state?.employees.length && window.hs.office.furnishings.items.length);
  await page.locator('#loading').waitFor({ state: 'hidden' });
};
async function terminalPoint(page) {
  await page.evaluate(() => {
    const office = window.hs.office, furniture = office.furnishings;
    // Ensure even a small mock office has a terminal; this edits only the browser's unsaved room.
    let item = furniture.items.find(i => i.asset === 'zephilie-retro-terminal');
    if (!item) { furniture.add('decor', 'zephilie-retro-terminal'); item = furniture.items.find(i => i.asset === 'zephilie-retro-terminal'); }
    office.cameras.main.setZoom(3); office.cameras.main.centerOn(item.x, item.y - 22);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => {
    const office = window.hs.office, item = office.furnishings.items.find(i => i.asset === 'zephilie-retro-terminal');
    const camera = office.cameras.main, rect = office.game.canvas.getBoundingClientRect();
    return { x: rect.left + camera.width / 2 + (item.x - camera.scrollX - camera.width / 2) * camera.zoom,
      y: rect.top + camera.height / 2 + (item.y - 22 - camera.scrollY - camera.height / 2) * camera.zoom };
  });
}
const browser = await chromium.launch({ executablePath });
try {
  const url = await start(true), page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(12000);
  await page.goto(url); await ready(page);
  const before = await page.evaluate(() => window.hs.model.agents.size);
  let point = await terminalPoint(page);
  await page.evaluate(() => window.hs.office.furnishings.startEdit());
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.evaluate(() => window.hs.model.agents.size), before);
  assert(await page.evaluate(() => !!window.hs.office.furnishings.selected));
  await page.evaluate(() => window.hs.office.furnishings.stopEdit());
  // A rejected request should show its error and leave the control available for retry.
  await page.evaluate(() => {
    const client = window.hs.client, original = client.call.bind(client);
    client.call = (method, params) => {
      if (method === 'agent.free') { client.call = original; return Promise.reject(Error('Launch unavailable')); }
      return original(method, params);
    };
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => document.getElementById('studio-toast').textContent.includes('Launch unavailable'));
  assert.equal(await page.evaluate(() => window.hs.model.agents.size), before);
  await page.evaluate(() => window.hs.dialog.close());
  // Delay the response so two physical clicks definitely overlap the launch.
  await page.evaluate(() => {
    const client = window.hs.client, original = client.call.bind(client); window.freeCalls = 0;
    client.call = async (method, params) => {
      if (method === 'agent.free') { window.freeCalls++; await new Promise(resolve => setTimeout(resolve, 250)); }
      return original(method, params);
    };
  });
  await page.mouse.dblclick(point.x, point.y, { delay: 30 });
  await page.waitForFunction(() => [...window.hs.model.agents.values()].some(a => a.office_name === 'Free agent'));
  await page.waitForFunction(() => window.hs.dialog.openPane);
  const agent = await page.evaluate(() => [...window.hs.model.agents.values()].find(a => a.office_name === 'Free agent'));
  assert.equal(agent.name, 'free-agent', 'Herdr gets a lowercase name without spaces');
  assert.equal(agent.cwd, projects); assert.equal(agent.agent, 'codex'); assert.equal(agent.agent_status, 'idle');
  assert.equal(await page.evaluate(() => window.freeCalls), 1);
  assert.equal(await page.evaluate(() => window.hs.model.agents.size), before + 1);
  assert.equal(await page.evaluate(() => window.hs.dialog.openPane), agent.pane_id);
  assert.equal(await page.locator('.hire-form').count(), 0);
  const terminal = await call(url, 'agent.read', { target: agent.pane_id });
  assert(!terminal.result.read.text.includes('› '), 'No initial prompt');
  await page.screenshot({ path: join(scratch, 'free-agent.png') });
  console.log('PASS terminal click launches one idle Codex in projects and opens its conversation; editing and errors are handled');

  const second = await call(url, 'agent.free', { cwd: '/different', kind: 'claude', task: 'Do work', model: 'override' });
  assert.equal(second.result.agent.cwd, projects); assert.equal(second.result.kind, 'codex');
  assert.equal(second.result.name, 'Free agent 2'); assert.equal(second.result.prompted, false);
  assert.equal(second.result.agent.name, 'free-agent-2'); assert.equal(second.result.agent.office_name, 'Free agent 2');
  assert.notEqual(second.result.agent.model, 'override');
  console.log('PASS subsequent agents have distinct names, and browser parameters cannot override the terminal launch');

  const hired = await Promise.all(['Build.v2', 'Build v2'].map(name => call(url, 'agent.hire', { mode: 'new', kind: 'codex', name, task: '', cwd: projects })));
  assert(hired.every(h => !h.error), JSON.stringify(hired));
  assert.deepEqual(hired.map(h => h.result.agent.name).sort(), ['build-v2', 'build-v2-2']);
  assert.deepEqual(hired.map(h => h.result.agent.office_name), ['Build.v2', 'Build v2']);
  await page.reload(); await ready(page);
  await page.waitForFunction(() => [...window.hs.model.agents.values()].some(a => a.office_name === 'Free agent 2'));
  console.log('PASS concurrent hires reserve distinct valid names and friendly labels survive reload');

  const readOnlyUrl = await start(false), readOnlyPage = await browser.newPage();
  await readOnlyPage.goto(readOnlyUrl); await ready(readOnlyPage);
  point = await terminalPoint(readOnlyPage); await readOnlyPage.mouse.click(point.x, point.y);
  await readOnlyPage.waitForFunction(() => document.getElementById('studio-toast').textContent.includes('read-only'));
  assert((await call(readOnlyUrl, 'agent.free')).error);
  const invalidUrl = await start(true, 'relative/projects');
  assert((await call(invalidUrl, 'agent.free')).error.message.includes('absolute path'));
  assert.deepEqual(errors, []);
  console.log('PASS read-only UI and API enforcement, invalid directory rejection, and no browser errors');
} finally {
  await browser.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve); child.kill();
  })));
}
