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
import { dismissOnBackdrop, replayAnimation, snapShut } from './motion';
import './dialog.css';
export { renderTerminal } from './terminal-renderer';

type QueuedReceipt = { id: string; text: string; state: 'queuing' | AgentQueueState; queuedAt: number; error?: string };
/** `seen` is how many turns already carried these words when the message was sent, so an older
 *  "continue" is not taken for this one. `filed` latches once the transcript shows the message, or
 *  its turn has ended, or the agent never started on it: from then on its receipt is history. */
type OutboxReceipt = { id: string; text: string; images: Attachment[]; state: 'sending' | 'accepted' | 'working' | 'failed' | 'uncertain'; error?: string; seen?: number; filed?: boolean };
type Reading = { scroll: number; follow: boolean };
/** Memory only, like the screen cache: what the agent said never goes into browser storage. */
type Conversation = { agent: AgentInfo; draft: string; images: Attachment[]; scroll?: number; follow?: boolean; outbox: OutboxReceipt[]; turns?: Turn[]; transcript?: Reading };
const QUEUE_HISTORY_KEY = 'herdr-story:queued-prompts';
/** How long a delivered message may wait for the agent to start on it before its receipt stops
 *  being held under the conversation. A slash command or an answer to a menu never becomes a turn. */
const RECEIPT_HOLD_MS = 8000;
const HIRE_FIELDS = ['kind', 'name', 'mode', 'workspace_id', 'cwd', 'label', 'model', 'effort', 'task'] as const;
type HireDraft = Record<typeof HIRE_FIELDS[number], string>;

/** 16px icons on the pixel lattice of src/icons.ts, for the controls that used to be glyphs. */
const icon = (rects: number[][]) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">${rects.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('')}</svg>`;
const CLOSE_ICON = icon([[3, 3, 2, 2], [5, 5, 2, 2], [7, 7, 2, 2], [9, 9, 2, 2], [11, 11, 2, 2], [11, 3, 2, 2], [9, 5, 2, 2], [5, 9, 2, 2], [3, 11, 2, 2]]);
/** The return key: down the right side, along the bottom, and an arrowhead pointing left. */
const ENTER_ICON = icon([[12, 3, 2, 8], [5, 9, 9, 2], [4, 8, 2, 4], [6, 7, 1, 6], [2, 9, 2, 2]]);
const CLOSE_BUTTON = `<button type="button" class="close" aria-label="Close">${CLOSE_ICON}</button>`;
const STOP_LABEL = '<i class="stop-mark" aria-hidden="true"></i>Stop task';
const words = (text?: string) => (text ?? '').replace(/\s+/g, ' ').trim();
/** Play a one-shot animation class and take it off again: a node that is hidden and shown later
 *  would otherwise make its entrance twice. */
function playOnce(el: HTMLElement, name: string) {
  replayAnimation(el, name);
  el.addEventListener('animationend', () => el.classList.remove(name), { once: true });
}
/** Stands in for the reply of a turn the agent is still working on. */
const PENDING = '\0';

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

/** Whether a scroll box is following its newest content. Geometry cannot answer that by itself: a
 *  box that sat at the bottom stops being there the moment anything under it grows (a receipt, a
 *  queued prompt, an attached image), and one that was painted while its face was hidden was never
 *  anywhere. So following is remembered, only the reader scrolling away ends it, and the box is
 *  put back on its last line whenever its size changes underneath it. */
