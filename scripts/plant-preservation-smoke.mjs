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



  const plantIds = await page.evaluate(async()=>{
    const {studio,office,client}=window.hs;
    const items=office.furnishings.savedItems();
    const plants=items.filter(i=>i.asset?.includes('plant')||i.asset==='floor18_244_45'||i.asset==='floor3_287_0');
    if(!plants.length)throw Error('Expected plants in initial office');
    await client.call('studio.change',{op:'room.save',version:studio.state.room.version,items,projectOrder:studio.state.room.projectOrder});
    return plants.map(i=>i.id);
  });
  await page.route('**/decor/manifest.json',route=>route.abort());
  await page.reload();await page.waitForFunction(()=>window.hs?.studio?.state&&window.hs.office.furnishings.items.length);
  await page.evaluate(()=>{window.hs.studio.startRoom();window.hs.office.regenerateRoom();window.hs.studio.paintEditBar();});
  await page.getByRole('button',{name:'Save layout',exact:true}).click();
  await page.waitForFunction(()=>!window.hs.studio.roomDraft);
  const retained=await page.evaluate(()=>window.hs.studio.state.room.items.map(i=>i.id));
  for(const id of plantIds)assert(retained.includes(id),'Tidy keeps plant with unavailable texture: '+id);
  await page.unroute('**/decor/manifest.json');
  await page.reload();await page.waitForFunction(()=>window.hs?.office?.furnishings.items.length);
  const visible=await page.evaluate(()=>window.hs.office.furnishings.items.map(i=>i.id));
  for(const id of plantIds)assert(visible.includes(id),'Plant returns when catalog loads: '+id);
  assert.deepEqual(errors,[]);
  console.log('PASS missing catalogs → Tidy → Save → reload preserves and restores every plant');
} finally {
  await browser.close();
  await new Promise(resolve=>{if(server.exitCode!==null||server.signalCode!==null)return resolve();server.once('exit',resolve);server.kill();});
}
