import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichStripeCustomer, PaymentDetailsStore, revenueCatPaymentDetails, stripePaymentDetails } from './payment-details';
import { RevenueCatWebhook } from './revenuecat-webhook';
import { stripeMoney } from './stripe-events';
const event={id:'evt_details',type:'charge.succeeded',created:1750000000,livemode:false,data:{object:{id:'ch_record',amount:1499,currency:'aud',customer:'cus_test',billing_details:{name:'Morgan',email:'morgan@example.test',address:{country:'AU'}},payment_method_details:{card:{brand:'visa',last4:'4242',fingerprint:'never-export'}},client_secret:'never-export',metadata:{secret:'never-export'}}}};
test('Stripe detail allows selected customer and payment fields without raw secrets or broadcast PII',()=>{
 const detail=stripePaymentDetails(event);expect(detail.customer).toMatchObject({name:'Morgan',email:'morgan@example.test',id:'cus_test'});expect(detail.amount).toBe(14.99);expect(detail.customer?.url).toContain('/test/customers/');
 expect(JSON.stringify(detail)).not.toContain('never-export');expect(JSON.stringify(stripeMoney(event))).not.toContain('morgan@example.test');
});
test('customer permission errors retain event details and successful lookup normalizes its fields',async()=>{
 const detail=stripePaymentDetails(event);
 const failed=await enrichStripeCustomer(detail,'test',async()=>new Response('{}',{status:403}));expect(failed.note).toContain('Customers → Read');expect(failed.customer?.email).toBe('morgan@example.test');
 const enriched=await enrichStripeCustomer(detail,'test',async()=>Response.json({name:'New name',email:'new@example.test',metadata:{secret:'never-export'}}));expect(enriched.customer?.name).toBe('New name');expect(JSON.stringify(enriched)).not.toContain('never-export');
});
test('RevenueCat details survive restart separately from public event data; old events explain missing identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'herdr-payment-details-'));let store=new PaymentDetailsStore(dir);
 const hook=new RevenueCatWebhook({directory:dir,authorization:'Bearer test',record:async()=>{},publish:()=>{},recordDetail:detail=>store.put(detail)});
 const raw={api_version:'1.0',event:{id:'private-event',type:'EXPIRATION',event_timestamp_ms:Date.now(),environment:'PRODUCTION',store:'APP_STORE',expiration_reason:'UNSUBSCRIBE',product_id:'monthly',app_user_id:'customer-id',subscriber_attributes:{$displayName:{value:'Morgan'},$email:{value:'morgan@example.test'},secret:{value:'never-export'}}}};
 try {
  expect((await hook.fetch(new Request('http://local/webhooks/revenuecat',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(raw)}))).status).toBe(200);await hook.drain();
  expect(JSON.stringify(hook.recent())).not.toContain('customer-id');expect(JSON.stringify(hook.recent())).not.toContain('morgan@example.test');
  store.close();store=new PaymentDetailsStore(dir);expect(store.get('revenuecat:private-event')?.customer).toMatchObject({name:'Morgan',id:'customer-id'});expect(JSON.stringify(store.get('revenuecat:private-event'))).not.toContain('never-export');
  expect(hook.detail('revenuecat:private-event')?.customer?.email).toBe('morgan@example.test');
  expect(hook.detail('revenuecat:private-event')?.note).toBeUndefined();
  const clean=revenueCatPaymentDetails({...raw.event,expiration_at_ms:1e300});expect(clean.fields.some(field=>field.label==='Access expires')).toBe(false);
 }finally{await hook.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
