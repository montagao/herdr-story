// Local mock only: signed webhook -> durable journal -> browser notification -> restart recovery.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const scratch = mkdtempSync(join(tmpdir(), 'herdr-revenuecat-'));
const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), hookPort = await freePort();
const url = `http://127.0.0.1:${port}`, hookUrl = `http://127.0.0.1:${hookPort}/webhooks/revenuecat`;
const authorization = 'Bearer isolated-revenuecat-test', secret = 'isolated-signing-secret';
const children = [];
async function start(writable = true) {
  const child = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
    HERDR_STORY_PORT: String(port), HERDR_STORY_STATE_DIR: join(scratch, 'state'), HERDR_STORY_HOST: '127.0.0.1',
    HERDR_STORY_MOCK_STATIC: '1', HERDR_STORY_WRITE: writable ? '1' : '0', HERDR_STORY_WEBHOOK_MOCK: '1',
    HERDR_STORY_WEBHOOK_PORT: String(hookPort), REVENUECAT_WEBHOOK_AUTH: authorization,
    REVENUECAT_WEBHOOK_SIGNING_SECRET: secret, REVENUECAT_WEBHOOK_PUBLIC_URL: 'https://hooks.example.test/webhooks/revenuecat',
    REVENUECAT_WEBHOOK_INTEGRATION_ID: '',
    STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(log);
    try { const r = await fetch(`${url}/health`); if (r.ok) { assert.equal((await r.json()).mock, true); return child; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw Error(log);
}
const stop = c => new Promise(resolve => { if (c.exitCode !== null || c.signalCode !== null) return resolve(); c.once('exit', resolve); c.kill(); });
async function send(id, type = 'INITIAL_PURCHASE', patch = {}) {
  const body = JSON.stringify({ api_version: '1.0', event: { id, type, event_timestamp_ms: Date.now(),
    environment: 'PRODUCTION', store: 'APP_STORE', product_id: 'Lantern monthly', price: 9.99,
    currency: 'AUD', price_in_purchased_currency: 14.99, period_type: 'NORMAL', ...patch } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return fetch(hookUrl, { method: 'POST', headers: { authorization, 'content-type': 'application/json',
    'x-revenuecat-webhook-signature': `t=${timestamp},v1=${signature}` }, body });
}
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', e => errors.push(e.message));
let revenueReads = 0;
await page.route('**/api/revenue*', route => {
  if (new URL(route.request().url()).pathname !== '/api/revenue') return route.continue();
  revenueReads++; return route.fulfill({ json: { source: 'revenuecat', amount: 3399, currency: 'usd', label: 'RevenueCat', rangeSelectable: true } });
});
const ready = async () => { await page.waitForFunction(() => window.__herdrReady && window.hs?.office?.furnishings?.items.length); };
const instrument = () => page.evaluate(() => {
  window.paymentCalls = [];
  const office = window.hs.office, money = office.money.bind(office);
  office.money = e => { window.paymentCalls.push(e); money(e); };
});

try {
  execFileSync('bun',['-e', `
    import {PaymentDetailsStore,stripePaymentDetails} from './bridge/payment-details';
    import {StudioStore} from './bridge/studio';
    import {stripeMoney} from './bridge/stripe-events';
    const dir=process.env.PAYMENT_TEST_STATE,details=new PaymentDetailsStore(dir),studio=new StudioStore(dir);
    const event={id:'evt_paymentDetail',type:'charge.succeeded',created:Math.floor(Date.now()/1000),livemode:false,data:{object:{id:'ch_test',amount:4200,currency:'usd',customer:'cus_test',description:'Stripe browser fixture',billing_details:{name:'Taylor',email:'taylor@example.test'},payment_method_details:{card:{brand:'visa',last4:'4242'}}}}};
    details.put(stripePaymentDetails(event));studio.recordSale(stripeMoney(event));details.close();await studio.close();
  `],{env:{...process.env,PAYMENT_TEST_STATE:join(scratch,'state')}});
  let child=await start();
  assert.equal((await send('detail_test','EXPIRATION',{expiration_reason:'UNSUBSCRIBE',app_user_id:'customer-detail-test',subscriber_attributes:{$displayName:{value:'Morgan <img src=x onerror=alert(1)>'},$email:{value:'morgan@example.test'}},transaction_id:'transaction-42',expiration_at_ms:Date.now()})).status,200);
  await page.goto(url);await ready();
  await page.waitForFunction(()=>window.hs.studio.state.journal.some(e=>e.moneyId==='revenuecat:detail_test'));
  const snapshot=await fetch(`${url}/api/state`).then(r=>r.json());
  assert(!JSON.stringify(snapshot).includes('morgan@example.test'),'Customer information is absent from broadcast snapshots');
  assert.equal((await fetch(`http://127.0.0.1:${hookPort}/api/call`,{method:'POST',body:JSON.stringify({method:'payment.detail',params:{id:'revenuecat:detail_test'}})})).status,404);
  await page.evaluate(()=>{window.detailReads=0;const c=window.hs.client,raw=c.call.bind(c);c.call=(method,params,options)=>{if(method==='payment.detail')window.detailReads++;return raw(method,params,options);};});
  await page.locator('[data-money="revenuecat:detail_test"]').click();
  await page.locator('.payment-customer').waitFor();
  assert((await page.locator('.payment-customer').textContent()).includes('morgan@example.test'));
  assert.equal(await page.locator('.payment-customer img').count(),0,'Customer content is text, never HTML');
  assert((await page.locator('.payment-fields').textContent()).includes('transaction-42'));
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.hs.studio.open('journal'));
  const id=await page.evaluate(()=>window.hs.studio.state.journal.find(e=>e.moneyId==='revenuecat:detail_test').id);
  assert((await page.locator(`[data-journal-entry="${id}"] .entry-project`).textContent()).includes('RevenueCat'));
  await page.locator(`[data-entry="${id}"]`).click();await page.locator('.payment-customer').waitFor();
  assert.equal(await page.evaluate(()=>window.detailReads),1,'Reopening uses the short lived detail cache');
  await page.screenshot({path:join(scratch,'payment-detail-desktop.png')});
  await page.keyboard.press('Escape');assert(await page.locator('#studio-panel').isVisible(),'Escape closes only the top window');
  // Delayed failed detail requests cannot overwrite a newer window; failures offer retry.
  await page.evaluate(()=>{
    const c=window.hs.client,raw=c.call.bind(c);window.detailCall=raw;
    c.call=(method,params,options)=>method==='payment.detail'?Promise.reject(new Error('Temporary test outage')):raw(method,params,options);
  });
  await page.locator(`[data-entry="${id}"]`).click();await page.locator('[data-refresh-payment]').click();
  await page.locator('[data-retry-payment]').waitFor();
  await page.evaluate(()=>window.hs.client.call=window.detailCall);await page.locator('[data-retry-payment]').click();await page.locator('.payment-customer').waitFor();
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>{const r=document.querySelector('#payment-window').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
  await page.screenshot({path:join(scratch,'payment-detail-mobile.png')});
  await page.locator('[data-close-payment]').click();
  const stripeId=await page.evaluate(()=>window.hs.studio.state.journal.find(e=>e.moneyId==='evt_paymentDetail').id);
  await page.locator(`[data-entry="${stripeId}"]`).click();await page.locator('.payment-customer').waitFor();
  assert((await page.locator('.payment-customer').textContent()).includes('taylor@example.test'));
  assert((await page.locator('.payment-fields').textContent()).includes('4242'));
  assert((await page.locator('.payment-customer a').getAttribute('href')).includes('/test/customers/cus_test'));
  await stop(child);child=await start(false);await page.reload();await ready();
  await page.locator('[data-money="revenuecat:detail_test"]').click();await page.locator('.payment-customer').waitFor();
  assert((await page.locator('.payment-customer').textContent()).includes('morgan@example.test'),'Details survive restart and are readable in read-only offices');
  assert.deepEqual(errors,[]);
  console.log('PASS payment detail from Sales and Journal, provider labels, private storage, safe rendering, caching/retry, mobile, restart and read-only');
  console.log('Screenshots:',scratch);

} finally { await browser.close(); await Promise.all(children.map(stop)); }
