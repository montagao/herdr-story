import { type RecapMoney } from '../shared/recap-money';
// Where the studio lives on disk: one SQLite file, one row per employee, project, journal entry,
// identity and observation. A change writes only the rows it touched — the journal grows by a row
// per completion instead of the whole studio being rewritten — and SQLite's WAL gives crash
// safety without a temp-file-and-rename dance. bun:sqlite is built into Bun: no dependency.
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry, JournalPageQuery } from '../shared/studio';

const ROWS = ['employees', 'projects', 'journal'] as const;
const MAPS = ['identities', 'observations'] as const;
/** The studio's shape on disk, mirrored from StudioStore's SavedStudio without importing it. */
export interface Saved {
  actionReceipts?: Record<string, { hash: string; revision: number; at: number }>; actionFloor?: number;
  version: number; revision: number;
  employees: { id: string }[]; projects: { id: string }[]; journal: { id: string; at: number; kind: string }[];
  room: unknown; imports: string[]; identities: Record<string, string>; observations: Record<string, unknown>; revenueCatSubscribers?: Record<string, number>;
}

/** Explicit row changes: the worker never needs a copy of unchanged studio history. */
export interface SavedPatch {
  rows: Partial<Record<'employees' | 'projects' | 'journal', { upsert: any[]; remove: string[] }>>;
  maps: Partial<Record<'identities' | 'observations', { upsert: Record<string, unknown>; remove: string[] }>>;
  meta: Record<string, unknown>;
}
export interface JournalRead extends JournalPageQuery { limit: number; before?: [number, string] }

