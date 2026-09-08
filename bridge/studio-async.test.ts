import { test, expect } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from './studio';
import type { AgentInfo } from '../shared/types';

const agent = { pane_id: 'w1:p1', agent: 'codex', agent_status: 'working', cwd: '/projects/studio', title: 'Debug release' } as AgentInfo;
test('async studio saves serialize observations and expose only committed snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-async-'));
  try {
    const store = new StudioStore(directory, { asyncWrite: true });
    expect(store.needsObservation([agent])).toBe(true);
    let publishedInside = -1;
    const first = store.run(() => {
      const result = store.observe([agent], 1000);
      queueMicrotask(() => { publishedInside = store.snapshot().revision; });
      return result;
    });
    const second = store.run(() => store.observe([{ ...agent, agent_status: 'done' }], 121000));
    await Promise.all([first, second]);
    expect(publishedInside).toBe(0);
    expect(store.snapshot().employees[0].shipped).toBe(1);
    expect(store.snapshot().journal).toHaveLength(1);
    expect(store.needsObservation([{ ...agent, agent_status: 'done' }])).toBe(false);
    expect(new StudioStore(directory).snapshot()).toEqual(store.snapshot());
    expect((await stat(join(directory, 'studio.sqlite'))).mode & 0o777).toBe(0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('failed async save rolls back and later operations can still commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-rollback-'));
  try {
    const store = new StudioStore(directory, { asyncWrite: true });
    // A database constraint is visible to both the reader and the background writer connection.
    const db = (store as any).storage.db;
    db.exec("CREATE TRIGGER reject_employee BEFORE INSERT ON employees BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    await expect(store.run(() => store.observe([agent]))).rejects.toThrow();
    expect(store.snapshot().employees).toHaveLength(0);
    db.exec('DROP TRIGGER reject_employee');
    await store.run(() => store.observe([agent]));
    expect(new StudioStore(directory).snapshot().employees).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
