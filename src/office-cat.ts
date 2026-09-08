import type { JournalEntry, JournalPage, StudioState } from '../shared/studio';
import type { OfficeClient } from './net/office-client';
import { closeOnEscape } from './escape';
import { paintCat } from './scenes/regulars-art';
import './office-cat.css';

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
  get isOpen() { return !this.root.hidden; }
  constructor(private client: OfficeClient, private options: Options) {
    this.root.id = 'office-cat'; this.root.hidden = true; this.root.dataset.blockOfficeInput = '';
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-labelledby', 'cat-heading');
    this.root.innerHTML = `<section class="cat-window"><header><b id="cat-heading">Miso · Office cat</b><button data-close aria-label="Close office cat">×</button></header>
      <div class="cat-greeting"><div data-portrait></div><div><small>HEAD OF NAPS</small><p data-mood role="status">Mrrp. You may take a break.</p><button data-pet>Pet Miso</button></div></div>
      <div class="cat-memory"><small>A LITTLE SOMETHING I FOUND</small><h2 data-title></h2><p data-notes></p><small data-date></small><p data-status role="status"></p>
      <div class="cat-actions"><button data-open hidden>Open in Journal →</button><button data-another>Find another memory</button></div></div>
      <footer>Good work deserves a second look. And then a nap.</footer></section>`;
    this.portrait.width = 36; this.portrait.height = 34; this.portrait.setAttribute('aria-label', 'Miso, a ginger cat wearing a green collar'); this.portrait.setAttribute('role', 'img');
    this.root.querySelector('[data-portrait]')!.append(this.portrait); this.draw(false);
    document.body.append(this.root); closeOnEscape(this.root, () => this.close());
    this.root.addEventListener('click', e => {
      if (e.target === this.root || (e.target as HTMLElement).closest('[data-close]')) this.close();
    });
    this.root.querySelector('[data-pet]')!.addEventListener('click', () => {
      this.options.onPet(); this.draw(true);
      const lines = ['Prrrr. Your work has been inspected. It is warm.', 'One more pet. Then we both get back to work.', 'Miso has promoted you to favourite human.', 'The purring is now a load-bearing office feature.'];
      this.root.querySelector('[data-mood]')!.textContent = lines[this.pets++ % lines.length];
    });
    this.root.querySelector('[data-another]')!.addEventListener('click', () => { this.pick(); if (!this.fetched) void this.load(); });
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
    this.root.hidden = false; this.draw(false);
    this.root.querySelector('[data-mood]')!.textContent = 'Mrrp. You may take a break.';
    this.merge(this.options.state()?.journal ?? []); this.pick();
    this.root.querySelector<HTMLButtonElement>('[data-pet]')!.focus({ preventScroll: true });
    if (Date.now() - this.fetched > 300_000) void this.load();
  }
  close(focus = true) {
    if (!this.isOpen) return;
    this.root.hidden = true; this.request++; this.controller?.abort();
    if (focus) this.previousFocus?.focus({ preventScroll: true });
  }
  private draw(happy: boolean) {
    const c = this.portrait.getContext('2d')!; c.clearRect(0, 0, 36, 34); paintCat(c, happy ? 'happy' : 'stand');
    if (happy) { c.fillStyle = '#bc6a68'; c.fillRect(23, 1, 2, 2); c.fillRect(26, 1, 2, 2); c.fillRect(23, 3, 5, 1); c.fillRect(24, 4, 3, 1); c.fillRect(25, 5, 1, 1); }
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
