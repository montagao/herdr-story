// Start an isolated bridge (mock or read-only real), open an agent window, screenshot both faces.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import fs from 'node:fs';
const [mode = 'mock', out = '/tmp'] = process.argv.slice(2);
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), stateDir = mkdtempSync(join(tmpdir(), 'hs-transcript-'));
const args = ['bridge/server.ts', ...(mode === 'mock' ? ['--mock'] : [])];
const child = spawn('bun', args, { env: { ...process.env, HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: stateDir, ...(mode === 'mock' ? {} : { HERDR_STORY_WRITE: '0' }) }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', d => { const t = String(d); if (/error/i.test(t)) process.stderr.write(t); });
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
const exe = fs.readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort().map((d) => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.hs?.model?.agents?.size > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  const pane = await page.evaluate(() => {
    const all = [...window.hs.model.agents.values()];
    const pick = all.find(a => a.agent === 'claude' && a.agent_session?.kind === 'id' && a.pane_id.startsWith('w10:')) ?? all.find(a => a.agent_session?.kind === 'id') ?? all[0];
    window.hs.dialog.open(pick); return pick.pane_id;
  });
  await page.waitForFunction(() => document.querySelector('.transcript-output')?.dataset.loaded === 'true' || document.querySelector('[data-view="conversation"]')?.disabled, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => ({ available: !document.querySelector('[data-view="conversation"]').disabled, conversationShown: !document.querySelector('.transcript-output').hidden, turns: document.querySelectorAll('.turn').length, widen: !!document.querySelector('.pane-widen') }));
  console.log(mode, pane, JSON.stringify(state));
  await page.screenshot({ path: `${out}/transcript-${mode}-conversation.png` });
  await page.locator('[data-view="screen"]').click();
  await page.waitForTimeout(400);
  console.log('screen face:', JSON.stringify(await page.evaluate(() => ({ preShown: !document.querySelector('.terminal-output').hidden, history: !document.querySelector('.terminal-history').hidden }))));
  await page.screenshot({ path: `${out}/transcript-${mode}-screen.png` });
  if (mode === 'mock') {
    await page.locator('.pane-widen').click();
    await page.waitForTimeout(800);
    console.log('widen:', await page.locator('.pane-widen').textContent());
  }
  await page.locator('[data-view="conversation"]').click();
  await page.waitForTimeout(300);
  console.log('back:', JSON.stringify(await page.evaluate(() => ({ conversationShown: !document.querySelector('.transcript-output').hidden, stored: localStorage.getItem('herdr-story.output-view') }))));
} finally { await browser.close(); child.kill(); }
