import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo } from '../shared/types';
import { agentKind } from '../shared/types';
import { employeeName, projectKey } from '../shared/studio';
import { SWEEP_INTERVALS, type SweepAgent, type SweepScan, type SweepRecap, type SweepReview, type SweepResult } from '../shared/sweep';
import type { Transcript } from './transcript';
import { extractOutcome } from './outcome';

export interface SweepSnapshot {
  agents: AgentInfo[];
  workspaces: { workspace_id: string; label: string; focused?: boolean }[];
  panes?: { pane_id: string; workspace_id: string }[];
}
interface Dependencies {
  snapshot(): Promise<SweepSnapshot>;
  lastActivity(agent: AgentInfo): Promise<number | undefined>;
  transcript(agent: AgentInfo): Promise<Transcript | undefined>;
  read(agent: AgentInfo): Promise<string>;
  save(id: string, agent: AgentInfo, recap: SweepRecap): Promise<string>;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  queued(agent: AgentInfo, fresh?: boolean): boolean | Promise<boolean>;
  now?: () => number;
}
interface Observation { fingerprint: string; since: number }
interface ReviewState {
  review: SweepReview; agents: AgentInfo[]; fingerprints: string[]; activity: number[]; minutes: number;
  promise?: Promise<SweepResult>; result?: SweepResult;
}
const idle = (a: AgentInfo) => a.agent_status === 'idle' || a.agent_status === 'done';
const identity = (a: AgentInfo) => JSON.stringify([a.pane_id, agentKind(a), a.agent_session?.kind, a.agent_session?.value, a.cwd]);
const fingerprint = (a: AgentInfo) => JSON.stringify([identity(a), a.state_change_seq, a.agent_status]);
const workspaceId = (a: AgentInfo) => a.workspace_id || a.pane_id.split(':')[0];
const bounded = (s: string, length: number) => s.length <= length ? s : s.slice(0, length - 1).trimEnd() + '…';

