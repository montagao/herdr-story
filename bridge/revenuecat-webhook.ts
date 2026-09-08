import { revenueCatPaymentDetails } from './payment-details';
import type { PaymentDetails } from '../shared/payment-details';
import { Database } from 'bun:sqlite';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MoneyEvent } from '../shared/types';

export const REVENUECAT_WEBHOOK_PATH = '/webhooks/revenuecat';
const MAX_BODY = 256 * 1024;
type Event = Record<string, unknown> & { id: string; type: string; event_timestamp_ms: number };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const string = (v: unknown) => typeof v === 'string' ? v : '';
const equal = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function verifyRevenueCatSignature(raw: Uint8Array, header: string, secret: string, now = Date.now()) {
  const parts = header.split(',').map(s => s.trim().split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1] ?? '';
  const signature = parts.find(([k]) => k === 'v1')?.[1] ?? '';
  if (!/^\d{1,12}$/.test(timestamp) || !/^[a-f\d]{64}$/i.test(signature) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  return equal(expected, signature.toLowerCase());
}

/** Shared event metadata. Customer fields are stored separately in the private receipt detail. */
export function parseRevenueCatEvent(body: unknown): Event {
  const envelope = body as { api_version?: unknown; event?: Record<string, unknown> } | null;
  const e = envelope?.event;
  if (envelope?.api_version !== '1.0' || !e || typeof e !== 'object' || Array.isArray(e)
      || !/^[\w-]{1,255}$/.test(string(e.id)) || !/^[A-Z_]{1,100}$/.test(string(e.type))
      || !Number.isSafeInteger(e.event_timestamp_ms) || Number(e.event_timestamp_ms) <= 0
      || Number(e.event_timestamp_ms) > Date.now() + 300_000) throw new Error('Invalid RevenueCat event');
  const safe: Record<string, unknown> = {};
  for (const key of ['id', 'type', 'event_timestamp_ms', 'app_id', 'environment', 'store', 'product_id',
    'currency', 'price', 'price_in_purchased_currency', 'period_type', 'is_trial_conversion', 'is_family_share',
    'purchased_at_ms', 'cancel_reason', 'expiration_reason']) {
    const v = e[key];
    if (typeof v === 'string') safe[key] = v.slice(0, 512);
    else if (finite(v) || typeof v === 'boolean') safe[key] = v;
  }
  return safe as Event;
}

/** RevenueCat's cancel and expiration reasons, in the office's words. */
const RC_REASONS: Record<string, string> = {
  UNSUBSCRIBE: 'Customer cancelled', BILLING_ERROR: 'Billing error', DEVELOPER_INITIATED: 'Cancelled by the developer',
  PRICE_INCREASE: 'Declined a price increase', CUSTOMER_SUPPORT: 'Customer support', SUBSCRIPTION_PAUSED: 'Subscription paused', UNKNOWN: 'Unknown',
};
/** Price fields are already major units. `price` is USD, even when `currency` is something else. */
export function revenueCatMoney(e: Event, stripeConnected = false): { money: MoneyEvent | null; reason?: string } {
  const skip = (reason: string) => ({ money: null, reason });
  if (e.type === 'TEST') return skip('test');
  if (e.environment !== 'PRODUCTION') return skip('not-production');
  if (e.store === 'STRIPE' && stripeConnected) return skip('handled-by-stripe');
  if (e.store === 'PROMOTIONAL' || e.is_family_share === true) return skip('no-new-payment');
  const local = finite(e.price_in_purchased_currency) && /^[A-Za-z]{3}$/.test(string(e.currency));
  const price = local ? e.price_in_purchased_currency as number : finite(e.price) ? e.price : undefined;
  const currency = local ? string(e.currency).toLowerCase() : 'usd';
  let kind: MoneyEvent['kind'];
  let amount = 0, description: string;
  switch (e.type) {
    case 'INITIAL_PURCHASE': case 'RENEWAL': case 'NON_RENEWING_PURCHASE':
      if (e.period_type === 'TRIAL') { kind = 'trial_started'; description = 'Free trial'; break; }
      if (price === undefined) return skip('unknown-price');
      if (price < 0) return skip('unexpected-purchase-price');
      if (price === 0) {
        if (e.type !== 'INITIAL_PURCHASE') return skip('free-purchase');
        kind = 'subscription_started'; description = 'Free subscription'; break;
      }
      kind = 'sale'; amount = price;
      description = e.is_trial_conversion === true ? 'Trial converted' : e.type === 'RENEWAL' ? 'Renewal'
        : e.type === 'NON_RENEWING_PURCHASE' ? 'One-time purchase' : 'New subscription';
      break;
    case 'CANCELLATION':
      if (e.cancel_reason === 'CUSTOMER_SUPPORT' || (price !== undefined && price < 0)) {
        kind = 'refund'; amount = price === undefined ? 0 : -Math.abs(price); description = 'Refund';
      } else { kind = 'churned'; description = 'Auto-renew cancelled'; }
      break;
    case 'BILLING_ISSUE': kind = 'failed'; description = 'Billing issue'; break;
    case 'EXPIRATION': kind = 'expired'; description = 'Subscription expired'; break;
    case 'UNCANCELLATION': kind = 'subscription_resumed'; description = 'Auto-renew restored'; break;
    case 'REFUND_REVERSED':
      if (price === undefined || price === 0) return skip('unknown-price');
      kind = 'sale'; amount = Math.abs(price); description = 'Refund reversed'; break;
    default: return skip('no-payment-notification');
  }
  const product = string(e.product_id).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
  const purchaseTime = ['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE'].includes(e.type)
    && Number.isSafeInteger(e.purchased_at_ms) && Number(e.purchased_at_ms) > 0 && Number(e.purchased_at_ms) <= Date.now() + 300_000;
  const why = kind === 'churned' ? RC_REASONS[string(e.cancel_reason)] : kind === 'expired' ? RC_REASONS[string(e.expiration_reason)] : undefined;
  return { money: { id: `revenuecat:${e.id}`, ts: purchaseTime ? Number(e.purchased_at_ms) : e.event_timestamp_ms, source: 'revenuecat', kind, amount, currency,
    label: [description, product].filter(Boolean).join(' · '), ...(why ? { detail: { reason: why, ...(product ? { plan: product } : {}) } } : {}) } };
}

interface Row { id: string; received_at: number; money: string; detail: string | null }
interface Options {
  directory?: string;
  authorization?: string;
  signingSecret?: string;
  stripeConnected?: () => boolean;
  /** Await durable journal writes before marking a notification processed. Must be idempotent. */
  record(event: MoneyEvent): Promise<void>;
  recordDetail?: (detail: PaymentDetails) => void;
  publish(event: MoneyEvent, live: boolean): void;
}

/** Dedicated webhook-only ingress. Safe to proxy publicly; it has no office/terminal routes. */
export class RevenueCatWebhook {
  private db: Database;
  private startedAt = Date.now();
  private draining?: Promise<void>;
  private closed = false;
  constructor(private options: Options) {
    const path = options.directory ? join(options.directory, 'revenuecat-events.sqlite') : ':memory:';
    if (options.directory) mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    if (options.directory) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, type TEXT NOT NULL, environment TEXT,
        payload TEXT NOT NULL, money TEXT, detail TEXT, reason TEXT, processed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS pending_events ON events(processed, received_at);`);
    const columns = this.db.query('PRAGMA table_info(events)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'detail')) this.db.exec('ALTER TABLE events ADD COLUMN detail TEXT');
    // Older releases marked lifecycle notifications processed even though they never entered
    // the studio journal. Queue only that previously excluded subset, once, without replaying sales.
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)');
    this.db.transaction(() => {
      if (this.db.query('SELECT name FROM migrations WHERE name = ?').get('journal-lifecycle-v1')) return;
      const rows = this.db.query('SELECT id, money FROM events WHERE money IS NOT NULL AND processed = 1').all() as { id: string; money: string }[];
      const queue = this.db.query('UPDATE events SET processed = 0 WHERE id = ?');
      for (const row of rows) {
        const money = JSON.parse(row.money) as MoneyEvent;
        const leaving = ['churned', 'expired'].includes(money.kind) && !!(money.detail?.reason || money.detail?.feedback || money.detail?.comment);
        const recorded = (['sale', 'refund', 'dispute'].includes(money.kind) && !!money.amount) || leaving;
        if (!recorded) queue.run(row.id);
      }
      this.db.query('INSERT INTO migrations(name) VALUES (?)').run('journal-lifecycle-v1');
    })();
  }
  get enabled() { return Boolean(this.options.authorization || this.options.signingSecret); }
  setSigningSecret(secret: string) { this.options.signingSecret = secret; }
  status() {
    const row = this.db.query(`SELECT COUNT(*) AS received, MAX(received_at) AS lastReceivedAt,
      MAX(CASE WHEN type = 'TEST' THEN received_at END) AS lastTestAt,
      MAX(CASE WHEN money IS NOT NULL THEN received_at END) AS lastNotificationAt,
      SUM(CASE WHEN processed = 0 THEN 1 ELSE 0 END) AS pending FROM events`).get();
    return { enabled: this.enabled, ...row as { received: number; lastReceivedAt: number | null;
      lastTestAt: number | null; lastNotificationAt: number | null; pending: number | null } };
  }
  recent(limit = 40): MoneyEvent[] {
    return (this.db.query('SELECT money FROM events WHERE money IS NOT NULL ORDER BY received_at DESC, rowid DESC LIMIT ?')
      .all(limit) as { money: string }[]).map(r => JSON.parse(r.money) as MoneyEvent).reverse();
  }
  async fetch(req: Request): Promise<Response> {
    const reply = (status: number, text: string) => new Response(text, { status, headers: { 'cache-control': 'no-store' } });
    if (new URL(req.url).pathname !== REVENUECAT_WEBHOOK_PATH) return reply(404, 'Not found');
    if (req.method !== 'POST') return reply(405, 'POST required');
    if (!this.enabled) return reply(503, 'Webhook not configured');
    // Reject browser submissions and authenticate before reading any body bytes.
    if (req.headers.has('origin')) return reply(403, 'Server-to-server requests only');
    if (this.options.authorization && !equal(req.headers.get('authorization') ?? '', this.options.authorization)) return reply(401, 'Unauthorized');
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return reply(415, 'JSON required');
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return reply(413, 'Payload too large');
    let event: Event; let detail: PaymentDetails;
    try {
      const reader = req.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_BODY) { await reader.cancel(); return reply(413, 'Payload too large'); }
        chunks.push(value);
      }
      const raw = Buffer.concat(chunks);
      if (this.options.signingSecret && !verifyRevenueCatSignature(raw, req.headers.get('x-revenuecat-webhook-signature') ?? '', this.options.signingSecret)) return reply(401, 'Invalid signature');
      const body = JSON.parse(raw.toString('utf8'));
      event = parseRevenueCatEvent(body); detail = revenueCatPaymentDetails(body.event);
    } catch { return reply(400, 'Invalid RevenueCat event'); }
    try {
      const { money, reason } = revenueCatMoney(event, this.options.stripeConnected?.());
      const savedDetail = { ...detail, amount: money?.amount || undefined, currency: money?.currency, status: money?.label };
      // Event, customer detail and outbox status commit in one SQLite statement before HTTP 200.
      this.db.query(`INSERT INTO events (id, received_at, type, environment, payload, money, detail, reason, processed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET detail = COALESCE(events.detail, excluded.detail)`).run(event.id, Date.now(), event.type, string(event.environment),
          JSON.stringify(event), money ? JSON.stringify(money) : null, JSON.stringify(savedDetail), reason ?? null, money ? 0 : 1);
    } catch { return reply(503, 'Unable to save event; please retry'); }
    setTimeout(() => void this.drain(), 0);
    return reply(200, 'OK');
  }
  detail(id: string): PaymentDetails | undefined {
    const row = this.db.query('SELECT payload, money, detail FROM events WHERE id = ?').get(id.replace(/^revenuecat:/, '')) as {payload: string; money: string | null; detail: string | null} | null;
    if (!row) return;
    if (row.detail) return JSON.parse(row.detail) as PaymentDetails;
    const money = row.money ? JSON.parse(row.money) as MoneyEvent : undefined;
    return { ...revenueCatPaymentDetails(JSON.parse(row.payload)), amount: money?.amount || undefined, currency: money?.currency, status: money?.label,
      note: 'This older event was saved before customer details were collected. New notifications keep the customer information provided by RevenueCat.' };
  }
  drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.draining) return this.draining;
    this.draining = this.process().catch(() => {
      console.warn('[revenuecat] Notification processing paused; saved events will be retried.');
    }).finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async process() {
    for (;;) {
      const row = this.db.query('SELECT id, received_at, money, detail FROM events WHERE processed = 0 ORDER BY received_at, rowid LIMIT 1').get() as Row | null;
      if (!row) return;
      const money = JSON.parse(row.money) as MoneyEvent;
      if (row.detail) this.options.recordDetail?.(JSON.parse(row.detail) as PaymentDetails);
      await this.options.record(money);
      this.db.query('UPDATE events SET processed = 1 WHERE id = ?').run(row.id);
      // Recovered events remain in the feed/journal without replaying old celebrations.
      this.options.publish(money, row.received_at >= this.startedAt);
    }
  }
  async close() { this.closed = true; await this.draining; this.db.close(); }
}
