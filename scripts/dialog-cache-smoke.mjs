// Isolated UI regression: prompt calls are captured, never sent to a real agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const scratch = mkdtempSync(join(tmpdir(), 'herdr-dialog-cache-'));
const port = await new Promise(resolve => { const socket = createServer(); socket.listen(0, '127.0.0.1', () => { const n = socket.address().port; socket.close(() => resolve(n)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: join(scratch, 'state'), HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: '1',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
const base = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${base}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
const url = `http://127.0.0.1:${port}`;
try {
  let started = false;
  for (let n=0;n<80;n++) {
    try { if ((await fetch(`${url}/health`)).ok) { started=true; break; } } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(started, 'Mock bridge starts');
  const page=await browser.newPage({viewport:{width:1280,height:900}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url); await page.waitForFunction(()=>window.hs?.studio?.agents.length);
  const ids=await page.evaluate(()=>{
    const agents=window.hs.studio.agents.filter(a=>a.agent_status==='working').slice(0,2);
    const client=window.hs.client, original=client.call.bind(client);
    client.watchOutput=()=>()=>{}; // This test isolates the HTTP/cache fallback from output push.
    window.readTest={calls:[], settings:0, delay:450, fail:false, texts:{}, perPaneDelay:{}};
    for(const [i,a] of agents.entries()) window.readTest.texts[a.pane_id]=Array.from({length:100},(_,n)=>`Agent ${i} output line ${n}`).join('\n');
    client.call=async(method,params)=>{
      const test=window.readTest;
      if(method==='agent.settings.options')test.settings++;
      if(method!=='agent.read')return original(method,params);
      test.calls.push({...params}); const text=test.texts[params.target], fail=test.fail;
      await new Promise(resolve=>setTimeout(resolve,test.perPaneDelay[params.target]??test.delay));
      if(fail)throw Error('disconnected');
      if(params.source!=='visible')throw Error('scrollback unavailable while working');
      return {read:{text}};
    };
    return agents.map(a=>a.pane_id);
  });
  const first=ids[0], second=ids[1];
  const cold=await page.evaluate(async pane=>{
    const t=performance.now(); await window.hs.dialog.open(window.hs.model.agents.get(pane));
    return performance.now()-t;
  },first);
  await page.evaluate(()=>clearTimeout(window.hs.dialog.refreshTimer));
  const before=process.env.CACHE_BASELINE==='1';
  const warm=await page.evaluate(pane=>{
    const d=window.hs.dialog;d.close();const t=performance.now();
    window.warmRead=d.open(window.hs.model.agents.get(pane));
    return {ms:performance.now()-t,text:document.querySelector('.win-body pre').textContent};
  },first);
  if(before){console.log(JSON.stringify({coldMs:Math.round(cold),warmShowsLoading:warm.text==='loading…',warmRenderMs:Math.round(warm.ms)}));}
  else {
    assert(warm.text.includes('Agent 0 output'), 'Reopening paints cached output before the network replies');
    assert(warm.ms<200, `Cached view renders promptly (${warm.ms}ms)`);
    assert.equal(await page.evaluate(()=>window.readTest.settings),0,'Collapsed settings do not fetch model choices');
    await page.evaluate(()=>window.warmRead); await page.evaluate(()=>clearTimeout(window.hs.dialog.refreshTimer));
    assert((await page.evaluate(()=>window.readTest.calls)).every(call=>call.source==='visible'));
    await page.locator('.conversation-details > summary').click();
    await page.locator('.live-agent-settings summary').click();
    await page.waitForFunction(()=>document.querySelector('[name="effort"]').options.length>1);
    assert.equal(await page.evaluate(()=>window.readTest.settings),1);
    await page.locator('.live-agent-settings summary').click();
    await page.evaluate(async pane=>{
      const d=window.hs.dialog, a=window.hs.model.agents.get(pane), pre=document.querySelector('.terminal-output');
      pre.scrollTop=60;window.outputNode=pre.firstChild;window.outputScroll=pre.scrollTop;
      await Promise.all([d.refresh(a,pre),d.refresh(a,pre)]);
    },first);
    assert(await page.evaluate(()=>document.querySelector('.terminal-output').firstChild===window.outputNode),'Unchanged output retains its DOM');
    assert.equal(await page.locator('.terminal-output').evaluate(p=>p.scrollTop),await page.evaluate(()=>window.outputScroll),'Reading position survives a refresh');
    const failed=await page.evaluate(async pane=>{
      window.readTest.fail=true;const d=window.hs.dialog,pre=document.querySelector('.terminal-output');
      const previous=pre.textContent;await d.refresh(window.hs.model.agents.get(pane),pre);window.readTest.fail=false;
      return {previous,now:pre.textContent,status:document.querySelector('.terminal-status').textContent};
    },first);
    assert.equal(failed.now,failed.previous);assert(failed.status.includes('Last view'));
    await page.evaluate(pane=>{window.hs.dialog.close();window.hs.dialog.prefetch(window.hs.model.agents.get(pane));},second);
    await page.waitForTimeout(170);
    await page.evaluate(pane=>window.hs.dialog.open(window.hs.model.agents.get(pane)),second);
    await page.evaluate(()=>clearTimeout(window.hs.dialog.refreshTimer));
    assert.equal(await page.evaluate(pane=>window.readTest.calls.filter(c=>c.target===pane).length,second),1,'Prefetch and click share one request');
    await page.evaluate(({first,second})=>{
      const d=window.hs.dialog; d.close();window.readTest.perPaneDelay[first]=850;window.readTest.perPaneDelay[second]=100;
      window.readTest.texts[second]='Fresh output from the second agent';
      void d.open(window.hs.model.agents.get(first));void d.open(window.hs.model.agents.get(second));
    },{first,second});
    await page.waitForFunction(()=>document.querySelector('.terminal-output')?.textContent==='Fresh output from the second agent');
    await page.waitForTimeout(900);
    assert.equal(await page.locator('.terminal-output').textContent(),'Fresh output from the second agent','Late responses cannot paint another agent’s view');
    const pausedCalls=await page.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
      document.dispatchEvent(new Event('visibilitychange'));
      return window.readTest.calls.length;
    });
    await page.waitForTimeout(2100);
    assert.equal(await page.evaluate(()=>window.readTest.calls.length),pausedCalls,'Hidden tabs stop terminal polling');
    await page.evaluate(()=>{
      delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(count=>window.readTest.calls.length>count,pausedCalls);
    await page.waitForTimeout(150);
    await page.evaluate(pane => {
      const { dialog, client, model } = window.hs;
      clearTimeout(dialog.refreshTimer);
      client.outputFresh = () => true; // An old stream health lease must not suppress completion.
      window.readTest.texts[pane] = 'Final answer after completion';
      dialog.sync([...model.agents.values()].map(a => a.pane_id === pane ? { ...a, agent_status: 'done' } : a));
    }, second);
    await page.waitForFunction(() => document.querySelector('.terminal-output')?.textContent === 'Final answer after completion', null, { timeout: 1000 });
    await page.screenshot({path:join(scratch,'dialog-cache.png')});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({coldMs:Math.round(cold),cachedRenderMs:Math.round(warm.ms),simulatedNetworkDelayMs:450}));
    console.log('PASS instant cached reopen, visible-first reads, lazy settings, request coalescing, stable DOM/scroll, retained output on failure, rapid agent switching, and hidden-tab pause/resume');
    console.log(`Screenshot: ${scratch}/dialog-cache.png`);
  }
} finally {
  await browser.close();
  await new Promise(resolve=>{if(server.exitCode!==null||server.signalCode!==null)return resolve();server.once('exit',resolve);server.kill();});
}
