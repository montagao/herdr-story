// All workflows run against a private mock bridge. No live agents or payments are touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-reception-')), stateDir = join(scratch, 'state'); mkdirSync(stateDir);
const now = Date.now(), lastVisit = now - 2 * 3600_000;
const entry = (id, kind, at = now - 3600_000, extra = {}) => ({ id, kind, at, version: 0, title: id, notes: '', project: '/projects/nebula', contributors: [], url: '', source: kind === 'sale' ? 'stripe' : kind === 'task' ? 'agent' : 'manual', ...extra });
const journal = [
  ...Array.from({ length: 7 }, (_, i) => entry(`Finished task ${i}`, 'task', now - 3600_000 - i, i === 0 ? { readAt: now } : {})),
  entry('Older task', 'task', now - 4 * 3600_000), entry('Reached milestone', 'milestone'), entry('Released update', 'release'),
  entry('USD purchase', 'sale', now - 1800_000, { amount: 12, currency: 'USD' }), entry('EUR purchase', 'sale', now - 1700_000, { amount: 15, currency: 'EUR' }),
  ...Array.from({ length: 68 }, (_, i) => entry(`Memory filler ${i}`, 'note', now - 600_000 + i)),
  entry('nebula-memory', 'note', now - 3 * 864e5, { title: 'Nebula memory', notes: 'Saved findings <img src=x onerror="window.injected=true">', url: 'https://example.com/artifact', readAt: now - 864e5 }),
];
writeFileSync(join(stateDir, 'studio.json'), JSON.stringify({ version: 1, revision: 1, employees: [], projects: [{ id: '/projects/nebula', version: 0, name: 'Nebula', notes: 'Launch project', goals: [], color: '#307c9b' }], journal,
  room: { version: 0, items: null, projectOrder: [] }, identities: {}, observations: {}, imports: [] }));
