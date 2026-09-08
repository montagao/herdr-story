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

  const id=await page.evaluate(async()=>{
    const {client,studio}=window.hs;
    const state=await client.call('studio.change',{op:'entry.save',title:'Search retention fixture',notes:'A long note '.repeat(80),kind:'note',project:'',contributors:[],url:''});
    studio.acceptState(state);studio.open('journal');return state.journal.find(entry=>entry.title==='Search retention fixture').id;
  });
  await page.waitForFunction(()=>!window.hs.studio.historyLoading);
  await page.locator(`[data-journal-entry="${id}"] [data-more-notes]`).click();
  await page.evaluate(id=>{window.keptRow=document.querySelector(`[data-journal-entry="${id}"]`);window.keptPanel=document.querySelector('.studio-content');},id);
  await page.locator('[data-journal-search]').fill('Search retention');
  assert(await page.evaluate(id=>window.keptRow===document.querySelector(`[data-journal-entry="${id}"]`),id),'Matching rows survive search');
  assert.equal(await page.locator(`[data-journal-entry="${id}"] [data-more-notes]`).textContent(),'Show less');
  await page.locator('[data-tab="room"]').click();await page.locator('[data-tab="journal"]').click();
  assert(await page.evaluate(()=>window.keptPanel===document.querySelector('.studio-content')),'Tab roundtrip retains the panel');
  await page.locator('[data-new-memory]').click();await page.locator('[name="title"]').fill('Recovered unfinished memory');
  await page.locator('[name="notes"]').fill('Details that survive refresh.');
  await page.locator('[data-tab="room"]').click();await page.locator('[data-tab="journal"]').click();
  assert.equal(await page.locator('[name="title"]').inputValue(),'Recovered unfinished memory');
  await page.reload();await page.waitForFunction(()=>window.hs?.studio?.state);
  await page.locator('[data-drafts]').click();await page.locator('[data-resume-draft="entry:new"]').click();
  assert.equal(await page.locator('[name="title"]').inputValue(),'Recovered unfinished memory');
  assert.equal(await page.locator('[name="notes"]').inputValue(),'Details that survive refresh.');
  await page.locator('[data-cancel]').click();await page.reload();await page.waitForFunction(()=>window.hs?.studio?.state);
  assert.equal(await page.locator('[data-drafts]').isVisible(),false,'Explicit cancel discards a draft');
  await page.evaluate(()=>window.hs.studio.open('journal'));await page.locator('[data-new-memory]').click();
  await page.locator('[name="title"]').fill('Confirmed draft save');await page.locator('button[type="submit"]').click();
  await page.waitForFunction(()=>!window.hs.studio.busy);
  assert.equal(await page.evaluate(()=>window.hs.studio.drafts.records.has('entry:new')),false,'Saving clears the submitted draft');
  // A confirmed save whose response/status were both lost survives reload without leaving a duplicate draft.
  await page.locator('[data-new-memory]').click();await page.locator('[name="title"]').fill('Recovered receipt after reload');
  await page.evaluate(()=>{
    const client=window.hs.client,raw=client.call.bind(client);
    client.call=async(method,params,options)=>{
      if(method==='studio.action.status')return {state:'unknown'};
      const result=await raw(method,params,options);
      if(method==='studio.change' && params.op==='entry.save')throw Object.assign(new Error('Lost save reply'),{uncertain:true});
      return result;
    };
  });
  await page.locator('button[type="submit"]').click();await page.waitForFunction(()=>!window.hs.studio.busy);
  assert.equal(await page.evaluate(()=>window.hs.studio.saves.pending.size),1);
  await page.reload();await page.waitForFunction(()=>window.hs?.studio?.state);
  await page.locator('[data-drafts]').click();await page.locator('[data-resume-draft="entry:new"]').click();
  await page.locator('[data-check-saves]').click();await page.waitForFunction(()=>!window.hs.studio.saves.pending.size);
  assert.equal(await page.evaluate(()=>window.hs.studio.drafts.records.has('entry:new')),false,'Receipt confirmation clears its recovered draft');
  assert.equal(await page.evaluate(()=>window.hs.studio.state.journal.filter(entry=>entry.title==='Recovered receipt after reload').length),1);
  await page.locator('[data-cancel]').click();
  // Delay an archive, then lose only its reply. The commit is confirmed using its durable receipt.
  await page.evaluate(()=>{
    const client=window.hs.client,raw=client.call.bind(client);window.receiptChecks=0;
    client.call=async(method,params,options)=>{
      if(method==='studio.action.status')window.receiptChecks++;
      if(method==='studio.change' && params.op==='entry.read') { await new Promise(resolve=>window.releaseArchive=resolve);await raw(method,params,options);throw Object.assign(new Error('Reply lost'),{uncertain:true}); }
      return raw(method,params,options);
    };window.rawSaveCall=raw;
  });
  await page.locator(`[data-read-entry="${id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('#studio-save-status')?.textContent.includes('longer'));
  await page.locator('[data-tab="room"]').click();
  await page.evaluate(()=>window.releaseArchive());await page.waitForFunction(()=>!window.hs.studio.busy && !window.hs.studio.readDrafts.size);
  assert.equal(await page.evaluate(()=>window.receiptChecks),1);
  assert.equal(await page.evaluate(()=>window.hs.studio.saves.pending.size),0);
  await page.evaluate(()=>window.hs.client.call=window.rawSaveCall);
  await page.locator('#studio-toast [data-undo]').click();await page.waitForFunction(()=>!window.hs.studio.busy && !window.hs.studio.readDrafts.size);
  assert.equal(await page.evaluate(id=>!!window.hs.studio.state.journal.find(entry=>entry.id===id).readAt,id),false,'Archive Undo restores unread');
  await page.evaluate(()=>window.hs.studio.close());await page.locator('[data-arrange-room]').click();
  const removed=await page.evaluate(()=>{const furniture=window.hs.office.furnishings;const item=furniture.items.find(item=>item.kind==='decor');furniture.select(item.id);return item.id;});
  await page.locator('[data-remove]').click();assert.equal(await page.evaluate(id=>window.hs.office.furnishings.items.some(item=>item.id===id),removed),false);
  await page.locator('#studio-toast [data-undo]').click();assert.equal(await page.evaluate(id=>window.hs.office.furnishings.items.some(item=>item.id===id),removed),true);
  await page.locator('[data-remove]').click();
  await page.reload();await page.waitForFunction(()=>window.hs?.studio?.state);
  await page.locator('[data-drafts]').click();await page.locator('[data-resume-draft="room"]').click();
  assert.equal(await page.evaluate(id=>window.hs.office.furnishings.items.some(item=>item.id===id),removed),false,'Arrangement draft survives refresh');
  await page.locator('[data-cancel-room]').click();
  assert.equal(await page.evaluate(id=>window.hs.office.furnishings.items.some(item=>item.id===id),removed),true,'Cancel still restores the saved room');
  assert.deepEqual(errors,[]);
  console.log('PASS retained tabs/search rows, refresh recovery, cancel/save cleanup, slow saves, lost replies, archive Undo and furniture recovery/Undo');

} finally {
  await browser.close();
  await new Promise(resolve=>{if(server.exitCode!==null||server.signalCode!==null)return resolve();server.once('exit',resolve);server.kill();});
}
