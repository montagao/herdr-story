import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayStore, buildReplay } from './replay';
import { StudioStore } from './studio';
import { replayRange, REPLAY_LIMIT } from '../shared/replay';
import type { AgentInfo } from '../shared/types';
const agent: AgentInfo = { pane_id: 'w1:1', agent: 'claude', agent_status: 'working', title: 'Build the garden' };
const now = Date.now();
describe('durable office replay', () => {
  test('stores changes only, survives restart, and preserves removals and baseline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-replay-'));
    let store = new ReplayStore(dir);
    try {
      store.record([agent], now - 5000); store.record([agent], now - 4000);
      store.record([{ ...agent, agent_status: 'done' }], now - 3000);
      store.close(); store = new ReplayStore(dir);
      store.record([{ ...agent, agent_status: 'done' }], now - 2000);
      store.record([], now - 1000);
      const data = store.range(now - 4500, now);
      expect(data.agents[0].agent_status).toBe('working');
      expect(data.moments).toHaveLength(2);
      expect(data.moments[1]).toMatchObject({ kind: 'agent', agent: null });
      expect(store.range(now - 500, now).agents).toEqual([]);
      expect(data.recordedSince).toBe(now - 5000);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('retention preserves the last state before the window but drops departed agents', () => {
    const store = new ReplayStore();
    try {
      store.record([agent, { ...agent, pane_id: 'gone' }], now - 20 * 86400_000);
      store.record([agent], now - 19 * 86400_000);
      store.record([agent], now);
      const data = store.range(now - 7 * 86400_000, now);
      expect(data.agents.map(a => a.pane_id)).toEqual(['w1:1']);
      expect(data.moments).toEqual([]);
      expect(store.range(now - 21 * 86400_000, now - 15 * 86400_000).agents).toEqual([]);
      const crossing = store.range(now - 15 * 86400_000, now);
      expect(crossing.agents).toEqual([]);
      expect(crossing.moments[0]).toMatchObject({ kind: 'agent', pane: 'w1:1' });
    } finally { store.close(); }
  });
  test('does not retain terminal output or attachments', () => {
    const store = new ReplayStore();
    try {
      store.record([{ ...agent, activity: { text: 'secret terminal text' }, last_prompt: 'private attachment path' } as unknown as AgentInfo], now - 1000);
      const text = JSON.stringify(store.range(now - 500, now));
      expect(text).not.toContain('secret terminal'); expect(text).not.toContain('private attachment');
    } finally { store.close(); }
  });
  test('bounds large replay requests without silently truncating', () => {
    const store = new ReplayStore();
    try {
      store.record(Array.from({ length: REPLAY_LIMIT + 1 }, (_, i) => ({ ...agent, pane_id: String(i) })), now - 1000);
      expect(() => store.range(now - 2000, now)).toThrow('shorter range');
    } finally { store.close(); }
  });
  test('validates timeframe and supplies an empty, read-only historical snapshot', () => {
    expect(() => replayRange(now, now + 1000, now)).toThrow();
    expect(() => replayRange(now - 8 * 86400_000, now, now)).toThrow();
    expect(() => replayRange('yesterday', now, now)).toThrow();
    const store = new ReplayStore(), studio = new StudioStore();
    try {
      const data = buildReplay(store, studio, now - 86400_000, now);
      expect(data.moments).toEqual([]); expect(data.recordedSince).toBeNull();
      expect(data.snapshot.transcripts).toEqual({}); expect(data.snapshot.studio.journal).toEqual([]);
    } finally { store.close(); }
  });
});

test('replay paginates saved payments, includes range boundaries and archived entries', () => {
  const store = new ReplayStore(), studio = new StudioStore();
  try {
    const from = now - 10000, to = now - 1000;
    for (let i = 0; i < 205; i++) studio.recordSale({ id: `evt_${i}`, ts: from + i,
      source: i % 2 ? 'stripe' : 'revenuecat', kind: 'sale', amount: 19.99, currency: 'usd', label: 'Fictional payment' });
    studio.recordSale({ id: 'evt_edge', ts: to, kind: 'sale', amount: 5, currency: 'usd', label: 'At end' });
    studio.recordSale({ id: 'evt_later', ts: to + 1, kind: 'sale', amount: 5, currency: 'usd', label: 'Too late' });
    const before = studio.snapshot();
    const data = buildReplay(store, studio, from, to);
    expect(data.moments).toHaveLength(206);
    expect(data.moments[0].at).toBe(from); expect(data.moments.at(-1)?.at).toBe(to);
    expect(data.moments.filter(m => m.kind === 'journal' && m.entry.source === 'revenuecat').length).toBeGreaterThan(100);
    expect(studio.snapshot()).toEqual(before);
  } finally { store.close(); }
});


test('room snapshots and original billing events survive restart and do not duplicate journal payments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-replay-room-'));
  let store = new ReplayStore(dir);
  const studio = new StudioStore();
  const before = studio.snapshot();
  const after = structuredClone(before); after.revision++;
  after.room.items = [{id:'plant',kind:'decor',asset:'plant',x:64,y:128}];
  const event = {id:'evt_recorded',source:'stripe' as const,ts:now-2000,kind:'refund' as const,amount:-29,currency:'usd',label:'Refund'};
  try {
    store.recordStudio(before, now-5000); store.recordStudio(after, now-3000);
    store.recordEvent(event); studio.recordSale(event);
    store.close(); store = new ReplayStore(dir);
    const data = buildReplay(store, studio, now-4000, now);
    expect(data.snapshot.studio.room).toEqual(before.room);
    expect(data.moments.filter(m => m.kind === 'studio')).toHaveLength(1);
    const payment = data.moments.find(m => m.kind === 'money');
    expect(payment?.kind === 'money' && payment.event).toEqual(event);
    expect(payment?.kind === 'money' && payment.entry?.moneyId).toBe(event.id);
    expect(data.moments.filter(m => m.kind === 'journal')).toHaveLength(0);
  } finally { store.close(); rmSync(dir, {recursive:true,force:true}); }
});
