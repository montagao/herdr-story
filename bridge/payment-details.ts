import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { PaymentDetails } from '../shared/payment-details';
import { dashboardUrl, planOf, stripeMoney, ZERO_DECIMAL, type StripeEvent } from './stripe-events';
export const cleanDetail = (value: unknown, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const idOf = (value: any) => cleanDetail(typeof value === 'string' ? value : value?.id);
const field = (label: string, value: unknown) => { const text = cleanDetail(value); return text ? [{ label, value: text }] : []; };
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : undefined;
const dateField = (label: string, value: unknown) => timestamp(value) ? [{ label, value: new Date(value as number).toISOString() }] : [];

export function stripePaymentDetails(event: StripeEvent): PaymentDetails {
 const o=event.data?.object ?? {}, money=stripeMoney(event), customer=typeof o.customer==='object' ? o.customer : {};
 const currency=cleanDetail(o.currency || 'usd'), minor=event.type==='charge.refunded' ? -Number(o.amount_refunded ?? 0) : o.amount_paid ?? o.amount;
 const billing=o.billing_details ?? {}, card=o.payment_method_details?.card;
 const customerId=idOf(o.customer);
 return {source:'stripe',eventId:event.id,eventType:event.type,occurredAt:event.created*1000,
  ...(typeof minor==='number' && Number.isFinite(minor) ? {amount:minor/(ZERO_DECIMAL.has(currency.toLowerCase())?1:100),currency} : {}),
  status:cleanDetail(o.status)||money?.label,url:dashboardUrl(event,o),
  customer:{id:customerId,name:cleanDetail(customer?.name || o.customer_name || billing.name),email:cleanDetail(customer?.email || o.customer_email || billing.email || o.receipt_email),phone:cleanDetail(customer?.phone || billing.phone),
   ...(customerId ? {url:`https://dashboard.stripe.com/${event.livemode===false?'test/':''}customers/${encodeURIComponent(customerId)}`} : {})},
  fields:[...field('Description',o.description),...field('Plan',planOf(o)),...field('Reason',money?.detail?.reason || o.failure_message || o.reason),...field('Feedback',money?.detail?.feedback),...field('Customer comment',money?.detail?.comment),
   ...field('Payment method',card ? `${cleanDetail(card.brand)} •••• ${/^\d{4}$/.test(card.last4)?card.last4:''}` : o.payment_method_details?.type),
   ...field('Country',billing.address?.country),...field('Record ID',o.id),...field('Subscription',idOf(o.subscription ?? o.parent?.subscription_details?.subscription)),
   ...dateField('Access ends',money?.detail?.ends),...field('Environment',event.livemode===false?'Test':'Live')]};
}
export function revenueCatPaymentDetails(event: Record<string, any>): PaymentDetails {
 const attrs=event.subscriber_attributes ?? {}, id=cleanDetail(event.app_user_id || event.original_app_user_id);
 const labels:Record<string,string>={APP_STORE:'App Store',PLAY_STORE:'Google Play',STRIPE:'Stripe',AMAZON:'Amazon',RC_BILLING:'RevenueCat Billing',NORMAL:'Normal billing',TRIAL:'Free trial',INTRO:'Introductory offer',PRODUCTION:'Production',SANDBOX:'Sandbox',UNSUBSCRIBE:'Customer cancelled',BILLING_ERROR:'Billing error',DEVELOPER_INITIATED:'Cancelled by developer',CUSTOMER_SUPPORT:'Customer support',PRICE_INCREASE:'Declined a price increase',SUBSCRIPTION_PAUSED:'Subscription paused'};
 const friendly=(value:unknown)=>labels[cleanDetail(value)] || cleanDetail(value).replace(/_/g,' ').toLowerCase();
 return {source:'revenuecat',eventId:`revenuecat:${event.id}`,eventType:cleanDetail(event.type),occurredAt:timestamp(event.event_timestamp_ms),
  customer:{id,name:cleanDetail(attrs.$displayName?.value),email:cleanDetail(attrs.$email?.value),phone:cleanDetail(attrs.$phoneNumber?.value)},
  fields:[...field('Product',event.product_id),...field('Store',friendly(event.store)),...field('Period',friendly(event.period_type)),...field('Reason',friendly(event.cancel_reason || event.expiration_reason)),
   ...field('Transaction ID',event.transaction_id),...field('Original transaction',event.original_transaction_id),...field('App ID',event.app_id),...field('Environment',friendly(event.environment)),...field('Country',event.country_code),
   ...dateField('Purchased',event.purchased_at_ms),...dateField('Access expires',event.expiration_at_ms)]};
}
/** The detail index is private to the host, outside the shared studio and exported demos. */
export class PaymentDetailsStore {
 private db:Database;
 constructor(directory?:string) {
  if(directory)mkdirSync(directory,{recursive:true,mode:0o700});
  const path=directory?join(directory,'payment-details.sqlite'):':memory:';
  this.db=new Database(path);if(directory)chmodSync(path,0o600);
  this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS details (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
 }
 put(details:PaymentDetails) { this.db.query('INSERT INTO details(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(details.eventId,JSON.stringify(details)); }
 get(id:string):PaymentDetails|undefined {const row=this.db.query('SELECT data FROM details WHERE id=?').get(id) as {data:string}|null;return row?JSON.parse(row.data):undefined;}
 close(){this.db.close();}
}

/** Customer lookups happen only when a detail is opened; restricted keys can still show event data. */
export async function enrichStripeCustomer(details:PaymentDetails, key:string, request:(input:string, init?:RequestInit)=>Promise<Response>=fetch):Promise<PaymentDetails> {
 const id=details.customer?.id;if(!id || !/^cus_[A-Za-z0-9]+$/.test(id))return details;
 try {
  const response=await request(`https://api.stripe.com/v1/customers/${id}`,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(6000)});
  if(!response.ok)return {...details,note:response.status===403?'Customer lookup needs Customers → Read on your Stripe restricted key. Available payment details are shown.':'Customer details could not be refreshed. Available payment details are shown.'};
  const customer=await response.json() as Record<string,any>;
  if(customer.deleted)return {...details,note:'This customer has been deleted in Stripe.'};
  return {...details,customer:{...details.customer,name:cleanDetail(customer.name)||details.customer?.name,email:cleanDetail(customer.email)||details.customer?.email,phone:cleanDetail(customer.phone)||details.customer?.phone}};
 }catch{return {...details,note:'Customer lookup timed out. Available payment details are shown.'};}
}
