import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudioStore } from './studio';
import type { AgentInfo } from '../shared/types';
import type { RoomItem } from '../shared/studio';
import type { MoneyEvent } from '../shared/types';

const directories: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'herdr-studio-test-')); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const agent = (overrides: Partial<AgentInfo> = {}): AgentInfo => ({ pane_id: 'w1:p1', workspace_id: 'w1', name: 'Ada', agent: 'codex',
  agent_status: 'working', title: 'Fix crash on startup', cwd: '/projects/game', agent_session: { kind: 'id', value: 'session-one' }, ...overrides });

test('RevenueCat net changes persist across restarts without inventing sales or replaying polls', () => {
  const dir = directory(), store = new StudioStore(dir);
  expect(store.observeRevenueCat('app', 10, 1000)).toBeNull();
  expect(store.snapshot().journal).toHaveLength(0);
  expect(store.observeRevenueCat('app', undefined, 1500)).toBeNull();
  expect(store.observeRevenueCat('app', Infinity, 1500)).toBeNull();
  expect(store.observeRevenueCat('app', -1, 1500)).toBeNull();
  expect(store.observeRevenueCat('app', 12, 2000)?.kind).toBe('subscribed');
  const restored = new StudioStore(dir);
  expect(restored.observeRevenueCat('app', 12, 3000)).toBeNull();
  expect(restored.observeRevenueCat('other-app', 100, 3000)).toBeNull();
  expect(restored.observeRevenueCat('app', 11, 4000)?.kind).toBe('churned');
  const entries = restored.snapshot().journal;
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ source: 'revenuecat', kind: 'note', at: 2000 });
  expect(entries[0].title).toContain('+2 net');
  expect(entries[1].title).toContain('-1 net');
  expect(entries.every(e => e.amount === undefined)).toBe(true);
});
function setup(store = new StudioStore()) {
  const a = agent(); store.observe([a], 1000);
  return { store, a, employee: store.snapshot().employees[0], project: store.snapshot().projects[0] };
}