class Follow {
  pinned = true;
  private top = 0;
  private shown: boolean;
  private observer: ResizeObserver;
  constructor(private box: HTMLElement) {
    this.shown = box.clientHeight > 0;
    box.addEventListener('scroll', () => {
      if (!box.clientHeight) return;    // a hidden face has no position worth remembering
      this.top = box.scrollTop;
      this.pinned = box.scrollHeight - box.clientHeight - box.scrollTop < 40;
    }, { passive: true });
    this.observer = new ResizeObserver(() => {
      const shown = box.clientHeight > 0;
      if (shown && this.pinned) { if (!selectingIn(box)) box.scrollTop = box.scrollHeight; }
      // a face coming back from hidden reopens where it was being read
      else if (shown && !this.shown) box.scrollTop = this.top;
      this.shown = shown;
    });
    this.observer.observe(box);
  }
  /** Go to the newest line and stay there. */
  pin() { this.pinned = true; this.box.scrollTop = this.box.scrollHeight; this.top = this.box.scrollTop; }
  /** Return to a place the reader had scrolled to. */
  hold(top: number) { this.pinned = false; this.top = top; this.box.scrollTop = top; }
  /** What to restore next time. A visible box is measured, because a scroll made in this same
   *  task has not reported itself yet; a hidden one can only be remembered. */
  reading(): Reading {
    const box = this.box;
    return box.clientHeight ? { scroll: box.scrollTop, follow: box.scrollHeight - box.clientHeight - box.scrollTop < 40 } : { scroll: this.top, follow: this.pinned };
  }
  stop() { this.observer.disconnect(); }
}
/** A selection being made inside the box: moving the text under it would lose the reader's place. */
function selectingIn(box: HTMLElement) {
  const selection = box.ownerDocument.getSelection();
  return !!selection && !selection.isCollapsed && box.contains(selection.anchorNode);
}

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
  /** What the conversation face was last painted from, so an unchanged poll costs nothing. */
  private transcriptKey = '';
  private turnParts = new WeakMap<HTMLElement, { asked: string; said: string }>();
  /** Turns fetched while a roster row was hovered, for agents that have not been opened yet. */
  private warmTurns = new Map<string, Turn[]>();
  private outputFollow?: Follow;
  private transcriptFollow?: Follow;
  private recentKey = '';
  private factsKey = '';
  private detailsOpen = false;
  /** What had the keyboard before the window opened; it gets it back when the window closes. */
  private opener?: HTMLElement;
  private hireDraft?: HireDraft;
  /** A one-off line for the strip above the output: a new hire's welcome. */
  private greeting?: { pane: string; text: string };
  private lastShipped?: string;
  private stopOutput?: () => void;
  private launchToken = 0;
  private queueHistory = this.loadQueueHistory();
  private promptChains = new Map<string, Promise<boolean>>();
  private queueChains = new Map<string, Promise<boolean>>();
  private queueStatusPending = new Set<string>();
  progressOf?: (paneId: string) => AgentProgress;
  onJournalEntry?: (id: string) => void;
  onProfile?: (a: AgentInfo) => void;
  /** A hire from the recruitment desk went through; the office may want to look at the new desk. */
  onHired?: (a: AgentInfo) => void;
  /** Set from the bridge snapshot. Remotely exposed bridges are read-only unless opted in. */
  writable = false;
  /** Shown under the reply box when nothing can be sent. The demo swaps in its own reason. */
  readOnlyNote = 'remote bridge is read-only · set HERDR_STORY_WRITE=1 before starting it to reply';
  constructor(private client: OfficeClient) {
    this.terminalCache = new TerminalCache(async (target, source, signal) => {
      const result = await this.client.call('agent.read', { target, source, ...(source === 'visible' ? {} : { lines: 120 }) }, { signal }) as { read: { text: string } };
      return result.read.text;
    });
    dismissOnBackdrop(this.root, () => this.close());
    // closest, not the target itself: the press lands on the icon inside the button
    this.root.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.close')) this.close(); });
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
      // The window opens on the conversation face, so that is the face worth having ready. An
      // agent opened before already carries its turns in its conversation record.
      const key = this.queueKey(agent);
      if (this.view !== 'conversation' || this.conversations.get(key)?.turns) return;
      void (this.client.call('agent.transcript', { target: agent.pane_id }) as Promise<{ available: boolean; turns: Turn[] }>).then(result => {
        if (!result.available) return;
        this.warmTurns.delete(key); this.warmTurns.set(key, result.turns);
        while (this.warmTurns.size > 12) this.warmTurns.delete(this.warmTurns.keys().next().value!);
      }).catch(() => {});
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
        // The prompt leaves the tray for the conversation rather than vanishing: it waits under
        // the output as a delivered message until the transcript has it. Only a dispatch reported
        // for this pane does this; a reconnect's replay of old deliveries carries no target.
        const conversation = this.currentAgent && this.conversations.get(this.queueKey(this.currentAgent));
        if (found && conversation) {
          // Delivered, not yet seen to be worked on: a roster update that still says idle must not
          // file it before the agent has picked it up.
          const receipt: OutboxReceipt = { id: found.receipt.id, text: found.receipt.text, images: [], state: 'accepted', seen: this.turnsSaying(found.receipt.text) };
          conversation.outbox = [...conversation.outbox, receipt].slice(-10);
          this.repaintOutbox?.(); this.holdReceipt(conversation, receipt);
          // one queued a moment ago has just had its own sound
          if (Date.now() - found.receipt.queuedAt > 1000) audio.blip('send');
        }
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
      const states = () => (this.queueHistory.get(key) ?? []).map(receipt => `${receipt.id}:${receipt.state}`).join('|');
      const before = states();
      for (const receipt of receipts) {
        if (this.findQueued(receipt.id)?.receipt !== receipt) continue;
        this.paintQueueItem({ id: receipt.id, target: '', text: receipt.text, queued_at: receipt.queuedAt,
          state: pending.has(receipt.id) ? 'queued' : 'sent' });
      }
      // Rows are patched as they change. The tray is only rebuilt when one changed kind, so a
      // poll that found nothing new does not fold a pasted prompt the reader had opened.
      if (states() !== before && this.currentAgent && this.queueKey(this.currentAgent) === key) this.repaintQueue?.();
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
      if (conversation && this.outputFollow) ({ scroll: conversation.scroll, follow: conversation.follow } = this.outputFollow.reading());
      if (conversation && this.transcriptFollow) conversation.transcript = this.transcriptFollow.reading();
      this.terminalCache.cancel(this.currentAgent);
    }
    this.outputFollow?.stop(); this.transcriptFollow?.stop();
    this.outputFollow = this.transcriptFollow = undefined;
    this.stopOutput?.(); this.stopOutput = undefined;
  }
  /** Provisional launch window; the returned token stops late completion stealing another chat.
   *  Later stages update the window that is already up, so nothing is rebuilt while it waits.
   *  `step` moves the bar: 1 a desk, 2 the agent starting, 3 ready; left out, the bar stays put. */
  showLaunch(stage: string, token?: number, error = false, step?: 1 | 2 | 3): number {
    if (token !== undefined && (token !== this.launchToken || !this.root.querySelector('.launch-win'))) return token;
    if (token === undefined) {
      // replacing the recruitment form is not a close: the keyboard stays with this window
      const opener = this.root.hidden ? this.focused() : this.opener;
      this.opener = undefined; this.close(); this.launchToken++; this.opener = opener;
      this.root.innerHTML = `<div class="win launch-win"><div class="win-title"><b>Free agent</b>${CLOSE_BUTTON}</div><div class="win-body"><p class="launch-stage" role="status"></p><div class="launch-track" aria-hidden="true"><i></i></div><p>Your conversation will open here when the agent is ready.</p></div></div>`;
    }
    const win = this.root.querySelector<HTMLElement>('.launch-win')!, line = win.querySelector<HTMLElement>('.launch-stage')!;
    line.textContent = stage; line.classList.toggle('failed', error);
    win.classList.toggle('failed', error);
    if (step) win.dataset.step = String(step);
    this.root.hidden = false;
    return this.launchToken;
  }
  launchActive(token: number) { return token === this.launchToken && !this.root.hidden && !!this.root.querySelector('.launch-win'); }
  /** Whatever holds the keyboard outside this window, if it is something that can take it back. */
  private focused() {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body && !(active instanceof HTMLCanvasElement) && !this.root.contains(active) ? active : undefined;
  }
  close() {
    this.saveConversation();
    const opener = this.root.hidden ? undefined : this.opener;
    this.opener = undefined;
    if (!this.root.hidden) snapShut(this.root.firstElementChild);
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
    // Back to the roster row (or button) the window was opened from, so the list can be worked
    // through from the keyboard. A window that opens straight after this one takes focus itself.
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  private prunePreviews() {
    const retained = new Set([...this.conversations.values()].flatMap(c => [...c.images, ...c.outbox.flatMap(r => r.images)]).map(a => a.url));
    for (const url of this.previewUrls) if (!retained.has(url)) { URL.revokeObjectURL(url); this.previewUrls.delete(url); }
  }

  /** The recruitment desk turns the lower-level Herdr workspace/pane/agent calls into one clear
   * decision: put a supported agent in a known workspace, or give it a fresh one. */
  openHire(workspaces: WorkspaceSummary[], agents: AgentInfo[], preferredWorkspace?: string, initial?: { task: string; project?: string; newWorkspace?: boolean; onTaskSent?: () => void }) {
    this.saveConversation();
    if (this.root.hidden) this.opener = this.focused();
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
      <div class="win-title"><span class="hire-title-icon" aria-hidden="true">＋</span><span>Hire agent <small>recruitment desk</small></span>${CLOSE_BUTTON}</div>
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
    // A form dismissed by a stray Escape comes back as it was left. A task handed over by the
    // front desk is a new application, and wins over anything remembered.
    const draft = initial ? undefined : this.hireDraft;
    if (draft) {
      if ([...kind.options].some(option => option.value === draft.kind)) kind.value = draft.kind;
      name.value = draft.name;
    }
    const loadSettings = bindSettings(form.querySelector<HTMLElement>('.hire-settings')!, this.client);
    void loadSettings(kind.value).then(() => {
      // the choices arrive after the form; a model typed in the meantime is left alone
      const model = form.elements.namedItem('model') as HTMLInputElement, effort = form.elements.namedItem('effort') as HTMLSelectElement;
      if (!draft || !form.isConnected || kind.value !== draft.kind || model.disabled || model.value) return;
      model.value = draft.model; model.dispatchEvent(new Event('input', { bubbles: true }));
      // the form remembers itself on change, so the effort is not lost to a second stray close
      effort.value = draft.effort; effort.dispatchEvent(new Event('change', { bubbles: true }));
    });
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
    if (draft) {
      // a desk that was clicked says where the hire goes; otherwise the placement is as it was left
      const mode = form.querySelector<HTMLInputElement>(`input[name="mode"][value="${draft.mode === 'new' ? 'new' : 'existing'}"]`)!;
      if (!preferredWorkspace && !mode.disabled) mode.checked = true;
      if (!preferredWorkspace && sorted.some(w => w.workspace_id === draft.workspace_id)) (form.elements.namedItem('workspace_id') as HTMLSelectElement).value = draft.workspace_id;
      if (draft.cwd) (form.elements.namedItem('cwd') as HTMLInputElement).value = draft.cwd;
      (form.elements.namedItem('label') as HTMLInputElement).value = draft.label;
    }
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
    } else if (draft) {
      task.value = draft.task; taskDraft.refresh(true);
      note.textContent = 'Picked up where you left off.';
    }
    // Attached images are not remembered: their previews are released when the window closes.
    const remember = () => {
      const data = new FormData(form);
      this.hireDraft = Object.fromEntries(HIRE_FIELDS.map(field => [field, String(data.get(field) ?? '')])) as HireDraft;
    };
    form.addEventListener('input', remember); form.addEventListener('change', remember);
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
      audio.blip('press');
      note.dataset.state = 'sending'; note.textContent = mode === 'new' ? 'Creating workspace and starting agent…' : 'Adding desk and starting agent…';
      const images = tray.take();
      const hireView = this.root.firstElementChild!;
      let launch: number | undefined;
      try {
        if (images.length) note.textContent = `Uploading ${images.length} image${images.length === 1 ? '' : 's'}…`;
        const taskText = await ImageTray.compose(String(data.get('task') ?? ''), images, (file) => this.client.uploadImage(file));
        if (generation !== this.generation) return;
        launch = this.showLaunch(mode === 'new' ? 'Creating workspace…' : 'Adding desk…', undefined, false, 1);
        this.root.querySelector('.win-title b')!.textContent = String(data.get('name') || 'New agent');
        generation = this.generation;
        const result = await this.client.call('agent.hire', {
          mode, kind: data.get('kind'), name: data.get('name'), task: taskText,
          model: data.get('model') || '', effort: data.get('effort') || '',
          ...(mode === 'new' ? { cwd: data.get('cwd'), label: data.get('label') } : { workspace_id: data.get('workspace_id') }),
        }, { onProgress: stage => {
          if (stage === 'creating') this.showLaunch('Creating workspace…', launch, false, 1);
          else if (stage === 'starting') this.showLaunch('Starting agent…', launch, false, 2);
          else this.showLaunch('Ready · opening conversation…', launch, false, 3);
        } }) as { prompt_error?: string; agent?: AgentInfo };
        this.hireDraft = undefined;
        audio.blip(result.prompt_error ? 'error' : 'ok');
        if (!result.prompt_error) initial?.onTaskSent?.();
        if (result.agent) this.onHired?.(result.agent);
        if (!this.launchActive(launch)) return;
        if (result.agent) {
          this.welcome(result.agent, mode === 'new' ? String(data.get('label') || '').trim() || String(data.get('cwd')).split('/').filter(Boolean).pop()
            : sorted.find(workspace => workspace.workspace_id === data.get('workspace_id'))?.label);
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
        audio.blip('error');
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
  /** Say hello in the strip above the output when a new hire's conversation opens. */
  welcome(a: AgentInfo, workspace = a.workspace_name?.trim()) {
    const greeting = this.greeting = { pane: a.pane_id, text: `Welcome aboard, ${employeeName(a)}${workspace ? ` · desk in ${workspace}` : ''}` };
    window.setTimeout(() => { if (this.greeting === greeting) { this.greeting = undefined; this.paintConversationFreshness(); } }, 8000);
  }
  /** `caret` is the composer's selection when the window is being rebuilt under someone typing. */
  async open(a: AgentInfo, caret?: [number, number]) {
    // A tab, or the same agent rebuilt, replaces a window that is already up: the details stay as
    // they were, and only a real opening has an opener to give the keyboard back to.
    if (this.root.hidden) { this.opener = this.focused(); this.detailsOpen = false; }
    else this.detailsOpen = !!this.root.querySelector<HTMLDetailsElement>('.conversation-details')?.open;
    this.saveConversation();
    this.transcriptTurns = []; this.transcriptKey = ''; this.recentKey = ''; this.factsKey = factsOf(a); this.repaintOutbox = undefined;
    this.lastShipped = undefined;
    const conversationKey = this.queueKey(a);
    const conversation = this.conversations.get(conversationKey) ?? { agent: a, draft: '', images: [], outbox: [] };
    conversation.agent = a; this.conversations.delete(conversationKey); this.conversations.set(conversationKey, conversation);
    while (this.conversations.size > 12) this.conversations.delete(this.conversations.keys().next().value!);
    conversation.turns ??= this.warmTurns.get(conversationKey);
    this.warmTurns.delete(conversationKey);
    this.prunePreviews();
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
      <div class="win-title"><div class="avatar"></div><span><span class="title-name">${esc(employeeName(a))}</span> <small style="color:#536471">${handleOf(kind, a.pane_id)}</small></span>${progress ? `<span class="title-level" data-level-tier="${tierForLevel(progress.level)}" title="${progress.rank} · Level ${progress.level}">Lv ${progress.level}</span>` : ''}${a.employee_id ? '<button type="button" class="employee-customize">Employee profile</button>' : ''}${CLOSE_BUTTON}</div>
      <nav class="recent-conversations" aria-label="Recent agents"></nav>
      <div class="win-body">
        <div class="conversation-summary"><span class="st ${a.agent_status}">${statusLabel(a.agent_status)}</span><span class="conversation-task">${esc(taskOf(a)) || 'Ready for a prompt'}</span></div>
        <details class="conversation-details"${this.detailsOpen ? ' open' : ''}><summary>Agent details · workspace, career &amp; controls</summary>
        <section class="workspace-marquee" aria-label="Herdr workspace"><span class="workspace-mark" aria-hidden="true">W</span><span><small>Herdr workspace</small><b title="${esc(workspaceName)}">${esc(workspaceName)}</b></span><code>${esc(workspaceId)}</code></section>
        ${sheet}
        ${this.writable && supportsAgentSettings(kind) ? `<details class="live-agent-settings"><summary>Model &amp; effort</summary>${settingsFields(true)}${kind === 'codex' ? '<button type="button" data-settings-picker>Open terminal picker</button>' : ''}</details>` : ''}
        <dl class="agent-facts">${factsOf(a)}</dl>
        ${this.writable ? `<section class="agent-exit" aria-label="Exit agent">
          <span><b>Exit agent</b><small>Ends this agent and closes its Herdr pane.</small></span>
          <button type="button" data-request-exit>exit agent</button>
          <div class="agent-exit-confirm" hidden role="alert"><span>Close pane <code>${esc(a.pane_id)}</code>? This ends the running agent.</span><button type="button" data-confirm-exit>yes, exit + close pane</button><button type="button" data-cancel-exit>cancel</button></div>
        </section>` : ''}
        </details>
        <div class="terminal-tools"><div class="terminal-status" role="status"></div><div class="terminal-actions"><button type="button" class="terminal-live" hidden>Back to live output</button><button type="button" class="terminal-history">Load earlier output</button>${this.writable ? '<button type="button" class="pane-widen" title="Zoom this pane in Herdr so its output has the whole tab. Click again to restore the split.">Widen pane</button>' : ''}<div class="view-switch" role="group" aria-label="Output view"><button type="button" data-view="conversation" title="What the agent said, from its own transcript">Conversation</button><button type="button" data-view="screen" title="The pane as it is on screen">Screen</button></div></div></div><div class="conversation-rail"><div class="agent-wait-notice" role="status" hidden></div><div class="agent-completion" hidden><span></span><button type="button" data-completion-journal>Open journal entry</button></div><div class="conversation-freshness"><span role="status"></span><button type="button" data-other-face></button></div></div><div class="terminal-frame"><pre class="terminal-output" tabindex="0" aria-label="Agent output">loading…</pre><div class="transcript-output" tabindex="0" aria-label="Conversation" hidden></div></div>
        ${this.writable
          ? `<div class="prompt-outbox" aria-label="Your recent messages"></div><div class="prompt-queue" hidden aria-label="Queued prompts"></div><form class="reply${canQueue ? ' can-queue' : ''}">${canQueue ? `<div class="reply-stop-controls"><button type="button" data-stop-task aria-label="■ Stop task"${a.agent_status === 'working' ? '' : ' hidden'}>${STOP_LABEL}</button><button type="button" data-restore-prompt hidden>Restore last prompt</button></div>` : ''}<div class="reply-attachments" hidden></div><textarea rows="2" maxlength="20000" aria-label="Message to ${displayName(kind)}" placeholder="${a.agent_status === 'blocked' ? 'answer them…' : 'send a prompt to this agent…'}"></textarea><button type="submit">send</button>${canQueue ? `<button type="button" class="queue-button" data-queue title="Queue this prompt after ${displayName(kind)}’s current work (Tab)"><kbd>Tab</kbd><span>queue</span></button>` : ''}<button type="button" data-keys="Enter" title="press Enter in the agent's terminal" aria-label="Press Enter in the agent's terminal">${ENTER_ICON}</button><span class="reply-note" aria-live="polite">${matchMedia('(pointer:coarse)').matches ? `Paste images · send goes now${canQueue ? ' · queue holds it for later' : ''}` : `Paste or drop images · Enter sends now${canQueue ? ' · Tab queues for later' : ''} · Shift+Enter for a new line`}</span></form>`
          : `<div class="reply-note ro">${this.readOnlyNote}</div>`}
      </div></div>`;
    // one listener on the strip: its tabs are patched as conversations come, go and gain drafts
    this.root.querySelector('.recent-conversations')!.addEventListener('click', event => {
      const key = (event.target as HTMLElement).closest<HTMLElement>('[data-conversation]')?.dataset.conversation;
      const next = key === undefined ? undefined : this.conversations.get(key);
      if (!next || next === this.conversations.get(this.queueKey(this.currentAgent ?? a))) return;
      audio.blip('tick'); void this.open(next.agent);
    });
    this.paintRecent();
    this.root.querySelector('.avatar')!.appendChild(avatarCanvas(a.pane_id, 32));
    this.root.querySelector('[data-completion-journal]')?.addEventListener('click', () => {
      const entry = this.currentAgent?.completed_task;
      if (entry) { this.close(); this.onJournalEntry?.(entry.entry_id); }
    });
    this.root.querySelector('.employee-customize')?.addEventListener('click', () => { this.close(); this.onProfile?.(a); });
    this.root.hidden = false;
    const pre = this.root.querySelector('pre')!;
    const output = this.outputFollow = new Follow(pre);
    const transcript = this.transcriptFollow = new Follow(this.root.querySelector<HTMLElement>('.transcript-output')!);
    const cached = this.terminalCache.peek(a);
    if (cached?.source === 'visible') this.latestOutput = cached;
    if (cached) {
      renderTerminal(pre, tidyTerminal(cached.text) || '(no output)');
      pre.dataset.loaded = 'true';
      if (conversation.follow === false) output.hold(conversation.scroll ?? 0); else output.pin();
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
      output.pin();
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
    this.root.querySelector('[data-other-face]')!.addEventListener('click', () => {
      this.root.querySelector<HTMLButtonElement>('[data-view][aria-pressed="false"]')?.click();
    });
    this.stopOutput = this.client.watchOutput(a.pane_id, snapshot => {
      if (generation !== this.generation || document.hidden) return;
      this.readVersion++;
      this.terminalCache.accept(a, snapshot); this.paintOutput(pre, snapshot);
    });
    this.transcriptAvailable = undefined; this.transcriptCheckFailed = false;
    this.paintStatus(this.currentStatus);
    this.applyView();
    // The conversation face opens on what it last showed, the way the screen opens on its cached
    // frame; the transcript read below only has to bring it up to date.
    if (conversation.turns) {
      this.paintTranscript(conversation.turns);
      if (conversation.transcript?.follow === false) transcript.hold(conversation.transcript.scroll);
      this.paintConversationFreshness();
    }
    this.root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => {
      if (button.disabled) return;
      if (button.getAttribute('aria-pressed') !== 'true') audio.blip('tick');
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
          note.textContent = result.message; note.dataset.state = '';
        } catch (error) { note.textContent = (error as Error).message; note.dataset.state = 'error'; }
        finally { button.disabled = false; }
      });
      settings.querySelectorAll<HTMLButtonElement>('[data-apply-setting]').forEach(button => {
        button.addEventListener('click', async () => {
          const field = button.dataset.applySetting!;
          const value = settings.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${field}"]`)!.value.trim();
          const note = settings.querySelector<HTMLElement>('.agent-settings-note')!;
          const say = (text: string, state = '') => { note.textContent = text; note.dataset.state = state; };
          if (!value) { say(`Choose a ${field} first.`); return; }
          const buttons = [...settings.querySelectorAll<HTMLButtonElement>('button')];
          buttons.forEach(b => b.disabled = true);
          say('Applying…');
          try {
            const result = await this.client.call('agent.settings.update', { target: a.pane_id, [field]: value }) as { message: string };
            if (generation !== this.generation) return;
            say(result.message, 'sent'); audio.blip('ok');
            this.onSettingsApplied?.(a, field, value);
            await this.refresh(a, pre);
          } catch (error) {
            if (generation === this.generation) { say((error as Error).message, 'error'); audio.blip('error'); }
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
      input.value = conversation.draft; draft.refresh(!caret); tray.restore(conversation.images);
      const capture = () => { conversation.draft = input.value; conversation.images = [...tray.attachments]; this.paintRecent(); };
      this.captureDraft = capture;
      input.addEventListener('input', capture);
      const schedulePrompt = (run: () => Promise<boolean>) => {
        const pending = (this.promptChains.get(queueKey) ?? Promise.resolve(true)).then(run, run);
        this.promptChains.set(queueKey, pending);
        void pending.finally(() => { if (this.promptChains.get(queueKey) === pending) this.promptChains.delete(queueKey); });
        return pending;
      };
      // Rows are kept by receipt and rebuilt only when their own state changes, so a poll that
      // repaints the transcript does not fold a pasted prompt someone has just opened.
      const echoes = new Map<OutboxReceipt, { row: HTMLElement; key: string }>();
      const uploadOf = (image: Attachment) => image.path ? 'Uploaded' : image.uploadError ? 'Upload failed' : image.uploading ? 'Uploading…' : 'Waiting to upload';
      const echo = (receipt: OutboxReceipt) => {
        const row = document.createElement('div'); row.className = 'prompt-echo'; row.dataset.messageId = receipt.id;
        const heading = document.createElement('div'); const who = document.createElement('strong'); who.textContent = 'You';
        heading.append(who, document.createElement('span'));
        const body = document.createElement('div'); body.className = 'prompt-echo-text'; renderPromptText(body, receipt.text);
        const pictures = document.createElement('div'); pictures.className = 'prompt-echo-images';
        renderPromptImages(pictures, receipt.images.map(image => ({ name: image.file.name, url: image.url, status: uploadOf(image) })));
        row.append(heading, body, pictures);
        if (receipt.state === 'failed' || receipt.state === 'uncertain') {
          const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = receipt.state === 'uncertain' ? 'Check delivery' : 'Retry message'; retry.title = receipt.error ?? '';
          retry.addEventListener('click', async () => {
            if (receipt.state === 'uncertain') {
              retry.disabled = true;
              try {
                const status = await this.client.call('agent.message.status', { target: a.pane_id, message_id: receipt.id }) as { state: string };
                if (status.state === 'confirmed') { receipt.state = 'accepted'; paintOutbox(); this.holdReceipt(conversation, receipt); }
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
        return row;
      };
      const paintOutbox = () => {
        if (generation !== this.generation) return;
        const host = this.root.querySelector<HTMLElement>('.prompt-outbox')!;
        const follow = host.scrollHeight - host.clientHeight - host.scrollTop < 40;
        const rows = conversation.outbox.map(receipt => {
          // delivered and being worked on are the same row with a different word on it
          const delivered = receipt.state === 'accepted' || receipt.state === 'working';
          const key = JSON.stringify([delivered || receipt.state, receipt.error ?? '', receipt.images.map(uploadOf)]);
          const kept = echoes.get(receipt);
          const row = kept?.key === key ? kept.row : echo(receipt);
          echoes.set(receipt, { row, key });
          row.dataset.deliveryState = receipt.state; row.dataset.filed = String(this.filed(receipt));
          row.querySelector(':scope > div > span')!.textContent = receipt.state === 'sending' ? 'sending…' : receipt.state;
          return row;
        });
        for (const receipt of echoes.keys()) if (!conversation.outbox.includes(receipt)) echoes.delete(receipt);
        if (rows.length !== host.children.length || rows.some((row, index) => host.children[index] !== row)) host.replaceChildren(...rows);
        if (follow) host.scrollTop = host.scrollHeight;
      };
      this.repaintOutbox = paintOutbox;
      if (a.agent_status !== 'working') this.settleReceipts(conversation);
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
          if (receipt) { receipt.state = 'accepted'; paintOutbox(); this.holdReceipt(conversation, receipt); }
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
          setNote(method === 'agent.prompt' ? `delivered to ${employeeName(conversation.agent)} · waiting for a reply`
            : method === 'agent.queue' ? queuePending ? `queued for ${employeeName(conversation.agent)} · type another and press Tab` : 'queued prompt sent · watching live agent output'
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
          audio.blip('error');
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
        // Enter and Tab press their buttons too, so a send from the keyboard is seen as well as heard.
        audio.blip(method === 'agent.queue' ? 'queue' : 'send');
        replayAnimation(form.querySelector(method === 'agent.queue' ? '[data-queue]' : 'button[type="submit"]'), 'pressed');
        const queued = method === 'agent.queue' ? showQueued(text, images) : undefined;
        let receipt: OutboxReceipt | undefined;
        if (method === 'agent.prompt') {
          receipt = conversation.outbox.find(r => r.state === 'failed' && r.text === text && r.images.length === images.length && r.images.every((image, i) => image === images[i]));
          if (!receipt) { receipt = { id: crypto.randomUUID(), text, images, state: 'sending', seen: this.turnsSaying(text) }; conversation.outbox.push(receipt); }
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
        audio.blip('press');
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
        finally { stopTask.disabled = false; stopTask.innerHTML = STOP_LABEL; }
      });
      form.querySelector('[data-queue]')?.addEventListener('click', () => submitMessage('agent.queue'));
      form.querySelector('[data-keys]')!.addEventListener('click', () => void send('agent.send_keys', { keys: ['Enter'] }));
      // A window rebuilt under someone typing gives the caret back at once, where it was; keys
      // pressed in the meantime would otherwise go nowhere.
      if (caret) { draft.focus(); input.setSelectionRange(caret[0], caret[1]); }
      else setTimeout(() => {
        if (generation === this.generation && !this.root.hidden && !this.readingHistory && !selectingIn(pre)) input.focus();
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
    for (const key of this.warmTurns.keys()) if (!agents.some(a => this.queueKey(a) === key)) this.warmTurns.delete(key);
    if (!this.openPane || this.root.hidden) return;
    const agent = agents.find((candidate) => candidate.pane_id === this.openPane);
    if (!agent) { this.close(); return; }
    if (this.currentAgent && this.terminalCache.key(agent) !== this.terminalCache.key(this.currentAgent)) {
      this.reopen(agent); return;
    }
    this.currentAgent = agent;
    this.paintRecent();
    this.paintHeader(agent);
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
    const conversation = this.conversations.get(this.queueKey(agent));
    if (conversation && agent.agent_status !== 'working') this.settleReceipts(conversation);
    else for (const receipt of conversation?.outbox ?? []) if (receipt.state === 'accepted') receipt.state = 'working';
    this.repaintOutbox?.();
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

  /** The open agent changed identity under the window: its session id arrived or changed, or it
   *  was given an employee record. The window has to be rebuilt, since the composer's queue button
   *  depends on the session, but whoever is typing in it keeps their words, caret and place. */
  private reopen(agent: AgentInfo) {
    const previous = this.currentAgent!, from = this.queueKey(previous), to = this.queueKey(agent);
    const input = this.root.querySelector<HTMLTextAreaElement>('form.reply textarea');
    const caret: [number, number] | undefined = input && document.activeElement === input ? [input.selectionStart, input.selectionEnd] : undefined;
    const screen = this.latestOutput;
    this.saveConversation();
    if (from !== to) {
      // Conversations are kept by session, so a new id would strand the draft under the old one
      // as a tab that goes nowhere. The record moves, never over one that is already there, and
      // without its turns: another session has another transcript.
      const record = this.conversations.get(from), existing = this.conversations.get(to), queued = this.queueHistory.get(from);
      this.conversations.delete(from);
      if (record && !existing) { record.turns = record.transcript = undefined; this.conversations.set(to, record); }
      else if (record && existing && !existing.draft && !existing.images.length) { existing.draft = record.draft; existing.images = record.images; }
      // Queued prompts follow the pane when its session id first arrives. A changed session is a
      // different native queue, and receipts for the old one must not be reconciled against it.
      if (queued && !previous.agent_session?.value && !this.queueHistory.has(to)) { this.queueHistory.delete(from); this.queueHistory.set(to, queued); this.saveQueueHistory(); }
    }
    // the pane's screen is still the pane's screen
    if (screen) this.terminalCache.accept(agent, screen);
    void this.open(agent, caret);
  }

  /** How many turns of the transcript carry these words as their prompt. */
  private turnsSaying(text: string) { const said = words(text); return this.transcriptTurns.filter(turn => words(turn.prompt) === said).length; }
  /** A delivered message belongs to the transcript. Until the transcript shows it, its receipt
   *  stays under the conversation, so your own words never leave the screen between pressing Enter
   *  and the agent writing them down. */
  private filed(receipt: OutboxReceipt) {
    if (receipt.state !== 'accepted' && receipt.state !== 'working') return false;
    receipt.filed ||= receipt.images.length
      ? this.transcriptTurns.some(turn => (!receipt.text.trim() || turn.prompt?.trim() === receipt.text.trim())
        && receipt.images.every(image => image.path && turn.images?.some(saved => saved.path === image.path)))
      : this.turnsSaying(receipt.text) > (receipt.seen ?? 0);
    return receipt.filed;
  }
  /** Not everything sent becomes a turn: a slash command, an answer to a menu. If the agent has
   *  not started on a delivered message after a few seconds, stop holding its receipt. While the
   *  agent is busy with something else the message is still waiting its turn, and the status
   *  change that ends that work asks again. Pictures wait for the transcript however long it takes. */
  private holdReceipt(conversation: Conversation, receipt: OutboxReceipt) {
    if (receipt.images.length || receipt.filed) return;
    window.setTimeout(() => {
      if (receipt.filed || receipt.state !== 'accepted' || conversation.agent.agent_status === 'working') return;
      receipt.filed = true;
      if (this.currentAgent && this.conversations.get(this.queueKey(this.currentAgent)) === conversation) this.repaintOutbox?.();
    }, RECEIPT_HOLD_MS);
  }

  /** The agent is not working: a turn has ended, or the window opened on one that ended while it
   *  was shut. Whatever that turn was going to put on the record is there by now, and a message
   *  it never took up gets a last few seconds to be started on. */
  private settleReceipts(conversation: Conversation) {
    for (const receipt of conversation.outbox) {
      if (receipt.state === 'working' && !receipt.images.length) receipt.filed = true;
      else if (receipt.state === 'accepted') this.holdReceipt(conversation, receipt);
    }
  }

  /** The recent-agents strip, patched in place: a tab is only touched when its name or draft
   *  marker changes, so a click that is under way is never lost to a rebuild. */
  private paintRecent() {
    const strip = this.root.querySelector<HTMLElement>('.recent-conversations');
    if (!strip || !this.currentAgent) return;
    const current = this.queueKey(this.currentAgent);
    const tabs = [...this.conversations.entries()].reverse().map(([key, c]) => ({ key, pane: c.agent.pane_id, label: `${employeeName(c.agent)}${c.draft || c.images.length ? ' · draft' : ''}` }));
    const signature = JSON.stringify([current, tabs]);
    if (signature === this.recentKey) return;
    this.recentKey = signature;
    const kept = new Map([...strip.querySelectorAll<HTMLButtonElement>('[data-conversation]')].map(button => [button.dataset.conversation!, button]));
    const buttons = tabs.map(({ key, pane, label }) => {
      let button = kept.get(key);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.dataset.conversation = key;
        button.append(avatarCanvas(pane, 16), document.createElement('span'));
      }
      const text = button.querySelector('span')!;
      if (text.textContent !== label) text.textContent = label;
      button.setAttribute('aria-current', key === current ? 'page' : 'false');
      return button;
    });
    if (buttons.length !== strip.children.length || buttons.some((button, index) => strip.children[index] !== button)) strip.replaceChildren(...buttons);
  }

  /** The header says what the agent is on now, not what it was on when the window opened. */
  private paintHeader(agent: AgentInfo) {
    const set = (selector: string, value: string) => { const el = this.root.querySelector(selector); if (el && el.textContent !== value) el.textContent = value; };
    set('.title-name', employeeName(agent));
    set('.conversation-task', taskOf(agent) || 'Ready for a prompt');
    const facts = this.root.querySelector<HTMLElement>('.agent-facts'), html = factsOf(agent);
    if (facts && html !== this.factsKey) { facts.innerHTML = html; this.factsKey = html; }
  }

  refreshProgress(paneId: string) {
    if (this.openPane !== paneId || this.root.hidden) return;
    const progress = this.progressOf?.(paneId); if (!progress) return;
    const set = (selector: string, value: string) => { const el = this.root.querySelector(selector); if (el && el.textContent !== value) el.textContent = value; };
    this.root.querySelectorAll<HTMLElement>('.title-level,.level-card').forEach(el => { el.dataset.levelTier = tierForLevel(progress.level); });
    const title = this.root.querySelector<HTMLElement>('.title-level');
    if (title) {
      title.title = `${progress.rank} · Level ${progress.level}`;
      // a level gained while you are watching: the badge hops
      if (title.textContent !== `Lv ${progress.level}`) { title.textContent = `Lv ${progress.level}`; replayAnimation(title, 'levelled'); }
    }
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
    const win = this.root.querySelector<HTMLElement>('.conversation-win');
    if (win && win.dataset.status !== status) win.dataset.status = status;
    const stopTask = this.root.querySelector<HTMLButtonElement>('[data-stop-task]');
    if (stopTask) stopTask.hidden = status !== 'working';
    const input = this.root.querySelector<HTMLTextAreaElement>('form.reply textarea');
    const placeholder = status === 'blocked' ? 'answer them…' : 'send a prompt to this agent…';
    if (input && input.placeholder !== placeholder) input.placeholder = placeholder;
    const wait = this.currentAgent?.wait_notice;
    const completed = status === 'idle' ? this.currentAgent?.completed_task : null;
    const completion = this.root.querySelector<HTMLElement>('.agent-completion');
    if (completion) {
      const text = completed ? `Task complete · ${completed.title} · Ready for another prompt` : '', line = completion.querySelector('span')!;
      completion.hidden = !completed || !!wait;
      if (line.textContent !== text) { line.textContent = text; line.title = text; }
      // A task finished while the window was open is the one thing here that lands, since the
      // office's own card is held back behind a conversation. One already done at open just shows.
      const shipped = completed?.entry_id;
      if (shipped && this.lastShipped !== undefined && shipped !== this.lastShipped && !completion.hidden) playOnce(completion, 'fresh');
      this.lastShipped = shipped ?? '';
    }
    const label = wait ? wait.kind === 'rate_limit' ? 'Rate limited' : 'Waiting to retry' : completed ? 'done' : statusLabel(status);
    this.root.querySelectorAll<HTMLElement>('.win-body .st').forEach(badge => {
      const name = `st ${wait ? 'retry-wait' : completed ? 'done' : status}`;
      if (badge.className !== name) badge.className = name;
      if (badge.textContent !== label) badge.textContent = label;
    });
    const notice = this.root.querySelector<HTMLElement>('.agent-wait-notice');
    if (notice) { const text = wait ? `${label} · ${wait.detail}. Task is paused.` : ''; notice.hidden = !wait; if (notice.textContent !== text) notice.textContent = text; }
    this.paintConversationFreshness();
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
      else { const conversation = this.conversations.get(this.queueKey(a)); if (conversation) conversation.turns = undefined; }
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
  /** The strip above the output is one slot of constant height on both faces, so the box under
   *  it never moves: a wait notice, else a finished task, else a line saying which face this is.
   *  Only what the slot says changes. */
  private paintConversationFreshness() {
    const banner = this.root.querySelector<HTMLElement>('.conversation-freshness');
    if (!banner) return;
    banner.hidden = [...this.root.querySelectorAll<HTMLElement>('.agent-wait-notice,.agent-completion')].some(strip => !strip.hidden);
    const conversation = this.view === 'conversation' && this.transcriptAvailable !== false;
    const active = this.currentStatus === 'working' || this.currentStatus === 'blocked';
    const name = this.currentAgent ? employeeName(this.currentAgent) : 'Agent';
    const greeting = this.greeting && this.greeting.pane === this.openPane ? this.greeting.text : '';
    const text = greeting ? greeting
      : !conversation ? this.transcriptAvailable === false ? 'Live screen · this agent keeps no transcript on this machine' : 'Live screen · the pane as it is right now'
      : this.transcriptCheckFailed ? 'Conversation update failed · showing saved messages. Retrying…'
      : this.transcriptAvailable === undefined ? this.transcriptTurns.length ? 'Saved conversation · checking for updates…' : 'Loading saved conversation…'
      : active ? `${name} is ${this.currentStatus === 'blocked' ? 'waiting for input' : 'working'} · messages appear here when saved`
      : 'Saved conversation · checks for updates automatically';
    const label = banner.querySelector('span')!, other = banner.querySelector<HTMLButtonElement>('button')!;
    if (label.textContent !== text) { label.textContent = text; label.title = text; }
    banner.classList.toggle('greeting', !!greeting);
    const action = conversation ? 'View live screen' : 'Back to conversation';
    if (other.textContent !== action) other.textContent = action;
    // no transcript, or none that could be read yet (the demo office has none): no other face to offer
    other.hidden = !conversation && (this.transcriptAvailable === false || (this.transcriptAvailable === undefined && this.transcriptCheckFailed));
  }
  /** Turns are reconciled one at a time, the way the screen is reconciled line by line: a turn
   *  whose prompt is unchanged keeps its node and its pictures, and only a reply that changed is
   *  rendered again. A selection in an older turn survives the next message. */
  private paintTranscript(turns: Turn[]) {
    const box = this.root.querySelector<HTMLElement>('.transcript-output');
    if (!box) return;
    const working = this.currentStatus === 'working' || this.currentStatus === 'blocked';
    const key = JSON.stringify([turns, working]);
    if (box.dataset.loaded && key === this.transcriptKey) return;
    this.transcriptKey = key; this.transcriptTurns = turns;
    const conversation = this.currentAgent && this.conversations.get(this.queueKey(this.currentAgent));
    if (conversation) conversation.turns = turns;
    const follow = !selectingIn(box) && (!box.dataset.loaded || !!this.transcriptFollow?.pinned);
    const scroll = box.scrollTop;
    const kept = new Map<string, HTMLElement[]>();
    for (const row of box.querySelectorAll<HTMLElement>(':scope > .turn')) {
      const asked = this.turnParts.get(row)!.asked; kept.set(asked, [...(kept.get(asked) ?? []), row]);
    }
    const rows = turns.map((turn, index) => {
      // A turn is its prompt. Its time is not part of that: each message of the reply moves it.
      const asked = JSON.stringify([turn.prompt ?? '', turn.images ?? []]);
      const said = turn.reply || (index === turns.length - 1 && working ? PENDING : '');
      let row = kept.get(asked)?.shift();
      const before = row && this.turnParts.get(row)!.said;
      if (!row) {
        row = document.createElement('article'); row.className = 'turn';
        // a turn that arrives while you are reading steps into place; the first paint just appears
        if (box.dataset.loaded && box.clientHeight) playOnce(row, 'turn-new');
        if (turn.prompt || turn.images?.length) {
          const prompt = document.createElement('div'); prompt.className = 'turn-prompt';
          prompt.innerHTML = `<span><b>You</b><time></time></span>${turn.prompt ? `<p>${esc(turn.prompt)}</p>` : ''}<div class="turn-images"></div>`;
          renderPromptImages(prompt.querySelector<HTMLElement>('.turn-images')!, (turn.images ?? []).map(image => ({ name: image.name,
            url: image.url?.startsWith('/api/image?') ? image.url : undefined, status: 'Attached' })));
          row.append(prompt);
        }
      }
      const time = row.querySelector<HTMLTimeElement>('.turn-prompt time');
      const clock = turn.at ? new Date(turn.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      if (time && time.textContent !== clock) { time.textContent = clock; time.dateTime = turn.at ? new Date(turn.at).toISOString() : ''; }
      if (said !== before) {
        row.querySelector(':scope > .turn-reply')?.remove();
        if (said) {
          const reply = document.createElement('div'); reply.className = said === PENDING ? 'turn-reply turn-pending' : 'turn-reply';
          reply.innerHTML = said === PENDING ? 'Working on it<i></i><i></i><i></i>' : renderMarkdown(said);
          row.append(reply);
        }
      }
      this.turnParts.set(row, { asked, said });
      return row;
    });
    // As in the terminal: take out what is gone, then put the rest in order without moving a row
    // that is already in its place.
    const wanted = new Set<Element>(rows);
    for (const child of [...box.children]) if (!wanted.has(child)) child.remove();
    let cursor = box.firstElementChild;
    for (const row of rows) { if (row === cursor) cursor = cursor.nextElementSibling; else box.insertBefore(row, cursor); }
    if (!rows.length) {
      const empty = document.createElement('p'); empty.className = 'turn-empty';
      empty.textContent = `Nothing on the record yet. Messages appear here once ${this.currentAgent ? employeeName(this.currentAgent) : 'the agent'} saves them.`;
      box.append(empty);
    }
    this.repaintOutbox?.();
    box.dataset.loaded = 'true';
    if (follow) this.transcriptFollow?.pin(); else box.scrollTop = scroll;
  }
  private paintOutputNow(pre: HTMLPreElement, result: TerminalSnapshot) {
    if (this.rawOutput.get(pre) === result.text) { this.clearOutputStatus(); return; }
    this.rawOutput.set(pre, result.text);
    const text = tidyTerminal(result.text) || '(no output)';
    const follow = !selectingIn(pre) && (!pre.dataset.loaded || !!this.outputFollow?.pinned);
    const scroll = pre.scrollTop;
    if (renderTerminal(pre, text)) { if (follow) this.outputFollow?.pin(); else pre.scrollTop = scroll; }
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

/** The plain facts in the details sheet. They are rewritten as the agent moves on; the status
 *  badge among them is repainted by paintStatus, which knows about waits and completions. */
function factsOf(a: AgentInfo) {
  const task = taskOf(a), asked = a.last_prompt?.split('\n')[0].trim();
  return `<dt>status</dt><dd><span class="st ${a.agent_status}">${statusLabel(a.agent_status)}</span></dd>
    <dt>task</dt><dd>${esc(task) || '—'}</dd>${asked && asked !== task ? `<dt>asked</dt><dd class="asked">${esc(asked)}</dd>` : ''}${a.activity && a.agent_status === 'working' ? `<dt>now</dt><dd>${esc(a.activity)}</dd>` : ''}
    <dt>pane</dt><dd>${esc(a.pane_id)}</dd>
    <dt>cwd</dt><dd>${esc(a.foreground_cwd || a.cwd || '—')}</dd>`;
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
