import type { Completion, StudioState, Employee, ProjectBoard, JournalEntry, StudioRoom } from './studio';
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** Subset of herdr's AgentInfo we care about (agent.list). */
export interface AgentInfo {
  pane_id: string;
  workspace_id?: string | null;
  /** Herdr workspace label, enriched by the bridge from the session snapshot. */
  workspace_name?: string | null;
  agent: string | null;
  display_agent?: string | null;
  name?: string | null;
  employee_id?: string;
  office_name?: string;
  office_role?: 'boss';
  office_look?: { body: number; face: number };
  favorite?: boolean;
  /** Exact runtime model, enriched by the bridge from the agent's local session metadata. */
  model?: string | null;
  /** What the person last asked this agent, and the last thing it was seen doing — read off the
   *  pane's screen by the bridge. Codex titles its window after the folder, so the prompt is
   *  often the only account of the task. */
  last_prompt?: string | null;
  activity?: string | null;
  /** Verified transcript completion, used to recognize short turns. */
  last_turn_completed_at?: number;
  /** Saved result of the current work stretch, while ready for the next prompt. */
  completed_task?: { entry_id: string; title: string; at: number } | null;
  /** Current terminal retry/limit notice; independent of Herdr's task lifecycle. */
  wait_notice?: { kind: 'rate_limit' | 'retry'; detail: string } | null;
  agent_session?: { source?: string; agent?: string; kind?: string; value?: string } | null;
  agent_status: AgentStatus;
  title?: string | null;
  terminal_title_stripped?: string | null;
  terminal_title?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  state_change_seq?: number;
  /** Herdr's view of a launching agent: not yet ready for input, or its start still pending. */
  interactive_ready?: boolean;
  launch_pending?: boolean;
  focused?: boolean;
}

export interface WorkspaceSummary {
  workspace_id: string;
  label: string;
}

export type AgentQueueState = 'queued' | 'dispatching' | 'sent' | 'failed';

export interface AgentQueueItem {
  id: string;
  target: string;
  text: string;
  queued_at: number;
  state: AgentQueueState;
  error?: string;
}

export type EventKind = 'joined' | 'left' | 'status' | 'title';

export interface OfficeEvent {
  id: string;
  ts: number;
  kind: EventKind;
  pane_id: string;
  agent: string;
  status: AgentStatus;
  prev?: AgentStatus;
  title: string;
  /** How long the agent had been in `prev` before this change. */
  prev_for_ms?: number;
  cwd?: string | null;
  /** Last lines of the pane at the time of the event (blocked/idle/done only). */
  snippet?: string;
  completion?: Completion;
}

export type ServerMsg =
  | { type: 'snapshot'; agents: AgentInfo[]; events: OfficeEvent[]; writable: boolean; mock: boolean;
      queues?: AgentQueueItem[]; delivered_queue_ids?: string[]; bridge_started_at?: number;
      money?: MoneyEvent[]; workspaces?: WorkspaceSummary[]; studio?: StudioState }
  | { type: 'agents'; agents: AgentInfo[]; workspaces?: WorkspaceSummary[] }
  | { type: 'agents.patch'; upsert: AgentInfo[]; remove: string[]; workspaces?: WorkspaceSummary[] }
  | { type: 'studio.patch'; baseRevision: number; revision: number;
      employees?: { upsert: Employee[]; remove: string[] }; projects?: { upsert: ProjectBoard[]; remove: string[] };
      journal?: { upsert: JournalEntry[]; remove: string[] }; room?: StudioRoom;
      metadata?: Pick<StudioState, 'journalTotal' | 'journalCursor' | 'journalEpoch' | 'journalRetired' | 'journalSummary' | 'journalInvalidated'> }
  | { type: 'event'; event: OfficeEvent }
  | { type: 'money'; event: MoneyEvent }
  | { type: 'queue'; item: AgentQueueItem }
  | { type: 'studio'; studio: StudioState }
  | { type: 'launch'; id: string; stage: 'creating' | 'starting' | 'ready' }
  | { type: 'output'; target: string; text: string; source: 'visible'; at: number; live: boolean; healthyForMs?: number }
  | { type: 'output.health'; target: string; healthyForMs: number }
  | { type: 'result'; id: string; result?: unknown; error?: unknown };

/** Something that happened in a connected payments account. The bridge receives provider events and
 *  passes these through; the page turns them into a line in the roster and a moment in the office.
 *  Deliberately carries no customer name, email or id — this screen gets shared and screenshotted,
 *  and the amount and the merchant's own description are enough to know what happened. */
export interface MoneyEvent {
  /** Provider event id; RevenueCat ids are namespaced. Stable across retries and restarts. */
  id: string;
  source?: 'stripe' | 'revenuecat';
  ts: number;
  kind: 'sale' | 'refund' | 'failed' | 'subscribed' | 'subscription_started'
    | 'subscription_pending' | 'trial_started' | 'churned' | 'dispute' | 'expired' | 'subscription_resumed';
  /** Major units (dollars, not cents), signed: a refund is negative. */
  amount: number;
  currency: string;
  /** The merchant's own description of what was bought, when there is one. */
  label: string;
  /** What else the provider said, for reading into: why a subscription ended, and the way in to
   *  the provider's own record. Never who the customer is. */
  detail?: MoneyDetail;
}
export interface MoneyDetail {
  /** Why it ended, in the provider's terms: who asked, or what failed. */
  reason?: string;
  /** The category the customer picked when they cancelled. */
  feedback?: string;
  /** The customer's own words, when they left any. */
  comment?: string;
  plan?: string;
  /** When access ends (a cancellation) or renews (a new subscription), ms since epoch. */
  ends?: number;
  /** The record in the provider's dashboard. */
  url?: string;
}

export type ClientMsg =
  | { type: 'hello'; deltas: true }
  | { type: 'call'; id: string; method: string; params: Record<string, unknown> }
  | { type: 'cancel'; id: string }
  | { type: 'output.subscribe'; target: string }
  | { type: 'output.unsubscribe' };

export function titleOf(a: AgentInfo): string {
  return (a.title || a.terminal_title_stripped || a.terminal_title || '').replace(/^[^\w(]+/, '').trim();
}
/** A window title that only repeats the folder ("paperplane", "LanternAppiOS-relea...") says
 *  nothing about the task. */
export function genericTitle(title: string, cwd?: string | null): boolean {
  const base = (cwd || '').replace(/\/+$/, '').split('/').pop()?.toLowerCase() ?? '';
  const plain = title.replace(/[.…]+$/, '').trim().toLowerCase();
  return !plain || plain === 'completed task' || (!!base && (plain === base || (/[.…]$/.test(title.trim()) && base.startsWith(plain))));
}
/** The best one-line account of what an agent is on: its window title when that names the task,
 *  otherwise the last prompt it was given. */
export function taskOf(a: AgentInfo): string {
  const title = titleOf(a);
  if (!genericTitle(title, a.foreground_cwd || a.cwd)) return title;
  return (a.last_prompt || '').split('\n')[0].trim() || title;
}
export function agentKind(a: AgentInfo): string {
  return (a.display_agent || a.agent || 'agent').toLowerCase();
}
