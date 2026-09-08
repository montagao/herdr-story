export const REVENUE_RANGES = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '3m', label: '3m' },
  { value: 'ytd', label: 'YTD' },
  { value: 'all', label: 'All time' },
] as const;
export type RevenueRange = typeof REVENUE_RANGES[number]['value'];
export function isRevenueRange(value: unknown): value is RevenueRange {
  return REVENUE_RANGES.some((range) => range.value === value);
}
/** Rolling windows; calendar months and year boundaries use UTC. */
export function revenueWindow(range: RevenueRange, now = new Date()) {
  const end = Math.floor(now.getTime() / 1000);
  let since: number | undefined;
  if (range === '24h' || range === '7d' || range === '30d') {
    since = end - ({ '24h': 1, '7d': 7, '30d': 30 }[range] * 86400);
  } else if (range === 'ytd') {
    since = Date.UTC(now.getUTCFullYear(), 0, 1) / 1000;
  } else if (range === '3m') {
    const start = new Date(now);
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 3);
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(now.getUTCDate(), lastDay));
    since = Math.floor(start.getTime() / 1000);
  }
  return { since, end, label: REVENUE_RANGES.find((r) => r.value === range)!.label };
}

/** RevenueCat accepts inclusive UTC dates, so include today and the preceding N-1 days. */
export function revenueCalendarWindow(range: RevenueRange, now = new Date(), allTimeStart?: string) {
  const midnight = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  const window = revenueWindow(range, midnight);
  let since = window.since;
  if (range === '24h' || range === '7d' || range === '30d') since! += 86400;
  if (range === 'all' && allTimeStart) {
    const parsed = Date.parse(`${allTimeStart}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(allTimeStart) || !Number.isFinite(parsed) ||
        new Date(parsed).toISOString().slice(0, 10) !== allTimeStart) {
      throw new Error('All-time start must be a valid YYYY-MM-DD date.');
    }
    since = parsed / 1000;
  }
  const startDate = new Date((since ?? 0) * 1000).toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);
  return { since, end: Math.floor(now.getTime() / 1000), startDate, endDate,
    label: range === '24h' ? 'Today (UTC)' : `${window.label} (UTC)` };
}
