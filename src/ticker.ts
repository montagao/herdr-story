// The day's money, running along the top edge the way the game's news line does. A payment
// vanishes from the floor in five seconds; here it stays all day.
import type { MoneyEvent } from '../shared/types';
import type { JournalEntry } from '../shared/studio';
import { hop, moneyAmount, moneyText } from './feed/feed';
import { gameCurrency } from './currency';
import { reducedMotion } from './motion';
import './ticker.css';

const TONE: Record<MoneyEvent['kind'], 'up' | 'down' | 'flat'> = {
  sale: 'up', subscribed: 'up', refund: 'down', failed: 'down', dispute: 'down', churned: 'down', expired: 'down',
  subscription_started: 'flat', subscription_pending: 'flat', trial_started: 'flat', subscription_resumed: 'flat',
};
const COUNTED = new Set<MoneyEvent['kind']>(['sale', 'subscribed', 'refund']);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
// whole minutes gone, as the roster counts them: half a minute ago is still 'just now'
const ago = (ts: number) => { const m = Math.max(0, Math.floor((Date.now() - ts) / 60_000)); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`; };
const money = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: Math.abs(amount) < 100 && amount % 1 ? 2 : 0 }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency.toUpperCase()}`; }
};

/** A provider label minus the parts nobody reads: bundle ids, "Preview only", the generic
 *  "Subscription update", and the leading verb the row already shows. */
export function cleanLabel(label: string) {
  return label.split(/\s·\s|\s-\s/).map(part => part.trim())
    .filter(part => part && !/^[a-z0-9_-]+(\.[a-z0-9_-]+){2,}$/i.test(part) && !/^preview only$/i.test(part) && !/^subscription update$/i.test(part) && !/^payment$/i.test(part))
    .join(' · ');
}

/** One figure for the day, in the game currency. Money already in it adds up plainly; the rest
 *  is converted at the bridge's dated reference rates and the result is marked as an estimate.
 *  Without a rate for something, nothing is invented: the currencies are listed side by side. */
export function dayTotals(events: MoneyEvent[], target = gameCurrency.get()): { text: string; estimated: boolean; parts: string[] } {
  const sums = new Map<string, { amount: number; count: number }>();
  for (const ev of events) {
    if (!COUNTED.has(ev.kind) || !ev.amount) continue;
    const key = (ev.currency || 'usd').toLowerCase(), sum = sums.get(key) ?? { amount: 0, count: 0 };
    sum.amount += ev.amount; sum.count++; sums.set(key, sum);
  }
  const ordered = [...sums].sort((a, b) => b[1].count - a[1].count);
  const parts = ordered.map(([currency, sum]) => money(sum.amount, currency));
  if (!ordered.length) return { text: '', estimated: false, parts };
  let total = 0, estimated = false;
  const was = gameCurrency.get(); if (target !== was) gameCurrency.set(target);
  try {
    for (const [currency, sum] of ordered) {
      const c = gameCurrency.convert(sum.amount, currency);
      if (!c) return { text: parts.join(' · '), estimated: false, parts };
      total += c.amount; estimated ||= c.estimated;
    }
  } finally { if (target !== was) gameCurrency.set(was); }
  return { text: `${estimated ? '≈ ' : ''}${money(Math.round(total * 100) / 100, target)}`, estimated, parts };
}

/** How fast the line crawls, in pixels a second. On a 60Hz screen that is one whole pixel every
 *  other frame, so the pixel type stays sharp as it moves. */
const CRAWL = 30;
/** How long a sale that has just come in is marked as news. */
const FRESH_MS = 3200;

