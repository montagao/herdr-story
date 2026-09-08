import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage, type Saved } from './storage';
import { AsyncStorage } from './async-storage';

const state = (revision: number, ids = ['veteran']): Saved => ({ version: 1, revision,
  employees: ids.map(id => ({ id })), projects: [], journal: [], room: { version: 0, items: null, projectOrder: [] },
  imports: [], identities: Object.fromEntries(ids.map(id => [id, id])), observations: {} });

test('worker commits in order and seeds prior rows before applying deletions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-storage-worker-'));
  const initial = new Storage(directory); initial.save(state(1, ['veteran', 'retired'])); initial.close();
  const worker = new AsyncStorage(directory);
  try {
    const committed: number[] = [];
    await Promise.all([worker.save(state(2)).then(() => committed.push(2)), worker.save(state(3, ['newcomer'])).then(() => committed.push(3))]);
    expect(committed).toEqual([2, 3]);
    const reader = new Storage(directory);
    try { expect(reader.load()).toMatchObject({ revision: 3, employees: [{ id: 'newcomer' }], identities: { newcomer: 'newcomer' } }); }
    finally { reader.close(); }
    await worker.close();
    await expect(worker.save(state(4))).rejects.toThrow('closing');
  } finally { await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('rejected SQLite commit has no acknowledgement and a later commit recovers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-storage-lock-'));
  const worker = new AsyncStorage(directory);
  let lock: Database | undefined;
  try {
    await worker.save(state(1));
    lock = new Database(join(directory, 'studio.sqlite'));
    lock.exec("CREATE TRIGGER reject_write BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'test commit rejected'); END;");
    let acknowledged = false;
    const failed = worker.save(state(2)).then(() => { acknowledged = true; });
    // Bun 1.3's rejects matcher can stall chained worker promises; await normally first.
    let rejection: unknown;
    try { await failed; } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    expect(acknowledged).toBe(false);
    lock.exec('DROP TRIGGER reject_write'); lock.close(); lock = undefined;
    const reader = new Storage(directory);
    try { expect(reader.load()?.revision).toBe(1); } finally { reader.close(); }
    await worker.save(state(3));
    const restored = new Storage(directory);
    try { expect(restored.load()?.revision).toBe(3); } finally { restored.close(); }
  } finally { if (lock) { lock.exec('DROP TRIGGER IF EXISTS reject_write'); lock.close(); } await worker.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

test('startup errors reject promptly and close without leaving a live worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-storage-startup-'));
  const worker = new AsyncStorage(join(directory, 'missing', 'directory'));
  try { await expect(worker.save(state(1))).rejects.toThrow(); }
  finally { await worker.close(); rmSync(directory, { recursive: true, force: true }); }
});