/** Preserve evidence first; only the exact, still-idle sessions reviewed by the user may close. */
export class SweepService {
  private db: Database;
  private observations = new Map<string, Observation>();
  private reviews = new Map<string, ReviewState>();
  private closing = new Set<string>();
  private now: () => number;
  constructor(private deps: Dependencies, directory?: string) {
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = directory ? join(directory, 'sweep.sqlite') : ':memory:';
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS activity (identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, since INTEGER NOT NULL)');
    if (directory) chmodSync(path, 0o600);
    this.now = deps.now ?? Date.now;
  }
  isClosing(paneId: string) { return this.closing.has(paneId); }
  private store(a: AgentInfo, record: Observation) {
    this.observations.set(identity(a), record);
    this.db.query('INSERT OR REPLACE INTO activity VALUES (?, ?, ?)').run(identity(a), record.fingerprint, record.since);
  }
  touch(a: AgentInfo) { this.store(a, { fingerprint: fingerprint(a), since: this.now() }); }
  async observe(agents: AgentInfo[]) {
    for (const a of agents) {
      const key = identity(a);
      const previous = this.observations.get(key) ?? this.db.query('SELECT fingerprint, since FROM activity WHERE identity = ?').get(key) as Observation | undefined;
      if (previous?.fingerprint === fingerprint(a)) { this.observations.set(key, previous); continue; }
      const recorded = !previous && idle(a) ? await this.deps.lastActivity(a).catch(() => undefined) : undefined;
      this.store(a, { fingerprint: fingerprint(a), since: recorded && recorded <= this.now() ? recorded : this.now() });
    }
    const live = new Set(agents.map(identity));
    for (const key of this.observations.keys()) if (!live.has(key)) this.observations.delete(key);
  }
  private minutes(value: unknown) {
    const minutes = value === undefined ? 60 : Number(value);
    if (!SWEEP_INTERVALS.some(interval => interval.minutes === minutes)) throw new Error('Choose an inactivity interval.');
    return minutes;
  }
  private async candidate(a: AgentInfo, minutes: number, fresh = false): Promise<SweepAgent> {
    const observation = this.observations.get(identity(a)) ?? { since: this.now() };
    const recorded = await this.deps.lastActivity(a).catch(() => undefined);
    const lastActiveAt = Math.max(observation.since, recorded && recorded <= this.now() ? recorded : 0);
    let queued = false, queueUnavailable = false;
    if (idle(a) && !a.focused && this.now() - lastActiveAt >= minutes * 60_000) {
      try { queued = await this.deps.queued(a, fresh); } catch { queueUnavailable = true; }
    }
    const reason = !idle(a) ? 'Still working or needs attention' : a.focused ? 'Open in your terminal'
      : queued ? 'Has queued prompts' : queueUnavailable ? 'Queue status unavailable'
      : this.now() - lastActiveAt < minutes * 60_000 ? 'Recently active' : undefined;
    return { agent: a, lastActiveAt, eligible: !reason, reason };
  }
  private async inspect(minutes: number, fresh = false) {
    const snapshot = await this.deps.snapshot();
    await this.observe(snapshot.agents);
    const candidates = await Promise.all(snapshot.agents.map(a => this.candidate(a, minutes, fresh)));
    return { snapshot, candidates };
  }
  async scan(value?: unknown): Promise<SweepScan> {
    const minutes = this.minutes(value), { snapshot, candidates } = await this.inspect(minutes);
    return { at: this.now(), minutes, protectedCount: candidates.filter(c => !idle(c.agent)).length,
      workspaces: snapshot.workspaces.map(w => {
        const all = candidates.filter(c => workspaceId(c.agent) === w.workspace_id);
        const ids = new Set(all.map(c => c.agent.pane_id));
        return { id: w.workspace_id, name: w.label || w.workspace_id, agents: all.filter(c => idle(c.agent)).sort((a, b) => a.lastActiveAt - b.lastActiveAt),
          activeAgents: all.filter(c => !idle(c.agent)).length,
          otherPanes: snapshot.panes ? snapshot.panes.filter(p => p.workspace_id === w.workspace_id && !ids.has(p.pane_id)).length : -1 };
      }).filter(w => w.agents.length).sort((a, b) => a.agents[0].lastActiveAt - b.agents[0].lastActiveAt) };
  }
  async prepare(params: Record<string, unknown>): Promise<SweepReview> {
    const minutes = this.minutes(params.minutes);
    const ids = params.paneIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Select 1–50 agents to review.');
    const { snapshot, candidates } = await this.inspect(minutes);
    const selected = ids.map(id => {
      const c = candidates.find(c => c.agent.pane_id === id);
      if (!c?.eligible) throw new Error(`${id}: ${c?.reason || 'Agent has left'}. Scan again.`);
      return c;
    });
    const recaps: SweepRecap[] = [];
    for (const c of selected) recaps.push(await this.recap(c.agent, snapshot));
    const selectedIds = new Set(ids);
    const closeWorkspaces = snapshot.panes ? snapshot.workspaces.filter(w => {
      const panes = snapshot.panes!.filter(p => p.workspace_id === w.workspace_id);
      return !w.focused && panes.length > 0 && panes.every(p => selectedIds.has(p.pane_id));
    }).map(w => ({ id: w.workspace_id, name: w.label || w.workspace_id })) : [];
    for (const [token, state] of this.reviews) if (state.review.expiresAt < this.now() && !state.promise) this.reviews.delete(token);
    if (this.reviews.size >= 30) throw new Error('Too many open reviews. Try again after an older review expires.');
    const review: SweepReview = { token: crypto.randomUUID(), expiresAt: this.now() + 15 * 60_000, recaps, closeWorkspaces };
    this.reviews.set(review.token, { review, agents: selected.map(c => c.agent), fingerprints: selected.map(c => fingerprint(c.agent)), activity: selected.map(c => c.lastActiveAt), minutes });
    return review;
  }
  private async recap(a: AgentInfo, snapshot: SweepSnapshot): Promise<SweepRecap> {
    const transcript = await this.deps.transcript(a).catch(() => undefined);
    let prompt = transcript?.prompt || a.last_prompt || '', findings = transcript?.reply || '';
    let source: SweepRecap['source'] = findings ? 'transcript' : 'unavailable';
    if (!findings) {
      try { const outcome = extractOutcome(await this.deps.read(a)); prompt ||= outcome.prompt || ''; findings = outcome.summary || ''; if (findings) source = 'terminal'; } catch {}
    }
    const evidence = [findings, ...(transcript?.turns.slice(-3).map(t => t.reply || '') ?? [])].join('\n');
    let artifactBytes = 0;
    const artifacts = [...new Set([
      ...(evidence.match(/https?:\/\/[^\s<>"`\)\]]+/g) ?? []).map(s => s.replace(/[.,;]+$/, '')),
      ...(evidence.match(/(?:\/(?:tmp|home|Users)\/[^\s<>"`\)\]]+|\b(?:src|public|recordings|docs|reports|artifacts)\/[^\s<>"`\)\]]+)/g) ?? []).map(s => s.replace(/[.,;]+$/, '')),
    ])].filter(s => s.length < 500).slice(0, 12).filter(s => { if (artifactBytes + s.length + 3 > 1500) return false; artifactBytes += s.length + 3; return true; });
    const name = employeeName(a), workspace = snapshot.workspaces.find(w => w.workspace_id === workspaceId(a))?.label || workspaceId(a);
    const session = a.agent_session?.value || '';
    prompt = bounded(prompt || 'No recorded prompt available.', 900);
    const metadata = bounded(`Workspace: ${workspace} (${workspaceId(a)})\nAgent: ${agentKind(a)} · ${a.pane_id}\nSession: ${session || 'not reported'}\nProject: ${projectKey(a)}`, 1000);
    const references = artifacts.length ? artifacts.map(s => '- ' + s).join('\n') : 'No artifact paths or links were mentioned in the recent replies.';
    findings = bounded(findings || 'No final reply was available. Open this agent to review its conversation before closing.', Math.min(3000, 5800 - metadata.length - prompt.length - references.length));
    const notes = `${metadata}\n\n## Last prompt\n${prompt}\n\n## Last findings${source === 'terminal' ? ' (terminal excerpt)' : ''}\n${findings}\n\n## Artifacts mentioned\n${references}`;
    return { paneId: a.pane_id, name, workspace, project: projectKey(a), status: a.agent_status, prompt, findings, artifacts, session, notes, source };
  }
  finish(params: Record<string, unknown>): Promise<SweepResult> {
    const state = this.reviews.get(String(params.token));
    if (!state) return Promise.reject(new Error('Review expired. Scan again.'));
    if (state.result) return Promise.resolve(state.result);
    if (state.promise) return state.promise;
    if (state.review.expiresAt < this.now()) return Promise.reject(new Error('Review expired. Scan again.'));
    const close = params.close === true;
    if (close && (!Array.isArray(params.confirm) || JSON.stringify([...params.confirm].sort()) !== JSON.stringify(state.agents.map(a => a.pane_id).sort()))) return Promise.reject(new Error('Confirm the exact agents shown in this review.'));
    if (state.agents.some(a => this.closing.has(a.pane_id))) return Promise.reject(new Error('One of these agents is already being swept.'));
    for (const a of state.agents) this.closing.add(a.pane_id);
    state.promise = this.complete(state, close).then(result => state.result = result).finally(() => { for (const a of state.agents) this.closing.delete(a.pane_id); state.promise = undefined; });
    return state.promise;
  }
  private async complete(state: ReviewState, close: boolean): Promise<SweepResult> {
    const result: SweepResult = { saved: [], closed: [], closedWorkspaces: [], kept: [] };
    // Persist every reviewed recap before making any destructive call. A failed save stops here.
    for (let i = 0; i < state.agents.length; i++) {
      const a = state.agents[i];
      const entryId = await this.deps.save(`sweep:${state.review.token}:${a.pane_id}`, a, state.review.recaps[i]);
      result.saved.push({ paneId: a.pane_id, entryId });
    }
    if (!close) return result;
    const checked = async () => {
      const { snapshot, candidates } = await this.inspect(state.minutes, true);
      const safe = new Set<string>();
      state.agents.forEach((a, i) => {
        const live = candidates.find(c => c.agent.pane_id === a.pane_id);
        if (live?.eligible && fingerprint(live.agent) === state.fingerprints[i] && live.lastActiveAt === state.activity[i]) safe.add(a.pane_id);
      });
      // Transcript and queue checks can take time. Refresh pane membership and status once more
      // after that I/O, immediately before the close call.
      const latest = await this.deps.snapshot();
      for (const id of safe) {
        const a = latest.agents.find(a => a.pane_id === id);
        const i = state.agents.findIndex(a => a.pane_id === id);
        if (!a || !idle(a) || a.focused || fingerprint(a) !== state.fingerprints[i]) safe.delete(id);
      }
      return { snapshot: latest, safe };
    };
    try {
      for (const w of state.review.closeWorkspaces) {
        const { snapshot, safe } = await checked();
        const panes = snapshot.panes?.filter(p => p.workspace_id === w.id);
        const reviewed = state.agents.filter(a => workspaceId(a) === w.id);
        if (!snapshot.workspaces.find(item => item.workspace_id === w.id && !item.focused) || !panes?.length || !panes.every(p => safe.has(p.pane_id)) || !reviewed.every(a => panes.some(p => p.pane_id === a.pane_id))) continue;
        try { await this.deps.call('workspace.close', { workspace_id: w.id, close_group: false }); result.closedWorkspaces.push(w.id); result.closed.push(...panes.map(p => p.pane_id)); }
        catch { /* Linked workspace groups stay intact; individual reviewed panes can still close. */ }
      }
      for (const a of state.agents) {
        if (result.closed.includes(a.pane_id)) continue;
        const { snapshot, safe } = await checked();
        if (!safe.has(a.pane_id)) { result.kept.push({ paneId: a.pane_id, reason: 'Activity, focus, queued work, or session changed. Scan again to review it.' }); continue; }
        const panes = snapshot.panes?.filter(p => p.workspace_id === workspaceId(a));
        if (!panes?.some(p => p.pane_id === a.pane_id) || (panes.length === 1 && (!state.review.closeWorkspaces.some(w => w.id === workspaceId(a)) || snapshot.workspaces.some(w => w.workspace_id === workspaceId(a) && w.focused)))) {
          result.kept.push({ paneId: a.pane_id, reason: 'Workspace contents changed or could not be verified. Scan again before closing its last pane.' }); continue;
        }
        try {
          await this.deps.call('pane.close', { pane_id: a.pane_id }); result.closed.push(a.pane_id);
          if (panes.length === 1) result.closedWorkspaces.push(workspaceId(a));
        }
        catch (error) { result.kept.push({ paneId: a.pane_id, reason: (error as Error).message }); }
      }
    } catch (error) {
      for (const a of state.agents) if (!result.closed.includes(a.pane_id) && !result.kept.some(item => item.paneId === a.pane_id)) {
        result.kept.push({ paneId: a.pane_id, reason: `Could not recheck activity; no further close was attempted. ${(error as Error).message}` });
      }
    }
    return result;
  }
  dispose() { this.db.close(); }
}
