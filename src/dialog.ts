// GDS-style window showing one agent, with its recent terminal output via agent.read.
import type { AgentInfo, AgentQueueItem, AgentQueueState, AgentStatus, WorkspaceSummary } from '../shared/types';
import { agentKind, taskOf, titleOf } from '../shared/types';
import type { OfficeClient } from './net/office-client';
import { TerminalCache, type TerminalSnapshot } from './net/terminal-cache';
import { avatarCanvas } from './feed/avatar';
import { displayName, handleOf, statusLabel } from './feed/feed';
import { audio } from './audio';
import { closeOnEscape } from './escape';
import { WORK, WORK_KINDS, jobIconStyle, statIconStyle, workKindOf } from './work';
import { tierForLevel, type AgentProgress } from './model/office';
import { employeeName } from '../shared/studio';
import { ImageTray, type Attachment } from './attachments';
import { renderPromptImages } from './prompt-images';
import type { ConversationTurn } from '../shared/prompt-images';
import { PastedDraft, renderPromptText } from './pasted-text';
import { bindSettings, settingsFields } from './agent-settings';
import { supportsAgentSettings } from '../shared/agent-settings';
import { renderTerminal } from './terminal-renderer';
import { renderMarkdown } from './markdown';
import { pendingQueueIds, type PendingPrompt } from './net/queue-reconcile';
export { renderTerminal } from './terminal-renderer';

type QueuedReceipt = { id: string; text: string; state: 'queuing' | AgentQueueState; queuedAt: number; error?: string };
type OutboxReceipt = { id: string; text: string; images: Attachment[]; state: 'sending' | 'accepted' | 'working' | 'failed' | 'uncertain'; error?: string };
type Conversation = { agent: AgentInfo; draft: string; images: Attachment[]; scroll?: number; follow?: boolean; outbox: OutboxReceipt[] };
const QUEUE_HISTORY_KEY = 'herdr-story:queued-prompts';

/** What a pane says, minus the parts of a TUI that only make sense on a live screen: trailing
 *  whitespace, the input box and status bar a coding agent keeps pinned at the bottom (rules of
 *  box-drawing, a prompt line, "permissions" hints), and runs of blank lines. */