describe('durable studio', () => {
  test('a saved career follows a session into a new pane and a new browser', () => {
    const dir = directory(), { store, a, employee } = setup(new StudioStore(dir));
    store.change({ op: 'employee.save', id: employee.id, version: 0, name: 'Ada the debugger', bio: 'Here since v1', face: 17, body: 12, favorite: true }, [a]);
    store.observe([{ ...a, agent_status: 'done' }], 90_000);
    const restored = new StudioStore(dir), moved = { ...a, pane_id: 'w9:p4', agent_status: 'idle' as const };
    restored.observe([moved], 95_000);
    expect(restored.decorate(moved)).toMatchObject({ employee_id: employee.id, office_name: 'Ada the debugger', office_look: { face: 17, body: 12 }, favorite: true });
    expect(restored.snapshot().employees).toHaveLength(1);
    expect(restored.snapshot().employees[0].stats.debug).toBe(1);
    expect(statSync(join(dir, 'studio.sqlite')).mode & 0o777).toBe(0o600);
  });
  test('a different session reusing a pane gets its own career; explicit reassignment keeps both', () => {
    const { store, a, employee } = setup();
    store.observe([{ ...a, agent_status: 'done' }], 9000);
    const other = agent({ agent_session: { kind: 'id', value: 'session-two' } });
    store.observe([other], 10_000);
    expect(store.decorate(other).employee_id).not.toBe(employee.id);
    expect(store.snapshot().employees[1].shipped).toBe(0);
    store.change({ op: 'employee.bind', id: employee.id, pane: other.pane_id }, [other]);
    expect(store.decorate(other).employee_id).toBe(employee.id);
    expect(store.snapshot().employees).toHaveLength(2);
  });
  test('late session metadata keeps the provisional employee and their ongoing work', () => {
    const store = new StudioStore(), provisional = agent({ agent_session: null });
    store.observe([provisional], 1000);
    const employee = store.snapshot().employees[0];
    store.change({ op: 'employee.save', id: employee.id, version: 0, name: 'My employee', bio: '', face: 4, body: 5, favorite: true }, [provisional]);
    store.observe([agent()], 2000);
    store.observe([agent({ agent_status: 'done' })], 9000);
    expect(store.snapshot().employees).toHaveLength(1);
    expect(store.snapshot().employees[0]).toMatchObject({ id: employee.id, name: 'My employee', shipped: 1 });
    store.observe([agent({ agent_session: { kind: 'id', value: 'replacement' } })], 10_000);
    expect(store.snapshot().employees).toHaveLength(2);
  });
  test('work completed while the UI is absent is counted once across blocked, done, idle, and restart', () => {
    const dir = directory(), { store, a } = setup(new StudioStore(dir));
    store.observe([{ ...a, agent_status: 'blocked' }], 5000);
    store.observe([a], 10_000);
    const restored = new StudioStore(dir);
    expect(restored.observe([{ ...a, agent_status: 'done' }], 90_000).completions.size).toBe(1);
    restored.observe([{ ...a, agent_status: 'done' }], 91_000);
    restored.observe([{ ...a, agent_status: 'idle' }], 92_000);
    expect(new StudioStore(dir).snapshot().journal).toHaveLength(1);
    expect(restored.snapshot().employees[0].shipped).toBe(1);
    restored.observe([a], 100_000);
    restored.observe([{ ...a, agent_status: 'idle' }], 101_000);
    expect(restored.snapshot().journal).toHaveLength(1);
    restored.observe([a], 110_000);
    restored.observe([{ ...a, agent_status: 'idle' }], 180_000);
    expect(restored.snapshot().employees[0].shipped).toBe(2);
  });
  test('a completed snapshot on first encounter does not invent an accomplishment', () => {
    const store = new StudioStore(); store.observe([agent({ agent_status: 'done' })]);
    expect(store.snapshot().journal).toHaveLength(0);
  });
  test('custom milestones, contributors, and real artifacts survive reload and reopening removes the trophy', () => {
    const dir = directory(), { store, a, employee, project } = setup(new StudioStore(dir));
    store.change({ op: 'project.save', id: project.id, version: 0, name: 'Moonshot team', notes: 'Ship something small.', color: '#39815b' }, [a]);
    store.change({ op: 'goal.save', project: project.id, title: 'Public beta', notes: 'Useful on day one', done: false,
      contributors: [employee.id], checklist: [{ id: 'build', text: 'Build it', done: true }], due: '2026-10-01', url: 'https://example.com/releases/1' }, [a]);
    let goal = store.snapshot().projects[0].goals[0];
    store.change({ ...goal, op: 'goal.save', project: project.id, done: true }, [a]);
    goal = store.snapshot().projects[0].goals[0];
    store.change({ ...goal, op: 'goal.save', project: project.id, notes: 'Shipped!' }, [a]);
    const restored = new StudioStore(dir);
    expect(restored.snapshot().projects[0]).toMatchObject({ name: 'Moonshot team', color: '#39815b' });
    expect(restored.snapshot().journal).toHaveLength(1);
    expect(restored.snapshot().journal[0]).toMatchObject({ kind: 'milestone', contributors: [employee.id], url: 'https://example.com/releases/1', notes: 'Shipped!' });
    goal = restored.snapshot().projects[0].goals[0];
    restored.change({ ...goal, op: 'goal.save', project: project.id, done: false }, [a]);
    expect(restored.snapshot().journal).toHaveLength(0);
  });
  test('conflicting edits and invalid links fail atomically without losing the previous save', () => {
    const { store, a, employee, project } = setup();
    store.change({ op: 'project.save', id: project.id, version: 0, name: 'New name', notes: '', color: '#39815b' }, [a]);
    expect(() => store.change({ op: 'project.save', id: project.id, version: 0, name: 'Stale name', notes: '', color: '#39815b' }, [a])).toThrow('another window');
    const before = store.snapshot();
    expect(() => store.change({ op: 'entry.save', title: 'Unsafe artifact', notes: '', contributors: [employee.id], url: 'javascript:alert(1)' }, [a])).toThrow('http');
    expect(store.snapshot()).toEqual(before);
  });
  test('removing a misclassified completion corrects its career point and never replays it', () => {
    const { store, a } = setup(); store.observe([{ ...a, agent_status: 'done' }], 9000);
    const entry = store.snapshot().journal[0];
    store.change({ op: 'entry.remove', id: entry.id, version: entry.version }, [a]);
    store.observe([{ ...a, agent_status: 'idle' }], 10_000);
    expect(store.snapshot().employees[0].shipped).toBe(0);
    expect(store.snapshot().employees[0].stats.debug).toBe(0);
    expect(store.snapshot().journal).toHaveLength(0);
  });
  test('projects with the same folder name keep separate boards and room layouts persist', () => {
    const dir = directory(), { store, a, project } = setup(new StudioStore(dir));
    const other = agent({ cwd: '/other/game', pane_id: 'w2:p1', agent_session: { kind: 'id', value: 'session-two' } }); store.observe([a, other], 2000);
    expect(store.snapshot().projects).toHaveLength(2);
    const ids = store.snapshot().projects.map(p => p.id).reverse();
    const items: RoomItem[] = [{ id: 'board', kind: 'whiteboard', project: project.id, x: 64, y: 88 }];
    store.change({ op: 'room.save', version: 0, items, projectOrder: ids }, [a, other]);
    expect(new StudioStore(dir).snapshot().room).toEqual({ version: 1, items, projectOrder: ids });
    expect(() => store.change({ op: 'room.save', version: 0, items: [], projectOrder: [] }, [a])).toThrow('another window');
  });
  test('old browser stats import once per career across multiple tabs', () => {
    const { store, a } = setup();
    const params = { op: 'legacy.import', rows: [{ pane: a.pane_id, shipped: 12, stats: { debug: 12 } }] };
    store.change(params, [a]); store.change(params, [a]);
    store.observe([{ ...a, agent_status: 'done' }], 9000);
    store.change(params, [a]);
    expect(store.snapshot().employees[0]).toMatchObject({ shipped: 13, stats: { debug: 13 } });
  });
  test('a damaged JSON save is preserved instead of silently resetting the studio', () => {
    const dir = directory(), file = join(dir, 'studio.json'); writeFileSync(file, '{broken');
    expect(() => new StudioStore(dir)).toThrow(); expect(readFileSync(file, 'utf8')).toBe('{broken');
  });
  test('an older JSON save is migrated into SQLite once and kept as a backup', () => {
    const dir = directory();
    const first = new StudioStore(dir); first.observe([agent()], 1000); first.observe([agent({ agent_status: 'done' })], 90_000);
    const legacy = { ...JSON.parse(JSON.stringify((first as any).state)), revision: 7 };
    rmSync(join(dir, 'studio.sqlite')); rmSync(join(dir, 'studio.sqlite-wal'), { force: true }); rmSync(join(dir, 'studio.sqlite-shm'), { force: true });
    writeFileSync(join(dir, 'studio.json'), JSON.stringify(legacy));
    const migrated = new StudioStore(dir);
    expect(migrated.snapshot().revision).toBe(7);
    expect(migrated.snapshot().employees[0].shipped).toBe(1);
    expect(readFileSync(join(dir, 'studio.json.migrated'), 'utf8')).toBe(JSON.stringify(legacy));
    expect(statSync(join(dir, 'studio.sqlite')).mode & 0o777).toBe(0o600);
    // rows, not a blob: a later change touches one journal row
    migrated.observe([agent({ pane_id: 'w2:p1', agent_session: { kind: 'id', value: 'other' } })], 100_000);
    expect(new StudioStore(dir).snapshot().revision).toBe(migrated.snapshot().revision);
  });
});

