import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { Storage, type Saved, type SavedPatch } from './storage';
import { StudioStore } from './studio';
import { emptyCareer, type JournalEntry, type JournalPageQuery } from '../shared/studio';
import type { AgentInfo } from '../shared/types';

const entry = (n: number): JournalEntry => ({ id: `memory-${String(n).padStart(6, '0')}`, version: 0, at: 1_000 + Math.floor(n / 3),
  kind: n % 20 === 0 ? 'release' : 'task', title: `Memory ${n}`, notes: n === 3 ? 'A distant ÉCLAIR %_ artifact' : 'History '.repeat(50),
  project: n % 2 ? '/projects/one' : '/projects/two', contributors: ['veteran'], url: '', source: 'manual' });
function saved(count = 245): Saved {
  return { version: 1, revision: 1, employees: [{ id: 'veteran', version: 0, name: 'Élodie', bio: '', kind: 'codex',
    body: 0, face: 0, favorite: false, createdAt: 1, shipped: 0, stats: emptyCareer() } as any],
    projects: [], journal: Array.from({ length: count }, (_, n) => entry(n)), room: { version: 0, items: null, projectOrder: [] },
    imports: [], identities: {}, observations: {} };
}
function fixture(count = 245) {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-delta-test-')), state = saved(count);
  const disk = new Storage(directory); disk.save(state); disk.close();
  const store = new StudioStore(directory, { asyncWrite: true });
  return { directory, store, state, cleanup: async () => { await store.close(); rmSync(directory, { force: true, recursive: true }); } };
}
const edit = (item: JournalEntry, notes = 'Changed one row') => ({ ...item, op: 'entry.save', project: '', notes });

test('one change among 5000 memories transfers one record and never clones unchanged history', async () => {
  const { store, cleanup } = fixture(5000);
  try {
    const internal = store as any, writer = internal.writer, commit = writer.patch.bind(writer);
    const payloads: SavedPatch[] = [];
    writer.patch = (patch: SavedPatch) => { payloads.push(structuredClone(patch)); return commit(patch); };
    const unchanged = internal.state.journal[4999];
    // A getter witnesses traversal by structuredClone/JSON serialization; ordinary id lookup
    // and page queries do not touch its body. A rollback snapshot used to visit all 5000 notes.
    let visits = 0;
    Object.defineProperty(unchanged, 'notes', { configurable: true, enumerable: true, get: () => { visits++; return 'Unchanged'; } });
    await store.run(() => store.change(edit(entry(3)), [], { snapshot: false }));
    expect(visits).toBe(0);
    expect(internal.state.journal[4999]).toBe(unchanged);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].rows.journal?.upsert.map(row => row.id)).toEqual([entry(3).id]);
    expect(payloads[0].rows.journal?.remove).toEqual([]);
    expect(JSON.stringify(payloads[0]).length).toBeLessThan(1000);
    expect(store.journalPage({ ids: [entry(3).id] }).entries[0].notes).toBe('Changed one row');
  } finally { await cleanup(); }
});

test('failed nested edits restore rows, identities, arrays, and compact history metadata', async () => {
  const { store, cleanup } = fixture();
  try {
    const agent = { pane_id: 'w1:p1', agent: 'codex', agent_status: 'working', cwd: '/projects/studio', title: 'Debug release' } as AgentInfo;
    await store.run(() => store.observe([agent], 1000));
    const before = store.snapshot(), compact = store.snapshot(100), db = (store as any).storage.db;
    db.exec("CREATE TRIGGER reject_edit BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'reject transaction'); END");
    const attempt = store.run(() => {
      store.observe([{ ...agent, agent_status: 'done', agent_session: { kind: 'id', value: 'now-identified' } }], 91000);
      store.change({ op: 'employee.save', ...before.employees[0], name: 'Rejected rename' }, [], { snapshot: false });
      store.change({ op: 'entry.remove', id: entry(3).id, version: 0 }, [], { snapshot: false });
      store.change({ op: 'room.save', version: 0, items: [], projectOrder: [] }, [], { snapshot: false });
    });
    let failure: unknown; try { await attempt; } catch (error) { failure = error; }
    expect((failure as Error)?.message).toContain('reject transaction');
    expect(store.snapshot()).toEqual(before);
    expect(store.snapshot(100)).toEqual(compact);
    expect(store.journalPage({ ids: [entry(3).id] }).entries).toHaveLength(1);
    db.exec('DROP TRIGGER reject_edit');
    await store.run(() => store.observe([{ ...agent, agent_status: 'done', agent_session: { kind: 'id', value: 'now-identified' } }], 92000));
    expect(store.snapshot().employees).toHaveLength(2);
    expect(store.snapshot().employees[1].shipped).toBe(1);
    expect(store.snapshot().journal).toHaveLength(before.journal.length + 1);
    const reopened = new StudioStore((store as any).storage.path.replace(/\/studio.sqlite$/, ''));
    try { expect(reopened.snapshot()).toEqual(store.snapshot()); } finally { await reopened.close(); }
  } finally { await cleanup(); }
});

