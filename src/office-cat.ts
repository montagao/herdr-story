import type { JournalEntry, JournalPage, StudioState } from '../shared/studio';
import type { OfficeClient } from './net/office-client';
import { closeOnEscape } from './escape';
import { paintCat, paintHeart } from './scenes/regulars-art';
import './office-cat.css';
import { dismissOnBackdrop, reducedMotion, replayAnimation, snapShut } from './motion';
import { audio } from './audio';

interface Options { state(): StudioState | undefined; beforeOpen(): void; onPet(): void; onEntry(id: string): void }
const eligible = (entry: JournalEntry) => ['task', 'milestone', 'release'].includes(entry.kind);
const plain = (text: string) => text.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/[#*`_>]/g, '').replace(/\s+/g, ' ').trim();

export class OfficeCat {
  private root = document.createElement('div');
  private portrait = document.createElement('canvas');
  private previousFocus?: HTMLElement;
  private entries: JournalEntry[] = [];
  private current?: JournalEntry;
  private shown = new Set<string>();
  private fetched = 0;
  private request = 0;
  private controller?: AbortController;
  private pets = 0;
  private happy = false;
  /** The portrait's idle clock, five beats a second while the window is up. */
  private beat = 0; private idle = 0;
  get isOpen() { return !this.root.hidden; }
  constructor(private client: OfficeClient, private options: Options) {
    this.root.id = 'office-cat'; this.root.hidden = true; this.root.dataset.blockOfficeInput = '';
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-labelledby', 'cat-heading');
    this.root.innerHTML = `<section class="cat-window"><header><b id="cat-heading">Miso · Office cat</b><button data-close aria-label="Close office cat">×</button></header>
      <div class="cat-greeting"><div class="cat-portrait" data-portrait></div><div><small>HEAD OF NAPS</small><p data-mood role="status">Mrrp. You may take a break.</p><button data-pet>Pet Miso</button></div></div>
      <div class="cat-memory"><small>A LITTLE SOMETHING I FOUND</small><h2 data-title></h2><p data-notes></p><small data-date></small><p data-status role="status"></p>
      <div class="cat-actions"><button data-another>Find another memory</button><button data-open hidden>Open in Journal →</button></div></div>
      <footer>Good work deserves a second look. And then a nap.</footer></section>`;
    this.portrait.width = 36; this.portrait.height = 34; this.portrait.setAttribute('aria-label', 'Miso, a ginger cat wearing a green collar'); this.portrait.setAttribute('role', 'img');
    this.root.querySelector('[data-portrait]')!.append(this.portrait); this.draw();
    document.body.append(this.root); closeOnEscape(this.root, () => this.close());
    dismissOnBackdrop(this.root, () => this.close());
    this.root.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-close]')) this.close(); });
    this.root.querySelector('[data-pet]')!.addEventListener('click', () => {
      this.options.onPet(); this.happy = true; this.draw();
      const lines = ['Prrrr. Your work has been inspected. It is warm.', 'One more pet. Then we both get back to work.', 'Miso has promoted you to favourite human.', 'The purring is now a load-bearing office feature.'];
      this.root.querySelector('[data-mood]')!.textContent = lines[this.pets++ % lines.length];
      audio.blip('pop');
      if (reducedMotion()) return;
      // Every pet is answered: she hops, and a heart lifts off her and is gone.
      replayAnimation(this.portrait, 'pet');
      const heart = document.createElement('canvas'); heart.className = 'cat-heart'; heart.width = heart.height = 5;
      paintHeart(heart.getContext('2d')!);
      heart.addEventListener('animationend', () => heart.remove());
      this.portrait.after(heart);
    });
    this.root.querySelector('[data-another]')!.addEventListener('click', () => {
      this.pick(); audio.blip('tick'); replayAnimation(this.root.querySelector('.cat-memory'), 'swap');
      if (!this.fetched) void this.load();
    });
    this.root.querySelector('[data-open]')!.addEventListener('click', () => { if (this.current) { const id = this.current.id; this.close(false); this.options.onEntry(id); } });
    this.root.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button')].filter(b => !b.hidden && !b.disabled);
      if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0]?.focus(); }
    });
  }
  open() {
    const active = document.activeElement as HTMLElement;
    this.previousFocus = active !== document.body && active?.getClientRects().length ? active : document.getElementById('front-desk') ?? undefined;
    this.options.beforeOpen();
    this.root.hidden = false; this.happy = false; this.beat = 1; this.draw();
    this.root.querySelector('[data-mood]')!.textContent = 'Mrrp. You may take a break.';
    // a class left on from last time would play its animation again as the window comes back
    this.portrait.classList.remove('pet'); this.root.querySelector('.cat-memory')!.classList.remove('swap');
    this.merge(this.options.state()?.journal ?? []); this.pick();
    this.root.querySelector<HTMLButtonElement>('[data-pet]')!.focus({ preventScroll: true });
    clearInterval(this.idle);
    if (!reducedMotion()) this.idle = window.setInterval(() => { this.beat++; this.draw(); }, 200);
    if (Date.now() - this.fetched > 300_000) void this.load();
  }
  close(focus = true) {
    if (!this.isOpen) return;
    snapShut(this.root.firstElementChild); this.root.hidden = true; this.request++; this.controller?.abort();
    clearInterval(this.idle);
    // a heart caught in mid-air would otherwise start its rise again the next time the window opens
    for (const heart of this.root.querySelectorAll('.cat-heart')) heart.remove();
    if (focus) this.previousFocus?.focus({ preventScroll: true });
  }
  /** The portrait is the floor's own drawing. Idle, her tail flicks twice every few seconds and
   *  she blinks in between; the heart is drawn in only where it cannot float off by itself. */
  private draw() {
    const c = this.portrait.getContext('2d')!, beat = this.beat % 16;
    c.clearRect(0, 0, 36, 34);
    paintCat(c, this.happy || beat === 8 ? 'happy' : 'stand', beat === 0 || beat === 2 ? 1 : 0);
    if (this.happy && reducedMotion()) paintHeart(c, 23, 1);
  }
  private merge(entries: JournalEntry[]) {
    const retired = new Set(this.options.state()?.journalRetired ?? []);
    this.entries = [...new Map([...this.entries, ...entries].filter(e => eligible(e) && !retired.has(e.id)).map(e => [e.id, e])).values()];
  }
  private pick() {
    let choices = this.entries.filter(e => !this.shown.has(e.id));
    if (!choices.length) { this.shown.clear(); choices = this.entries.filter(e => e.id !== this.current?.id); }
    this.current = choices[Math.floor(Math.random() * choices.length)] ?? this.entries[0];
    const e = this.current; if (e) this.shown.add(e.id);
    this.root.querySelector('[data-title]')!.textContent = e?.title || 'The memory collection is still growing.';
    const notes = plain(e?.notes || '');
    this.root.querySelector('[data-notes]')!.textContent = e ? notes.slice(0, 300) + (notes.length > 300 ? '…' : '') : 'Finish a task or record a milestone in the Journal. Miso will bring it back for a victory lap.';
    this.root.querySelector('[data-date]')!.textContent = e ? `${e.kind === 'task' ? 'Completed task' : e.kind === 'release' ? 'Release' : 'Milestone'} · ${new Date(e.at).toLocaleDateString()}` : '';
    this.root.querySelector<HTMLButtonElement>('[data-open]')!.hidden = !e;
    this.root.querySelector<HTMLButtonElement>('[data-another]')!.textContent = this.entries.length ? 'Find another memory' : 'Look for memories';
  }
  private async load() {
    this.controller?.abort(); this.controller = new AbortController();
    const request = ++this.request, status = this.root.querySelector('[data-status]')!;
    status.textContent = this.entries.length ? '' : 'Checking under the filing cabinet…';
    const results = await Promise.allSettled(['task', 'milestone', 'release'].map(kind => this.client.call('studio.journal', { kind, limit: 30 }, { signal: this.controller!.signal }) as Promise<JournalPage>));
    if (request !== this.request || !this.isOpen) return;
    for (const result of results) if (result.status === 'fulfilled') this.merge(result.value.entries);
    const failed = results.some(r => r.status === 'rejected');
    if (!failed) this.fetched = Date.now();
    status.textContent = failed ? 'Couldn’t reach all the shelves. Try looking again.' : '';
    if (!this.current) this.pick();
  }
}