describe('sales in the journal', () => {
  const sale = (overrides: Partial<MoneyEvent> = {}): MoneyEvent => ({ id: 'evt_1', ts: 5_000, kind: 'sale', amount: 44, currency: 'usd', label: 'Pro plan', ...overrides });
  test('money that moved is journaled once, dated when it moved; attempts are not', () => {
    const dir = directory(), store = new StudioStore(dir);
    expect(store.recordSale(sale())).toBe(true);
    expect(store.recordSale(sale())).toBe(false);
    expect(store.recordSale(sale({ id: 'evt_2', kind: 'failed' }))).toBe(false);
    expect(store.recordSale(sale({ id: 'evt_3', kind: 'refund', amount: -44, label: '' }))).toBe(true);
    const [first, refund] = store.snapshot().journal;
    expect(first).toMatchObject({ kind: 'sale', title: 'Payment · Pro plan', at: 5_000, amount: 44, currency: 'usd', moneyId: 'evt_1', source: 'stripe' });
    expect(refund.title).toBe('Refund');
    expect(new StudioStore(dir).recordSale(sale())).toBe(false);
  });
  test('editing a sale keeps its amount and kind', () => {
    const store = new StudioStore(directory());
    store.recordSale(sale());
    const entry = store.snapshot().journal[0];
    const edited = store.change({ op: 'entry.save', id: entry.id, version: entry.version, title: 'First real customer', notes: 'They found us on the forum.', project: '', kind: 'note', url: '', contributors: [] }, []).journal[0];
    expect(edited).toMatchObject({ kind: 'sale', title: 'First real customer', amount: 44, moneyId: 'evt_1' });
  });
});

