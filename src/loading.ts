// The title screen: the office loads behind a game's "Now Loading" card rather than an empty
// room. The markup is in index.html so it is on screen from the first paint; this only advances
// the steps and takes it down once the first agents are seated.
const STEPS = ['art', 'bridge', 'agents'] as const;
export type LoadStep = typeof STEPS[number];

/** The red banner in index.html. It is also the net for a main.ts that never loaded at all, so it
 *  can be showing before boot() even runs; anything that gets the office open takes it back down
 *  rather than leaving a stale failure over a working room. */
const bootBanner = () => document.getElementById('boot-error');
export function bootFailed(message: string) { const box = bootBanner(); if (box) { box.hidden = false; box.textContent = `Could not start the office: ${message}`; } }
export function bootSucceeded() { const box = bootBanner(); if (box) box.hidden = true; }

export class Loading {
  private root = document.getElementById('loading');
  private status = this.root?.querySelector<HTMLElement>('[data-status]') ?? null;
  private bar = this.root?.querySelector<HTMLElement>('[data-bar]') ?? null;
  private note = this.root?.querySelector<HTMLElement>('[data-note]') ?? null;
  private slow?: number;
  private finished = false;
  private reached = -1;
  /** The card has gone and the room is the whole picture. */
  onGone?: () => void;
  constructor() {
    // A bridge that never answers should say so, not spin forever.
    this.slow = window.setTimeout(() => this.setNote('Still waiting for the bridge · is `npm run dev` running?'), 12_000);
  }
  step(step: LoadStep, text: string) {
    if (this.finished || !this.root) return;
    // The bridge usually answers before the room is up, so the steps can arrive out of order;
    // a bar that runs backwards reads as something going wrong.
    const index = STEPS.indexOf(step);
    if (index < this.reached) return;
    this.reached = index;
    if (this.status) this.status.textContent = text;
    if (this.bar) this.bar.style.width = `${Math.round(((index + 1) / (STEPS.length + 1)) * 100)}%`;
  }
  setNote(text: string) { clearTimeout(this.slow); if (this.note) this.note.textContent = text; }
  fail(message: string) {
    if (!this.root) return;
    clearTimeout(this.slow);
    this.root.classList.add('failed');
    if (this.status) this.status.textContent = 'Could not open the office';
    this.setNote(message);
  }
  /** Fill the bar, say hello, and raise the card off the finished office like a shop's shutter. */
  finish(agents: number) {
    if (this.finished || !this.root) return;
    this.finished = true; clearTimeout(this.slow);
    if (this.status) this.status.textContent = agents ? `${agents} ${agents === 1 ? 'agent is' : 'agents are'} at their desks` : 'The office is open';
    if (this.bar) this.bar.style.width = '100%';
    const root = this.root;
    const away = () => { if (root.hidden) return; root.hidden = true; root.classList.remove('leaving'); this.onGone?.(); };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { away(); return; }
    window.setTimeout(() => {
      root.classList.add('leaving');
      // only the card's own shutter ends it: the bar inside has a transition of its own
      root.addEventListener('transitionend', (event) => { if (event.target === root && event.propertyName === 'clip-path') away(); });
      window.setTimeout(away, 900);
    }, 500);
  }
}