writeFileSync(join(stateDir, 'boss.json'), JSON.stringify({ seen: {}, employees: [], archive: Array.from({ length: 25 }, (_, i) => ({ id: `briefing-${i}`, at: now - (30 - i) * 864e5, intro: 'A saved briefing', ideas: [{ title: i === 0 ? 'Nebula launch metrics' : `Idea ${i}`, evidence: 'Saved journal evidence', why: 'Make progress visible', nextStep: 'Build a small chart' }] })) }));
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: stateDir, HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: '1', HERDR_STORY_WEBHOOK_PORT: '',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', d => appendFileSync(join(scratch, 'bridge.log'), d)); server.stderr.on('data', d => appendFileSync(join(scratch, 'bridge.log'), d));
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
let page; const errors = [];
try {
  const url = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 80; n++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(at => localStorage.setItem('herdr-story:seen-at', String(at)), lastVisit);
  const ready = async () => { await page.waitForFunction(() => window.__herdrReady && window.hs?.studio?.state?.employees.length && window.hs?.office?.receptionSprite); await page.locator('#loading').waitFor({ state: 'hidden' }); };
  await page.goto(url); await ready();
  await page.evaluate(() => {
    const c = window.hs.client, original = c.call.bind(c);
    window.receptionTest = { calls: [], prompts: [], failure: true };
    c.call = async (method, params = {}, options) => {
      window.receptionTest.calls.push({ method, params });
      if (method === 'agent.prompt') { window.receptionTest.prompts.push(params); return { state: 'sent' }; }
      if (method === 'agent.hire' || method === 'agent.boss') throw Error('Reception must not launch agents before explicit review');
      if (method === 'studio.journal' && params.search === 'failure' && window.receptionTest.failure) { window.receptionTest.failure = false; throw Error('Temporary journal failure'); }
      if (method === 'studio.journal' && params.search === 'slow') return new Promise(resolve => window.receptionTest.releaseSlow = () => resolve({ entries: [{ id: 'stale-result', title: 'Stale result', notes: '', project: '', at: Date.now(), kind: 'note' }], total: 1, cursor: null }));
      return original(method, params, options);
    };
    const agents = [...window.hs.model.agents.values()].map((a, i) => i === 0 ? { ...a, agent_status: 'blocked', activity: 'Please review the proposed launch change.' } : a);
    window.hs.model.setAgents(agents); window.hs.reception.sync();
  });

  // The receptionist sprite is the primary entry point, including its visible attention bell.
  const target = await page.evaluate(() => {
    const o = window.hs.office, sprite = o.receptionSprite, camera = o.cameras.main;
    camera.panEffect.reset(); camera.setZoom(3).centerOn(sprite.x, sprite.y - 30);
    const rect = o.game.canvas.getBoundingClientRect();
    return { x: rect.left + camera.width / 2, y: rect.top + camera.height / 2 };
  });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.mouse.click(target.x, target.y);
  await page.locator('#reception').waitFor({ state: 'visible' });
  const waiting = await page.evaluate(() => [...window.hs.model.agents.values()].filter(a => a.agent_status === 'blocked').length);
  assert(waiting > 0); assert.equal(await page.locator('#reception .needs-attention').count(), waiting);
  assert.equal(await page.locator('#reception [data-view="attention"]').getAttribute('aria-pressed'), 'true');
  assert(await page.evaluate(() => window.hs.office.receptionBell.visible));
  assert.equal((await page.evaluate(() => window.receptionTest.calls)).filter(c => ['agent.prompt', 'agent.boss', 'agent.hire'].includes(c.method)).length, 0);
  await page.screenshot({ path: join(scratch, 'attention-desktop.png') });
  await page.locator('#reception .needs-attention').first().click();
  assert(await page.locator('#reception').isHidden()); assert(await page.locator('#dialog').isVisible());
  await page.keyboard.press('Escape'); await page.locator('#front-desk').click();
  await page.evaluate(() => {
    const all = [...window.hs.model.agents.values()]; window.receptionTest.agents = all;
    window.hs.model.setAgents(all.map(a => ({ ...a, agent_status: 'idle' }))); window.hs.reception.sync();
  });
  assert(await page.locator('#reception h2').filter({ hasText: 'Everyone is taken care of.' }).isVisible());
  assert.equal(await page.evaluate(() => window.hs.office.receptionBell.visible), false);
  await page.evaluate(() => { window.hs.model.setAgents(window.receptionTest.agents); window.hs.reception.sync(); });

  // The recap reads full paginated history, including archived work outside the compact snapshot.
  await page.locator('#reception [data-view="recap"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#reception .reception-results').length === 4 && !document.querySelector('#reception .reception-results [role="status"]'));
  const counts = await page.locator('#reception .reception-results h3 > span').allTextContents();
  assert.deepEqual(counts, ['7', '1', '1', '2']);
  assert(!(await page.locator('#reception').textContent()).includes('Older task'));
  assert((await page.locator('#reception').textContent()).includes('€15.00'));
  await page.locator('[data-recap-more="task"]').click();
  await page.waitForFunction(() => document.querySelector('#reception .reception-results')?.querySelectorAll('.reception-card').length === 7);
  await page.screenshot({ path: join(scratch, 'recap-desktop.png') });

  // Search reaches old journal rows and old Boss briefings, and opens their exact saved content.
  await page.locator('#reception [data-view="search"]').click();
  const search = page.locator('#reception input[type="search"]');
  await search.fill('nebula');
  await page.locator('[data-idea="briefing-0"]').waitFor();
  assert(await page.locator('[data-entry="nebula-memory"]').isVisible());
  assert(await page.locator('#reception [data-project="/projects/nebula"]').isVisible());
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.screenshot({ path: join(scratch, 'search-desktop.png') });
  const requestsBefore = await page.evaluate(() => window.receptionTest.calls.length);
  await page.locator('[data-idea="briefing-0"]').click();
  assert.equal(await page.locator('#boss-cutscene [data-title]').textContent(), 'Nebula launch metrics');
  assert.equal((await page.evaluate(n => window.receptionTest.calls.slice(n), requestsBefore)).filter(c => c.method.startsWith('agent.boss')).length, 0);
  await page.keyboard.press('Escape'); await page.locator('#front-desk').click(); await page.locator('#reception [data-view="search"]').click();
  await page.locator('[data-entry="nebula-memory"]').waitFor(); await page.locator('[data-entry="nebula-memory"]').click();
  await page.locator('#studio-panel .journal-highlight').waitFor();
  assert((await page.locator('#studio-panel .journal-highlight').textContent()).includes('Nebula memory'));
  await page.keyboard.press('Escape'); await page.locator('#front-desk').click(); await page.locator('#reception [data-view="search"]').click();
  await search.fill('memory');
  await page.waitForFunction(() => document.querySelectorAll('#reception [data-entry]').length === 15);
  await page.locator('[data-search-more="memories"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#reception [data-entry]').length === 30);
  await search.fill('failure'); await page.locator('[data-search-retry="memories"]').waitFor();
  await page.locator('[data-search-retry="memories"]').click(); await page.locator('[data-search-retry="memories"]').waitFor({ state: 'hidden' });
  await search.fill('slow'); await page.waitForFunction(() => !!window.receptionTest.releaseSlow);
  await search.fill('nebula'); await page.locator('[data-entry="nebula-memory"]').waitFor();
  await page.evaluate(() => window.receptionTest.releaseSlow());
  assert.equal(await page.locator('[data-entry="stale-result"]').count(), 0);

  // Drafts survive Escape, and a task never overwrites another message or switches agents silently.
  await page.locator('#reception [data-view="task"]').click();
  const assignment = await page.evaluate(() => {
    const a = [...window.hs.model.agents.values()].find(a => a.agent && a.office_role !== 'boss' && a.agent_status === 'idle');
    return { pane: a.pane_id, project: (a.foreground_cwd || a.cwd).replace(/\/+$/, ''), workspace: a.workspace_id };
  });
  await page.locator('#reception [name="project"]').selectOption(assignment.project);
  await page.locator('#reception [name="agent"]').selectOption(assignment.pane);
  await page.locator('#reception textarea').fill('Build the new launch chart');
  await page.keyboard.press('Escape'); await page.locator('#front-desk').click(); await page.locator('#reception [data-view="task"]').click();
  assert.equal(await page.locator('#reception textarea').inputValue(), 'Build the new launch chart');
  await page.evaluate(async pane => {
    await window.hs.dialog.open(window.hs.model.agents.get(pane));
    const input = document.querySelector('#dialog .reply textarea'); input.value = 'Existing unsent message'; input.dispatchEvent(new Event('input', { bubbles: true }));
    window.hs.dialog.close();
  }, assignment.pane);
  await page.locator('#reception button[type="submit"]').click();
  assert((await page.locator('#reception .reception-status').textContent()).includes('already has an unsent message'));
  await page.locator('[data-open-task-agent]').click();
  assert.equal(await page.locator('#dialog .reply textarea').inputValue(), 'Existing unsent message');
  await page.locator('#dialog .reply textarea').fill(''); await page.keyboard.press('Escape');
  await page.locator('#front-desk').click(); await page.locator('#reception [data-view="task"]').click();
  await page.locator('#reception button[type="submit"]').click();
  assert(await page.locator('#reception').isHidden());
  assert.equal(await page.locator('#dialog .reply textarea').inputValue(), 'Build the new launch chart');
  assert.equal(await page.evaluate(() => window.receptionTest.prompts.length), 0, 'Review does not send a task');
  await page.locator('#dialog .reply button[type="submit"]').click();
  await page.waitForFunction(() => window.receptionTest.prompts.length === 1);
  assert.equal(await page.evaluate(() => window.receptionTest.prompts[0].text), 'Build the new launch chart');
  await page.keyboard.press('Escape'); await page.locator('#front-desk').click(); await page.locator('#reception [data-view="task"]').click();
  await page.locator('#reception textarea').fill('First task for a new hire');
  await page.locator('#reception [name="agent"]').selectOption('__hire');
  await page.locator('#reception button[type="submit"]').click();
  assert.equal(await page.locator('.hire-form [name="task"]').inputValue(), 'First task for a new hire');
  assert.equal(await page.locator('.hire-form [name="workspace_id"]').inputValue(), assignment.workspace);
  await page.keyboard.press('Escape'); await page.locator('#front-desk').click(); await page.locator('#reception [data-view="task"]').click();
  await page.locator('#reception textarea').fill('Remember this after refresh');
  await page.screenshot({ path: join(scratch, 'task-desktop.png') });
  await page.reload(); await ready(); await page.locator('#front-desk').click(); await page.locator('#reception [data-view="task"]').click();
  assert.equal(await page.locator('#reception textarea').inputValue(), 'Remember this after refresh');
  await page.evaluate(() => { window.hs.dialog.writable = false; window.hs.reception.sync(); });
  assert(await page.locator('#reception button[type="submit"]').isDisabled());
  assert((await page.locator('[data-task-hint]').textContent()).includes('read-only'));
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('.reception-window').boundingBox();
  assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 844, JSON.stringify(bounds));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(scratch, 'front-desk-mobile.png') });
  for (const viewport of [{ width:1280, height:900 }, { width:390, height:844 }]) {
    await page.setViewportSize(viewport);
    const frame = await page.locator('.reception-window').boundingBox();
    for (const view of ['attention', 'task', 'recap', 'search', 'attention']) {
      await page.locator(`#reception [data-view="${view}"]`).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const next = await page.locator('.reception-window').boundingBox();
      for (const key of ['x','y','width','height']) assert(Math.abs(frame[key] - next[key]) < 1, `Front desk ${key} changed in ${view} at ${viewport.width}px`);
      assert(await page.evaluate(() => {
        const content=document.querySelector('.reception-content').getBoundingClientRect();
        const frame=document.querySelector('.reception-window').getBoundingClientRect();
        return content.top>=frame.top && content.bottom<=frame.bottom;
      }), 'Section content stays inside the window');
    }
  }
  console.log('PASS stable front-desk position and dimensions across every section on desktop and mobile');
  await page.keyboard.press('Escape'); assert(await page.locator('#reception').isHidden());
  assert.deepEqual(errors, []);
  console.log('PASS reception sprite/bell, attention/chat, full-history recap/search/pagination, saved Boss ideas, draft-safe task review/send/hire, refresh retention, read-only and mobile/Escape');
  console.log(`Screenshots: ${scratch}`);
} catch (error) {
  console.error({ errors, scratch }); if (page) await page.screenshot({ path: join(scratch, 'failure.png') }); throw error;
} finally {
  await browser.close();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
}
