import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from './studio';

test('save receipts prevent duplicate creates across concurrent retries and restart', async () => {
 const dir=mkdtempSync(join(tmpdir(),'herdr-save-receipts-'));
 let store=new StudioStore(dir,{asyncWrite:true});
 const action_id=`${Date.now()}-${crypto.randomUUID()}`;
 const params={op:'entry.save',title:'One memory',notes:'Keep once',kind:'note',project:'',contributors:[],url:'',action_id};
 try {
  await Promise.all([store.run(()=>store.changeOnce(params,[])),store.run(()=>store.changeOnce({...params,response:'patch',base_revision:0},[]))]);
  expect(store.journalPage({}).entries).toHaveLength(1);
  const revision=store.revision;
  expect(store.actionStatus(action_id)).toEqual({state:'confirmed',revision});
  expect((store.snapshot() as any).actionReceipts).toBeUndefined();
  await store.close();store=new StudioStore(dir,{asyncWrite:true});
  expect(store.actionStatus(action_id)).toEqual({state:'confirmed',revision});
  await store.run(()=>store.changeOnce(params,[]));
  expect(store.revision).toBe(revision);
  await expect(store.run(()=>store.changeOnce({...params,title:'Different payload'},[]))).rejects.toThrow('different edit');
  expect(store.journalPage({}).entries).toHaveLength(1);
  const failed=`${Date.now()}-${crypto.randomUUID()}`;
  await expect(store.run(()=>store.changeOnce({...params,action_id:failed,title:''},[]))).rejects.toThrow();
  expect(store.actionStatus(failed)).toEqual({state:'unknown'});
  await expect(store.run(()=>store.changeOnce({...params,action_id:`${Date.now()-8*86400000}-${crypto.randomUUID()}`},[]))).rejects.toThrow('expired');
 } finally {await store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a failed durable commit rolls back its receipt and retry can commit once', async () => {
 const dir=mkdtempSync(join(tmpdir(),'herdr-save-rollback-')),store=new StudioStore(dir,{asyncWrite:true});
 const params={op:'entry.save',title:'Recoverable edit',notes:'',kind:'note',project:'',contributors:[],url:'',action_id:`${Date.now()}-${crypto.randomUUID()}`};
 try {
  const db=(store as any).storage.db;
  db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON meta WHEN NEW.key = 'actionReceipts' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  await expect(store.run(()=>store.changeOnce(params,[]))).rejects.toThrow('receipt failure');
  expect(store.actionStatus(params.action_id)).toEqual({state:'unknown'});expect(store.snapshot().journal).toHaveLength(0);
  db.exec('DROP TRIGGER reject_receipt');
  await store.run(()=>store.changeOnce(params,[]));expect(store.snapshot().journal).toHaveLength(1);
 } finally {await store.close();rmSync(dir,{recursive:true,force:true});}
});
