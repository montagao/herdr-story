import { closeOnEscape } from './escape';
import { REVENUE_RANGES, type RevenueRange } from '../shared/revenue-range';

/** A game-styled menu with native button activation and radio-menu keyboard navigation. */
export class RevenueRangeMenu {
  readonly button: HTMLButtonElement;
  private menu: HTMLElement;
  private items: HTMLButtonElement[];
  private listeners = new AbortController();
  private stopEscape: () => void;
  private calendar = false;
  private value: RevenueRange;

  constructor(private funds: HTMLElement, value: RevenueRange, onChange: (range: RevenueRange) => void) {
    this.value = value;
    this.button = funds.querySelector('.hud-range')!;
    this.menu = funds.querySelector('.hud-range-menu')!;
    this.stopEscape = closeOnEscape(this.menu, () => this.close(true));
    this.menu.innerHTML = REVENUE_RANGES.map(r =>
      `<button type="button" class="hud-range-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-range="${r.value}">${r.label}</button>`).join('');
    this.items = [...this.menu.querySelectorAll<HTMLButtonElement>('button')];
    this.update();
    this.button.addEventListener('click', () => this.menu.hidden ? this.open() : this.close());
    this.button.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.open();
      } else if (event.key === 'Escape') this.close();
    });
    for (const item of this.items) item.addEventListener('click', () => {
      const next = item.dataset.range as RevenueRange;
      const changed = next !== this.value;
      this.value = next;
      this.update();
      this.close(true);
      if (changed) onChange(next);
    });
    this.menu.addEventListener('keydown', event => {
      event.stopPropagation();
      const index = this.items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | undefined;
      if (event.key === 'ArrowDown') next = (index + 1) % this.items.length;
      if (event.key === 'ArrowUp') next = (index + this.items.length - 1) % this.items.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = this.items.length - 1;
      if (next !== undefined) { event.preventDefault(); this.items[next].focus(); }
      if (event.key === 'Escape') { event.preventDefault(); this.close(true); }
      // Continue the ordinary tab order from the trigger instead of trapping focus in the menu.
      if (event.key === 'Tab') this.close(true);
    });
    document.addEventListener('pointerdown', event => {
      const target = event.target as Node;
      if (!this.menu.contains(target) && !this.button.contains(target)) this.close();
    }, { capture: true, signal: this.listeners.signal });
    document.addEventListener('focusin', event => {
      const target = event.target as Node;
      if (!this.menu.contains(target) && !this.button.contains(target)) this.close();
    }, { signal: this.listeners.signal });
  }

  setCalendar(calendar: boolean) {
    this.calendar = calendar;
    this.button.title = calendar ? 'Calendar dates in UTC; today is partial' : 'Rolling time range';
    this.update();
  }

  close(returnFocus = false) {
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.funds.classList.remove('range-open');
    if (returnFocus) this.button.focus();
  }

  destroy() { this.stopEscape(); this.close(); this.listeners.abort(); }

  private open() {
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.funds.classList.add('range-open');
    this.items.find(item => item.dataset.range === this.value)?.focus();
  }

  private update() {
    for (const item of this.items) {
      const range = REVENUE_RANGES.find(r => r.value === item.dataset.range)!;
      item.textContent = this.calendar && range.value === '24h' ? 'Today' : range.label;
      item.setAttribute('aria-checked', String(range.value === this.value));
      if (range.value === this.value) {
        this.button.textContent = item.textContent;
        this.button.setAttribute('aria-label', `Revenue time range: ${item.textContent}`);
      }
    }
  }
}
