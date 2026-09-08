import { expect, test } from 'bun:test';
import { CodexQueueReader, localCodexQueue } from './codex-queue';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
const row = (id: string) => ({ id, clientUserMessageId: id, input: [{ type: 'text', text: id }] });

test('native queue reads include every page and coalesce across tabs', async () => {
  const calls: any[] = [];
  const reader = new CodexQueueReader(async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [row('second')], nextCursor: null } : { data: [row('first')], nextCursor: 'page-2' };
  });
  const [a, b] = await Promise.all([reader.read('thread'), reader.read('thread')]);
  expect(a).toEqual(b); expect(a.map(item => item.id)).toEqual(['first', 'second']); expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({ method: 'thread/queue/list', params: { threadId: 'thread', limit: 100 } });
  await reader.read('thread'); expect(calls).toHaveLength(2);
});
test('failed and partial native queue reads never become an empty queue', async () => {
  for (const result of [{}, { data: [], nextCursor: 'repeat' }]) {
    await expect(new CodexQueueReader(async () => result).read('thread')).rejects.toThrow();
  }
  let failed = true;
  const reader = new CodexQueueReader(async () => { if (failed) throw Error('Disconnected'); return { data: [], nextCursor: null }; });
  await expect(reader.read('thread')).rejects.toThrow('Disconnected');
  failed = false; expect(await reader.read('thread')).toEqual([]);
});
test('a queue write invalidates an older in-flight list and its cache', async () => {
  let resolve!: (value: any) => void, calls = 0;
  const reader = new CodexQueueReader(async () => ++calls === 1 ? new Promise(r => resolve = r) : { data: [row('new')], nextCursor: null });
  const old = reader.read('thread'); reader.invalidate('thread');
  expect((await reader.read('thread'))[0].id).toBe('new');
  resolve({ data: [], nextCursor: null }); await old;
  expect((await reader.read('thread'))[0].id).toBe('new');
});

test('standalone native queue uses its verified disk format, isolates threads, and never creates a missing database', () => {
  const directory = mkdtempSync('/tmp/herdr-native-queue-test-'), path = `${directory}/queue.sqlite`;
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT, queue_order INTEGER)');
    const payload = JSON.stringify({ UserInput: { content: [{ type: 'text', text: 'Queued fixture', text_elements: [] }], client_id: 'client-id' } });
    db.query('INSERT INTO queued_items VALUES (?, ?, ?, ?)').run('native-id', 'thread', payload, 0);
    expect(localCodexQueue(path, 'thread')).toEqual({ data: [{ id: 'native-id', clientUserMessageId: 'client-id', input: [{ type: 'text', text: 'Queued fixture', text_elements: [] }] }], nextCursor: null });
    expect(localCodexQueue(path, 'other').data).toEqual([]);
    expect((db.query('SELECT count(*) AS n FROM queued_items').get() as any).n).toBe(1);
    expect(() => localCodexQueue(`${directory}/missing.sqlite`, 'thread')).toThrow();
    expect(existsSync(`${directory}/missing.sqlite`)).toBe(false);
    db.query('UPDATE queued_items SET payload_json = ?').run('{}');
    expect(() => localCodexQueue(path, 'thread')).toThrow('unsupported');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
