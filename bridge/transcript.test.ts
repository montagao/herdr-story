import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outcomeFor, parseTranscript, promptAgrees, readTranscript, turnFor } from './transcript';

const j = (o: unknown) => JSON.stringify(o);
describe('parseTranscript', () => {
  test('shortened prompt metadata cannot detach a reply or erase a finished turn', () => {
    const prompt = 'Review the journal and propose ideas. '.repeat(50) + '\nBRIEFING ID: exact-review';
    const summary = j({ type: 'last-prompt', lastPrompt: prompt.slice(0, 200) + '…' });
    const before = parseTranscript([j({ type: 'user', message: { content: prompt } })]);
    const completed = parseTranscript([summary, j({ type: 'assistant', message: { content: 'The finished ideas.' } }), summary], before);
    expect(completed.prompt).toBe(prompt);
    expect(completed.reply).toBe('The finished ideas.');
    expect(completed.turns).toHaveLength(1);
    expect(completed.turns[0]).toMatchObject({ prompt, reply: 'The finished ideas.' });
  });
  test('Claude: the last real prompt and the last assistant text, not tool chatter', () => {
    const t = parseTranscript([
      j({ type: 'user', message: { content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] } }),
      j({ type: 'user', message: { content: [{ type: 'text', text: '[Image: source: /tmp/a.png]\nwhy does this look broken' }] } }),
      j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash' }] } }),
      j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      j({ type: 'user', isMeta: true, message: { content: 'system note' } }),
      j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed — the shadow is gone.' }] } }),
      j({ type: 'ai-title', aiTitle: 'Office shadows' }),
      j({ type: 'last-prompt', lastPrompt: 'why does this look broken' }),
    ]);
    expect(t).toMatchObject({ prompt: 'why does this look broken', reply: 'Fixed — the shadow is gone.', title: 'Office shadows' });
    expect(t.turns).toEqual([{ prompt: 'why does this look broken', reply: 'Fixed — the shadow is gone.', at: undefined,
      images: [{ name: 'a.png', path: '/tmp/a.png' }] }]);
  });
  test('Codex: input_text and output_text messages', () => {
    const t = parseTranscript([
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'plus button looks weird\n\nAttached image file (available locally on this machine):\n- /tmp/x.png' }] } }),
      j({ type: 'event_msg', payload: { type: 'item_completed' } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Replaced the dark square with a round cream button.' }] } }),
    ]);
    expect(t).toMatchObject({ prompt: 'plus button looks weird', reply: 'Replaced the dark square with a round cream button.' });
  });
  test('garbage lines are skipped', () => { expect(parseTranscript(['{not json', ''])).toEqual({ turns: [] }); });
  test('an older entry is matched to the turn of its own time, not the latest reply', () => {
    const t = parseTranscript([
      j({ type: 'user', timestamp: '2026-09-06T05:00:00Z', message: { content: 'first' } }),
      j({ type: 'assistant', timestamp: '2026-09-06T05:04:00Z', message: { content: [{ type: 'text', text: 'Did the first thing.' }] } }),
      j({ type: 'user', timestamp: '2026-09-06T05:10:00Z', message: { content: 'second' } }),
      j({ type: 'assistant', timestamp: '2026-09-06T05:20:00Z', message: { content: [{ type: 'text', text: 'Did the second thing.' }] } }),
    ]);
    expect(turnFor(t, Date.parse('2026-09-06T05:04:30Z'), 4)?.reply).toBe('Did the first thing.');
    expect(turnFor(t, Date.parse('2026-09-06T05:20:10Z'), 7)?.prompt).toBe('second');
    expect(turnFor(t, Date.parse('2026-09-06T04:00:00Z'), 1)).toBeUndefined();
  });
  test('a stale session file yields no outcome for a later task, rather than its old last reply', () => {
    const t = parseTranscript([
      j({ type: 'user', timestamp: '2026-09-06T05:50:00Z', message: { content: 'move the studio to sqlite' } }),
      j({ type: 'assistant', timestamp: '2026-09-06T05:57:42Z', message: { content: [{ type: 'text', text: 'Done — the studio now lives in SQLite.' }] } }),
    ]);
    expect(t.reply).toBe('Done — the studio now lives in SQLite.');
    expect(outcomeFor(t, Date.parse('2026-09-06T10:40:34Z'), 2)).toBeUndefined();
    expect(outcomeFor(t, Date.parse('2026-09-06T05:58:00Z'), 5)).toEqual({ prompt: 'move the studio to sqlite', summary: 'Done — the studio now lives in SQLite.' });
    const long = parseTranscript([j({ type: 'assistant', timestamp: '2026-09-06T05:57:42Z', message: { content: [{ type: 'text', text: 'word '.repeat(300) }] } })]);
    const clipped = outcomeFor(long, Date.parse('2026-09-06T05:58:00Z'))!.summary!;
    expect(clipped.length).toBeLessThanOrEqual(901); expect(clipped.endsWith('…')).toBe(true);
  });
  test('the screen outranks a transcript that tells a different story', () => {
    const t = parseTranscript([j({ type: 'user', message: { content: 'move the studio to sqlite, keep the api' } })]);
    expect(promptAgrees(t, undefined)).toBe(true);
    expect(promptAgrees(t, 'move the studio to  sqlite, keep…')).toBe(true);
    expect(promptAgrees(t, 'fix the layering here')).toBe(false);
    expect(promptAgrees(undefined, 'fix the layering here')).toBe(false);
    expect(promptAgrees({ turns: [] }, 'anything')).toBe(false);
  });
});

