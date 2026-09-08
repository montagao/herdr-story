import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeQueueFile, claudeQueueIdentity, restoredClaudeQueue, type StoredClaudeQueue } from './claude-queue';
import { MessageReceipts } from './message-receipts';
import type { AgentInfo } from '../shared/types';
const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'herdr-claude-queue-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true, force:true}); });
const agent: AgentInfo = { pane_id:'w3:p1', agent:'claude', agent_status:'idle', cwd:'/projects/game', agent_session:null };
const item: StoredClaudeQueue = { id:'queue-test-123', target:'w3:p1', text:'follow up', queued_at:1, state:'queued', attempts:0, next_attempt_at:0 };

test('restored queues require session evidence; unidentified sessions cannot survive process replacement', () => {
  expect(restoredClaudeQueue(item).state).toBe('failed');
  expect(claudeQueueIdentity(agent, 100)).not.toBe(claudeQueueIdentity(agent, 200));
  const known = { ...agent, agent_session:{agent:'claude',kind:'id',source:'herdr',value:'session1'} };
  expect(claudeQueueIdentity(known, 100)).toBe(claudeQueueIdentity(known, 200));
  expect(claudeQueueIdentity(known, 100)).not.toBe(claudeQueueIdentity({...known,agent_session:{...known.agent_session,value:'replacement'}},100));
  expect(restoredClaudeQueue({...item,state:'failed',session:'known',error:'unconfirmed'})).toMatchObject({state:'failed',error:'unconfirmed'});
});
test('queue writes capture snapshots and commit in order with private file permissions', async () => {
  const dir=directory(), file=new ClaudeQueueFile(dir), state={step:1};
  const first=file.write(state); state.step=2; const second=file.write(state); state.step=3;
  await Promise.all([first,second]);
  expect(JSON.parse(readFileSync(join(dir,'claude-queue.json'),'utf8'))).toEqual({step:2});
  expect(statSync(join(dir,'claude-queue.json')).mode&0o777).toBe(0o600);
});
test('ambiguous Claude dispatch stops without replay; explicit dismissal releases the next item once', async () => {
  const dir=directory();
  await new MessageReceipts(dir).run('w3:p1:dispatch','uncertain-queue',{text:'must not resend'},async()=>{throw Error('lost acknowledgement');}).catch(()=>{});
  const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('port')});
  const port=reservation.port!; reservation.stop(true);
  const process=Bun.spawn(['bun','bridge/server.ts','--mock'],{env:{...Bun.env,HERDR_STORY_PORT:String(port),HERDR_STORY_HOST:'127.0.0.1',HERDR_STORY_WRITE:'1',HERDR_STORY_STATE_DIR:dir,HERDR_STORY_MOCK_STATIC:'1',HERDR_STORY_POLL_MS:'100',STRIPE_SECRET_KEY:'',STRIPE_RESTRICTED_KEY:'',STRIPE_API_KEY:'',REVENUECAT_API_KEY:'',REVENUECAT_SECRET_KEY:''},stdout:'ignore',stderr:'ignore'});
  const url=`http://127.0.0.1:${port}`;
  const wait=async(check:()=>Promise<boolean>)=>{for(let n=0;n<100;n++){try{if(await check())return;}catch{}await Bun.sleep(50);}throw Error('mock bridge condition timed out');};
  const state=async()=>fetch(`${url}/api/state`).then(r=>r.json()) as Promise<{queues:StoredClaudeQueue[]}>;
  const call=async(method:string,params:unknown)=>{
    const response=await fetch(`${url}/api/call`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'call',id:crypto.randomUUID(),method,params})});
    const body=await response.json() as {result:any;error?:{message:string}};if(body.error)throw Error(body.error.message);return body.result;
  };
  try {
    await wait(async()=> { const health=await fetch(`${url}/health`); return health.ok && (await health.json() as {agents:number}).agents > 0; });
    await call('agent.queue',{target:'w3:p1',text:'must not resend',queue_id:'uncertain-queue'});
    await wait(async()=> (await state()).queues.some(q=>q.id==='uncertain-queue'&&q.state==='failed'));
    await call('agent.queue',{target:'w3:p1',text:'safe next task',queue_id:'following-queue'});
    await Bun.sleep(350);
    let terminal=await call('agent.read',{target:'w3:p1',source:'visible'});
    expect(terminal.read.text).not.toContain('must not resend');expect(terminal.read.text).not.toContain('safe next task');
    expect((await state()).queues.find(q=>q.id==='uncertain-queue')?.error).toContain('unconfirmed');
    await call('agent.queue.dismiss',{target:'w3:p1',queue_id:'uncertain-queue'});
    await wait(async()=> (await state()).queues.length===0);
    terminal=await call('agent.read',{target:'w3:p1',source:'visible'});
    expect(terminal.read.text).not.toContain('must not resend');expect(terminal.read.text.match(/safe next task/g)).toHaveLength(1);
    expect(statSync(join(dir,'claude-queue.json')).mode&0o777).toBe(0o600);
  } finally { process.kill(); await process.exited; }
},15000);
