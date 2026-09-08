import { test, expect } from 'bun:test';
import { appendFile, mkdtemp, rm, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTranscript } from './transcript';

const row = (type: string, content: string) => JSON.stringify({ type, message: { content } });
test('a cold tail read passes shortened metadata to find the full prompt in earlier chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-prompt-summary-')), path = join(directory, 'session.jsonl');
  try {
    const prompt = 'Journal evidence for this exact review. '.repeat(80) + 'BRIEFING ID: one';
    await writeFile(path, [row('user', prompt), JSON.stringify({ type: 'tool', output: 'x'.repeat(5000) }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: prompt.slice(0, 200) + '…' }), row('assistant', 'Finished ideas')].join('\n') + '\n');
    const result = await readTranscript(path, 256);
    expect(result.prompt).toBe(prompt); expect(result.reply).toBe('Finished ideas');
    expect(result.turns).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('incremental reads retain split UTF-8, coalesce readers, and never reuse an older reply for a new prompt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-incremental-')), path = join(directory, 'session.jsonl');
  try {
    await writeFile(path, row('user', 'first') + '\n' + row('assistant', 'done') + '\n');
    expect((await readTranscript(path, 31)).reply).toBe('done');
    const next = Buffer.from(row('user', 'café 🌱 second'));
    const split = next.indexOf(Buffer.from('🌱')) + 2;
    await appendFile(path, next.subarray(0, split));
    expect((await readTranscript(path)).prompt).toBe('first');
    await appendFile(path, next.subarray(split));
    const first = readTranscript(path), second = readTranscript(path);
    expect(first).toBe(second);
    expect((await first).prompt).toBe('café 🌱 second');
    expect((await first).reply).toBeUndefined();
    await appendFile(path, '\n' + JSON.stringify({ type: 'tool', output: 'x'.repeat(600_000) }) + '\n' + row('assistant', 'second done') + '\n');
    expect(await readTranscript(path)).toMatchObject({ prompt: 'café 🌱 second', reply: 'second done' });
    expect((await readTranscript(path)).turns).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('same-size replacement, truncation and inode rotation discard cached turns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-rotation-')), path = join(directory, 'session.jsonl');
  try {
    await writeFile(path, row('user', 'alpha') + '\n'); await readTranscript(path);
    await writeFile(path, row('user', 'bravo') + '\n');
    expect((await readTranscript(path)).prompt).toBe('bravo');
    await writeFile(path, ''); expect((await readTranscript(path)).turns).toHaveLength(0);
    await writeFile(path + '.new', row('user', 'rotated') + '\n'); await rename(path + '.new', path);
    expect((await readTranscript(path)).prompt).toBe('rotated');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
