import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo, MoneyEvent, OfficeEvent } from '../shared/types';
import type { ReplayMoment } from '../shared/replay';
import { REPLAY_LIMIT, replayRange, type ReplayData } from '../shared/replay';
import type { StudioStore } from './studio';
import type { StudioState } from '../shared/studio';

/** Bounded local status history. No terminal transcripts, customer details, or prompt attachments. */
export class ReplayStore {
  private db: Database;
  private previous = new Map<string, string>();
  private pruneAt = 0;
  private studioKey = "";
  constructor(directory?: string) {
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = directory ? join(directory, 'replay.sqlite') : ':memory:';
    this.db = new Database(file);
    if (directory) chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, pane TEXT NOT NULL, data TEXT);
      CREATE INDEX IF NOT EXISTS replay_time ON changes(at,id);
      CREATE INDEX IF NOT EXISTS replay_pane ON changes(pane,id);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recordings_time ON recordings(at,id);
      CREATE INDEX IF NOT EXISTS recordings_kind ON recordings(kind,at);`);
    const latest = this.db.query('SELECT pane,data FROM changes WHERE id IN (SELECT MAX(id) FROM changes GROUP BY pane)').all() as {pane:string;data:string|null}[];
    for (const row of latest) if (row.data) this.previous.set(row.pane, row.data);
  }
  record(agents: AgentInfo[], at = Date.now()) {
    const next = new Map<string, string>();
    for (const a of agents) next.set(a.pane_id, JSON.stringify({ pane_id: a.pane_id, workspace_id: a.workspace_id,
      workspace_name: a.workspace_name, office_role: a.office_role, agent: a.agent, agent_status: a.agent_status, name: a.name, office_name: a.office_name, employee_id: a.employee_id,
      office_look: a.office_look, favorite: a.favorite, cwd: a.foreground_cwd || a.cwd,
      title: (a.title || '').slice(0, 500), model: a.model,
      wait_notice: a.wait_notice ? { kind: a.wait_notice.kind, detail: a.wait_notice.detail.slice(0, 500) } : null }));
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO meta VALUES ('started',?)").run(at);
      const insert = this.db.query('INSERT INTO changes(at,pane,data) VALUES(?,?,?)');
      for (const [pane, data] of next) if (this.previous.get(pane) !== data) insert.run(at, pane, data);
      for (const pane of this.previous.keys()) if (!next.has(pane)) insert.run(at, pane, null);
      if (at >= this.pruneAt) {
        // Retain one baseline per pane before the window, without accumulating departed agents.
        const cutoff = at - 14 * 86400_000;
        this.db.query(`DELETE FROM changes WHERE at < ? AND id NOT IN
          (SELECT MAX(id) FROM changes WHERE at < ? GROUP BY pane HAVING data IS NOT NULL)`).run(cutoff, cutoff);
        this.db.query("DELETE FROM recordings WHERE at < ? AND id NOT IN (SELECT id FROM recordings WHERE kind='studio' AND at < ? ORDER BY at DESC LIMIT 1)").run(cutoff, cutoff);
        this.pruneAt = at + 3600_000;
      }
    })();
    this.previous = next;
  }
  range(from: number, to: number) {
    const started = this.db.query("SELECT value FROM meta WHERE key='started'").get() as {value:number}|null;
    const recordedSince = started ? Math.max(started.value, Date.now() - 14 * 86400_000) : null;
    if (recordedSince === null || to < recordedSince) return { agents: [] as AgentInfo[], recordedSince, moments: [] as ReplayMoment[] };
    const effectiveFrom = Math.max(from, recordedSince);
    const baseline = this.db.query(`SELECT data FROM changes WHERE id IN
      (SELECT MAX(id) FROM changes WHERE at <= ? GROUP BY pane) AND data IS NOT NULL`).all(effectiveFrom) as {data:string}[];
    const rows = this.db.query('SELECT id,at,pane,data FROM changes WHERE at > ? AND at <= ? ORDER BY at,id LIMIT ?')
      .all(effectiveFrom, to, REPLAY_LIMIT + 1) as {id:number;at:number;pane:string;data:string|null}[];
    const agents = baseline.map(r => JSON.parse(r.data) as AgentInfo);
    const moments: ReplayMoment[] = rows.map(r => ({ id: `status:${r.id}`, at: r.at, kind: 'agent', pane: r.pane, agent: r.data ? JSON.parse(r.data) : null }));
    // A retained baseline describes the retention boundary, never an older unrecorded period.
    if (from < recordedSince) moments.unshift(...agents.map(agent => ({ id: `baseline:${agent.pane_id}`, at: recordedSince, kind: 'agent' as const, pane: agent.pane_id, agent })));
    if (moments.length > REPLAY_LIMIT) throw new Error('Too much activity for one replay. Choose a shorter range.');
    return { agents: from < recordedSince ? [] : agents, recordedSince, moments };
  }

  currentAgents(): AgentInfo[] { return [...this.previous.values()].map(data => JSON.parse(data)); }
  recordStudio(studio: StudioState, at = Date.now()) {
    const state = structuredClone(studio);
    state.journal = []; delete state.journalCursor; delete state.journalRetired; delete state.journalInvalidated;
    const key = JSON.stringify(state);
    if (key === this.studioKey) return;
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO meta VALUES ('studio-started',?)").run(at);
      this.db.query('INSERT OR REPLACE INTO recordings VALUES (?,?,?,?)').run(`studio:${at}:${state.revision}`, 'studio', at, key);
    })();
    this.studioKey = key;
  }
  recordEvent(event: MoneyEvent | OfficeEvent) {
    const kind = 'pane_id' in event ? 'event' : 'money';
    this.db.query('INSERT OR IGNORE INTO recordings VALUES (?,?,?,?)').run(`${kind}:${event.id}`, kind, event.ts, JSON.stringify(event));
  }
  presentation(from: number, to: number) {
    const started = this.db.query("SELECT value FROM meta WHERE key='studio-started'").get() as {value:number}|null;
    const studioRecordedSince = started ? Math.max(started.value, Date.now() - 14 * 86400_000) : null;
    const baseline = studioRecordedSince !== null && from >= studioRecordedSince
      ? this.db.query("SELECT data FROM recordings WHERE kind='studio' AND at <= ? ORDER BY at DESC LIMIT 1").get(from) as {data:string}|null : null;
    const rows = this.db.query('SELECT id,kind,at,data FROM recordings WHERE at >= ? AND at <= ? ORDER BY at,id LIMIT ?')
      .all(from, to, REPLAY_LIMIT + 1) as {id:string;kind:string;at:number;data:string}[];
    if (rows.length > REPLAY_LIMIT) throw new Error('Too much activity for one replay. Choose a shorter range.');
    const moments: ReplayMoment[] = rows.map(row => ({ id:row.id, at:row.at, kind:row.kind,
      ...(row.kind === 'studio' ? { studio:JSON.parse(row.data) } : { event:JSON.parse(row.data) }) } as ReplayMoment));
    return { studioRecordedSince, studio: baseline ? JSON.parse(baseline.data) as StudioState : undefined, moments };
  }
  close() { this.db.close(); }
}


/** The journal remains the authority for tasks and payments; do not duplicate its ledger. */
export function buildReplay(store: ReplayStore, studio: StudioStore, fromValue: unknown, toValue: unknown): ReplayData {
  const { from, to } = replayRange(fromValue, toValue);
  const history = store.range(from, to);
  const presentation = store.presentation(from, to);
  const moments = [...history.moments, ...presentation.moments];
  const payments = new Map(presentation.moments.filter(m => m.kind === 'money').map(m => [m.event.id, m]));
  let cursor: string | undefined = JSON.stringify([to + 1, '']);
  do {
    const page = studio.journalPage({ since: Math.max(0, from - 1), cursor, limit: 200 });
    for (const entry of page.entries) if (entry.at >= from && entry.at <= to) {
      const payment = entry.moneyId ? payments.get(entry.moneyId) : undefined;
      if (payment) payment.entry = entry;
      else moments.push({ id: `journal:${entry.id}`, at: entry.at, kind: 'journal', entry });
    }
    if (moments.length > REPLAY_LIMIT) throw new Error('Too much activity for one replay. Choose a shorter range.');
    cursor = page.cursor ?? undefined;
  } while (cursor);
  moments.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const state = studio.snapshot(1);
  state.journal = []; state.journalTotal = 0; state.journalCursor = null;
  delete state.journalSummary;
  return { from, to, recordedSince: history.recordedSince, studioRecordedSince: presentation.studioRecordedSince, contextAgents: store.currentAgents(), moments,
    snapshot: { version: 1, capturedAt: from, theme: 'classic', agents: history.agents,
      workspaces: [], events: [], money: [], studio: presentation.studio ?? state, revenue: {}, transcripts: {} } };
}
