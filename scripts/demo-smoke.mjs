import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readdirSync, mkdirSync, readFileSync } from 'node:fs';
// The demo office: the real studio from public/demo/office.json, served with no bridge. This
// checks that it boots, shows its books and crew, opens a desk and the studio windows, moves on
// its own, and never reaches for /api or a socket.
const base = process.env.DEMO_URL || 'http://127.0.0.1:5173';
const snapshot = JSON.parse(readFileSync(new URL('../public/demo/office.json', import.meta.url), 'utf8'));
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [], forbidden = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => {
  const url = new URL(socket.url());
  // Vite's development reload channel is unrelated to the live bridge.
  if (url.host === new URL(base).host && url.pathname === '/' && url.searchParams.has('token')) return;
  forbidden.push(socket.url());
});
page.on('request', request => { if (/\/(api|ws)(\/|\?|$)/.test(new URL(request.url()).pathname)) forbidden.push(request.url()); });
mkdirSync('shots/demo', { recursive: true });
const text = async selector => (await page.locator(selector).first().textContent())?.trim();
try {
  await page.goto(`${base}/?demo=1&seed=5`);
  await page.waitForFunction(() => window.herdrDemo?.ready);
  await page.waitForFunction(() => { const l = document.getElementById('loading'); return !l || l.hidden || getComputedStyle(l).opacity === '0'; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'shots/demo/office.png' });
  // The books and the crew are the snapshot's, not fiction.
  assert.equal(await page.locator('#hud').isVisible(), true);
  assert.equal(await text('.hud-staff'), String(snapshot.agents.length));
  const monthly = await text('.hud-amount');
  assert.notEqual(monthly, '—', 'Revenue comes from the snapshot');
  // Every interval was captured, so the settings gear changes the figure without a bridge.
  await page.locator('.hud-settings').click();
  await page.locator('#revenue-settings-range').selectOption('7d');
  await page.waitForFunction(m => document.querySelector('.hud-amount')?.textContent !== m, monthly);
  await page.locator('#revenue-settings-range').selectOption('30d');
  await page.waitForFunction(m => document.querySelector('.hud-amount')?.textContent === m, monthly);
  await page.locator('.revenue-settings .setup-x').click();
  assert.equal(await page.locator('#demo-badge').isVisible(), true, 'The office says it is a demo');
  assert.equal(await page.locator('#hire-agent').count(), 0, 'Nothing can be hired in a snapshot');
  assert.equal(await page.locator('#offline').count(), 0, 'A snapshot is never offline');
  const starred = await page.locator('.agent-row', { hasText: '★' }).count();
  assert.ok(starred >= 1, 'Favourites are starred in the roster');
  // A desk opens onto what its terminal showed.
  await page.locator('.agent-row', { hasText: '★' }).first().click();
  await page.waitForSelector('#dialog:not([hidden])');
  await page.waitForFunction(() => (document.querySelector('#dialog .terminal-output')?.textContent ?? '').length > 20);
  await page.screenshot({ path: 'shots/demo/desk.png' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('dialog').hidden);
  // The studio windows read the curated boards and trophies.
  await page.locator('#studio-dock button', { hasText: 'Whiteboards' }).click();
  await page.waitForSelector('#studio-panel:not([hidden])');
  const boards = await page.locator('#studio-panel').innerText();
  assert.ok(snapshot.studio.projects.some(p => boards.includes(p.name)), 'A curated board is on screen');
  assert.equal(await page.evaluate(() => window.herdrDemo.model.studio.projects.length), snapshot.studio.projects.length, 'Only the curated boards exist');
  await page.screenshot({ path: 'shots/demo/boards.png' });
  await page.evaluate(() => window.herdrDemo.studio.open('trophies'));
  await page.waitForSelector('.trophy-card');
  assert.equal(await page.locator('.trophy-card').count(), Math.min(snapshot.studio.journalSummary.trophies, 40));
  await page.screenshot({ path: 'shots/demo/trophies.png' });
  await page.evaluate(() => window.herdrDemo.studio.open('people'));
  const people = await page.locator('#studio-panel').innerText();
  const generic = snapshot.studio.employees.filter(e => /^(Claude|Codex)$/.test(e.name));
  assert.deepEqual(generic, [], 'Every employee has a name of their own');
  assert.ok(people.includes(snapshot.studio.employees.find(e => e.favorite).name));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('studio-panel').hidden);
  // Left alone, the day goes on: desks start and finish real tasks.
  const before = await page.evaluate(() => window.herdrDemo.model.totalShipped);
  await page.evaluate(() => { let t = Date.now(); for (let i = 0; i < 60; i++) { t += 4000; window.herdrDemo.client.tick(t); } });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => window.herdrDemo.model.totalShipped) > before, 'The re-enactment finishes work');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shots/demo/mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile stays within viewport');
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, [], 'Demo must not call API endpoints or open a live WebSocket');
  console.log(`PASS: snapshot office with ${snapshot.agents.length} desks, ${snapshot.studio.projects.length} boards and ${snapshot.studio.journalSummary.trophies} trophies; desk and studio windows open; the day re-enacts; mobile layout; no live API/WebSocket access or page errors`);
} finally { await browser.close(); }
