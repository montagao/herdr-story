import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageReceipts } from './message-receipts';
const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'herdr-message-receipts-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('concurrent duplicate sends coalesce; confirmed result survives restart without storing the prompt', async () => {
  const dir = directory(), receipts = new MessageReceipts(dir); let sends = 0;
  const send = async () => {
    sends++;
    const persisted = JSON.parse(readFileSync(join(dir, 'message-receipts.json'), 'utf8'));
    expect(persisted.receipts[0][1].state).toBe('pending');
    await new Promise(resolve => setTimeout(resolve, 10)); return { accepted: true };
  };
  const first = receipts.run('session', 'one', { text: 'secret prompt', other: 1 }, send);
  const retry = receipts.run('session', 'one', { other: 1, text: 'secret prompt' }, send);
  expect(first).toBe(retry);
  expect(await receipts.status('session', 'one')).toEqual({ state: 'pending' });
  expect(await first).toEqual({ accepted: true });
  expect(await new MessageReceipts(dir).run('session', 'one', { text: 'secret prompt', other: 1 }, send)).toEqual({ accepted: true });
  expect(sends).toBe(1);
  expect(await receipts.status('session', 'one')).toEqual({ state: 'confirmed', result: { accepted: true } });
  expect(await receipts.status('session', 'missing')).toEqual({ state: 'unknown' });
  expect(readFileSync(join(dir, 'message-receipts.json'), 'utf8')).not.toContain('secret prompt');
  expect(statSync(join(dir, 'message-receipts.json')).mode & 0o777).toBe(0o600);
});
test('an id with different contents is rejected both in flight and after confirmation', async () => {
  const receipts = new MessageReceipts();
  const first = receipts.run('pane', 'one', 'original', async () => 1);
  await expect(receipts.run('pane', 'one', 'changed', async () => 2)).rejects.toMatchObject({ code: 'conflict' });
  await first;
  await expect(receipts.run('pane', 'one', 'changed', async () => 2)).rejects.toMatchObject({ code: 'conflict' });
  expect(await receipts.run('another-session', 'one', 'changed', async () => 2)).toBe(2);
});
test('failed or interrupted sends remain uncertain across restart and cannot be replayed', async () => {
  const dir = directory(), receipts = new MessageReceipts(dir); let sends = 0;
  const send = async () => { sends++; throw Error('connection lost after write'); };
  await expect(receipts.run('session', 'one', 'text', send)).rejects.toMatchObject({ code: 'uncertain' });
  await expect(receipts.run('session', 'one', 'text', send)).rejects.toMatchObject({ code: 'uncertain' });
  await expect(new MessageReceipts(dir).run('session', 'one', 'text', send)).rejects.toMatchObject({ code: 'uncertain' });
  expect(sends).toBe(1);
  // Unknown receipts never expire, even when older than confirmed receipt retention.
  const file = join(dir, 'message-receipts.json'), data = JSON.parse(readFileSync(file, 'utf8'));
  data.receipts[0][1].at = 0; writeFileSync(file, JSON.stringify(data));
  await expect(new MessageReceipts(dir).run('session', 'one', 'text', send)).rejects.toMatchObject({ code: 'uncertain' });
  expect(sends).toBe(1);
});
test('explicit no-effect errors may be retried, while legacy requests remain compatible', async () => {
  const receipts = new MessageReceipts(directory()); let sends = 0;
  await expect(receipts.run('session', 'one', 'text', async () => { throw Object.assign(Error('not connected'), { notSent: true }); })).rejects.toThrow('not connected');
  expect(await receipts.run('session', 'one', 'text', async () => ++sends)).toBe(1);
  expect(await receipts.run('session', undefined, 'text', async () => ++sends)).toBe(2);
  expect(await receipts.run('session', undefined, 'text', async () => ++sends)).toBe(3);
});
test('persistence failure stops the side effect and corrupt saves fail closed', async () => {
  const dir = directory(), file = join(dir, 'message-receipts.json');
  writeFileSync(file, 'broken'); let sends = 0;
  await expect(new MessageReceipts(dir).run('session', 'one', 'text', async () => ++sends)).rejects.toThrow();
  expect(sends).toBe(0);
  const other = new MessageReceipts(join('/dev/null', 'impossible'));
  await expect(other.run('session', 'one', 'text', async () => ++sends)).rejects.toThrow();
  expect(sends).toBe(0);
});
test('only confirmed receipts expire and confirmation count is bounded', async () => {
  const dir = directory(), receipts = new MessageReceipts(dir);
  for (let i = 0; i < 502; i++) await receipts.run('session', `${i}`, 'text', async () => i);
  const file = join(dir, 'message-receipts.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.receipts).toHaveLength(500);
  saved.receipts.forEach((entry: [string, { at: number }]) => entry[1].at = 0); writeFileSync(file, JSON.stringify(saved));
  expect(await new MessageReceipts(dir).run('session', '501', 'text', async () => 'new')).toBe('new');
});