describe('cancellations in the journal', () => {
  const left = (overrides: Partial<MoneyEvent> = {}): MoneyEvent => ({ id: 'evt_c1', ts: 9_000, kind: 'churned', amount: 0, currency: 'usd', label: 'subscription ended',
    detail: { reason: 'Customer cancelled', feedback: 'Too expensive', comment: 'Only needed it for one project.', plan: 'Pro monthly', ends: Date.UTC(2026, 8, 30), url: 'https://dashboard.stripe.com/subscriptions/sub_1' }, ...overrides });
  test('a cancellation with a reason is a memory with the reason as its title and the words as its notes', () => {
    const dir = directory(), store = new StudioStore(dir);
    expect(store.recordSale(left())).toBe(true);
    expect(store.recordSale(left())).toBe(false);
    const entry = store.snapshot().journal.find(e => e.moneyId === 'evt_c1')!;
    expect(entry).toMatchObject({ kind: 'sale', title: 'Cancelled · Customer cancelled · Too expensive', url: 'https://dashboard.stripe.com/subscriptions/sub_1', source: 'stripe', at: 9_000 });
    expect(entry.notes).toBe('“Only needed it for one project.”\nPlan: Pro monthly\nEnds: 2026-09-30');
    expect(entry.amount).toBeUndefined();
  });
  test('a cancellation that said nothing stays in the sales strip only', () => {
    const dir = directory(), store = new StudioStore(dir);
    expect(store.recordSale(left({ id: 'evt_c2', detail: { url: 'https://dashboard.stripe.com/subscriptions/sub_2' } }))).toBe(false);
    expect(store.recordSale(left({ id: 'evt_c3', detail: undefined }))).toBe(false);
  });
});

test('verified short completion arrives after idle, saves once, and clears on next task', () => {
  const dir = directory(), {store, a} = setup(new StudioStore(dir));
  const idle = {...a, agent_status: 'idle' as const};
  store.observe([idle], 5000);
  expect(store.decorate(idle).completed_task).toBeNull();
  const verified = {...idle, last_turn_completed_at: 4900};
  expect(store.needsObservation([verified])).toBe(true);
  expect(store.observe([verified], 6000).completions.size).toBe(1);
  const entry = store.decorate(idle).completed_task!;
  expect(entry.entry_id).toBe(store.snapshot().journal[0].id);
  const restored = new StudioStore(dir);
  expect(restored.observe([verified], 7000).completions.size).toBe(0);
  expect(restored.decorate(idle).completed_task?.entry_id).toBe(entry.entry_id);
  restored.observe([a], 10000);
  expect(restored.decorate(a).completed_task).toBeNull();
  restored.observe([verified], 11000); // old turn evidence cannot finish the new task
  expect(restored.snapshot().journal).toHaveLength(1);
  expect(restored.decorate(idle).completed_task).toBeNull();
});
