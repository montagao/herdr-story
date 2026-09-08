// Public bootstrap and access regression checks, with no local .env, artwork, or real agents.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-release-'));
const project = join(scratch, 'project');
mkdirSync(project);
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const cleanEnv = { PATH: process.env.PATH, HOME: join(scratch, 'home'), TMPDIR: scratch,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_MOCK_STATIC: '1',
  HERDR_STORY_STATE_DIR: join(scratch, 'state'), HERDR_STORY_ALLOWED_ORIGINS: 'https://office.example.test' };
mkdirSync(cleanEnv.HOME);
let child, browser;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
}
async function start(writable) {
  child = spawn('bun', ['--no-env-file', 'bridge/server.ts', '--mock'], { cwd: project,
    env: { ...cleanEnv, HERDR_STORY_WRITE: writable ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Mock bridge exited: ${output}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Mock bridge did not start: ${output}`);
}
async function socket(origin, expected) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, { origin });
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('WebSocket timeout')); }, 4000);
    ws.on('error', error => { clearTimeout(timeout); reject(error); });
    ws.on('unexpected-response', (_, response) => {
      clearTimeout(timeout); response.resume(); ws.terminate();
      try { assert.equal(response.statusCode, expected); resolve(); } catch (error) { reject(error); }
    });
    ws.on('open', () => {
      clearTimeout(timeout); ws.close();
      try { assert.equal(expected, 101); resolve(); } catch (error) { reject(error); }
    });
  });
}
try {
  execFileSync('npm', ['run', 'build:public', '--', '--outDir', join(project, 'dist')], { stdio: 'pipe' });
  assert.equal(existsSync(join(project, 'dist/assets/gds')), false, 'Public build excludes private artwork');
  for (const path of ['bridge', 'shared', 'src', 'package.json']) cpSync(path, join(project, path), { recursive: true });
  symlinkSync(resolve('node_modules'), join(project, 'node_modules'), 'dir');
  await start(true);
  for (const path of ['/api/state', '/api/call', '/api/image', '/api/setup', '/api/revenuecat/webhook', '/api/seatmap']) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403, `${path} rejects a foreign browser`);
  }
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/state`, { headers: { Host: `rebound.example:${port}` } }, response => {
      response.resume(); resolve(response.statusCode);
    }); req.on('error', reject); req.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(`${base}/api/image`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: 'x' })).status, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { origin: 'https://office.example.test' } })).status, 200);
  await socket(base, 101);
  await socket('https://evil.example', 403);
  console.log('PASS HTTP/WebSocket origin gates, trusted proxy, and DNS rebinding rejection');

  let executablePath = process.env.PW_EXE;
  if (!executablePath && !existsSync(chromium.executablePath())) {
    const cache = join(homedir(), '.cache/ms-playwright');
    if (existsSync(cache)) executablePath = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort()
      .map(d => join(cache, d, 'chrome-headless-shell-linux64/chrome-headless-shell')).filter(existsSync).pop();
  }
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__herdrReady && document.querySelectorAll('.agent-row').length);
  assert.ok(await page.locator('body').evaluate(el => el.classList.contains('roster-only')));
  await page.locator('.agent-row').first().click();
  await page.waitForSelector('#dialog:not([hidden])');
  await page.waitForFunction(() => document.querySelector('.terminal-output')?.textContent?.trim().length > 20);
  assert.equal(await page.locator('#dialog textarea').first().isEnabled(), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#dialog[hidden]', { state: 'attached' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile does not overflow');
  assert.ok(await page.evaluate(() => document.getElementById('feed').getBoundingClientRect().height >= innerHeight * .95), 'Roster fills mobile screen');
  assert.ok(await page.locator('.agent-row').first().evaluate(el => el.getBoundingClientRect().bottom < innerHeight), 'First agent is visible below the introduction');
  mkdirSync('shots/release', { recursive: true });
  await page.screenshot({ path: 'shots/release/roster-mobile.png' });
  console.log('PASS missing-art roster, existing-agent chat, Escape and mobile layout');

  const demo = await browser.newPage();
  const forbidden = [];
  demo.on('request', req => { if (/\/(api|ws)(\/|\?|$)/.test(new URL(req.url()).pathname)) forbidden.push(req.url()); });
  demo.on('websocket', ws => forbidden.push(ws.url()));
  demo.on('pageerror', error => errors.push(error.message));
  await demo.goto(`${base}/?demo=1`);
  await demo.waitForFunction(() => window.__herdrReady && document.querySelectorAll('.agent-row').length === 4);
  await demo.locator('.agent-row').first().click();
  await demo.waitForSelector('#dialog:not([hidden])');
  assert.equal(await demo.evaluate(() => window.hs.dialog.writable), false);
  assert.deepEqual(forbidden, [], 'Fictional demo does not access the bridge');
  assert.deepEqual(errors, [], 'No unhandled browser errors');
  console.log('PASS fictional demo is read-only and makes no bridge requests');
  await browser.close(); browser = undefined;
  await stop(); await start(false);
  assert.equal((await fetch(`${base}/api/seatmap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"items":[]}' })).status, 403);
  assert.equal(existsSync(join(project, 'seatmap.json')), false, 'Read-only seatmap did not write');
  console.log('PASS read-only layout write rejection');
} finally {
  await browser?.close(); await stop(); rmSync(scratch, { recursive: true, force: true });
}
