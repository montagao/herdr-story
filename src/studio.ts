import { recapMoney, type RecapMoney } from '../shared/recap-money';
import { janitorKey, JANITOR_WIDTH, JANITOR_HEIGHT } from './scenes/janitor-art';
import type { PaymentSummary } from './payment-details';
import { StudioDrafts, type StudioDraft } from './studio-drafts';
import { studioLane } from '../shared/studio-actions';
import { StudioSaves } from './studio-saves';
import { closeOnEscape } from './escape';
import { settings } from './settings';
import { agentKind, type AgentInfo } from '../shared/types';
import { studioIcon } from './icons';
import { renderMarkdown } from './markdown';
import { handleOf } from './feed/feed';
import { BOARD_COLORS, employeeName, goalProgress, projectKey, projectName, safeArtifactUrl, type Employee, type JournalEntry, type JournalPage, type JournalPageQuery, type Milestone, type ProjectBoard, type StudioState } from '../shared/studio';
import type { OfficeClient } from './net/office-client';
import type { OfficeScene } from './scenes/OfficeScene';
import { avatarCanvas } from './feed/avatar';
import { WORK, WORK_KINDS } from './work';
import { rankForLevel, tierForLevel } from './model/office';
import type { RoomItem } from '../shared/studio';
import { Sweep } from './sweep';
import { propName } from './decor';

type Page = 'boards' | 'people' | 'journal' | 'trophies' | 'room';
const PAGES: [Page, string][] = [['boards', 'Whiteboards'], ['people', 'Employees'], ['journal', 'Journal'], ['trophies', 'Trophies'], ['room', 'Room']];
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const selected = (yes: boolean) => yes ? ' selected' : '';
const checked = (yes: boolean) => yes ? ' checked' : '';
const date = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** How long a visible tab can sit untouched before it counts as "away" for the recap. */
const IDLE_MS = 5 * 60_000;
type RecapRange = 'look' | 'today' | '24h' | '7d' | '30d';
const RECAP_RANGES: { value: RecapRange; label: string; phrase: string }[] = [
  { value: 'look', label: 'Since you last looked', phrase: 'since you last looked' },
  { value: 'today', label: 'Today', phrase: 'today' },
  { value: '24h', label: '24 hours', phrase: 'in the last 24 hours' },
  { value: '7d', label: '7 days', phrase: 'this past week' },
  { value: '30d', label: '30 days', phrase: 'this past month' },
];
const recapStart = (range: RecapRange, look: number) => {
  const now = Date.now();
  if (range === 'look') return look || now - 864e5;
  if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return now - (range === '24h' ? 1 : range === '7d' ? 7 : 30) * 864e5;
};
const money = (amount: number, currency = 'usd', signed = false, code = false) => {
  const n = Math.abs(amount);
  let text: string; try { text = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), currencyDisplay: code ? 'code' : 'symbol', maximumFractionDigits: 2 }).format(n); } catch { text = `$${n.toFixed(2)}`; }
  return amount < 0 ? `−${text}` : signed ? `+${text}` : text;
};
/** Net money across entries, in one currency; mixed currencies are never added. */
const netMoney = (entries: JournalEntry[]) => {
  const sales = entries.filter(e => e.kind === 'sale' && typeof e.amount === 'number');
  const currencies = new Set(sales.map(e => e.currency || 'usd'));
  return sales.length && currencies.size === 1 ? { amount: sales.reduce((n, e) => n + e.amount!, 0), currency: [...currencies][0], count: sales.length } : sales.length ? { count: sales.length } : undefined;
};
const field = (label: string, input: string) => `<label class="studio-field"><span>${label}</span>${input}</label>`;
const artifact = (url: string) => safeArtifactUrl(url) ? `<a class="artifact-link" href="${esc(safeArtifactUrl(url))}" target="_blank" rel="noopener noreferrer">Open artifact ↗</a>` : '';

export class Studio {
  private sweep: Sweep;
  state?: StudioState;
  agents: AgentInfo[] = [];
  writable = false;
  onPayment?: (payment: PaymentSummary) => void;
  onTalk?: (a: AgentInfo) => void;
  beforeOpen?: () => void;
  private root = document.createElement('div');
  private dock = document.createElement('nav');
  private notice = document.createElement('div');
  private editBar = document.createElement('div');
  private recap = document.createElement('div');
  private page: Page = 'boards';
  private drafts = new StudioDrafts();
  private panels = new Map<Page, { node: HTMLElement; signature: string; scroll: number }>();
  private mountedPage?: Page;
  private roomStart = '';
  private markdownCache = new Map<string, string>();
  private entryBindings = new WeakSet<HTMLElement>();
  private peopleBindings = new WeakSet<HTMLElement>();
  private searchCache = new WeakMap<JournalEntry, { names: string; text: string }>();
  private rowMarkup = new WeakMap<Node, string>();
  private boardId = '';
  private personId = '';
  private journalProject = '';
  private journalKind = '';
  private journalArchive = false;
  private journalSearch = '';
  private journalLimit = 40;
  private history = new Map<string, JournalEntry>();
  private historyEpoch?: string;
  private historyVersions = new Map<string, number>();
  private historyCursor?: string | null;
  private historyQuery = '';
  private historyPageCursor?: string | null;
  private historyQueryLoaded = false;
  private historyMoney?: RecapMoney;
  private historyMoneyRevision = -1;
  private moneyCache = new Map<string, { money: RecapMoney; revision: number }>();
  private historyLoading = false;
  private historyError = false;
  private historyPaint?: () => void;
  private historyRequest = 0;
  private historySearchTimer?: number;

  private journalSince = 0;
  /** Recap mode: which window the journal is summarising, and where "since you last looked" is. */
  private recapRange: RecapRange = 'look';
  private recapLook = 0;
  /** The last time you looked at the recap or dismissed it: "since you last looked" starts here. */
  private recapSince = 0;
  /** The recap may show: set on load, on returning to the tab, or after a quiet spell. */
  private recapArmed = false;
  private lastInteraction = Date.now();
  private hiddenSince = 0;
  private ackKey = 'herdr-story:recap-seen';
  /** The older visibility stamp: still written when the tab hides, and read once to seed the baseline. */
  private seenKey = 'herdr-story:seen-at';
  private initialized = false;
  private busy = false;
  private changes = 0;
  private changeTails = new Map<string, Promise<unknown>>();
  private viewChanges = new Map<Element, number>();
  private saves: StudioSaves;
  private checkingSaves = false;
  private saveStatus = document.createElement('div');
  private changeView?: { content: Element; view: Element };
  private readDrafts = new Map<string, { entry: JournalEntry; readAt?: number }>();
  private returnFocus?: HTMLElement;
  private toastTimer?: number;
  private roomDraft?: { version: number; order: string[] };
  private roomSaving = false;

