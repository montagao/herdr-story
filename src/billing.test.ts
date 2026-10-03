import { expect, test } from 'bun:test';
import { billingLabel, journalCategory, journalMoneyKind } from '../shared/billing';
import { replayMoney, type ReplayData } from '../shared/replay';
import { replayHighlights } from './replay-selection';
import { pageJournal } from '../shared/journal-page';
import { StudioStore } from '../bridge/studio';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JournalEntry } from '../shared/studio';
const cancelled: JournalEntry = {id:'cancel',version:0,at:1000,kind:'sale',title:'Cancelled · Customer cancelled',notes:'Plan: 44 USD/month',project:'',contributors:[],url:'',source:'stripe',moneyId:'evt_cancel'};

test('legacy cancellation history becomes subscription activity, not a sale or pending payment', () => {
  expect(journalMoneyKind(cancelled)).toBe('churned');
  expect(billingLabel(replayMoney(cancelled)!.kind)).toBe('Subscription cancelled');
  expect(journalCategory(cancelled)).toBe('subscription');
  const moments = [{id:'cancel',at:1000,kind:'journal' as const,entry:cancelled},
    {id:'raw',at:1000,kind:'money' as const,event:{id:'raw',ts:1000,kind:'churned' as const,amount:44,currency:'usd',label:'Cancelled'}}];
  expect(replayHighlights({moments} as ReplayData,'payments')).toEqual([]);
  expect(pageJournal([cancelled],[],{kind:'subscription'},0,'test').entries).toEqual([cancelled]);
  expect(pageJournal([cancelled],[],{kind:'sale'},0,'test').entries).toEqual([]);
});

test('provider billing type survives edits and SQLite persistence; category filters agree', async () => {
  const directory = mkdtempSync(join(tmpdir(),'herdr-billing-test-'));
  try {
    const store = new StudioStore(directory);
    store.recordSale({id:'cancel',ts:1000,kind:'churned',amount:0,currency:'usd',label:'Cancelled',source:'stripe',detail:{reason:'Customer cancelled'}});
    store.recordSale({id:'paid',ts:2000,kind:'sale',amount:44,currency:'usd',label:'Paid',source:'stripe'});
    const entry = store.snapshot().journal.find(e=>e.moneyId==='cancel')!;
    store.change({op:'entry.save',id:entry.id,version:entry.version,title:'Customer feedback',notes:'Leaving for now',project:'',url:''},[]);
    await store.flush();
    const restored = new StudioStore(directory);
    const subscriptions = restored.journalPage({kind:'subscription'}).entries;
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].moneyKind).toBe('churned');
    expect(journalMoneyKind(subscriptions[0])).toBe('churned');
    expect(restored.journalPage({kind:'sale'}).entries.map(e=>e.moneyId)).toEqual(['paid']);
    expect(pageJournal(restored.snapshot().journal,[],{kind:'subscription'},0,'test').entries).toEqual(subscriptions);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
