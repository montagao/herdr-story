// Real keyboard events against an isolated mock office; no live agents or payments are touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-escape-'));
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: join(scratch, 'state'),
  HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: '1', HERDR_STORY_WEBHOOK_PORT: '',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
const url = `http://127.0.0.1:${port}`;
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(log);
    try { const r = await fetch(url + '/health'); if (r.ok) { assert.equal((await r.json()).mock, true); break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => {
    if (req.url().endsWith('/api/call') && req.method() === 'POST') writes.push(req.postDataJSON()?.method);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__herdrReady && window.hs?.studio?.state?.employees.length);
  await page.locator('#loading').waitFor({ state: 'hidden' });
  const escape = () => page.keyboard.press('Escape');
  const blur = () => page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus(); });
  const openAgent = () => page.evaluate(() => window.hs.dialog.open([...window.hs.model.agents.values()].find(a => a.agent === 'claude')));

  // Closing a conversation with focus in the prompt preserves the draft and the running agent.
  const crew = await page.evaluate(() => window.hs.model.agents.size);
  await openAgent();
  const prompt = page.locator('#dialog textarea');
  await prompt.fill('Keep this unsent prompt when Escape closes the window.');
  await escape(); assert(await page.locator('#dialog').isHidden());
  await openAgent(); assert.equal(await prompt.inputValue(), 'Keep this unsent prompt when Escape closes the window.');
  await page.evaluate(() => document.querySelector('#dialog textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  assert(await page.locator('#dialog').isVisible(), 'IME cancellation must not dismiss the conversation');

  // Billing can be above the conversation while focus is still in the lower window.
  await page.evaluate(() => window.hs.billingSetup.open());
  await page.keyboard.down('Escape');
  assert(await page.locator('#billing-setup').isHidden());
  assert(await page.locator('#dialog').isVisible());
  await page.keyboard.down('Escape'); // auto-repeat, still the same physical press
  assert(await page.locator('#dialog').isVisible(), 'Holding Escape must not close the next window');
  await page.keyboard.up('Escape'); await escape();
  assert(await page.locator('#dialog').isHidden());

  // Every studio page still closes after its contents have replaced the focused element.
  for (const name of ['boards', 'people', 'journal', 'trophies', 'room']) {
    await page.locator(`#studio-dock [data-page="${name}"]`).click();
    await blur(); await escape();
    assert(await page.locator('#studio-panel').isHidden(), `Escape closes ${name} without focus inside it`);
  }
  await page.locator('#studio-dock [data-page="boards"]').click();
  await page.locator('#studio-panel [data-tab="journal"]').click();
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'Tab redraw reproduces lost focus');
  await escape(); assert(await page.locator('#studio-panel').isHidden());

  await page.locator('#studio-dock [data-page="journal"]').click();
  await page.locator('.studio-menu-button').first().click();
  await escape();
  assert.equal(await page.locator('.studio-menu-list:not([hidden])').count(), 0);
  assert(await page.locator('#studio-panel').isVisible(), 'First Escape closes the nested menu only');
  await escape(); assert(await page.locator('#studio-panel').isHidden());

  // Native modal dialogs win over ordinary windows regardless of their CSS z-index.
  await page.locator('#studio-dock [data-page="people"]').click();
  await page.evaluate(() => window.hs.hud.openSettings());
  await escape();
  assert(await page.locator('dialog.revenue-settings').isHidden());
  assert(await page.locator('#studio-panel').isVisible());
  await escape(); assert(await page.locator('#studio-panel').isHidden());

  await page.getByRole('button', { name: 'Hire', exact: true }).click();
  await blur(); await escape(); assert(await page.locator('#dialog').isHidden());
  await page.locator('#studio-dock [data-sweep]').click();
  await page.waitForSelector('#sweep-panel .sweep-tally');
  await blur(); await escape(); assert(await page.locator('#sweep-panel').isHidden());
  await page.locator('#theme-btn').click();
  await blur(); await escape(); assert(await page.locator('#theme-gallery').isHidden());
  assert.equal(await page.locator('#theme-btn').getAttribute('aria-expanded'), 'false');

  // Scene previews leave keyboard focus in the tray beneath them. Only the scene should close.
  await page.locator('.event-debug-toggle').click();
  await page.getByRole('button', { name: 'Sales report', exact: true }).click();
  await page.waitForSelector('#cutscene:not([hidden])');
  await blur(); await escape();
  assert(await page.locator('#cutscene').isHidden());
  assert(await page.locator('#event-debug-tray').isVisible());
  await escape(); assert(await page.locator('#event-debug-tray').isHidden());

  await page.evaluate(() => window.hs.party.money({ id: 'escape-preview', ts: Date.now(), kind: 'sale', amount: 25, currency: 'usd', label: 'Browser-only preview' }));
  await page.waitForSelector('#party:not([hidden])');
  await blur(); await escape(); assert(await page.locator('#party').isHidden());

  // The briefing's async content may also replace the focused button.
  await page.evaluate(() => { void window.hs.bossCutscene.open(false); });
  await page.waitForSelector('#boss-cutscene');
  await blur(); await escape(); assert.equal(await page.locator('#boss-cutscene').count(), 0);
  await page.evaluate(() => { void window.hs.office.showDepartures([[...window.hs.model.agents.values()][0]]); });
  await page.waitForSelector('#reorg-cutscene');
  await blur(); await escape(); assert.equal(await page.locator('#reorg-cutscene').count(), 0);
  await page.waitForFunction(() => window.hs.office.canInteract());

  assert((await (await fetch(url + '/api/state')).json()).agents.length >= crew, 'All original mock agents remain running');
  assert(!writes.some(m => ['pane.close', 'agent.interrupt', 'agent.send_keys', 'agent.prompt'].includes(m)), 'Escape only dismisses UI; it does not stop or prompt agents');
  assert.deepEqual(errors, []);
  console.log('PASS Escape: drafts, focus loss, all studio pages, menus, stacked/native windows, key repeat, IME, hire, Re-org, themes, scenes and Boss.');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
}
