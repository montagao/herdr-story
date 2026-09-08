import type { AgentInfo, AgentStatus, MoneyEvent, OfficeEvent, ServerMsg, WorkspaceSummary } from '../../shared/types';
import type { DemoSnapshot } from '../../shared/demo';
import type { JournalEntry, JournalPageQuery, StudioState } from '../../shared/studio';
import { projectName, projectKey } from '../../shared/studio';
import { pageJournal } from '../../shared/journal-page';
import type { InteractionTiming, OfficeClient, OutputUpdate } from './office-client';

export interface StaticClientOptions {
  /** Re-enact activity on the snapshot's desks. Off, the office is a still photograph. */
  live?: boolean;
  /** Seed for the re-enactment, so a recording plays the same way twice. */
  seed?: number;
  /** Milliseconds between ticks; `0` leaves ticking to the caller. */
  intervalMs?: number;
  now?: () => number;
}
const EPOCH = 'demo-snapshot';
const TICK_MS = 3_000;
const readOnly = () => Object.assign(new Error('This office is a snapshot; changes are not saved here.'), { code: 'read_only' });
const clone = <T>(value: T): T => structuredClone(value);
/** Small, fast, seedable; the quality of a demo does not hinge on its randomness. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The office's data source when there is no bridge: a captured studio served from memory. Reads
 * answer from the snapshot, writes are refused, and when live, a seeded loop replays the kind of
 * day the snapshot recorded — desks start and finish real tasks, a sale lands now and then — so
 * the room moves the way it does with a bridge behind it.
 */
export class StaticBridgeClient implements OfficeClient {
  connected = true;
  readonly outputStreaming = false;
  private listeners = new Set<(msg: ServerMsg) => void>();
  private agents: AgentInfo[];
  private workspaces: WorkspaceSummary[];
  private events: OfficeEvent[];
  private money: MoneyEvent[];
  private studio: StudioState;
  private random: () => number;
  private seq = 0;
  private ticks = 0;
  private timer?: ReturnType<typeof setInterval>;
  private phase = new Map<string, { status: 'working' | 'done'; until: number; since: number }>();
  private now: () => number;
  /** Desks that take part in the re-enactment: seated employees with a record of finished work. */
  private cast: string[];

