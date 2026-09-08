// The title screen: the office loads behind a game's "Now Loading" card rather than an empty
// room. The markup is in index.html so it is on screen from the first paint; this only advances
// the steps and takes it down once the first agents are seated.
const STEPS = ['art', 'bridge', 'agents'] as const;
export type LoadStep = typeof STEPS[number];

export class Loading {
  private root = document.getElementById('loading');
  private status = this.root?.querySelector<HTMLElement>('[data-status]') ?? null;
  private bar = this.root?.querySelector<HTMLElement>('[data-bar]') ?? null;
  private note = this.root?.querySelector<HTMLElement>('[data-note]') ?? null;
  private slow?: number;
  private finished = false;
  constructor() {
    // A bridge that never answers should say so, not spin forever.
    this.slow = window.setTimeout(() => this.setNote('Still waiting for the bridge · is `npm run dev` running?'), 12_000);
  }
  step(step: LoadStep, text: string) {
    if (this.finished || !this.root) return;
    if (this.status) this.status.textContent = text;
    if (this.bar) this.bar.style.width = `${Math.round(((STEPS.indexOf(step) + 1) / (STEPS.length + 1)) * 100)}%`;
  }
  setNote(text: string) { if (this.note) this.note.textContent = text; }
  fail(message: string) {
    if (!this.root) return;
    clearTimeout(this.slow);
    this.root.classList.add('failed');
    if (this.status) this.status.textContent = 'Could not open the office';
    this.setNote(message);
  }
  /** Fill the bar, say hello, and fade the card away over the finished office. */
  finish(agents: number) {
    if (this.finished || !this.root) return;
    this.finished = true; clearTimeout(this.slow);
    if (this.status) this.status.textContent = agents ? `${agents} ${agents === 1 ? 'agent is' : 'agents are'} at their desks` : 'The office is open';
    if (this.bar) this.bar.style.width = '100%';
    const root = this.root;
    const away = () => { root.hidden = true; root.classList.remove('leaving'); };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { away(); return; }
    window.setTimeout(() => { root.classList.add('leaving'); root.addEventListener('transitionend', away, { once: true }); window.setTimeout(away, 900); }, 500);
  }
}
