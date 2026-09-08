import { revenueCalendarWindow, type RevenueRange } from '../shared/revenue-range';

/** Uses the authoritative range total, in major currency units, before taxes and store fees.
 * https://www.revenuecat.com/docs/api-v2/charts-and-metrics */
export async function revenueCatTotal(
  get: (path: string) => Promise<unknown>, project: string, range: RevenueRange, now = new Date(), allTimeStart?: string,
) {
  const window = revenueCalendarWindow(range, now, allTimeStart);
  const query = new URLSearchParams({ start_date: window.startDate, end_date: window.endDate, revenue_type: 'revenue' });
  const body = await get(`/projects/${encodeURIComponent(project)}/metrics/revenue?${query}`) as {
    value?: number; currency?: string;
  } | null;
  if (!body || typeof body.value !== 'number' || !Number.isFinite(body.value) ||
      typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) {
    throw new Error('RevenueCat returned an invalid revenue total.');
  }
  return { source: 'revenuecat' as const, amount: body.value, currency: body.currency.toLowerCase(),
    label: `RevenueCat · ${window.label}`, at: now.getTime(),
    note: `Gross revenue before taxes and store fees · ${window.startDate} to ${window.endDate} (UTC; today is partial)` };
}
