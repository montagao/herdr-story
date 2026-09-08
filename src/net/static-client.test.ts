import { expect, test } from 'bun:test';
import { StaticBridgeClient } from './static-client';
import type { DemoSnapshot } from '../../shared/demo';
import type { ServerMsg } from '../../shared/types';
import { emptyCareer } from '../../shared/studio';

const P = '/home/me/app';
function snapshot(): DemoSnapshot {
  return {
    version: 1, capturedAt: 1_000, theme: 'classic',
    agents: [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', cwd: P, employee_id: 'mona', office_name: 'Mona', state_change_seq: 0 },
      { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'codex', agent_status: 'idle', cwd: P, employee_id: 'new', office_name: 'Bea', state_change_seq: 0 },
    ],
    workspaces: [{ workspace_id: 'w1', label: 'app' }, { workspace_id: 'w2', label: 'app' }],
    events: [], money: [{ id: 'm1', ts: 1, kind: 'sale', amount: 9, currency: 'usd', label: 'Sub' }],
    studio: { version: 1, revision: 5,
      employees: [{ id: 'mona', version: 1, name: 'Mona', bio: '', kind: 'claude', face: 1, body: 1, favorite: true, createdAt: 0, shipped: 3, stats: { ...emptyCareer(), graphics: 3 } },
        { id: 'new', version: 1, name: 'Bea', bio: '', kind: 'codex', face: 1, body: 1, favorite: false, createdAt: 0, shipped: 0, stats: emptyCareer() }],
      projects: [{ id: P, version: 1, name: 'app', notes: '', color: '#000', goals: [] }],
      journal: [
        { id: 'j1', version: 1, at: 10, kind: 'task', title: 'Drew the shelf', notes: '', project: P, contributors: ['mona'], url: '', source: 'agent', stat: 'graphics' },
        { id: 'j2', version: 1, at: 20, kind: 'milestone', title: 'Shipped', notes: '', project: P, contributors: ['mona'], url: '', source: 'goal' },
        { id: 'j3', version: 1, at: 30, kind: 'task', title: 'Drew the plant', notes: 'leafy', project: P, contributors: ['mona'], url: '', source: 'agent', stat: 'graphics' },
      ],
      room: { version: 4, items: null, projectOrder: [P] } },
    revenue: {}, transcripts: { 'w1:p1': '● Painting the shelf' },
  };
}
const collect = (client: StaticBridgeClient) => { const seen: ServerMsg[] = []; client.on(m => seen.push(m)); return seen; };
const flush = () => new Promise(resolve => queueMicrotask(() => resolve(undefined)));

test('delivers a read-only snapshot and answers reads from it', async () => {
  const client = new StaticBridgeClient(snapshot(), { live: false });
  const seen = collect(client); await flush();
  expect(seen[0].type).toBe('snapshot');
  const first = seen[0] as Extract<ServerMsg, { type: 'snapshot' }>;
  expect(first.writable).toBe(false); expect(first.agents).toHaveLength(2); expect(first.studio?.journal).toHaveLength(3); expect(first.money).toHaveLength(1);
  expect(await client.call('ping')).toEqual({ type: 'pong' });
  expect(((await client.call('agent.read', { target: 'w1:p1', source: 'visible' })) as { read: { text: string } }).read.text).toBe('● Painting the shelf');
  expect(((await client.call('agent.read', { target: 'w2:p1', source: 'recent' })) as { read: { text: string } }).read.text).toContain('quiet');
  const trophies = await client.call('studio.journal', { trophies: true }) as { entries: { id: string }[]; total: number };
  expect(trophies.entries.map(e => e.id)).toEqual(['j2']);
  const page = await client.call('studio.journal', { limit: 2 }) as { entries: { id: string }[]; cursor: string | null; total: number };
  expect(page.entries.map(e => e.id)).toEqual(['j2', 'j3']); expect(page.total).toBe(3);
  const rest = await client.call('studio.journal', { limit: 2, cursor: page.cursor }) as { entries: { id: string }[]; cursor: string | null };
  expect(rest.entries.map(e => e.id)).toEqual(['j1']); expect(rest.cursor).toBeNull();
  expect(client.connected).toBe(true); expect(client.outputStreaming).toBe(false); expect(client.outputFresh('w1:p1')).toBe(false);
});

test('refuses changes with a read-only code, except the harmless legacy import', async () => {
  const client = new StaticBridgeClient(snapshot(), { live: false });
  await expect(client.call('studio.change', { op: 'employee.save' })).rejects.toMatchObject({ code: 'read_only' });
  await expect(client.call('agent.prompt', { target: 'w1:p1', text: 'hi' })).rejects.toMatchObject({ code: 'read_only' });
  await expect(client.uploadImage(new Blob(['x']))).rejects.toMatchObject({ code: 'read_only' });
  expect(((await client.call('studio.change', { op: 'legacy.import', rows: [] })) as { revision: number }).revision).toBe(5);
});

test('re-enacts a day: a veteran starts a real task, finishes it with a completion, then rests', async () => {
  let now = 100_000;
  const client = new StaticBridgeClient(snapshot(), { intervalMs: 0, seed: 3, now: () => now });
  const seen = collect(client); await flush();
  for (let i = 0; i < 30 && !seen.some(m => m.type === 'event' && m.event.status === 'working'); i++) { now += 3_000; client.tick(now); }
  const started = seen.find(m => m.type === 'event' && m.event.status === 'working') as Extract<ServerMsg, { type: 'event' }>;
  expect(started).toBeDefined();
  expect(started.event.pane_id).toBe('w1:p1');                       // only desks with a record take part
  expect(['Drew the shelf', 'Drew the plant']).toContain(started.event.title);
  now += 60_000; client.tick(now);
  const done = seen.find(m => m.type === 'event' && m.event.status === 'done') as Extract<ServerMsg, { type: 'event' }>;
  expect(done.event.completion).toMatchObject({ employeeId: 'mona', total: 4, stat: 'graphics' });
  expect(['j1', 'j3']).toContain(done.event.completion!.entryId);
  const studio = seen.filter(m => m.type === 'studio').at(-1) as Extract<ServerMsg, { type: 'studio' }>;
  expect(studio.studio.employees[0].shipped).toBe(4); expect(studio.studio.revision).toBe(6);
  now += 30_000; client.tick(now);
  const rested = seen.filter(m => m.type === 'event').map(m => (m as Extract<ServerMsg, { type: 'event' }>).event);
  expect(rested.findIndex(e => e.status === 'idle' && e.prev === 'done')).toBeGreaterThan(rested.findIndex(e => e.status === 'done'));
  const agents = (await client.call('agent.list')) as { agents: { pane_id: string; agent_status: string }[] };
  expect(agents.agents.find(a => a.pane_id === 'w2:p1')!.agent_status).toBe('idle');
});

test('a sale lands now and then, replayed from the captured tail with a fresh id', async () => {
  let now = 0;
  const client = new StaticBridgeClient(snapshot(), { intervalMs: 0, seed: 1, now: () => now });
  const seen = collect(client); await flush();
  for (let i = 0; i < 200 && !seen.some(m => m.type === 'money'); i++) { now += 3_000; client.tick(now); }
  const money = seen.find(m => m.type === 'money') as Extract<ServerMsg, { type: 'money' }>;
  expect(money.event).toMatchObject({ kind: 'sale', amount: 9, label: 'Sub' });
  expect(money.event.id).not.toBe('m1');
});
