import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {expect,test} from 'bun:test';
import {RecapFX} from './recap-fx';
import type {RecapMoney} from '../shared/recap-money';
const money = (totals: RecapMoney['totals']):RecapMoney=>({totals,payments:2,refunds:0,billingEvents:2});
test('combines currencies into USD, subtracts refunds, and caches rate requests',async()=>{
 let calls=0;
 const fx=new RecapFX((async()=>{calls++;return Response.json([{base:'USD',quote:'EUR',rate:0.8,date:'2026-09-07'},{base:'USD',quote:'GBP',rate:0.5,date:'2026-09-07'}]);}));
 const totals=money([{currency:'usd',amount:82.22},{currency:'eur',amount:10},{currency:'gbp',amount:-2}]);
 const [a,b]=await Promise.all([fx.convert(totals),fx.convert(totals)]);
 expect(a.usd).toEqual({amount:90.72,estimated:true,rateDate:'2026-09-07'});expect(b.usd).toEqual(a.usd);
 await fx.convert(totals);expect(calls).toBe(1);
});
test('USD-only and zero totals never need a rate service',async()=>{
 const fx=new RecapFX((async()=>{throw Error('Should not fetch');}));
 expect((await fx.convert(money([{currency:'usd',amount:5}]))).usd).toEqual({amount:5,estimated:false});
 expect((await fx.convert(money([]))).usd?.amount).toBe(0);
});
test('missing rates do not silently omit a currency or pretend a partial sum is the total',async()=>{
 const fx=new RecapFX((async()=>Response.json([{base:'USD',quote:'EUR',rate:0,date:'2026-09-07'}])));
 const result=await fx.convert(money([{currency:'usd',amount:80},{currency:'eur',amount:10}]));
 expect(result.usd).toBeUndefined();expect(result.conversionUnavailable).toBe(true);
});

test('saved rates survive a restart and calculate USD without a network request', async () => {
 const directory = mkdtempSync(join(tmpdir(), 'recap-fx-cache-'));
 try {
  const path = join(directory, 'rates.json'), now = () => 1_000_000;
  const first = new RecapFX((async () => Response.json([{base:'USD',quote:'EUR',rate:0.8,date:'2026-09-07'}])), now, path);
  await first.convert(money([{currency:'eur',amount:10}]));
  expect(JSON.parse(readFileSync(path,'utf8')).rates).toHaveLength(1);
  let calls = 0;
  const restarted = new RecapFX((async () => { calls++; throw Error('Offline'); }), now, path);
  expect((await restarted.convert(money([{currency:'eur',amount:10}]))).usd?.amount).toBe(12.5);
  expect(calls).toBe(0);
 } finally { rmSync(directory,{recursive:true,force:true}); }
});
