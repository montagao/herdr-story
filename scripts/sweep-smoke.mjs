import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync('/tmp/herdr-sweep-browser-');
const cache = process.env.HOME + '/.cache/ms-playwright';
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const children = [];
async function start(writable) {
  const port = await freePort(), state = `${scratch}/${writable ? 'writable' : 'readonly'}-${port}`;
  execFileSync('bun', ['scripts/sweep-fixture.ts', state]);
  const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env, HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1',
    HERDR_STORY_STATE_DIR: state, HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: writable ? '1' : '0',
    STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let logs = ''; child.stdout.on('data', chunk => logs += chunk); child.stderr.on('data', chunk => logs += chunk);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { const health = await (await fetch(url + '/health')).json(); if (health.agents === 12 && health.mock) return { url, child, state }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(logs);
}
const api = async (url, method, params = {}) => {
  const r = await fetch(url + '/api/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call', method, params }) });
  return { status: r.status, body: await r.json() };
};
const browser = await chromium.launch({ executablePath });
try {
  const live = await start(true);
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(live.url); await page.locator('#studio-dock [data-sweep]').click();
  assert.equal(await page.locator('#studio-dock [data-sweep]').textContent(), 'Re-org');
  await page.waitForFunction(() => document.querySelector('[data-agent="w2:p1"]')?.disabled === false);
  assert.equal(await page.locator('[data-agent="w1:p1"]').count(), 0, 'Working agent omitted');
  assert.equal(await page.locator('[data-agent="w5:p1"]').isDisabled(), true, 'Recent idle agent kept');
  assert.match(await page.locator('.sweep-tally').innerText(), /2 agents ready/);
  await page.locator('[data-minutes="1440"]').click();
  await page.waitForFunction(() => document.querySelector('[data-agent="w2:p1"]')?.disabled === true);
  await page.locator('[data-minutes="60"]').click();
  await page.waitForFunction(() => document.querySelector('[data-agent="w2:p1"]')?.disabled === false);
  await page.screenshot({ path: scratch + '/scan-desktop.png' });
  await page.locator('[data-agent="w2:p1"]').check();
  await page.locator('[data-prepare]').click(); await page.waitForSelector('[data-finish="save"]:not(:disabled)');
  assert.match(await page.locator('.sweep-close-summary').innerText(), /proj1 studio/);
  await page.screenshot({ path: scratch + '/review-desktop.png' });
  await page.locator('[data-finish="save"]').click(); await page.waitForSelector('[data-journal]');
  assert.match(await page.locator('.sweep-complete').innerText(), /1 recap saved/);
  assert((await (await fetch(live.url + '/api/state')).json()).agents.some(a => a.pane_id === 'w2:p1'));
  assert.equal(await page.locator('#reorg-cutscene').count(), 0, 'Saving alone never plays a cutscene');
  const first = (await api(live.url, 'studio.journal', { search: 'Re-org' })).body.result;
  assert.equal(first.entries.length, 1); assert.match(first.entries[0].notes, /## Last findings/);
  await page.locator('[data-journal]').click(); await page.waitForSelector('.journal-entries');
  await page.waitForFunction(() => document.querySelector('.journal-entries')?.textContent.includes('Re-org'));
  await page.locator('#studio-panel [data-close]').click();

  await page.setViewportSize({ width: 390, height: 844 });
  const dock = await page.locator('#studio-dock').boundingBox(); assert(dock.x >= 0 && dock.x + dock.width <= 390, 'Dock fits mobile');
  await page.locator('#studio-dock [data-sweep]').click(); await page.waitForSelector('[data-agent="w3:p1"]:not(:disabled)');
  await page.locator('[data-workspace="w3"]').check(); await page.locator('[data-workspace="w2"]').check();
  await page.locator('[data-prepare]').click();
  await page.waitForSelector('[data-finish="close"]:not(:disabled)');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: scratch + '/review-mobile.png' });
  const originalView = await page.evaluate(() => ({ zoom: window.hs.office.cameras.main.zoom, fit: window.hs.office.wholeOfficeView }));
  await page.locator('[data-finish="close"]').click();
  await page.waitForSelector('#reorg-cutscene');
  assert(await page.locator('#sweep-panel').isHidden(), 'Review gives way to the cutscene');
  assert.equal(await page.locator('#reorg-cutscene [data-pane]').count(), 2);
  await page.waitForFunction(() => !window.hs.office.game.loop.running && !window.hs.office.canInteract());
  const firstFrame = await page.locator('#reorg-cutscene canvas').evaluate(c => c.toDataURL());
  await page.waitForFunction(() => document.querySelector('#reorg-cutscene [data-caption]')?.textContent.includes('goodbye'));
  assert.notEqual(await page.locator('#reorg-cutscene canvas').evaluate(c => c.toDataURL()), firstFrame, 'Sprite scene visibly animates while the office is paused');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: scratch + '/cutscene-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.screenshot({ path: scratch + '/cutscene-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#reorg-cutscene canvas')?.dataset.departed === '1');
  assert(await page.evaluate(() => window.hs.model.isDeparting('w2:p1') && window.hs.model.isDeparting('w3:p1')), 'Keep both desks until the final actor exits');
  await page.waitForSelector('#reorg-cutscene[data-complete="true"]');
  assert.equal(await page.locator('#reorg-cutscene [data-pane][data-done]').count(), 2, 'Each selected actor checks out');
  assert.match(await page.locator('#reorg-cutscene [data-count]').innerText(), /2 \/ 2 checked out/);
  await page.waitForFunction(() => !window.hs.model.agents.has('w2:p1') && !window.hs.model.agents.has('w3:p1'));
  await page.screenshot({ path: scratch + '/cutscene-complete.png' });
  await page.locator('#reorg-cutscene [data-continue]').click();
  await page.waitForSelector('#sweep-panel:not([hidden])');
  assert.equal(await page.evaluate(() => window.hs.office.cameras.main.zoom), originalView.zoom, 'Prior zoom restored');
  assert.equal(await page.evaluate(() => window.hs.office.wholeOfficeView), originalView.fit, 'Whole office toggle unchanged');
  assert.match(await page.locator('.sweep-complete').innerText(), /2 agents closed · 2 workspaces closed/);
  await page.waitForFunction(async () => !(await (await fetch('/api/state')).json()).agents.some(a => ['w2:p1', 'w3:p1'].includes(a.pane_id)));
  const journal = (await api(live.url, 'studio.journal', { search: 'Re-org' })).body.result;
  assert.equal(journal.entries.length, 3);
  await page.screenshot({ path: scratch + '/finished-mobile.png' });

  const readonly = await start(false);
  const ro = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await ro.goto(readonly.url); await ro.locator('#studio-dock [data-sweep]').click();
  await ro.waitForSelector('[data-agent="w2:p1"]:not(:disabled)');
  await ro.locator('[data-agent="w2:p1"]').check(); await ro.locator('[data-prepare]').click();
  await ro.waitForSelector('[data-finish="close"]');
  assert(await ro.locator('[data-finish="close"]').isDisabled()); assert(await ro.locator('[data-finish="save"]').isDisabled());
  assert.equal((await api(readonly.url, 'sweep.finish', { token: 'forged', close: true })).status, 403);
  // A resumed agent stays out of the cast. Reduced motion offers a static preview;
  // the user can opt into the animation and skip it without repeating any close request.
  const shortcut = await start(true);
  const reduced = await browser.newPage({ viewport: { width: 1000, height: 800 }, reducedMotion: 'reduce' });
  reduced.on('pageerror', e => errors.push(e.message));
  await reduced.goto(shortcut.url); await reduced.locator('#studio-dock [data-sweep]').click();
  await reduced.waitForSelector('[data-agent="w2:p1"]:not(:disabled)');
  await reduced.locator('[data-select-all]').click(); await reduced.locator('[data-prepare]').click();
  await reduced.waitForSelector('[data-finish="close"]:not(:disabled)');
  await api(shortcut.url, 'agent.prompt', { target: 'w2:p1', text: 'Continue the implementation' });
  await reduced.locator('[data-finish="close"]').click(); await reduced.waitForSelector('#reorg-cutscene');
  assert.equal(await reduced.locator('#reorg-cutscene [data-pane="w2:p1"]').count(), 0, 'Resumed agent never walks out');
  assert.equal(await reduced.locator('#reorg-cutscene [data-pane="w3:p1"]').count(), 1);
  const still = await reduced.locator('#reorg-cutscene canvas').getAttribute('data-frame');
  await reduced.waitForTimeout(150);
  assert.equal(await reduced.locator('#reorg-cutscene canvas').getAttribute('data-frame'), still, 'Reduced motion does not autoplay');
  await reduced.locator('#reorg-cutscene [data-play]').click();
  await reduced.waitForFunction(() => Number(document.querySelector('#reorg-cutscene canvas')?.dataset.frame) > 15);
  await reduced.keyboard.press('Escape');
  await reduced.waitForSelector('#sweep-panel:not([hidden])');
  assert.match(await reduced.locator('.sweep-complete').innerText(), /1 agent closed/);
  assert.match(await reduced.locator('.sweep-kept').innerText(), /w2:p1/);
  assert(await reduced.evaluate(() => window.hs.model.agents.has('w2:p1')));
  await reduced.locator('#sweep-panel [data-close]').click();
  await reduced.waitForFunction(() => window.hs.office.game.loop.running && window.hs.office.canInteract());
  assert.deepEqual(errors, []);
  console.log(`PASS Re-org: filters, saved recaps, save-only, sprite cutscene, batch exit, saved results, restored zoom, mobile, reduced motion, skip, resumed agent protection, read-only. Screenshots: ${scratch}`);
} finally {
  await browser.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}
