import { expect, test } from 'bun:test';
import { TerminalCache } from './terminal-cache';
import type { AgentInfo } from '../../shared/types';

const agent = (id = 'a', session = id): AgentInfo => ({ pane_id: id, agent: 'codex', agent_status: 'working',
  agent_session: { kind: 'id', value: session }, cwd: '/project' });

test('hover and open share a read; working panes go straight to the visible screen', async () => {
  const calls: string[] = []; let finish!: (text: string) => void;
  const cache = new TerminalCache(async (_pane, source) => { calls.push(source); return new Promise<string>(resolve => finish = resolve); });
  const a = agent(), first = cache.read(a), second = cache.read(a);
  expect(second).toBe(first); expect(calls).toEqual(['visible']);
  finish('latest output'); await first;
  expect(cache.peek(a)?.text).toBe('latest output');
});

test('an unsupported history source is remembered without treating a disconnect as a source error', async () => {
  const calls: string[] = []; let offline = false;
  const cache = new TerminalCache(async (_pane, source) => {
    calls.push(source); if (offline) throw Error('disconnected');
    if (source === 'recent_unwrapped') throw Error('unsupported source');
    return 'history';
  });
  const a = { ...agent(), agent_status: 'idle' as const };
  await cache.readHistory(a); await cache.readHistory(a);
  expect(calls).toEqual(['recent_unwrapped', 'recent', 'recent']);
  offline = true; await expect(cache.readHistory(a)).rejects.toThrow('disconnected');
  expect(calls).toHaveLength(4); expect(cache.peek(a)?.text).toBe('history');
});

test('older reads cannot overwrite output fetched after a command', async () => {
  const finishes: ((text: string) => void)[] = [];
  const cache = new TerminalCache(() => new Promise(resolve => finishes.push(resolve)));
  const a = agent(), before = cache.read(a);
  cache.invalidate(a); const after = cache.read(a);
  finishes[1]('after command'); await after;
  finishes[0]('before command'); await before;
  expect(cache.peek(a)?.text).toBe('after command');
});

test('pane reuse and departed agents cannot resurrect another session’s output', async () => {
  let finish!: (text: string) => void;
  const cache = new TerminalCache(() => new Promise(resolve => finish = resolve));
  const old = agent('same-pane', 'old-session'), fresh = agent('same-pane', 'new-session');
  const pending = cache.read(old); cache.retain([fresh]); finish('old conversation'); await pending;
  expect(cache.peek(old)).toBeUndefined(); expect(cache.peek(fresh)).toBeUndefined();
});

test('terminal snapshots expire and the least recently used entries are bounded', async () => {
  let now = 1;
  const cache = new TerminalCache(async pane => pane, () => now);
  for (let i = 0; i < 32; i++) await cache.read(agent(String(i)));
  cache.peek(agent('0')); await cache.read(agent('32'));
  expect(cache.peek(agent('0'))?.text).toBe('0'); expect(cache.peek(agent('1'))).toBeUndefined();
  now += 300_001; expect(cache.peek(agent('0'))).toBeUndefined();
});


test('idle agents render the screen without waiting for slow history', async () => {
  const sources: string[] = [];
  const cache = new TerminalCache(async (_pane, source) => { sources.push(source); return 'screen'; });
  await cache.read({ ...agent(), agent_status: 'idle' });
  expect(sources).toEqual(['visible']);
});

test('a pushed screen cannot be replaced in the cache by older history', async () => {
  let finish!: (text: string) => void;
  const cache = new TerminalCache(() => new Promise(resolve => finish = resolve));
  const a = agent(), pending = cache.readHistory(a);
  cache.accept(a, { text: 'new screen', source: 'visible', at: Date.now(), live: true });
  finish('old history'); await pending;
  expect(cache.peek(a)?.text).toBe('new screen');
});
