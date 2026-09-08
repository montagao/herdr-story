import { expect, test } from 'bun:test';
import { STRIPE_EVENT_TYPES, dashboardUrl, planOf, stripeMoney } from './stripe-events';

const event = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: `evt_${type}`, type, created: 1_700_000_000, livemode: true, data: { object, ...extra } });
const price = { nickname: '', unit_amount: 1800, currency: 'usd', recurring: { interval: 'month' } };

test('a cancelled subscription carries why, the plan, when access ends and the way into Stripe', () => {
  const money = stripeMoney(event('customer.subscription.deleted', {
    id: 'sub_1', currency: 'usd', items: { data: [{ price }] }, ended_at: 1_700_500_000,
    cancellation_details: { reason: 'cancellation_requested', feedback: 'too_expensive', comment: ' Loved it,\n but I only\tneeded it for one project. ' },
  }))!;
  expect(money).toMatchObject({ kind: 'churned', amount: 0, label: 'subscription ended', source: 'stripe' });
  expect(money.detail).toEqual({ reason: 'Customer cancelled', feedback: 'Too expensive', comment: 'Loved it, but I only needed it for one project.',
    ends: 1_700_500_000_000, plan: '18 USD/month', url: 'https://dashboard.stripe.com/subscriptions/sub_1' });
});
test('the customer asking to cancel is reported when it happens, not when the period runs out', () => {
  const asked = stripeMoney(event('customer.subscription.updated', { id: 'sub_2', cancel_at_period_end: true, cancel_at: 1_701_000_000, items: { data: [{ price: { ...price, nickname: 'Pro monthly' } }] },
    cancellation_details: { reason: 'cancellation_requested', feedback: 'unused', comment: null } }, { previous_attributes: { cancel_at_period_end: false } }))!;
  expect(asked).toMatchObject({ kind: 'churned', label: 'cancels at period end' });
  expect(asked.detail).toEqual({ reason: 'Customer cancelled', feedback: 'Not using it', ends: 1_701_000_000_000, plan: 'Pro monthly', url: 'https://dashboard.stripe.com/subscriptions/sub_2' });
  const withdrawn = stripeMoney(event('customer.subscription.updated', { id: 'sub_2', cancel_at_period_end: false }, { previous_attributes: { cancel_at_period_end: true } }))!;
  expect(withdrawn).toMatchObject({ kind: 'subscription_resumed', label: 'cancellation withdrawn' });
  expect(stripeMoney(event('customer.subscription.updated', { id: 'sub_2', cancel_at_period_end: false }, { previous_attributes: { metadata: {} } }))).toBeNull();
  expect(STRIPE_EVENT_TYPES).toContain('customer.subscription.updated');
});
test('a cancellation with nothing said still says so, and the comment is bounded', () => {
  const quiet = stripeMoney(event('customer.subscription.deleted', { id: 'sub_3', current_period_end: 1_700_000_100 }))!;
  expect(quiet.detail).toEqual({ ends: 1_700_000_100_000, url: 'https://dashboard.stripe.com/subscriptions/sub_3' });
  const loud = stripeMoney(event('customer.subscription.deleted', { id: 'sub_4', cancellation_details: { reason: 'payment_failed', comment: 'x'.repeat(500) } }))!;
  expect(loud.detail?.reason).toBe('Payment failed'); expect(loud.detail?.comment).toHaveLength(300);
});
test('every Stripe row can be opened in the dashboard, test mode included', () => {
  expect(stripeMoney(event('charge.succeeded', { id: 'ch_1', amount: 1800, currency: 'usd', payment_intent: 'pi_1' }))).toMatchObject({ kind: 'sale', amount: 18, detail: { url: 'https://dashboard.stripe.com/payments/pi_1' } });
  expect(stripeMoney({ ...event('charge.failed', { id: 'ch_2', amount: 900, currency: 'usd' }), livemode: false })?.detail?.url).toBe('https://dashboard.stripe.com/test/payments/ch_2');
  expect(stripeMoney(event('charge.dispute.created', { id: 'dp_1', amount: 900, currency: 'usd' }))?.detail?.url).toBe('https://dashboard.stripe.com/disputes/dp_1');
  expect(stripeMoney(event('invoice.paid', { id: 'in_1', billing_reason: 'subscription_create', amount_paid: 1800, currency: 'usd' }))?.detail?.url).toBe('https://dashboard.stripe.com/invoices/in_1');
  expect(stripeMoney(event('customer.subscription.created', { id: 'sub_5', status: 'trialing', items: { data: [{ price }] } }))?.detail).toEqual({ plan: '18 USD/month', url: 'https://dashboard.stripe.com/subscriptions/sub_5' });
  expect(dashboardUrl(event('charge.succeeded', {}), {})).toBeUndefined();
});
test('the plan reads as its nickname, or its price in whole units where Stripe uses them', () => {
  expect(planOf({ items: { data: [{ price: { ...price, nickname: 'Studio' } }] } })).toBe('Studio');
  expect(planOf({ plan: { amount: 1200, currency: 'jpy', interval: 'year' } })).toBe('1200 JPY/year');
  expect(planOf({ items: { data: [{ price: { unit_amount: 1999, currency: 'aud' } }] } })).toBe('19.99 AUD');
  expect(planOf({})).toBeUndefined();
});
