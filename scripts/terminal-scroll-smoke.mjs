// DOM and conversation tests use only a temporary mock bridge; no real agent receives a prompt.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const directory = mkdtempSync(join(tmpdir(), 'herdr-terminal-lines-'));
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: directory, HERDR_STORY_MOCK_STATIC: '1',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().map(n => `${cache}/${n}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw Error(logs);
    try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.waitForFunction(() => window.hs?.office?.pods?.length);
  await page.evaluate(async () => {
    const { dialog, client, model } = window.hs;
    const agent = [...model.agents.values()].find(a => a.agent_status === 'working');
    window.scrollFixture = { historyReads: 0, latest: 'Live screen', releases: [] };
    client.watchOutput = (target, callback) => { window.scrollFixture.push = callback; return () => {}; };
    client.outputFresh = () => true;
    const original = client.call.bind(client);
    client.call = (method, params, options) => {
      if (method !== 'agent.read') return original(method, params, options);
      if (params.source === 'visible') return Promise.resolve({ read: { text: window.scrollFixture.latest } });
      window.scrollFixture.historyReads++;
      return new Promise(resolve => window.scrollFixture.releases.push(() => resolve({ read: {
        text: Array.from({length: 120}, (_, i) => `Earlier output line ${i}`).join('\n'),
      } })));
    };
    await dialog.open(agent);
  });
  await page.locator('[data-view="screen"]').click();
  const pre = page.locator('.terminal-output');
  await page.waitForFunction(() => document.querySelector('.terminal-output')?.dataset.loaded === 'true');
  assert.equal(await pre.evaluate(e => e.scrollHeight), await pre.evaluate(e => e.clientHeight));
  await pre.hover(); await page.mouse.wheel(0, -450);
  await page.waitForFunction(() => window.scrollFixture.historyReads === 1);
  // A working agent emits another screen while the requested scrollback is in flight.
  await page.evaluate(() => {
    const f = window.scrollFixture; f.latest = 'New live screen';
    f.push({text: f.latest, source: 'visible', live: true, at: Date.now()}); f.releases.shift()();
  });
  await page.waitForFunction(() => document.querySelector('.terminal-output').textContent.includes('Earlier output line 0'));
  const bottom = await pre.evaluate(e => e.scrollTop);
  assert(bottom > 400, 'Earlier output provides actual scrollback');
  await pre.hover(); await page.mouse.wheel(0, -350);
  await page.waitForFunction(top => document.querySelector('.terminal-output').scrollTop < top - 100, bottom);
  const reading = await pre.evaluate(e => e.scrollTop);
  await page.evaluate(() => {
    const f = window.scrollFixture; f.latest = 'Latest live screen';
    f.push({text: f.latest, source: 'visible', live: true, at: Date.now()});
  });
  await page.waitForTimeout(150);
  assert.equal(await pre.evaluate(e => e.scrollTop), reading, 'Live output does not rewind the reading position');
  assert((await pre.textContent()).includes('Earlier output line 0'));
  await page.locator('.terminal-live').click();
  await page.waitForFunction(() => document.querySelector('.terminal-output').textContent === 'Latest live screen');
  assert(await page.locator('.terminal-live').isHidden());
  // Keyboard scrolling also fetches earlier output from a screen too short to overflow.
  await pre.focus(); await page.keyboard.press('PageUp');
  await page.waitForFunction(() => window.scrollFixture.historyReads === 2);
  await page.locator('.terminal-live').click();
  await page.evaluate(() => window.scrollFixture.releases.shift()());
  await page.waitForTimeout(100);
  assert.equal(await pre.textContent(), 'Latest live screen', 'A late history response cannot undo Back to live');
  // Reproduce the unavailable-output trap: first reads disconnect, then a manual history
  // request also fails. A recovered live push must paint without clicking Back to live.
  await page.evaluate(() => {
    const {dialog,client,model}=window.hs;
    dialog.close();
    const agent=[...model.agents.values()].filter(a=>a.agent_status==='working')[1];
    window.recovery={allow:false,transcriptReads:0};
    client.watchOutput=(_target,push)=>{window.recovery.push=push;return()=>{};};
    client.outputFresh=()=>true;
    const original=client.call.bind(client);
    client.call=(method,params,options)=>{
      if(method==='agent.transcript') {
        window.recovery.transcriptReads++;
        return window.recovery.allow ? Promise.resolve({available:true,turns:[{prompt:'Task',reply:'Recovered conversation'}]}) : Promise.reject(Error('Disconnected'));
      }
      if(method==='agent.read') return params.source==='visible' && window.recovery.allow
        ? Promise.resolve({read:{text:'Recovered live output'}}) : Promise.reject(Error('Disconnected'));
      return original(method,params,options);
    };
    void dialog.open(agent);
  });
  await page.waitForFunction(()=>document.querySelector('.terminal-output').textContent.includes('reconnect'));
  await page.locator('.terminal-history').click();
  await page.waitForFunction(()=>document.querySelector('.terminal-history').textContent==='Retry earlier output');
  assert(await page.locator('.terminal-live').isHidden(),'failed first history read releases the live-output hold');
  await page.evaluate(()=>{window.recovery.allow=true;window.recovery.push({text:'Recovered live output',source:'visible',live:true,at:Date.now()});});
  await page.waitForFunction(()=>document.querySelector('.terminal-output').textContent==='Recovered live output');
  await page.waitForFunction(()=>window.recovery.transcriptReads>1);
  assert(await page.locator('[data-view="conversation"]').isEnabled(),'temporary transcript failures do not disable Conversation');
  await page.locator('[data-view="conversation"]').click();
  await page.waitForFunction(()=>document.querySelector('.transcript-output').textContent.includes('Recovered conversation'));
  console.log('PASS failed history and transcript requests recover automatically after a disconnect');
  assert.deepEqual(errors, []);
  console.log('PASS real wheel and keyboard scrollback, history during streaming, preserved reading position, Back to live, and obsolete history cancellation');

} finally {
  await browser.close();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
  rmSync(directory, { recursive: true, force: true });
}
