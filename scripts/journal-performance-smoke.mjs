// Isolated browser regression: the bridge is mocked and every save goes to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-studio-browser-'));
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
mkdirSync(stateDir);
const memories = Array.from({ length: 245 }, (_, n) => ({ id: `memory-${n}`, version: 0, at: Date.now() - 1_000_000 + n * 1000,
  kind: n === 3 ? 'release' : 'note', title: n === 3 ? 'Forgotten launch record' : n === 7 ? 'Deep archived record' : `Memory ${n}`,
  notes: `Saved historical work ${n}`, project: '', contributors: [], url: '', source: 'manual' }));
writeFileSync(join(stateDir, 'studio.json'), JSON.stringify({ version: 1, revision: 0, employees: [], projects: [], journal: memories,
  room: { version: 0, items: null, projectOrder: [] }, identities: {}, observations: {}, imports: [] }));
const server = await startBridge(port, stateDir);
const browser = await chromium.launch({ executablePath });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.hs?.studio?.state?.journalTotal === 245 && window.hs.office.furnishings.items.length);
  assert.equal(await page.evaluate(() => window.hs.model.studio.journal.length), 100);
  assert.equal(await page.evaluate(() => window.hs.model.studio.journalSummary.trophies), 1);
  await page.locator('#studio-dock [data-page="trophies"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.trophy-card')].some(e => e.textContent.includes('Forgotten launch record')));
  await page.locator('.studio-tabs [data-tab="journal"]').click();
  await page.locator('[data-journal-search]').fill('Deep archived record');
  await page.waitForFunction(() => document.querySelector('.journal-entries').textContent.includes('Deep archived record'));
  assert.equal(await page.locator('.journal-row').count(), 1);
  console.log('PASS compact 100-entry snapshot, full trophy count, remote trophy/filter search');
  await page.evaluate(() => {
    window.historyReadCount = 0;
    const call = window.hs.client.call.bind(window.hs.client);
    window.hs.client.call = (method, ...args) => {
      if (method === 'studio.journal') window.historyReadCount++;
      return call(method, ...args);
    };
  });
  await page.locator('[data-journal-search]').fill('');
  await page.locator('[data-older-history]').click();
  await page.waitForFunction(() => window.hs.studio.state.journal.length >= 200 && !window.hs.studio.historyLoading);
  await page.locator('[data-older-history]').click();
  await page.waitForFunction(() => window.hs.studio.state.journal.length === 245 && !window.hs.studio.historyLoading);
  assert.equal(await page.locator('[data-older-history]').count(), 0);
  const finishedReads = await page.evaluate(() => window.historyReadCount);
  await page.waitForTimeout(400); // The search debounce must not restart exhausted pagination.
  assert.equal(await page.evaluate(() => window.historyReadCount), finishedReads);
  assert.equal(await page.locator('[data-older-history]').count(), 0);
  const edited = await fetch(`${url}api/call`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'call', id: 'edit-old-memory', method: 'studio.change', params: { op: 'entry.save', id: 'memory-3', version: 0,
      title: 'Launch record revised in another browser', notes: 'The original artifact has been corrected.', kind: 'release', project: '', contributors: [], url: '' } }) });
  assert.equal(edited.status, 200);
  await page.waitForFunction(() => window.hs.studio.state.journal.find(e => e.id === 'memory-3')?.title === 'Launch record revised in another browser');
  const response = await fetch(`${url}api/call`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'call', id: 'remove-old-memory', method: 'studio.change', params: { op: 'entry.remove', id: 'memory-7', version: 0 } }) });
  assert.equal(response.status, 200);
  await page.waitForFunction(() => window.hs.model.studio.journalTotal === 244 && !window.hs.studio.state.journal.some(e => e.id === 'memory-7'));
  await page.locator('[data-journal-search]').fill('Deep archived record');
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.journal-row').count(), 0);
  const retained = await page.evaluate(() => window.hs.studio.state.journal.some(e => e.id === 'memory-3'));
  assert.equal(retained, true, 'Other fetched pages survive compact updates');
  assert.deepEqual(errors, []);
  console.log('PASS on-demand older pages, no duplicate entries, cached pages refresh cross-browser edits and survive compact updates without resurrecting deleted memories');
  console.log(`Journal artifacts: ${scratch}`);
} finally { await browser.close(); for (const child of children) await stop(child); }