test('SQL pages match memory filters, Unicode names and literal search with tied timestamps', async () => {
  const { store, state, cleanup } = fixture();
  const memory = new StudioStore(); (memory as any).state = structuredClone(state);
  try {
    for (const query of [{}, { trophies: true }, { search: 'ÉLODIE' }, { search: 'éclair %_' }, { search: '3 a distant' },
      { search: 'missing' }, { project: '/projects/one' }, { kind: 'release' }, { since: 1080 }, { ids: [] }, { ids: [entry(3).id, entry(30).id] }] as JournalPageQuery[]) {
      let cursor: string | null | undefined;
      do {
        const actual = store.journalPage({ ...query, cursor, limit: 37 }), expected = memory.journalPage({ ...query, cursor, limit: 37 });
        expect({ ...actual, epoch: '' }).toEqual({ ...expected, epoch: '' });
        cursor = actual.cursor;
      } while (cursor);
    }
    // Reading a durable page must not walk the in-memory history at all.
    (store as any).state.journal.filter = () => { throw new Error('unexpected memory scan'); };
    expect(store.journalPage({ search: 'éclair' }).entries.map(row => row.id)).toEqual([entry(3).id]);
    delete (store as any).state.journal.filter;
    await store.run(() => store.change({ op: 'employee.save', ...(state.employees[0] as any), name: 'İpek' }, [], { snapshot: false }));
    expect(store.journalPage({ search: 'Élodie' }).total).toBe(0);
    expect(store.journalPage({ search: 'İPEK' }).total).toBe(245);
  } finally { await memory.close(); await cleanup(); }
});

test('SQL keyset pages survive deletion and arrival; committed metadata updates incrementally', async () => {
  const { store, cleanup } = fixture();
  try {
    const first = store.snapshot(100), cursorEntry = first.journal[0];
    await store.run(() => store.change({ op: 'entry.remove', id: cursorEntry.id, version: 0 }, [], { snapshot: false }));
    await store.run(() => store.change({ op: 'entry.save', title: 'Just arrived', notes: '', project: '', contributors: [], kind: 'release', url: '' }, [], { snapshot: false }));
    await store.run(() => store.change(edit(entry(3), 'Changed old history'), [], { snapshot: false }));
    const second = store.journalPage({ cursor: first.journalCursor, limit: 100 }), third = store.journalPage({ cursor: second.cursor, limit: 100 });
    expect(second.entries).toHaveLength(100); expect(third.entries).toHaveLength(45);
    expect(new Set([...first.journal, ...second.entries, ...third.entries].map(row => row.id)).size).toBe(245);
    const compact = store.snapshot(100);
    expect(compact.journalRetired).toContain(cursorEntry.id);
    expect(compact.journalInvalidated?.[entry(3).id]).toBe(4);
    expect(compact.journalSummary?.trophies).toBe(14);
    expect(compact.journalSummary?.tasksByProject['/projects/one']).toBe(120);
    expect(compact.journalSummary?.tasksByProject['']).toBeUndefined();
    const epoch = compact.journalEpoch;
    (store as any).journalRetired = new Set(Array.from({ length: 501 }, (_, n) => `gone-${n}`));
    await store.run(() => store.change(edit({ ...entry(3), version: 1 }), [], { snapshot: false }));
    expect(store.snapshot(100).journalEpoch).not.toBe(epoch);
  } finally { await cleanup(); }
});

