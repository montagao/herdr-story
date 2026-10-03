import { closeOnEscape } from './escape';
// The status bar, top right.
//
// Game Dev Story keeps a bar on screen at all times: the date, your funds, and your fans. This is
// the same bar for the office, on the game's own status-bar art, with the nearest honest mapping
// for the third cell — the game counts fans, we count the staff actually at their desks.
//
// The date is the real one, in the game's shape: month and week-of-month. The game's calendar has
// exactly four weeks in a month; a real one does not, so a fifth week is shown as Wk5 rather than
// pretending otherwise.
//
// Where the number comes from, in order of preference:
//   * Stripe, if the bridge was started with STRIPE_SECRET_KEY. The key stays on the bridge; the
//     page only ever receives a total.
//   * Otherwise the office's own economy — shipped tasks at a fixed rate — clearly labelled as
//     such so it is never mistaken for real revenue.
import { audio } from './audio';
import { gameCurrency } from './currency';
import { hop } from './feed/feed';
import { reducedMotion, replayAnimation, snapShut } from './motion';
import './hud.css';
import { REVENUE_RANGES, isRevenueRange, type RevenueRange } from '../shared/revenue-range';

const POLL_MS = 60_000;
/** Dollars per shipped task when there is no Stripe key. A game score, and labelled as one. */
const RATE = Math.max(0, Number(new URLSearchParams(location.search).get('rate') ?? 250));

interface RevenuePart { source: string; amount: number; currency: string; note?: string }
export interface Revenue { source: 'stripe' | 'revenuecat' | 'both' | 'none'; amount?: number; currency?: string;
  calendarRanges?: boolean; rangeSelectable?: boolean; label?: string; note?: string; days?: number; error?: string; parts?: RevenuePart[] }
