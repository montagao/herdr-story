import type { MoneyDetail, MoneyEvent } from '../shared/types';

/** Currencies Stripe counts in whole units rather than hundredths. */
export const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv',
  'xaf', 'xof', 'xpf']);

/** The events the office listens for. A subscription's update is included for one change only:
 *  the customer asking to cancel, which Stripe reports weeks before the subscription actually
 *  ends. `deleted` is that ending. */
export const STRIPE_EVENT_TYPES = [
  'charge.succeeded',
  'charge.refunded',
  'charge.failed',
  'charge.dispute.created',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
] as const;

export interface StripeEvent { id: string; type: string; created: number; livemode?: boolean; data?: { object?: Record<string, any>; previous_attributes?: Record<string, any> } }

/** Stripe's cancellation_details, in the office's words. `reason` is who or what ended it;
 *  `feedback` is the category the customer picked in the Customer Portal. */
const REASONS: Record<string, string> = { cancellation_requested: 'Customer cancelled', payment_disputed: 'Payment disputed', payment_failed: 'Payment failed' };
const FEEDBACK: Record<string, string> = {
  too_expensive: 'Too expensive', missing_features: 'Missing features', switched_service: 'Switched to another service', unused: 'Not using it',
  customer_service: 'Customer service', too_complex: 'Too complex', low_quality: 'Low quality', other: 'Other',
};
/** Free text from a customer: control characters out, whitespace folded, length bounded. */
const clean = (value: unknown, max: number) => typeof value === 'string'
  ? [...value].map(c => { const code = c.charCodeAt(0); return code < 32 || code === 127 ? ' ' : c; }).join('').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;

/** Where this record lives in the dashboard. Test-mode events go to the test dashboard. */
export function dashboardUrl(ev: StripeEvent, o: Record<string, any>): string | undefined {
  const base = `https://dashboard.stripe.com/${ev.livemode === false ? 'test/' : ''}`;
  const id = typeof o.id === 'string' ? o.id : undefined;
  if (ev.type.startsWith('customer.subscription.')) return id && `${base}subscriptions/${id}`;
  if (ev.type === 'charge.dispute.created') return id && `${base}disputes/${id}`;
  if (ev.type.startsWith('charge.')) { const intent = typeof o.payment_intent === 'string' ? o.payment_intent : id; return intent && `${base}payments/${intent}`; }
  if (ev.type === 'invoice.paid') return id && `${base}invoices/${id}`;
  return undefined;
}

/** The plan, as its nickname or its price: "Pro monthly", or "18 USD/month". */
export function planOf(o: Record<string, any>): string | undefined {
  const price = o.items?.data?.[0]?.price ?? o.items?.data?.[0]?.plan ?? o.plan;
  if (!price || typeof price !== 'object') return undefined;
  const nickname = clean(price.nickname, 60);
  if (nickname) return nickname;
  const amount = typeof price.unit_amount === 'number' ? price.unit_amount : typeof price.amount === 'number' ? price.amount : undefined;
  if (amount === undefined) return undefined;
  const currency = String(price.currency ?? o.currency ?? 'usd').toLowerCase();
  const n = amount / (ZERO_DECIMAL.has(currency) ? 1 : 100);
  const interval = price.recurring?.interval ?? price.interval;
  const text = `${n % 1 ? n.toFixed(2) : n} ${currency.toUpperCase()}`;
  return interval ? `${text}/${interval}` : text;
}

/** What a subscription event says beyond its kind. Only cancellations carry a reason. */
export function subscriptionDetail(ev: StripeEvent, o: Record<string, any>, ending: boolean): MoneyDetail | undefined {
  const cd = (o.cancellation_details ?? {}) as Record<string, unknown>;
  const detail: MoneyDetail = {};
  if (ending) {
    const reason = REASONS[String(cd.reason ?? '')]; if (reason) detail.reason = reason;
    const feedback = FEEDBACK[String(cd.feedback ?? '')]; if (feedback) detail.feedback = feedback;
    const comment = clean(cd.comment, 300); if (comment) detail.comment = comment;
    const ends = seconds(o.cancel_at) ?? seconds(o.ended_at) ?? seconds(o.current_period_end); if (ends) detail.ends = ends;
  }
  const plan = planOf(o); if (plan) detail.plan = plan;
  const url = dashboardUrl(ev, o); if (url) detail.url = url;
  return Object.keys(detail).length ? detail : undefined;
}

