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
const ready = async p => { await p.waitForFunction(() => window.hs?.studio?.state?.employees.length && window.hs.office.furnishings.items.length); };
const saved = async p => { await p.waitForFunction(() => !window.hs.studio.busy); };
const tab = async (p, name) => { await saved(p); await p.locator(`.studio-tabs [data-tab="${name}"]`).click(); };
const open = async (p, name) => { await p.locator(`#studio-dock [data-page="${name}"]`).click(); };
const shot = async (p, name) => p.screenshot({ path: join(scratch, `${name}.png`) });
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await ready(page);
  const initial = await page.evaluate(() => ({ boards: window.hs.office.furnishings.items.filter(i => i.kind === 'whiteboard').length, projects: window.hs.model.pods.length }));
  assert.equal(initial.boards, initial.projects, 'Every project has an in-world whiteboard');
  const cameraView = () => page.evaluate(() => {
    const camera = window.hs.office.cameras.main;
    return { zoom: camera.zoom, x: camera.scrollX + camera.width / 2, y: camera.scrollY + camera.height / 2 };
  });
  const previousView = await cameraView();
  await page.locator('[data-fit]').click();
  assert.equal(await page.locator('[data-fit]').getAttribute('aria-pressed'), 'true');
  assert.ok((await page.locator('[data-fit]').innerText()).includes('Zoom back'));
  await page.evaluate(() => window.hs.office.refreshRoom());
  await page.locator('[data-fit]').click();
  assert.deepEqual(await cameraView(), previousView, 'Fit toggle restores zoom and position after a room rebuild');
  assert.equal(await page.locator('[data-fit]').getAttribute('aria-pressed'), 'false');
  console.log('PASS reversible whole-office view and visible toggle state');
  await open(page, 'boards');
  await page.locator('[data-customize]').click();
  await page.locator('[name="name"]').fill('Moonshot studio');
  await page.locator('[name="notes"]').fill('Build something small. Make it dependable.');
  await page.locator('[name="color"][value="#39815b"]').check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await saved(page);
  await page.locator('[data-add-goal]').click();
  await page.locator('[name="title"]').fill('Ship our public beta');
  await page.locator('[name="notes"]').fill('A useful first release, from all of us.');
  await page.locator('[name="due"]').fill('2026-10-01');
  await page.locator('[name="url"]').fill('https://example.com/releases/beta');
  await page.locator('[data-step-text]').fill('Polish the first-run experience');
  await page.locator('[data-add-step]').click();
  await page.locator('[data-step-text]').last().fill('Publish release notes');
  await page.locator('[name="contributor"]').first().check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await saved(page);
  assert.equal(await page.locator('.milestone-card h3').textContent(), 'Ship our public beta');
  await page.evaluate(() => {
    const client=window.hs.client, call=client.call.bind(client);
    client.call=(method,params,options)=>{
      if(method==='studio.change' && params.op==='goal.save') {
        client.call=call;
        return new Promise((resolve,reject)=>{window.releaseGoalSave=()=>call(method,params,options).then(resolve,reject);});
      }
      return call(method,params,options);
    };
  });
  await page.locator('[data-check="0"]').check();
  await page.locator('[data-check="1"]').check();
  assert.equal(await page.locator('[data-check]:checked').count(),2,'Checklist clicks respond before the save');
  assert.equal(await page.locator('.milestone-card .goal-meter').getAttribute('aria-valuenow'),'100','Checklist progress responds before the save');
  await page.evaluate(()=>window.releaseGoalSave()); await saved(page);
  assert.equal(await page.locator('.milestone-card .goal-meter').getAttribute('aria-valuenow'),'100','Rapid checklist clicks both persist');
  await page.locator('[data-check="1"]').uncheck(); await saved(page);

  assert.equal(await page.locator('.milestone-card .goal-meter').getAttribute('aria-valuenow'), '50');
  await shot(page, 'whiteboard');
  await page.locator('[data-complete]').click(); await saved(page);
  await tab(page, 'trophies'); assert.equal(await page.locator('.trophy-card').count(), 1);
  assert.equal(await page.locator('.trophy-card .artifact-link').getAttribute('href'), 'https://example.com/releases/beta');
  await shot(page, 'trophies');
  console.log('PASS editable whiteboards, checklists, contributors, milestones, and trophy links');

  await tab(page, 'people');
  const employeeId = await page.evaluate(() => window.hs.studio.personId);
  await page.locator('[name="name"]').fill('Ada the debugger');
  await page.locator('[name="bio"]').fill('Our veteran debugger. Here since the first release.');
  await page.locator('[data-appearance="face"][data-step="1"]').click();
  await page.locator('[data-appearance="body"][data-step="1"]').click();
  await page.locator('[name="favorite"]').check();
  const appearance = await page.evaluate(() => ({ face: Number(document.querySelector('[name="face"]').value), body: Number(document.querySelector('[name="body"]').value) }));
  await page.getByRole('button', { name: 'Save employee', exact: true }).click(); await saved(page);
  assert.equal(await page.locator('.employee-passport h2').textContent(), 'Ada the debugger');
  assert.ok(await page.locator('.agent-row').filter({ hasText: 'Ada the debugger' }).count());
  const actualLook = await page.evaluate(id => [...window.hs.model.agents.values()].find(a => a.employee_id === id).office_look, employeeId);
  assert.deepEqual(actualLook, appearance);
  await shot(page, 'employee');
  await page.locator('.career-continue summary').click();
  const targetPane = await page.evaluate(id => [...window.hs.model.agents.values()].find(a => a.employee_id !== id).pane_id, employeeId);
  await page.locator('[data-bind-agent]').selectOption(targetPane);
  await page.locator('[data-bind]').click(); await saved(page);
  assert.equal(await page.evaluate(pane => window.hs.model.agents.get(pane).employee_id, targetPane), employeeId);
  console.log('PASS names, portrait/outfit previews, pinned employees, and career reassignment');

  await tab(page, 'journal');
  await page.locator('[data-new-memory]').click();
  await page.locator('[name="title"]').fill('Beta release retrospective');
  await page.locator('[name="notes"]').fill('We shipped the first version together.');
  await page.locator('[name="kind"]').selectOption('release');
  await page.locator('[name="url"]').fill('https://example.com/releases/1');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await saved(page);
  await page.locator('[data-journal-search]').fill('retrospective');
  assert.equal(await page.locator('.journal-entries .journal-row').count(), 1);
  await shot(page, 'journal');
  await page.locator('[data-journal-search]').fill('');
  await page.locator('#studio-panel [data-close]').click();
  const recapPage = await browser.newPage();
  await recapPage.addInitScript(() => localStorage.setItem('herdr-story:seen-at', String(Date.now() - 60_000)));
  await recapPage.goto(url); await ready(recapPage);
  assert.equal(await recapPage.locator('#studio-recap').isVisible(), true);
  await recapPage.locator('[data-recap]').click();
  assert.ok((await recapPage.locator('.journal-heading').innerText()).includes('WHILE YOU WERE AWAY'));
  await recapPage.close();
  console.log('PASS editable memories, search, release artifacts, and while-away recap');

  await page.locator('[data-arrange-room]').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#studio-panel').isVisible(), false, 'Shortcut enters arrange mode directly');
  assert.equal(await page.locator('[data-selected]').evaluate(el => el === document.activeElement), true);
  const draftBefore = await page.evaluate(() => { window.cancelOfficeRoom=window.hs.office.room; return JSON.stringify(window.hs.office.furnishings.items); });
  const nudge = await page.evaluate(() => {
    const f = window.hs.office.furnishings;
    for (const item of f.items.filter(i => i.kind === 'decor')) for (const [dx, dy] of [[16,8],[-16,8],[16,-8],[-16,-8]]) {
      if (f.clear({...item,x:item.x+dx,y:item.y+dy})) return {id:item.id,x:item.x,y:item.y,dx,dy};
    }
  });
  assert.ok(nudge);
  await page.locator('[data-selected]').selectOption(nudge.id);
  const focused = await page.evaluate(() => { const f=window.hs.office.furnishings; return {id:f.selected,y:window.hs.office.cameras.main.midPoint.y}; });
  assert.equal(focused.id,nudge.id);
  const nudgeButton = page.locator(`[data-nudge="${nudge.dx},${nudge.dy}"]`);
  await nudgeButton.focus(); await page.keyboard.press('Enter');
  assert.equal(await nudgeButton.evaluate(el => el === document.activeElement), true, 'Moving furniture retains keyboard focus');
  const nudged = await page.evaluate(id => window.hs.office.furnishings.items.find(i => i.id === id),nudge.id);
  assert.deepEqual({x:nudged.x,y:nudged.y},{x:nudge.x+nudge.dx,y:nudge.y+nudge.dy});
  await page.locator('[data-catalog]').click();
  assert.ok(await page.locator('.furnishing-catalog').evaluate(el => { const a=el.getBoundingClientRect(),b=el.closest('.studio-content').getBoundingClientRect();return a.top>=b.top-1 && a.top<b.bottom; }), 'Add furniture jumps straight to the catalog');
  await page.locator('#studio-panel [data-close]').click(); await page.locator('[data-cancel-room]').click();
  assert.equal(await page.evaluate(() => JSON.stringify(window.hs.office.furnishings.items)),draftBefore);
  assert.equal(await page.evaluate(() => window.cancelOfficeRoom===window.hs.office.room),true,'Cancel keeps the room and desks');
  assert.equal(await page.locator('[data-arrange-room]').evaluate(el => el === document.activeElement),true);
  console.log('PASS direct arrange shortcut, keyboard selection/movement, catalog access, and cancel');

  await open(page, 'room'); await page.locator('[data-arrange]').click();
  assert.equal(await page.locator('#room-edit-bar').isVisible(), true);
  const beforeRoom = await page.evaluate(() => JSON.stringify(window.hs.office.furnishings.items));
  const move = await page.evaluate(() => {
    const f = window.hs.office.furnishings;
    for (const item of f.items.filter(i => i.kind === 'decor')) for (const [dx, dy] of [[16, 8], [-16, 8], [16, -8], [-16, -8], [32, 0]]) {
      if (!f.clear({ ...item, x: item.x + dx, y: item.y + dy })) continue;
      const cam = window.hs.office.cameras.main; cam.centerOn(item.x, item.y - 45);
      const rect = document.querySelector('#game canvas').getBoundingClientRect(), height = f.size(item).h;
      return { id: item.id, from: { x: item.x, y: item.y }, dx, dy,
        x: rect.x + (item.x - cam.scrollX - cam.width / 2) * cam.zoom + cam.width / 2,
        y: rect.y + (item.y - height / 2 - cam.scrollY - cam.height / 2) * cam.zoom + cam.height / 2, zoom: cam.zoom };
    }
  });
  assert.ok(move, 'There is a valid furniture move');
  // Camera transforms and input hit areas settle on the next Phaser frame after centerOn.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => window.hs.office.input.enabled && window.hs.office.canInteract());
  await page.mouse.move(move.x, move.y); await page.mouse.down();
  await page.mouse.move(move.x + move.dx * move.zoom, move.y + move.dy * move.zoom, { steps: 8 }); await page.mouse.up();
  const moved = await page.evaluate(id => window.hs.office.furnishings.items.find(i => i.id === id), move.id);
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: move.from.x + move.dx, y: move.from.y + move.dy });
  await page.locator('[data-cancel-room]').click();
  assert.equal(await page.evaluate(() => JSON.stringify(window.hs.office.furnishings.items)), beforeRoom, 'Cancel restores original positions');
  await open(page, 'room');
  await page.locator('[data-add-kind="decor"]').first().click();
  await page.evaluate(() => {
    const client = window.hs.client, call = client.call.bind(client);
    client.call = (method, params, options) => {
      if (method === 'studio.change' && params.op === 'room.save') {
        client.call = call;
        return new Promise((_, reject) => { window.rejectLayoutSave = () => reject(new Error('Test save failure')); });
      }
      return call(method, params, options);
    };
  });
  await page.locator('[data-save-room]').click();
  assert.equal(await page.locator('[data-save-room]').innerText(), 'Saving…');
  assert.equal(await page.locator('[data-cancel-room]').isDisabled(), true);
  await page.evaluate(() => window.rejectLayoutSave()); await saved(page);
  assert.equal(await page.locator('#room-edit-bar').isVisible(), true, 'Failed save preserves the editable draft');
  assert.equal(await page.locator('[data-save-room]').isEnabled(), true);
  await page.evaluate(() => {
    window.savedOfficeRoom = window.hs.office.room;
    const finish = window.hs.office.finishArrangement.bind(window.hs.office);
    window.hs.office.finishArrangement = () => { const start = performance.now(); finish(); window.layoutFinishMs = performance.now() - start; };
  });
  await page.locator('[data-save-room]').click(); await saved(page);
  assert.equal(await page.evaluate(() => window.savedOfficeRoom === window.hs.office.room), true, 'Saving retains the office and desk sprites');
  console.log('Layout save display update:', await page.evaluate(() => Math.round(window.layoutFinishMs)), 'ms');
  await page.waitForSelector('#room-edit-bar', { state: 'hidden' });
  const savedItems = await page.evaluate(() => window.hs.studio.state.room.items.length);
  assert.ok(savedItems > JSON.parse(beforeRoom).length);
  await open(page, 'room');
  await page.locator('[data-project-move="0"][data-direction="1"]').click();
  await page.locator('[data-arrange]').click(); await page.locator('[data-save-room]').click(); await saved(page);
  const order = await page.evaluate(() => window.hs.studio.state.room.projectOrder);
  await page.locator('#studio-dock [data-fit]').click();
  await shot(page, 'office');
  console.log('PASS drag placement, cancel, add furnishings, saved layouts, and project rearrangement');

  const second = await browser.newPage({ viewport: { width: 390, height: 844 } });
  second.on('pageerror', error => errors.push(error.message)); await second.goto(url); await ready(second);
  assert.ok(await second.evaluate(() => window.hs.studio.state.employees.some(e => e.name === 'Ada the debugger' && e.favorite)));
  assert.deepEqual(await second.evaluate(() => window.hs.studio.state.room.projectOrder), order);
  await shot(second, 'mobile-office'); await open(second, 'boards'); await shot(second, 'mobile-whiteboard');
  assert.ok(await second.evaluate(() => { const el = document.querySelector('.studio-content'); return el.scrollWidth <= el.clientWidth + 1; }));
  await tab(second, 'people'); await shot(second, 'mobile-employee');
  assert.ok(await second.evaluate(() => document.querySelector('.employee-passport').getBoundingClientRect().right <= innerWidth));
  await second.locator('#studio-panel [data-close]').click(); await second.locator('[data-arrange-room]').click();
  await shot(second, 'mobile-arrange');
  const controls = await second.locator('#room-edit-bar').evaluate(el => ({overflow:el.scrollWidth>el.clientWidth,buttons:[...el.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height)}));
  assert.equal(controls.overflow,false); assert.ok(controls.buttons.every(h=>h>=44));
  await second.locator('[data-cancel-room]').click();
  await second.close();
  console.log('PASS shared state in a fresh browser and mobile layouts');

  const fallback = await browser.newPage();
  await fallback.goto(`${url}?ws=ws://127.0.0.1:65534/ws`); await ready(fallback);
  const version = await fallback.evaluate(() => window.hs.studio.state.room.version);
  assert.ok(version >= 2);
  await open(fallback, 'boards'); await fallback.locator('[data-customize]').click();
  await fallback.locator('[name="notes"]').fill('Saved through the HTTP connection.');
  await fallback.getByRole('button', { name: 'Save changes', exact: true }).click(); await saved(fallback);
  assert.equal(await fallback.evaluate(() => window.hs.model.studio.projects[0].notes), 'Saved through the HTTP connection.');
  await fallback.close();
  const readPort = await freePort(), readDir = join(scratch, 'read-only'); mkdirSync(readDir);
  // the studio is a SQLite database with WAL sidecars; copy every piece of it
  for (const name of readdirSync(stateDir).filter(f => f.startsWith('studio.sqlite'))) copyFileSync(join(stateDir, name), join(readDir, name));
  await startBridge(readPort, readDir, false);
  const forbidden = await fetch(`http://127.0.0.1:${readPort}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call', id: 'test', method: 'studio.change', params: { op: 'entry.save', title: 'Must not be saved' } }) });
  assert.equal(forbidden.status, 403);
  const readPage = await browser.newPage(); await readPage.goto(`http://127.0.0.1:${readPort}/`); await ready(readPage); await open(readPage, 'boards');
  assert.equal(await readPage.locator('[data-add-goal]').isDisabled(), true); assert.equal(await readPage.locator('[data-arrange-room]').isDisabled(), true); await readPage.close();
  await stop(server); server = await startBridge(port, stateDir);
  await page.reload(); await ready(page);
  assert.ok(await page.evaluate(() => window.hs.studio.state.journal.some(e => e.title === 'Beta release retrospective')));
  assert.equal(await page.evaluate(() => window.hs.studio.state.room.items.length), savedItems);
  assert.deepEqual(errors, []);
  console.log('PASS HTTP fallback, read-only protection, restart persistence, and no page errors');
  console.log(`Studio screenshots: ${scratch}`);
} catch (error) {
  if (page && !page.isClosed()) console.error('Office input:', await page.evaluate(() => ({
    enabled: window.hs?.office.input.enabled, allowed: window.hs?.office.canInteract(), visible: document.visibilityState,
    blockers: [...document.querySelectorAll('[data-block-office-input]')].map(el => ({ id: el.id, hidden: el.hidden, display: getComputedStyle(el).display })),
  })).catch(() => null));
  if (page && !page.isClosed()) { await shot(page, 'failure').catch(() => {}); console.error('Page:', await page.locator('.studio-content').innerText().catch(() => '(closed)')); }
  console.error(`Failure artifacts: ${scratch}`); throw error;
} finally { await browser.close(); for (const child of children) await stop(child); }