const SOURCE_NAMES: Record<string, string> = { stripe: 'Stripe', revenuecat: 'RevenueCat' };
/** Any real book counts as live; only 'none' falls back to the office's own tally. */
const LIVE = new Set(['stripe', 'revenuecat', 'both']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** How often the clock is redrawn. A minute would drift by up to a minute; ten seconds never shows
 *  a stale minute for long, and costs nothing. */
const CLOCK_MS = 10_000;

export class Hud {
  constructor(private options: { loadRevenue?: (range: RevenueRange) => Promise<Revenue>; persistRange?: boolean } = {}) {}
  private root = document.getElementById('hud');
  private amountEl?: HTMLElement;
  private labelEl?: HTMLElement;
  private popEl?: HTMLElement;
  private amount = 0;
  private currency = 'usd';
  private label = '';
  private live = false;
  private shown?: number;      // what the panel currently reads, for the count-up
  private timer?: number;
  private paymentTimer?: number;
  private popTimer?: number;
  /** Set from main: total tasks this office has shipped, for the fallback figure. */
  shipped = () => 0;
  /** Set from main: who is in the office right now. */
  staff = () => ({ total: 0, working: 0 });
  /** Set from main: opens the Stripe setup window. */
  onConnect?: () => void;
  private settings?: HTMLDialogElement;
  private stopSettingsEscape?: () => void;
  private calendarRanges = false;
  private breakEl?: HTMLElement;
  private parts: RevenuePart[] = [];
  private range: RevenueRange = '30d';
  private rangeEl?: HTMLElement;
  private request = 0;
  private animation = 0;
  private dateEl?: HTMLElement;
  private clockEl?: HTMLElement;
  private weekLabel?: string;
  /** The calendar moved to a new week while the page was open. */
  onWeek?: (label: string, previous: string) => void;
  get week() { return this.weekLabel ?? ''; }
  private staffEl?: HTMLElement;
  private staffNoteEl?: HTMLElement;
  private clockTimer?: number;
  /** A gain that landed while the bar could not move, shown once it can. */
  private owed = 0;
  private cover?: MutationObserver;
  private crew?: number;
  /** Payments on their way to the till, each with the revenue read it arrived after. */
  private awaited = new Map<string, number>();
  /** Payments a later read has already taken into the total. */
  private counted = new Set<string>();

  start() {
    if (!this.root) return;
    try {
      const saved = this.options.persistRange === false ? null : localStorage.getItem('herdr-revenue-range');
      if (isRevenueRange(saved)) this.range = saved;
    } catch { /* Storage may be unavailable. */ }
    // The HUD is always visible, so it must not act as a modal that disables the entire office.
    // Keep its own pointer events local while allowing the rest of the canvas to accept input.
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel'])
      this.root.addEventListener(type, event => event.stopPropagation());
    this.root.innerHTML =
        `<div class="hud-cell hud-when"><b class="hud-date"></b><small class="hud-clock"></small></div>`
      + `<div class="hud-cell hud-funds" tabindex="0"><span class="hud-coin" aria-hidden="true"></span>`
      +   `<b class="hud-amount">—</b><small class="hud-caption"><span class="hud-label"></span><span class="hud-range-label" hidden></span></small>`
      +   `<button type="button" class="hud-settings" aria-label="Revenue settings" title="Revenue settings" aria-haspopup="dialog"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9.5 3h5l.5 2.3 1.5.9 2.2-.7 2.5 4.3-1.7 1.6v1.2l1.7 1.6-2.5 4.3-2.2-.7-1.5.9-.5 2.3h-5L9 18.7l-1.5-.9-2.2.7-2.5-4.3 1.7-1.6v-1.2L2.8 9.8l2.5-4.3 2.2.7L9 5.3Z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>`
      +   `<div class="hud-break" hidden></div></div>`
      + `<div class="hud-cell hud-crew"><b class="hud-staff">0</b><small class="hud-staff-note"></small></div>`
      + `<span class="hud-pop" hidden></span>`;
    this.amountEl = this.root.querySelector('.hud-amount')!;
    this.labelEl = this.root.querySelector('.hud-label')!;
    this.rangeEl = this.root.querySelector('.hud-range-label')!;
    this.root.querySelector('.hud-settings')!.addEventListener('click', () => this.openSettings());
    this.popEl = this.root.querySelector('.hud-pop')!;
    this.dateEl = this.root.querySelector('.hud-date')!;
    this.clockEl = this.root.querySelector('.hud-clock')!;
    this.staffEl = this.root.querySelector('.hud-staff')!;
    this.staffNoteEl = this.root.querySelector('.hud-staff-note')!;
    this.breakEl = this.root.querySelector('.hud-break')!;
    // Each plays once; left on, the classes would replay them whenever the bar was redisplayed.
    this.root.addEventListener('animationend', (event) => {
      const el = event.target as HTMLElement;
      if (event.animationName === 'hud-flash') el.classList.remove('flash');
      if (event.animationName === 'hud-rise') { el.hidden = true; el.classList.remove('go'); }
    });
    // The office's animations stop while a window covers it or the tab is hidden, and main marks
    // both on <html>. A flash is not left half-lit under the window, and a gain that lands
    // meanwhile waits for the mark to lift.
    this.cover = new MutationObserver(() => {
      if (this.covered()) this.root?.querySelector('.hud-funds')?.classList.remove('flash');
      else if (this.owed) this.pop(this.owed);
    });
    this.cover.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    this.root.hidden = false;
    this.clock();
    this.clockTimer = window.setInterval(() => this.clock(), CLOCK_MS);
    gameCurrency.onChange(() => { cancelAnimationFrame(this.animation); if (this.shown !== undefined) { this.shown = this.amount; this.amountEl!.textContent = this.money(this.amount); } });
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  stop() {
    this.stopSettingsEscape?.();
    this.settings?.close(); this.settings?.remove();
    this.request++;
    this.cover?.disconnect();
    cancelAnimationFrame(this.animation);
    if (this.timer) clearInterval(this.timer);
    if (this.paymentTimer) clearTimeout(this.paymentTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
  }

  /** The date cell, and the crew count beside it — both cheap, so they share the same tick. */
  clock() {
    const now = new Date();
    const week = Math.floor((now.getDate() - 1) / 7) + 1;
    const label = `${MONTHS[now.getMonth()]} Wk${week}`;
    // This runs on every roster update, so nothing is written that has not changed.
    const write = (el: HTMLElement | undefined, text: string) => { if (el && el.textContent !== text) el.textContent = text; };
    write(this.dateEl, label);
    // the week rolling over while the office is open is news; the first tick is not
    if (this.weekLabel && this.weekLabel !== label) this.onWeek?.(label, this.weekLabel);
    this.weekLabel = label;
    const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
    write(this.clockEl, `${DAYS[now.getDay()]} ${hh}:${mm}`);
    const crew = this.staff();
    write(this.staffEl, String(crew.total));
    write(this.staffNoteEl, crew.working ? `${crew.working} working` : 'all idle');
    // somebody clocked in or out: the head count hops
    if (this.crew !== undefined && this.crew !== crew.total && !reducedMotion() && !this.covered()) this.staffEl?.animate(hop(3), { duration: 160 });
    this.crew = crew.total;
  }

  /** A payment has been announced and its customer is on the way to the till. The revenue poll
   *  can land before they get there with the sale already in it; knowing which payments are
   *  still walking lets credit() tell, instead of counting the sale twice. */
  expect(id: string) { this.awaited.set(id, this.request); }

  /** A Stripe event just landed. The selected total it belongs to is only re-read once a minute, so
   *  move the number now — the next poll replaces it with Stripe's own figure either way. A cancelled
   *  subscription carries no amount and must not pretend to. */
  credit(amount: number, id?: string) {
    if (!this.live || !amount) return;
    if (id) this.awaited.delete(id);
    // Already in the figure: the till still rings, but there is nothing to add.
    if (id && this.counted.delete(id)) { if (amount > 0) this.pop(amount); return; }
    // credit() is only called for Stripe's events, so the breakdown's Stripe line moves with the total
    const stripe = this.parts.find((p) => p.source === 'stripe');
    if (stripe) stripe.amount += amount;
    this.set(this.amount + amount, this.label);
    this.breakdown();
  }

  /** The till rang for money this bar cannot add up itself (a store sale, in another currency and
   *  reported late): light the bar and hop the coin now, and let the next read bring the figure. */
  ring() { if (!this.covered()) replayAnimation(this.root?.querySelector('.hud-funds'), 'flash'); }

  /** Store events can use a different currency or arrive late. Re-read the selected total. */
  refreshAfterPayment() {
    if (this.paymentTimer) return;
    this.paymentTimer = window.setTimeout(() => {
      this.paymentTimer = undefined;
      void this.refresh();
    }, 1500);
  }

  /** Called when a task ships: the fallback figure moves immediately rather than at the next poll. */
  bump() { this.clock(); if (!this.live) this.set(this.shipped() * RATE, `${this.shipped()} shipped · $${RATE} each`); }

  private async refresh() {
    const request = ++this.request;
    let r: Revenue = { source: 'none' };
    try {
      if (this.options.loadRevenue) r = await this.options.loadRevenue(this.range);
      else {
        const res = await fetch(`/api/revenue?range=${this.range}`, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error('Could not load revenue.');
        r = await res.json() as Revenue;
      }
    } catch {
      if (this.live || (this.rangeEl && !this.rangeEl.hidden)) r = { source: 'none', error: 'Could not load revenue. Retrying shortly.', rangeSelectable: true };
    }
    if (request !== this.request) return;
    if (this.rangeEl) {
      this.rangeEl.hidden = !(r.rangeSelectable ?? LIVE.has(r.source));
      if (r.calendarRanges !== undefined) this.calendarRanges = r.calendarRanges;
      this.rangeEl.textContent = this.calendarRanges && this.range === '24h' ? 'Today' : REVENUE_RANGES.find(r => r.value === this.range)!.label;
    }
    if (r.error && r.source === 'none') {
      this.live = false;
      this.shown = undefined;
      this.amountEl!.textContent = '—';
      this.labelEl!.textContent = 'Unavailable';
      this.labelEl!.title = r.error;
      this.breakEl!.hidden = true;
      return;
    }
    this.labelEl!.title = r.note ?? '';
    if (LIVE.has(r.source) && typeof r.amount === 'number') {
      this.live = true;
      this.currency = r.currency ?? 'usd';
      this.parts = r.parts ?? [];
      // A payment announced before this read was asked for is in its figure. The number moves
      // now, quietly; the pop and the flash are kept for the till.
      let early = false;
      for (const [id, asked] of this.awaited) if (asked < request) { this.awaited.delete(id); this.counted.add(id); early = true; }
      if (this.counted.size > 50) this.counted.clear();
      this.set(r.amount, r.label ?? 'Stripe', early);
    } else {
      this.live = false;
      this.currency = 'usd';
      this.parts = [];
      this.set(this.shipped() * RATE, `${this.shipped()} shipped · $${RATE} each`);
    }
    this.breakdown();
  }

  /** What the total is made of, revealed on hover. The bar has room for one number; the books it
   *  came from belong here rather than crammed into the label. */
  private breakdown() {
    const el = this.breakEl;
    if (!el) return;
    if (!this.live || !this.parts.length) { el.hidden = true; el.innerHTML = ''; return; }
    const row = (name: string, amount: number, currency: string, cls = '') =>
      `<div class="hud-break-row ${cls}"><span>${name}</span><b>${money(amount, currency)}</b></div>`;
    const multiple = this.parts.length > 1;
    el.innerHTML = this.parts.map((p) => row(SOURCE_NAMES[p.source] ?? p.source, p.amount, p.currency)).join('')
      + (multiple ? row('Total', this.amount, this.currency, 'total') : '')
      + `<div class="hud-break-note"></div>`;
    el.querySelector('.hud-break-note')!.textContent = [this.label, ...this.parts.map((p) => p.note).filter(Boolean)].join(' · ');
    el.hidden = false;
  }

  /** The revenue window; the office's settings link here. */
  openSettings() {
    if (!this.root || this.settings?.open) return;
    const dialog = this.settings ??= document.createElement('dialog');
    dialog.className = 'revenue-settings setup-win';
    dialog.setAttribute('aria-labelledby', 'revenue-settings-title');
    dialog.setAttribute('data-block-office-input', '');
    dialog.innerHTML = `<div class="setup-head"><b id="revenue-settings-title">Revenue settings</b><button type="button" class="setup-x" aria-label="Close revenue settings">×</button></div>
      <div class="setup-body">
        <section class="revenue-setting"><label for="revenue-settings-range">Reporting period</label><select id="revenue-settings-range" aria-describedby="revenue-settings-range-note"></select>
          <p id="revenue-settings-range-note" class="setup-hint"></p></section>
        <section class="revenue-setting"><label for="revenue-settings-currency">Game currency</label><select id="revenue-settings-currency" aria-describedby="revenue-settings-currency-note"></select>
          <p id="revenue-settings-currency-note" class="setup-hint"></p></section>
        <section class="revenue-setting"><h3>Payment sources</h3><p class="revenue-settings-sources"></p>
          <button type="button" class="revenue-sources-button">Manage payment sources</button></section>
      </div>`;
    const select = dialog.querySelector<HTMLSelectElement>('#revenue-settings-range')!;
    const currency = dialog.querySelector<HTMLSelectElement>('#revenue-settings-currency')!;
    currency.replaceChildren(...gameCurrency.choices().map(c => new Option(c.label, c.code)));
    currency.value = gameCurrency.get();
    const rateNote = () => { dialog.querySelector('#revenue-settings-currency-note')!.textContent = gameCurrency.rates
      ? `Totals in another currency are converted at reference rates${gameCurrency.rates.date ? ` from ${gameCurrency.rates.date}` : ''} and shown with ≈. Rows keep their own currency.`
      : 'Exchange rates are not available yet; figures stay in their own currency.'; };
    rateNote();
    currency.addEventListener('change', () => { gameCurrency.set(currency.value); rateNote(); });
    select.replaceChildren(...REVENUE_RANGES.map(r => new Option(this.calendarRanges && r.value === '24h' ? 'Today' : r.label, r.value)));
    select.value = this.range;
    dialog.querySelector('#revenue-settings-range-note')!.textContent =
      (this.calendarRanges ? 'Calendar dates in UTC; today is partial. ' : '')
      + (this.options.persistRange === false ? 'Changes apply to this preview.' : 'Changes apply immediately and are saved in this browser.');
    dialog.querySelector('.revenue-settings-sources')!.textContent = this.parts.length
      ? this.parts.map(p => SOURCE_NAMES[p.source] ?? p.source).join(' · ')
      : 'Connect Stripe or RevenueCat to show your revenue here.';
    const close = () => { snapShut(dialog); dialog.close(); dialog.hidden = true; this.root?.querySelector<HTMLButtonElement>('.hud-settings')?.focus(); };
    dialog.querySelector('.setup-x')!.addEventListener('click', close);
    this.stopSettingsEscape = closeOnEscape(dialog, close);
    dialog.oncancel = event => { event.preventDefault(); close(); };
    dialog.onclick = event => { if (event.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    } };
    const sources = dialog.querySelector<HTMLButtonElement>('.revenue-sources-button')!;
    sources.disabled = !this.onConnect;
    sources.addEventListener('click', () => { close(); this.onConnect?.(); });
    select.addEventListener('change', () => {
      if (!isRevenueRange(select.value)) return;
      this.range = select.value;
      try { if (this.options.persistRange !== false) localStorage.setItem('herdr-revenue-range', this.range); } catch {}
      this.live = false; cancelAnimationFrame(this.animation); this.shown = undefined;
      this.amountEl!.textContent = '—'; this.labelEl!.textContent = 'Loading…';
      this.breakEl!.hidden = true; this.popEl!.hidden = true; this.owed = 0;
      void this.refresh();
    });
    document.body.append(dialog);
    dialog.hidden = false; dialog.showModal(); select.focus();
  }

  private set(amount: number, label: string, quiet = false) {
    const gain = this.shown === undefined ? 0 : amount - this.amount;
    this.amount = amount;
    this.label = label;
    if (this.labelEl) this.labelEl.textContent = this.rangeEl && !this.rangeEl.hidden ? label.split(' · ')[0] + ' ·' : label;
    if (gain > 0 && !quiet) this.pop(gain);
    this.countTo(amount);
  }

  /** Roll the digits rather than snapping, the way a Kairosoft total settles. */
  private countTo(target: number) {
    const el = this.amountEl;
    if (!el) return;
    cancelAnimationFrame(this.animation);
    if (this.shown === undefined || reducedMotion()) { this.shown = target; el.textContent = this.money(target); return; }
    const from = this.shown, start = performance.now(), ms = 700;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      this.shown = from + (target - from) * eased;
      el.textContent = this.money(this.shown!);
      if (t < 1) this.animation = requestAnimationFrame(step); else this.shown = target;
    };
    this.animation = requestAnimationFrame(step);
  }

  /** Whether the bar's animations are stopped: a window is over the office, or the tab is hidden. */
  private covered() { return document.hidden || document.documentElement.classList.contains('office-obscured'); }

  private pop(gain: number) {
    const el = this.popEl;
    if (!el) return;
    // Started behind a window, the flash would sit frozen on its first, solid gold frame until
    // the window closed, and the rising figure would time out unseen. Keep it for the return.
    if (this.covered()) { this.owed += gain; return; }
    this.owed = 0;
    el.textContent = `+${this.money(gain)}`;
    el.hidden = false;
    replayAnimation(el, 'go');    // restart the animation rather than letting it finish silently
    replayAnimation(this.root?.querySelector('.hud-funds'), 'flash');
    audio.blip('coin');
    if (this.popTimer) clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(() => { el.hidden = true; }, 1800);
  }

  private money(n: number) { return gameCurrency.display(n, this.currency, true); }
}

/** Whole units: a HUD is read at a glance, and cents are noise at this size. */
function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(),
      maximumFractionDigits: 0 }).format(n);
  } catch { return `$${Math.round(n).toLocaleString()}`; }
}