export class SalesTicker {
  private root = document.createElement('div');
  private events = new Map<string, MoneyEvent>();
  private names = new Map<string, string>();
  private timer = 0;
  // The band is built once and patched. Rebuilding it on every redraw started the crawl again
  // from its head each minute, and under a pointer that was holding it still.
  private total: HTMLElement;
  private figure: HTMLElement;
  private track: HTMLElement;
  private runs: HTMLElement[];
  /** The ids on the line, newest first. The same line again only has its words patched. */
  private line = '';
  /** The width of one run of the line that the crawl is set for; none while the line stands still. */
  private width = 0;
  private fresh = '';
  private freshTimer = 0;
  constructor(private mount: HTMLElement) {
    gameCurrency.onChange(() => this.render());
    this.root.id = 'sales-ticker'; this.root.hidden = true; this.root.setAttribute('aria-label', "Today's payments");
    this.root.innerHTML = '<b class="ticker-total"><span>TODAY</span><em class="ticker-figure"></em></b><div class="ticker-window"><div class="ticker-track"><span class="ticker-run"></span><span class="ticker-run" aria-hidden="true"></span></div></div>';
    this.total = this.root.querySelector('.ticker-total')!;
    this.figure = this.root.querySelector('.ticker-figure')!;
    this.track = this.root.querySelector('.ticker-track')!;
    this.runs = [...this.root.querySelectorAll<HTMLElement>('.ticker-run')];
    mount.prepend(this.root);
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel']) this.root.addEventListener(type, event => event.stopPropagation());
    this.timer = window.setInterval(() => this.render(), 60_000);
  }
  /** History from the bridge and news alike; anything not from today is dropped. */
  seed(events: MoneyEvent[]) { for (const ev of events) this.events.set(ev.id, ev); this.render(); }
  /** The journal is the complete record of the day; the bridge's live tail is only its last few
   *  events. A sale entry carries the provider's event id, so live news and history dedupe. */
  seedFromJournal(entries: JournalEntry[]) {
    for (const e of entries) {
      if (e.kind !== 'sale' || !e.moneyId) continue;
      const title = e.title.toLowerCase();
      const kind: MoneyEvent['kind'] = typeof e.amount === 'number' && e.amount > 0 ? 'sale' : typeof e.amount === 'number' && e.amount < 0 ? 'refund'
        : /^trial/.test(title) ? 'trial_started' : /^expired/.test(title) ? 'expired' : /^cancel/.test(title) ? 'churned'
        : /failed|billing issue|dispute/.test(title) ? 'failed' : 'subscription_started';
      if (!this.events.has(e.moneyId)) this.events.set(e.moneyId, { id: e.moneyId, source: e.source === 'revenuecat' ? 'revenuecat' : 'stripe', ts: e.at, kind, amount: e.amount ?? 0, currency: e.currency || 'usd', label: e.title.replace(/^[^·]+·\s*/, '') });
    }
    this.render();
  }
  /** News, as it happens: the line starts again with it at the head, its amount blinks for a
   *  moment and the day's figure hops. `described` resolves to who paid for what once the bridge
   *  has looked it up. */
  add(ev: MoneyEvent, described?: Promise<string>) {
    const news = !this.events.has(ev.id), was = this.figure.textContent;
    this.events.set(ev.id, ev);
    if (news) {
      this.fresh = ev.id;
      clearTimeout(this.freshTimer);
      this.freshTimer = window.setTimeout(() => { this.fresh = ''; for (const item of this.root.querySelectorAll('.fresh')) item.classList.remove('fresh'); }, FRESH_MS);
    }
    this.render();
    // The band is inside the office, which keeps still behind an open window.
    const still = reducedMotion() || document.hidden || document.documentElement.classList.contains('office-obscured');
    if (news && !still && this.figure.textContent !== was) this.figure.animate(hop(3), { duration: 160 });
    void described?.then(text => {
      // the row already leads with the amount, so a description ending in it loses that part
      const trimmed = ev.amount ? text.replace(new RegExp(`\\s·\\s${moneyAmount(ev).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') : text;
      if (trimmed && this.events.has(ev.id)) { this.names.set(ev.id, trimmed); this.render(); }
    }).catch(() => {});
  }
  private today() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return [...this.events.values()].filter(ev => ev.ts >= start.getTime()).sort((a, b) => b.ts - a.ts);
  }
  private render() {
    for (const [id, ev] of this.events) if (Date.now() - ev.ts > 36 * 3600e3) { this.events.delete(id); this.names.delete(id); }
    const today = this.today();
    this.root.hidden = !today.length;
    this.mount.classList.toggle('has-ticker', !this.root.hidden);
    if (!today.length) { this.line = ''; return; }
    const write = (node: Element, text: string) => { if (node.textContent !== text) node.textContent = text; };
    const totals = dayTotals(today);
    write(this.figure, totals.text || `${today.length} ${today.length === 1 ? 'event' : 'events'}`);
    const title = totals.estimated ? `${totals.parts.join(' · ')} · converted at reference rates${gameCurrency.rates?.date ? ` from ${gameCurrency.rates.date}` : ''}` : '';
    if (this.total.title !== title) this.total.title = title;
    const shown = today.slice(0, 24), line = shown.map(ev => ev.id).join('\n');
    const words = (ev: MoneyEvent) => { const detail = this.names.get(ev.id) || cleanLabel(ev.label ?? ''); return [moneyText(ev), detail && ` ${detail}`, ago(ev.ts)]; };
    // A new sale at the head is the one thing that sends the line back to its start.
    const leads = shown[0].id !== this.line.split('\n')[0];
    if (line !== this.line) {
      const items = shown.map(ev => {
        const [what, detail, when] = words(ev);
        return `<span class="ticker-item tone-${TONE[ev.kind]}${ev.id === this.fresh ? ' fresh' : ''}"><b>${esc(what)}</b><span>${esc(detail)}</span> <i>${esc(when)}</i></span>`;
      }).join('<span class="ticker-dot" aria-hidden="true">◆</span>');
      for (const run of this.runs) run.innerHTML = items;
      this.line = line;
    } else for (const run of this.runs) run.querySelectorAll('.ticker-item').forEach((item, i) => words(shown[i]).forEach((text, part) => write(item.children[part], text)));
    this.pace(leads);
  }
  /** Set the crawl for the line as it stands: one speed whatever the day holds, a whole pixel at
   *  a time. A line that fits in the band is shown once and left standing. `restart` puts its
   *  head back at the left edge; otherwise it carries on from where it had got to. */
  private pace(restart: boolean) {
    const [run, twin] = this.runs;
    run.style.minWidth = '';
    const width = Math.ceil(run.getBoundingClientRect().width), still = width <= this.track.parentElement!.clientWidth;
    this.track.classList.toggle('still', still);
    if (twin.hidden !== still) twin.hidden = still;
    if (still) { this.width = 0; return; }
    // Under reduced motion the stylesheet takes the animation away, and there is nothing to set.
    const crawl = () => this.track.getAnimations().find(a => (a as CSSAnimation).animationName === 'ticker-run');
    const period = (px: number) => px / CRAWL * 1000;
    const at = this.width ? Number(crawl()?.currentTime ?? 0) % period(this.width) : 0;
    run.style.minWidth = twin.style.minWidth = `${width}px`;
    this.track.style.animationDuration = `${period(width)}ms`;
    this.track.style.animationTimingFunction = `steps(${width})`;
    this.width = width;
    const now = crawl();
    if (now) now.currentTime = restart ? 0 : at % period(width);
  }
  destroy() { clearInterval(this.timer); clearTimeout(this.freshTimer); this.root.remove(); this.mount.classList.remove('has-ticker'); }
}
