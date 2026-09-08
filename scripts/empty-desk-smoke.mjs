// Isolated browser regression: the bridge is mocked and every save goes to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-empty-desk-'));
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
const ready = async p => {
  await p.waitForFunction(() => window.hs?.studio?.state?.employees.length && window.hs.office.furnishings.items.length);
  await p.locator('#loading').waitFor({ state: 'hidden' });
};
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url); await ready(page);
  const expected = await page.evaluate(() => {
    const office = window.hs.office;
    const pod = office.pods.find(p => p.stations.some(s => !s.agent) && p.stations.some(s => s.agent));
    const desk = pod.stations.find(s => !s.agent);
    window.testEmptyDesk = desk;
    office.cameras.main.setZoom(3).centerOn(desk.assignButton.x, desk.assignButton.y);
    return pod.stations.find(s => s.agent).agent.workspace_id;
  });
  await page.waitForTimeout(150);
  const point = await page.evaluate(() => {
    const desk = window.testEmptyDesk, camera = window.hs.office.cameras.main;
    if (desk.workspaceTag.visible || !desk.assignButton.visible) throw Error('Incorrect empty-desk marker');
    return { x: camera.x + (desk.assignButton.x - camera.worldView.x) * camera.zoom,
      y: camera.y + (desk.assignButton.y - 0 - camera.worldView.y) * camera.zoom };
  });
  await page.mouse.move(point.x, point.y);
  await page.waitForFunction(() => window.testEmptyDesk.assignTag.visible);
  await page.screenshot({ path: join(scratch, 'assign-hover.png') });
  await page.mouse.click(point.x, point.y);
  await page.waitForSelector('.hire-win');
  assert.equal(await page.locator('[name="workspace_id"]').inputValue(), expected);
  await page.screenshot({ path: join(scratch, 'assign-window.png') });
  await page.evaluate(() => {
    window.hs.dialog.close();
    const st = window.testEmptyDesk;
    const agent = [...window.hs.model.agents.values()][0];
    st.setAgent(agent);
    if (st.assignButton.visible) throw Error('Occupied desk still invites assignment');
    st.setAgent(null);
    if (!st.assignButton.visible || !st.assignButton.input.enabled) throw Error('Vacated desk is not assignable');
    window.hs.dialog.writable = false; st.refreshAssignment();
    if (st.assignButton.visible || st.assignButton.input.enabled) throw Error('Read-only desk permits hiring');
  });
  console.log('PASS empty-desk hover, real canvas click, correct workspace, occupied/vacated transitions and read-only gating');
  console.log(`Screenshots: ${scratch}`);
} finally { await browser.close(); for (const child of children) await stop(child); }
