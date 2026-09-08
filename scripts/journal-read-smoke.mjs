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
    const result=await client.call('studio.change',{op:'entry.save',title:'Archive browser test',notes:'A saved memory',kind:'note',project:'',contributors:[],url:''});
    studio.acceptState(result);studio.open('journal');
    return result.journal.find(e=>e.title==='Archive browser test').id;
  });
  await page.locator(`[data-read-entry="${id}"]`).click();
  await page.waitForFunction(id=>!document.querySelector(`[data-entry="${id}"]`) || document.querySelector(`[data-entry="${id}"]`).closest("article").hidden,id);
  await page.getByRole('button',{name:'Archive',exact:true}).click();
  await page.locator(`[data-read-entry="${id}"]`).waitFor();
  assert.equal(await page.locator(`[data-read-entry="${id}"]`).textContent(),'Mark unread');
  await page.waitForFunction(()=>!window.hs.studio.busy && !window.hs.studio.readDrafts.size);
  await page.reload();await page.waitForFunction(()=>window.hs?.studio?.state);
  await page.evaluate(()=>window.hs.studio.open('journal'));
  assert.equal(await page.locator(`[data-entry="${id}"]`).count(),0);
  await page.getByRole('button',{name:'Archive',exact:true}).click();
  await page.locator(`[data-read-entry="${id}"]`).click();
  await page.waitForFunction(id=>!document.querySelector(`[data-entry="${id}"]`) || document.querySelector(`[data-entry="${id}"]`).closest("article").hidden,id);
  await page.getByRole('button',{name:'Unread',exact:true}).click();
  await page.locator(`[data-entry="${id}"]`).waitFor();
  await page.waitForFunction(()=>!window.hs.studio.busy && !window.hs.studio.readDrafts.size);
  const ids=await page.evaluate(async()=>{
    const {client,studio}=window.hs;
    for(const title of ['Quick archive A','Quick archive B','Quick archive C']) {
      const state=await client.call('studio.change',{op:'entry.save',title,notes:'Keep this row intact',kind:'note',project:'',contributors:[],url:''});studio.acceptState(state);
    }
    studio.open('journal');
    return studio.state.journal.filter(e=>e.title.startsWith('Quick archive')).map(e=>e.id);
  });
  await page.evaluate(ids=>{
    const {client}=window.hs,call=client.call.bind(client);
    window.releaseReads=[]; window.readCalls=[]; window.rawJournalCall=call;
    client.call=(method,params,options)=>{
      if(method==='studio.change' && params.op==='entry.read') {
        window.readCalls.push(params.id);
        return new Promise((resolve,reject)=>window.releaseReads.push({ok:()=>call(method,params,options).then(resolve,reject),fail:()=>reject(new Error('Test archive failure'))}));
      }
      return call(method,params,options);
    };
    window.untouchedRow=document.querySelector(`[data-journal-entry="${ids[2]}"]`);
    window.journalSearch=document.querySelector('[data-journal-search]');
  },ids);
  await page.locator(`[data-read-entry="${ids[0]}"]`).click();
  await page.locator(`[data-read-entry="${ids[1]}"]`).click();
  assert.equal(await page.locator(`[data-journal-entry="${ids[0]}"]`).isVisible(),false,'First archive responds before the server');
  assert.equal(await page.locator(`[data-journal-entry="${ids[1]}"]`).isVisible(),false,'Another click is accepted while saving');
  assert.equal(await page.evaluate(()=>window.readCalls.length),2,'Independent entries save without waiting for each other');
  await page.evaluate(()=>window.releaseReads.shift().ok());
  await page.waitForFunction(()=>window.readCalls.length===2);
  await page.evaluate(()=>window.releaseReads.shift().fail());
  await page.waitForFunction(()=>!window.hs.studio.busy && !window.hs.studio.readDrafts.size);
  assert.equal(await page.locator(`[data-journal-entry="${ids[0]}"]`).isVisible(),false);
  assert.equal(await page.locator(`[data-journal-entry="${ids[1]}"]`).isVisible(),true,'A failed archive returns to the list');
  assert.equal(await page.evaluate(ids=>window.untouchedRow===document.querySelector(`[data-journal-entry="${ids[2]}"]`) && window.journalSearch===document.querySelector('[data-journal-search]'),ids),true,'Other rows and filters retain their DOM');
  // A late acknowledgement must not tear down another editor the user has opened.
  await page.locator(`[data-read-entry="${ids[1]}"]`).click();
  await page.locator('[data-new-memory]').click();
  await page.locator('[name="title"]').fill('Still typing while the archive saves');
  await page.evaluate(()=>window.releaseReads.shift().ok());
  await page.waitForFunction(()=>!window.hs.studio.busy && !window.hs.studio.readDrafts.size);
  assert.equal(await page.locator('[name="title"]').inputValue(),'Still typing while the archive saves');
  console.log('PASS immediate archives, rapid clicks, rollback, retained rows, and navigation during save');
  await page.locator('[data-cancel]').click();
  await page.evaluate(async()=>{
    const {client,studio}=window.hs;client.call=window.rawJournalCall;studio.close();
    for(let n=0;n<105;n++) await client.call('studio.change',{op:'entry.save',title:`Later memory ${n}`,notes:'Pagination fixture',kind:'note',project:'',contributors:[],url:''});
    studio.open('journal');
  });
  await page.locator('[data-journal-search]').fill('Archive browser test');
  await page.locator(`[data-read-entry="${id}"]`).waitFor();
  await page.waitForFunction(()=>!window.hs.studio.historyLoading);
  await page.evaluate(()=>{
    const client=window.hs.client,call=client.call.bind(client);window.olderReads=0;window.olderFilter=document.querySelector('[data-journal-search]');
    client.call=(method,params,options)=>{if(method==='studio.journal' && params.ids)window.olderReads++;return call(method,params,options);};
  });
  await page.locator(`[data-read-entry="${id}"]`).click();
  await page.waitForFunction(()=>!window.hs.studio.busy && !window.hs.studio.readDrafts.size);
  assert.equal(await page.evaluate(()=>window.olderFilter===document.querySelector('[data-journal-search]')),true);
  assert.equal(await page.evaluate(()=>window.olderReads),1,'An archived entry outside the snapshot is refreshed once');
  assert.equal(await page.locator(`[data-journal-entry="${id}"]`).isVisible(),false);
  console.log('PASS older-entry archive without duplicate fetches or resetting the filters');

  assert.deepEqual(errors,[]);
  console.log('PASS archive, reload persistence, and restore unread in journal UI');
} finally {
  await browser.close();
  await new Promise(resolve=>{if(server.exitCode!==null||server.signalCode!==null)return resolve();server.once('exit',resolve);server.kill();});
}