export class Storage {
  readonly path: string;
  private db: Database;
  /** What each row last held on disk, so a save only writes what changed. */
  private written = new Map<string, Map<string, string>>();
  constructor(directory: string) {
    this.path = join(directory, 'studio.sqlite');
    this.db = new Database(this.path, { create: true });
    // owner-only, before WAL creates its sidecar files with the same permissions
    chmodSync(this.path, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, data TEXT NOT NULL, search_name TEXT);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, search_text TEXT);
      CREATE INDEX IF NOT EXISTS journal_at ON journal (at);
      CREATE INDEX IF NOT EXISTS journal_page ON journal (at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS journal_kind_page ON journal (kind, at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS journal_project_page ON journal (json_extract(data, '$.project'), at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS identities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    // Numeric money columns are projections of the journal record. Backfill once and keep
    // them in the same transaction as every journal edit, so fast sums cannot drift.
    this.db.transaction(() => {
      const columns = this.db.query('PRAGMA table_info(journal)').all() as { name: string }[];
      const missing = !columns.some(c => c.name === 'money_amount') || !columns.some(c => c.name === 'money_currency');
      if (!columns.some(c => c.name === 'money_amount')) this.db.exec('ALTER TABLE journal ADD COLUMN money_amount REAL');
      if (!columns.some(c => c.name === 'money_currency')) this.db.exec('ALTER TABLE journal ADD COLUMN money_currency TEXT');
      if (missing) this.db.exec(`UPDATE journal SET money_amount = CASE WHEN json_type(data, '$.amount') IN ('integer', 'real') THEN json_extract(data, '$.amount') ELSE 0 END,
        money_currency = lower(COALESCE(NULLIF(json_extract(data, '$.currency'), ''), 'usd'))`);
      this.db.exec('CREATE INDEX IF NOT EXISTS journal_money_totals ON journal(kind, at, money_currency, money_amount)');
    })();
    // One-time backfill for older databases. Normalize with JavaScript so Unicode searches
    // preserve the browser's toLowerCase semantics (SQLite's built-in lower is ASCII-only).
    for (const [table, column] of [['employees', 'search_name'], ['journal', 'search_text']]) {
      const columns = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some(c => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      const missing = this.db.query(`SELECT id, data FROM ${table} WHERE ${column} IS NULL`).all() as { id: string; data: string }[];
      if (missing.length) this.db.transaction(() => {
        const update = this.db.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
        for (const row of missing) {
          const data = JSON.parse(row.data);
          update.run((table === 'employees' ? data.name ?? '' : `${data.title ?? ''} ${data.notes ?? ''}`).toLowerCase(), row.id);
        }
      })();
    }
    // Failed migration may leave an empty database. Keep checking the preserved JSON until a
    // revision commits, so a subsequent start cannot silently replace a damaged save with blank state.
    if (!this.db.query("SELECT value FROM meta WHERE key = 'revision'").get()) this.migrate(directory);
  }
  /** The JSON save the studio used before SQLite becomes the first rows, and stays behind as a
   *  backup under a new name. A damaged JSON save is left untouched and stops the start, as before. */
  private migrate(directory: string) {
    const json = join(directory, 'studio.json');
    if (!existsSync(json)) return;
    const saved = JSON.parse(readFileSync(json, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.employees) || !Array.isArray(saved.projects) || !Array.isArray(saved.journal)
      || !saved.room || !saved.identities || !saved.observations) throw new Error('Studio save is invalid; preserve studio.json and restore a backup.');
    this.save(saved);
    renameSync(json, `${json}.migrated`);
  }
  load(): Saved | undefined {
    const meta = new Map((this.db.query('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
    if (!meta.has('revision')) return undefined;
    const rows = (table: string) => (this.db.query(`SELECT id, data FROM ${table}`).all() as { id: string; data: string }[]);
    const map = (table: string) => Object.fromEntries((this.db.query(`SELECT key, data FROM ${table}`).all() as { key: string; data: string }[]).map(r => [r.key, JSON.parse(r.data)]));
    const saved: Saved = {
      version: Number(meta.get('version') ?? 1), revision: Number(meta.get('revision')),
      employees: rows('employees').map(r => JSON.parse(r.data)), projects: rows('projects').map(r => JSON.parse(r.data)),
      journal: (this.db.query('SELECT data FROM journal ORDER BY at, rowid').all() as { data: string }[]).map(r => JSON.parse(r.data)),
      room: JSON.parse(meta.get('room') ?? '{"version":0,"items":null,"projectOrder":[]}'), imports: JSON.parse(meta.get('imports') ?? '[]'),
      identities: map('identities'), observations: map('observations'),
    };
    if (meta.has('revenueCatSubscribers')) saved.revenueCatSubscribers = JSON.parse(meta.get('revenueCatSubscribers')!);
    for (const key of ['actionReceipts', 'actionFloor'] as const) if (meta.has(key)) (saved as any)[key] = JSON.parse(meta.get(key)!);
    this.remember(saved);
    return saved;
  }
  /** Write what differs from the last save, in one transaction. */
  save(state: Saved) {
    const remove = Object.fromEntries([...ROWS, ...MAPS].map(t => [t, this.db.query(`DELETE FROM ${t} WHERE ${t === 'identities' || t === 'observations' ? 'key' : 'id'} = ?`)]));
    const putMap = Object.fromEntries(MAPS.map(t => [t, this.db.query(`INSERT INTO ${t} (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data`)]));
    const putMeta = this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.db.transaction(() => {
      for (const table of ROWS) {
        const seen = new Set<string>(), before = this.written.get(table) ?? new Map<string, string>();
        for (const row of state[table]) {
          const data = JSON.stringify(row); seen.add(row.id);
          if (before.get(row.id) === data) continue;
          this.writeRow(table, row, data);
        }
        for (const id of before.keys()) if (!seen.has(id)) remove[table].run(id);
      }
      for (const table of MAPS) {
        const seen = new Set<string>(), before = this.written.get(table) ?? new Map<string, string>();
        for (const [key, value] of Object.entries(state[table])) {
          const data = JSON.stringify(value); seen.add(key);
          if (before.get(key) !== data) putMap[table].run(key, data);
        }
        for (const key of before.keys()) if (!seen.has(key)) remove[table].run(key);
      }
      const meta = this.written.get('meta') ?? new Map<string, string>();
      for (const [key, value] of [['version', String(state.version)], ['revision', String(state.revision)], ['room', JSON.stringify(state.room)], ['imports', JSON.stringify(state.imports)], ['revenueCatSubscribers', JSON.stringify(state.revenueCatSubscribers ?? {})], ['actionReceipts', JSON.stringify(state.actionReceipts ?? {})], ['actionFloor', JSON.stringify(state.actionFloor ?? 0)]]) {
        if (meta.get(key) !== value) putMeta.run(key, value);
      }
    })();
    this.remember(state);
  }
  private writeRow(table: typeof ROWS[number], row: any, data: string) {
    if (table === 'journal') this.db.query(`INSERT INTO journal (id, data, at, kind, search_text, money_amount, money_currency) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, at = excluded.at, kind = excluded.kind, search_text = excluded.search_text, money_amount = excluded.money_amount, money_currency = excluded.money_currency`)
      .run(row.id, data, row.at, row.kind, `${row.title ?? ''} ${row.notes ?? ''}`.toLowerCase(), typeof row.amount === 'number' && Number.isFinite(row.amount) ? row.amount : 0, String(row.currency || 'usd').toLowerCase());
    else if (table === 'employees') this.db.query(`INSERT INTO employees (id, data, search_name) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, search_name = excluded.search_name`).run(row.id, data, (row.name ?? '').toLowerCase());
    else this.db.query('INSERT INTO projects (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(row.id, data);
  }
  /** Apply caller-tracked mutations directly; no row scan, JSON diff, or full-state cache. */
  patch(patch: SavedPatch) {
    this.db.transaction(() => {
      for (const table of ROWS) {
        const change = patch.rows[table]; if (!change) continue;
        const remove = this.db.query(`DELETE FROM ${table} WHERE id = ?`);
        for (const id of change.remove) remove.run(id);
        for (const row of change.upsert) {
          const data = JSON.stringify(row);
          this.writeRow(table, row, data);
        }
      }
      for (const table of MAPS) {
        const change = patch.maps[table]; if (!change) continue;
        const remove = this.db.query(`DELETE FROM ${table} WHERE key = ?`);
        const upsert = this.db.query(`INSERT INTO ${table} (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data`);
        for (const key of change.remove) remove.run(key);
        for (const [key, value] of Object.entries(change.upsert)) upsert.run(key, JSON.stringify(value));
      }
      const meta = this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [key, value] of Object.entries(patch.meta)) meta.run(key, JSON.stringify(value));
    })();
    // A caller can mix the compatibility full-save API and explicit patches on one connection.
    for (const table of ROWS) {
      const change = patch.rows[table]; if (!change) continue;
      let written = this.written.get(table); if (!written) this.written.set(table, written = new Map());
      for (const id of change.remove) written.delete(id);
      for (const row of change.upsert) written.set(row.id, JSON.stringify(row));
    }
    for (const table of MAPS) {
      const change = patch.maps[table]; if (!change) continue;
      let written = this.written.get(table); if (!written) this.written.set(table, written = new Map());
      for (const key of change.remove) written.delete(key);
      for (const [key, value] of Object.entries(change.upsert)) written.set(key, JSON.stringify(value));
    }
    let meta = this.written.get('meta'); if (!meta) this.written.set('meta', meta = new Map());
    for (const [key, value] of Object.entries(patch.meta)) meta.set(key, JSON.stringify(value));
  }
  /** Filtering and keyset ordering stay inside SQLite; only the requested page crosses into JS. */
  journalPage(query: JournalRead): { money?: RecapMoney; entries: JournalEntry[]; cursor: string | null; total: number } {
    const where = ['j.at > ?'], params: any[] = [query.since ?? 0];
    if (query.ids) {
      where.push(query.ids.length ? `j.id IN (${query.ids.map(() => '?').join(',')})` : '0');
      params.push(...query.ids);
    }
    if (query.project) { where.push("json_extract(j.data, '$.project') = ?"); params.push(query.project); }
    if (query.kind) { where.push('j.kind = ?'); params.push(query.kind); }
    if (query.read !== undefined) where.push(query.read ? "COALESCE(json_extract(j.data, '$.readAt'), 0) > 0" : "COALESCE(json_extract(j.data, '$.readAt'), 0) = 0");
    if (query.trophies) where.push("j.kind IN ('milestone', 'release')");
    if (query.search) {
      where.push(`instr(j.search_text || ' ' ||
        COALESCE((SELECT group_concat(COALESCE(e.search_name, ''), ' ') FROM json_each(j.data, '$.contributors') c LEFT JOIN employees e ON e.id = c.value), ''), ?) > 0`);
      params.push(query.search);
    }
    const filter = where.join(' AND ');
    return this.db.transaction(() => {
      const total = (this.db.query(`SELECT count(*) AS total FROM journal j WHERE ${filter}`).get(...params) as { total: number }).total;
      // Aggregate in SQLite: only one small row per currency crosses into JavaScript.
      // A covering money index avoids reading or decoding the journal text at all.
      let money: RecapMoney | undefined;
      if (query.moneySummary) {
        const amount = 'j.money_amount';
        const groups = this.db.query(`SELECT j.money_currency AS currency,
          SUM(${amount}) AS amount, SUM(CASE WHEN (${amount}) > 0 THEN 1 ELSE 0 END) AS payments,
          SUM(CASE WHEN (${amount}) < 0 THEN 1 ELSE 0 END) AS refunds, COUNT(*) AS billingEvents
          FROM journal j WHERE ${filter} AND j.kind = 'sale' GROUP BY currency ORDER BY currency`).all(...params) as {currency: string; amount: number; payments: number; refunds: number; billingEvents: number}[];
        money = { totals: groups.filter(g => g.payments + g.refunds > 0).map(g => ({currency: g.currency, amount: g.amount})),
          payments: groups.reduce((n,g) => n + g.payments, 0), refunds: groups.reduce((n,g) => n + g.refunds, 0),
          billingEvents: groups.reduce((n,g) => n + g.billingEvents, 0) };
      }
      const pageWhere = [...where], pageParams = [...params];
      if (query.before) { pageWhere.push('(j.at < ? OR (j.at = ? AND j.id < ?))'); pageParams.push(query.before[0], query.before[0], query.before[1]); }
      const found = this.db.query(`SELECT j.data FROM journal j WHERE ${pageWhere.join(' AND ')} ORDER BY j.at DESC, j.id DESC LIMIT ?`).all(...pageParams, query.limit + 1) as { data: string }[];
      const entries = found.slice(0, query.limit).map(row => JSON.parse(row.data) as JournalEntry), last = entries.at(-1);
      return { ...(money ? {money} : {}), entries: entries.reverse(), cursor: found.length > query.limit && last ? JSON.stringify([last.at, last.id]) : null, total };
    })();
  }
  private remember(state: Saved) {
    for (const table of ROWS) this.written.set(table, new Map(state[table].map(row => [row.id, JSON.stringify(row)])));
    for (const table of MAPS) this.written.set(table, new Map(Object.entries(state[table]).map(([k, v]) => [k, JSON.stringify(v)])));
    this.written.set('meta', new Map([['version', String(state.version)], ['revision', String(state.revision)], ['room', JSON.stringify(state.room)], ['imports', JSON.stringify(state.imports)], ['revenueCatSubscribers', JSON.stringify(state.revenueCatSubscribers ?? {})], ['actionReceipts', JSON.stringify(state.actionReceipts ?? {})], ['actionFloor', JSON.stringify(state.actionFloor ?? 0)]]));
  }
  close() { this.db.close(); }
}
