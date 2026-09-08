// Isolated browser regression: the bridge is mocked and every save goes to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
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
let server = await startBridge(port, stateDir);
const browser = await chromium.launch({ executablePath });
const errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.hs?.office?.furnishings.items.length && document.querySelector('.agent-row canvas'));
  await page.waitForTimeout(500);
  // Count actual rendered frames, not TimeStep.frame (native RAF keeps accepting input).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.evaluate(() => {
    const { office, game } = window.hs;
    window.__rendered = 0;
    game.events.on('postrender', () => window.__rendered++);
    office.renderBudget.boost(2500);
  });
  const sample = async () => {
    const start = await cdp.send('Performance.getMetrics');
    const before = await page.evaluate(() => window.__rendered);
    await page.waitForTimeout(2000);
    const after = await page.evaluate(() => window.__rendered);
    const end = await cdp.send('Performance.getMetrics');
    const value = (snapshot, name) => snapshot.metrics.find(m => m.name === name).value;
    return { frames: after - before, taskMs: Math.round((value(end, 'TaskDuration') - value(start, 'TaskDuration')) * 1000) };
  };
  const active = await sample();
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.hs.office.renderBudget.fps), 30);
  const quiet = await sample();
  assert(quiet.frames > 35 && quiet.frames < 85, `Quiet office stays near 30 FPS: ${quiet.frames} frames/2s`);
  assert(active.frames > quiet.frames * 1.3, `Interaction budget renders more frequently: ${JSON.stringify({ active, quiet })}`);
  await page.evaluate(() => window.hs.office.focusProject(window.hs.office.projectOrder().at(-1)));
  assert.equal(await page.evaluate(() => window.hs.office.renderBudget.fps), 60);
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate(() => window.hs.office.cameras.main.panEffect.isRunning), false, 'Camera pan completes without RAF restart');
  console.log('PASS adaptive office frame budget (same isolated fixture)', { active, quiet });
  const result = await page.evaluate(async () => {
    const { office, model } = window.hs;
    const stations = office.pods.flatMap(p => p.stations);
    const texturesBefore = office.textures.getTextureKeys();
    const previous = structuredClone(model.studio);
    const state = structuredClone(previous);
    state.projects[0].name = 'Responsive board';
    state.projects[0].color = '#39815b';
    const board = office.furnishings.items.find(i => i.kind === 'whiteboard' && i.project === state.projects[0].id);
    const beforeBoard = office.furnishings.nodes.get(board.id);
    const otherItem = office.furnishings.items.find(i => i.id !== board.id);
    const beforeOther = office.furnishings.nodes.get(otherItem.id);
    model.setStudio(state);
    const stableDesks = stations.every((s, i) => s === office.pods.flatMap(p => p.stations)[i]);
    const boardUpdated = beforeBoard !== office.furnishings.nodes.get(board.id) && office.furnishings.label(board).includes('Responsive board');
    const untouchedFurniture = beforeOther === office.furnishings.nodes.get(otherItem.id);
    const baked = office.furnishings.nodes.get(board.id).list[0];
    const canvas = baked.texture.getSourceImage();
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const visiblePixels = [...pixels].filter((_, i) => i % 4 === 3 && pixels[i] > 0).length;
    const beforeFrame = office.game.loop.frame;
    office.setPresentationPaused(true);
    await new Promise(r => setTimeout(r, 180));
    const paused = office.game.loop.frame === beforeFrame;
    state.projects[0].name = 'Updated behind chat'; model.setStudio(state);
    const syncedWhilePaused = office.furnishings.label(board).includes('Updated behind chat');
    office.setPresentationPaused(false);
    await new Promise(r => setTimeout(r, 180));
    const resumed = office.game.loop.frame > beforeFrame;
    await office.setTheme('midnight');
    const lazyTheme = office.theme.id === 'midnight' && office.textures.exists('carpet_midnight');
    await office.setTheme('classic');
    model.setStudio(previous);
    return { stableDesks, boardUpdated, untouchedFurniture, visiblePixels, paused, syncedWhilePaused, resumed, lazyTheme,
      themeCountBefore: texturesBefore.filter(k => k.startsWith('carpet_')).length,
      bodyCountBefore: texturesBefore.filter(k => /^body\d+$/.test(k)).length };
  });
  assert.equal(result.stableDesks, true); assert.equal(result.boardUpdated, true); assert.equal(result.untouchedFurniture, true);
  assert.ok(result.visiblePixels > 300, 'Baked furniture retains visible artwork');
  assert.equal(result.paused, true); assert.equal(result.resumed, true); assert.equal(result.syncedWhilePaused, true);
  assert.equal(result.lazyTheme, true); assert.equal(result.themeCountBefore, 1); assert.ok(result.bodyCountBefore < 26);
  await page.screenshot({ path: join(scratch, 'office-performance.png') });
  console.log('PASS stable desks, targeted furniture refresh, baked pixel artwork, sleeping canvas with live state, lazy themes/looks', result);

  await page.evaluate(() => {
    window.__row = document.querySelector('.agent-row');
    window.__avatar = window.__row.querySelector('canvas');
    window.__allRows = [...document.querySelectorAll('.agent-row')];
  });
  await page.locator('#studio-dock [data-page="people"]').click();
  await page.locator('[name="name"]').fill('Fast interaction veteran');
  await page.locator('[data-appearance="face"][data-step="1"]').click();
  await page.locator('[data-appearance="body"][data-step="1"]').click();
  await page.getByRole('button', { name: 'Save employee', exact: true }).click();
  await page.waitForFunction(() => !window.hs.studio.busy && document.querySelector('.agent-row').textContent.includes('Fast interaction veteran'));
  const rows = await page.evaluate(() => ({
    sameRows: window.__allRows.every(row => row.isConnected),
    name: window.__row.textContent,
  }));
  assert.equal(rows.sameRows, true, 'Employee edit patches existing agent rows');
  await page.locator('[data-close]').click();
  const project = page.locator('.project-collapse').first();
  await project.click(); assert.equal(await project.getAttribute('aria-expanded'), 'false');
  await project.click(); assert.equal(await project.getAttribute('aria-expanded'), 'true');
  await page.locator('.project-focus').first().click();
  await page.locator('.agent-row').first().click();
  assert.equal(await page.locator('#dialog').isVisible(), true);
  const animations = await page.evaluate(async () => {
    const lamp = document.querySelector('.status-lamp.working');
    const reply = document.querySelector('.reply-note');
    const state = reply.dataset.state; reply.dataset.state = 'sending';
    const style = getComputedStyle(lamp, '::after');
    const frames = window.__rendered;
    const result = { paused: style.animationPlayState, chatFeedback: getComputedStyle(reply, '::before').animationPlayState,
      parentAnimation: getComputedStyle(lamp).animationName };
    await new Promise(resolve => setTimeout(resolve, 250));
    result.backgroundFrames = window.__rendered - frames;
    if (state === undefined) delete reply.dataset.state; else reply.dataset.state = state;
    return result;
  });
  assert.deepEqual(animations, { paused: 'paused', chatFeedback: 'running', parentAnimation: 'none', backgroundFrames: 0 });
  const obscured = await sample();
  assert.equal(obscured.frames, 0, 'Office remains fully asleep throughout the chat sample');
  console.log('PASS obscured office render budget', obscured);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.status-lamp.working'), '::after').animationName), 'none');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('page-hidden')), true);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  console.log('PASS paused background CSS/canvas, active chat feedback, hidden-page handling, reduced motion');
  assert.deepEqual(errors, []);
  console.log('PASS keyed roster rows, appearance edits, delegated collapse/pan/chat actions; no page errors');
  console.log(`Performance artifacts: ${scratch}`);
} finally { await browser.close(); for (const child of children) await stop(child); }
