import { expect, test } from 'bun:test';
import { cleanLabel, dayTotals } from './ticker';
import { gameCurrency } from './currency';
import type { MoneyEvent } from '../shared/types';

const ev = (kind: MoneyEvent['kind'], amount: number, currency: string): MoneyEvent => ({ id: `${kind}-${amount}-${currency}`, ts: Date.now(), kind, amount, currency, label: '' });

const day = [ev('sale', 9, 'usd'), ev('sale', 599, 'php'), ev('sale', 10, 'usd'), ev('refund', -9, 'usd'), ev('sale', 11.43, 'usd'), ev('trial_started', 0, 'usd'), ev('churned', 0, 'usd')];

test('without a rate, currencies are listed side by side and never added', () => {
  const totals = dayTotals(day);
  expect(totals.estimated).toBe(false);
  expect(totals.parts).toHaveLength(2);
  expect(totals.parts[0]).toMatch(/21\.43/);
  expect(totals.text).not.toMatch(/620|609/);
  expect(totals.text).toMatch(/599/);
});

test('with the bridge rates, foreign money is converted and marked as an estimate', async () => {
  await gameCurrency.loadRates(async () => ({ date: '2026-09-08', rates: { php: 57.1, eur: 0.9 } }));
  const totals = dayTotals(day);
  expect(totals.estimated).toBe(true);
  expect(totals.text).toMatch(/^≈ /);
  expect(totals.text).toMatch(/31\.92/);   // 21.43 + 599 / 57.1
  expect(dayTotals([ev('sale', 9, 'usd')]).text).not.toMatch(/≈/);
  // the game currency itself can be anything the table quotes
  const euros = dayTotals(day, 'eur');
  expect(euros.text).toMatch(/28\.73/);    // 31.92 × 0.9
  expect(gameCurrency.get()).toBe('usd');   // a one-off target does not change the setting
});

test('row labels drop bundle ids and boilerplate', () => {
  expect(cleanLabel('Payment · One-time purchase · com.translatemom.credits.300')).toBe('One-time purchase');
  expect(cleanLabel('Preview only · Studio plan, annual')).toBe('Studio plan, annual');
  expect(cleanLabel('Subscription update')).toBe('');
  expect(cleanLabel('Trial converted · com.translatemom.subscription.starter')).toBe('Trial converted');
});
