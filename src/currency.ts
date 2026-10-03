// The game currency: every total the office shows is converted into one currency of your
// choosing, the way a game keeps one kind of coin. Conversion uses the bridge's dated reference
// rates (USD base); anything converted is marked ≈, and without a rate the native figure stands.
export type Rates = { date?: string; rates: Record<string, number> };
type Listener = () => void;
const KEY = 'herdr-story:currency';
const COMMON = ['usd', 'eur', 'gbp', 'jpy', 'cad', 'aud', 'php', 'inr', 'sgd', 'chf', 'sek', 'nzd', 'mxn', 'brl', 'krw', 'hkd', 'cny'];

class GameCurrency {
  private code = 'usd';
  private table?: Rates;
  private listeners = new Set<Listener>();
  constructor() { try { const saved = localStorage.getItem(KEY); if (saved && /^[a-z]{3}$/.test(saved)) this.code = saved; } catch { /* private mode */ } }
  get() { return this.code; }
  set(code: string) {
    code = code.toLowerCase();
    if (!/^[a-z]{3}$/.test(code) || code === this.code) return;
    this.code = code;
    try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
    for (const fn of this.listeners) fn();
  }
  onChange(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  get rates() { return this.table; }
  async loadRates(loader: () => Promise<Rates>) {
    try { const table = await loader(); if (table?.rates) { this.table = table; for (const fn of this.listeners) fn(); } } catch { /* the native figures stand */ }
  }
  /** Codes worth offering: the common set plus anything the bridge quotes, USD first. */
  choices() {
    const all = new Set(['usd', ...COMMON, ...Object.keys(this.table?.rates ?? {})]);
    let names: Intl.DisplayNames | undefined;
    try { names = new Intl.DisplayNames(undefined, { type: 'currency' }); } catch { /* fine */ }
    return [...all].map(code => ({ code, label: `${code.toUpperCase()}${names ? ` · ${names.of(code.toUpperCase()) ?? ''}` : ''}` }));
  }
  /** An amount in `from`, as the game currency. `undefined` when no rate can honestly get there. */
  convert(amount: number, from = 'usd'): { amount: number; estimated: boolean } | undefined {
    from = from.toLowerCase(); const to = this.code;
    if (from === to) return { amount, estimated: false };
    const rates = this.table?.rates ?? {};
    const usd = from === 'usd' ? amount : rates[from] ? amount / rates[from] : undefined;
    if (usd === undefined) return undefined;
    const out = to === 'usd' ? usd : rates[to] ? usd * rates[to] : undefined;
    if (out === undefined) return undefined;
    return { amount: Math.round(out * 100) / 100, estimated: true };
  }
  format(amount: number, currency = this.code, whole = false) {
    const n = Math.abs(amount);
    let text: string;
    try { text = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: whole || !(n < 100 && n % 1) ? 0 : 2 }).format(n); }
    catch { text = `${whole ? Math.round(n) : n.toFixed(2)} ${currency.toUpperCase()}`; }
    return amount < 0 ? `−${text}` : text;
  }
  /** The figure the office shows: converted and marked when it had to be, native otherwise. */
  display(amount: number, from = 'usd', whole = false) {
    const c = this.convert(amount, from);
    return c ? `${c.estimated ? '≈' : ''}${this.format(c.amount, this.code, whole)}` : this.format(amount, from, whole);
  }
}
export const gameCurrency = new GameCurrency();
