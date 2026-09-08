import { recapMoney } from '../shared/recap-money';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { actionPayload, canonicalAction } from '../shared/studio-actions';
import { Storage, type SavedPatch } from './storage';
import { StorageMutation } from './storage-mutation';
import { AsyncStorage } from './async-storage';
import type { AgentInfo, AgentStatus, MoneyEvent } from '../shared/types';
import { agentKind, titleOf } from '../shared/types';
import { BOARD_COLORS, emptyCareer, CAREER_STATS, projectKey, projectName, safeArtifactUrl,
  type Completion, type Employee, type JournalEntry, type JournalPage, type JournalPageQuery, type Milestone, type ProjectBoard, type RoomItem, type StudioState } from '../shared/studio';
import { taskTitle, type Outcome } from './outcome';
import { workKindForTitle } from '../src/work';

type Observation = { status: AgentStatus; title: string; workingAt: number; credited: boolean; entryId?: string };
type SavedStudio = StudioState & { identities: Record<string, string>; observations: Record<string, Observation>; imports: string[]; revenueCatSubscribers?: Record<string, number>;
  actionReceipts?: Record<string, { hash: string; revision: number; at: number }>; actionFloor?: number };
const blank = (): SavedStudio => ({ version: 1, revision: 0, employees: [], projects: [], journal: [],
  room: { version: 0, items: null, projectOrder: [] }, identities: {}, observations: {}, imports: [] });