export function tidyTerminal(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // a rule may carry a title in the middle ("──── task name ─"), so count dashes rather than
  // demanding a solid line
  const rule = (l: string) => { const t = l.trim(); const d = (t.match(/[\u2500-\u257f=_-]/g) || []).length; return t.length >= 8 && d / t.length >= 0.6; };
  const chrome = (l: string) => /^\s*[\u276f\u203a>]\s*(\S.*)?$/.test(l) || /permissions|shift\+tab|\u25b6\u25b6|^\s*\/\w+\s*$/.test(l);
  // status glyphs a coding agent right-aligns with a hundred spaces of padding
  for (let i = 0; i < lines.length; i++) if (/^\s{5,}[\u2714\u2722\u273b\u2736]/.test(lines[i])) lines[i] = lines[i].replace(/^\s+/, '  ');
  // the footer is whatever sits under the first rule in the last dozen lines, if that block holds
  // a prompt or a status hint
  const tail = Math.max(0, lines.length - 14);
  for (let i = tail; i < lines.length; i++) {
    if (rule(lines[i]) && lines.slice(i + 1).some(chrome)) { lines.length = i; break; }
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // A busy pane only offers its visible screen, where the terminal has already broken long lines
  // at its own width, dropping the tail onto the next row at column 0. Rejoin those: a line that
  // ran the width, followed by a row starting flush with ordinary text, is one line.
  const width = Math.max(...lines.map((l) => l.length), 0);
  for (let i = lines.length - 1; i > 0; i--) {
    const prev = lines[i - 1], cur = lines[i];
    if (width >= 60 && prev.length >= width - 2 && /^[A-Za-z0-9"'(\[]/.test(cur)) { lines.splice(i - 1, 2, prev + (prev.endsWith(' ') ? '' : ' ') + cur); }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

type OutputView = 'conversation' | 'screen';
type Turn = ConversationTurn;
const VIEW_KEY = 'herdr-story.output-view';
function readView(): OutputView { try { return localStorage.getItem(VIEW_KEY) === 'screen' ? 'screen' : 'conversation'; } catch { return 'conversation'; } }
function saveView(view: OutputView) { try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ } }

export class Dialog {
  private root = document.getElementById('dialog')!;
  private refreshTimer?: number;
  private outputFrame?: number;
  private queuedOutput?: { pre: HTMLPreElement; result: TerminalSnapshot; generation: number };
  private rawOutput = new WeakMap<HTMLPreElement, string>();
  private readingHistory = false;
  private latestOutput?: TerminalSnapshot;
  private historyRequest = 0;
  private generation = 0;
  private readVersion = 0;
  private terminalCache: TerminalCache;
  private currentAgent?: AgentInfo;
  private prefetchTimer?: number;
  private prefetchedAt = 0;
  /** Once the user starts a conversation, prefer the pane's live screen over scrollback. */
  /** A model or effort change went through; the office may send them to a seminar. */
  onSettingsApplied?: (agent: AgentInfo, field: string, value: string) => void;
  private liveConversation = false;
  /** Which face of the agent's output the box shows: the conversation from its own transcript,
   *  or the raw pane screen. The choice sticks across windows. */
  private view: OutputView = readView();
  private transcriptAvailable?: boolean;
  private transcriptRequest = 0;
  private transcriptInFlight?: number;
  private transcriptCheckFailed = false;
  private openPane?: string;
  private currentStatus?: AgentStatus;
  private previewUrls = new Set<string>();
  private conversations = new Map<string, Conversation>();
  private captureDraft?: () => void;
  private repaintQueue?: () => void;
  private repaintOutbox?: () => void;
  private transcriptTurns: Turn[] = [];
  private stopOutput?: () => void;
  private launchToken = 0;
  private queueHistory = this.loadQueueHistory();
  private promptChains = new Map<string, Promise<boolean>>();
  private queueChains = new Map<string, Promise<boolean>>();
  private queueStatusPending = new Set<string>();
  progressOf?: (paneId: string) => AgentProgress;
  onJournalEntry?: (id: string) => void;
  onProfile?: (a: AgentInfo) => void;
  /** Set from the bridge snapshot. Remotely exposed bridges are read-only unless opted in. */
  writable = false;
  /** Shown under the reply box when nothing can be sent. The demo swaps in its own reason. */
  readOnlyNote = 'remote bridge is read-only · set HERDR_STORY_WRITE=1 before starting it to reply';
  constructor(private client: OfficeClient) {
    this.terminalCache = new TerminalCache(async (target, source, signal) => {
      const result = await this.client.call('agent.read', { target, source, ...(source === 'visible' ? {} : { lines: 120 }) }, { signal }) as { read: { text: string } };
      return result.read.text;
    });
    this.root.addEventListener('click', (e) => { if (e.target === this.root || (e.target as HTMLElement).classList.contains('close')) this.close(); });
    closeOnEscape(this.root, () => this.close());
    document.addEventListener('visibilitychange', () => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
      if (!document.hidden && !this.root.hidden && this.currentAgent) {
        const generation = this.generation, agent = this.currentAgent, pre = this.root.querySelector<HTMLPreElement>('.terminal-output')!;
        void this.refresh(agent, pre).then(() => this.scheduleRefresh(agent, pre, generation));
      }
    });
  }
  /** A brief hover/focus warms only the likely next pane, never the whole roster. */
  prefetch(agent: AgentInfo) {
    if (document.hidden || !this.root.hidden) return;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    const cached = this.terminalCache.peek(agent);
    if (cached && Date.now() - cached.at < 3000) return;
    this.prefetchTimer = window.setTimeout(() => {
      if (document.hidden || !this.root.hidden || Date.now() - this.prefetchedAt < 500) return;
      this.prefetchedAt = Date.now();
      void this.terminalCache.read(agent).catch(() => {});
    }, 120);
  }
  private queueKey(a: AgentInfo) { return a.agent_session?.value || a.pane_id; }
  private loadQueueHistory() {
    const history = new Map<string, QueuedReceipt[]>();
    try {
      const raw = JSON.parse(sessionStorage.getItem(QUEUE_HISTORY_KEY) || '{}') as Record<string, QueuedReceipt[]>;
      for (const [key, receipts] of Object.entries(raw)) {
        if (!Array.isArray(receipts)) continue;
        history.set(key, receipts.filter((r) => r && typeof r.id === 'string' && typeof r.text === 'string'
          && ['queuing', 'queued', 'dispatching', 'sent', 'failed'].includes(r.state)).slice(-20));
      }
    } catch { /* storage can be unavailable in private/locked-down browsers */ }
    return history;
  }
  private saveQueueHistory() {
    try { sessionStorage.setItem(QUEUE_HISTORY_KEY, JSON.stringify(Object.fromEntries(this.queueHistory))); }
    catch { /* the in-memory history still survives closing and reopening the dialog */ }
  }
  private findQueued(id: string) {
    for (const [key, receipts] of this.queueHistory) {
      const receipt = receipts.find((candidate) => candidate.id === id);
      if (receipt) return { key, receipts, receipt };
    }
  }
  private paintQueueItem(item: AgentQueueItem) {
    const found = this.findQueued(item.id);
    if (item.state === 'sent') {
      if (found) {
        found.receipts.splice(found.receipts.indexOf(found.receipt), 1);
        if (!found.receipts.length) this.queueHistory.delete(found.key);
      }
      const row = this.root.querySelector<HTMLElement>(`.queued-prompt[data-queue-id="${CSS.escape(item.id)}"]`);
      row?.remove();
      const tray = this.root.querySelector<HTMLElement>('.prompt-queue');
      if (tray && !tray.children.length) tray.hidden = true;
      if (item.target === this.openPane) {
        this.liveConversation = true;
        this.paintStatus('working');
        const note = this.root.querySelector<HTMLElement>('form.reply .reply-note');
        if (note) { note.textContent = 'queued prompt sent · watching live agent output'; note.setAttribute('data-state', 'sending'); }
      }
      this.saveQueueHistory();
      return;
    }
    if (found) { found.receipt.state = item.state; found.receipt.error = item.error; }
    const row = this.root.querySelector<HTMLElement>(`.queued-prompt[data-queue-id="${CSS.escape(item.id)}"]`);
    if (row) {
      row.classList.toggle('is-queued', item.state === 'queued');
      row.classList.toggle('is-dispatching', item.state === 'dispatching');
      row.classList.toggle('queue-failed', item.state === 'failed');
      const badge = row.querySelector('.queued-state');
      if (badge) badge.textContent = item.state === 'dispatching' ? 'sending…' : item.state;
      row.title = item.error ?? '';
    }
    this.saveQueueHistory();
    if (item.state === 'failed') this.repaintQueue?.();
  }
  /** Reconcile browser receipts with the bridge's durable Claude queue after reconnect/restart. */
  syncQueues(items: AgentQueueItem[], delivered: string[], bridgeStartedAt: number, agents: AgentInfo[]) {
    const active = new Set(items.map((item) => item.id));
    const sent = new Set(delivered);
    for (const id of sent) this.paintQueueItem({ id, target: '', text: '', queued_at: 0, state: 'sent' });
    for (const item of items) {
      let found = this.findQueued(item.id);
      if (!found) {
        const agent = agents.find((candidate) => candidate.pane_id === item.target);
        const key = agent ? this.queueKey(agent) : item.target;
        const receipts = this.queueHistory.get(key) ?? [];
        const receipt: QueuedReceipt = { id: item.id, text: item.text, state: item.state, queuedAt: item.queued_at, error: item.error };
        receipts.push(receipt); this.queueHistory.set(key, receipts.slice(-20));
        found = this.findQueued(item.id);
      }
      this.paintQueueItem(item);
    }
    // Older builds saved only a browser-side receipt. Be honest after a bridge restart instead
    // of displaying a green QUEUED badge for a prompt that no server actually holds.
    for (const [key, receipts] of this.queueHistory) for (const receipt of receipts) {
      if (agents.some(agent => this.queueKey(agent) === key && agentKind(agent) === 'codex')) continue;
      if ((receipt.state === 'queued' || receipt.state === 'dispatching') && receipt.queuedAt < bridgeStartedAt
        && !active.has(receipt.id) && !sent.has(receipt.id)) {
        receipt.state = 'failed'; receipt.error = 'bridge restarted before this queue became durable; queue it again';
      }
    }
    this.saveQueueHistory();
    if (this.currentAgent) void this.refreshNativeQueue(this.currentAgent);
  }
  /** Codex removes a native queue item when it starts (or is cancelled in its terminal).
   * Reconcile confirmed browser receipts against that queue, never against a busy/idle guess. */
  private async refreshNativeQueue(agent: AgentInfo) {
    if (agentKind(agent) !== 'codex' || agent.agent_session?.kind !== 'id' || document.hidden) return;
    const key = this.queueKey(agent);
    if (this.queueStatusPending.has(key)) return;
    const receipts = (this.queueHistory.get(key) ?? []).filter(receipt => receipt.state === 'queued'
      || receipt.state === 'dispatching' || (receipt.state === 'failed' && /bridge restarted before this queue became durable/.test(receipt.error ?? '')));
    if (!receipts.length) return;
    this.queueStatusPending.add(key);
    try {
      const result = await this.client.call('agent.queue.status', { target: agent.pane_id, session: agent.agent_session.value }) as { pending: PendingPrompt[] };
      if (!Array.isArray(result.pending)) throw new Error('Queue status is unavailable.');
      const pending = pendingQueueIds(receipts, result.pending);
      for (const receipt of receipts) {
        if (this.findQueued(receipt.id)?.receipt !== receipt) continue;
        this.paintQueueItem({ id: receipt.id, target: '', text: receipt.text, queued_at: receipt.queuedAt,
          state: pending.has(receipt.id) ? 'queued' : 'sent' });
      }
      if (this.currentAgent && this.queueKey(this.currentAgent) === key) this.repaintQueue?.();
    } catch {
      // A disconnected or older bridge is not evidence that queued work was delivered.
    } finally { this.queueStatusPending.delete(key); }
  }
  queueUpdate(item: AgentQueueItem) { this.paintQueueItem(item); }
  private saveConversation() {
    if (this.outputFrame !== undefined) cancelAnimationFrame(this.outputFrame);
    this.outputFrame = undefined; this.queuedOutput = undefined;
    this.readingHistory = false; this.latestOutput = undefined; this.historyRequest++;
    this.captureDraft?.(); this.captureDraft = undefined; this.repaintQueue = undefined; this.repaintOutbox = undefined;
    if (this.currentAgent) {
      const conversation = this.conversations.get(this.queueKey(this.currentAgent));
      const pre = this.root.querySelector<HTMLElement>('.terminal-output');
      if (conversation && pre) { conversation.scroll = pre.scrollTop; conversation.follow = pre.scrollHeight - pre.clientHeight - pre.scrollTop < 40; }
      this.terminalCache.cancel(this.currentAgent);
    }
    this.stopOutput?.(); this.stopOutput = undefined;
  }
  /** Provisional launch window; the returned token stops late completion stealing another chat. */
  showLaunch(stage: string, token?: number, error = false): number {
    if (token !== undefined && (token !== this.launchToken || !this.root.querySelector('.launch-win'))) return token;
    if (token === undefined) { this.close(); this.launchToken++; }
    this.root.innerHTML = `<div class="win launch-win"><div class="win-title"><b>Free agent</b><button type="button" class="close" aria-label="Close">✕</button></div><div class="win-body"><p class="launch-stage" role="status"></p><p>Your conversation will open here when the agent is ready.</p></div></div>`;
    this.root.querySelector('.launch-stage')!.textContent = stage;
    this.root.querySelector('.launch-stage')!.classList.toggle('failed', error);
    this.root.hidden = false;
    return this.launchToken;
  }
  launchActive(token: number) { return token === this.launchToken && !this.root.hidden && !!this.root.querySelector('.launch-win'); }
  close() {
    this.saveConversation();
    if (!this.root.hidden) audio.play('close');
    this.generation++;
    this.liveConversation = false;
    this.openPane = undefined;
    this.currentStatus = undefined;
    this.currentAgent = undefined;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prunePreviews();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.root.hidden = true; this.root.innerHTML = '';
  }

  private prunePreviews() {
    const retained = new Set([...this.conversations.values()].flatMap(c => [...c.images, ...c.outbox.flatMap(r => r.images)]).map(a => a.url));
    for (const url of this.previewUrls) if (!retained.has(url)) { URL.revokeObjectURL(url); this.previewUrls.delete(url); }
  }

  /** The recruitment desk turns the lower-level Herdr workspace/pane/agent calls into one clear
   * decision: put a supported agent in a known workspace, or give it a fresh one. */
  openHire(workspaces: WorkspaceSummary[], agents: AgentInfo[], preferredWorkspace?: string, initial?: { task: string; project?: string; newWorkspace?: boolean; onTaskSent?: () => void }) {
    this.saveConversation();
    audio.play('open');
    let generation = ++this.generation;
    this.liveConversation = false; this.openPane = undefined; this.currentStatus = undefined;
    this.currentAgent = undefined;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.prunePreviews();

    const kinds = ['codex', 'claude', 'gemini', 'cursor', 'opencode', 'copilot', 'pi', 'devin', 'agy',
      'cline', 'omp', 'mastracode', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'maki'];
    const sorted = [...workspaces].sort((a, b) => a.label.localeCompare(b.label));
    const defaultCwd = agents.find((agent) => agent.focused)?.foreground_cwd
      || agents.find((agent) => agent.focused)?.cwd
      || agents.find((agent) => agent.foreground_cwd || agent.cwd)?.foreground_cwd
      || agents.find((agent) => agent.cwd)?.cwd || '';
    const hasWorkspace = sorted.length > 0;
    this.root.innerHTML = `<div class="win hire-win">
      <div class="win-title"><span class="hire-title-icon" aria-hidden="true">＋</span><span>Hire agent <small>recruitment desk</small></span><span class="close">✕</span></div>
      <div class="win-body hire-body">
        <section class="hire-banner"><span class="hire-banner-mark" aria-hidden="true">!</span><span><small>Staff application</small><b>Put another specialist to work</b><em>The bridge creates the desk, starts the agent, and sends its first task.</em></span></section>
        <form class="hire-form">
          <label class="hire-field"><span>Agent type</span><select name="kind">${kinds.map((kind) => `<option value="${kind}">${displayName(kind)}</option>`).join('')}</select><small>Only agent kinds supported by this Herdr build are listed.</small></label>
          <label class="hire-field"><span>Name</span><input name="name" maxlength="40" value="codex" required autocomplete="off"><small>Shown in Herdr; the office still displays the agent type.</small></label>
          <section class="hire-settings">${settingsFields()}</section>
          <fieldset class="hire-placement"><legend>Placement</legend>
            <label><input type="radio" name="mode" value="existing" ${hasWorkspace ? 'checked' : 'disabled'}><span><b>Existing workspace</b><small>Add a new split pane to a current project.</small></span></label>
            <label><input type="radio" name="mode" value="new" ${hasWorkspace ? '' : 'checked'}><span><b>New workspace</b><small>Create a fresh Herdr workspace and root pane.</small></span></label>
          </fieldset>
          <section class="hire-panel" data-panel="existing" ${hasWorkspace ? '' : 'hidden'}>
            <label class="hire-field"><span>Workspace</span><select name="workspace_id">${sorted.map((workspace) => `<option value="${esc(workspace.workspace_id)}">${esc(workspace.label)} · ${esc(workspace.workspace_id)}</option>`).join('')}</select></label>
          </section>
          <section class="hire-panel" data-panel="new" ${hasWorkspace ? 'hidden' : ''}>
            <label class="hire-field"><span>Working directory</span><input name="cwd" value="${esc(defaultCwd || '')}" placeholder="/absolute/path/to/project" autocomplete="off"><small>Must already exist on the machine running the bridge.</small></label>
            <label class="hire-field"><span>Workspace name <i>optional</i></span><input name="label" maxlength="80" placeholder="defaults to folder name" autocomplete="off"></label>
          </section>
          <label class="hire-field hire-task"><span>First task <i>optional</i></span><div class="reply-attachments" hidden></div><textarea name="task" rows="4" maxlength="20000" placeholder="What should this agent start working on? Paste or drop a screenshot to go with it."></textarea><small class="hire-task-hint">Paste or drop up to 4 images · they are uploaded to the bridge and named in the task.</small></label>
          <div class="hire-actions"><span class="hire-note" aria-live="polite">The new hire will walk in through reception.</span><button type="submit"><span aria-hidden="true">＋</span> hire agent</button></div>
        </form>
      </div></div>`;
    this.root.hidden = false;

    const form = this.root.querySelector<HTMLFormElement>('.hire-form')!;
    if (preferredWorkspace && sorted.some(w => w.workspace_id === preferredWorkspace)) {
      (form.elements.namedItem('workspace_id') as HTMLSelectElement).value = preferredWorkspace;
    }
    const kind = form.elements.namedItem('kind') as HTMLSelectElement;
    const name = form.elements.namedItem('name') as HTMLInputElement;
    const loadSettings = bindSettings(form.querySelector<HTMLElement>('.hire-settings')!, this.client);
    void loadSettings(kind.value);
    let suggestedName = kind.value;
    kind.addEventListener('change', () => {
      if (!name.value.trim() || name.value.trim().toLowerCase() === suggestedName) name.value = kind.value;
      suggestedName = kind.value;
      void loadSettings(kind.value);
    });
    const panels = [...form.querySelectorAll<HTMLElement>('.hire-panel')];
    const showMode = (mode: string) => {
      for (const panel of panels) panel.hidden = panel.dataset.panel !== mode;
      const cwd = form.elements.namedItem('cwd') as HTMLInputElement;
      cwd.required = mode === 'new';
    };
    form.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => radio.addEventListener('change', () => showMode(radio.value)));
    showMode((form.elements.namedItem('mode') as RadioNodeList).value);
    const note = form.querySelector<HTMLElement>('.hire-note')!;
    const task = form.elements.namedItem('task') as HTMLTextAreaElement;
    const hint = form.querySelector<HTMLElement>('.hire-task-hint')!;
    // the tray's messages go under the task box, where the images are, not into the hire status
    const taskNote = (text: string, state = '') => { hint.textContent = text; hint.dataset.state = state; };
    const taskDraft = new PastedDraft(task, taskNote);
    if (initial) {
      task.value = initial.task; taskDraft.refresh(true);
      if (!preferredWorkspace && (initial.newWorkspace || initial.project?.startsWith('/'))) {
        if (initial.project?.startsWith('/')) (form.elements.namedItem('cwd') as HTMLInputElement).value = initial.project;
        const mode = form.querySelector<HTMLInputElement>('input[name="mode"][value="new"]')!;
        mode.checked = true; showMode('new');
      }
    }
    const tray = new ImageTray(form.querySelector<HTMLElement>('.hire-task .reply-attachments')!, taskNote, this.previewUrls, () => taskDraft.focus(), file => this.client.uploadImage(file));
    tray.listen(task, this.root.querySelector<HTMLElement>('.hire-win')!);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const data = new FormData(form), mode = String(data.get('mode'));
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')];
      const initiallyDisabled = new Set(controls.filter((control) => control.disabled));
      controls.forEach((control) => control.disabled = true);
      form.setAttribute('aria-busy', 'true'); button.textContent = 'hiring…';
      note.dataset.state = 'sending'; note.textContent = mode === 'new' ? 'Creating workspace and starting agent…' : 'Adding desk and starting agent…';
      const images = tray.take();
      const hireView = this.root.firstElementChild!;
      let launch: number | undefined;
      try {
        if (images.length) note.textContent = `Uploading ${images.length} image${images.length === 1 ? '' : 's'}…`;
        const taskText = await ImageTray.compose(String(data.get('task') ?? ''), images, (file) => this.client.uploadImage(file));
        if (generation !== this.generation) return;
        launch = this.showLaunch(mode === 'new' ? 'Creating workspace…' : 'Adding desk…');
        this.root.querySelector('.win-title b')!.textContent = String(data.get('name') || 'New agent');
        generation = this.generation;
        const result = await this.client.call('agent.hire', {
          mode, kind: data.get('kind'), name: data.get('name'), task: taskText,
          model: data.get('model') || '', effort: data.get('effort') || '',
          ...(mode === 'new' ? { cwd: data.get('cwd'), label: data.get('label') } : { workspace_id: data.get('workspace_id') }),
        }, { onProgress: stage => {
          this.showLaunch(stage === 'creating' ? 'Creating workspace…' : stage === 'starting' ? 'Starting agent…' : 'Ready · opening conversation…', launch);
          if (launch !== undefined && this.launchActive(launch)) this.root.querySelector('.win-title b')!.textContent = String(data.get('name') || 'New agent');
        } }) as { prompt_error?: string; agent?: AgentInfo };
        if (!result.prompt_error) initial?.onTaskSent?.();
        if (!this.launchActive(launch)) return;
        if (result.agent) {
          await this.open(result.agent);
          if (result.prompt_error && this.openPane === result.agent.pane_id) {
            const replyNote = this.root.querySelector<HTMLElement>('.reply-note');
            if (replyNote) { replyNote.textContent = `Agent hired, but the first task was not sent: ${result.prompt_error}`; replyNote.dataset.state = 'error'; }
          }
        } else this.showLaunch(result.prompt_error ? `Agent hired, but the first task was not sent: ${result.prompt_error}` : 'Agent ready · select it in the roster to open its conversation.', launch, !!result.prompt_error);
      } catch (error) {
        if (generation !== this.generation || (launch !== undefined && !this.launchActive(launch))) return;
        if ((error as { code?: string }).code === 'uncertain' && launch !== undefined) {
          this.showLaunch('Launch is unconfirmed. Check the roster before hiring again.', launch, true); return;
        }
        if (launch !== undefined) {
          this.root.replaceChildren(hireView);
          for (const image of images) if (!this.previewUrls.has(image.url)) { image.url = URL.createObjectURL(image.file); this.previewUrls.add(image.url); }
        }
        tray.restore(images);
        controls.forEach((control) => control.disabled = initiallyDisabled.has(control));
        showMode((form.elements.namedItem('mode') as RadioNodeList).value);
        form.removeAttribute('aria-busy'); button.innerHTML = '<span aria-hidden="true">＋</span> hire agent';
        note.dataset.state = 'error'; note.textContent = (error as Error).message;
      }
    });
    window.setTimeout(() => kind.focus(), 50);
  }

  /** Hand a receptionist task to the existing composer; never replace an unfinished message. */
  prepareTask(a: AgentInfo, text: string) {
    if (!this.writable) throw new Error('Task assignment is unavailable in this read-only office.');
    this.captureDraft?.();
    const key = this.queueKey(a), previous = this.conversations.get(key);
    if (previous?.draft.trim() || previous?.images.length) throw new Error('This agent already has an unsent message. Open their chat to finish it, or choose another agent. Your new task is kept here.');
    this.conversations.set(key, { ...(previous ?? { agent: a, images: [], outbox: [] }), draft: text });
    // The empty composer must not overwrite the staged task when open() saves the previous view.
    if (this.currentAgent && this.queueKey(this.currentAgent) === key) this.captureDraft = undefined;
    void this.open(a);
  }
  async open(a: AgentInfo) {
    this.saveConversation();
    this.transcriptTurns = []; this.repaintOutbox = undefined;
    const conversationKey = this.queueKey(a);
    const conversation = this.conversations.get(conversationKey) ?? { agent: a, draft: '', images: [], outbox: [] };
    conversation.agent = a; this.conversations.delete(conversationKey); this.conversations.set(conversationKey, conversation);
    while (this.conversations.size > 12) this.conversations.delete(this.conversations.keys().next().value!);
    this.prunePreviews();
    audio.play('open');
    const generation = ++this.generation;
    this.liveConversation = false;
    this.openPane = a.pane_id;
    this.currentAgent = a;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.currentStatus = a.agent_status;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const kind = agentKind(a);
    const canQueue = kind === 'claude' || (kind === 'codex' && a.agent_session?.kind === 'id' && !!a.agent_session.value);
    const job = workKindOf(a);
    const progress = this.progressOf?.(a.pane_id);
    const pct = progress ? Math.round(progress.inLevel / progress.toNext * 100) : 0;
    const model = a.model?.trim() || 'Not reported';
    const workspaceId = a.workspace_id?.trim() || a.pane_id.split(':', 1)[0];
    const workspaceName = a.workspace_name?.trim() || workspaceId;
    const sheet = progress ? `<section class="agent-sheet" aria-label="Agent progression">
      <div class="career"><span class="job" style="${jobIconStyle(job)}"></span><span><small>Current job</small><b>${WORK[job].title}</b></span></div>
      <div class="level-card" data-level-tier="${tierForLevel(progress.level)}"><span class="level-number">Lv ${progress.level}</span><span class="rank">${progress.rank}</span>
        <div class="xp-track" title="${progress.inLevel} of ${progress.toNext} shipments toward the next level"><i style="width:${pct}%"></i></div>
        <small>${progress.inLevel} / ${progress.toNext} to next level · ${progress.shipped} shipped</small></div>
      <div class="model-card"><small>Runtime model</small><b title="${esc(model)}">${esc(model)}</b><span>${a.model ? 'from session metadata' : 'unavailable'}</span></div>
      <div class="stat-grid">${WORK_KINDS.map((stat) => `<div class="stat" data-stat="${stat}"><span class="stat-icon" style="${statIconStyle(stat)}"></span><span>${WORK[stat].short}<small>${WORK[stat].stat}</small></span><b>${progress.stats[stat]}</b></div>`).join('')}</div>
    </section>` : '';
    this.root.innerHTML = `<div class="win conversation-win">
      <div class="win-title"><div class="avatar"></div><span>${esc(employeeName(a))} <small style="color:#536471">${handleOf(kind, a.pane_id)}</small></span>${progress ? `<span class="title-level" data-level-tier="${tierForLevel(progress.level)}" title="${progress.rank} · Level ${progress.level}">Lv ${progress.level}</span>` : ''}${a.employee_id ? '<button type="button" class="employee-customize">Employee profile</button>' : ''}<span class="close">✕</span></div>
      <nav class="recent-conversations" aria-label="Recent agents">${[...this.conversations.entries()].reverse().map(([key, c]) => `<button type="button" data-conversation="${esc(key)}" aria-current="${key === conversationKey ? 'page' : 'false'}">${esc(employeeName(c.agent))}${c.draft || c.images.length ? ' · draft' : ''}</button>`).join('')}</nav>
      <div class="win-body">
        <div class="conversation-summary"><span class="st ${a.agent_status}">${statusLabel(a.agent_status)}</span><span class="conversation-task">${esc(taskOf(a)) || 'Ready for a prompt'}</span></div>
        <details class="conversation-details"><summary>Agent details · workspace, career &amp; controls</summary>
        <section class="workspace-marquee" aria-label="Herdr workspace"><span class="workspace-mark" aria-hidden="true">W</span><span><small>Herdr workspace</small><b title="${esc(workspaceName)}">${esc(workspaceName)}</b></span><code>${esc(workspaceId)}</code></section>
        ${sheet}
        ${this.writable && supportsAgentSettings(kind) ? `<details class="live-agent-settings"><summary>Model &amp; effort</summary>${settingsFields(true)}${kind === 'codex' ? '<button type="button" data-settings-picker>Open terminal picker</button>' : ''}</details>` : ''}
        <dl><dt>status</dt><dd><span class="st ${a.agent_status}">${statusLabel(a.agent_status)}</span></dd>
        <dt>task</dt><dd>${esc(taskOf(a)) || '—'}</dd>${a.last_prompt && a.last_prompt.split('\n')[0].trim() !== taskOf(a) ? `<dt>asked</dt><dd class="asked">${esc(a.last_prompt.split('\n')[0].trim())}</dd>` : ''}${a.activity && a.agent_status === 'working' ? `<dt>now</dt><dd>${esc(a.activity)}</dd>` : ''}
        <dt>pane</dt><dd>${esc(a.pane_id)}</dd>
        <dt>cwd</dt><dd>${esc(a.foreground_cwd || a.cwd || '—')}</dd></dl>
        ${this.writable ? `<section class="agent-exit" aria-label="Exit agent">
          <span><b>Exit agent</b><small>Ends this agent and closes its Herdr pane.</small></span>
          <button type="button" data-request-exit>exit agent</button>
          <div class="agent-exit-confirm" hidden role="alert"><span>Close pane <code>${esc(a.pane_id)}</code>? This ends the running agent.</span><button type="button" data-confirm-exit>yes, exit + close pane</button><button type="button" data-cancel-exit>cancel</button></div>
        </section>` : ''}
        </details>
        <div class="terminal-tools"><div class="terminal-status" role="status"></div><div class="terminal-actions"><div class="view-switch" role="group" aria-label="Output view"><button type="button" data-view="conversation" title="What the agent said, from its own transcript">Conversation</button><button type="button" data-view="screen" title="The pane as it is on screen">Screen</button></div><button type="button" class="terminal-live" hidden>Back to live output</button><button type="button" class="terminal-history">Load earlier output</button>${this.writable ? '<button type="button" class="pane-widen" title="Zoom this pane in Herdr so its output has the whole tab. Click again to restore the split.">Widen pane</button>' : ''}</div></div><div class="agent-completion" hidden><span></span><button type="button" data-completion-journal>Open journal entry</button></div><div class="agent-wait-notice" role="status" hidden></div><div class="conversation-freshness" hidden><span role="status"></span><button type="button" data-live-screen>View live screen</button></div><div class="terminal-frame"><pre class="terminal-output" tabindex="0" aria-label="Agent output">loading…</pre><div class="transcript-output" tabindex="0" aria-label="Conversation" hidden></div></div>
        ${this.writable
          ? `<div class="prompt-outbox" aria-label="Your recent messages"></div><div class="prompt-queue" hidden aria-label="Queued prompts"></div><form class="reply${canQueue ? ' can-queue' : ''}">${canQueue ? `<div class="reply-stop-controls"><button type="button" data-stop-task${a.agent_status === 'working' ? '' : ' hidden'}>■ Stop task</button><button type="button" data-restore-prompt hidden>Restore last prompt</button></div>` : ''}<div class="reply-attachments" hidden></div><textarea rows="2" maxlength="20000" aria-label="Message to ${displayName(kind)}" placeholder="${a.agent_status === 'blocked' ? 'answer them…' : 'send a prompt to this agent…'}"></textarea><button type="submit">send</button>${canQueue ? `<button type="button" class="queue-button" data-queue title="Queue this prompt after ${displayName(kind)}’s current work (Tab)"><kbd>Tab</kbd><span>queue</span></button>` : ''}<button type="button" data-keys="Enter" title="press Enter in the agent's terminal">↵</button><span class="reply-note" aria-live="polite">Paste or drop images · Enter sends now${canQueue ? ' · Tab queues for later' : ''} · Shift+Enter for a new line</span></form>`
          : `<div class="reply-note ro">${this.readOnlyNote}</div>`}
      </div></div>`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-conversation]').forEach(button => {
      button.addEventListener('click', () => { const next = this.conversations.get(button.dataset.conversation!); if (next && next !== conversation) void this.open(next.agent); });
    });
    this.root.querySelector('.avatar')!.appendChild(avatarCanvas(a.pane_id, 32));
    this.root.querySelector('[data-completion-journal]')?.addEventListener('click', () => {
      const entry = this.currentAgent?.completed_task;
      if (entry) { this.close(); this.onJournalEntry?.(entry.entry_id); }
    });
    this.root.querySelector('.employee-customize')?.addEventListener('click', () => { this.close(); this.onProfile?.(a); });
    this.root.hidden = false;
    const pre = this.root.querySelector('pre')!;
    const cached = this.terminalCache.peek(a);
    if (cached?.source === 'visible') this.latestOutput = cached;
    if (cached) {
      renderTerminal(pre, tidyTerminal(cached.text) || '(no output)');
      pre.dataset.loaded = 'true'; pre.scrollTop = conversation.follow === false ? conversation.scroll ?? 0 : pre.scrollHeight;
      this.markStale('Last view · updating…');
    }
    const historyButton = this.root.querySelector<HTMLButtonElement>('.terminal-history')!;
    const liveButton = this.root.querySelector<HTMLButtonElement>('.terminal-live')!;
    let loadedEarlier = cached?.source !== undefined && cached.source !== 'visible';
    const holdOutput = () => {
      this.readingHistory = true;
      liveButton.hidden = false;
      if (this.outputFrame !== undefined) cancelAnimationFrame(this.outputFrame);
      this.outputFrame = undefined; this.queuedOutput = undefined;
    };
    const loadEarlier = async () => {
      if (historyButton.disabled) return;
      holdOutput();
      const request = ++this.historyRequest;
      historyButton.disabled = true; historyButton.textContent = 'Loading earlier output…';
      try {
        const snapshot = await this.terminalCache.readHistory(a);
        if (generation !== this.generation || request !== this.historyRequest) return;
        // History is a deliberate reading view. New live screens still update the cache, but
        // must neither cancel this read nor replace its scrollback while the user is reading.
        this.paintOutputNow(pre, snapshot);
        loadedEarlier = true; historyButton.textContent = 'Refresh earlier output';
      } catch (error) {
        if (generation === this.generation && request === this.historyRequest) {
          historyButton.textContent = 'Retry earlier output';
          if (!loadedEarlier) {
            // A failed history request must not keep suppressing recovered live frames.
            this.readingHistory = false; liveButton.hidden = true;
            if (this.latestOutput) this.paintOutputNow(pre, this.latestOutput);
            else void this.refresh(this.currentAgent ?? a, pre);
          } else this.markStale('Earlier output could not refresh · showing the last loaded history');
        }
      } finally { if (request === this.historyRequest) historyButton.disabled = false; }
    };
    historyButton.addEventListener('click', () => void loadEarlier());
    liveButton.addEventListener('click', () => {
      this.historyRequest++; this.readingHistory = false; liveButton.hidden = true;
      this.terminalCache.cancel(a);
      historyButton.disabled = false; historyButton.textContent = 'Load earlier output'; loadedEarlier = false;
      if (this.latestOutput) this.paintOutputNow(pre, this.latestOutput);
      pre.scrollTop = pre.scrollHeight;
      void this.refresh(this.currentAgent ?? a, pre);
    });
    const scrollUp = () => {
      if (!pre.dataset.loaded) return;
      holdOutput();
      if (pre.scrollTop <= 1 && !loadedEarlier) void loadEarlier();
    };
    pre.addEventListener('wheel', event => { if (event.deltaY < 0) scrollUp(); }, { passive: true });
    let touchY = 0;
    pre.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY ?? 0; }, { passive: true });
    pre.addEventListener('touchmove', event => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY + 2) scrollUp();
      touchY = y;
    }, { passive: true });
    pre.addEventListener('keydown', event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) scrollUp(); });
    pre.addEventListener('pointerdown', event => {
      // The scrollbar can also be dragged without a wheel, touch swipe, or key press.
      if (event.clientX - pre.getBoundingClientRect().left >= pre.clientWidth) holdOutput();
    });
    this.root.querySelector('[data-live-screen]')?.addEventListener('click', () => {
      this.root.querySelector<HTMLButtonElement>('[data-view="screen"]')?.click();
    });
    this.stopOutput = this.client.watchOutput(a.pane_id, snapshot => {
      if (generation !== this.generation || document.hidden) return;
      this.readVersion++;
      this.terminalCache.accept(a, snapshot); this.paintOutput(pre, snapshot);
    });
    this.transcriptAvailable = undefined; this.transcriptCheckFailed = false;
    this.paintStatus(this.currentStatus);
    this.applyView();
    this.root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
      if (button.disabled) return;
      this.view = button.dataset.view as OutputView; saveView(this.view); this.applyView();
      if (this.view === 'conversation') void this.refreshTranscript(a, generation);
      else if (this.latestOutput && !this.readingHistory) this.paintOutputNow(pre, this.latestOutput);
    }));
    void this.refreshTranscript(a, generation);
    const widen = this.root.querySelector<HTMLButtonElement>('.pane-widen');
    widen?.addEventListener('click', async () => {
      widen.disabled = true;
      try {
        const result = await this.client.call('pane.zoom', { target: a.pane_id, mode: 'toggle' }) as { zoomed?: boolean };
        if (generation !== this.generation) return;
        widen.textContent = result.zoomed ? 'Restore pane' : 'Widen pane';
        // The app in the pane reflows on resize; give it a beat, then read the wider screen.
        this.terminalCache.invalidate(a);
        setTimeout(() => { if (generation === this.generation && !this.root.hidden) void this.refresh(a, pre); }, 500);
      } catch (error) {
        const status = this.root.querySelector<HTMLElement>('.terminal-status');
        if (status) { status.textContent = `Could not resize the pane: ${(error as Error).message}`; }
      } finally { widen.disabled = false; }
    });
    const settings = this.root.querySelector<HTMLDetailsElement>('.live-agent-settings');
    if (settings) {
      const loadSettings = bindSettings(settings, this.client, true);
      let requested = false;
      settings.addEventListener('toggle', () => {
        if (settings.open && !requested) { requested = true; void loadSettings(kind, a.model); }
      });
      settings.querySelector<HTMLButtonElement>('[data-settings-picker]')?.addEventListener('click', async event => {
        const button = event.currentTarget as HTMLButtonElement;
        const note = settings.querySelector<HTMLElement>('.agent-settings-note')!;
        button.disabled = true;
        try {
          const result = await this.client.call('agent.settings.picker', { target: a.pane_id }) as { message: string };
          note.textContent = result.message;
        } catch (error) { note.textContent = (error as Error).message; }
        finally { button.disabled = false; }
      });
      settings.querySelectorAll<HTMLButtonElement>('[data-apply-setting]').forEach(button => {
        button.addEventListener('click', async () => {
          const field = button.dataset.applySetting!;
          const value = settings.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${field}"]`)!.value.trim();
          const note = settings.querySelector<HTMLElement>('.agent-settings-note')!;
          if (!value) { note.textContent = `Choose a ${field} first.`; return; }
          const buttons = [...settings.querySelectorAll<HTMLButtonElement>('button')];
          buttons.forEach(b => b.disabled = true);
          note.textContent = 'Applying…';
          try {
            const result = await this.client.call('agent.settings.update', { target: a.pane_id, [field]: value }) as { message: string };
            if (generation !== this.generation) return;
            note.textContent = result.message;
            this.onSettingsApplied?.(a, field, value);
            await this.refresh(a, pre);
          } catch (error) {
            if (generation === this.generation) note.textContent = (error as Error).message;
          } finally { buttons.forEach(b => b.disabled = false); }
        });
      });
    }
    const exitBox = this.root.querySelector<HTMLElement>('.agent-exit');
    if (exitBox) {
      const request = exitBox.querySelector<HTMLButtonElement>('[data-request-exit]')!;
      const confirmation = exitBox.querySelector<HTMLElement>('.agent-exit-confirm')!;
      const confirm = confirmation.querySelector<HTMLButtonElement>('[data-confirm-exit]')!;
      const cancel = confirmation.querySelector<HTMLButtonElement>('[data-cancel-exit]')!;
      request.addEventListener('click', () => {
        request.hidden = true;
        confirmation.hidden = false;
        confirm.focus();
      });
      cancel.addEventListener('click', () => {
        confirmation.hidden = true;
        request.hidden = false;
        request.focus();
      });
      confirm.addEventListener('click', async () => {
        request.disabled = confirm.disabled = cancel.disabled = true;
        exitBox.setAttribute('aria-busy', 'true');
        confirm.textContent = 'closing pane…';
        try {
          await this.client.call('pane.close', { target: a.pane_id, confirm: a.pane_id });
          if (generation === this.generation) this.close();
        } catch (e) {
          confirm.textContent = (e as Error).message;
          confirm.classList.add('failed');
          request.disabled = confirm.disabled = cancel.disabled = false;
          exitBox.removeAttribute('aria-busy');
        }
      });
    }
    // replies go straight to the pane through herdr's agent.prompt; keys through agent.send_keys
    const form = this.root.querySelector<HTMLFormElement>('form.reply');
    if (form) {
      const input = form.querySelector('textarea')!, note = form.querySelector('.reply-note')!;
      const buttons = [...form.querySelectorAll<HTMLButtonElement>('button')];
      const queue = this.root.querySelector<HTMLElement>('.prompt-queue')!;
      const queueKey = this.queueKey(a);
      const setNote = (text: string, state = '') => {
        note.textContent = text;
        state ? note.setAttribute('data-state', state) : note.removeAttribute('data-state');
      };
      const draft = new PastedDraft(input, setNote);
      const tray = new ImageTray(form.querySelector<HTMLElement>('.reply-attachments')!, setNote, this.previewUrls, () => draft.focus(), file => this.client.uploadImage(file));
      tray.listen(input, form);
      input.value = conversation.draft; draft.refresh(true); tray.restore(conversation.images);
      const capture = () => { conversation.draft = input.value; conversation.images = [...tray.attachments]; };
      this.captureDraft = capture;
      input.addEventListener('input', capture);
      const schedulePrompt = (run: () => Promise<boolean>) => {
        const pending = (this.promptChains.get(queueKey) ?? Promise.resolve(true)).then(run, run);
        this.promptChains.set(queueKey, pending);
        void pending.finally(() => { if (this.promptChains.get(queueKey) === pending) this.promptChains.delete(queueKey); });
        return pending;
      };
      const paintOutbox = () => {
        if (generation !== this.generation) return;
        const host = this.root.querySelector<HTMLElement>('.prompt-outbox')!;
        const follow = host.scrollHeight - host.clientHeight - host.scrollTop < 40;
        host.replaceChildren();
        for (const receipt of conversation.outbox) {
          const row = document.createElement('div'); row.className = 'prompt-echo'; row.dataset.messageId = receipt.id;
          row.dataset.deliveryState = receipt.state;
          const recorded = receipt.images.length > 0 && this.transcriptTurns.some(turn =>
            (!receipt.text.trim() || turn.prompt?.trim() === receipt.text.trim()) && receipt.images.every(image =>
              image.path && turn.images?.some(saved => saved.path === image.path)));
          row.dataset.imagesPending = String(receipt.images.length > 0 && !recorded);
          const heading = document.createElement('div'); const who = document.createElement('strong'); who.textContent = 'You';
          const state = document.createElement('span'); state.textContent = receipt.state === 'sending' ? 'sending…' : receipt.state;
          heading.append(who, state);
          const body = document.createElement('div'); body.className = 'prompt-echo-text'; renderPromptText(body, receipt.text);
          const pictures = document.createElement('div'); pictures.className = 'prompt-echo-images';
          renderPromptImages(pictures, receipt.images.map(image => ({ name: image.file.name, url: image.url,
            status: image.path ? 'Uploaded' : image.uploadError ? 'Upload failed' : image.uploading ? 'Uploading…' : 'Waiting to upload' })));
          row.append(heading, body, pictures);
          if (receipt.state === 'failed' || receipt.state === 'uncertain') {
            const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = receipt.state === 'uncertain' ? 'Check delivery' : 'Retry message'; retry.title = receipt.error ?? '';
            retry.addEventListener('click', async () => {
              if (receipt.state === 'uncertain') {
                retry.disabled = true;
                try {
                  const status = await this.client.call('agent.message.status', { target: a.pane_id, message_id: receipt.id }) as { state: string };
                  if (status.state === 'confirmed') { receipt.state = 'accepted'; paintOutbox(); }
                  else setNote('Delivery is still unconfirmed · check the agent output before sending a new message', 'error');
                } catch (error) { setNote((error as Error).message, 'error'); }
                finally { retry.disabled = false; }
                return;
              }
              if (input.value.trim() === receipt.text && tray.attachments.length === receipt.images.length && tray.attachments.every((image, i) => image === receipt.images[i])) { input.value = ''; draft.refresh(); tray.take(); capture(); }
              receipt.state = 'sending'; paintOutbox();
              void schedulePrompt(() => send('agent.prompt', { text: receipt.text, message_id: receipt.id }, receipt.text, receipt.images, undefined, receipt));
            }); row.append(retry);
          }
          host.append(row);
        }
        if (follow) host.scrollTop = host.scrollHeight;
      };
      this.repaintOutbox = paintOutbox;
      paintOutbox();
      /** Forget one receipt: out of the stored history, and off the screen. */
      const drop = (receipt: QueuedReceipt, node?: HTMLElement) => {
        const history = this.queueHistory.get(queueKey) ?? [];
        const index = history.indexOf(receipt); if (index >= 0) history.splice(index, 1);
        if (!history.length) this.queueHistory.delete(queueKey);
        this.saveQueueHistory();
        node?.remove();
        refreshClearAll();
        queue.hidden = !queue.children.length;
      };
      const dismiss = async (receipt: QueuedReceipt, node?: HTMLElement) => {
        try { await this.client.call('agent.queue.dismiss', { target: a.pane_id, queue_id: receipt.id }); drop(receipt, node); }
        catch (error) { setNote((error as Error).message, 'error'); }
      };
      /** One button for the lot, once a second failure has piled up behind the first. */
      const refreshClearAll = () => {
        const failed = (this.queueHistory.get(queueKey) ?? []).filter((r) => r.state === 'failed');
        let all = queue.querySelector<HTMLButtonElement>('.queue-clear-all');
        if (failed.length < 2) { all?.remove(); return; }
        if (!all) {
          all = document.createElement('button');
          all.type = 'button'; all.className = 'queue-clear-all'; all.textContent = 'clear failed';
          all.addEventListener('click', async () => {
            for (const receipt of [...(this.queueHistory.get(queueKey) ?? [])]) {
              if (receipt.state !== 'failed') continue;
              await dismiss(receipt, queue.querySelector<HTMLElement>(`[data-queue-id="${CSS.escape(receipt.id)}"]`) ?? undefined);
            }
            setNote('');
          });
        }
        queue.append(all);      // always last, however many rows arrive after it
      };

      const renderQueued = (receipt: QueuedReceipt) => {
        queue.hidden = false;
        const item = document.createElement('div'); item.className = `queued-prompt${receipt.state === 'queued' ? ' is-queued' : receipt.state === 'dispatching' ? ' is-dispatching' : receipt.state === 'failed' ? ' queue-failed' : ''}`;
        item.dataset.queueId = receipt.id;
        item.title = receipt.error ?? '';
        const badge = document.createElement('span'); badge.className = 'queued-state'; badge.textContent = receipt.state === 'queuing' ? 'queuing…' : receipt.state === 'dispatching' ? 'sending…' : receipt.state;
        const body = document.createElement('div'); body.className = 'queued-text'; renderPromptText(body, receipt.text);
        item.append(badge, body); queue.append(item);
        if (receipt.state === 'failed') {
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'queue-retry';
          const inspect = /unconfirmed|session changed|verified agent session/i.test(receipt.error ?? '');
          retry.textContent = inspect ? 'inspect output' : 'retry';
          retry.addEventListener('click', async () => {
            if (inspect) { pre.focus(); setNote('Check the agent output, then dismiss this stopped item to continue the queue. It will not be resent.'); return; }
            if (input.value && input.value !== receipt.text) return;
            input.value = receipt.text;
            draft.refresh(true);
            await dismiss(receipt, item);
            setNote('recovered prompt · queue it again when ready'); draft.focus();
          });
          // A failure you have read is just noise, and there was no way to be rid of one: retry
          // was the only button, and it refuses while the box holds different text — so a failure
          // could sit there permanently. This throws it away without touching what you are typing.
          const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'queue-clear';
          clear.textContent = 'dismiss'; clear.title = 'Dismiss after checking the agent; continue remaining queued prompts'; clear.setAttribute('aria-label', 'Dismiss this stopped prompt after inspection');
          clear.addEventListener('click', () => { void dismiss(receipt, item); });
          // One grid cell, not two: the row is a three-column grid, so a fourth child wraps onto
          // a line of its own and the × ends up orphaned under the text.
          const actions = document.createElement('span'); actions.className = 'queue-actions';
          actions.append(retry, clear);
          item.append(actions);
        }
        return item;
      };
      this.repaintQueue = () => { queue.replaceChildren(); for (const receipt of this.queueHistory.get(queueKey) ?? []) renderQueued(receipt); refreshClearAll(); queue.hidden = !queue.children.length; };
      this.repaintQueue();
      void this.refreshNativeQueue(a);
      const showQueued = (prompt: string, images: Attachment[]) => {
        const receipt: QueuedReceipt = {
          id: crypto.randomUUID(),
          text: prompt || `${images.length} image attachment${images.length === 1 ? '' : 's'}`,
          state: 'queuing', queuedAt: Date.now(),
        };
        const history = this.queueHistory.get(queueKey) ?? [];
        history.push(receipt); this.queueHistory.set(queueKey, history.slice(-20)); this.saveQueueHistory();
        return { receipt, item: renderQueued(receipt) };
      };
      const paintQueued = (queued: { receipt: QueuedReceipt; item: HTMLElement }) => {
        const current = [...this.root.querySelectorAll<HTMLElement>('.queued-prompt')]
          .find((item) => item.dataset.queueId === queued.receipt.id);
        for (const item of new Set([queued.item, current].filter((candidate): candidate is HTMLElement => !!candidate))) {
          item.classList.toggle('is-queued', queued.receipt.state === 'queued');
          item.classList.toggle('is-dispatching', queued.receipt.state === 'dispatching');
          item.classList.toggle('queue-failed', queued.receipt.state === 'failed');
          const state = item.querySelector('.queued-state'); if (state) state.textContent = queued.receipt.state;
        }
      };
      const send = async (method: string, params: Record<string, unknown>, prompt?: string, images: Attachment[] = [], queued?: { receipt: QueuedReceipt; item: HTMLElement }, receipt?: OutboxReceipt) => {
        const isMessage = method === 'agent.prompt' || method === 'agent.queue';
        if (!isMessage) buttons.filter(el => el.hasAttribute('data-keys')).forEach(el => el.disabled = true);
        setNote(images.length ? `uploading ${images.length} image${images.length === 1 ? '' : 's'}…` : method === 'agent.queue' ? `adding to ${displayName(kind)} queue…` : 'sending…', 'sending');
        if (method === 'agent.prompt') {
          if (generation === this.generation) {
            this.liveConversation = true;
            if (this.readingHistory) liveButton.click();
          }
          if (receipt) { receipt.state = 'sending'; receipt.error = undefined; paintOutbox(); }
        }
        try {
          let callParams = params;
          if (isMessage && images.length) {
            callParams = { ...params, text: await ImageTray.compose(String(params.text ?? ''), images, (file) => this.client.uploadImage(file)) };
            paintOutbox();
            setNote('image uploaded · sending prompt…', 'sending');
          }
          const result = await this.client.call(method, { target: a.pane_id, ...callParams }) as { state?: AgentQueueState } | undefined;
          this.terminalCache.invalidate(a); if (generation === this.generation) this.readVersion++;
          if (receipt) { receipt.state = 'accepted'; paintOutbox(); }
          if (queued) {
            if (result?.state === 'sent') {
              this.paintQueueItem({ id: queued.receipt.id, target: a.pane_id, text: queued.receipt.text,
                queued_at: queued.receipt.queuedAt, state: 'sent' });
            } else if (this.findQueued(queued.receipt.id)) {
              queued.receipt.state = result?.state ?? 'queued'; this.saveQueueHistory();
              paintQueued(queued);
            }
          }
          const queuePending = queued ? !!this.findQueued(queued.receipt.id) : false;
          if (queued) void this.refreshNativeQueue(a);
          setNote(method === 'agent.prompt' ? 'accepted · waiting for agent output'
            : method === 'agent.queue' ? queuePending ? 'queued · type another and press Tab' : 'queued prompt sent · watching live agent output'
            : 'Enter sent', method === 'agent.queue' && !queuePending ? 'sending' : 'sent');
          setTimeout(() => { if (generation === this.generation) void this.refresh(a, pre); }, 100);
          return true;
        }
        catch (e) {
          if (receipt) { receipt.state = (e as { code?: string }).code === 'uncertain' ? 'uncertain' : 'failed'; receipt.error = (e as Error).message; paintOutbox(); }
          if (queued) {
            queued.receipt.state = 'failed'; this.saveQueueHistory();
            queued.receipt.error = (e as Error).message; this.saveQueueHistory(); paintQueued(queued); this.repaintQueue?.();
          }
          setNote((e as Error).message, 'error');
          return false;
        }
        finally {
          buttons.forEach((el) => (el.disabled = false));
          form.removeAttribute('aria-busy');
          if (generation === this.generation && !this.root.hidden) draft.focus();
        }
      };
      const submitMessage = (method: 'agent.prompt' | 'agent.queue') => {
        const text = input.value.trim(); if (!text && !tray.length) return;
        const images = tray.take(); input.value = ''; draft.refresh();
        capture();
        const queued = method === 'agent.queue' ? showQueued(text, images) : undefined;
        let receipt: OutboxReceipt | undefined;
        if (method === 'agent.prompt') {
          receipt = conversation.outbox.find(r => r.state === 'failed' && r.text === text && r.images.length === images.length && r.images.every((image, i) => image === images[i]));
          if (!receipt) { receipt = { id: crypto.randomUUID(), text, images, state: 'sending' }; conversation.outbox.push(receipt); }
          conversation.outbox = conversation.outbox.slice(-10); paintOutbox();
        }
        const run = () => send(method, method === 'agent.queue' && queued
          ? { text, queue_id: queued.receipt.id, queued_at: queued.receipt.queuedAt }
          : { text, message_id: receipt!.id }, text, images, queued, receipt);
        const pending = method === 'agent.queue'
          ? (this.queueChains.get(queueKey) ?? Promise.resolve(true)).then(run, run)
          : schedulePrompt(run);
        if (method === 'agent.queue') this.queueChains.set(queueKey, pending);
        void pending.then((sent) => {
          if (!sent && receipt?.state !== 'uncertain') {
            if (generation === this.generation) {
              if (!input.value) { input.value = text; draft.refresh(true); draft.focus(); tray.restore(images); }
              capture();
            } else if (!conversation.draft) { conversation.draft = text; conversation.images = images; }
          }
        });
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault(); submitMessage('agent.prompt');
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && canQueue && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (input.value.trim() || tray.length)) {
          e.preventDefault(); submitMessage('agent.queue');
        } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
      });
      const stopTask = form.querySelector<HTMLButtonElement>('[data-stop-task]');
      const restorePrompt = form.querySelector<HTMLButtonElement>('[data-restore-prompt]');
      let stoppedPrompt: { text: string; images: Attachment[] } | undefined;
      const restoreStopped = () => {
        if (!stoppedPrompt) return;
        input.value = stoppedPrompt.text; tray.take(); tray.restore(stoppedPrompt.images);
        draft.refresh(true); capture(); draft.focus();
        if (restorePrompt) restorePrompt.hidden = true;
        setNote('Task stopped · edit the prompt and send when ready');
      };
      restorePrompt?.addEventListener('click', restoreStopped);
      stopTask?.addEventListener('click', async () => {
        if (stopTask.disabled) return;
        stopTask.disabled = true; stopTask.textContent = 'Stopping…';
        setNote('Requesting stop…', 'sending');
        const latest = [...conversation.outbox].reverse().find(r => r.state === 'accepted' || r.state === 'working');
        try {
          const result = await this.client.call('agent.interrupt', { target: a.pane_id }) as { stopped: boolean; prompt: string };
          if (!result.stopped) throw Error('Stop has not been confirmed.');
          const matches = latest && (!result.prompt || result.prompt === latest.text || result.prompt.startsWith(latest.text + '\n\nAttached image file'));
          stoppedPrompt = matches ? { text: latest.text, images: latest.images } : { text: result.prompt || (this.currentAgent ?? a).last_prompt || '', images: [] };
          if (generation !== this.generation) {
            if (!conversation.draft && !conversation.images.length) { conversation.draft = stoppedPrompt.text; conversation.images = stoppedPrompt.images; }
            return;
          }
          if (!input.value.trim() && !tray.length) restoreStopped();
          else {
            if (restorePrompt) restorePrompt.hidden = false;
            setNote('Task stopped · your draft was kept. Restore last prompt to replace it.');
          }
          this.terminalCache.invalidate(a); void this.refresh(a, pre);
          stopTask.hidden = true;
        } catch (error) { if (generation === this.generation) setNote((error as Error).message, 'error'); }
        finally { stopTask.disabled = false; stopTask.textContent = '■ Stop task'; }
      });
      form.querySelector('[data-queue]')?.addEventListener('click', () => submitMessage('agent.queue'));
      form.querySelector('[data-keys]')!.addEventListener('click', () => void send('agent.send_keys', { keys: ['Enter'] }));
      setTimeout(() => {
        const selection = document.getSelection();
        if (generation === this.generation && !this.root.hidden && !this.readingHistory
          && !(selection && !selection.isCollapsed && pre.contains(selection.anchorNode))) input.focus();
      }, 50);
    }
    await this.refresh(a, pre);
    this.scheduleRefresh(a, pre, generation);
    // History never delays first output, and may not replace a newer live screen.
    if (generation === this.generation && a.agent_status === 'idle') {
      const version = this.readVersion;
      void this.terminalCache.readHistory(a).then(snapshot => {
        if (generation === this.generation && version === this.readVersion) this.paintOutput(pre, snapshot);
      }).catch(() => {});
    }
  }

  /** Keep the open modal's badge and response hint in sync with bridge polling. */
  sync(agents: AgentInfo[]) {
    this.terminalCache.retain(agents);
    for (const [key, conversation] of this.conversations) {
      const active = agents.find(a => this.queueKey(a) === key);
      if (active) conversation.agent = active;
      else if (key !== (this.currentAgent && this.queueKey(this.currentAgent))) this.conversations.delete(key);
    }
    if (!this.openPane || this.root.hidden) return;
    const agent = agents.find((candidate) => candidate.pane_id === this.openPane);
    if (!agent) { this.close(); return; }
    if (this.currentAgent && this.terminalCache.key(agent) !== this.terminalCache.key(this.currentAgent)) {
      void this.open(agent); return;
    }
    this.currentAgent = agent;
    this.paintWorkspace(agent);
    this.paintModel(agent.model);
    this.refreshProgress(agent.pane_id);
    const sameStatus = agent.agent_status === this.currentStatus;
    this.paintStatus(agent.agent_status);
    if (sameStatus) return;
    // Status and terminal frames arrive independently. Do not let a healthy-but-older stream
    // lease defer the final screen until the next fallback timer.
    this.terminalCache.invalidate(agent);
    const pre = this.root.querySelector<HTMLPreElement>('.terminal-output');
    if (pre && !document.hidden) { void this.refresh(agent, pre); void this.refreshTranscript(agent, this.generation); }
    if (agent.agent_status === 'working') {
      const conversation = this.conversations.get(this.queueKey(agent));
      for (const receipt of conversation?.outbox ?? []) if (receipt.state === 'accepted') {
        receipt.state = 'working';
        const badge = this.root.querySelector(`[data-message-id="${CSS.escape(receipt.id)}"] > div > span`);
        if (badge) badge.textContent = 'working';
      }
    }
    if (!this.liveConversation) return;
    const form = this.root.querySelector<HTMLFormElement>('form.reply');
    const note = form?.querySelector<HTMLElement>('.reply-note');
    if (!form || !note || form.hasAttribute('aria-busy')) return;
    if (agent.agent_status === 'working') {
      note.textContent = this.view === 'conversation' && this.transcriptAvailable !== false ? 'agent is working · waiting for saved messages' : 'agent is working · live output';
      note.setAttribute('data-state', 'sending');
    } else if (agent.agent_status === 'blocked') {
      note.textContent = 'agent needs your input';
      note.setAttribute('data-state', 'error');
    } else {
      note.textContent = 'response complete · ready for another prompt';
      note.setAttribute('data-state', 'sent');
    }
  }

  refreshProgress(paneId: string) {
    if (this.openPane !== paneId || this.root.hidden) return;
    const progress = this.progressOf?.(paneId); if (!progress) return;
    const set = (selector: string, value: string) => { const el = this.root.querySelector(selector); if (el && el.textContent !== value) el.textContent = value; };
    this.root.querySelectorAll<HTMLElement>('.title-level,.level-card').forEach(el => { el.dataset.levelTier = tierForLevel(progress.level); });
    const title = this.root.querySelector<HTMLElement>('.title-level'); if (title) title.title = `${progress.rank} · Level ${progress.level}`;
    set('.title-level', `Lv ${progress.level}`);
    set('.level-number', `Lv ${progress.level}`);
    set('.rank', progress.rank);
    const bar = this.root.querySelector<HTMLElement>('.xp-track i');
    if (bar) { const width = `${Math.round(progress.inLevel / progress.toNext * 100)}%`; if (bar.style.width !== width) bar.style.width = width; }
    set('.level-card > small', `${progress.inLevel} / ${progress.toNext} to next level · ${progress.shipped} shipped`);
    for (const stat of WORK_KINDS) set(`.stat[data-stat="${stat}"] b`, String(progress.stats[stat]));
  }

  private paintModel(model?: string | null) {
    const value = model?.trim() || 'Not reported';
    const card = this.root.querySelector<HTMLElement>('.model-card');
    const label = card?.querySelector<HTMLElement>('b');
    const source = card?.querySelector<HTMLElement>('span');
    if (label && label.textContent !== value) { label.textContent = value; label.title = value; }
    if (source) { const text = model ? 'from session metadata' : 'unavailable'; if (source.textContent !== text) source.textContent = text; }
  }

  private paintWorkspace(agent: AgentInfo) {
    const workspaceId = agent.workspace_id?.trim() || agent.pane_id.split(':', 1)[0];
    const workspaceName = agent.workspace_name?.trim() || workspaceId;
    const label = this.root.querySelector<HTMLElement>('.workspace-marquee b');
    const id = this.root.querySelector<HTMLElement>('.workspace-marquee code');
    if (label && label.textContent !== workspaceName) { label.textContent = workspaceName; label.title = workspaceName; }
    if (id && id.textContent !== workspaceId) id.textContent = workspaceId;
  }

  private paintStatus(status: AgentStatus) {
    this.currentStatus = status;
    this.paintConversationFreshness();
    const stopTask = this.root.querySelector<HTMLButtonElement>('[data-stop-task]');
    if (stopTask) stopTask.hidden = status !== 'working';
    const wait = this.currentAgent?.wait_notice;
    const completed = status === 'idle' ? this.currentAgent?.completed_task : null;
    const completion = this.root.querySelector<HTMLElement>('.agent-completion');
    if (completion) { completion.hidden = !completed || !!wait; completion.querySelector('span')!.textContent = completed ? `Task complete · ${completed.title} · Ready for another prompt` : ''; }
    const label = wait ? wait.kind === 'rate_limit' ? 'Rate limited' : 'Waiting to retry' : completed ? 'done' : statusLabel(status);
    this.root.querySelectorAll<HTMLElement>('.win-body .st').forEach(badge => { badge.className = `st ${wait ? 'retry-wait' : completed ? 'done' : status}`; badge.textContent = label; });
    const notice = this.root.querySelector<HTMLElement>('.agent-wait-notice');
    if (notice) { notice.hidden = !wait; notice.textContent = wait ? `${label} · ${wait.detail}. Task is paused.` : ''; }
  }

  /** Keep the open terminal view moving while the selected agent works on the prompt. */
  private scheduleRefresh(a: AgentInfo, pre: HTMLPreElement, generation: number) {
    if (generation !== this.generation || this.root.hidden || document.hidden) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(async () => {
      if (generation !== this.generation || this.root.hidden) return;
      void this.refreshNativeQueue(this.currentAgent ?? a);
      if (this.view === 'conversation' || this.transcriptCheckFailed) void this.refreshTranscript(this.currentAgent ?? a, generation);
      if (!pre.dataset.loaded || !this.client.outputFresh(a.pane_id)) await this.refresh(a, pre);
      if (generation === this.generation && !this.root.hidden) this.scheduleRefresh(a, pre, generation);
    }, this.view === 'conversation' && this.transcriptAvailable !== false ? (this.currentStatus === 'working' ? 750 : 1500) : this.client.outputStreaming ? 5000 : this.liveConversation && this.currentStatus === 'working' ? 900 : 1800);
  }

  private paintOutput(pre: HTMLPreElement, result: TerminalSnapshot) {
    if (result.source === 'visible') this.latestOutput = result;
    if (this.readingHistory && pre.dataset.loaded) return;
    if (!pre.dataset.loaded) { this.paintOutputNow(pre, result); return; }
    this.queuedOutput = { pre, result, generation: this.generation };
    if (this.outputFrame !== undefined) return;
    this.outputFrame = requestAnimationFrame(() => {
      const queued = this.queuedOutput;
      this.outputFrame = undefined; this.queuedOutput = undefined;
      if (queued && queued.generation === this.generation && queued.pre.isConnected && !this.root.hidden && !document.hidden) this.paintOutputNow(queued.pre, queued.result);
    });
  }
  /** Show one face of the output and hide the other; the screen's history controls only make
   *  sense on the screen. A window whose agent has no transcript on this machine stays on the
   *  screen with the conversation button explaining why. */
  private applyView() {
    const conversation = this.view === 'conversation' && this.transcriptAvailable !== false;
    const pre = this.root.querySelector<HTMLElement>('.terminal-output'), box = this.root.querySelector<HTMLElement>('.transcript-output');
    if (!pre || !box) return;
    pre.hidden = conversation; box.hidden = !conversation;
    this.root.dataset.outputView = conversation ? 'conversation' : 'screen';
    this.paintConversationFreshness();
    this.root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => {
      const own = button.dataset.view === 'conversation';
      button.setAttribute('aria-pressed', String(own === conversation));
      if (own) {
        button.disabled = this.transcriptAvailable === false;
        button.title = this.transcriptAvailable === false ? 'No transcript for this agent on this machine' : 'What the agent said, from its own transcript';
      }
    });
    const history = this.root.querySelector<HTMLElement>('.terminal-history'), live = this.root.querySelector<HTMLElement>('.terminal-live');
    if (history) history.hidden = conversation;
    if (live && conversation) live.hidden = true;
    else if (live) live.hidden = !this.readingHistory;
  }
  /** Pull the agent's own transcript and paint it; the bridge serves it from a cached parse, so
   *  this is cheap to call on the same cadence as the screen. */
  private async refreshTranscript(a: AgentInfo, generation: number) {
    if (document.hidden || this.root.hidden || this.transcriptInFlight === generation) return;
    this.transcriptInFlight = generation;
    const request = ++this.transcriptRequest;
    try {
      const result = await this.client.call('agent.transcript', { target: a.pane_id }) as { available: boolean; turns: Turn[] };
      if (generation !== this.generation || request !== this.transcriptRequest) return;
      this.transcriptCheckFailed = false;
      const first = this.transcriptAvailable === undefined;
      this.transcriptAvailable = result.available;
      if (first || !result.available) this.applyView();
      if (result.available) this.paintTranscript(result.turns);
      this.paintConversationFreshness();
    } catch {
      if (generation !== this.generation || request !== this.transcriptRequest) return;
      // An older bridge has no transcript method; the screen is still there.
      if (this.transcriptAvailable === undefined) {
        // Transport failure is not evidence that this agent has no transcript. Keep the
        // Conversation button available and retry in the background while showing Screen.
        this.view = 'screen'; this.applyView();
      }
      this.transcriptCheckFailed = true; this.paintConversationFreshness();
    } finally { if (this.transcriptInFlight === generation) this.transcriptInFlight = undefined; }
  }
  private paintConversationFreshness() {
    const banner = this.root.querySelector<HTMLElement>('.conversation-freshness');
    if (!banner) return;
    banner.hidden = !!this.currentAgent?.wait_notice || this.view !== 'conversation' || this.transcriptAvailable === false;
    const active = this.currentStatus === 'working' || this.currentStatus === 'blocked';
    const name = this.currentAgent ? displayName(agentKind(this.currentAgent)) : 'Agent';
    const text = this.transcriptCheckFailed
      ? 'Conversation update failed · showing saved messages. Retrying…'
      : this.transcriptAvailable === undefined ? 'Loading saved conversation…'
      : active ? `${name} is ${this.currentStatus === 'blocked' ? 'waiting for input' : 'working'} · messages appear here when saved. Screen shows live activity.`
      : 'Saved conversation · checks for updates automatically';
    const label = banner.querySelector('span')!;
    if (label.textContent !== text) label.textContent = text;
  }
  private paintTranscript(turns: Turn[]) {
    const box = this.root.querySelector<HTMLElement>('.transcript-output');
    if (!box) return;
    const working = this.currentStatus === 'working' || this.currentStatus === 'blocked';
    const key = JSON.stringify([turns, working]);
    if (box.dataset.key === key) return;
    this.transcriptTurns = turns;
    const selection = box.ownerDocument.getSelection();
    const selected = selection && !selection.isCollapsed && box.contains(selection.anchorNode);
    const follow = !selected && (!box.dataset.loaded || box.scrollHeight - box.clientHeight - box.scrollTop < 40);
    const scroll = box.scrollTop;
    const when = (at?: number) => at ? `<time datetime="${new Date(at).toISOString()}">${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>` : '';
    const last = turns[turns.length - 1];
    box.innerHTML = turns.map(t => `<article class="turn">${t.prompt || t.images?.length ? `<div class="turn-prompt"><span><b>You</b>${when(t.at)}</span>${t.prompt ? `<p>${esc(t.prompt)}</p>` : ''}<div class="turn-images"></div></div>` : ''}${t.reply ? `<div class="turn-reply">${renderMarkdown(t.reply)}</div>` : t === last && working ? '<div class="turn-reply turn-pending">Working on it…</div>' : ''}</article>`).join('')
      || '<p class="turn-empty">No conversation recorded yet.</p>';
    box.querySelectorAll<HTMLElement>('.turn').forEach((row, index) => {
      const host = row.querySelector<HTMLElement>('.turn-images');
      if (host) renderPromptImages(host, (turns[index].images ?? []).map(image => ({ name: image.name,
        url: image.url?.startsWith('/api/image?') ? image.url : undefined, status: 'Attached' })));
    });
    this.repaintOutbox?.();
    box.dataset.key = key; box.dataset.loaded = 'true';
    box.scrollTop = follow ? box.scrollHeight : scroll;
  }
  private paintOutputNow(pre: HTMLPreElement, result: TerminalSnapshot) {
    if (this.rawOutput.get(pre) === result.text) { this.clearOutputStatus(); return; }
    this.rawOutput.set(pre, result.text);
    const text = tidyTerminal(result.text) || '(no output)';
    const selection = pre.ownerDocument.getSelection();
    const selected = selection && !selection.isCollapsed && pre.contains(selection.anchorNode);
    const follow = !selected && (!pre.dataset.loaded || pre.scrollHeight - pre.clientHeight - pre.scrollTop < 40);
    const scroll = pre.scrollTop;
    if (renderTerminal(pre, text)) pre.scrollTop = follow ? pre.scrollHeight : scroll;
    pre.dataset.loaded = 'true';
    this.clearOutputStatus();
  }
  private clearOutputStatus() {
    const status = this.root.querySelector<HTMLElement>('.terminal-status');
    if (status?.textContent) status.textContent = '';
    if (status?.title) status.title = '';
    delete this.root.querySelector<HTMLElement>('.terminal-frame')?.dataset.stale;
  }
  /** The box still shows an older screen: say so in the status line and veil the output, so a
   *  reader does not take a snapshot from a while ago for what the agent is doing now. */
  private markStale(message: string) {
    const status = this.root.querySelector<HTMLElement>('.terminal-status');
    if (status) status.textContent = message;
    const frame = this.root.querySelector<HTMLElement>('.terminal-frame');
    if (frame) frame.dataset.stale = message;
  }

  /** (Re)load the pane's recent output into the box. */
  private async refresh(a: AgentInfo, pre: HTMLPreElement) {
    const generation = this.generation, version = ++this.readVersion;
    const current = () => generation === this.generation && version === this.readVersion && pre.isConnected && !this.root.hidden;
    try {
      const agent = this.currentAgent ?? a;
      const result = await this.terminalCache.read(agent, this.liveConversation || this.currentStatus === 'working' || this.currentStatus === 'blocked');
      if (!current()) return;
      this.paintOutput(pre, result);
    } catch (error) {
      if (!current()) return;
      if ((error as Error).name === 'AbortError') return;
      if (!pre.dataset.loaded) pre.textContent = '(Waiting for output to reconnect…)';
      const status = this.root.querySelector<HTMLElement>('.terminal-status')!;
      if (pre.dataset.loaded) this.markStale('Last view · update unavailable, retrying…');
      else status.textContent = /disconnect|network|fetch|closed/i.test((error as Error).message)
        ? 'Connection interrupted · retrying automatically…'
        : /timeout|timed out/i.test((error as Error).message) ? 'Output request timed out · retrying automatically…'
        : `Output read failed · ${(error as Error).message} · retrying…`;
      status.title = (error as Error).message;
    }
  }
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