  constructor(private client: OfficeClient, private office: OfficeScene, options: { sweep?: boolean } = {}) {
    this.saves = new StudioSaves(client);
    this.saveStatus.id = 'studio-save-status'; this.saveStatus.hidden = true; this.saveStatus.setAttribute('role', 'status');
    document.body.append(this.saveStatus); this.saves.onChange = () => this.paintSaveStatus();
    this.sweep = new Sweep(client, {
      janitorPortrait: () => {
        const key = janitorKey('stand', 'se', 0);
        if (!this.office.textures?.exists(key)) return undefined;
        const canvas = document.createElement('canvas');
        canvas.width = JANITOR_WIDTH; canvas.height = JANITOR_HEIGHT;
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Gus the office janitor holding his broom');
        const context = canvas.getContext('2d')!; context.imageSmoothingEnabled = false;
        context.drawImage(this.office.textures.get(key).getSourceImage() as CanvasImageSource, 0, 0);
        return canvas;
      },
      writable: () => this.writable,
      beforeOpen: () => { this.close(); this.beforeOpen?.(); },
      onJournal: () => { this.journalSearch = 'Re-org'; this.open('journal'); },
      onTalk: paneId => { const agent = this.agents.find(a => a.pane_id === paneId); if (agent) this.onTalk?.(agent); },
      onDepartures: agents => this.office.showDepartures(agents),
    });
    // Capture the previous visit before visibility events or a slow initial snapshot can overwrite it.
    try { this.recapSince = Number(localStorage.getItem(this.ackKey)) || Number(localStorage.getItem(this.seenKey)) || 0; } catch {}
    settings.on(() => this.paintRecap());
    this.root.id = 'studio-panel'; this.root.hidden = true; this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-label', 'Studio'); this.root.setAttribute('data-block-office-input', '');
    this.saves.onConfirmed = item => {
      if (!item.draft) return;
      const forms = new Set<HTMLFormElement>(this.root.querySelectorAll('form.studio-editor'));
      for (const panel of this.panels.values()) panel.node.querySelectorAll<HTMLFormElement>('form.studio-editor').forEach(form => forms.add(form));
      this.drafts.confirmed(item.draft.key, item.draft.fingerprint, [...forms]);
    };
    this.drafts.onChange = () => this.paintDraftButton();
    addEventListener('pagehide', () => { this.captureDrafts(); this.drafts.flush(); });
    this.dock.id = 'studio-dock'; this.dock.setAttribute('aria-label', 'Studio controls');
    this.dock.innerHTML = `<button type="button" data-arrange-room disabled title="Arrange furniture" aria-label="Arrange furniture"><i aria-hidden="true">${studioIcon('room', 18)}</i><span>Arrange furniture</span></button>` + PAGES.map(([page, name]) => `<button type="button" data-page="${page}" title="${name}"><i aria-hidden="true">${studioIcon(page, 18)}</i><span>${name}</span></button>`).join('') + `<button type="button" data-recap-open title="What happened since you last looked"><i aria-hidden="true">${studioIcon('recap', 18)}</i><span>Recap</span></button><button type="button" data-fit title="Show the whole office; click again to restore your view" aria-label="Show whole office" aria-pressed="false"><i aria-hidden="true">${studioIcon('fit', 18)}</i><span>Whole office</span></button>`;
    this.office.onViewModeChange = wholeOffice => {
      const button = this.dock.querySelector<HTMLButtonElement>('[data-fit]')!;
      button.setAttribute('aria-pressed', String(wholeOffice));
      button.setAttribute('aria-label', wholeOffice ? 'Restore previous view' : 'Show whole office');
      button.title = wholeOffice ? 'Restore your previous zoom and position' : 'Show the whole office; click again to restore your view';
      button.querySelector('span')!.textContent = wholeOffice ? 'Zoom back' : 'Whole office';
    };
    this.office.onViewModeChange(this.office.wholeOfficeView);
    const sweepButton = document.createElement('button');
    sweepButton.type = 'button'; sweepButton.dataset.sweep = '';
    sweepButton.title = 'Review long-idle agents and save their findings before closing them';
    sweepButton.innerHTML = `<i aria-hidden="true">${studioIcon('sweep', 18)}</i><span>Re-org</span>`;
    if (options.sweep !== false) this.dock.insertBefore(sweepButton, this.dock.querySelector('[data-fit]'));
    this.notice.id = 'studio-toast'; this.notice.hidden = true; this.notice.setAttribute('role', 'status');
    this.editBar.id = 'room-edit-bar'; this.editBar.hidden = true; this.editBar.setAttribute('role', 'region'); this.editBar.setAttribute('aria-label', 'Arrange furniture');
    this.recap.id = 'studio-recap'; this.recap.hidden = true;
    document.getElementById('game')?.append(this.dock, this.recap, this.editBar);
    document.body.append(this.root, this.notice);
    this.dock.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (button?.hasAttribute('data-drafts')) this.openDrafts();
      else if (button?.hasAttribute('data-arrange-room')) this.arrangeRoom();
      else if (button?.dataset.page) this.open(button.dataset.page as Page);
      else if (button?.hasAttribute('data-fit')) this.office.toggleOfficeView();
      else if (button?.hasAttribute('data-sweep')) this.sweep.open();
      else if (button?.hasAttribute('data-recap-open')) this.openRecap();
    });
    this.root.addEventListener('click', event => { if (event.target === this.root) this.close(); });
    closeOnEscape(this.root, () => { if (!this.closeMenus(true)) this.close(); });
    for (const type of ['pointerdown', 'focusin'] as const) this.root.addEventListener(type, event => { if (!(event.target as HTMLElement).closest?.('.studio-menu')) this.closeMenus(); }, { capture: true });
    this.root.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...this.root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    this.office.furnishings.onOpen = (page, project) => this.open(page, project);
    this.office.furnishings.onSelection = () => this.paintEditBar();
    this.office.furnishings.onChange = () => this.paintEditBar();
    this.office.onSwapProjects = (a, b) => { if (!this.roomDraft) return; const order = this.roomDraft.order; const x = order.indexOf(a), y = order.indexOf(b); if (x < 0 || y < 0) return; [order[x], order[y]] = [order[y], order[x]]; this.office.previewProjectOrder(order); this.paintEditBar(); this.toast('Project areas swapped. Save layout to keep them.'); };
    const remember = (at: number) => { try { localStorage.setItem(this.seenKey, String(at)); } catch {} };
    const leave = () => {
      // visibilitychange normally precedes pagehide. Closing a background tab must not
      // mark all the work recorded since it was hidden as already seen.
      if (this.hiddenSince) return;
      this.hiddenSince = Date.now();
      if (this.initialized) remember(this.hiddenSince);
    };
    const arrive = () => {
      if (document.hidden || !this.hiddenSince) return;
      this.hiddenSince = 0;
      this.lastInteraction = Date.now();
      if (this.initialized) { this.recapArmed = true; this.paintRecap(); }
    };
    // A tab left open but untouched is away too: after a quiet spell the recap may surface.
    const touched = () => { this.lastInteraction = Date.now(); };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, touched, { passive: true, capture: true });
    addEventListener('pagehide', leave);
    addEventListener('pageshow', arrive); // Returning through the browser's back/forward cache.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) leave();
      else arrive();
    });
    window.setInterval(() => {
      if (!this.initialized || document.hidden || this.recapArmed || Date.now() - this.lastInteraction < IDLE_MS) return;
      this.recapArmed = true; this.paintRecap();
    }, 30_000);
  }
  get isOpen() { return !this.root.hidden; }
  get sweepOpen() { return this.sweep.isOpen || this.sweep.isWalking; }
  openReorg() { this.sweep.open(); }
  sync(state: StudioState | undefined, agents: AgentInfo[], writable: boolean) {
    this.agents = agents; this.writable = writable;
    this.dock.querySelector<HTMLButtonElement>('[data-arrange-room]')!.disabled = !writable || !state;
    this.paintSaveStatus(); this.paintDraftButton();
    if (!state || (this.state && state.revision < this.state.revision)) return;
    const changed = !this.state || state.revision !== this.state.revision;
    this.acceptState(state);
    if (!this.initialized) {
      this.initialized = true;
      this.importLegacy();
      // a first visit has nothing to look back on; every later load may
      if (this.recapSince) this.recapArmed = true; else this.acknowledgeRecap(false);
    }
    this.paintRecap();
    // Never replace a draft or a focused filter when live work arrives.
    const focused = document.activeElement;
    if (changed && !this.busy && this.isOpen && !this.root.querySelector('.studio-editor')
      && !(focused instanceof HTMLElement && this.root.contains(focused))) this.render();
  }
  /** Compact snapshots replace their current entries while retaining pages the user opened.
   * Retired ids prevent an old page from bringing deleted memories back; epochs handle restarts. */
  private acceptState(state: StudioState) {
    if (state.journalEpoch && this.historyEpoch !== state.journalEpoch) {
      this.history.clear(); this.historyVersions.clear(); this.historyCursor = undefined; this.historyQuery = ''; this.historyRequest++; this.moneyCache.clear(); this.historyMoney = undefined; this.historyMoneyRevision = -1;
      this.historyLoading = false;
    }
    if (state.journalEpoch) this.historyEpoch = state.journalEpoch;
    if (state.journalTotal === undefined) { this.history.clear(); this.historyVersions.clear(); } // complete snapshot is authoritative
    for (const id of state.journalRetired ?? []) { this.history.delete(id); this.historyVersions.delete(id); }
    const refresh: string[] = [];
    for (const [id, revision] of Object.entries(state.journalInvalidated ?? {})) {
      if (this.history.has(id) && (this.historyVersions.get(id) ?? -1) < revision && !state.journal.some(entry => entry.id === id)) {
        this.history.delete(id); refresh.push(id);
      }
    }
    for (const entry of state.journal) { this.history.set(entry.id, entry); this.historyVersions.set(entry.id, state.revision); }
    if (this.historyCursor === undefined) this.historyCursor = state.journalCursor;
    this.state = { ...state, journal: [...this.history.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) };
    const refreshNow = refresh.filter(id => !this.readDrafts.has(id));
    if (refreshNow.length) void this.refreshHistory(refreshNow);
  }
  private mergeHistory(page: JournalPage) {
    if (!this.state || (this.historyEpoch && page.epoch !== this.historyEpoch)) return;
    const retired = new Set(this.state.journalRetired ?? []);
    for (const entry of page.entries) if (!retired.has(entry.id) && (this.state.journalInvalidated?.[entry.id] ?? 0) <= page.revision) {
      this.history.set(entry.id, entry); this.historyVersions.set(entry.id, page.revision);
    }
    this.state = { ...this.state, journal: [...this.history.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) };
  }
  private async refreshHistory(ids: string[], paint = true) {
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const page = await this.client.call('studio.journal', { ids: ids.slice(i, i + 200), limit: 200 }) as JournalPage;
        this.mergeHistory(page);
      }
      if (paint && this.isOpen && !this.root.querySelector('.studio-editor') && !this.root.contains(document.activeElement)) this.render();
    } catch (error) { this.toast(`Could not refresh changed history: ${(error as Error).message}`); }
  }
  private async loadHistory(query: JournalPageQuery, paint: () => void) {
    clearTimeout(this.historySearchTimer); this.historySearchTimer = undefined;
    // A cleared search may have queued a read before a manual page click finished. Never
    // reuse a null (exhausted) cursor: the server correctly treats it as a fresh first page.
    if (!this.state || this.historyLoading || this.historyPageCursor === null
      || (!query.moneySummary && (this.state.journalTotal ?? this.state.journal.length) <= this.state.journal.length)) return;
    this.historyLoading = true; this.historyError = false;
    const request = ++this.historyRequest, queryKey = this.historyQuery;
    paint();
    try {
      const page = await this.client.call('studio.journal', { ...query, cursor: this.historyPageCursor, limit: 100 }) as JournalPage;
      if (request !== this.historyRequest || (this.historyEpoch && page.epoch !== this.historyEpoch)
        || !this.state) return;
      this.mergeHistory(page);
      this.historyPageCursor = page.cursor; this.historyQueryLoaded = true;
      if (page.money) {
        this.historyMoney = page.money; this.historyMoneyRevision = page.revision;
        this.moneyCache.delete(queryKey); this.moneyCache.set(queryKey, { money: page.money, revision: page.revision });
        if (this.moneyCache.size > 20) this.moneyCache.delete(this.moneyCache.keys().next().value!);
      }
      if (!query.search && !query.project && !query.kind && !query.since && !query.trophies) this.historyCursor = page.cursor;
      this.journalLimit += 100;
    } catch (error) {
      if (request === this.historyRequest) {
        this.historyError = true;
        this.toast(`Could not load studio history: ${(error as Error).message}`);
      }
    } finally {
      // Live studio updates can rebuild this panel while the request is in flight.
      // Paint the current view, rather than the detached node that started the request.
      if (request === this.historyRequest) { this.historyLoading = false; (this.historyPaint ?? paint)(); }
    }
  }
  private importLegacy() {
    if (!this.writable) return;
    try {
      const counts = new Map<string, number>(JSON.parse(localStorage.getItem('herdr-story:shipped') || '[]'));
      const stats = new Map<string, unknown>(JSON.parse(localStorage.getItem('herdr-story:stats') || '[]'));
      const rows = this.agents.filter(a => (counts.get(a.pane_id) ?? 0) > 0).map(a => ({ pane: a.pane_id, shipped: counts.get(a.pane_id), stats: stats.get(a.pane_id) }));
      if (rows.length) void this.client.call('studio.change', { op: 'legacy.import', rows }).catch(error => this.toast(error.message));
    } catch { /* An invalid old browser save must not interrupt the durable studio. */ }
  }
  private recapEntries() { return this.state?.journal.filter(e => !e.readAt && this.recapSince && e.at > this.recapSince) ?? []; }
  private paintRecap() {
    const entries = this.recapEntries();
    this.recap.hidden = !entries.length || !this.recapArmed || !!this.roomDraft || !settings.value.recap;
    if (this.recap.hidden) return;
    const partial = (this.state?.journalTotal ?? 0) > (this.state?.journal.length ?? 0) && entries.length === this.state?.journal.length;
    const made = partial ? undefined : netMoney(entries);
    const counts = { sale: 0, task: 0, trophy: 0, note: 0 };
    for (const e of entries) counts[e.kind === 'milestone' || e.kind === 'release' ? 'trophy' : e.kind === 'sale' ? 'sale' : e.kind === 'task' ? 'task' : 'note']++;
    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const breakdown = [counts.sale && plural(counts.sale, 'payment'), counts.task && plural(counts.task, 'task'), counts.trophy && plural(counts.trophy, 'trophy', 'trophies'), counts.note && plural(counts.note, 'note')].filter(Boolean).join(', ');
    const since = new Date(this.recapSince);
    const when = Date.now() - this.recapSince > 20 * 3600e3 ? since.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : since.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    this.recap.innerHTML = `<button type="button" data-recap><span>WHILE YOU WERE AWAY · SINCE ${esc(when)}</span><b>${made?.amount ? `You made ${money(made.amount, made.currency)} · ` : ''}${entries.length}${partial ? '+' : ''} new ${entries.length === 1 ? 'memory' : 'memories'}${breakdown ? ` <small>${esc(breakdown)}</small>` : ''} <i>↗</i></b></button><button type="button" data-dismiss aria-label="Dismiss recap">×</button>`;
    this.recap.querySelector('[data-recap]')?.addEventListener('click', () => this.openRecap());
    this.recap.querySelector('[data-dismiss]')?.addEventListener('click', () => this.acknowledgeRecap());
  }
  /** Looking counts as caught up: the baseline moves to now and the card goes. */
  private acknowledgeRecap(paint = true) {
    this.recapSince = Date.now(); this.recapArmed = false;
    try { localStorage.setItem(this.ackKey, String(this.recapSince)); } catch { /* private mode */ }
    if (paint) this.paintRecap();
  }
  /** The journal from the last look on, whether or not the card is showing; the dock's Recap
   *  button and the card itself both land here. */
  openRecap() {
    const since = this.recapSince, entries = this.recapEntries();
    this.recapLook = since; this.recapRange = 'look';
    this.journalArchive = false; this.journalSince = recapStart('look', since); this.open('journal');
    if (!entries.length) this.toast(`Nothing new since ${new Date(since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`);
    this.acknowledgeRecap();
  }
  async openJournalEntry(id: string) {
    if (!this.state?.journal.some(entry => entry.id === id)) {
      try {
        this.mergeHistory(await this.client.call('studio.journal', { ids: [id], limit: 1 }) as JournalPage);
      } catch (error) { this.toast(`Could not load this memory: ${(error as Error).message}`); return; }
    }
    if (!this.state?.journal.some(entry => entry.id === id)) { this.toast('This journal entry is no longer available.'); return; }
    this.journalProject = ''; this.journalKind = ''; this.journalSearch = ''; this.journalSince = 0;
    this.journalArchive = !!this.state.journal.find(entry => entry.id === id)?.readAt;
    const ordered = [...this.state.journal].sort((a, b) => b.at - a.at);
    this.journalLimit = Math.max(40, ordered.findIndex(entry => entry.id === id) + 1);
    this.open('journal');
    const row = this.root.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`)?.closest<HTMLElement>('article');
    if (row) {
      row.querySelector<HTMLButtonElement>('[data-more-notes]')?.click();
      row.tabIndex = -1;
      row.classList.add('journal-highlight');
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'center' });
    }
  }
  open(page: Page, id?: string) {
    this.sweep.close();
    this.beforeOpen?.();
    if (!this.isOpen) this.returnFocus = document.activeElement as HTMLElement;
    this.page = page;
    if (page === 'boards' && id) this.boardId = id;
    if (page === 'people' && id) this.personId = id;
    this.root.hidden = false; this.render(false);
    // Focus lands on the window itself: Escape and the tab trap work at once, without a ring on ×.
    this.root.querySelector<HTMLElement>('.studio-window')?.focus({ preventScroll: true });
  }
  close() { this.captureDrafts(); this.cachePanel(); this.root.hidden = true; this.root.innerHTML = ''; this.returnFocus?.focus({ preventScroll: true }); }
  toast(message: string, undo?: () => void | Promise<void>) {
    this.notice.textContent = message; this.notice.hidden = false; this.notice.classList.toggle('has-action', !!undo);
    if (undo) { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Undo'; button.dataset.undo = ''; button.addEventListener('click', () => { button.disabled = true; void Promise.resolve(undo()).catch(error => this.toast((error as Error).message)); }); this.notice.append(button); }
    clearTimeout(this.toastTimer); this.toastTimer = window.setTimeout(() => { this.notice.hidden = true; }, 6500);
  }
  private change(input: Record<string, unknown> | (() => Record<string, unknown>), after?: () => void, options: { quiet?: boolean; lane?: string } = {}): Promise<boolean> {
    if (!this.writable) { this.toast('This studio is read-only.'); return Promise.resolve(false); }
    let lane: string;
    try { lane = options.lane ?? studioLane(typeof input === 'function' ? input() : input); } catch (error) { this.toast((error as Error).message); return Promise.resolve(false); }
    const content = this.root.querySelector('.studio-content'), view = content?.firstElementChild;
    if (view) this.viewChanges.set(view, (this.viewChanges.get(view) ?? 0) + 1);
    const active = document.activeElement;
    const button = active instanceof HTMLButtonElement && this.root.contains(active) ? active : undefined;
    const submit = this.root.querySelector<HTMLButtonElement>('button[type="submit"]');
    const form = active instanceof HTMLElement ? active.closest<HTMLFormElement>('form.studio-editor') : null;
    const submitted = form ? JSON.stringify(this.drafts.snapshot(form)) : '';
    const receipt = form ? this.drafts.receipt(form) : undefined;
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    if (submit) submit.disabled = true;
    this.changes++; this.busy = true; this.root.setAttribute('aria-busy', 'true');
    // Keep every click. Factories read the newest version after earlier edits have committed.
    const run = (this.changeTails.get(lane) ?? Promise.resolve()).then(async () => {
      let ok = false;
      try {
        const params = typeof input === 'function' ? input() : input;
        const state = await this.saves.save(params, lane, receipt);
        if (!this.state || state.revision > this.state.revision) this.acceptState(state);
        if (!this.office.model.studio || state.revision > this.office.model.studio.revision) this.office.model.setStudio(state);
        if (form) this.drafts.saved(form, submitted);
        after?.(); ok = true;
        if (!options.quiet) this.toast(params.op === 'room.save' ? 'Office layout saved.' : 'Saved to your studio.');
      } catch (error) {
        const message = (error as Error).message;
        const note = content?.isConnected && content.firstElementChild === view ? this.root.querySelector<HTMLElement>('.studio-form-note') : undefined;
        if (note) { note.textContent = message; note.setAttribute('role', 'alert'); }
        this.toast(message);
      } finally {
        this.changes--; this.busy = this.changes > 0;
        if (view) { const left = (this.viewChanges.get(view) ?? 1) - 1; if (left) this.viewChanges.set(view, left); else this.viewChanges.delete(view); }
        if (!this.busy) this.root.removeAttribute('aria-busy');
        if (button?.isConnected) { button.disabled = !this.writable; button.textContent = label ?? ''; }
        if (submit?.isConnected) submit.disabled = !this.writable;
        // Do not reset filters, scroll, or a new editor opened while the request was pending.
        if ((ok || typeof input === 'function') && !after && view && content?.isConnected && content.firstElementChild === view) this.changeView = { content, view };
        if (this.changeView && !this.viewChanges.has(this.changeView.view)) {
          const refresh = this.changeView; this.changeView = undefined;
          if (this.isOpen && refresh.content.isConnected && refresh.content.firstElementChild === refresh.view) {
            const scroll = refresh.content.scrollTop;
            this.render(); this.root.querySelector('.studio-content')!.scrollTop = scroll;
          }
        }
      }
      return ok;
    });
    const tail = run.catch(() => {}); this.changeTails.set(lane, tail);
    void tail.then(() => { if (this.changeTails.get(lane) === tail) this.changeTails.delete(lane); });
    return run;
  }
  private paintSaveStatus() {
    const pending = [...this.saves.pending.values()], delayed = pending.some(item => item.state !== 'saving');
    this.saveStatus.hidden = !this.writable || !delayed;
    if (this.saveStatus.hidden) return;
    const uncertain = pending.some(item => item.state === 'uncertain');
    this.saveStatus.innerHTML = `<span>${uncertain ? 'An edit needs confirmation. Your changes are kept.' : this.client.connected ? 'Saving is taking longer than usual… You can keep working.' : 'Connection interrupted. Your changes are kept.'}</span>${uncertain ? '<button type="button" data-check-saves>Check saves</button><button type="button" data-retry-saves>Retry saved edits</button>' : ''}`;
    this.saveStatus.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = this.checkingSaves; });
    const check = async (retry: boolean) => {
      if (this.checkingSaves) return;
      this.checkingSaves = true;
      this.saveStatus.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
      try {
        for (const item of [...this.saves.pending.values()]) {
          const state = await this.saves.check(item, retry);
          if (state && (!this.state || state.revision > this.state.revision)) { this.acceptState(state); this.office.model.setStudio(state); }
        }
        this.toast(this.saves.pending.size ? 'Checked saved edits. Other saves are still pending.' : 'Saved edits confirmed.');
        if (this.isOpen && !this.root.querySelector('.studio-editor')) this.render();
      } catch (error) { this.toast((error as Error).message); }
      finally { this.checkingSaves = false; this.paintSaveStatus(); }
    };
    this.saveStatus.querySelector('[data-check-saves]')?.addEventListener('click', () => void check(false));
    this.saveStatus.querySelector('[data-retry-saves]')?.addEventListener('click', () => void check(true));
  }
  private captureDrafts() {
    const forms = new Set<HTMLFormElement>(this.root.querySelectorAll('form.studio-editor'));
    forms.forEach(form => this.drafts.capture(form)); this.captureRoomDraft();
  }
  private captureRoomDraft() {
    if (!this.roomDraft || this.roomSaving) return;
    const items = this.office.furnishings.savedItems(), order = [...this.roomDraft.order];
    if (JSON.stringify([items, order]) === this.roomStart) return;
    this.drafts.put({ key: 'room', context: { kind: 'room', version: this.roomDraft.version, title: 'Office arrangement' }, at: Date.now(), room: { items, order } });
  }
  private paintDraftButton() {
    let button = this.dock.querySelector<HTMLButtonElement>('[data-drafts]');
    if (!button) { button = document.createElement('button'); button.type = 'button'; button.dataset.drafts = ''; this.dock.append(button); }
    button.hidden = !this.drafts.records.size; button.textContent = `Drafts · ${this.drafts.records.size}`;
  }
  private openDrafts() {
    this.captureDrafts(); this.open('journal');
    const content = this.root.querySelector<HTMLElement>('.studio-content')!;
    content.dataset.signature = 'drafts';
    content.innerHTML = `<div class="journal-heading"><div><small>KEPT ON THIS DEVICE</small><h2>Your unfinished edits.</h2><p>Resume a draft to review it before saving.</p></div></div>${[...this.drafts.records.values()].map(draft => `<article class="studio-draft-row"><div><b>${esc(draft.context.title)}</b><small>${esc(date(draft.at))}</small></div><button data-resume-draft="${esc(draft.key)}">Resume</button><button data-discard-draft="${esc(draft.key)}">Discard</button></article>`).join('') || '<p>No unfinished edits.</p>'}`;
    content.querySelectorAll<HTMLElement>('[data-resume-draft]').forEach(button => button.addEventListener('click', () => { const draft = this.drafts.records.get(button.dataset.resumeDraft!); if (draft) void this.resumeDraft(draft).catch(error => this.toast((error as Error).message)); }));
    content.querySelectorAll<HTMLElement>('[data-discard-draft]').forEach(button => button.addEventListener('click', () => { this.drafts.remove(button.dataset.discardDraft!); this.panels.clear(); this.openDrafts(); }));
  }
  private async resumeDraft(draft: StudioDraft) {
    if (!this.writable || !this.state) return;
    const context = draft.context;
    if (context.kind === 'room' && draft.room) {
      const room = structuredClone(draft.room);
      this.arrangeRoom();
      const known = new Set(this.state.projects.map(project => project.id));
      this.roomDraft!.order = [...room.order.filter(id => known.delete(id)), ...known];
      this.office.previewProjectOrder(this.roomDraft!.order);
      this.office.furnishings.restoreDraft(room.items as RoomItem[]); this.paintEditBar();
      this.toast('Arrangement restored for review. Save layout when ready.'); return;
    }
    if (context.kind === 'entry' && context.id && !this.state.journal.some(entry => entry.id === context.id)) await this.refreshHistory([context.id], false);
    const project = this.state.projects.find(project => project.id === (context.project ?? context.id));
    const entry = this.state.journal.find(entry => entry.id === context.id);
    const person = this.state.employees.find(person => person.id === context.id);
    if ((context.kind === 'project' || context.kind === 'goal') && !project || context.kind === 'employee' && !person || context.kind === 'entry' && context.id && !entry) throw new Error('This item was removed. The draft is still kept on this device.');
    const page = context.kind === 'employee' ? 'people' : context.kind === 'entry' ? 'journal' : 'boards';
    this.panels.delete(page); this.open(page, context.kind === 'employee' ? context.id : project?.id);
    const content = this.root.querySelector<HTMLElement>('.studio-content')!;
    if (context.kind === 'project') this.editBoard(content, project!);
    if (context.kind === 'goal') {
      const goal = project!.goals.find(goal => goal.id === context.id);
      if (context.id && !goal) throw new Error('This milestone was removed. Its draft is still kept.');
      this.editGoal(content, project!, goal);
    }
    if (context.kind === 'entry') this.editEntry(content, entry, context.release);
  }
  private panelSignature(page: Page, contextOnly = false) {
    const state = this.state;
    const filters = page === 'boards' ? [this.boardId] : page === 'people' ? [this.personId] : page === 'room' ? [this.roomDraft?.order] : [this.journalProject, this.journalKind, this.journalArchive, this.journalSearch, this.journalSince, this.readDrafts.size];
    const people = state?.employees.map(person => [person.id, person.version]);
    const projects = state?.projects.map(project => [project.id, project.version]);
    const revision = contextOnly ? null : page === 'boards' ? [projects, people] : page === 'people' ? [people, state?.revision] : page === 'room' ? [state?.room.version, projects] : state?.revision;
    return JSON.stringify([page, this.writable, revision, ...filters]);
  }
  private cachePanel() {
    const node = this.root.querySelector<HTMLElement>('.studio-content');
    if (!node || !this.mountedPage) return;
    this.captureDrafts();
    this.panels.set(this.mountedPage, { node, signature: node.dataset.signature ?? '', scroll: node.scrollTop });
    node.remove();
  }
  private render(force = true) {
    const samePage = this.mountedPage === this.page;
    this.cachePanel();
    const cached = this.panels.get(this.page), signature = this.panelSignature(this.page);
    const form = cached?.node.querySelector<HTMLFormElement>('form.studio-editor');
    const reuse = !force && cached && cached.node.dataset.historyPending !== 'true' && (cached.signature === signature || (form && this.drafts.dirty(form) && cached.node.dataset.context === this.panelSignature(this.page, true)));
    this.mountedPage = this.page;
    const title = PAGES.find(([key]) => key === this.page)?.[1] ?? 'Studio';
    this.root.innerHTML = `<div class="studio-window" tabindex="-1"><header class="studio-header"><span class="studio-mark" aria-hidden="true">${studioIcon(this.page, 18)}</span><b>${title}</b><small>${!this.state ? 'connecting…' : this.writable ? '' : 'read only'}</small><button type="button" data-close aria-label="Close studio">×</button></header>
      <nav class="studio-tabs" aria-label="Studio pages">${PAGES.map(([key, name]) => `<button type="button" data-tab="${key}" aria-current="${key === this.page ? 'page' : 'false'}"><i aria-hidden="true">${studioIcon(key)}</i><span>${name}</span></button>`).join('')}</nav>
      <div class="studio-content"></div></div>`;
    this.root.querySelector('[data-close]')?.addEventListener('click', () => this.close());
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.addEventListener('click', () => { this.page = button.dataset.tab as Page; this.render(false); }));
    const content = this.root.querySelector<HTMLElement>('.studio-content')!;
    if (reuse) { content.replaceWith(cached.node); cached.node.scrollTop = cached.scroll; return; }
    if (!samePage) { this.historyRequest++; this.historyLoading = false; }
    content.dataset.signature = signature;
    if (!this.state) { content.innerHTML = '<div class="studio-empty"><b>Connecting to your studio…</b><p>The office will appear when the local bridge is ready.</p></div>'; return; }
    if (this.page === 'boards') this.boards(content);
    else if (this.page === 'people') this.people(content);
    else if (this.page === 'room') this.room(content);
    else this.journal(content);
    content.dataset.signature = this.panelSignature(this.page);
    content.dataset.context = this.panelSignature(this.page, true);
    this.paintAvatars();
  }
  private paintAvatars() {
    this.root.querySelectorAll<HTMLElement>('[data-portrait]').forEach(el => { const person = this.state?.employees.find(p => p.id === el.dataset.portrait); if (person) { const key = JSON.stringify([person.id, person.face, person.body, el.dataset.size]); if (el.dataset.appearance !== key) { el.replaceChildren(avatarCanvas(person.id, Number(el.dataset.size) || 30, person)); el.dataset.appearance = key; } } });
  }
  /** The roster's handle for an employee at a desk, or nothing once its session is gone. */
  private handle(id: string) { const a = this.agents.find(a => a.employee_id === id); return a ? handleOf(agentKind(a), a.pane_id) : ''; }
  /** Two employees called Claude look identical, so a shared name carries its handle. */
  private tag(p: Employee) { return this.state!.employees.filter(e => e.name === p.name).length > 1 ? this.handle(p.id) || `${p.kind} · ${p.id.slice(0, 4)}` : ''; }
  private chips(ids: string[]) { return ids.map(id => { const p = this.state?.employees.find(e => e.id === id); if (!p) return ''; const tag = this.tag(p); return `<button type="button" class="person-chip" data-person="${esc(id)}"><span data-portrait="${esc(id)}"></span>${esc(p.name)}${tag ? `<small>${esc(tag)}</small>` : ''}</button>`; }).join(''); }
  private bindPeople() { this.root.querySelectorAll<HTMLElement>('[data-person]').forEach(el => { if (this.peopleBindings.has(el)) return; this.peopleBindings.add(el); el.addEventListener('click', () => this.open('people', el.dataset.person)); }); }
  /** A drop-down the office draws itself: the operating system's select popup never matches the
   *  window it opens from. Renders a trigger and a listbox; bindMenus wires them after innerHTML. */
  private menu(name: string, label: string, value: string, options: { value: string; label: string; color?: string }[], cls = '') {
    const current = options.find(o => o.value === value) ?? options[0];
    const swatch = (o?: { color?: string }) => o?.color ? `<span class="project-swatch" style="background:${esc(o.color)}" aria-hidden="true"></span>` : '';
    return `<div class="studio-menu ${cls}" data-menu="${esc(name)}" data-value="${esc(current?.value ?? '')}"><button type="button" class="studio-menu-button" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}">${swatch(current)}<span>${esc(current?.label ?? '')}</span></button><div class="studio-menu-list" role="listbox" aria-label="${esc(label)}" hidden>${options.map(o => `<button type="button" role="option" tabindex="-1" aria-selected="${o.value === current?.value}" data-option="${esc(o.value)}">${swatch(o)}<span>${esc(o.label)}</span></button>`).join('')}</div></div>`;
  }
  private bindMenus(scope: HTMLElement, onPick: Record<string, (value: string) => void>) {
    scope.querySelectorAll<HTMLElement>('[data-menu]').forEach(host => {
      const button = host.querySelector<HTMLButtonElement>('.studio-menu-button')!, list = host.querySelector<HTMLElement>('.studio-menu-list')!;
      const items = [...list.querySelectorAll<HTMLButtonElement>('[data-option]')];
      const open = () => { this.closeMenus(); list.hidden = false; button.setAttribute('aria-expanded', 'true'); (items.find(i => i.dataset.option === host.dataset.value) ?? items[0])?.focus(); };
      const close = (refocus = false) => { list.hidden = true; button.setAttribute('aria-expanded', 'false'); if (refocus) button.focus(); };
      button.addEventListener('click', () => list.hidden ? open() : close());
      button.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } });
      list.addEventListener('keydown', event => {
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        let next: number | undefined;
        if (event.key === 'ArrowDown') next = (index + 1) % items.length;
        if (event.key === 'ArrowUp') next = (index + items.length - 1) % items.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = items.length - 1;
        if (next !== undefined) { event.preventDefault(); items[next].focus(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        if (event.key === 'Tab') close();
      });
      for (const item of items) item.addEventListener('click', () => {
        const value = item.dataset.option!; close(true); if (value === host.dataset.value) return;
        host.dataset.value = value; for (const i of items) i.setAttribute('aria-selected', String(i === item));
        button.replaceChildren(...[...item.childNodes].map(node => node.cloneNode(true)));
        onPick[host.dataset.menu!]?.(value);
      });
    });
  }
  private closeMenus(refocus = false) {
    const lists = [...this.root.querySelectorAll<HTMLElement>('.studio-menu-list:not([hidden])')];
    for (const list of lists) {
      list.hidden = true;
      const button = list.parentElement?.querySelector<HTMLButtonElement>('.studio-menu-button');
      button?.setAttribute('aria-expanded', 'false');
      if (refocus) button?.focus({ preventScroll: true });
    }
    return lists.length > 0;
  }
  private projectMenu(name: string, label: string, value: string, all?: string, cls = '') {
    return this.menu(name, label, value, [...(all ? [{ value: '', label: all }] : []), ...this.state!.projects.map(p => ({ value: p.id, label: p.name, color: p.color }))], cls);
  }
  private projectOptions(value: string, all = false) { return (all ? `<option value="">All projects</option>` : '') + this.state!.projects.map(p => `<option value="${esc(p.id)}"${selected(p.id === value)}>${esc(p.name)}</option>`).join(''); }
  private contributors(ids: string[]) {
    return `<fieldset class="contributor-picker"><legend>Contributing employees</legend>${this.state!.employees.map(p => `<label><input type="checkbox" name="contributor" value="${esc(p.id)}"${checked(ids.includes(p.id))}><span data-portrait="${esc(p.id)}"></span><span>${esc(p.name)}<small>${esc(this.handle(p.id) || p.kind)}</small></span></label>`).join('') || '<p>Employees will appear when an agent joins the office.</p>'}</fieldset>`;
  }
  private picked(form: HTMLFormElement) { return [...form.querySelectorAll<HTMLInputElement>('[name="contributor"]:checked')].map(el => el.value); }
  private editor(content: HTMLElement, title: string, body: string, onSave: (form: HTMLFormElement) => void) {
    content.innerHTML = `<div class="editor-heading"><button type="button" data-back>← Back</button><h2>${esc(title)}</h2></div><form class="studio-editor"><fieldset class="editor-fields"${this.writable ? '' : ' disabled'}>${body}<div class="studio-form-actions"><button type="submit" class="primary">Save changes</button><button type="button" data-cancel>Cancel</button></div></fieldset><p class="studio-form-note" aria-live="polite"></p></form>`;
    content.querySelector('[data-back]')?.addEventListener('click', () => { this.drafts.capture(form); this.render(); });
    content.querySelector('[data-cancel]')?.addEventListener('click', () => { this.drafts.discard(form); this.render(); });
    const form = content.querySelector<HTMLFormElement>('form')!;
    form.addEventListener('submit', event => { event.preventDefault(); onSave(form); });
    this.paintAvatars();
    form.querySelector<HTMLElement>('input:not([type="hidden"]), textarea')?.focus();
    return form;
  }
  private removeButton(container: HTMLElement, label: string, run: () => void) {
    if (!this.writable) return;
    const area = document.createElement('div'); area.className = 'studio-remove';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', () => {
      area.innerHTML = '<span>Remove this item from the studio?</span><button type="button" data-confirm>Yes, remove</button><button type="button" data-keep>Keep it</button>';
      area.querySelector('[data-confirm]')?.addEventListener('click', run);
      area.querySelector('[data-keep]')?.addEventListener('click', () => area.replaceChildren(button));
    });
    area.append(button); container.append(area);
  }
  private boards(content: HTMLElement) {
    const board = this.state!.projects.find(p => p.id === this.boardId) ?? this.state!.projects[0];
    if (!board) { content.innerHTML = '<div class="studio-empty"><b>A whiteboard for every project</b><p>Hire an agent or start one in a project to get its first board.</p></div>'; return; }
    this.boardId = board.id;
    const next = board.goals.find(g => !g.done), complete = board.goals.filter(g => g.done).length;
    const working = [...new Set(this.agents.filter(a => projectKey(a) === board.id).map(a => a.employee_id).filter((id): id is string => !!id))];
    const addGoal = `<button type="button" class="primary" data-add-goal${this.writable ? '' : ' disabled'}>＋ ${board.goals.length ? 'New milestone' : 'Write the first milestone'}</button>`;
    content.innerHTML = `<div class="board-controls" style="--board-color:${board.color}">${this.projectMenu('project', 'Project whiteboard', board.id, undefined, 'board-switch')}<button type="button" data-customize${this.writable ? '' : ' disabled'}>Customize</button>${board.goals.length ? addGoal : ''}</div>
      <section class="project-whiteboard${board.goals.length ? '' : ' blank'}" style="--board-color:${board.color}"><div class="board-corner" aria-hidden="true"></div>
        ${board.goals.length ? `<header><div><small>${next ? 'NEXT MILESTONE' : 'ALL DONE'}</small><h2>${esc(next?.title || 'Every milestone on this board is complete.')}</h2>${next ? `<div class="goal-meter board-meter" aria-hidden="true"><i style="width:${goalProgress(next)}%"></i></div>` : ''}</div><span class="board-tally"><b>${complete}</b> / ${board.goals.length}<small>done</small></span></header>`
        : `<header><div><small>THIS BOARD IS BLANK</small><h2>What is this team building toward?</h2><p>Add a milestone, break it into steps, and pick who is on it. Finished milestones go on the trophy shelf.</p></div>${addGoal}</header>`}
        ${board.notes ? `<p class="board-notes">${esc(board.notes)}</p>` : ''}<div class="board-team"><small>AT THEIR DESKS</small>${this.chips(working) || '<span>Nobody is at this project right now.</span>'}</div></section>
      <div class="milestone-list">${board.goals.map((goal, index) => this.goalCard(goal, index, board.goals.length)).join('')}</div>
      <section class="project-work"><h3>Recent work <small>${this.state!.journalSummary?.tasksByProject[board.id] ?? this.state!.journal.filter(e => e.project === board.id && e.kind === 'task').length} completed</small></h3>${this.entryRows(this.state!.journal.filter(e => e.project === board.id && e.kind === 'task').slice(-6).reverse()) || '<p>Nothing finished here yet. Completed agent work collects on this board while the bridge runs.</p>'}</section>`;
    this.bindMenus(content, { project: id => { this.boardId = id; this.render(); } });
    content.querySelector('[data-customize]')?.addEventListener('click', () => this.editBoard(content, board));
    content.querySelector('[data-add-goal]')?.addEventListener('click', () => this.editGoal(content, board));
    content.querySelectorAll<HTMLElement>('[data-goal]').forEach(card => {
      const goal = board.goals.find(g => g.id === card.dataset.goal)!;
      card.querySelector('[data-edit-goal]')?.addEventListener('click', () => this.editGoal(content, board, goal));
      card.querySelector('[data-complete]')?.addEventListener('click', () => void this.saveGoal(board.id, goal.id, current => ({ ...current, done: !current.done })));
      card.querySelectorAll<HTMLInputElement>('[data-check]').forEach(box => box.addEventListener('change', () => {
        const done = box.checked, id = goal.checklist[Number(box.dataset.check)].id;
        box.closest('label')?.classList.toggle('checked', done);
        const count = card.querySelectorAll('[data-check]:checked').length, total = goal.checklist.length;
        const progress = Math.round(count / Math.max(1, total) * 100);
        const meter = card.querySelector<HTMLElement>('.goal-meter')!;
        meter.setAttribute('aria-valuenow', String(progress)); meter.querySelector<HTMLElement>('i')!.style.width = `${progress}%`;
        card.querySelector('[data-check-count]')!.textContent = `${count}/${total} steps`;
        if (next?.id === goal.id) content.querySelector<HTMLElement>('.board-meter i')!.style.width = `${progress}%`;
        void this.saveGoal(board.id, goal.id, current => ({ ...current, checklist: current.checklist.map(item => item.id === id ? { ...item, done } : item) })); }));
      card.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button => button.addEventListener('click', () => void this.change(() => ({ op: 'goal.move', project: board.id, id: goal.id, version: this.state!.projects.find(p => p.id === board.id)!.version, direction: button.dataset.move }))));
    });
    this.bindEntries(); this.bindPeople();
  }
  private goalCard(goal: Milestone, index: number, total: number) {
    return `<article class="milestone-card${goal.done ? ' completed' : ''}" data-goal="${esc(goal.id)}"><div class="milestone-top"><span class="milestone-number">${goal.done ? '✓' : String(index + 1).padStart(2, '0')}</span><div><h3>${esc(goal.title)}</h3><small>${goal.done ? `Completed ${date(goal.completedAt!)}` : goal.due ? `Due ${esc(goal.due)}` : 'No deadline'} · <span data-check-count>${goal.checklist.filter(i => i.done).length}/${goal.checklist.length} steps</span></small></div><button type="button" data-edit-goal>${this.writable ? 'Edit' : 'View'}</button></div>
      ${goal.notes ? `<p class="milestone-notes">${esc(goal.notes)}</p>` : ''}<div class="goal-meter" role="progressbar" aria-label="Checklist progress" aria-valuenow="${goalProgress(goal)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${goalProgress(goal)}%"></i></div>
      <div class="goal-checklist">${goal.checklist.map((item, i) => `<label class="${item.done ? 'checked' : ''}"><input type="checkbox" data-check="${i}"${checked(item.done)}${this.writable && !goal.done ? '' : ' disabled'}><span>${esc(item.text)}</span></label>`).join('')}</div>
      <div class="goal-contributors">${this.chips(goal.contributors)}${artifact(goal.url)}</div><div class="milestone-actions"><button type="button" data-complete${this.writable ? '' : ' disabled'}>${goal.done ? 'Reopen milestone' : 'Complete milestone'}</button><span></span><button type="button" data-move="up" aria-label="Move milestone up"${this.writable && index > 0 ? '' : ' disabled'}>↑</button><button type="button" data-move="down" aria-label="Move milestone down"${this.writable && index < total - 1 ? '' : ' disabled'}>↓</button></div></article>`;
  }
  private saveGoal(project: string, id: string, update: (goal: Milestone) => Milestone) {
    return this.change(() => {
      const goal = this.state?.projects.find(p => p.id === project)?.goals.find(g => g.id === id);
      if (!goal) throw new Error('This milestone was removed.');
      return { ...update(goal), op: 'goal.save', project };
    });
  }
  private editBoard(content: HTMLElement, board: ProjectBoard) {
    const form = this.editor(content, 'Customize whiteboard', field('Board name', `<input name="name" maxlength="60" required value="${esc(board.name)}">`) + field('Team notes', `<textarea name="notes" rows="4" maxlength="4000" placeholder="What matters to this team?">${esc(board.notes)}</textarea>`) + `<fieldset class="board-color-picker"><legend>Marker color</legend>${BOARD_COLORS.map((color, i) => `<label style="--swatch:${color}"><input type="radio" name="color" value="${color}"${checked(board.color === color)}><span>${['Ocean', 'Fern', 'Copper', 'Lilac', 'Berry', 'Slate'][i]}</span></label>`).join('')}</fieldset>`, form => {
      const data = new FormData(form); void this.change({ op: 'project.save', id: board.id, version: board.version, name: data.get('name'), notes: data.get('notes'), color: data.get('color') });
    });
    this.drafts.bind(form, `project:${board.id}`, { kind: 'project', id: board.id, version: board.version, title: board.name });
  }
  private editGoal(content: HTMLElement, board: ProjectBoard, goal?: Milestone) {
    const form = this.editor(content, goal ? 'Edit milestone' : 'New team milestone', field('Milestone', `<input name="title" required maxlength="120" placeholder="Ship the first public beta" value="${esc(goal?.title)}">`) + field('Notes', `<textarea name="notes" maxlength="4000" rows="3" placeholder="What does success look like?">${esc(goal?.notes)}</textarea>`) + `<div class="editor-pair">${field('Due date · optional', `<input type="date" name="due" value="${esc(goal?.due)}">`)}${field('Artifact link · optional', `<input type="url" name="url" maxlength="2000" placeholder="https://…" value="${esc(goal?.url)}">`)}</div><fieldset class="checklist-editor"><legend>Steps toward the milestone</legend><div data-checklist></div><button type="button" data-add-step>＋ Add step</button></fieldset>${this.contributors(goal?.contributors ?? [])}<label class="studio-check"><input type="checkbox" name="done"${checked(!!goal?.done)}>Milestone complete · display on the trophy shelf</label>`, form => {
      const data = new FormData(form);
      const checklist = [...form.querySelectorAll<HTMLElement>('.checklist-edit-row')].map(row => ({ id: row.dataset.id!, text: row.querySelector<HTMLInputElement>('[data-step-text]')!.value, done: row.querySelector<HTMLInputElement>('[data-step-done]')!.checked })).filter(item => item.text.trim());
      void this.change({ op: 'goal.save', project: board.id, id: goal?.id, version: goal?.version, title: data.get('title'), notes: data.get('notes'), due: data.get('due'), url: data.get('url'), checklist, contributors: this.picked(form), done: data.has('done') });
    });
    const rows = form.querySelector<HTMLElement>('[data-checklist]')!;
    const add = (item = { id: crypto.randomUUID() as string, text: '', done: false }, focus = false) => {
      if (rows.children.length >= 40) { this.toast('Use up to 40 steps per milestone.'); return; }
      const row = document.createElement('div'); row.className = 'checklist-edit-row'; row.dataset.id = item.id;
      row.innerHTML = `<input type="checkbox" data-step-done aria-label="Step complete"${checked(item.done)}><input data-step-text maxlength="200" aria-label="Step description" placeholder="A concrete step…" value="${esc(item.text)}"><button type="button" aria-label="Remove step">×</button>`;
      row.querySelector('button')!.addEventListener('click', () => row.remove()); rows.append(row); if (focus) row.querySelector<HTMLInputElement>('[data-step-text]')?.focus();
    };
    for (const item of goal?.checklist ?? []) add(item);
    if (!goal) add();
    form.querySelector('[data-add-step]')?.addEventListener('click', () => add(undefined, true));
    this.drafts.bind(form, `goal:${board.id}:${goal?.id ?? 'new'}`, { kind: 'goal', id: goal?.id, project: board.id, version: goal?.version, title: goal?.title ?? 'New milestone' }, steps => { rows.replaceChildren(); steps.forEach(step => add(step)); });
    if (goal) this.removeButton(form, 'Remove milestone', () => void this.change({ op: 'goal.remove', project: board.id, id: goal.id, version: goal.version }));
  }
  private people(content: HTMLElement) {
    const list = [...this.state!.employees].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    const person = list.find(p => p.id === this.personId) ?? list[0];
    if (!person) { content.innerHTML = '<div class="studio-empty"><b>Your team’s careers begin here.</b><p>Hire an agent to create an employee profile.</p></div>'; return; }
    this.personId = person.id;
    content.innerHTML = `<div class="people-layout"><aside class="employee-list" aria-label="Employees">${list.map(p => { const active = this.agents.some(a => a.employee_id === p.id); return `<button type="button" data-employee="${p.id}" aria-current="${p.id === person.id ? 'true' : 'false'}"><span data-portrait="${p.id}"></span><span><b>${p.favorite ? '★ ' : ''}${esc(p.name)}</b><small>${esc(active ? this.handle(p.id) : 'Career saved')} · ${p.shipped} done</small></span></button>`; }).join('')}</aside><div class="employee-detail"></div></div>`;
    content.querySelectorAll<HTMLButtonElement>('[data-employee]').forEach(button => button.addEventListener('click', () => { this.personId = button.dataset.employee!; this.render(); }));
    const detail = content.querySelector<HTMLElement>('.employee-detail')!;
    const active = this.agents.filter(a => a.employee_id === person.id), level = 1 + Math.floor(person.shipped / 3);
    const achievements = this.state!.journalSummary?.achievementsByEmployee[person.id] ?? this.state!.journal.filter(e => e.contributors.includes(person.id) && ['milestone', 'release'].includes(e.kind)).length;
    detail.innerHTML = `<div class="employee-passport"><span data-profile-preview></span><div><small>EMPLOYEE RECORD · SINCE ${new Date(person.createdAt).toLocaleDateString()}</small><h2>${esc(person.name)}</h2><p><span class="level-badge" data-level-tier="${tierForLevel(level)}">${rankForLevel(level)} · Lv ${level}</span> · ${esc(person.kind)}</p><div class="career-totals"><b>${person.shipped}<small>completed tasks</small></b><b>${achievements}<small>team achievements</small></b></div></div></div><div class="career-stats">${WORK_KINDS.map(stat => `<span>${WORK[stat].stat}<b>${person.stats[stat]}</b></span>`).join('')}</div>
      <form class="studio-editor employee-editor"><fieldset class="editor-fields"${this.writable ? '' : ' disabled'}>${field('Employee name', `<input name="name" required maxlength="40" value="${esc(person.name)}">`)}${field('Their story', `<textarea name="bio" maxlength="1000" rows="3" placeholder="Our veteran debugger. Here since the first release.">${esc(person.bio)}</textarea>`)}<div class="appearance-controls"><fieldset><legend>Portrait</legend><button type="button" data-appearance="face" data-step="-1" aria-label="Previous portrait">←</button><span data-face-count></span><button type="button" data-appearance="face" data-step="1" aria-label="Next portrait">→</button></fieldset><fieldset><legend>Outfit</legend><button type="button" data-appearance="body" data-step="-1" aria-label="Previous outfit">←</button><span data-body-count></span><button type="button" data-appearance="body" data-step="1" aria-label="Next outfit">→</button></fieldset></div><input type="hidden" name="face" value="${person.face}"><input type="hidden" name="body" value="${person.body}"><label class="studio-check"><input type="checkbox" name="favorite"${checked(person.favorite)}>★ Pin this employee in the office and roster</label><div class="studio-form-actions"><button type="submit" class="primary">Save employee</button>${active.map(a => `<button type="button" data-talk="${esc(a.pane_id)}">Talk to ${esc(person.name)}</button>`).join('')}</div></fieldset><p class="studio-form-note" aria-live="polite"></p></form>
      <details class="career-continue"><summary>Continue this career with another agent</summary><p>A new session can use this employee’s name, appearance, and career. Other saved careers stay in the employee list.</p>${field('Agent at a desk', `<select data-bind-agent>${this.agents.map(a => `<option value="${esc(a.pane_id)}">${esc(employeeName(a))} · ${esc(a.pane_id)}</option>`).join('')}</select>`)}<button type="button" data-bind${this.writable && this.agents.length ? '' : ' disabled'}>Use this employee for that agent</button></details><section class="employee-memories"><h3>Career journal</h3>${this.entryRows(this.state!.journal.filter(e => e.contributors.includes(person.id)).slice(-10).reverse()) || '<p>Completed work and team milestones will become part of this career.</p>'}</section>`;
    const form = detail.querySelector<HTMLFormElement>('form')!;
    const preview = () => {
      const face = Number((form.elements.namedItem('face') as HTMLInputElement).value), body = Number((form.elements.namedItem('body') as HTMLInputElement).value);
      detail.querySelector('[data-profile-preview]')!.replaceChildren(avatarCanvas(person.id, 108, { face, body }));
      detail.querySelector('[data-face-count]')!.textContent = `${face + 1} / 36`; detail.querySelector('[data-body-count]')!.textContent = `${body + 1} / 26`;
    };
    preview();
    form.querySelectorAll<HTMLButtonElement>('[data-appearance]').forEach(button => button.addEventListener('click', () => {
      const kind = button.dataset.appearance!, input = form.elements.namedItem(kind) as HTMLInputElement, count = kind === 'face' ? 36 : 26;
      input.value = String((Number(input.value) + Number(button.dataset.step) + count) % count); preview();
    }));
    form.addEventListener('submit', event => { event.preventDefault(); const data = new FormData(form); void this.change({ op: 'employee.save', id: person.id, version: person.version, name: data.get('name'), bio: data.get('bio'), face: Number(data.get('face')), body: Number(data.get('body')), favorite: data.has('favorite') }); });
    detail.querySelectorAll<HTMLButtonElement>('[data-talk]').forEach(button => button.addEventListener('click', () => { const agent = this.agents.find(a => a.pane_id === button.dataset.talk); if (agent) { this.close(); this.onTalk?.(agent); } }));
    detail.querySelector('[data-bind]')?.addEventListener('click', () => void this.change({ op: 'employee.bind', pane: detail.querySelector<HTMLSelectElement>('[data-bind-agent]')!.value, id: person.id }));
    this.drafts.bind(form, `employee:${person.id}`, { kind: 'employee', id: person.id, version: person.version, title: person.name }, undefined, preview);
    this.bindEntries();
  }
  private personLabel(id: string) { const p = this.state!.employees.find(e => e.id === id); if (!p) return ''; const tag = this.tag(p); return tag ? `${p.name} ${tag}` : p.name; }
  /** A journal row: who did it on the left, what happened in the middle, when and how on the right.
   *  Agent work shows the employee's portrait; everything else shows its kind's glyph. */
  private entryRows(entries: JournalEntry[]) {
    const KIND = { task: 'Completed work', milestone: 'Milestone', release: 'Release', note: 'Note', sale: 'Sale' } as const;
    const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return entries.map(raw => {
      const entry = this.readView(raw);
      const project = this.state!.projects.find(p => p.id === entry.project);
      const people = entry.contributors.map(id => this.state!.employees.find(e => e.id === id)).filter((p): p is Employee => !!p);
      const long = entry.notes.length > 260 || entry.notes.split('\n').length > 4;
      const who = people.length ? `<span class="entry-who">${people.map(p => { const tag = this.tag(p); return `<button type="button" class="entry-person" data-person="${esc(p.id)}">${esc(p.name)}${tag ? ` <small>${esc(tag)}</small>` : ''}</button>`; }).join('')}</span>` : '';
      const where = project ? `<span class="entry-project"><i class="project-swatch" style="background:${esc(project.color)}"></i>${esc(project.name)}</span>` : entry.kind === 'sale' ? `<span class="entry-project">${entry.source === 'revenuecat' ? 'RevenueCat' : 'Stripe'}</span>` : '';
      const duration = entry.minutes ? (entry.minutes >= 60 ? `${Math.floor(entry.minutes / 60)}h ${entry.minutes % 60}m` : `${entry.minutes} min`) : '';
      const amount = entry.kind === 'sale' && typeof entry.amount === 'number' ? `<b class="entry-amount ${entry.amount < 0 ? 'down' : 'up'}">${money(entry.amount, entry.currency, true)}</b>` : '';
      const lead = people.length === 1 && entry.kind === 'task' ? `<span class="entry-face" data-portrait="${esc(people[0].id)}" data-size="34"></span>`
        : `<span class="journal-glyph ${entry.kind}" aria-hidden="true">${studioIcon(entry.kind === 'task' ? 'check' : entry.kind === 'note' ? 'note' : entry.kind === 'sale' ? 'coin' : 'trophies', 18)}</span>`;
      return `<article class="journal-row kind-${entry.kind}" data-journal-entry="${esc(entry.id)}"${entry.kind === 'sale' && entry.moneyId ? ` data-payment-row="${esc(entry.id)}"` : ''}${entry.source === 'agent' ? ` data-memory-chat="${esc(entry.id)}"` : ''}>${lead}<div class="entry-body"><button type="button" class="entry-title" data-entry="${entry.id}">${esc(entry.title)}</button><small class="entry-meta">${who}${where}</small>${entry.notes ? `<div class="entry-notes${long ? ' clamped' : ''}">${this.cachedMarkdown(entry.notes)}</div>${long ? '<button type="button" class="entry-more" data-more-notes aria-expanded="false">Show more</button>' : ''}` : ''}${artifact(entry.url)}</div><aside class="entry-aside"><time datetime="${new Date(entry.at).toISOString()}">${clock(entry.at)}</time>${amount}${duration ? `<span>${esc(duration)}</span>` : ''}${entry.model ? `<span class="entry-model">${esc(entry.model)}</span>` : ''}<span class="entry-kind">${KIND[entry.kind]}</span><button type="button" class="entry-read" data-read-entry="${esc(entry.id)}"${this.writable && !this.readDrafts.has(entry.id) ? '' : ' disabled'}>${this.readDrafts.has(entry.id) ? 'Saving…' : entry.readAt ? 'Mark unread' : 'Mark read & archive'}</button>${entry.source === 'agent' || entry.kind === 'sale' ? `<button type="button" class="entry-edit" data-edit-entry="${esc(entry.id)}" aria-label="Edit memory: ${esc(entry.title)}">Edit memory</button>` : ''}</aside></article>`;
    }).join('');
  }
  private readView(entry: JournalEntry): JournalEntry {
    const pending = this.readDrafts.get(entry.id);
    return pending ? { ...entry, readAt: pending.readAt } : entry;
  }
  private async markRead(entry: JournalEntry) {
    if (!this.writable) return;
    const readAt = entry.readAt ? undefined : Date.now();
    this.readDrafts.set(entry.id, { entry, readAt });
    this.paintReadRows();
    const ok = await this.change({ op: 'entry.read', id: entry.id, version: entry.version, read: !!readAt }, () => {}, { quiet: true });
    // A compact snapshot may omit an older entry. Fetch that one row before dropping its preview.
    if (ok && !this.state?.journal.some(e => e.id === entry.id)) await this.refreshHistory([entry.id], false);
    this.readDrafts.delete(entry.id);
    this.paintReadRows();
    if (ok) this.toast(readAt ? 'Moved to Archive.' : 'Moved to Unread.', async () => {
      const current = this.state?.journal.find(e => e.id === entry.id);
      if (!current || !!current.readAt !== !!readAt) { this.toast('This memory changed. Open it to review its current status.'); return; }
      await this.markRead(current);
    });
  }
  /** Change only read buttons and row visibility. Keep other notes, avatars and focus intact. */
  private paintReadRows() {
    if (!this.isOpen) return;
    const entries = new Map(this.state?.journal.map(e => [e.id, this.readView(e)]));
    for (const [id, pending] of this.readDrafts) if (!entries.has(id)) entries.set(id, this.readView(pending.entry));
    this.root.querySelectorAll<HTMLElement>('[data-journal-entry]').forEach(row => {
      const entry = entries.get(row.dataset.journalEntry!); if (!entry) return;
      const button = row.querySelector<HTMLButtonElement>('[data-read-entry]')!;
      button.disabled = !this.writable || this.readDrafts.has(entry.id);
      button.textContent = this.readDrafts.has(entry.id) ? 'Saving…' : entry.readAt ? 'Mark unread' : 'Mark read & archive';
      if (this.page === 'journal') row.hidden = !!entry.readAt !== this.journalArchive;
    });
    if (this.page !== 'journal') return;
    const host = this.root.querySelector('.journal-entries'); if (!host) return;
    host.querySelectorAll<HTMLElement>('.journal-day').forEach(day => {
      let row = day.nextElementSibling, visible = false;
      while (row && !row.classList.contains('journal-day')) { if (row.matches('[data-journal-entry]:not([hidden])')) visible = true; row = row.nextElementSibling; }
      day.hidden = !visible;
    });
    const visible = [...host.querySelectorAll<HTMLElement>('[data-journal-entry]:not([hidden])')].flatMap(row => {
      const entry = entries.get(row.dataset.journalEntry!); return entry ? [entry] : [];
    });
    const digest = this.root.querySelector('[data-digest]'); if (digest) digest.textContent = this.digest(this.journalView());
    host.querySelector('[data-read-empty]')?.remove();
    if (!visible.length && host.querySelector('[data-journal-entry]')) host.insertAdjacentHTML('afterbegin', `<div class="studio-empty" data-read-empty><b>${this.journalArchive ? 'No archived entries on this page.' : 'You’re all caught up on this page.'}</b><p>${this.readDrafts.size ? 'Saving your changes… You can keep browsing.' : 'Use the journal filters or load more memories.'}</p></div>`);
  }
  private cachedMarkdown(notes: string) {
    let html = this.markdownCache.get(notes);
    if (html === undefined) { html = renderMarkdown(notes); this.markdownCache.set(notes, html); if (this.markdownCache.size > 256) this.markdownCache.delete(this.markdownCache.keys().next().value!); }
    return html;
  }
  private freshEntryControls<T extends HTMLElement>(selector: string): T[] {
    return [...this.root.querySelectorAll<T>(selector)].filter(el => { if (this.entryBindings.has(el)) return false; this.entryBindings.add(el); return true; });
  }
  private paintJournalRows(host: HTMLElement, html: string) {
    const template = document.createElement('template'); template.innerHTML = html;
    const key = (node: Element) => (node as HTMLElement).dataset.journalEntry ?? (node.classList.contains('journal-day') ? `day:${node.textContent}` : '');
    const existing = new Map([...host.children].filter(node => key(node)).map(node => [key(node), node]));
    let cursor = host.firstElementChild;
    for (const next of [...template.content.children]) {
      const markup = next.outerHTML, old = existing.get(key(next));
      const node = old && this.rowMarkup.get(old) === markup ? old : next;
      this.rowMarkup.set(node, markup);
      if (node !== cursor) host.insertBefore(node, cursor); else cursor = cursor.nextElementSibling;
    }
    while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
  }
  private bindEntries() {
    this.freshEntryControls<HTMLElement>('[data-payment-row]').forEach(row => row.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('button,a,input,select,textarea') || window.getSelection()?.toString()) return;
      row.querySelector<HTMLButtonElement>('[data-entry]')?.click();
    }));
    this.freshEntryControls<HTMLButtonElement>('[data-read-entry]').forEach(button => button.addEventListener('click', () => {
      const entry = this.state!.journal.find(e => e.id === button.dataset.readEntry);
      if (!entry || this.readDrafts.has(entry.id)) return;
      void this.markRead(entry);
    }));
    this.bindPeople(); this.paintAvatars();
    this.freshEntryControls<HTMLElement>('[data-memory-chat]').forEach(row => row.addEventListener('click', event => {
      // Links, profile controls and expansion keep their own actions. Selecting text is not a click-through.
      if ((event.target as HTMLElement).closest('button,a,input,select,textarea,summary') || window.getSelection()?.toString()) return;
      const entry = this.state!.journal.find(e => e.id === row.dataset.memoryChat);
      if (entry) this.openMemoryChat(entry);
    }));
    this.freshEntryControls<HTMLButtonElement>('[data-edit-entry]').forEach(button => button.addEventListener('click', () => {
      const entry = this.state!.journal.find(e => e.id === button.dataset.editEntry);
      if (entry) this.editEntry(this.root.querySelector<HTMLElement>('.studio-content')!, entry);
    }));
    this.freshEntryControls<HTMLElement>('.entry-notes').forEach(notes => notes.addEventListener('focusin', () => {
      if (notes.classList.contains('clamped')) (notes.nextElementSibling as HTMLButtonElement)?.click();
    }));
    this.freshEntryControls<HTMLButtonElement>('[data-more-notes]').forEach(button => button.addEventListener('click', () => {
      const notes = button.previousElementSibling as HTMLElement, open = notes.classList.toggle('clamped');
      button.textContent = open ? 'Show more' : 'Show less'; button.setAttribute('aria-expanded', String(!open));
    }));
    this.freshEntryControls<HTMLButtonElement>('[data-entry]').forEach(button => button.addEventListener('click', () => {
      const entry = this.state!.journal.find(e => e.id === button.dataset.entry); if (!entry) return;
      if (entry.kind === 'sale' && entry.moneyId && this.onPayment) { this.onPayment({ id: entry.moneyId, source: entry.source === 'revenuecat' ? 'revenuecat' : 'stripe', title: entry.title, at: entry.at, amount: entry.amount, currency: entry.currency, url: entry.url }); return; }
      if (entry.source === 'agent') { this.openMemoryChat(entry); return; }
      const content = this.root.querySelector<HTMLElement>('.studio-content')!;
      if (entry.source === 'goal') {
        const project = this.state!.projects.find(p => p.id === entry.project), goal = project?.goals.find(g => g.id === entry.goalId);
        if (project && goal) { this.page = 'boards'; this.boardId = project.id; this.editGoal(content, project, goal); }
      } else this.editEntry(content, entry);
    }));
  }
  private openMemoryChat(entry: JournalEntry) {
    const active = this.agents.filter(a => a.employee_id && entry.contributors.includes(a.employee_id));
    const agent = active.find(a => projectKey(a) === entry.project) ?? active[0];
    if (agent) { this.close(); this.office.focus(agent.pane_id); this.onTalk?.(agent); return; }
    const person = this.state!.employees.find(p => entry.contributors.includes(p.id));
    if (person) this.open('people', person.id);
    this.toast(person ? 'This agent’s session has ended. Showing their saved employee record.' : 'This agent’s session has ended. Their chat is no longer available.');
  }
  private journalView(trophies = false) {
    const entries = new Map(this.state!.journal.map(entry => [entry.id, entry]));
    for (const [id, pending] of this.readDrafts) if (!entries.has(id)) entries.set(id, pending.entry);
    const needle = this.journalSearch.toLowerCase();
    const names = new Map(this.state!.employees.map(person => [person.id, person.name]));
    const namesKey = JSON.stringify([...names]);
    const matches = (entry: JournalEntry) => {
      let cached = this.searchCache.get(entry);
      if (!cached || cached.names !== namesKey) { cached = { names: namesKey, text: `${entry.title} ${entry.notes} ${entry.contributors.map(id => names.get(id) ?? '').join(' ')}`.toLowerCase() }; this.searchCache.set(entry, cached); }
      return cached.text.includes(needle);
    };
    return [...entries.values()].map(entry => this.readView(entry)).sort((a, b) => b.at - a.at).filter(e => (trophies || !!this.journalSince || !!e.readAt === this.journalArchive) && (!trophies || ['milestone', 'release'].includes(e.kind)) && (!this.journalSince || trophies || e.at > this.journalSince) && (!this.journalProject || e.project === this.journalProject) && (trophies || !this.journalKind || e.kind === this.journalKind) && (!needle || matches(e)));
  }
  private journal(content: HTMLElement) {
    const trophies = this.page === 'trophies';
    const query = (): JournalPageQuery => ({ moneySummary: !!this.journalSince, project: this.journalProject, kind: trophies ? '' : this.journalKind,
      search: this.journalSearch, since: trophies ? 0 : this.journalSince, trophies, read: trophies || this.journalSince ? undefined : this.journalArchive });
    const selectQuery = () => {
      const key = JSON.stringify(query());
      if (key === this.historyQuery) {
        if (this.journalSince && !this.historyLoading && this.historyMoneyRevision !== this.state?.revision) {
          this.historyQueryLoaded = false; this.historyPageCursor = undefined;
        }
        return;
      }
      const cachedMoney = this.moneyCache.get(key);
      this.historyMoney = cachedMoney?.money; this.historyMoneyRevision = cachedMoney?.revision ?? -1;
      this.historyQuery = key; this.historyRequest++; this.historyLoading = false; this.historyError = false;
      const filtered = !trophies || this.journalProject || this.journalKind || this.journalSearch || this.journalSince || trophies;
      this.historyPageCursor = filtered ? undefined : this.historyCursor;
      this.historyQueryLoaded = !filtered;
    };
    selectQuery();
    content.innerHTML = `<div class="journal-heading"><div><small>${trophies ? 'THE TROPHY SHELF' : this.journalSince ? (this.recapRange === 'look' ? 'WHILE YOU WERE AWAY' : `RECAP · ${esc(this.recapPhrase().toUpperCase())}`) : 'THE STUDIO JOURNAL'}</small><h2 data-journal-title>${trophies ? 'Things we made happen.' : this.journalSince ? 'Here’s what happened.' : 'The work becomes a story.'}</h2><p class="journal-digest" data-digest></p></div><button type="button" class="primary" data-new-memory${this.writable ? '' : ' disabled'}>${trophies ? '＋ Record a release' : '＋ Add a memory'}</button></div>${trophies ? '' : this.journalSince ? `<div class="journal-mailboxes recap-ranges" role="group" aria-label="Recap window">${RECAP_RANGES.filter(r => r.value !== 'look' || this.recapLook).map(r => `<button type="button" data-recap-range="${r.value}" aria-pressed="${r.value === this.recapRange}">${r.label}</button>`).join('')}</div><div class="recap-summary" data-recap-summary></div>` : `<div class="journal-mailboxes" role="group" aria-label="Journal status"><button type="button" data-journal-box="unread" aria-pressed="${!this.journalArchive}">Unread</button><button type="button" data-journal-box="archive" aria-pressed="${this.journalArchive}">Archive</button></div>`}<div class="journal-filters">${field('Project', this.projectMenu('journal-project', 'Project', this.journalProject, 'All projects'))}${trophies ? '' : field('Kind', this.menu('journal-kind', 'Kind', this.journalKind, [{ value: '', label: 'All memories' }, { value: 'task', label: 'Completed work' }, { value: 'milestone', label: 'Milestones' }, { value: 'release', label: 'Releases' }, { value: 'note', label: 'Notes' }, { value: 'sale', label: 'Sales' }]))}${field('Find a memory', `<input type="search" data-journal-search value="${esc(this.journalSearch)}" placeholder="Search titles, notes, people…">`)}${this.journalSince ? '<button type="button" data-all-history>Show full journal</button>' : ''}</div><div class="journal-entries"></div>`;
    const paint = () => {
      if (!content.isConnected || !content.querySelector('.journal-entries')) return;
      content.dataset.historyPending = String(this.historyLoading);
      const entries = this.journalView(trophies);
      const host = content.querySelector<HTMLElement>('.journal-entries')!;
      host.classList.toggle('trophy-shelves', trophies);
      content.querySelector<HTMLElement>('[data-digest]')!.textContent = trophies || this.journalSince ? '' : this.digest(entries);
      if (this.journalSince && !trophies) {
        const totals = this.recapMoneyTotals(entries);
        const made = totals?.usd ? {amount: totals.usd.amount, currency: 'usd'} : undefined;
        content.querySelector<HTMLElement>('[data-journal-title]')!.textContent = made?.amount ? `${totals?.usd?.estimated ? 'About' : 'You made'} ${money(made.amount, made.currency)} USD ${this.recapPhrase()}.` : entries.length ? `Here’s what happened ${this.recapPhrase()}.` : `Nothing happened ${this.recapPhrase()}.`;
        const summary = content.querySelector<HTMLElement>('[data-recap-summary]');
        if (summary) summary.innerHTML = this.recapSummary(entries);
        summary?.querySelector('[data-retry-recap]')?.addEventListener('click', () => {
          this.historyPageCursor = undefined; this.historyQueryLoaded = false;
          void this.loadHistory(query(), paint);
        });
      }
      const markup = (trophies ? entries.slice(0, this.journalLimit).map(e => `<article class="trophy-card"><img src="/assets/gds/celebrate/trophy.png?v=2" alt=""><small>${esc(e.kind)} · ${new Date(e.at).toLocaleDateString()}</small><button type="button" data-entry="${e.id}">${esc(e.title)}</button><p>${esc(this.state!.projects.find(p => p.id === e.project)?.name || 'Studio')}</p>${artifact(e.url)}<div class="goal-contributors">${this.chips(e.contributors)}</div></article>`).join('') : this.dayRows(entries.slice(0, this.journalLimit))) || `<div class="studio-empty"><span aria-hidden="true">${studioIcon(trophies ? 'trophies' : 'journal', 28)}</span><b>${this.journalSearch || this.journalProject || this.journalKind ? 'No matching memories.' : trophies ? 'Save a place for the first achievement.' : this.journalArchive ? 'No archived entries yet.' : 'You’re all caught up.'}</b><p>${trophies ? 'Complete a milestone or record a release. Add its real artifact link so you can revisit it.' : 'Completed work is recorded automatically. You can also add notes, releases, and links yourself.'}</p></div>`;
      this.paintJournalRows(host, markup);
      content.dataset.signature = this.panelSignature(trophies ? 'trophies' : 'journal');
      content.dataset.context = this.panelSignature(trophies ? 'trophies' : 'journal', true);
      if (entries.length > this.journalLimit) host.insertAdjacentHTML('beforeend', `<button type="button" class="load-memories" data-more>Load more · ${entries.length - this.journalLimit} remaining</button>`);
      const remote = (this.state!.journalTotal ?? this.state!.journal.length) > this.state!.journal.length;
      if (remote && this.historyPageCursor !== null) {
        host.insertAdjacentHTML('beforeend', `<button type="button" class="load-memories" data-older-history${this.historyLoading ? ' disabled' : ''}>${this.historyLoading ? 'Loading studio history…' : 'Load older history'}</button>`);
        host.querySelector('[data-older-history]')?.addEventListener('click', () => void this.loadHistory(query(), paint));
      }
      host.querySelector('[data-more]')?.addEventListener('click', () => { this.journalLimit += 40; paint(); });
      this.bindEntries(); this.bindPeople(); this.paintAvatars();
    };
    content.querySelectorAll<HTMLButtonElement>('[data-recap-range]').forEach(button => button.addEventListener('click', () => {
      this.recapRange = button.dataset.recapRange as RecapRange; this.journalSince = recapStart(this.recapRange, this.recapLook); this.journalLimit = 40; this.render();
    }));
    content.querySelectorAll<HTMLButtonElement>('[data-journal-box]').forEach(button => button.addEventListener('click', () => {
      this.journalArchive = button.dataset.journalBox === 'archive'; this.journalSince = 0; this.journalLimit = 40; this.render();
    }));
    this.bindMenus(content, { 'journal-project': id => { this.journalProject = id; this.journalLimit = 40; this.render(); }, 'journal-kind': kind => { this.journalKind = kind; this.journalLimit = 40; this.render(); } });
    content.querySelector<HTMLInputElement>('[data-journal-search]')?.addEventListener('input', event => { this.journalSearch = (event.target as HTMLInputElement).value; this.journalLimit = 40; selectQuery(); paint();
      clearTimeout(this.historySearchTimer);
      if (this.journalSince || (this.state!.journalTotal ?? 0) > this.state!.journal.length) this.historySearchTimer = window.setTimeout(() => {
        if (content.isConnected) void this.loadHistory(query(), paint);
      }, 250); });
    content.querySelector('[data-all-history]')?.addEventListener('click', () => { this.journalSince = 0; this.render(); });
    content.querySelector('[data-new-memory]')?.addEventListener('click', () => this.editEntry(content, undefined, trophies));
    this.historyPaint = paint;
    paint();
    if (!this.historyQueryLoaded && (this.journalSince || (this.state!.journalTotal ?? 0) > this.state!.journal.length)) void this.loadHistory(query(), paint);
  }
  private recapPhrase() { return RECAP_RANGES.find(r => r.value === this.recapRange)?.phrase ?? 'since you last looked'; }
  /** The recap's scoreboard: money, shipped work and who shipped it, trophies, time, and which
   *  projects the window belonged to. Cards, not a sentence, so a week reads at a glance. */
  private recapMoneyTotals(entries: JournalEntry[]): RecapMoney | undefined {
    if (this.historyMoney) return this.historyMoney;
    if ((this.state?.journalTotal ?? 0) > (this.state?.journal.length ?? 0)) return undefined;
    const local = recapMoney(entries);
    if (local.totals.every(t => t.currency === 'usd')) local.usd = { amount: local.totals.reduce((sum, t) => sum + t.amount, 0), estimated: false };
    return local;
  }
  private recapSummary(entries: JournalEntry[]) {
    if (!entries.length) return '';
    const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
    const totals = this.recapMoneyTotals(entries);
    const tasks = entries.filter(e => e.kind === 'task'), minutes = tasks.reduce((t, e) => t + (e.minutes ?? 0), 0);
    const trophies = entries.filter(e => e.kind === 'milestone' || e.kind === 'release'), notes = entries.filter(e => e.kind === 'note');
    const top = (pairs: Iterable<[string, number]>, label: (id: string) => string, limit = 3) => [...pairs].sort((a, b) => b[1] - a[1]).slice(0, limit).filter(([id]) => label(id)).map(([id, count]) => `${esc(label(id))} <em>${count}</em>`).join(', ');
    const byPerson = new Map<string, number>(); for (const e of tasks) for (const id of e.contributors) byPerson.set(id, (byPerson.get(id) ?? 0) + 1);
    const byProject = new Map<string, number>(); for (const e of entries) if (e.project) byProject.set(e.project, (byProject.get(e.project) ?? 0) + 1);
    const person = (id: string) => this.state?.employees.find(e => e.id === id)?.name ?? '';
    const project = (id: string) => this.state?.projects.find(p => p.id === id)?.name ?? projectName(id);
    const card = (label: string, value: string, detail: string) => `<div class="recap-card"><small>${label}</small><b>${value}</b><span>${detail}</span></div>`;
    const cards = [
      card('Money made · USD', totals?.usd ? `${totals.usd.estimated ? '≈ ' : ''}${esc(money(totals.usd.amount, 'usd'))}` : this.historyLoading ? 'Converting…' : 'Total unavailable',
        !totals?.usd && !this.historyLoading ? `${this.historyError || !totals ? 'Could not load the total' : 'Exchange rates unavailable'}${totals?.totals.length ? `<br>${totals.totals.map(t => esc(money(t.amount, t.currency, false, true))).join(' + ')}` : ''}<br><button type="button" data-retry-recap>Try again</button>` : totals ? `${totals.usd?.estimated ? `Estimated · rates ${esc(totals.usd.rateDate)}<br>` : ''}${this.historyLoading && totals.usd ? 'Updating…<br>' : ''}${n(totals.payments, 'payment')}${totals.refunds ? ` · ${n(totals.refunds, 'refund or adjustment', 'refunds or adjustments')} deducted` : ''}${totals.billingEvents - totals.payments - totals.refunds ? ` · ${n(totals.billingEvents - totals.payments - totals.refunds, 'other billing event')}` : ''}` : 'Total for the selected period'),
      card('Shipped', String(tasks.length), tasks.length ? (top(byPerson, person) || n(new Set(tasks.flatMap(e => e.contributors)).size, 'person', 'people')) : 'no tasks completed'),
      card('Trophies', String(trophies.length), trophies.length ? esc(trophies[0].title) : 'no milestones or releases'),
      card('Agent time', minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`, notes.length ? n(notes.length, 'note') + ' added' : 'across all desks'),
    ];
    const projects = top(byProject, project, 4);
    return `<div class="recap-cards">${cards.join('')}</div>${projects ? `<p class="recap-projects"><small>PROJECTS</small> ${projects}</p>` : ''}`;
  }
  /** One line that says what the list below adds up to. */
  private digest(entries: JournalEntry[]) {
    if (!entries.length) return '';
    const tasks = entries.filter(e => e.kind === 'task'), minutes = tasks.reduce((n, e) => n + (e.minutes ?? 0), 0);
    const people = new Set(entries.flatMap(e => e.contributors)).size, projects = new Set(entries.map(e => e.project).filter(Boolean)).size;
    const parts = [`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} completed`];
    if (projects) parts.push(`${projects} ${projects === 1 ? 'project' : 'projects'}`);
    if (people) parts.push(`${people} ${people === 1 ? 'person' : 'people'}`);
    if (minutes) parts.push(minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m of agent time` : `${minutes} min of agent time`);
    const made = netMoney(entries);
    if (made) parts.push(`${made.count} ${made.count === 1 ? 'sale' : 'sales'}${made.amount !== undefined ? ` · ${money(made.amount, made.currency, true)}` : ''}`);
    const others = entries.length - tasks.length - (made?.count ?? 0); if (others) parts.push(`${others} ${others === 1 ? 'note or release' : 'notes and releases'}`);
    return parts.join(' · ');
  }
  /** Rows under a heading per day, so a long journal can be scanned. */
  private dayRows(entries: JournalEntry[]) {
    const today = new Date().toDateString(), yesterday = new Date(Date.now() - 86_400_000).toDateString();
    const label = (at: number) => { const d = new Date(at).toDateString(); return d === today ? 'Today' : d === yesterday ? 'Yesterday' : new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
    let last = '', out = '';
    for (const entry of entries) { const day = label(entry.at); if (day !== last) { out += `<h3 class="journal-day">${esc(day)}</h3>`; last = day; } out += this.entryRows([entry]); }
    return out;
  }
  private editEntry(content: HTMLElement, entry?: JournalEntry, release = false) {
    const isTask = entry?.source === 'agent' || entry?.kind === 'sale';
    const form = this.editor(content, entry ? 'Edit memory' : release ? 'Record a release' : 'Add a memory', field('Title', `<input name="title" required maxlength="160" placeholder="Our first public release" value="${esc(entry?.title)}">`) + field('Notes', `<textarea name="notes" rows="4" maxlength="6000" placeholder="What happened? What should we remember?">${esc(entry?.notes)}</textarea>`) + `<div class="editor-pair">${field('Project', `<select name="project"><option value="">Studio</option>${this.projectOptions(entry?.project ?? '')}</select>`)}${isTask ? `<p class="memory-source">${entry.kind === 'sale' ? `${entry.source === 'revenuecat' ? 'RevenueCat' : 'Stripe'} · ${typeof entry.amount === 'number' ? money(entry.amount, entry.currency, true) : 'sale'}` : 'Completed agent work'}</p>` : field('Memory kind', `<select name="kind"><option value="note"${selected(!release && entry?.kind !== 'release')}>Note</option><option value="release"${selected(release || entry?.kind === 'release')}>Release · display on trophy shelf</option></select>`)}</div>${field('Artifact link · optional', `<input name="url" type="url" maxlength="2000" placeholder="https://…" value="${esc(entry?.url)}">`)}${isTask ? `<div class="goal-contributors">${this.chips(entry.contributors)}</div>` : this.contributors(entry?.contributors ?? [])}`, form => {
      const data = new FormData(form); void this.change({ op: 'entry.save', id: entry?.id, version: entry?.version, title: data.get('title'), notes: data.get('notes'), project: data.get('project'), kind: data.get('kind'), url: data.get('url'), contributors: this.picked(form) });
    });
    this.drafts.bind(form, `entry:${entry?.id ?? (release ? 'release' : 'new')}`, { kind: 'entry', id: entry?.id, release, version: entry?.version, title: entry?.title ?? (release ? 'New release' : 'New memory') });
    if (entry) this.removeButton(form, entry.kind === 'sale' ? 'Remove this sale from the journal' : isTask ? 'Remove this completion and its career point' : 'Remove memory', () => void this.change({ op: 'entry.remove', id: entry.id, version: entry.version }));
    this.bindPeople();
  }
  private room(content: HTMLElement) {
    const order = this.roomDraft?.order ?? [...this.office.projectOrder(), ...this.state!.projects.map(p => p.id).filter(id => !this.office.projectOrder().includes(id))];
    content.innerHTML = `<div class="journal-heading"><div><small>MAKE YOURSELF AT HOME</small><h2>Arrange your office.</h2></div><button type="button" data-tidy${this.writable ? '' : ' disabled'}>Tidy the office</button><button type="button" class="primary" data-arrange${this.writable ? '' : ' disabled'}>${this.roomDraft ? 'Back to arranging' : 'Arrange furniture'}</button></div><p class="room-intro">Choose <b>Arrange furniture</b>, then drag an object or select it from the list and use the move buttons. <b>Save layout</b> keeps your changes; <b>Cancel</b> restores the room. Want a starting point? <b>Tidy the office</b> creates an arrangement you can preview.</p>
      <section class="room-projects"><h3>Project areas</h3><p>Move projects through the office’s desk areas. In arrange mode, you can also drag one project’s floor label onto another to swap them.</p>${order.map((id, i) => `<div><span class="project-swatch" style="background:${this.state!.projects.find(p => p.id === id)?.color || '#307c9b'}"></span><b>${esc(this.state!.projects.find(p => p.id === id)?.name || id)}</b><button type="button" data-project-move="${i}" data-direction="-1" aria-label="Move project earlier"${this.writable && i > 0 ? '' : ' disabled'}>↑</button><button type="button" data-project-move="${i}" data-direction="1" aria-label="Move project later"${this.writable && i < order.length - 1 ? '' : ' disabled'}>↓</button></div>`).join('')}</section>
      <section class="furnishing-catalog"><h3>Add a furnishing</h3><p>${this.roomDraft ? 'Choose something, then drag it into place. Save layout when you are happy with the room.' : 'Choosing a furnishing starts an arrangement you can save or cancel.'}</p>${field('Whiteboard project', this.projectMenu('furniture-project', 'Whiteboard project', this.boardId))}<div class="catalog-grid"><button type="button" data-add-kind="whiteboard"><i aria-hidden="true">${studioIcon('boards', 32)}</i><span>Whiteboard</span></button><button type="button" data-add-kind="cabinet"><i aria-hidden="true">${studioIcon('journal', 32)}</i><span>Filing cabinet</span></button><button type="button" data-add-kind="trophy"><img src="/assets/gds/celebrate/trophy.png?v=2" alt=""><span>Trophy shelf</span></button>${this.office.props.map(p => `<button type="button" data-add-kind="decor" data-asset="${esc(p.id)}"><img src="${esc(p.src ?? `/assets/gds/decor/${p.id}.png`)}" alt=""><span>${esc(propName(p.id))}</span></button>`).join('')}</div></section>`;
    this.bindMenus(content, {});
    content.querySelector('[data-arrange]')?.addEventListener('click', () => { this.arrangeRoom(); });
    content.querySelector('[data-tidy]')?.addEventListener('click', () => { this.startRoom(); this.office.regenerateRoom(); this.paintEditBar(); this.close(); this.toast('The office has been tidied. Save layout to keep it.'); });
    content.querySelectorAll<HTMLButtonElement>('[data-project-move]').forEach(button => button.addEventListener('click', () => {
      this.startRoom();
      const list = this.roomDraft!.order, from = Number(button.dataset.projectMove), to = from + Number(button.dataset.direction);
      [list[from], list[to]] = [list[to], list[from]]; this.office.previewProjectOrder(list); this.paintEditBar(); this.render();
    }));
    content.querySelectorAll<HTMLButtonElement>('[data-add-kind]').forEach(button => {
      button.disabled = !this.writable;
      button.addEventListener('click', () => {
        this.startRoom();
        try { this.office.furnishings.add(button.dataset.addKind as RoomItem['kind'], button.dataset.asset, content.querySelector<HTMLElement>('[data-menu="furniture-project"]')!.dataset.value!); this.close(); this.paintEditBar(); this.focusRoomControl(); }
        catch (error) { this.toast((error as Error).message); }
      });
    });
  }
  private arrangeRoom() {
    if (!this.writable || !this.state) return;
    this.sweep.close(); this.beforeOpen?.();
    this.startRoom(); this.close(); this.focusRoomControl();
  }
  private focusRoomControl() { this.editBar.querySelector<HTMLSelectElement>('[data-selected]')?.focus({ preventScroll: true }); }
  private startRoom() {
    if (!this.writable || !this.state || this.roomDraft) return;
    this.roomDraft = { version: this.state.room.version, order: [...this.office.projectOrder(), ...this.state.projects.map(p => p.id).filter(id => !this.office.projectOrder().includes(id))] };
    this.roomStart = JSON.stringify([this.office.furnishings.savedItems(), this.roomDraft.order]);
    this.office.furnishings.startEdit(); this.paintEditBar(); this.paintRecap(); this.dock.hidden = true;
  }
  private finishRoom(saved = false) {
    this.roomDraft = undefined; this.drafts.remove('room');
    if (saved) this.office.finishArrangement();
    else this.office.cancelArrangement();
    this.editBar.hidden = true; this.dock.hidden = false; this.paintRecap();
  }
  private paintEditBar() {
    this.editBar.toggleAttribute('data-block-office-input', this.roomSaving && !!this.roomDraft);
    this.editBar.setAttribute('aria-busy', String(this.roomSaving));
    this.editBar.hidden = !this.roomDraft; if (!this.roomDraft) return;
    this.captureRoomDraft();
    const furniture = this.office.furnishings, item = furniture.items.find(item => item.id === furniture.selected);
    // Selection and movement repaint the controls. Keep keyboard focus on the same action.
    const active = this.editBar.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focusKey = active ? [...active.attributes].find(attr => attr.name.startsWith('data-')) : undefined;
    const name = item ? furniture.label(item).split('\n')[0].replace(' · drag to move', '') : '';
    this.editBar.innerHTML = `<div class="room-edit-heading"><div><b>Arrange furniture</b><span>Preview · save when you’re happy</span></div><div class="room-edit-finish"><button type="button" data-cancel-room>Cancel</button><button type="button" class="primary" data-save-room>${this.roomSaving ? 'Saving…' : 'Save layout'}</button></div></div>
      <p class="room-edit-help" id="room-edit-help">${item ? `Move <b>${esc(name)}</b>: drag it or use the arrows below.` : 'Click an object in the office, or choose one below to bring it into view.'}</p>
      <div class="room-edit-tools"><select data-selected aria-label="Select a furnishing" aria-describedby="room-edit-help"><option value="">Choose furniture to move…</option>${furniture.items.map(item => `<option value="${esc(item.id)}"${selected(furniture.selected === item.id)}>${esc(furniture.label(item).split('\n')[0].replace(' · drag to move', ''))}</option>`).join('')}</select><div class="room-nudge" role="group" aria-label="Move selected furniture one tile"><button type="button" data-nudge="-16,-8" title="Move one tile northwest" aria-label="Move furnishing northwest">↖</button><button type="button" data-nudge="16,-8" title="Move one tile northeast" aria-label="Move furnishing northeast">↗</button><button type="button" data-nudge="-16,8" title="Move one tile southwest" aria-label="Move furnishing southwest">↙</button><button type="button" data-nudge="16,8" title="Move one tile southeast" aria-label="Move furnishing southeast">↘</button></div><button type="button" data-remove${item ? '' : ' disabled'}>Remove</button><div class="room-edit-browse"><button type="button" data-catalog>＋ Add furniture</button><button type="button" data-projects>Project areas</button></div></div>`;
    this.editBar.querySelector<HTMLSelectElement>('[data-selected]')?.addEventListener('change', event => {
      furniture.select((event.target as HTMLSelectElement).value); furniture.focusSelected();
    });
    const browse = (selector: string) => { this.open('room'); this.root.querySelector(selector)?.scrollIntoView({ block: 'start' }); };
    this.editBar.querySelector('[data-catalog]')?.addEventListener('click', () => browse('.furnishing-catalog'));
    this.editBar.querySelector('[data-projects]')?.addEventListener('click', () => browse('.room-projects'));
    this.editBar.querySelector('[data-cancel-room]')?.addEventListener('click', () => {
      if (this.roomSaving) return;
      this.finishRoom(); this.close(); this.dock.querySelector<HTMLButtonElement>('[data-arrange-room]')?.focus({ preventScroll: true }); this.toast('Arrangement cancelled. Your saved layout is restored.');
    });
    this.editBar.querySelector('[data-save-room]')?.addEventListener('click', () => {
      if (!this.roomDraft || this.roomSaving) return;
      this.roomSaving = true; this.paintEditBar();
      void this.change({ op: 'room.save', version: this.roomDraft.version, items: furniture.savedItems(), projectOrder: this.roomDraft.order }, () => {
        this.finishRoom(true); this.close(); this.dock.querySelector<HTMLButtonElement>('[data-arrange-room]')?.focus({ preventScroll: true });
      }).finally(() => { this.roomSaving = false; this.paintEditBar(); });
    });
    this.editBar.querySelector('[data-remove]')?.addEventListener('click', () => { try { const removed = furniture.removeSelected(); if (removed) this.toast('Furniture removed from this arrangement.', () => { if (!this.roomDraft || this.roomSaving) return; furniture.restoreItem(removed); this.toast('Furniture restored.'); }); } catch (error) { this.toast((error as Error).message); } });
    this.editBar.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach(button => {
      button.disabled = !item;
      button.addEventListener('click', () => { const [x, y] = button.dataset.nudge!.split(',').map(Number); try { furniture.moveSelected(x, y); } catch (error) { this.toast((error as Error).message); } });
    });
    if (this.roomSaving) this.editBar.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select').forEach(control => { control.disabled = true; });
    if (focusKey) [...this.editBar.querySelectorAll<HTMLElement>('button,select')].find(control => control.getAttribute(focusKey.name) === focusKey.value)?.focus({ preventScroll: true });
  }

}
