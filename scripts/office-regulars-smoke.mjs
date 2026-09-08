// Private fixture only: never sends prompts, hires, or closes real agents.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync('/tmp/herdr-regulars-'), state = `${scratch}/state`; mkdirSync(state);
const entry = (id, kind) => ({ id, kind, version: 0, at: Date.now() - 864e5, title: `Saved ${kind} ${id}`, notes: 'A remembered accomplishment and its findings.', project: '/projects/office', contributors: [], url: '', source: 'manual' });
writeFileSync(`${state}/studio.json`, JSON.stringify({ version: 1, revision: 1, employees: [], projects: [], journal: [entry('one', 'task'), entry('two', 'milestone'), entry('three', 'release')], room: { version: 0, items: null, projectOrder: [] }, identities: {}, observations: {}, imports: [] }));
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env, HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_PORT: String(port), HERDR_STORY_STATE_DIR: state,
  HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: '1', HERDR_STORY_WEBHOOK_PORT: '', STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [server.stdout, server.stderr]) stream.on('data', d => appendFileSync(`${scratch}/bridge.log`, d));
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
const errors = [], writes = [], reads = [];
let page;
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { assert.equal(server.exitCode, null, 'Fixture bridge must stay running'); try { if ((await fetch(`${url}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  const ready = async () => { await page.waitForFunction(() => window.__herdrReady && window.hs.office.regulars?.actors.length === 2 && window.hs.studio.state.employees.length); await page.locator('#loading').waitFor({ state: 'hidden' }); };
  await ready();
  await page.exposeFunction('recordRegularRpc', method => {
    if (/^(agent\.(prompt|hire|boss|close)|sweep\.(prepare|finish)|studio\.change)$/.test(method)) { writes.push(method); return false; }
    reads.push(method); return true;
  });
  await page.evaluate(() => {
    const client = window.hs.client, original = client.call.bind(client);
    client.call = async (method, ...args) => { if (!await window.recordRegularRpc(method)) throw new Error('Resident test forbids agent commands'); return original(method, ...args); };
  });
  const position = async kind => {
    await page.mouse.move(0, 0);
    await page.evaluate(kind => {
      const o = window.hs.office, a = o.regulars.actors.find(a => a.kind === kind);
      a.path = []; a.until = o.time.now + 100000; a.phase = 'rest';
      o.followedPane = undefined; o.cameras.main.panEffect.reset(); o.cameras.main.setZoom(5).centerOn(a.node.x + 8, a.node.y + 12);
    }, kind);
    await page.waitForTimeout(150);
    return page.evaluate(kind => {
      const o = window.hs.office, a = o.regulars.actors.find(a => a.kind === kind), c = o.cameras.main, rect = o.game.canvas.getBoundingClientRect();
      return { x: rect.left + (a.node.x + 8 - c.worldView.x) * c.zoom, y: rect.top + (a.node.y + 12 - c.worldView.y) * c.zoom };
    }, kind);
  };
  let p = await position('cat');
  await page.screenshot({ path: `${scratch}/cat-office.png` });
  // A pan started over a cat must not open its window.
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 80, p.y + 30, { steps: 5 }); await page.mouse.up();
  assert(await page.locator('#office-cat').isHidden());
  p = await position('cat'); await page.mouse.click(p.x, p.y);
  await page.locator('#office-cat:not([hidden])').waitFor();
  await page.waitForFunction(() => !window.hs.office.game.loop.running);
  await page.locator('#office-cat [data-open]:not([hidden])').waitFor();
  const first = await page.locator('#office-cat [data-title]').innerText();
  await page.locator('#office-cat [data-pet]').click();
  assert.match(await page.locator('#office-cat [data-mood]').innerText(), /Prrrr/);
  await page.locator('#office-cat [data-another]').click();
  assert.notEqual(await page.locator('#office-cat [data-title]').innerText(), first);
  await page.waitForFunction(() => window.hs.cat.fetched > 0);
  await page.screenshot({ path: `${scratch}/cat-window.png` });
  await page.keyboard.press('Escape'); assert(await page.locator('#office-cat').isHidden());
  await page.waitForFunction(() => window.hs.office.game.loop.running);
  const readCount = reads.filter(m => m === 'studio.journal').length;
  await page.locator('#front-desk').click(); await page.locator('#reception [data-cat]').click();
  await page.waitForTimeout(200);
  assert.equal(reads.filter(m => m === 'studio.journal').length, readCount, 'Reopening uses the memory cache');
  await page.locator('#office-cat [data-open]').click();
  await page.locator('#studio-panel:not([hidden])').waitFor();
  assert(await page.locator('#office-cat').isHidden()); await page.keyboard.press('Escape');
  p = await position('janitor'); await page.screenshot({ path: `${scratch}/janitor-office.png` });
  await page.mouse.click(p.x, p.y); await page.locator('#sweep-panel:not([hidden])').waitFor();
  await page.locator('.sweep-tally').waitFor();
  assert.match(await page.locator('.sweep-intro').innerText(), /GUS/);
  assert(reads.includes('sweep.scan'), 'Janitor opens the existing idle scan');
  assert.equal(writes.length, 0, 'Meeting residents does not issue agent commands or close anything');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.hs.office.game.loop.running);
  await page.mouse.move(0, 0);
  const start = await page.evaluate(() => {
    const r = window.hs.office.regulars; r.hideHints();
    return r.actors.map(a => { a.until = 0; return { kind: a.kind, x: a.node.x, y: a.node.y }; });
  });
  await page.waitForFunction(start => window.hs.office.regulars.actors.every(a => { const p = start.find(p => p.kind === a.kind); return Math.hypot(a.node.x - p.x, a.node.y - p.y) > 10; }), start);
  assert(await page.evaluate(() => {
    const o = window.hs.office;
    return o.regulars.actors.every(a => o.wander.isFree(a.node) && a.path.every(p => o.wander.isFree(p)));
  }), 'Residents and planned paths stay on walkable floor');
  await page.evaluate(() => window.hs.office.refreshRoom());
  assert.equal(await page.evaluate(() => window.hs.office.regulars.actors.length), 2, 'Rebuilding the room keeps exactly two residents');
  assert(await page.evaluate(() => window.hs.office.regulars.actors.every(a => window.hs.office.wander.isFree(a.node))));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await page.evaluate(() => window.hs.office.regulars.actors.map(a => [a.node.x, a.node.y]));
  await page.waitForTimeout(800);
  assert.deepEqual(await page.evaluate(() => window.hs.office.regulars.actors.map(a => [a.node.x, a.node.y])), still, 'Reduced motion keeps residents still');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#front-desk').click(); await page.screenshot({ path: `${scratch}/front-desk-mobile.png` });
  await page.locator('#reception [data-cat]').click(); await page.locator('#office-cat [data-pet]').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${scratch}/cat-mobile.png` });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log(`Office cat and janitor checks passed. Screenshots: ${scratch}`);
} catch (error) {
  await page?.screenshot({ path: `${scratch}/failure.png` }).catch(() => {}); console.error(`Artifacts: ${scratch}`, errors); throw error;
} finally { await browser.close(); server.kill('SIGTERM'); }
