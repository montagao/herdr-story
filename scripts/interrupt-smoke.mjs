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

  const first = await page.evaluate(() => window.hs.studio.agents.find(a => a.agent === 'codex' && a.agent_status === 'working').pane_id);
  await page.evaluate(async pane => {
    const {dialog,model}=window.hs;
    await dialog.open(model.agents.get(pane));
    const c=dialog.conversations.get(dialog.queueKey(model.agents.get(pane)));
    c.outbox.push({id:'stop-test',text:'Review the screenshot',images:[{file:new File(['test image'],'test.png',{type:'image/png'}),url:URL.createObjectURL(new Blob(['test image'],{type:'image/png'}))}],state:'working'});
  },first);
  await page.getByRole('button',{name:'■ Stop task',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('form.reply textarea')?.value==='Review the screenshot');
  assert.match(await page.locator('.reply-note').textContent(),/stopped/);
  assert.equal(await page.locator('.reply-attachments img').count(),1,'Restores original image attachment');
  assert.equal(await page.getByRole('button',{name:'■ Stop task',exact:true}).isVisible(),false);
  const terminal=await page.evaluate(pane=>window.hs.client.call('agent.read',{target:pane,source:'visible'}),first);
  assert.match(terminal.read.text,/Escape/);
  // Interrupt a new turn while a different draft is present: preserve it until explicit restore.
  await page.evaluate(async pane=>{
    await window.hs.client.call('agent.prompt',{target:pane,text:'Continue review'});
    window.hs.dialog.sync([...window.hs.model.agents.values()].map(a=>a.pane_id===pane?{...a,agent_status:'working'}:a));
  },first);
  await page.locator('form.reply textarea').fill('Keep my new draft');
  await page.getByRole('button',{name:'■ Stop task',exact:true}).click();
  await page.getByRole('button',{name:'Restore last prompt',exact:true}).waitFor();
  assert.equal(await page.locator('form.reply textarea').inputValue(),'Keep my new draft');
  await page.getByRole('button',{name:'Restore last prompt',exact:true}).click();
  assert.equal(await page.locator('form.reply textarea').inputValue(),'Continue review');
  assert.deepEqual(errors,[]);
  console.log('PASS Stop interrupts mock agent, restores last prompt, preserves existing drafts, and supports explicit restore');
} finally {
  await browser.close();
  await new Promise(resolve=>{if(server.exitCode!==null||server.signalCode!==null)return resolve();server.once('exit',resolve);server.kill();});
}
