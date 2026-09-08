import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from './studio';
import { recapMoney } from '../shared/recap-money';
import type { JournalEntry } from '../shared/studio';

test('money totals keep currencies separate and subtract refunds without counting lifecycle events', () => {
  const row = (amount?: number, currency = 'usd') => ({kind:'sale', amount, currency} as JournalEntry);
  expect(recapMoney([row(120.25),row(-10),row(8,'eur'),row(0,'gbp'),row(undefined,'aud')])).toEqual({
    totals:[{currency:'eur',amount:8},{currency:'usd',amount:110.25}],payments:2,refunds:1,billingEvents:5,
  });
});
test('period totals include all matching payments beyond the current journal page', () => {
  const dir=mkdtempSync(join(tmpdir(),'recap-money-'));
  try {
    const store=new StudioStore(dir);
    for (let i=0;i<5;i++) store.recordSale({id:`pay-${i}`,ts:1000+i,kind:'sale',amount:12.34,currency:'usd',label:'Payment'});
    store.recordSale({id:'old',ts:100,kind:'sale',amount:1000,currency:'usd',label:'Old payment'});
    store.recordSale({id:'refund',ts:1006,kind:'refund',amount:-2,currency:'usd',label:'Refund'});
    const first=store.journalPage({since:999,limit:2,moneySummary:true});
    expect(first.entries).toHaveLength(2);
    expect(first.money?.totals[0].amount).toBeCloseTo(59.70);
    expect(first.money?.payments).toBe(5);
    const next=store.journalPage({since:999,limit:2,moneySummary:true,cursor:first.cursor!});
    expect(next.money).toEqual(first.money);
    expect(store.journalPage({since:1005,moneySummary:true}).money?.totals).toEqual([{currency:'usd',amount:-2}]);
    expect(store.journalPage({since:2000,moneySummary:true}).money?.totals).toEqual([]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('legacy payments are backfilled once and edits/deletions keep indexed totals correct', async () => {
  const {Database}=await import('bun:sqlite');
  const {Storage}=await import('./storage');
  const dir=mkdtempSync(join(tmpdir(),'recap-migration-'));
  let storage: InstanceType<typeof Storage> | undefined;
  try {
    const db=new Database(join(dir,'studio.sqlite'));
    db.exec('CREATE TABLE journal (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, search_text TEXT)');
    const entry={id:'legacy',at:1000,version:0,kind:'sale',title:'Payment',notes:'',project:'',contributors:[],url:'',source:'stripe',amount:12.34,currency:'EUR'};
    db.query('INSERT INTO journal VALUES (?, ?, ?, ?, ?)').run(entry.id,entry.at,entry.kind,JSON.stringify(entry),'payment');db.close();
    storage=new Storage(dir);
    expect(storage.journalPage({limit:1,moneySummary:true}).money?.totals).toEqual([{currency:'eur',amount:12.34}]);
    storage.patch({rows:{journal:{upsert:[{...entry,amount:-2,currency:'usd'}],remove:[]}},maps:{},meta:{}});
    expect(storage.journalPage({limit:1,moneySummary:true}).money).toMatchObject({totals:[{currency:'usd',amount:-2}],refunds:1,payments:0});
    storage.close();storage=new Storage(dir);
    expect(storage.journalPage({limit:1,moneySummary:true}).money?.totals).toEqual([{currency:'usd',amount:-2}]);
    storage.patch({rows:{journal:{upsert:[],remove:['legacy']}},maps:{},meta:{}});
    expect(storage.journalPage({limit:1,moneySummary:true}).money?.totals).toEqual([]);
  } finally {storage?.close();rmSync(dir,{recursive:true,force:true});}
});
