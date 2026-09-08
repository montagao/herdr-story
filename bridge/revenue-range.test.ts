import { expect, test } from 'bun:test';
import { isRevenueRange, revenueWindow } from '../shared/revenue-range';

test('rolling ranges use exact elapsed days', () => {
  const now = new Date('2026-09-05T12:34:56Z');
  for (const [range, days] of [['24h', 1], ['7d', 7], ['30d', 30]] as const) {
    const window = revenueWindow(range, now);
    expect(window.end - window.since!).toBe(days * 86400);
  }
});
test('three calendar months clamps month-end dates', () => {
  expect(revenueWindow('3m', new Date('2026-05-31T12:00:00Z')).since)
    .toBe(Date.parse('2026-02-28T12:00:00Z') / 1000);
});
test('YTD starts at January 1 UTC and all time has no lower bound', () => {
  expect(revenueWindow('ytd', new Date('2026-09-05T12:00:00Z')).since)
    .toBe(Date.parse('2026-01-01T00:00:00Z') / 1000);
  expect(revenueWindow('all').since).toBeUndefined();
  expect(isRevenueRange('bogus')).toBe(false);
});

import { revenueCalendarWindow } from '../shared/revenue-range';
import { revenueCatTotal } from './revenuecat';

test('RevenueCat dates include exactly N calendar days, including today', () => {
  const now = new Date('2026-09-05T12:34:56Z');
  for (const [range, start] of [['24h', '2026-09-05'], ['7d', '2026-08-30'], ['30d', '2026-08-07'],
    ['3m', '2026-06-05'], ['ytd', '2026-01-01'], ['all', '1970-01-01']] as const) {
    const window = revenueCalendarWindow(range, now);
    expect(window.startDate).toBe(start);
    expect(window.endDate).toBe('2026-09-05');
    if (range !== 'all') expect(window.since).toBe(Date.parse(start + 'T00:00:00Z') / 1000);
  }
  expect(revenueCalendarWindow('24h', now).label).toBe('Today (UTC)');
  expect(revenueCalendarWindow('7d', new Date('2026-01-01T00:00:00Z')).startDate).toBe('2025-12-26');
});

test('RevenueCat queries gross revenue and preserves major units and zero totals', async () => {
  for (const amount of [123.45, 0, -10]) {
    const total = await revenueCatTotal(async path => {
      const url = new URL(path, 'https://api.revenuecat.com');
      expect(url.pathname).toBe('/projects/proj123/metrics/revenue');
      expect(url.searchParams.get('start_date')).toBe('2026-08-30');
      expect(url.searchParams.get('end_date')).toBe('2026-09-05');
      expect(url.searchParams.get('revenue_type')).toBe('revenue');
      return { value: amount, currency: 'AUD' };
    }, 'proj123', '7d', new Date('2026-09-05T12:00:00Z'));
    expect(total.amount).toBe(amount);
    expect(total.currency).toBe('aud');
  }
});

test('RevenueCat failures never become a zero total', async () => {
  for (const body of [null, {}, {value: '12', currency:'USD'}, {value: NaN, currency:'USD'}, {value:12}]) {
    await expect(revenueCatTotal(async () => body, 'proj123', '30d')).rejects.toThrow('invalid revenue total');
  }
  await expect(revenueCatTotal(async () => { throw Error('Access denied'); }, 'proj123', '30d')).rejects.toThrow('Access denied');
});

test('each provider has a fixed all-time start that does not roll forward', async () => {
  for (const now of [new Date('2026-09-05T12:00:00Z'), new Date('2026-10-05T12:00:00Z')]) {
    const stripe = revenueCalendarWindow('all', now, '2023-06-01');
    expect(stripe.startDate).toBe('2023-06-01');
    expect(stripe.since).toBe(Date.parse('2023-06-01T00:00:00Z') / 1000);
    await revenueCatTotal(async path => {
      expect(new URL(path, 'https://api.revenuecat.com').searchParams.get('start_date')).toBe('2026-06-05');
      return { value: 123, currency: 'USD' };
    }, 'proj123', 'all', now, '2026-06-05');
    expect(revenueCalendarWindow('30d', now, '2023-06-01')).toEqual(revenueCalendarWindow('30d', now));
  }
  expect(() => revenueCalendarWindow('all', new Date(), '2026-02-30')).toThrow('valid YYYY-MM-DD');
});
