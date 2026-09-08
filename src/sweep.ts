import type { OfficeClient } from './net/office-client';
import { SWEEP_INTERVALS, type SweepScan, type SweepReview, type SweepResult } from '../shared/sweep';
import { employeeName, safeArtifactUrl } from '../shared/studio';
import { taskOf, type AgentInfo } from '../shared/types';
import { studioIcon } from './icons';
import { renderMarkdown } from './markdown';
import './sweep.css';
import { closeOnEscape } from './escape';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const age = (at: number, now: number) => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ago` : `${Math.floor(minutes / 1440)} days ago`;
};
const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
interface Options {
  janitorPortrait?(): HTMLElement | undefined;
  writable(): boolean; beforeOpen(): void; onJournal(): void; onTalk(paneId: string): void;
  onDepartures(agents: AgentInfo[]): Promise<void>;
}

export class Sweep {
  private root = document.createElement('div');
  private walking = false;
  private minutes = 60;
  private scan?: SweepScan;
  private review?: SweepReview;
  private result?: SweepResult;
  private selected = new Set<string>();
  private loading = '';
  private error = '';
  private request = 0;
  private returnFocus?: HTMLElement;
  constructor(private client: OfficeClient, private options: Options) {
    this.root.id = 'sweep-panel'; this.root.hidden = true;
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Re-org the office'); this.root.setAttribute('data-block-office-input', '');
    document.body.append(this.root);
    this.root.addEventListener('click', event => { if (event.target === this.root) this.close(); });
    closeOnEscape(this.root, () => this.close());
    this.root.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const elements = [...this.root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary')].filter(el => el.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
  }
  get isOpen() { return !this.root.hidden; }
  get isWalking() { return this.walking; }
  open() {
    this.returnFocus = document.activeElement as HTMLElement; this.options.beforeOpen();
    if (this.walking) return;
    this.root.hidden = false; this.review = undefined; this.result = undefined; this.selected.clear();
    void this.load();
  }
  close() {
    if (!this.isOpen || this.loading === 'Saving recaps…') return;
    this.root.hidden = true; this.request++; this.returnFocus?.focus({ preventScroll: true });
  }
  private async run<T>(label: string, method: string, params: Record<string, unknown>, apply: (result: T) => void) {
    const request = ++this.request;
    this.loading = label; this.error = ''; this.render();
    try {
      const result = await this.client.call(method, params, { timeoutMs: 100_000 }) as T;
      if (request === this.request) apply(result);
    } catch (error) { if (request === this.request) this.error = (error as Error).message; }
    finally { if (request === this.request) { this.loading = ''; this.render(); } }
  }
  private load() {
    this.review = undefined; this.result = undefined;
    return this.run<SweepScan>('Checking the office…', 'sweep.scan', { minutes: this.minutes }, scan => {
      this.scan = scan;
      const eligible = new Set(scan.workspaces.flatMap(w => w.agents.filter(a => a.eligible).map(a => a.agent.pane_id)));
      this.selected = new Set([...this.selected].filter(id => eligible.has(id)));
    });
  }
  private render() {
    const scroll = this.root.querySelector('.studio-content')?.scrollTop || 0;
    const focused = this.root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focusKey = focused && ['agent', 'workspace', 'minutes', 'selectAll'].find(key => key in focused.dataset);
    const focusValue = focusKey ? focused!.dataset[focusKey] : undefined;
    const saving = this.loading === 'Saving recaps…';
    this.root.innerHTML = `<div class="studio-window sweep-window" tabindex="-1"><header class="studio-header"><span class="studio-mark" aria-hidden="true">${studioIcon('sweep', 18)}</span><b>Re-org the office</b><small>${this.options.writable() ? '' : 'read only'}</small><button type="button" data-close aria-label="Close Re-org" ${saving ? 'disabled' : ''}>×</button></header>
      <div class="sweep-steps" aria-label="Re-org progress"><span class="${!this.review && !this.result ? 'current' : ''}">1 · Find idle desks</span><span class="${this.review && !this.result ? 'current' : ''}">2 · Review recaps</span><span class="${this.result ? 'current' : ''}">3 · Save & clear</span></div>
      <div class="studio-content">${this.result ? this.resultContent() : this.review ? this.reviewContent() : this.scanContent()}</div>
      <div class="sweep-status ${this.error ? 'error' : ''}" role="${this.error ? 'alert' : 'status'}">${esc(this.error || this.loading)}</div>
      <footer class="sweep-actions">${this.actions()}</footer></div>`;
    const portrait = this.options.janitorPortrait?.();
    if (portrait) this.root.querySelector('[data-gus-portrait]')?.append(portrait);
    this.root.querySelector('.studio-content')!.scrollTop = scroll;
    this.root.querySelector('[data-close]')?.addEventListener('click', () => this.close());
    this.root.querySelector('[data-scan]')?.addEventListener('click', () => void this.load());
    this.root.querySelector('[data-journal]')?.addEventListener('click', () => { this.close(); this.options.onJournal(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-minutes]').forEach(button => button.addEventListener('click', () => { this.minutes = Number(button.dataset.minutes); void this.load(); }));
    this.root.querySelectorAll<HTMLInputElement>('[data-agent]').forEach(input => input.addEventListener('change', () => { input.checked ? this.selected.add(input.dataset.agent!) : this.selected.delete(input.dataset.agent!); this.render(); }));
    this.root.querySelectorAll<HTMLInputElement>('[data-workspace]').forEach(input => input.addEventListener('change', () => {
      for (const row of this.scan!.workspaces.find(w => w.id === input.dataset.workspace)!.agents) if (row.eligible) input.checked ? this.selected.add(row.agent.pane_id) : this.selected.delete(row.agent.pane_id);
      this.render();
    }));
    this.root.querySelectorAll<HTMLInputElement>('[data-workspace]').forEach(input => {
      const rows = this.scan?.workspaces.find(w => w.id === input.dataset.workspace)?.agents.filter(a => a.eligible) || [];
      const count = rows.filter(a => this.selected.has(a.agent.pane_id)).length;
      input.indeterminate = count > 0 && count < rows.length;
    });
    this.root.querySelector('[data-select-all]')?.addEventListener('click', () => {
      const ids = this.scan!.workspaces.flatMap(w => w.agents.filter(a => a.eligible).map(a => a.agent.pane_id));
      this.selected = this.selected.size === ids.length ? new Set() : new Set(ids.slice(0, 50)); this.render();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-talk]').forEach(button => button.addEventListener('click', () => { this.close(); this.options.onTalk(button.dataset.talk!); }));
    this.root.querySelector('[data-prepare]')?.addEventListener('click', () => void this.run<SweepReview>('Reading the last findings…', 'sweep.prepare', { minutes: this.minutes, paneIds: [...this.selected] }, review => { this.review = review; }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-finish]').forEach(button => button.addEventListener('click', () => {
      const close = button.dataset.finish === 'close';
      void this.run<SweepResult>('Saving recaps…', 'sweep.finish', { token: this.review!.token, close, confirm: this.review!.recaps.map(r => r.paneId) }, result => {
        this.result = result;
        if (result.closed.length) this.showDeparture(result);
      });
    }));
    if (this.loading) this.root.querySelector('.studio-window')?.setAttribute('aria-busy', 'true');
    // Keep keyboard focus after a filter/selection causes a redraw.
    if (focusKey) [...this.root.querySelectorAll<HTMLElement>('button,input')].find(el => el.dataset[focusKey] === focusValue && !(el as HTMLButtonElement).disabled)?.focus({ preventScroll: true });
    if (this.isOpen && !this.root.contains(document.activeElement)) this.root.querySelector<HTMLElement>('.studio-window')?.focus({ preventScroll: true });
  }
  private showDeparture(result: SweepResult) {
    this.root.hidden = true; this.walking = true;
    const cast = result.closed.map(paneId => this.scan?.workspaces.flatMap(w => w.agents).find(a => a.agent.pane_id === paneId)?.agent
      ?? { pane_id: paneId, agent: null, agent_status: 'idle' as const, office_name: this.review?.recaps.find(r => r.paneId === paneId)?.name });
    void this.options.onDepartures(cast).catch(() => {
      this.error = 'The cutscene could not play. Your saved recaps and closure results are below.';
    }).finally(() => {
      this.walking = false; this.root.hidden = false; this.render();
    });
  }
  private scanContent() {
    const count = this.scan?.workspaces.reduce((n, w) => n + w.agents.filter(a => a.eligible).length, 0) || 0;
    return `<div class="sweep-intro sweep-intro-gus"><div class="sweep-gus" data-gus-portrait></div><div><small>GUS · OFFICE JANITOR</small><h2>Keep the work. Clear the desks.</h2><p>“I keep the floors clean. You decide who clocks out.” Review quiet agents, save their last findings and artifact links to the Journal, then close the ones you choose.</p></div></div>
      <div class="sweep-filters"><span>Inactive for at least</span><div role="group" aria-label="Inactivity cutoff">${SWEEP_INTERVALS.map(i => `<button type="button" data-minutes="${i.minutes}" aria-pressed="${i.minutes === this.minutes}" ${this.loading ? 'disabled' : ''}>${i.label}</button>`).join('')}</div><button type="button" data-scan ${this.loading ? 'disabled' : ''}>Scan again</button></div>
      ${this.scan ? `<div class="sweep-tally"><b>${count} ${count === 1 ? 'agent' : 'agents'} ready for review</b><span>${this.scan.protectedCount} working or needing attention kept out</span><button type="button" data-select-all ${!count || this.loading ? 'disabled' : ''}>${this.selected.size === count && count ? 'Clear selection' : 'Select eligible'}</button></div>
      ${this.scan.workspaces.map(w => {
        const eligible = w.agents.filter(a => a.eligible), selected = eligible.filter(a => this.selected.has(a.agent.pane_id)).length;
        return `<section class="sweep-workspace"><header><label><input type="checkbox" data-workspace="${esc(w.id)}" ${eligible.length && selected === eligible.length ? 'checked' : ''} ${!eligible.length || this.loading ? 'disabled' : ''}><b>${esc(w.name)}</b><code>${esc(w.id)}</code></label><small>${w.activeAgents ? `${w.activeAgents} active · ` : ''}${w.otherPanes > 0 ? `${w.otherPanes} other terminal ${w.otherPanes === 1 ? 'pane' : 'panes'}` : 'Quiet desks'}</small></header>
          ${w.agents.map(row => { const a = row.agent; return `<div class="sweep-agent ${row.eligible ? '' : 'recent'}"><label><input type="checkbox" data-agent="${esc(a.pane_id)}" ${this.selected.has(a.pane_id) ? 'checked' : ''} ${!row.eligible || this.loading ? 'disabled' : ''}><span><b>${esc(employeeName(a))}</b><code>${esc(a.pane_id)}</code><span class="sweep-prompt">${esc(a.last_prompt || taskOf(a) || 'Last prompt will be checked during review')}</span></span></label><div class="sweep-age"><b>${esc(a.agent_status)}</b><span title="${esc(new Date(row.lastActiveAt).toLocaleString())}">last active ${age(row.lastActiveAt, this.scan!.at)}</span>${row.reason ? `<small>${esc(row.reason)}</small>` : ''}</div><button type="button" data-talk="${esc(a.pane_id)}" ${this.loading ? 'disabled' : ''}>Open</button></div>`; }).join('')}</section>`;
      }).join('') || '<div class="studio-empty">No idle or done agents to re-organize.</div>'}
      <p class="sweep-workspace-option">Closing the last pane also closes its workspace. The next step lists every affected workspace; workspaces with other panes stay open.</p>
      <p class="sweep-footnote">Inactivity uses the last recorded conversation activity and the bridge’s observations. Newly discovered agents without a saved conversation start their clock now.</p>` : '<div class="studio-empty">Checking idle desks and their last activity…</div>'}`;
  }
  private reviewContent() {
    const r = this.review!;
    return `<div class="sweep-intro"><h2>Review what stays in the Journal</h2><p>These recaps use the agents’ recorded replies. Saves happen before any agent is closed; agents that resume work are kept open.</p></div>
      ${r.recaps.map((recap, i) => `<article class="sweep-recap"><header><b>${esc(recap.name)}</b><span>${esc(recap.status)} · ${esc(recap.workspace)}</span><code>${esc(recap.paneId)}</code></header><p><b>Last prompt</b><br>${esc(recap.prompt)}</p>
        <details ${i === 0 ? 'open' : ''}><summary>Last findings & ${recap.artifacts.length} artifact references</summary><div class="sweep-findings">${renderMarkdown(recap.findings)}</div><ul class="sweep-artifacts">${recap.artifacts.map(a => `<li>${safeArtifactUrl(a) ? `<a href="${esc(safeArtifactUrl(a))}" target="_blank" rel="noopener noreferrer">${esc(a)}</a>` : `<code>${esc(a)}</code>`}</li>`).join('')}</ul><small>Source: ${recap.source === 'transcript' ? 'saved conversation' : recap.source === 'terminal' ? 'terminal excerpt' : 'no final reply available'}${recap.session ? ` · Session ${esc(recap.session)}` : ''}</small></details></article>`).join('')}
      <div class="sweep-close-summary"><b>If you close this selection</b><p>${r.recaps.length} agent ${r.recaps.length === 1 ? 'pane closes' : 'panes close'}. ${r.closeWorkspaces.length ? `These workspaces also close: ${r.closeWorkspaces.map(w => esc(w.name)).join(', ')}.` : 'No workspace closures are included.'} Saved conversations and files stay on disk.</p></div>`;
  }
  private resultContent() {
    const result = this.result!;
    return `<div class="sweep-complete"><i aria-hidden="true">${studioIcon('journal', 36)}</i><h2>${countLabel(result.saved.length, 'recap')} saved to the Journal</h2><p>${result.closed.length ? `${countLabel(result.closed.length, 'agent')} closed${result.closedWorkspaces.length ? ` · ${countLabel(result.closedWorkspaces.length, 'workspace')} closed` : ''}.` : result.kept.length ? 'Some agents need another check; see below.' : 'Your agents are still open.'}</p></div>
      ${result.kept.length ? `<section class="sweep-kept"><h3>Needs review</h3>${result.kept.map(item => `<p><code>${esc(item.paneId)}</code> · ${esc(item.reason)}</p>`).join('')}</section>` : ''}<p>Find the saved prompts, findings, artifact references, and session IDs under “Re-org” in the Journal.</p>`;
  }
  private actions() {
    const disabled = this.loading ? 'disabled' : '';
    if (this.result) return `<button type="button" data-scan ${this.walking ? 'disabled' : ''}>Re-org again</button><button type="button" class="primary" data-journal>View Journal</button>`;
    if (this.review) return `<button type="button" data-scan ${disabled}>Back to selection</button><button type="button" data-finish="save" ${this.loading || !this.options.writable() ? 'disabled' : ''}>Save recaps only</button><button type="button" class="primary" data-finish="close" ${this.loading || !this.options.writable() ? 'disabled' : ''}>Save recaps & close ${countLabel(this.review.recaps.length, 'agent')}</button>`;
    return `<span>${this.selected.size} selected</span><button type="button" class="primary" data-prepare ${this.loading || !this.selected.size ? 'disabled' : ''}>Review selected agents</button>`;
  }
}
