import type { AgentInfo, WorkspaceSummary } from '../shared/types';
import { taskOf } from '../shared/types';
import { employeeName, projectKey, projectName, type JournalEntry, type JournalPage, type StudioState } from '../shared/studio';
import type { BossArchivePage, BossBriefing } from '../shared/boss';
import type { OfficeClient } from './net/office-client';
import { closeOnEscape } from './escape';
import { attentionAgents, findReceptionAgents, matchesReception, receptionProjects, taskAgents, visitStart } from './reception-data';
import './reception.css';

type View = 'attention' | 'task' | 'recap' | 'search';
type RecapKind = 'task' | 'milestone' | 'release' | 'sale';
type Page<T> = { rows: T[]; total: number; cursor: string | null; error?: string; loading?: boolean };
interface Options {
  agents(): AgentInfo[]; state(): StudioState | undefined; workspaces(): WorkspaceSummary[]; writable(): boolean;
  visit: ReturnType<typeof visitStart>;
  beforeOpen(): void; onAgent(agent: AgentInfo): void; onProject(id: string): void;
  onCat?(): void; onJanitor?(): void;
  onEntry(id: string): void; onIdea(briefing: BossBriefing, index: number): void;
  onTask(agent: AgentInfo, text: string): void; onHire(text: string, project: string | undefined, workspace: string | undefined, sent: () => void): void;
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const snippet = (s: string, n = 180) => s.replace(/\s+/g, ' ').trim().slice(0, n) + (s.length > n ? '…' : '');
const when = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const amount = (entry: JournalEntry) => {
  if (entry.amount === undefined) return '';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: entry.currency || 'USD' }).format(entry.amount); }
  catch { return `${entry.amount.toFixed(2)} ${entry.currency || ''}`; }
};
const bell = '<svg viewBox="0 0 16 16" aria-hidden="true" shape-rendering="crispEdges"><path fill="#755533" d="M7 1h2v2h2v2h2v6h2v3H1v-3h2V5h2V3h2z"/><path fill="#e7bd63" d="M5 5h6v2h1v4H4V7h1zM2 12h12v1H2z"/><path fill="#ffedac" d="M5 6h2v4H5z"/></svg>';
const VIEWS: [View, string][] = [['attention', 'Who needs me?'], ['task', 'I have a new task.'], ['recap', 'Catch me up.'], ['search', 'Find something.']];
const RECAP: [RecapKind, string][] = [['task', 'Completed work'], ['milestone', 'Milestones'], ['release', 'Releases'], ['sale', 'Payments']];
const DRAFT_KEY = 'herdr-story:front-desk-task';