/** One Stripe event as the office sees it, or null for the ones it does not care about. */
export function stripeMoney(ev: StripeEvent): MoneyEvent | null {
  const o = ev.data?.object ?? {};
  let kind: MoneyEvent['kind'];
  let label = '';
  switch (ev.type) {
    case 'charge.succeeded': kind = 'sale'; break;
    case 'charge.refunded': kind = 'refund'; break;
    case 'charge.failed': kind = 'failed'; break;
    case 'charge.dispute.created': kind = 'dispute'; break;
    case 'customer.subscription.deleted': kind = 'churned'; label = 'subscription ended'; break;
    case 'customer.subscription.updated': {
      // Of everything an update can be, only the customer's decision matters here: asking to
      // cancel at the end of the period, or taking that back.
      const before = ev.data?.previous_attributes ?? {};
      if (o.cancel_at_period_end === true && before.cancel_at_period_end === false) { kind = 'churned'; label = 'cancels at period end'; }
      else if (o.cancel_at_period_end === false && before.cancel_at_period_end === true) { kind = 'subscription_resumed'; label = 'cancellation withdrawn'; }
      else return null;
      break;
    }
    case 'customer.subscription.created': {
      const status = String(o.status ?? '').toLowerCase();
      if (status === 'trialing') kind = 'trial_started';
      else if (status === 'incomplete' || status === 'past_due' || status === 'unpaid') kind = 'subscription_pending';
      else if (status === 'active') {
        const items = Array.isArray(o.items?.data) ? o.items.data : [];
        const amounts = items.map((item: any) => item?.price?.unit_amount ?? item?.plan?.amount)
          .filter((amount: unknown) => typeof amount === 'number');
        if (!amounts.length && typeof o.plan?.amount === 'number') amounts.push(o.plan.amount);
        if (amounts.length && amounts.every((amount: number) => amount === 0)) kind = 'subscription_started';
        else return null;
      }
      // Active does not necessarily mean paid. Its first paid invoice is the authoritative event.
      else return null;
      break;
    }
    case 'invoice.paid':
      // Trial starts generate a paid $0 first invoice too. The trialing subscription event above
      // describes that lifecycle change; only money received here proves a paid subscriber.
      if (o.billing_reason !== 'subscription_create' || Number(o.amount_paid ?? 0) <= 0) return null;
      kind = 'subscribed';
      break;
    default: return null;
  }
  const currency = String(o.currency ?? o.plan?.currency ?? 'usd').toLowerCase();
  const scale = ZERO_DECIMAL.has(currency) ? 1 : 100;
  // A refund reports what was sent back, and reads as money leaving. Subscription lifecycle rows
  // carry no money because charge.succeeded is the authoritative dollar event alongside them.
  const minor = kind === 'refund' ? -Number(o.amount_refunded ?? o.amount ?? 0)
    : kind === 'subscribed' || kind === 'subscription_started' || kind === 'trial_started'
      || kind === 'subscription_pending' || kind === 'churned' || kind === 'subscription_resumed' ? 0
    : Number(o.amount ?? 0);
  // description is the merchant's own text. Nothing else about the customer is copied: their
  // name and email stay in Stripe. What does come along is the reason they gave for leaving.
  const described = typeof o.description === 'string' ? o.description.slice(0, 80) : '';
  const fallback: Record<MoneyEvent['kind'], string> = {
    sale: 'payment', refund: 'refund', failed: 'payment failed', dispute: 'disputed',
    subscribed: 'first subscription payment', subscription_started: 'free subscription',
    subscription_pending: 'awaiting first payment', trial_started: 'trial subscription',
    churned: 'subscription cancelled', expired: 'subscription expired', subscription_resumed: 'subscription resumed',
  };
  const subscription = ev.type.startsWith('customer.subscription.');
  const detail = subscription ? subscriptionDetail(ev, o, kind === 'churned') : (() => { const url = dashboardUrl(ev, o); return url ? { url } : undefined; })();
  return { id: ev.id, source: 'stripe', ts: (Number(ev.created) || 0) * 1000 || Date.now(), kind,
    amount: minor / scale, currency, label: described || label || fallback[kind], ...(detail ? { detail } : {}) };
}