  constructor(private snapshot: DemoSnapshot, private options: StaticClientOptions = {}) {
    this.agents = clone(snapshot.agents); this.workspaces = clone(snapshot.workspaces);
    this.events = clone(snapshot.events); this.money = clone(snapshot.money); this.studio = clone(snapshot.studio);
    this.random = mulberry32(options.seed ?? 7);
    this.now = options.now ?? (() => Date.now());
    const shipped = new Map(this.studio.employees.map(e => [e.id, e.shipped]));
    this.cast = this.agents.filter(a => a.employee_id && (shipped.get(a.employee_id) ?? 0) > 0).map(a => a.pane_id);
    const now = this.now();
    for (const a of this.agents) {
      if (a.agent_status === 'working') this.phase.set(a.pane_id, { status: 'working', until: now + 18_000 + this.random() * 20_000, since: now });
      else if (a.agent_status === 'done') this.phase.set(a.pane_id, { status: 'done', until: now + 12_000 + this.random() * 12_000, since: now });
    }
    const interval = options.intervalMs ?? TICK_MS;
    if (options.live !== false && interval > 0) this.timer = setInterval(() => this.tick(), interval);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  on(listener: (msg: ServerMsg) => void) {
    this.listeners.add(listener);
    queueMicrotask(() => { if (this.listeners.has(listener)) listener(this.snapshotMessage()); });
    return () => this.listeners.delete(listener);
  }
  private snapshotMessage(): ServerMsg {
    return { type: 'snapshot', agents: clone(this.agents), events: clone(this.events), writable: false, mock: false, queues: [], delivered_queue_ids: [],
      bridge_started_at: this.snapshot.capturedAt, money: clone(this.money), workspaces: clone(this.workspaces), studio: clone(this.studio) };
  }
  private emit(msg: ServerMsg) { for (const listener of this.listeners) listener(msg); }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'payment.detail') throw new Error('Customer details are available in the connected office. They are not included in this demo snapshot.');
    switch (method) {
      case 'ping': return { type: 'pong' };
      case 'agent.list': return { type: 'agent_list', agents: clone(this.agents) };
      case 'agent.read': {
        const text = this.snapshot.transcripts[String(params.target)] ?? 'This desk was quiet when the office was captured.';
        return { type: 'pane_read', read: { text, truncated: false } };
      }
      case 'studio.get': return clone(this.studio);
      case 'studio.journal': return pageJournal(this.studio.journal, this.studio.employees, params as JournalPageQuery, this.studio.revision, EPOCH);
      case 'agent.settings.options': return { models: [], efforts: [] };
      case 'agent.boss.archive': return { briefings: [], total: 0, cursor: null };
      case 'agent.message.status': return { state: 'delivered' };
      case 'studio.change': if (params.op === 'legacy.import') return clone(this.studio); throw readOnly();
      default: throw readOnly();
    }
  }
  watchOutput(_target: string, _callback: (update: OutputUpdate) => void) { return () => {}; }
  outputFresh(_target: string) { return false; }
  async uploadImage(_image: Blob): Promise<string> { throw readOnly(); }
  performanceSnapshot(): InteractionTiming[] { return []; }

  private tasksOf(employeeId: string): JournalEntry[] {
    return this.studio.journal.filter(e => e.kind === 'task' && e.contributors.includes(employeeId));
  }
  private pick<T>(items: T[]): T | undefined { return items.length ? items[Math.floor(this.random() * items.length)] : undefined; }
  private setStatus(a: AgentInfo, status: AgentStatus, title: string, now: number, completion?: OfficeEvent['completion']) {
    const prev = a.agent_status, since = this.phase.get(a.pane_id)?.since ?? now;
    a.agent_status = status; a.state_change_seq = (a.state_change_seq ?? 0) + 1;
    const event: OfficeEvent = { id: `demo-${++this.seq}`, ts: now, kind: 'status', pane_id: a.pane_id, agent: a.agent ?? 'agent', status, prev,
      prev_for_ms: Math.max(0, now - since), title, cwd: a.cwd, ...(completion ? { completion } : {}) };
    this.events = [...this.events, event].slice(-60);
    this.emit({ type: 'agents', agents: clone(this.agents), workspaces: clone(this.workspaces) });
    this.emit({ type: 'event', event });
  }

  /** One step of the re-enactment. Public so a recording can pace it by hand. */
  tick(now = this.now()) {
    this.ticks++;
    const byPane = new Map(this.agents.map(a => [a.pane_id, a]));
    for (const [pane, phase] of [...this.phase]) {
      const a = byPane.get(pane);
      if (!a) { this.phase.delete(pane); continue; }
      if (now < phase.until) continue;
      if (phase.status === 'working') {
        const employee = this.studio.employees.find(e => e.id === a.employee_id);
        const task = employee ? this.pick(this.tasksOf(employee.id)) : undefined;
        let completion: OfficeEvent['completion'];
        if (employee && task) {
          employee.shipped++; employee.stats[task.stat ?? 'program']++; this.studio.revision++;
          completion = { employeeId: employee.id, total: employee.shipped, stat: task.stat ?? 'program', entryId: task.id };
          this.emit({ type: 'studio', studio: clone(this.studio) });
        }
        this.phase.set(pane, { status: 'done', until: now + 8_000 + this.random() * 8_000, since: now });
        this.setStatus(a, 'done', task?.title ?? a.title ?? `Finished in ${projectName(projectKey(a))}`, now, completion);
      } else {
        this.phase.delete(pane);
        this.setStatus(a, 'idle', a.title ?? '', now);
      }
    }
    const working = this.agents.filter(a => a.agent_status === 'working').length;
    const wanted = Math.min(4, 2 + Math.floor(this.cast.length / 8));
    if (working < wanted && this.random() < 0.55) {
      const idle = this.cast.filter(pane => byPane.get(pane)?.agent_status === 'idle' && !this.phase.has(pane));
      const a = byPane.get(this.pick(idle) ?? '');
      if (a) {
        const task = a.employee_id ? this.pick(this.tasksOf(a.employee_id)) : undefined;
        const title = task?.title ?? `Working in ${projectName(projectKey(a))}`;
        a.title = title; a.last_prompt = title; a.activity = null;
        this.phase.set(a.pane_id, { status: 'working', until: now + 15_000 + this.random() * 22_000, since: now });
        this.setStatus(a, 'working', title, now);
      }
    }
    const sales = this.snapshot.money.filter(m => m.kind === 'sale');
    if (sales.length && this.ticks > 3 && this.random() < 0.04) {   // about one every couple of minutes
      const sale = this.pick(sales)!;
      const event: MoneyEvent = { ...sale, id: `demo-money-${++this.seq}`, ts: now };
      this.money = [...this.money, event].slice(-40);
      this.emit({ type: 'money', event });
    }
  }
}
