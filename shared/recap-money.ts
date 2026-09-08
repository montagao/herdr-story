import type { JournalEntry } from './studio';
export interface RecapMoney {
  usd?: { amount: number; estimated: boolean; rateDate?: string };
  conversionUnavailable?: boolean;
  totals: { currency: string; amount: number }[];
  payments: number;
  refunds: number;
  billingEvents: number;
}
/** Only recorded money movement counts. Trials/cancellations do not introduce a currency. */
export function recapMoney(entries: JournalEntry[]): RecapMoney {
  const amounts = new Map<string, number>();
  let payments = 0, refunds = 0, billingEvents = 0;
  for (const entry of entries) {
    if (entry.kind !== 'sale') continue;
    billingEvents++;
    if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount) || !entry.amount) continue;
    const currency = (entry.currency || 'usd').toLowerCase();
    amounts.set(currency, (amounts.get(currency) ?? 0) + entry.amount);
    if (entry.amount > 0) payments++; else refunds++;
  }
  return { totals: [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({currency, amount})), payments, refunds, billingEvents };
}
