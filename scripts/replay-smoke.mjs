// An isolated mock office and fictional history; never connects to live agents or credentials.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const scratch = mkdtempSync(join(tmpdir(), 'herdr-replay-smoke-')), project = join(scratch, 'project');
mkdirSync(project);
const port = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, HOME: join(scratch, 'home'), TMPDIR: scratch, HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_STATE_DIR: join(scratch, 'state'), HERDR_STORY_WRITE: '0' };
mkdirSync(env.HOME);
let child, browser;
try {
  for (const path of ['dist', 'bridge', 'shared', 'src', 'package.json']) cpSync(path, join(project, path), { recursive: true });
  symlinkSync(resolve('node_modules'), join(project, 'node_modules'), 'dir');
  writeFileSync(join(project, 'seed.ts'), `
    import { StudioStore } from './bridge/studio';
    import { ReplayStore } from './bridge/replay';
    const studio = new StudioStore(process.env.HERDR_STORY_STATE_DIR), history = new ReplayStore(process.env.HERDR_STORY_STATE_DIR);
    const at = Date.now() - 3600000;
    const a = { pane_id:'replay-test:1', agent:'claude', agent_status:'working', name:'Ada', cwd:'/demo/garden', title:'Plant the garden' };
    studio.observe([a], at - 3600000);
    studio.observe([{ ...a, agent_status:'done' }], at - 3540000);
    const agent = studio.decorate(a);
    const coworker = { ...agent, pane_id:'replay-test:2', employee_id:undefined, office_name:'Bea', cwd:'/demo/lantern', agent_status:'idle' };
    history.record([agent, coworker], at);
    history.recordStudio(studio.snapshot(), at);
    studio.recordSale({ id:'evt_fictional', source:'revenuecat', ts:at+10000, kind:'sale', amount:29, currency:'usd', label:'Fictional garden subscription' });
    studio.recordSale({ id:'evt_cancelled', source:'stripe', ts:at+15000, kind:'churned', amount:0, currency:'usd', label:'Subscription cancelled', detail:{reason:'Customer cancelled',plan:'44 USD/month'} });
    history.record([{ ...agent, agent_status:'done' }, coworker], at+20000);
    studio.change({op:'entry.save',kind:'release',title:'Garden launch',notes:'The garden is open.',contributors:[agent.employee_id],project:'/demo/garden',url:''}, []);
    studio.change({op:'goal.save',project:'/demo/garden',title:'Garden milestone',notes:'All planted.',done:true,contributors:[agent.employee_id],checklist:[],url:'',due:''}, []);
    history.close();
  `);
  execFileSync('bun', ['--no-env-file', 'seed.ts'], { cwd: project, env, stdio: 'pipe' });
  child = spawn('bun', ['--no-env-file', 'bridge/server.ts', '--mock'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const now = Date.now();
  const response = await fetch(`${base}/api/call`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'call',method:'studio.replay',params:{from:now-86400000,to:now}}) });
  const payload = await response.json(); assert.equal(response.status, 200, JSON.stringify(payload));
  assert.ok(payload.result.moments.some(m => m.kind === 'journal' && m.entry.amount === 29));
  let executablePath = process.env.PW_EXE;
  if (!executablePath && !existsSync(chromium.executablePath())) {
    const cache = join(homedir(), '.cache/ms-playwright');
    executablePath = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort()
      .map(d => join(cache, d, 'chrome-headless-shell-linux64/chrome-headless-shell')).filter(existsSync).pop();
  }
  browser = await chromium.launch({ executablePath });
  // A cold image taking longer than the old 15s deadline must still open the office.
  const cold = await browser.newPage();
  await cold.route('**/assets/gds/ui/main00.png', async route => {
    await new Promise(resolve => setTimeout(resolve, 17000));
    await route.continue();
  });
  await cold.goto(`${base}/?replay=1`, { waitUntil: 'domcontentloaded' });
  await cold.waitForFunction(() => window.__herdrReady === true, undefined, { timeout: 35000 });
  assert.equal(await cold.locator('#replay-error').isVisible(), false, 'Slow artwork is not a failed replay');
  assert.equal(await cold.locator('body').evaluate(el => el.classList.contains('roster-only')), false, 'Slow artwork eventually opens the full office');
  await cold.close();
  // Accelerate only the replay watchdog to exercise a stalled download and retry.
  const stalled = await browser.newPage();
  const stallErrors = []; stalled.on('pageerror', error => stallErrors.push(error.message));
  await stalled.addInitScript(() => {
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => schedule(fn,
      delay === 60000 && String(fn).includes('Office artwork stopped loading') ? 1000 : delay, ...args);
  });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  await stalled.route('**/assets/gds/ui/main00.png', async route => { await barrier; await route.abort().catch(() => {}); });
  await stalled.goto(`${base}/?replay=1`, { waitUntil: 'domcontentloaded' });
  await stalled.waitForFunction(() => window.__herdrReady === true);
  assert.equal(await stalled.locator('#replay-error').isVisible(), true, 'Stalled art explains how to retry');
  assert.equal(await stalled.locator('#replay-play').isEnabled(), true, 'History remains playable after art fails');
  assert.equal(await stalled.locator('body').evaluate(el => el.classList.contains('roster-only')), true);
  release();
  await stalled.unroute('**/assets/gds/ui/main00.png');
  await stalled.locator('#replay-play').click();
  await stalled.locator('#replay-load').click();
  await stalled.waitForFunction(() => !document.querySelector('#replay-load').disabled);
  assert.equal(await stalled.locator('#replay-error').isVisible(), false, 'Retry clears the error');
  assert.equal(await stalled.locator('body').evaluate(el => el.classList.contains('roster-only')), false, 'Retry restores the full office');
  assert.deepEqual(stallErrors, [], 'Late failed downloads cannot resurrect a disposed scene');
  await stalled.close();
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [], calls = [], sockets = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Replay browser error:', e.stack); });
  page.on('request', r => { if (r.url().startsWith(base + '/api/')) calls.push({ url:r.url(), body:r.postDataJSON() }); });
  page.on('websocket', ws => sockets.push(ws.url()));
  await page.addInitScript(() => { const Native = window.AudioContext; window.AudioContext = class extends Native { constructor(...args) { super(...args); window.__replayAudio = this; } createGain() { const g = super.createGain(); window.__replayMusicGain ??= g; return g; } createOscillator() { const o = super.createOscillator(), start = o.start.bind(o); o.start = (...args) => { window.__replayNotes = (window.__replayNotes || 0) + 1; start(...args); }; return o; } }; localStorage.setItem('herdr-story:recap-seen', '1234'); localStorage.setItem('herdr-story:seen-at', '5678'); });
  await page.goto(`${base}/?replay=1`);
  await page.waitForFunction(() => window.__herdrReady === true);
  await page.waitForSelector('#game canvas');
  assert.equal(await page.locator('#replay-play').isEnabled(), true);
  // Journal-only history keeps the whole office visible and plays the live task window.
  const fullOffice = await page.locator('.agent-row').count();
  assert.equal(fullOffice, payload.result.contextAgents.length, 'The complete current office remains visible before historical tasks');
  assert.ok(fullOffice >= 2);
  await page.locator('#replay-play').click();
  await page.waitForFunction(() => document.querySelector('#replay-event strong')?.textContent.includes('TASK'));
  assert.ok(await page.locator('.agent-row').count() >= fullOffice, 'First historical task preserves coworkers');
  await page.waitForSelector('#party:not([hidden]) .party-task');
  await page.waitForFunction(() => window.__replayAudio?.state === 'running' && window.__replayNotes > 0 && window.__replayMusicGain?.gain.value > 0);
  await page.locator('#replay-play').click();
  await page.locator('#replay-activity button').filter({ hasText:'Fictional garden' }).click();
  assert.match(await page.locator('#replay-event').innerText(), /\$29\.00/);
  await page.waitForSelector('#party:not([hidden]) .payday');
  assert.match(await page.locator('#party').innerText(), /29/);
  assert.match(await page.locator('#replay-earned').innerText(), /29/);
  assert.ok(await page.locator('#replay-markers button').count() > 0, 'Activity strip has seekable highlights');
  // A paused celebration and office must stay still beyond the old real-time dismiss timer.
  await page.waitForTimeout(400);
  const pausedCanvas = await page.locator('#game canvas').evaluate(el => el.toDataURL());
  await page.waitForTimeout(5500);
  assert.equal(await page.locator('#party').isVisible(), true, 'Pause freezes celebration lifetime');
  assert.equal(await page.locator('#game canvas').evaluate(el => el.toDataURL()), pausedCanvas, 'Pause freezes office rendering');
  await page.locator('#replay-watch').selectOption('payments');
  assert.equal(await page.locator('#replay-activity button').count(), 1, 'Payments mode excludes task windows');
  await page.locator('#replay-play').click();
  await page.waitForSelector('body.replay-arrival');
  assert.match(await page.locator('#replay-earned').innerText(), /0\.00/, 'Customer has not paid before reaching the counter');
  await page.locator('#replay-play').click();
  await page.waitForTimeout(2800);
  assert.match(await page.locator('#replay-earned').innerText(), /0\.00/, 'Pause also stops the customer');
  await page.locator('#replay-play').click();
  await page.waitForSelector('#party:not([hidden]) .payday');
  assert.match(await page.locator('#replay-earned').innerText(), /29\.00/, 'Arrival updates the total and opens the card together');
  await page.locator('#replay-restart').click();
  await page.locator('#replay-play').click();
  await page.waitForSelector('body.replay-arrival');
  await page.locator('#replay-restart').click();
  await page.waitForTimeout(2800);
  assert.equal(await page.locator('#party').isVisible(), false, 'Seeking cancels the old arrival');
  assert.match(await page.locator('#replay-earned').innerText(), /0\.00/);
  await page.locator('#replay-watch').selectOption('all');
  await page.locator('#replay-project').selectOption('/demo/garden');
  assert.equal(await page.locator('#replay-activity button').filter({hasText:'Fictional garden subscription'}).count(), 0, 'Unassigned payments are not guessed into a project');
  await page.locator('#replay-project').selectOption('*');
  await page.locator('#replay-restart').click();
  assert.match(await page.locator('#replay-earned').innerText(), /0\.00/);
  await page.locator('#replay-next').click();
  assert.match(await page.locator('#replay-event strong').innerText(), /TASK/);
  await page.locator('#replay-restart').click();
  await page.locator('#replay-speed').selectOption('4');
  await page.locator('#replay-play').click();
  await page.waitForFunction(() => document.querySelector('#replay-event').textContent.includes('Fictional garden'));
  await page.locator('#replay-play').click();
  const frozen = await page.locator('#replay-clock').innerText();
  await page.waitForTimeout(350);
  assert.equal(await page.locator('#replay-clock').innerText(), frozen, 'Pause freezes historical time');
  await page.locator('#replay-activity button').filter({ hasText:'Fictional garden' }).click();
  mkdirSync('shots/replay', { recursive:true });
  await page.waitForTimeout(800);
  await page.screenshot({ path:'shots/replay/desktop.png' });
  await page.setViewportSize({ width:390, height:844 });
  await page.locator('#replay-options').evaluate(el => el.open = false);
  await page.waitForTimeout(350);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile has no overflow');
  await page.screenshot({ path:'shots/replay/mobile.png' });
  assert.ok(await page.evaluate(() => document.querySelector('#party .party-win').getBoundingClientRect().bottom <= document.querySelector('#game').getBoundingClientRect().bottom + 2), 'Payment card stays inside the office when options collapse');
  assert.ok(await page.locator('#game').evaluate(el => el.getBoundingClientRect().height) >= 280, 'Mobile preserves room for the office');
  await page.locator('#replay-options summary').click();
  await page.locator('#replay-range').selectOption('custom');
  await page.locator('#replay-from').fill('2020-01-01T00:00');
  await page.locator('#replay-load').click();
  await page.waitForSelector('#replay-error:not([hidden])');
  assert.match(await page.locator('#replay-error').innerText(), /seven days/);
  assert.deepEqual(calls.map(c => c.body?.method), ['studio.replay'], 'Playback and invalid ranges make no extra API calls');
  assert.deepEqual(sockets, [], 'Replay never opens a live socket');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('herdr-story:recap-seen'), localStorage.getItem('herdr-story:seen-at')]), ['1234', '5678']);
  await page.locator('#replay-range').selectOption('24');
  await page.locator('#replay-load').click();
  await page.waitForFunction(() => !document.querySelector('#replay-play').disabled);
  await page.locator('#replay-play').click();
  await page.waitForFunction(() => document.querySelector('#replay-event strong')?.textContent.includes('PAYMENT')).catch(async error => { console.error(await page.locator('#replay-controls').innerText(), await page.locator('#replay-event').innerText(), errors); throw error; });
  await page.locator('#replay-play').click();
  assert.equal(await page.locator('#replay-error').isVisible(), false);
  await page.setViewportSize({ width:1280, height:850 });
  await page.waitForTimeout(200);
  assert.deepEqual(errors, [], 'Playback and resize still work after replacing the office scene for a new range');
  await page.locator('#replay-activity button').filter({ hasText:'Garden launch' }).click();
  await page.waitForSelector('#cutscene:not([hidden])');
  assert.match(await page.locator('#cutscene').innerText(), /garden is out/i);
  await page.locator('#replay-activity button').filter({ hasText:'Garden milestone' }).click();
  await page.waitForSelector('#cutscene:not([hidden])');
  assert.match(await page.locator('#cutscene').innerText(), /Garden milestone/);
  assert.equal(await page.locator('#party').isVisible(), false, 'Seeking cancels the previous payment window');
  await page.locator('#replay-sound').click();
  assert.equal(await page.locator('#replay-sound').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(errors, [], 'Milestone and release scenes render without errors');
  await page.locator('#replay-activity button').filter({hasText:'Cancelled · Customer cancelled'}).click();
  assert.match(await page.locator('#replay-event strong').innerText(), /SUBSCRIPTION CANCELLED/);
  assert.equal(await page.locator('#replay-event').evaluate(el => el.classList.contains('subscription')), true);
  assert.equal(await page.locator('#party').isVisible(), false, 'Cancellation does not celebrate a payment');
  assert.match(await page.locator('#replay-earned').innerText(), /29\.00/, 'Cancellation does not change earned cash');
  await page.screenshot({path:'shots/replay/subscription.png'});
  await page.locator('#replay-watch').selectOption('payments');
  assert.equal(await page.locator('#replay-activity button').filter({hasText:'Cancelled'}).count(), 0, 'Cancellation stays out of payments-only playback');
  const foreign = await browser.newPage();
  const decorRequests = [];
  foreign.on('request', request => { if (/\/decor\/.*\.(png|svg)/.test(request.url())) decorRequests.push(request.url()); });
  await foreign.route('**/api/call', async route => {
    if (route.request().postDataJSON()?.method !== 'studio.replay') { await route.continue(); return; }
    const response = await route.fetch(), body = await response.json();
    body.result.snapshot.studio.room.items = [];
    for (const moment of body.result.moments) {
      if (moment.kind === 'studio') moment.studio.room.items = [];
      if (moment.kind === 'journal' && moment.entry.kind === 'sale') { moment.entry.amount = 9.2; moment.entry.currency = 'eur'; }
    }
    await route.fulfill({ response, json: body });
  });
  await foreign.goto(`${base}/?replay=1`);
  await foreign.waitForFunction(() => window.__herdrReady === true);
  await foreign.locator('#replay-watch').selectOption('payments');
  await foreign.locator('#replay-next').click();
  assert.match(await foreign.locator('#replay-earned').innerText(), /≈USD\s+10\.00/, 'Foreign payments combine into estimated USD');
  assert.deepEqual(decorRequests, [], 'Saved empty rooms do not download unused decor');
  await foreign.close();
  // The same historical viewer must work in public installs without the optional artwork.
  await page.route('**/assets/gds/**', route => route.fulfill({ status:404, body:'' }));
  await page.reload(); await page.waitForFunction(() => window.__herdrReady === true);
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('roster-only')), true);
  assert.equal(await page.locator('#replay-play').isEnabled(), true);
  console.log('PASS replay: slow/stalled loading and retry, customer arrivals/pause/cancellation, USD conversion, project/payment filters, selective artwork, mobile card bounds, playback/seek/reload, and no live-agent calls/recap writes');
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const stopped = new Promise(r => child.once('exit', r)); child.kill(); await stopped; }
  rmSync(scratch, { recursive:true, force:true });
}
