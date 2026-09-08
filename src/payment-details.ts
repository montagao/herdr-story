import type { PaymentDetails } from '../shared/payment-details';
import type { OfficeClient } from './net/office-client';
import { closeOnEscape } from './escape';
import { studioIcon } from './icons';
export type PaymentSummary = {id:string;source?:'stripe'|'revenuecat';title:string;at:number;amount?:number;currency?:string;url?:string};
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const link=(url?:string)=>{try {const parsed=new URL(url!);return parsed.protocol==='https:' && ['dashboard.stripe.com','app.revenuecat.com'].includes(parsed.hostname)?parsed.href:'';}catch{return '';}};
const money=(amount:number,currency='usd')=>{try{return new Intl.NumberFormat(undefined,{style:'currency',currency}).format(amount);}catch{return `${amount} ${currency.toUpperCase()}`;}};
export class PaymentWindow {
 private root=document.createElement('dialog');
 private generation=0;
 private returnFocus?:HTMLElement;
 private cache=new Map<string,{at:number;detail:PaymentDetails}>();
 private pending=new Map<string,Promise<PaymentDetails>>();
 constructor(private client:OfficeClient){
  this.root.id='payment-window';this.root.className='payment-window';this.root.hidden=true;this.root.setAttribute('aria-labelledby','payment-title');this.root.setAttribute('data-block-office-input','');
  document.body.append(this.root);closeOnEscape(this.root,()=>this.close());
  this.root.addEventListener('click',event=>{if(event.target===this.root)this.close();});
  this.root.addEventListener('cancel',event=>{event.preventDefault();this.close();});
 }
 get isOpen(){return this.root.open;}
 close(){this.generation++;this.root.close();this.root.hidden=true;this.root.innerHTML='';this.returnFocus?.focus({preventScroll:true});}
 async open(summary:PaymentSummary,refresh=false){
  const generation=++this.generation;
  if(!this.root.open){this.returnFocus=document.activeElement as HTMLElement;this.root.hidden=false;this.root.showModal();}
  const source=summary.source==='revenuecat'?'RevenueCat':'Stripe';
  this.root.innerHTML=`<header class="studio-header"><span class="studio-mark" aria-hidden="true">${studioIcon('coin',18)}</span><b>${source} · Payment details</b><button type="button" data-close-payment aria-label="Close payment details">×</button></header><div class="payment-paper"><small class="payment-kicker">THE STUDIO LEDGER</small><h2 id="payment-title">${esc(summary.title)}</h2><p class="payment-summary">${summary.amount!==undefined?`<b>${esc(money(summary.amount,summary.currency))}</b> · `:''}${esc(new Date(summary.at).toLocaleString())}</p><div data-payment-body aria-live="polite"><p>Loading customer and event details…</p></div></div>`;
  this.root.querySelector('[data-close-payment]')?.addEventListener('click',()=>this.close());
  if(!refresh)this.root.querySelector<HTMLButtonElement>('[data-close-payment]')?.focus();
  const body=this.root.querySelector<HTMLElement>('[data-payment-body]')!;
  const fetchDetail=()=>{
   let pending=this.pending.get(summary.id);
   if(!pending){pending=this.client.call('payment.detail',{id:summary.id,refresh},{timeoutMs:20000}).then(result=>{const detail=result as PaymentDetails;this.cache.set(summary.id,{at:Date.now(),detail});if(this.cache.size>30)this.cache.delete(this.cache.keys().next().value!);return detail;}).finally(()=>this.pending.delete(summary.id));this.pending.set(summary.id,pending);}
   return pending;
  };
  try{
   const cached=this.cache.get(summary.id);
   const detail=!refresh && cached && Date.now()-cached.at<60000?cached.detail:await fetchDetail();
   if(generation!==this.generation)return;
   const customer=detail.customer, rows=[...(detail.status?[{label:'Status',value:detail.status}]:[]),...(detail.amount!==undefined?[{label:'Amount',value:money(detail.amount,detail.currency)}]:[]),...detail.fields,{label:'Event',value:detail.eventType || detail.eventId},{label:'Event ID',value:detail.eventId}];
   for(const row of rows) if (['Purchased','Access expires','Access ends'].includes(row.label) && !Number.isNaN(Date.parse(row.value))) row.value=new Date(row.value).toLocaleString();
   const providerUrl=link(detail.url)||link(summary.url),customerUrl=link(customer?.url);
   body.innerHTML=`<section class="payment-customer"><small>CUSTOMER</small><h3>${esc(customer?.name || 'Name not provided')}</h3>${customer?.email?`<p>${esc(customer.email)}</p>`:''}${customer?.phone?`<p>${esc(customer.phone)}</p>`:''}${customer?.id?`<p class="payment-id">${esc(customer.id)}</p>`:'<p>No customer identifier was saved with this event.</p>'}${customerUrl?`<a href="${esc(customerUrl)}" target="_blank" rel="noopener noreferrer">Open customer in ${source} ↗</a>`:''}</section><dl class="payment-fields">${rows.map(row=>`<div><dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd></div>`).join('')}</dl>${detail.note?`<p class="payment-note">${esc(detail.note)}</p>`:''}<footer class="payment-actions">${providerUrl?`<a href="${esc(providerUrl)}" target="_blank" rel="noopener noreferrer">Open in ${source} ↗</a>`:''}<button type="button" data-refresh-payment>Refresh details</button></footer>`;
   body.querySelector('[data-refresh-payment]')?.addEventListener('click',()=>void this.open(summary,true));
  }catch(error){
   if(generation!==this.generation)return;
   body.innerHTML=`<p role="alert">${esc((error as Error).message)}</p><footer class="payment-actions"><button type="button" data-retry-payment>Try again</button>${link(summary.url)?`<a href="${esc(link(summary.url))}" target="_blank" rel="noopener noreferrer">Open in ${source} ↗</a>`:''}</footer>`;
   body.querySelector('[data-retry-payment]')?.addEventListener('click',()=>void this.open(summary,true));
  }
 }
}