const uuid = () => crypto.randomUUID();
function hash(text: string) { let h = 2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function text(value: unknown, limit: number, required = false): string {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error(`Enter ${required ? '1–' : 'up to '}${limit} characters.`);
  return value.trim();
}
function integer(value: unknown, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error('Choose a valid value.');
  return Number(value);
}
function link(value: unknown) { const raw = text(value ?? '', 2000); const url = safeArtifactUrl(raw); if (raw && !url) throw new Error('Use an http:// or https:// artifact link.'); return url; }
function checkedVersion(entity: { version: number }, version: unknown) {
  if (entity.version !== version) throw new Error('This item changed in another window. Reopen it to load the latest version.');
}

/** One local, atomic save holds the studio. Agent observation runs in the bridge, even with no
 * browser connected. Identity prefers a session id; pane reuse never merges known sessions. */
export class StudioStore {
  private state: SavedStudio;
  private storage?: Storage;
  private writer?: AsyncStorage;
  private paneIdentities = new Map<string, string>();
  private asyncWrite = false;
  private saveNeeded = false;
  private operationTail: Promise<unknown> = Promise.resolve();
  private ensuredChanges = 0;
  private mutation?: StorageMutation<SavedStudio>;
  private inOperation = false;
  private commitPending = false;
  constructor(directory?: string, options: { asyncWrite?: boolean } = {}) {
    this.asyncWrite = !!options.asyncWrite;
    this.state = blank();
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.storage = new Storage(directory);
    const saved = this.storage.load();
    if (saved) this.state = saved as SavedStudio;
    if (this.asyncWrite) this.writer = new AsyncStorage(directory);
  }
  /** Where the studio is kept, for the log line and the README's backup advice. */
  get path() { return this.storage?.path; }
  private compactSnapshot?: { revision: number; limit: number; state: StudioState };
  private journalEpoch = uuid();
  private journalKnown = new Set<string>();
  private journalRetired = new Set<string>();
  private journalPrevious = new Map<string, Pick<JournalEntry, 'version' | 'title' | 'notes'>>();
  private journalInvalidated: Record<string, number> = {};
  private journalMetadataReady = false;
  private journalSummary: NonNullable<StudioState['journalSummary']> = { trophies: 0, tasksByProject: {}, achievementsByEmployee: {} };
  private countEntry(entry: JournalEntry, delta: number) {
    const increment = (map: Record<string, number>, id: string) => { const next = (map[id] ?? 0) + delta; if (next) map[id] = next; else delete map[id]; };
    if (entry.kind === 'task') increment(this.journalSummary.tasksByProject, entry.project);
    if (entry.kind === 'milestone' || entry.kind === 'release') {
      this.journalSummary.trophies += delta;
      for (const id of entry.contributors) increment(this.journalSummary.achievementsByEmployee, id);
    }
  }
  private committedJournalPatch(patch: SavedPatch, previous: Map<string, JournalEntry>) {
    if (!this.journalMetadataReady || !patch.rows.journal) return;
    for (const id of patch.rows.journal.remove) {
      const entry = previous.get(id); if (entry) this.countEntry(entry, -1);
      this.journalKnown.delete(id); this.journalRetired.add(id); this.journalPrevious.delete(id); delete this.journalInvalidated[id];
    }
    for (const entry of patch.rows.journal.upsert as JournalEntry[]) {
      const old = previous.get(entry.id); if (old) this.countEntry(old, -1);
      this.countEntry(entry, 1);
      if (old && (old.version !== entry.version || old.title !== entry.title || old.notes !== entry.notes)) this.journalInvalidated[entry.id] = this.state.revision;
      this.journalKnown.add(entry.id); this.journalRetired.delete(entry.id);
      this.journalPrevious.set(entry.id, { version: entry.version, title: entry.title, notes: entry.notes });
    }
  }
  snapshot(journalLimit?: number): StudioState {
    const { identities, observations, imports, revenueCatSubscribers, actionReceipts, actionFloor, ...state } = this.mutation?.state ?? this.state;
    if (journalLimit === undefined) return structuredClone(state);
    // A synchronous draft snapshot is useful to legacy callers, but must not update the
    // committed page cache, tombstones, or epoch before its transaction is acknowledged.
    if (this.inOperation) {
      const page = this.journalPage({ limit: journalLimit });
      return structuredClone({ ...state, journal: page.entries, journalTotal: page.total, journalCursor: page.cursor });
    }
    if (this.compactSnapshot?.revision === state.revision && this.compactSnapshot.limit === journalLimit) return structuredClone(this.compactSnapshot.state);
    if (!this.asyncWrite || !this.journalMetadataReady) {
      const ids = new Set(state.journal.map(entry => entry.id));
      for (const id of this.journalKnown) if (!ids.has(id)) this.journalRetired.add(id);
      for (const id of ids) this.journalRetired.delete(id);
      this.journalKnown = ids;
      for (const entry of state.journal) {
        const previous = this.journalPrevious.get(entry.id);
        if (previous && (previous.version !== entry.version || previous.title !== entry.title || previous.notes !== entry.notes)) this.journalInvalidated[entry.id] = state.revision;
        this.journalPrevious.set(entry.id, { version: entry.version, title: entry.title, notes: entry.notes });
      }
      for (const id of this.journalPrevious.keys()) if (!ids.has(id)) { this.journalPrevious.delete(id); delete this.journalInvalidated[id]; }
      this.journalSummary = { trophies: 0, tasksByProject: {}, achievementsByEmployee: {} };
      for (const entry of state.journal) this.countEntry(entry, 1);
      this.journalMetadataReady = true;
    }
    // Keep invalidation metadata bounded. A new epoch safely drops old browser pages before
    // retired ids are forgotten; fetching history again always reads the current full store.
    if (this.journalRetired.size + Object.keys(this.journalInvalidated).length > 500) {
      this.journalEpoch = uuid(); this.journalRetired.clear(); this.journalInvalidated = {};
    }
    const page = this.journalPage({ limit: journalLimit });
    const compact = structuredClone({ ...state, journal: page.entries, journalTotal: page.total, journalCursor: page.cursor,
      journalEpoch: this.journalEpoch, journalRetired: [...this.journalRetired], journalInvalidated: this.journalInvalidated, journalSummary: this.journalSummary });
    this.compactSnapshot = { revision: state.revision, limit: journalLimit, state: compact };
    return structuredClone(compact);
  }
  /** Stable keyset pagination: arrivals do not shift the next page or duplicate rows. */
  journalPage(query: JournalPageQuery = {}): JournalPage {
    const state = this.mutation?.state ?? this.state;
    const limit = query.limit === undefined ? 100 : integer(query.limit, 1, 200);
    let before: [number, string] | undefined;
    if (query.cursor) {
      try {
        const parsed = JSON.parse(text(query.cursor, 500));
        if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isFinite(parsed[0]) || typeof parsed[1] !== 'string') throw new Error();
        before = parsed as [number, string];
      } catch { throw new Error('The journal page cursor is invalid.'); }
    }
    const search = text(query.search ?? '', 500).toLowerCase();
    const project = text(query.project ?? '', 2000), kind = text(query.kind ?? '', 30);
    const since = query.since === undefined ? 0 : Number(query.since);
    if (!Number.isFinite(since) || since < 0) throw new Error('The journal start date is invalid.');
    if (query.ids !== undefined && (!Array.isArray(query.ids) || query.ids.length > 200 || query.ids.some(id => typeof id !== 'string' || id.length > 100))) throw new Error('Choose up to 200 journal entries.');
    if (this.storage && !this.inOperation && !this.commitPending) {
      return { ...this.storage.journalPage({ ...query, limit, before, search, project, kind, since }), revision: state.revision, epoch: this.journalEpoch };
    }
    const wanted = query.ids ? new Set(query.ids) : undefined;
    const names = new Map(state.employees.map(employee => [employee.id, employee.name]));
    const ordered = state.journal.filter(entry => (!wanted || wanted.has(entry.id)) && (!project || entry.project === project) && (!kind || entry.kind === kind)
      && (query.read === undefined || !!entry.readAt === query.read)
    && (!query.trophies || entry.kind === 'milestone' || entry.kind === 'release') && entry.at > since
      && (!search || `${entry.title} ${entry.notes} ${entry.contributors.map(id => names.get(id) ?? '').join(' ')}`.toLowerCase().includes(search)))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const remaining = before ? ordered.filter(entry => entry.at < before![0] || (entry.at === before![0] && entry.id < before![1])) : ordered;
    const entries = remaining.slice(0, limit), last = entries.at(-1);
    return { ...(query.moneySummary ? { money: recapMoney(ordered) } : {}), entries: structuredClone(entries.reverse()), cursor: remaining.length > limit && last ? JSON.stringify([last.at, last.id]) : null,
      total: ordered.length, revision: state.revision, epoch: this.journalEpoch };
  }
  private persist() {
    if (this.asyncWrite) { this.saveNeeded = true; return; }
    this.storage?.save(this.state);
  }
  /** Serialize async mutations and acknowledge them only after an atomic durable save.
   * The bridge uses this boundary for observations as well as user edits. */
  run<T>(operation: () => T): Promise<T> {
    const next = this.operationTail.then(async () => {
      if (!this.asyncWrite) return operation();
      const mutation = new StorageMutation(this.state), identities = new Map(this.paneIdentities), ensured = this.ensuredChanges;
      this.mutation = mutation; this.state = mutation.draft;
      try {
        this.inOperation = true;
        const result = operation();
        if (result && typeof (result as any).then === 'function') throw new Error('Studio operations must be synchronous.');
        this.inOperation = false;
        const patch = this.saveNeeded ? mutation.patch() : undefined;
        // Restore the committed version while I/O is pending. No history-sized snapshot is kept.
        mutation.restore(); this.state = mutation.state; this.mutation = undefined;
        if (this.asyncWrite && patch && this.writer) {
          this.commitPending = true;
          try { await this.writer.patch(patch); } finally { this.commitPending = false; }
        }
        mutation.publish();
        if (patch) this.committedJournalPatch(patch, mutation.previousRows('journal'));
        this.saveNeeded = false; return result;
      } catch (error) {
        mutation.restore(); this.state = mutation.state; this.mutation = undefined;
        this.inOperation = false;
        this.paneIdentities = identities; this.ensuredChanges = ensured; this.saveNeeded = false;
        throw error;
      }
    });
    this.operationTail = next.catch(() => {}); return next;
  }
  flush() { return this.operationTail; }
  async close() { await this.flush(); await this.writer?.close(); this.storage?.close(); }
  /** A sweep archives work without counting it as another completed task. Retries reuse the id. */
  archiveSweep(id: string, agent: AgentInfo, notes: string, url: string): string {
    if (this.state.journal.some(entry => entry.id === id)) return id;
    return this.transaction(() => {
      const employee = this.ensure(agent);
      this.state.journal.push({ id, version: 0, at: Date.now(), kind: 'note', source: 'manual',
        title: `Re-org · ${employee.name} · ${projectName(projectKey(agent))}`.slice(0, 160),
        notes: text(notes, 6000), project: projectKey(agent), contributors: [employee.id], url: safeArtifactUrl(url) });
      return id;
    });
  }
  private transaction<T>(fn: () => T): T {
    const previous = this.asyncWrite ? undefined : structuredClone(this.state);
    try { const result = fn(); this.state.revision++; this.persist(); return result; }
    catch (error) { if (previous) this.state = previous; throw error; }
  }
  private identity(a: AgentInfo) {
    const session = a.agent_session?.value;
    return session ? JSON.stringify(['session', agentKind(a), a.agent_session?.kind, session])
      : JSON.stringify(['pane', a.pane_id, agentKind(a), a.name || '', projectKey(a)]);
  }
  private employee(id: unknown) {
    const employee = this.state.employees.find(e => e.id === id);
    if (!employee) throw new Error('Employee no longer exists.');
    return employee;
  }
  private project(id: unknown) {
    const project = this.state.projects.find(p => p.id === id);
    if (!project) throw new Error('Project no longer exists.');
    return project;
  }
  private contributors(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string')) throw new Error('Choose contributors from the employee list.');
    return [...new Set(value)].map(id => this.employee(id).id);
  }
  private ensure(a: AgentInfo): Employee {
    const identity = this.identity(a);
    let employee = this.state.employees.find(e => e.id === this.state.identities[identity]);
    // Session metadata can arrive a poll after the agent itself. Adopt that first pane career
    // once, then remove its provisional binding so a later session cannot inherit it by accident.
    if (!employee && a.agent_session?.value) {
      const provisional = this.identity({ ...a, agent_session: null });
      employee = this.state.employees.find(e => e.id === this.state.identities[provisional]);
      if (employee) {
        this.ensuredChanges++;
        this.state.identities[identity] = employee.id;
        if (this.state.observations[provisional]) this.state.observations[identity] = this.state.observations[provisional];
        delete this.state.identities[provisional]; delete this.state.observations[provisional];
      }
    }
    if (!employee) {
      this.ensuredChanges++;
      const look = hash(a.pane_id);
      employee = { id: uuid(), version: 0, name: a.name?.trim() || agentKind(a).replace(/^./, c => c.toUpperCase()),
        bio: '', kind: agentKind(a), face: (look >>> 8) % 36, body: look % 26, favorite: false, createdAt: Date.now(), shipped: 0, stats: emptyCareer() };
      this.state.employees.push(employee); this.state.identities[identity] = employee.id;
    }
    this.paneIdentities.set(a.pane_id, identity);
    const key = projectKey(a);
    if (!this.state.projects.some(p => p.id === key)) { this.ensuredChanges++; this.state.projects.push({ id: key, version: 0, name: projectName(key), notes: '', color: BOARD_COLORS[this.state.projects.length % BOARD_COLORS.length], goals: [] }); }
    return employee;
  }
  decorate(a: AgentInfo): AgentInfo {
    const state = this.mutation?.state ?? this.state;
    const employee = state.employees.find(e => e.id === state.identities[this.identity(a)]);
    const prior = state.observations[this.identity(a)];
    const entry = employee && a.agent_status === 'idle' && prior?.credited && prior.workingAt
      ? state.journal.find(e => prior.entryId ? e.id === prior.entryId : e.source === 'agent' && e.kind === 'task' && e.at >= prior.workingAt && e.contributors.includes(employee.id)) : undefined;
    return employee ? { ...a, completed_task: entry ? { entry_id: entry.id, title: entry.title, at: entry.at } : null, employee_id: employee.id, office_name: employee.name,
      office_look: { body: employee.body, face: employee.face }, favorite: employee.favorite } : a;
  }
  /** Preserve the user's label while Herdr uses a stricter lowercase launch identifier. */
  nameHiredAgent(agent: AgentInfo, name: string) {
    this.transaction(() => {
      const employee = this.ensure(agent);
      const display = text(name, 40, true);
      if (employee.name !== display) { employee.name = display; employee.version++; }
    });
  }
  needsObservation(agents: AgentInfo[]): boolean {
    return agents.some(a => {
      const identity = this.identity(a), prior = this.state.observations[identity];
      return !this.state.identities[identity] || !this.state.projects.some(p => p.id === projectKey(a))
        || !prior || this.confirmedShortTurn(a, prior) || prior.status !== a.agent_status || (a.agent_status === 'working' && prior.title !== titleOf(a));
    });
  }
  private confirmedShortTurn(a: AgentInfo, prior: Observation) {
    return a.agent_status === 'idle' && !a.wait_notice && !prior.credited && prior.workingAt > 0
      && (a.last_turn_completed_at ?? 0) >= prior.workingAt;
  }
  observe(agents: AgentInfo[], now = Date.now()): { changed: boolean; completions: Map<string, Completion> } {
    const before = this.ensuredChanges;
    // Async callers already track changed records in run(); unchanged polls need no journal scan.
    const previous = this.asyncWrite ? undefined : structuredClone(this.state);
    let changed = false;
    const completions = new Map<string, Completion>();
    try {
      for (const agent of agents) {
        const employee = this.ensure(agent), key = this.identity(agent), title = titleOf(agent);
        const prior = this.state.observations[key];
        if (!prior) { changed = true; this.state.observations[key] = { status: agent.agent_status, title, workingAt: agent.agent_status === 'working' ? now : 0, credited: false }; continue; }
        if (prior.status === agent.agent_status && !this.confirmedShortTurn(agent, prior)) { if (agent.agent_status === 'working' && prior.title !== title) { prior.title = title; changed = true; } continue; }
        changed = true;
        const confirmed = this.confirmedShortTurn(agent, prior);
        const finished = confirmed || agent.agent_status === 'done' || (agent.agent_status === 'idle' && prior.status === 'working' && now - prior.workingAt > 60_000);
        if (finished && prior.workingAt && !prior.credited) {
          const task = prior.title || title || 'Completed task', stat = workKindForTitle(task);
          employee.shipped++; employee.stats[stat]++; prior.credited = true;
          const entry: JournalEntry = { id: uuid(), version: 0, at: now, kind: 'task', title: task, project: projectKey(agent), contributors: [employee.id],
            notes: confirmed || agent.agent_status === 'done' ? 'Agent reported completion.' : 'Returned to idle after working for more than a minute.', url: '', source: 'agent', stat,
            minutes: Math.max(1, Math.round((now - prior.workingAt) / 60_000)), model: agent.model || undefined };
          this.state.journal.push(entry); prior.entryId = entry.id;
          completions.set(agent.pane_id, { employeeId: employee.id, total: employee.shipped, stat, entryId: entry.id });
        }
        if (agent.agent_status === 'working' && (prior.status !== 'blocked' || !prior.workingAt || prior.credited)) { prior.workingAt = now; prior.credited = false; }
        prior.status = agent.agent_status; prior.title = title;
      }
      if (!changed && this.ensuredChanges === before) return { changed: false, completions };
      this.state.revision++; this.persist();
      return { changed: true, completions };
    } catch (error) { if (previous) this.state = previous; throw error; }
  }
  /** Money that actually moved becomes part of the story; attempts and lifecycle changes stay in
   *  the live feed. Keyed on the provider's event id, so a replayed poll or a restart cannot
   *  double-post. Dated when the money moved, not when the bridge heard about it. */
  recordSale(ev: MoneyEvent): boolean {
    // RevenueCat webhook lifecycle changes are durable history even when no money moved.
    // Stripe retains its existing payment/cancellation policy.
    const gone = ev.kind === 'churned' || ev.kind === 'expired';
    const why = gone && ev.detail ? [ev.detail.reason, ev.detail.feedback].filter(Boolean).join(' · ') : '';
    const leaving = gone && !!(why || ev.detail?.comment);
    const moved = ['sale', 'refund', 'dispute'].includes(ev.kind) && !!ev.amount;
    if (!moved && !leaving && ev.source !== 'revenuecat') return false;
    if (this.state.journal.some(e => e.moneyId === ev.id)) return false;
    if (leaving) {
      const d = ev.detail!, ends = d.ends ? new Date(d.ends) : undefined;
      const notes = [d.comment ? `“${d.comment}”` : '', d.plan ? `Plan: ${d.plan}` : '', ends && !Number.isNaN(ends.getTime()) ? `${ev.kind === 'expired' ? 'Ended' : 'Ends'}: ${ends.toISOString().slice(0, 10)}` : ''].filter(Boolean).join('\n');
      this.state.journal.push({ id: uuid(), version: 0, at: ev.ts, kind: 'sale', title: `${ev.kind === 'expired' ? 'Expired' : 'Cancelled'} · ${why || ev.label}`.slice(0, 160), notes, project: '', contributors: [],
        url: d.url ?? '', source: ev.source ?? 'stripe', moneyId: ev.id });
      this.state.revision++; this.persist();
      return true;
    }
    if (!moved && ev.source === 'revenuecat') {
      const titles: Partial<Record<MoneyEvent['kind'], string>> = { failed: 'Billing issue', trial_started: 'Trial started', subscription_started: 'Subscription started',
        subscription_pending: 'Subscription pending', subscription_resumed: 'Subscription resumed', subscribed: 'Subscribed', churned: 'Cancelled', expired: 'Expired', refund: 'Refund', sale: 'Payment' };
      const title = titles[ev.kind] ?? 'Subscription update';
      this.state.journal.push({ id: uuid(), version: 0, at: ev.ts, kind: 'sale', title: `${title}${ev.label ? ` · ${ev.label}` : ''}`.slice(0, 160),
        notes: ev.detail?.plan ? `Plan: ${ev.detail.plan}` : '', project: '', contributors: [], url: ev.detail?.url ?? '', source: 'revenuecat', moneyId: ev.id });
      this.state.revision++; this.persist(); return true;
    }
    const verb = ev.kind === 'sale' ? 'Payment' : ev.kind === 'refund' ? 'Refund' : 'Dispute';
    this.state.journal.push({ id: uuid(), version: 0, at: ev.ts, kind: 'sale', title: ev.label ? `${verb} · ${ev.label}`.slice(0, 160) : verb, notes: '', project: '', contributors: [], url: ev.detail?.url ?? '',
      source: ev.source ?? 'stripe', amount: ev.amount, currency: ev.currency, moneyId: ev.id });
    this.state.revision++; this.persist();
    return true;
  }
  /** Persist net subscription changes, not inferred purchases. The first reading establishes
   * a baseline; later readings survive browser closures and bridge restarts. */
  observeRevenueCat(project: string, count: number | undefined, at = Date.now()): MoneyEvent | null {
    if (!project || !Number.isSafeInteger(count) || count! < 0) return null;
    const previous = this.state.revenueCatSubscribers?.[project];
    if (previous === count) return null;
    return this.transaction(() => {
      (this.state.revenueCatSubscribers ??= {})[project] = count!;
      if (previous === undefined) return null;
      const delta = count! - previous;
      const label = `${delta > 0 ? '+' : ''}${delta} net · ${count} active subscriptions`;
      const event: MoneyEvent = { id: `rc_subs_${uuid()}`, ts: at, kind: delta > 0 ? 'subscribed' : 'churned', amount: 0, currency: 'usd', label };
      this.state.journal.push({ id: uuid(), version: 0, at, kind: 'note', source: 'revenuecat',
        title: `RevenueCat · ${label}`, notes: `Active subscriptions changed from ${previous} to ${count} for RevenueCat project ${project}. This is a net change observed between polls, not a count of individual purchases or cancellations.`,
        project: '', contributors: [], url: '', moneyId: event.id });
      return event;
    });
  }
  /** A pane's employee's agent-work entries that still carry the placeholder notes written before
   *  the pane could be read. */
  journalEntry(id: string): JournalEntry | undefined { return this.state.journal.find(e => e.id === id); }
  placeholdersFor(a: AgentInfo): JournalEntry[] {
    const employee = this.state.employees.find(e => e.id === this.state.identities[this.identity(a)]);
    if (!employee) return [];
    return this.state.journal.filter(e => e.source === 'agent' && e.version === 0 && e.contributors.includes(employee.id)
      && /^(Agent reported completion\.|Returned to idle after working for more than a minute\.)$/.test(e.notes));
  }
  /** Fill a fresh completion in from what its pane says: the person's prompt as the title when
   *  the window title was only the folder, and the agent's own closing reply as the notes. */
  describe(entryId: string, outcome: Outcome, windowTitle?: string): boolean {
    const entry = this.state.journal.find(e => e.id === entryId);
    if (!entry || entry.source !== 'agent' || entry.version !== 0 || (!outcome.prompt && !outcome.summary)) return false;
    // judged from the window's own title, so a second, fuller read can still improve on the first
    entry.title = taskTitle(windowTitle ?? entry.title, entry.project, outcome).slice(0, 160);
    if (outcome.summary) entry.notes = outcome.summary;
    this.state.revision++; this.persist();
    return true;
  }
  actionStatus(id: string) {
    const receipt = this.state.actionReceipts?.[id];
    return receipt ? { state: 'confirmed' as const, revision: receipt.revision } : { state: 'unknown' as const };
  }
  get revision() { return this.state.revision; }
  /** Receipt and edit commit together in the same SQLite transaction. Call inside run(). */
  changeOnce(params: Record<string, unknown>, agents: AgentInfo[]) {
    const id = params.action_id;
    if (id === undefined) { this.change(params, agents, { snapshot: false }); return; }
    if (!this.asyncWrite || !this.inOperation) throw new Error('Save receipts require an atomic studio operation.');
    if (typeof id !== 'string' || !/^\d{13}-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid save ID.');
    const hash = createHash('sha256').update(canonicalAction(params)).digest('hex');
    const receipt = this.state.actionReceipts?.[id];
    if (receipt) {
      if (receipt.hash !== hash) throw new Error('This save ID belongs to a different edit.');
      return;
    }
    const at = Number(id.slice(0, 13));
    if (at <= (this.state.actionFloor ?? 0) || at < Date.now() - 7 * 86400_000 || at > Date.now() + 300_000) throw new Error('This save has expired. Reopen the item before making a new edit.');
    this.change(actionPayload(params), agents, { snapshot: false });
    const receipts = { ...this.state.actionReceipts, [id]: { hash, revision: this.state.revision, at } };
    const sorted = Object.keys(receipts).sort((a, b) => receipts[a].at - receipts[b].at);
    for (const old of sorted.slice(0, Math.max(0, sorted.length - 256))) {
      this.state.actionFloor = Math.max(this.state.actionFloor ?? 0, receipts[old].at); delete receipts[old];
    }
    this.state.actionReceipts = receipts; this.persist();
  }
  change(params: Record<string, unknown>, agents: AgentInfo[]): StudioState;
  change(params: Record<string, unknown>, agents: AgentInfo[], options: { snapshot: false }): void;
  change(params: Record<string, unknown>, agents: AgentInfo[], options?: { snapshot: false }): StudioState | void {
    this.transaction(() => {
      switch (params.op) {
        case 'project.save': {
          const project = this.project(params.id); checkedVersion(project, params.version);
          const color = text(params.color, 7); if (!BOARD_COLORS.includes(color)) throw new Error('Choose a board color.');
          project.name = text(params.name, 60, true); project.notes = text(params.notes, 4000); project.color = color; project.version++; break;
        }
        case 'goal.save': {
          const project = this.project(params.project);
          const existing = project.goals.find(g => g.id === params.id);
          if (params.id && !existing) throw new Error('This milestone was removed.');
          if (existing) checkedVersion(existing, params.version);
          if (!existing && project.goals.length >= 100) throw new Error('This board already has 100 milestones.');
          if (!Array.isArray(params.checklist) || params.checklist.length > 40) throw new Error('Use up to 40 checklist items.');
          const checklist = params.checklist.map((item: any) => ({ id: typeof item?.id === 'string' ? text(item.id, 80, true) : uuid(), text: text(item?.text, 200, true), done: item?.done === true }));
          if (new Set(checklist.map(item => item.id)).size !== checklist.length) throw new Error('Checklist item ids must be unique.');
          const due = text(params.due ?? '', 10); if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || new Date(`${due}T00:00:00Z`).toISOString().slice(0, 10) !== due)) throw new Error('Choose a valid due date.');
          const done = params.done === true;
          const goal: Milestone = { id: existing?.id ?? uuid(), version: (existing?.version ?? -1) + 1, title: text(params.title, 120, true),
            notes: text(params.notes, 4000), done, completedAt: done ? existing?.completedAt ?? Date.now() : undefined,
            contributors: this.contributors(params.contributors), checklist, url: link(params.url), due };
          if (existing) project.goals.splice(project.goals.indexOf(existing), 1, goal); else project.goals.push(goal);
          project.version++;
          const entry = this.state.journal.find(e => e.goalId === goal.id);
          if (done) {
            const record: JournalEntry = { id: entry?.id ?? uuid(), version: (entry?.version ?? -1) + 1, at: goal.completedAt!, kind: 'milestone', title: goal.title,
              notes: goal.notes, project: project.id, contributors: goal.contributors, url: goal.url, source: 'goal', goalId: goal.id };
            if (entry) this.state.journal.splice(this.state.journal.indexOf(entry), 1, record); else this.state.journal.push(record);
          } else if (entry) this.state.journal = this.state.journal.filter(row => row.id !== entry.id);
          break;
        }
        case 'goal.remove': {
          const project = this.project(params.project), goal = project.goals.find(g => g.id === params.id);
          if (!goal) throw new Error('This milestone was already removed.'); checkedVersion(goal, params.version);
          project.goals = project.goals.filter(g => g !== goal); project.version++;
          this.state.journal = this.state.journal.filter(e => e.goalId !== goal.id); break;
        }
        case 'goal.move': {
          const project = this.project(params.project); checkedVersion(project, params.version);
          const index = project.goals.findIndex(g => g.id === params.id), target = index + (params.direction === 'up' ? -1 : 1);
          if (index < 0 || target < 0 || target >= project.goals.length) throw new Error('Milestone cannot move further.');
          [project.goals[index], project.goals[target]] = [project.goals[target], project.goals[index]]; project.version++; break;
        }
        case 'employee.save': {
          const employee = this.employee(params.id); checkedVersion(employee, params.version);
          employee.name = text(params.name, 40, true); employee.bio = text(params.bio, 1000);
          employee.face = integer(params.face, 0, 35); employee.body = integer(params.body, 0, 25); employee.favorite = params.favorite === true; employee.version++; break;
        }
        case 'employee.bind': {
          const agent = agents.find(a => a.pane_id === params.pane); if (!agent) throw new Error('That agent is no longer at a desk.');
          const employee = this.employee(params.id);
          this.state.identities[this.identity(agent)] = employee.id; break;
        }
        case 'entry.save': {
          const existing = this.state.journal.find(e => e.id === params.id);
          if (params.id && !existing) throw new Error('This journal entry was removed.');
          if (existing) { checkedVersion(existing, params.version); if (existing.source === 'goal') throw new Error('Edit this milestone on its whiteboard.'); }
          const project = params.project ? this.project(params.project).id : '';
          const kind = existing?.kind === 'sale' ? 'sale' : existing?.source === 'agent' ? 'task' : params.kind === 'release' ? 'release' : 'note';
          const entry: JournalEntry = { id: existing?.id ?? uuid(), version: (existing?.version ?? -1) + 1, at: existing?.at ?? Date.now(),
            kind, title: text(params.title, 160, true), notes: text(params.notes, 6000), project,
            contributors: existing?.source === 'agent' || existing?.kind === 'sale' ? existing.contributors : this.contributors(params.contributors), url: link(params.url), source: existing?.source ?? 'manual', stat: existing?.stat,
            readAt: existing?.readAt, minutes: existing?.minutes, model: existing?.model, amount: existing?.amount, currency: existing?.currency, moneyId: existing?.moneyId };
          if (existing) this.state.journal.splice(this.state.journal.indexOf(existing), 1, entry); else this.state.journal.push(entry); break;
        }
        case 'entry.read': {
          const entry = this.state.journal.find(e => e.id === params.id);
          if (!entry) throw new Error('This journal entry was removed.');
          checkedVersion(entry, params.version);
          if (typeof params.read !== 'boolean') throw new Error('Choose read or unread.');
          if (params.read) entry.readAt = Date.now(); else delete entry.readAt;
          entry.version++; break;
        }
        case 'entry.remove': {
          const entry = this.state.journal.find(e => e.id === params.id); if (!entry) throw new Error('Entry was already removed.'); checkedVersion(entry, params.version);
          if (entry.source === 'goal') throw new Error('Reopen or remove this milestone on its whiteboard.');
          if (entry.source === 'agent' && entry.stat) for (const id of entry.contributors) { const employee = this.employee(id); employee.shipped = Math.max(0, employee.shipped - 1); employee.stats[entry.stat] = Math.max(0, employee.stats[entry.stat] - 1); }
          this.state.journal = this.state.journal.filter(e => e.id !== entry.id); break;
        }
        case 'room.save': {
          checkedVersion(this.state.room, params.version);
          if (!Array.isArray(params.items) || params.items.length > 200) throw new Error('The office can hold up to 200 furnishings.');
          const items: RoomItem[] = params.items.map((item: any) => {
            if (!item || !['decor', 'whiteboard', 'cabinet', 'trophy', 'boss'].includes(item.kind)) throw new Error('Choose a furnishing from the catalog.');
            const asset = item.kind === 'decor' ? text(item.asset, 100, true) : undefined;
            if (asset && !/^[a-zA-Z0-9_-]+$/.test(asset)) throw new Error('Invalid furnishing.');
            return { id: text(item.id, 160, true), kind: item.kind, asset, project: item.kind === 'whiteboard' ? this.project(item.project).id : undefined,
              x: integer(item.x, -8000, 8000), y: integer(item.y, 0, 8000) };
          });
          if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Furnishing ids must be unique.');
          if (!Array.isArray(params.projectOrder) || params.projectOrder.length > 300) throw new Error('Invalid project order.');
          this.state.room = { version: this.state.room.version + 1, items, projectOrder: [...new Set(params.projectOrder.map(id => this.project(id).id))] }; break;
        }
        case 'legacy.import': {
          // Import a browser's old pane counters once per career, without doubling another tab's copy.
          if (!Array.isArray(params.rows) || params.rows.length > 500) throw new Error('Invalid career import.');
          for (const row of params.rows) {
            const agent = agents.find(a => a.pane_id === row?.pane); if (!agent) continue;
            const employee = this.employee(this.state.identities[this.identity(agent)]);
            if (this.state.imports.includes(employee.id)) continue;
            const count = integer(row.shipped, 0, 1_000_000);
            if (count <= 0) continue;
            employee.shipped = Math.max(employee.shipped, count);
            for (const stat of CAREER_STATS) employee.stats[stat] = Math.max(employee.stats[stat], integer(row.stats?.[stat] ?? 0, 0, 1_000_000));
            this.state.imports.push(employee.id);
          }
          break;
        }
        default: throw new Error('Unknown studio action.');
      }
    });
    if (options?.snapshot === false) return;
    return this.snapshot(this.asyncWrite ? 100 : undefined);
  }
}
