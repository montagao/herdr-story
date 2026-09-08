import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { parseRevenueCatEvent, revenueCatMoney, RevenueCatWebhook, verifyRevenueCatSignature } from './revenuecat-webhook';
import { StudioStore } from './studio';
import type { MoneyEvent } from '../shared/types';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'rc-webhook-')); dirs.push(dir); return dir; };
const payload = (patch: Record<string, unknown> = {}) => ({ api_version: '1.0', event: {
  id: 'event_1', type: 'INITIAL_PURCHASE', event_timestamp_ms: Date.now(), environment: 'PRODUCTION',
  store: 'APP_STORE', price: 9.99, price_in_purchased_currency: 14.99, currency: 'AUD',
  period_type: 'NORMAL', product_id: 'monthly', ...patch,
} });
const event = (patch: Record<string, unknown> = {}) => parseRevenueCatEvent(payload(patch));
const request = (patch: Record<string, unknown> = {}, authorization = 'Bearer private-test') => new Request('http://localhost/webhooks/revenuecat', {
  method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(payload(patch)),
});

describe('RevenueCat event mapping', () => {
  test('a cancellation says why, in plain words, and names the product', () => {
    expect(revenueCatMoney(event({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' })).money).toMatchObject({ kind: 'churned', detail: { reason: 'Customer cancelled', plan: 'monthly' } });
    expect(revenueCatMoney(event({ type: 'CANCELLATION', cancel_reason: 'PRICE_INCREASE' })).money?.detail?.reason).toBe('Declined a price increase');
    expect(revenueCatMoney(event({ type: 'EXPIRATION', expiration_reason: 'BILLING_ERROR' })).money).toMatchObject({ kind: 'expired', detail: { reason: 'Billing error' } });
    expect(revenueCatMoney(event({ type: 'CANCELLATION' })).money?.detail).toBeUndefined();
  });
  test('purchases/renewals use major local currency units and are tagged RevenueCat', () => {
    for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE']) {
      expect(revenueCatMoney(event({ type })).money).toMatchObject({ source: 'revenuecat', kind: 'sale', amount: 14.99, currency: 'aud', id: 'revenuecat:event_1' });
    }
    expect(revenueCatMoney(event({ currency: 'JPY', price_in_purchased_currency: 1200 })).money?.amount).toBe(1200);
    expect(revenueCatMoney(event({ price_in_purchased_currency: null })).money).toMatchObject({ amount: 9.99, currency: 'usd' });
    expect(revenueCatMoney(event({ price: null, price_in_purchased_currency: null })).reason).toBe('unknown-price');
  });
  test('free trials do not become sales; a paid trial conversion does', () => {
    expect(revenueCatMoney(event({ period_type: 'TRIAL', price: 0, price_in_purchased_currency: 0 })).money).toMatchObject({ kind: 'trial_started', amount: 0 });
    expect(revenueCatMoney(event({ type: 'RENEWAL', is_trial_conversion: true })).money).toMatchObject({ kind: 'sale', label: 'Trial converted · monthly' });
    expect(revenueCatMoney(event({ price: 0, price_in_purchased_currency: 0 })).money?.kind).toBe('subscription_started');
  });
  test('only refunds subtract money, not cancellation/expiration/billing issues', () => {
    expect(revenueCatMoney(event({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' })).money).toMatchObject({ kind: 'churned', amount: 0 });
    expect(revenueCatMoney(event({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' })).money).toMatchObject({ kind: 'refund', amount: -14.99 });
    expect(revenueCatMoney(event({ type: 'CANCELLATION', price_in_purchased_currency: -5 })).money?.amount).toBe(-5);
    expect(revenueCatMoney(event({ type: 'BILLING_ISSUE' })).money).toMatchObject({ kind: 'failed', amount: 0 });
    expect(revenueCatMoney(event({ type: 'EXPIRATION' })).money).toMatchObject({ kind: 'expired', amount: 0 });
    expect(revenueCatMoney(event({ type: 'UNCANCELLATION' })).money).toMatchObject({ kind: 'subscription_resumed', amount: 0 });
  });
  test('tests, sandbox, family shares, grants, invoices and Stripe overlaps never create sales', () => {
    for (const patch of [{ type: 'TEST' }, { environment: 'SANDBOX' }, { environment: null },
      { is_family_share: true }, { store: 'PROMOTIONAL' }, { type: 'INVOICE_ISSUANCE' },
      { type: 'PURCHASE_REDEEMED' }, { type: 'TEMPORARY_ENTITLEMENT_GRANT' }, { type: 'FUTURE_EVENT' }]) {
      expect(revenueCatMoney(event(patch)).money).toBeNull();
    }
    expect(revenueCatMoney(event({ store: 'STRIPE' }), true).reason).toBe('handled-by-stripe');
    expect(revenueCatMoney(event({ store: 'STRIPE' }), false).money?.kind).toBe('sale');
  });
});

test('HMAC verifies raw bytes, rejects tampering and stale timestamps', () => {
  const raw = Buffer.from(JSON.stringify(payload())), secret = 'test-signing-secret', timestamp = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  const header = `t=${timestamp},v1=${sig}`;
  expect(verifyRevenueCatSignature(raw, header, secret)).toBe(true);
  expect(verifyRevenueCatSignature(Buffer.concat([raw, Buffer.from(' ')]), header, secret)).toBe(false);
  expect(verifyRevenueCatSignature(raw, header, secret, (timestamp + 301) * 1000)).toBe(false);
  expect(verifyRevenueCatSignature(raw, `t=${timestamp},v1=x`, secret)).toBe(false);
});

test('public listener authenticates, bounds streamed bodies, and exposes no app routes', async () => {
  const hook = new RevenueCatWebhook({ authorization: 'Bearer private-test', record: async () => {}, publish: () => {} });
  expect((await hook.fetch(request({}, 'wrong'))).status).toBe(401);
  expect((await hook.fetch(new Request('http://localhost/api/state'))).status).toBe(404);
  expect((await hook.fetch(new Request('http://localhost/api/call', { method: 'POST' }))).status).toBe(404);
  expect((await hook.fetch(new Request('http://localhost/webhooks/revenuecat'))).status).toBe(405);
  const crossOrigin = request(); crossOrigin.headers.set('origin', 'https://elsewhere.test');
  expect((await hook.fetch(crossOrigin)).status).toBe(403);
  const oversized = request();
  expect((await hook.fetch(new Request(oversized.url, { method: 'POST', headers: oversized.headers, body: ' '.repeat(256 * 1024 + 1) }))).status).toBe(413);
  const bad = request({ id: '', event_timestamp_ms: 'not a date' });
  expect((await hook.fetch(bad)).status).toBe(400);
  expect(hook.status().received).toBe(0);
  await hook.close();
});

test('duplicate deliveries/restarts produce one journal payment and no replayed celebration', async () => {
  const dir = directory(), published: MoneyEvent[] = [];
  const studio = new StudioStore(dir, { asyncWrite: true });
  const options = { directory: dir, authorization: 'Bearer private-test',
    record: async (e: MoneyEvent) => { await studio.run(() => studio.recordSale(e)); },
    publish: (e: MoneyEvent, live: boolean) => { if (live) published.push(e); } };
  let hook = new RevenueCatWebhook(options);
  const responses = await Promise.all(Array.from({ length: 8 }, () => hook.fetch(request({
    app_user_id: 'private-customer', subscriber_attributes: { email: 'private@example.test' },
  }))));
  expect(responses.every(r => r.status === 200)).toBe(true);
  await hook.drain();
  expect(published.length).toBe(1);
  expect(hook.recent()).toHaveLength(1);
  expect(studio.snapshot().journal.filter(e => e.moneyId === 'revenuecat:event_1')).toHaveLength(1);
  expect(studio.snapshot().journal.find(e => e.moneyId === 'revenuecat:event_1')?.source).toBe('revenuecat');
  expect(statSync(join(dir, 'revenuecat-events.sqlite')).mode & 0o777).toBe(0o600);
  const db = new Database(join(dir, 'revenuecat-events.sqlite'));
  const saved = JSON.stringify(db.query('SELECT payload, money FROM events').all()); db.close();
  expect(saved).not.toContain('private-customer'); expect(saved).not.toContain('private@example.test');
  await hook.close();
  hook = new RevenueCatWebhook(options);
  expect((await hook.fetch(request())).status).toBe(200);
  await hook.drain();
  expect(published.length).toBe(1);
  expect(hook.status().received).toBe(1);
  await hook.close();
});

test('acknowledged events retry failed processing and recover after restart', async () => {
  const dir = directory();
  let fail = true, written = 0, liveNotifications = 0;
  const options = { directory: dir, authorization: 'Bearer private-test',
    record: async () => { if (fail) throw new Error('disk temporarily unavailable'); written++; },
    publish: (_e: MoneyEvent, live: boolean) => { if (live) liveNotifications++; } };
  let hook = new RevenueCatWebhook(options);
  expect((await hook.fetch(request())).status).toBe(200);
  await hook.drain(); expect(hook.status().pending).toBe(1);
  await hook.close(); await Bun.sleep(5);
  fail = false; hook = new RevenueCatWebhook(options);
  await hook.drain();
  expect(written).toBe(1); expect(liveNotifications).toBe(0); expect(hook.status().pending).toBe(0);
  expect(hook.recent()).toHaveLength(1);
  await hook.close();
});

test('dashboard tests are acknowledged and observable without a fake payment', async () => {
  const hook = new RevenueCatWebhook({ authorization: 'Bearer private-test', record: async () => { throw new Error('should not record'); }, publish: () => { throw new Error('should not publish'); } });
  expect((await hook.fetch(request({ type: 'TEST' }))).status).toBe(200);
  expect(hook.status().lastTestAt).toBeNumber(); expect(hook.recent()).toHaveLength(0);
  await hook.drain(); await hook.close();
});

test('every supported lifecycle notification is journaled durably without counting attempted revenue', async () => {
  const dir=directory();let studio=new StudioStore(dir,{asyncWrite:true});
  const hook=new RevenueCatWebhook({directory:dir,authorization:'Bearer private-test',record:async e=>{await studio.run(()=>studio.recordSale(e));},publish:()=>{}});
  try {
    const rows=[{id:'trial',type:'INITIAL_PURCHASE',period_type:'TRIAL',price:0,price_in_purchased_currency:0},
      {id:'free',type:'INITIAL_PURCHASE',price:0,price_in_purchased_currency:0},
      {id:'cancel',type:'CANCELLATION'}, {id:'expired',type:'EXPIRATION'}, {id:'billing',type:'BILLING_ISSUE'}, {id:'resumed',type:'UNCANCELLATION'}];
    for(const row of rows)expect((await hook.fetch(request({...row,app_user_id:'persisted-customer',subscriber_attributes:{$email:{value:'saved@example.test'}}}))).status).toBe(200);
    // Available immediately on receipt, even before the asynchronous journal writer runs.
    expect(hook.detail('revenuecat:trial')?.customer?.email).toBe('saved@example.test');
    await hook.drain();expect(hook.status().pending).toBe(0);
    await studio.close();studio=new StudioStore(dir,{asyncWrite:true});
    const entries=studio.snapshot().journal;expect(entries).toHaveLength(rows.length);
    expect(entries.every(e=>e.source==='revenuecat' && e.amount===undefined)).toBe(true);
    for(const row of rows)expect((await hook.fetch(request(row))).status).toBe(200);
    await hook.drain();expect(studio.snapshot().journal).toHaveLength(rows.length);
    expect(hook.detail('revenuecat:trial')?.customer?.email).toBe('saved@example.test');
  }finally{await hook.close();await studio.close();}
});

test('event and customer details commit together; a downstream failure stays recoverable after acknowledgement',async()=>{
 const dir=directory();let fail=true;
 const options={directory:dir,authorization:'Bearer private-test',record:async()=>{},publish:()=>{},recordDetail:()=>{if(fail)throw Error('detail index unavailable');}};
 let hook=new RevenueCatWebhook(options);const db=new Database(join(dir,'revenuecat-events.sqlite'));
 try {
  db.exec("CREATE TRIGGER reject_detail BEFORE INSERT ON events WHEN NEW.detail IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test disk error'); END");
  const row={app_user_id:'durable-id',subscriber_attributes:{$email:{value:'durable@example.test'}}};
  expect((await hook.fetch(request(row))).status).toBe(503);expect(hook.status().received).toBe(0);expect(hook.detail('revenuecat:event_1')).toBeUndefined();
  db.exec('DROP TRIGGER reject_detail');
  expect((await hook.fetch(request(row))).status).toBe(200);await hook.drain();expect(hook.status().pending).toBe(1);
  await hook.close();hook=new RevenueCatWebhook(options);expect(hook.detail('revenuecat:event_1')?.customer?.email).toBe('durable@example.test');
  fail=false;await hook.drain();expect(hook.status().pending).toBe(0);
 }finally{db.close();await hook.close();}
});

test('one-time upgrade recovers previously excluded events without resurrecting later deletions',async()=>{
 const dir=directory(),db=new Database(join(dir,'revenuecat-events.sqlite'));
 db.exec('CREATE TABLE events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, type TEXT NOT NULL, environment TEXT, payload TEXT NOT NULL, money TEXT, reason TEXT, processed INTEGER NOT NULL DEFAULT 0)');
 const oldEvent=event({id:'old_trial',period_type:'TRIAL',price:0,price_in_purchased_currency:0}),money=revenueCatMoney(oldEvent).money!;
 db.query('INSERT INTO events VALUES (?,?,?,?,?,?,?,?)').run(oldEvent.id,Date.now()-86400000,oldEvent.type,'PRODUCTION',JSON.stringify(oldEvent),JSON.stringify(money),null,1);db.close();
 const studio=new StudioStore(dir,{asyncWrite:true});let live=0;
 const options={directory:dir,authorization:'Bearer private-test',record:async(e:MoneyEvent)=>{await studio.run(()=>studio.recordSale(e));},publish:(_e:MoneyEvent,isLive:boolean)=>{if(isLive)live++;}};
 let hook=new RevenueCatWebhook(options);
 try {
  expect(hook.status().pending).toBe(1);await hook.drain();expect(live).toBe(0);expect(studio.snapshot().journal).toHaveLength(1);
  expect(hook.detail(money.id)?.note).toContain('older event');
  const entry=studio.snapshot().journal[0];await studio.run(()=>studio.change({op:'entry.remove',id:entry.id,version:entry.version},[],{snapshot:false}));
  await hook.close();hook=new RevenueCatWebhook(options);await hook.drain();expect(studio.snapshot().journal).toHaveLength(0);
 }finally{await hook.close();await studio.close();}
});
