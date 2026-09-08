// Exercise Boss against an isolated mock bridge; never start a live agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-boss-'));
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
async function bossPoint(page) {
  await page.evaluate(() => {
    const office = window.hs.office, item = office.furnishings.items.find(i => i.kind === 'boss');
    if (!item) throw Error('Boss desk was not placed');
    office.cameras.main.setZoom(4); office.cameras.main.centerOn(item.x, item.y - 35);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => {
    const office = window.hs.office, item = office.furnishings.items.find(i => i.kind === 'boss');
    const camera = office.cameras.main, rect = office.game.canvas.getBoundingClientRect();
    return { x: rect.left + camera.width / 2 + (item.x - camera.scrollX - camera.width / 2) * camera.zoom,
      y: rect.top + camera.height / 2 + (item.y - 35 - camera.scrollY - camera.height / 2) * camera.zoom };
  });
}
const browser = await chromium.launch({ executablePath });
try {
  const url = await start(true), page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(15000);
  await page.goto(url); await ready(page);
  const before = await page.evaluate(() => window.hs.model.agents.size);
  assert.equal(await page.evaluate(() => [...window.hs.model.agents.values()].filter(a => a.name === 'Boss').length), 0);
  await call(url, 'studio.change', { op: 'entry.save', title: 'Chat scrolling shipped', notes: 'Made long conversations easier to navigate', contributors: [], url: '', project: '' });
  let point = await bossPoint(page);
  await page.screenshot({ path: join(scratch, 'boss-desk.png') });
  await page.evaluate(() => window.hs.office.furnishings.startEdit());
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.evaluate(() => window.hs.model.agents.size), before);
  assert(await page.evaluate(() => !!window.hs.office.furnishings.selected));
  await page.evaluate(() => window.hs.office.furnishings.stopEdit());
  await page.mouse.dblclick(point.x, point.y, { delay: 25 });
  await page.locator('#boss-cutscene [data-project]').waitFor();
  assert.equal(await page.evaluate(() => window.hs.model.agents.size), before, 'Choose scope before starting Boss');
  await page.locator('#boss-cutscene [data-review]').click();
  await page.waitForFunction(() => [...window.hs.model.agents.values()].some(a => a.office_role === 'boss'));
  await page.waitForFunction(() => document.querySelector('#boss-cutscene [data-count]')?.textContent.includes('3 ideas'));
  assert(await page.locator('#dialog').isHidden());
  const agent = await page.evaluate(() => [...window.hs.model.agents.values()].find(a => a.office_role === 'boss'));
  assert.equal(agent.agent, 'claude'); assert.equal(agent.model, 'claude-fable-5-1');
  assert.equal(await page.evaluate(() => window.hs.model.agents.size), before + 1);
  assert.equal(await page.evaluate(id => window.hs.model.seatOf(id), agent.pane_id), null);
  assert(!(await page.locator('#boss-cutscene').innerText()).includes('JOURNAL EVIDENCE'));
  await page.locator('#boss-cutscene [data-next]').click();
  await page.locator('#boss-cutscene [data-title]').filter({ hasText: 'Give long chats a bookmark' }).waitFor();
  await page.screenshot({ path: join(scratch, 'boss-briefing.png') });
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#boss-cutscene [data-title]').innerText(), 'Show the milestone in the room');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#boss-cutscene [data-title]').innerText(), 'Give long chats a bookmark');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(scratch, 'boss-briefing-mobile.png') });
  assert(await page.evaluate(() => document.querySelector('.boss-window').getBoundingClientRect().right <= innerWidth));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#boss-cutscene').count(), 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  let terminal = (await call(url, 'agent.read', { target: agent.pane_id })).result.read.text;
  assert(terminal.includes('Chat scrolling shipped')); assert.equal((terminal.match(/You are Boss/g) || []).length, 1);
  await page.waitForFunction(() => [...window.hs.model.agents.values()].find(a => a.office_role === 'boss')?.agent_status === 'idle');
  const repeated = await call(url, 'agent.boss', { kind: 'codex', model: 'wrong-model', text: 'DO NOT FORWARD ME' });
  assert.equal(repeated.result.reviewed, false); assert.equal(repeated.result.pane_id, agent.pane_id);
  await call(url, 'studio.change', { op: 'entry.save', title: 'New multiplayer milestone', notes: 'Co-op demo released', contributors: [], url: '', project: '' });
  const updated = await call(url, 'agent.boss'); assert.equal(updated.result.reviewed, false); assert(updated.result.nextReviewAt > Date.now());
  terminal = (await call(url, 'agent.read', { target: agent.pane_id })).result.read.text;
  assert.equal((terminal.match(/You are Boss/g) || []).length, 1); assert(!terminal.includes('New multiplayer milestone'));
  assert(!terminal.includes('DO NOT FORWARD ME'));
  assert.equal((terminal.match(/Chat scrolling shipped/g) || []).length, 1);
  assert.equal((terminal.match(/Made long conversations easier to navigate/g) || []).length, 1);
  console.log('PASS desk click, one Fable 5.1 session, briefing cards, keyboard navigation, mobile fit, daily limit with new journal entries, editing guard');

  await page.evaluate(() => window.hs.dialog.close());
  const room = await page.evaluate(() => ({ op: 'room.save', version: window.hs.studio.state.room.version, items: window.hs.office.furnishings.items, projectOrder: window.hs.studio.state.room.projectOrder }));
  const saved = await call(url, 'studio.change', room); assert(!saved.error, JSON.stringify(saved.error));
  assert(saved.result.room.items.some(i => i.kind === 'boss'));
  await page.reload(); await ready(page); await bossPoint(page);
  assert.equal(await page.evaluate(() => window.hs.office.furnishings.items.filter(i => i.kind === 'boss').length), 1);
  await page.evaluate(() => window.hs.bossCutscene.open(false));
  await page.locator('#boss-cutscene [data-archive]').click();
  await page.locator('.boss-archive-entry').first().waitFor();
  assert.equal(await page.locator('.boss-archive-entry').count(), 1);
  assert((await page.locator('[data-cadence]').innerText()).includes('Next review:'));
  await page.screenshot({ path: join(scratch, 'boss-archive.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(scratch, 'boss-archive-mobile.png') });
  await page.locator('.boss-archive-entry').first().click();
  await page.locator('#boss-cutscene [data-next]').click();
  assert.equal(await page.locator('#boss-cutscene [data-title]').innerText(), 'Give long chats a bookmark');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  // Recovery only reads: it must never submit a replacement review.
  await page.evaluate(async () => {
    const client = window.hs.client, original = client.call.bind(client);
    window.bossOriginalCall = original; window.bossRecoveryReads = 0;
    const agent = [...window.hs.model.agents.values()].find(a => a.office_role === 'boss');
    client.call = (method, ...args) => {
      if (method === 'agent.boss') throw Error('Recovery must never request new ideas');
      if (method === 'agent.boss.briefing') {
        window.bossRecoveryReads++;
        if (window.bossRecoveryReads < 3) return Promise.resolve({ state: window.bossRecoveryReads === 1 ? 'thinking' : 'attention', message: 'Waiting for the saved answer', agent });
      }
      return original(method, ...args);
    };
    await window.hs.bossCutscene.open(false);
  });
  assert(await page.locator('#boss-cutscene [data-chat]').isVisible());
  await page.locator('#boss-cutscene [data-check]').waitFor();
  await page.locator('#boss-cutscene [data-check]').click();
  await page.waitForFunction(() => document.querySelector('#boss-cutscene [data-count]')?.textContent.includes('ideas'));
  assert.equal(await page.evaluate(() => window.bossRecoveryReads), 3);
  await page.evaluate(() => { window.hs.client.call = window.bossOriginalCall; window.hs.bossCutscene.close(); });
  console.log('PASS archive browsing and replay on desktop/mobile, cooldown display, and recovery without new prompts');
  await page.evaluate(() => window.hs.bossCutscene.open(true));
  const project = await page.locator('#boss-project option').nth(1).getAttribute('value');
  const projectName = await page.locator('#boss-project option').nth(1).textContent();
  await page.locator('#boss-project').selectOption(project);
  await page.locator('[data-review]').click();
  await page.waitForFunction(name => document.querySelector('#boss-heading')?.textContent === `Ideas for ${name}`, projectName);
  const focusedTerminal = (await call(url, 'agent.read', { target: agent.pane_id })).result.read.text;
  assert(focusedTerminal.includes('Only project'));
  assert(focusedTerminal.includes(project));
  await page.screenshot({ path: join(scratch, 'boss-project.png') });
  console.log('PASS project selector, focused prompt and project briefing heading');
  await page.keyboard.press('Escape');
  const readOnlyUrl = await start(false), readOnlyPage = await browser.newPage();
  await readOnlyPage.goto(readOnlyUrl); await ready(readOnlyPage);
  point = await bossPoint(readOnlyPage); await readOnlyPage.mouse.click(point.x, point.y);
  await readOnlyPage.waitForFunction(() => document.querySelector('#boss-cutscene [data-intro]')?.textContent.includes('Click Boss'));
  assert.equal(await readOnlyPage.evaluate(() => [...window.hs.model.agents.values()].filter(a => a.office_role === 'boss').length), 0);
  assert((await call(readOnlyUrl, 'agent.boss')).error);
  await page.evaluate(() => { void window.hs.bossCutscene.open(false); window.hs.bossCutscene.close(); });
  await page.waitForTimeout(2200);
  assert.equal(await page.locator('#boss-cutscene').count(), 0, 'Late reads must not reopen a dismissed cutscene');
  assert.deepEqual(errors, []);
  console.log(`PASS saved room/reload, read-only enforcement, no browser errors. Screenshot: ${scratch}/boss-desk.png`);
} finally {
  await browser.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve); child.kill();
  })));
}
