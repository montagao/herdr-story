import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RecapMoney } from '../shared/recap-money';

type Rate = { date: string; base: string; quote: string; rate: number };
/** Reference-rate estimate, shared across recap requests. Only currency rates leave the bridge. */
export class RecapFX {
  private rates = new Map<string, Rate>();
  private checked = 0;
  private retryAt = 0;
  private pending?: Promise<void>;
  constructor(private request: (url: string, init?: RequestInit) => Promise<Response> = fetch, private now = Date.now, private cacheFile?: string) {
    if (cacheFile) try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (saved.version === 1 && Number.isFinite(saved.checked) && saved.checked > 0 && saved.checked <= this.now()) {
        this.rates = this.validRates(saved.rates);
        if (this.rates.size) this.checked = saved.checked;
      }
    } catch { /* A missing or damaged cache can always be rebuilt from the rate service. */ }
  }
  private validRates(rows: unknown) {
    const rates = new Map<string, Rate>();
    if (!Array.isArray(rows)) return rates;
    for (const row of rows) if (row && row.base === 'USD' && /^[A-Z]{3}$/.test(row.quote) && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
      && Number.isFinite(row.rate) && row.rate > 0) rates.set(row.quote.toLowerCase(), row);
    return rates;
  }
  warm() { void this.refresh(); }
  private async persist() {
    if (!this.cacheFile) return;
    const temp = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify({ version: 1, checked: this.checked, rates: [...this.rates.values()] }), { mode: 0o600 });
      await rename(temp, this.cacheFile);
    } catch { console.warn('[recap] Could not persist exchange-rate cache; using in-memory rates.'); }
  }
  private async refresh() {
    if (this.checked && this.now() - this.checked < 6 * 3600_000 || this.now() < this.retryAt) return;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const response = await this.request('https://api.frankfurter.dev/v2/rates?base=USD', { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw Error('Rate service unavailable');
        const rows = await response.json() as Rate[];
        if (!Array.isArray(rows)) throw Error('Invalid rates');
        const rates = this.validRates(rows);
        if (!rates.size) throw Error('No rates');
        this.rates = rates; this.checked = this.now(); await this.persist();
      } catch { this.retryAt = this.now() + 60_000; }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async convert(money: RecapMoney): Promise<RecapMoney> {
    const foreign = money.totals.some(t => t.currency !== 'usd' && t.amount !== 0);
    if (foreign) {
      // Reuse the dated last-known rates immediately while refreshing in the background.
      if (this.checked && this.now() - this.checked <= 7 * 86400_000) void this.refresh();
      else await this.refresh();
    }
    let amount = 0; const dates: string[] = [];
    for (const total of money.totals) {
      if (total.currency === 'usd' || total.amount === 0) { amount += total.amount; continue; }
      const row = this.rates.get(total.currency);
      if (!row || this.now() - this.checked > 7 * 86400_000) return { ...money, usd: undefined, conversionUnavailable: true };
      amount += total.amount / row.rate; dates.push(row.date);
    }
    return { ...money, conversionUnavailable: false, usd: { amount: Math.round((amount + Number.EPSILON) * 100) / 100,
      estimated: foreign, ...(dates.length ? { rateDate: dates.sort()[0] } : {}) } };
  }
}