describe('readTranscript', () => {
  test('finds an idle agent’s prompt before a long tool result and retains its final reply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-transcript-'));
    try {
      const path = join(dir, 'session.jsonl');
      const prompt = 'Fix the pasted text window and keep café 🌱 readable';
      await Bun.write(path, [
        j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
        j({ type: 'response_item', payload: { type: 'function_call_output', output: 'tool output '.repeat(150) } }),
        j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The window is fixed.' }] } }),
      ].join('\n') + '\n');
      const result = await readTranscript(path, 67);
      expect(result.prompt).toBe(prompt);
      expect(result.reply).toBe('The window is fixed.');
      expect(result.turns).toEqual([{ prompt, reply: 'The window is fixed.', at: undefined }]);
      expect(await readTranscript(path, 67)).toBe(result);

      // A newer request must replace the cached prompt even if it too falls outside the tail.
      const next = 'Now fix the idle hover';
      await Bun.write(path, await Bun.file(path).text() + [
        j({ type: 'user', message: { content: next } }),
        j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output '.repeat(200) }] } }),
        j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hover fixed.' }] } }),
      ].join('\n') + '\n');
      expect(await readTranscript(path, 67)).toMatchObject({ prompt: next, reply: 'Hover fixed.' });

      // A replaced session file must not inherit a previous request or expose injected setup.
      await Bun.write(path, j({ type: 'user', message: { content: '# AGENTS.md instructions for /projects/example\nDo setup.' } }) + '\n');
      expect((await readTranscript(path, 67)).prompt).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('Codex task_complete proves completion; commentary and aborted turns do not', () => {
  const row = (type: string, payload: unknown) => JSON.stringify({type, timestamp:'2026-09-07T08:09:23.001Z', payload});
  const input = row('response_item', {type:'message',role:'user',content:[{type:'input_text',text:'Rotate the hourglass'}]});
  const progress = row('response_item', {type:'message',role:'assistant',content:[{type:'output_text',text:'Working on it'}]});
  expect(parseTranscript([input, progress]).completedAt).toBeUndefined();
  const finish = row('event_msg', {type:'task_complete',last_agent_message:'Done, verified in the browser.'});
  const completed = parseTranscript([input, progress, finish]);
  expect(completed.completedAt).toBe(Date.parse('2026-09-07T08:09:23.001Z'));
  expect(completed.reply).toBe('Done, verified in the browser.');
  expect(completed.turns[0].at).toBe(completed.completedAt);
  expect(parseTranscript([row('event_msg', {type:'task_started'})], completed).completedAt).toBeUndefined();
  expect(parseTranscript([row('event_msg', {type:'turn_aborted'})], completed).completedAt).toBeUndefined();
});