test('existing SQLite saves backfill normalized text without losing history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-search-migration-'));
  let storage: Storage | undefined;
  try {
    const db = new Database(join(directory, 'studio.sqlite'));
    db.exec('CREATE TABLE employees (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE journal (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)');
    db.query('INSERT INTO employees VALUES (?, ?)').run('veteran', JSON.stringify({ id: 'veteran', name: 'Élodie' }));
    db.query('INSERT INTO journal VALUES (?, ?, ?, ?)').run(entry(3).id, entry(3).at, entry(3).kind, JSON.stringify(entry(3))); db.close();
    storage = new Storage(directory);
    expect(storage.journalPage({ limit: 100, search: 'élodie' }).entries.map(row => row.id)).toEqual([entry(3).id]);
    expect(storage.journalPage({ limit: 100, search: 'éclair %_' }).total).toBe(1);
  } finally { storage?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('async milestone edits, reordering, reopening, deletion and room/import changes survive reload', async () => {
  const { store, directory, cleanup } = fixture(0);
  try {
    const agent = { pane_id: 'w1:p1', agent: 'codex', agent_status: 'working', cwd: '/projects/studio', title: 'Debug release' } as AgentInfo;
    await store.run(() => store.observe([agent], 1000));
    const change = (params: Record<string, unknown>) => store.run(() => store.change(params, [agent], { snapshot: false }));
    const project = store.snapshot().projects[0];
    const goal = { op: 'goal.save', project: project.id, title: 'Ship alpha', notes: 'Useful', done: true, checklist: [], contributors: ['veteran'], due: '', url: '' };
    await change(goal); await change({ ...goal, title: 'Ship beta' });
    let goals = store.snapshot().projects[0].goals;
    await change({ op: 'goal.move', project: project.id, id: goals[1].id, version: 2, direction: 'up' });
    goals = store.snapshot().projects[0].goals;
    expect(goals.map(g => g.title)).toEqual(['Ship beta', 'Ship alpha']);
    await change({ ...goals[1], op: 'goal.save', project: project.id, done: false });
    await change({ op: 'goal.remove', project: project.id, id: goals[0].id, version: goals[0].version });
    expect(store.snapshot().journal).toHaveLength(0);
    await change({ op: 'room.save', version: 0, items: [], projectOrder: [project.id] });
    await change({ op: 'legacy.import', rows: [{ pane: agent.pane_id, shipped: 12, stats: { debug: 12 } }] });
    await store.run(() => store.observeRevenueCat('app', 10, 1000));
    await store.run(() => store.observeRevenueCat('app', 12, 2000));
    const reopened = new StudioStore(directory);
    try { expect(reopened.snapshot()).toEqual(store.snapshot()); } finally { await reopened.close(); }
  } finally { await cleanup(); }
});

test('journal queries keep the committed revision while a durable worker acknowledgement is pending', async () => {
  const { store, cleanup } = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const writer = (store as any).writer, commit = writer.patch.bind(writer);
    let persisted!: () => void;
    const ready = new Promise<void>(resolve => { persisted = resolve; });
    writer.patch = async (patch: SavedPatch) => { await commit(patch); persisted(); await held; };
    const pending = store.run(() => store.change(edit(entry(3)), [], { snapshot: false }));
    await ready;
    // The database already has revision 2, but clients have only been promised revision 1.
    expect(store.journalPage({ ids: [entry(3).id] })).toMatchObject({ revision: 1, entries: [{ notes: entry(3).notes }] });
    expect(store.snapshot(100).revision).toBe(1);
    release(); await pending;
    expect(store.journalPage({ ids: [entry(3).id] })).toMatchObject({ revision: 2, entries: [{ notes: 'Changed one row' }] });
  } finally { release(); await cleanup(); }
});

test('re-saving an existing memory leaves no draft proxy in the committed row', async () => {
  const { store, cleanup } = fixture(20);
  try {
    const internal = store as any, writer = internal.writer, commit = writer.patch.bind(writer);
    const payloads: SavedPatch[] = [];
    writer.patch = (patch: SavedPatch) => { payloads.push(patch); return commit(patch); };
    // The entry editor sends the row's own id and version; for an agent's memory the store
    // rebuilds the row from the draft's copy of it, contributors included, and splices it in.
    internal.state.journal.find((e: JournalEntry) => e.id === 'memory-000003').source = 'agent';
    await store.run(() => store.change({ op: 'entry.save', id: 'memory-000003', version: 0, title: 'Renamed', notes: 'Corrected', project: '' }, [], { snapshot: false }));
    const row = internal.state.journal.find((e: JournalEntry) => e.id === 'memory-000003');
    expect(row).toMatchObject({ version: 1, title: 'Renamed', notes: 'Corrected', contributors: ['veteran'] });
    expect(() => structuredClone(row)).not.toThrow();
    expect(payloads.at(-1)?.rows.journal?.upsert.map(e => e.id)).toEqual(['memory-000003']);
  } finally { await cleanup(); }
});