/** The front desk routes existing data and workflows. Opening it never prompts an agent. */
export class Reception {
  private root = document.createElement('div');
  private launcher = document.createElement('button');
  private view: View = 'attention';
  private generation = 0;
  private controller?: AbortController;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private previousFocus?: HTMLElement;
  private attentionKey = '';
  private draft = { text: '', project: '', agent: '' };
  private query = '';
  private recap = new Map<RecapKind, Page<JournalEntry>>();
  private memories: Page<JournalEntry> = { rows: [], total: 0, cursor: null };
  private ideas: Page<BossBriefing> = { rows: [], total: 0, cursor: null };
  private recapCache?: { key: string; at: number; pages: Map<RecapKind, Page<JournalEntry>> };
  private recapKey = '';
  private since: number;
  private firstVisit: boolean;
  get isOpen() { return !this.root.hidden; }
  static previousVisit() { try { return visitStart(localStorage.getItem('herdr-story:seen-at')); } catch { return visitStart(null); } }
  constructor(private client: OfficeClient, private options: Options) {
    this.since = options.visit.since; this.firstVisit = options.visit.firstVisit;
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
      for (const key of ['text', 'project', 'agent'] as const) if (typeof saved[key] === 'string') this.draft[key] = saved[key].slice(0, key === 'text' ? 20_000 : 2000);
    } catch { /* Start with a blank task. */ }
    this.root.id = 'reception'; this.root.hidden = true; this.root.dataset.blockOfficeInput = '';
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-labelledby', 'reception-heading');
    this.root.innerHTML = `<section class="reception-window"><header>${bell}<b id="reception-heading">Front desk</b><button data-close aria-label="Close front desk">×</button></header>
      <div class="reception-welcome"><img src="/assets/gds/office/reception_002.png" alt=""><div><small>RECEPTION</small><p>How can I help?</p></div></div>
      <div class="reception-layout"><nav aria-label="Ask the receptionist">${VIEWS.map(([id, label]) => `<button data-view="${id}" aria-pressed="false">${label}${id === 'attention' ? '<span data-count></span>' : ''}</button>`).join('')}</nav>
      <div class="reception-content" tabindex="-1"></div></div><p class="reception-status" role="status"></p>
      <div class="reception-regulars"><span>Office regulars</span>${options.onCat ? '<button data-cat>Miso · Office cat</button>' : ''}${options.onJanitor ? '<button data-janitor>Gus · Re-org</button>' : ''}</div></section>`;
    document.body.append(this.root);
    closeOnEscape(this.root, () => this.close());
    this.root.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = [...this.root.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    this.root.addEventListener('click', e => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.hasAttribute('data-close')) return this.close();
      if (button.hasAttribute('data-cat')) { this.close(false); options.onCat?.(); return; }
      if (button.hasAttribute('data-janitor')) { this.close(false); options.onJanitor?.(); return; }
      if (button.dataset.view) return this.show(button.dataset.view as View);
      if (button.dataset.receptionAgent) {
        const agent = options.agents().find(a => a.pane_id === button.dataset.receptionAgent);
        if (!agent) { this.note('That agent has left the office.'); this.sync(); return; }
        this.close(false); options.onAgent(agent);
      }
      if (button.dataset.project) { this.close(false); options.onProject(button.dataset.project); }
      if (button.dataset.entry) { this.close(false); options.onEntry(button.dataset.entry); }
      if (button.dataset.idea) {
        const briefing = this.ideas.rows.find(b => b.id === button.dataset.idea);
        if (briefing) { this.close(false); options.onIdea(briefing, Number(button.dataset.index)); }
      }
      if (button.dataset.recapMore) void this.loadRecap(button.dataset.recapMore as RecapKind, true);
      if (button.dataset.recapRetry) void this.loadRecap(button.dataset.recapRetry as RecapKind);
      if (button.dataset.recapJump) this.content.querySelector(`[data-recap-section="${button.dataset.recapJump}"]`)?.scrollIntoView({ block: 'start' });
      if (button.dataset.searchMore) void this.loadSearch(button.dataset.searchMore as 'memories' | 'ideas', true);
      if (button.dataset.searchRetry) void this.loadSearch(button.dataset.searchRetry as 'memories' | 'ideas');
    });
    this.launcher.id = 'front-desk'; this.launcher.type = 'button'; this.launcher.innerHTML = `${bell}<span>Front desk</span><small hidden></small>`;
    this.launcher.onclick = () => this.open();
    document.querySelector('.head-tools')?.prepend(this.launcher);
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt) {
        this.since = hiddenAt; this.firstVisit = false; hiddenAt = 0; this.recapCache = undefined;
        if (this.isOpen && this.view === 'recap') this.show('recap');
      }
    });
    this.sync();
  }
  open() {
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.options.beforeOpen(); this.root.hidden = false; this.show('attention');
    this.root.querySelector<HTMLButtonElement>('[data-view="attention"]')!.focus();
  }
  close(restoreFocus = true) {
    this.root.hidden = true; this.controller?.abort(); this.generation++; clearTimeout(this.searchTimer);
    if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
  }
  sync() {
    const count = attentionAgents(this.options.agents()).length;
    this.launcher.title = count ? `Front desk · ${count} ${count === 1 ? 'agent needs' : 'agents need'} you` : 'Open the front desk';
    this.launcher.setAttribute('aria-label', this.launcher.title);
    const badge = this.launcher.querySelector('small')!; badge.hidden = !count; badge.textContent = String(count);
    this.root.querySelector('[data-count]')!.textContent = count ? String(count) : '';
    if (!this.isOpen) return;
    if (this.view === 'attention') this.paintAttention();
    if (this.view === 'task') this.paintTaskAgents();
  }
  private get content() { return this.root.querySelector<HTMLElement>('.reception-content')!; }
  private note(text: string) { this.root.querySelector('.reception-status')!.textContent = text; }
  private saveDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(this.draft)); } catch { /* The open window retains it. */ } }
  private show(view: View) {
    this.controller?.abort(); this.controller = new AbortController(); this.generation++; clearTimeout(this.searchTimer);
    this.view = view; this.note(''); this.attentionKey = '';
    this.root.querySelectorAll<HTMLElement>('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    this.content.scrollTop = 0;
    if (view === 'attention') this.paintAttention();
    if (view === 'task') this.paintTask();
    if (view === 'recap') this.startRecap();
    if (view === 'search') this.startSearch();
  }
  private agentCard(a: AgentInfo, attention = false) {
    return `<button class="reception-card${attention ? ' needs-attention' : ''}" data-reception-agent="${esc(a.pane_id)}"><span class="reception-card-title"><b>${esc(employeeName(a))}</b><small>${attention ? 'Needs you' : esc(a.agent_status)}</small></span><span>${esc(snippet(attention ? a.activity || taskOf(a) || 'Waiting for your input.' : taskOf(a) || 'Ready for a task'))}</span><small>${esc(this.options.state()?.projects.find(p => p.id === projectKey(a))?.name || projectName(projectKey(a)))} · Open chat →</small></button>`;
  }
  private paintAttention() {
    const agents = attentionAgents(this.options.agents()), key = JSON.stringify(agents);
    if (key === this.attentionKey) return;
    const focused = (document.activeElement as HTMLElement)?.dataset.receptionAgent;
    this.attentionKey = key;
    this.content.innerHTML = `<h2>${agents.length ? `${agents.length} ${agents.length === 1 ? 'person is' : 'people are'} waiting for you.` : 'Everyone is taken care of.'}</h2><p class="reception-help">${agents.length ? 'Open a chat to answer a question or review an approval.' : 'No agents are waiting for your input. I’ll keep an eye on the desk.'}</p>${agents.map(a => this.agentCard(a, true)).join('')}`;
    if (focused) this.content.querySelector<HTMLButtonElement>(`[data-reception-agent="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  private paintTask() {
    const projects = receptionProjects(this.options.state(), this.options.agents());
    if (!this.draft.project) this.draft.project = projects[0]?.id ?? '__new';
    const unavailableProject = this.draft.project !== '__new' && !projects.some(p => p.id === this.draft.project);
    this.content.innerHTML = `<h2>What needs doing?</h2><p class="reception-help">Choose a project and someone to help. You can review the task before it starts.</p>
      <form class="reception-task"><label>Task<textarea name="task" rows="5" maxlength="20000" required placeholder="Describe the work…">${esc(this.draft.text)}</textarea></label>
      <label>Project<select name="project">${unavailableProject ? `<option value="${esc(this.draft.project)}" selected disabled>Project unavailable · choose another</option>` : ''}${projects.map(p => `<option value="${esc(p.id)}"${p.id === this.draft.project ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new"${this.draft.project === '__new' ? ' selected' : ''}>New workspace…</option></select></label>
      <label>Who should take it?<select name="agent"></select></label><p class="reception-help" data-task-hint></p><div class="reception-task-actions"><button type="submit" class="reception-primary"${this.options.writable() ? '' : ' disabled'}>Review task →</button><button type="button" data-open-task-agent>Open existing chat</button></div></form>`;
    const form = this.content.querySelector<HTMLFormElement>('form')!;
    form.addEventListener('input', () => {
      this.draft.text = (form.elements.namedItem('task') as HTMLTextAreaElement).value; this.saveDraft();
    });
    form.querySelector<HTMLSelectElement>('[name="project"]')!.onchange = e => {
      this.draft.project = (e.target as HTMLSelectElement).value; this.draft.agent = ''; this.paintTaskAgents(); this.saveDraft();
    };
    form.querySelector<HTMLSelectElement>('[name="agent"]')!.onchange = e => { this.draft.agent = (e.target as HTMLSelectElement).value; this.paintTaskAgents(); this.saveDraft(); };
    form.querySelector<HTMLButtonElement>('[data-open-task-agent]')!.onclick = () => {
      const agent = this.options.agents().find(a => a.pane_id === this.draft.agent); if (agent) { this.close(false); this.options.onAgent(agent); }
    };
    form.onsubmit = e => {
      e.preventDefault(); if (!form.reportValidity() || !this.options.writable()) return;
      const text = this.draft.text.trim(); if (!text) { this.note('Describe the task first.'); return; }
      try {
        if (this.draft.project !== '__new' && !receptionProjects(this.options.state(), this.options.agents()).some(p => p.id === this.draft.project)) throw Error('That project is no longer available. Choose another project.');
        if (this.draft.agent === '__hire') {
          const project = this.draft.project === '__new' ? undefined : this.draft.project;
          const candidate = this.options.agents().find(a => projectKey(a) === project)?.workspace_id;
          const workspace = this.options.workspaces().find(w => w.workspace_id === candidate)?.workspace_id;
          const original = JSON.stringify(this.draft);
          this.options.onHire(text, project, workspace, () => {
            if (JSON.stringify(this.draft) === original) { this.draft.text = ''; this.saveDraft(); }
          });
        } else {
          const agent = taskAgents(this.options.agents(), this.draft.project).find(a => a.pane_id === this.draft.agent);
          if (!agent) { this.paintTaskAgents(); throw Error('That agent has left this project. Choose someone else.'); }
          this.options.onTask(agent, text);
          this.draft.text = ''; this.saveDraft();
        }
        this.close(false);
      } catch (error) { this.note((error as Error).message); }
    };
    this.paintTaskAgents();
  }
  private paintTaskAgents() {
    const select = this.content.querySelector<HTMLSelectElement>('[name="agent"]'); if (!select) return;
    const agents = taskAgents(this.options.agents(), this.draft.project);
    if (!this.draft.agent) this.draft.agent = agents[0]?.pane_id ?? '__hire';
    const unavailable = this.draft.agent !== '__hire' && !agents.some(a => a.pane_id === this.draft.agent);
    const unavailableProject = this.draft.project !== '__new' && !receptionProjects(this.options.state(), this.options.agents()).some(p => p.id === this.draft.project);
    const html = (unavailable ? `<option value="${esc(this.draft.agent)}" selected disabled>Agent unavailable · choose someone else</option>` : '') + agents.map(a => `<option value="${esc(a.pane_id)}"${a.pane_id === this.draft.agent ? ' selected' : ''}>${esc(employeeName(a))} · ${esc(a.agent_status)}</option>`).join('') + `<option value="__hire"${this.draft.agent === '__hire' ? ' selected' : ''}>Hire a new agent…</option>`;
    if (select.dataset.choices !== html) { select.innerHTML = html; select.dataset.choices = html; }
    this.content.querySelector<HTMLButtonElement>('[data-open-task-agent]')!.hidden = this.draft.agent === '__hire' || unavailable;
    const submit = this.content.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.disabled = !this.options.writable() || unavailable || unavailableProject; submit.textContent = this.draft.agent === '__hire' ? 'Choose new hire →' : 'Review task in chat →';
    this.content.querySelector('[data-task-hint]')!.textContent = !this.options.writable() ? 'Task assignment is unavailable in this read-only office.' : this.draft.agent === '__hire'
      ? 'Your task follows you to the hiring form.' : 'Opens their chat with the task ready to send or queue. Existing drafts stay safe.';
  }
  private entryCard(e: JournalEntry) {
    return `<button class="reception-card" data-entry="${esc(e.id)}"><span class="reception-card-title"><b>${esc(e.title)}</b>${e.kind === 'sale' ? `<strong>${esc(amount(e))}</strong>` : ''}</span>${e.notes ? `<span>${esc(snippet(e.notes))}</span>` : ''}<small>${esc(projectName(e.project))} · ${esc(when(e.at))}${e.url ? ' · Artifact attached' : ''}</small></button>`;
  }
  private startRecap() {
    const key = `${this.since}:${this.options.state()?.revision ?? 0}`;
    this.recapKey = key;
    if (this.recapCache?.key === key && Date.now() - this.recapCache.at < 30_000) { this.recap = this.recapCache.pages; this.paintRecap(); return; }
    this.recap = new Map(RECAP.map(([kind]) => [kind, { rows: [], total: 0, cursor: null, loading: true }]));
    this.paintRecap();
    for (const [kind] of RECAP) void this.loadRecap(kind);
  }
  private async loadRecap(kind: RecapKind, more = false) {
    const generation = this.generation, previous = this.recap.get(kind)!;
    if (more && (previous.loading || !previous.cursor)) return;
    previous.loading = true; previous.error = undefined; this.paintRecap();
    try {
      const page = await this.client.call('studio.journal', { kind, since: this.since, limit: 5, ...(more ? { cursor: previous.cursor } : {}) }, { signal: this.controller?.signal }) as JournalPage;
      if (generation !== this.generation) return;
      const rows = [...new Map([...(more ? previous.rows : []), ...page.entries].map(e => [e.id, e])).values()].sort((a, b) => b.at - a.at);
      this.recap.set(kind, { rows, total: page.total, cursor: page.cursor });
    } catch (error) { if (generation !== this.generation) return; previous.error = (error as Error).message; previous.loading = false; }
    if ([...this.recap.values()].every(p => !p.loading && !p.error)) this.recapCache = { key: this.recapKey, at: Date.now(), pages: this.recap };
    this.paintRecap();
  }
  private paintRecap() {
    this.content.innerHTML = `<h2>Here’s what happened.</h2><p class="reception-help">${this.firstVisit ? 'Your first visit · the last 24 hours' : `Since your last visit · ${esc(when(this.since))}`}. Includes archived memories.</p><div class="reception-totals" aria-label="Activity since your last visit">${RECAP.map(([kind, title]) => {
      const page = this.recap.get(kind)!;
      return `<button data-recap-jump="${kind}"><b>${page.loading && !page.rows.length ? '…' : page.error ? '—' : page.total}</b><span>${title}</span></button>`;
    }).join('')}</div>${RECAP.map(([kind, title]) => {
      const page = this.recap.get(kind)!;
      return `<section class="reception-results" data-recap-section="${kind}"><h3>${title}<span>${page.loading && !page.rows.length ? '…' : page.total}</span></h3>${page.rows.map(e => this.entryCard(e)).join('')}${page.error ? `<p class="reception-error">Couldn’t load ${title.toLowerCase()}. <button data-recap-retry="${kind}">Retry</button></p>` : page.loading ? '<p class="reception-help" role="status">Checking the journal…</p>' : !page.total ? '<p class="reception-empty">Nothing new here.</p>' : ''}${page.cursor ? `<button data-recap-more="${kind}"${page.loading ? ' disabled' : ''}>Show more ${title.toLowerCase()}</button>` : ''}</section>`;
    }).join('')}`;
  }
  private startSearch() {
    this.content.innerHTML = `<h2>Let’s find it.</h2><label class="reception-search">Search the studio<input type="search" maxlength="500" value="${esc(this.query)}" placeholder="Agent, project, memory, or idea…" autocomplete="off"></label><div data-search-results></div>`;
    const input = this.content.querySelector<HTMLInputElement>('input')!;
    input.oninput = () => {
      this.query = input.value; this.controller?.abort(); this.controller = new AbortController(); this.generation++; clearTimeout(this.searchTimer);
      this.resetSearch(); this.paintSearch();
      if (this.query.trim()) this.searchTimer = setTimeout(() => this.search(), 180);
    };
    this.resetSearch(); this.paintSearch();
    if (this.query.trim()) this.search();
  }
  private resetSearch() {
    this.memories = { rows: [], total: 0, cursor: null, loading: !!this.query.trim() };
    this.ideas = { rows: [], total: 0, cursor: null, loading: !!this.query.trim() };
  }
  private search() { void this.loadSearch('memories'); void this.loadSearch('ideas'); }
  private async loadSearch(source: 'memories' | 'ideas', more = false) {
    const generation = this.generation, previous = this[source], search = this.query.trim();
    if (!search || (more && (previous.loading || !previous.cursor))) return;
    previous.loading = true; previous.error = undefined; this.paintSearch();
    try {
      const params = { search, ...(source === 'memories' ? { limit: 15 } : {}), ...(more ? { cursor: previous.cursor } : {}) };
      const result = await this.client.call(source === 'memories' ? 'studio.journal' : 'agent.boss.archive', params, { signal: this.controller?.signal });
      if (generation !== this.generation) return;
      if (source === 'memories') {
        const page = result as JournalPage;
        this.memories = { rows: [...new Map([...(more ? this.memories.rows : []), ...page.entries].map(e => [e.id, e])).values()].sort((a, b) => b.at - a.at), total: page.total, cursor: page.cursor };
      } else {
        const page = result as BossArchivePage;
        this.ideas = { rows: [...new Map([...(more ? this.ideas.rows : []), ...page.briefings].map(b => [b.id, b])).values()], total: page.total, cursor: page.cursor };
      }
    } catch (error) { if (generation !== this.generation) return; previous.loading = false; previous.error = (error as Error).message; }
    this.paintSearch();
  }
  private paintSearch() {
    const host = this.content.querySelector<HTMLElement>('[data-search-results]'); if (!host) return;
    const query = this.query.trim();
    if (!query) { host.innerHTML = '<p class="reception-help">Search names, task descriptions, saved findings, and Boss’s archived ideas.</p>'; return; }
    const agents = findReceptionAgents(this.options.agents(), query), projects = receptionProjects(this.options.state(), this.options.agents()).filter(p => matchesReception(query, p.name, p.id, p.notes));
    const footer = (page: Page<unknown>, source: 'memories' | 'ideas') => page.error ? `<p class="reception-error">Couldn’t search ${source}. <button data-search-retry="${source}">Retry</button></p>`
      : `${page.loading ? '<p class="reception-help" role="status">Searching saved records…</p>' : !page.total ? '<p class="reception-empty">No matches.</p>' : ''}${page.cursor ? `<button data-search-more="${source}"${page.loading ? ' disabled' : ''}>Show more ${source}</button>` : ''}`;
    host.innerHTML = `<section class="reception-results"><h3>Agents<span>${agents.length}</span></h3>${agents.map(a => this.agentCard(a)).join('') || '<p class="reception-empty">No matches.</p>'}</section>
      <section class="reception-results"><h3>Projects<span>${projects.length}</span></h3>${projects.map(p => `<button class="reception-card" data-project="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc(p.id)}</small><span>${esc(snippet(p.notes))}</span></button>`).join('') || '<p class="reception-empty">No matches.</p>'}</section>
      <section class="reception-results"><h3>Memories<span>${this.memories.loading && !this.memories.rows.length ? '…' : this.memories.total}</span></h3>${this.memories.rows.map(e => this.entryCard(e)).join('')}${footer(this.memories, 'memories')}</section>
      <section class="reception-results"><h3>Boss’s ideas<span>${this.ideas.loading && !this.ideas.rows.length ? '…' : this.ideas.total} ${this.ideas.total === 1 ? 'briefing' : 'briefings'}</span></h3>${this.ideas.rows.map(b => b.ideas.map((idea, index) => matchesReception(query, b.intro, idea.title, idea.evidence, idea.why, idea.nextStep) ? `<button class="reception-card" data-idea="${esc(b.id)}" data-index="${index}"><b>${esc(idea.title)}</b><span>${esc(snippet(idea.why))}</span><small>${esc(when(b.at))} · Open saved idea →</small></button>` : '').join('')).join('')}${footer(this.ideas, 'ideas')}</section>`;
  }
}
