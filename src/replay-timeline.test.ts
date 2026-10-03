import { expect, test } from 'bun:test';
import { ReplayTimeline, replayTotals } from './replay-timeline';
import type { ReplayData } from '../shared/replay';
import { replayMoney } from '../shared/replay';
import demo from '../public/demo/office.json';
import type { DemoSnapshot } from '../shared/demo';
const snapshot = structuredClone(demo) as unknown as DemoSnapshot;
snapshot.agents = []; snapshot.studio.journal = []; snapshot.money = [];
const entry = { ...(demo as unknown as DemoSnapshot).studio.journal[0], id: 'pay', kind: 'sale' as const, source: 'revenuecat' as const, at: 3600_000, amount: 999, currency: 'usd' };
const data: ReplayData = { from: 0, to: 86400_000, recordedSince: null, snapshot, moments: [{ id: 'journal:pay', at: entry.at, kind: 'journal', entry }] };
test('compresses a whole quiet day to seconds, holding the payment for seven seconds', () => {
  const timeline = new ReplayTimeline(data);
  expect(timeline.duration).toBe(9400);
  expect(timeline.position(1199).at).toBeLessThan(entry.at);
  expect(timeline.position(1200).segment?.moment?.id).toBe('journal:pay');
  expect(timeline.position(8199).at).toBe(entry.at);
  expect(timeline.position(timeline.duration).at).toBe(data.to);
});
test('seeking backwards removes future payments and is repeatable without mutating source', () => {
  const timeline = new ReplayTimeline(data);
  expect(timeline.snapshotAt(data.to).money).toHaveLength(1);
  expect(timeline.snapshotAt(100).money).toHaveLength(0);
  expect(timeline.snapshotAt(data.to)).toEqual(timeline.snapshotAt(data.to));
  expect(snapshot.money).toHaveLength(0); expect(snapshot.studio.journal).toHaveLength(0);
  expect(timeline.wallAt(entry.at)).toBe(1200);
  expect(timeline.wallAt(data.to)).toBe(timeline.duration);
});
test('replays state changes and departures without inventing task transitions', () => {
  const timeline = new ReplayTimeline({ ...data, recordedSince: 0, moments: [
    { id: 'join', at: 100, kind: 'agent', pane: 'a', agent: { pane_id: 'a', agent: 'claude', agent_status: 'blocked' } },
    { id: 'left', at: 200, kind: 'agent', pane: 'a', agent: null },
  ] });
  expect(timeline.snapshotAt(150).agents[0].agent_status).toBe('blocked');
  expect(timeline.snapshotAt(201).agents).toHaveLength(0);
});
test('handles empty history and refunds', () => {
  const timeline = new ReplayTimeline({ ...data, moments: [] });
  expect(timeline.duration).toBe(1200);
  expect(timeline.snapshotAt(data.to).agents).toEqual([]);
  expect(replayMoney({ ...entry, amount: -999 })?.kind).toBe('refund');
});


test('journal reconstruction preserves the complete office instead of clearing other desks', () => {
  const employee = (demo as unknown as DemoSnapshot).studio.employees[0];
  const contextAgents = [
    { pane_id:'one', agent:'claude', agent_status:'working' as const, employee_id:employee.id, cwd:'/one' },
    { pane_id:'two', agent:'codex', agent_status:'idle' as const, cwd:'/two' },
  ];
  const task = { ...entry, kind:'task' as const, project:'/one', contributors:[employee.id] };
  const timeline = new ReplayTimeline({ ...data, contextAgents, moments:[{id:'task',at:task.at,kind:'journal',entry:task}] });
  expect(timeline.snapshotAt(0).agents).toHaveLength(2);
  expect(timeline.snapshotAt(0).agents.every(a => a.agent_status === 'unknown')).toBe(true);
  const after = timeline.snapshotAt(data.to).agents;
  expect(after).toHaveLength(2); expect(after.find(a => a.pane_id === 'one')?.agent_status).toBe('done');
  expect(after.find(a => a.pane_id === 'two')?.cwd).toBe('/two');
});
test('seeking restores recorded room state and original payment kinds', () => {
  const before = structuredClone(snapshot.studio), after = structuredClone(before);
  after.room.items = [{id:'cabinet',kind:'cabinet',x:40,y:50}];
  const event = {id:'dispute',ts:200,kind:'dispute' as const,source:'stripe' as const,amount:-29,currency:'usd',label:'Disputed payment'};
  const timeline = new ReplayTimeline({...data, snapshot:{...snapshot,studio:before}, moments:[
    {id:'room',at:100,kind:'studio',studio:after}, {id:'money',at:200,kind:'money',event},
  ]});
  expect(timeline.snapshotAt(201).studio.room).toEqual(after.room);
  expect(timeline.snapshotAt(201).money[0].kind).toBe('dispute');
  expect(timeline.snapshotAt(99).studio.room).toEqual(before.room);
  expect(timeline.snapshotAt(99).money).toHaveLength(0);
});

test('payment totals rewind, deduct refunds once and exclude failed invoices', () => {
  const money = (id: string, at: number, kind: 'sale' | 'refund' | 'failed', amount: number, currency = 'usd') =>
    ({ id, at, kind: 'money' as const, event: { id, ts: at, kind, amount, currency, source: 'stripe' as const, label: id } });
  const history = { ...data, moments: [money('paid', 100, 'sale', 29), money('failed', 200, 'failed', 99),
    money('refund', 300, 'refund', 10), money('refund', 301, 'refund', 10), money('eur', 400, 'sale', 5, 'eur')] };
  expect(replayTotals(history, 99).currencies).toEqual({});
  expect(replayTotals(history, 250).currencies).toEqual({ USD: 29 });
  expect(replayTotals(history, 500)).toMatchObject({ currencies: { USD: 19, EUR: 5 }, payments: 2 });
});
test('routine polling does not turn a short burst into minutes of playback', () => {
  const history = { ...data, moments: Array.from({length: 100}, (_, i) => ({ id: String(i), at: i * 10,
    kind: 'agent' as const, pane: 'a', agent: { pane_id: 'a', agent: 'claude', agent_status: 'working' as const } })) };
  expect(new ReplayTimeline(history).duration).toBeLessThan(10000);
});


test('background changes share one continuous gap instead of individual stops', () => {
  const timeline = new ReplayTimeline({ ...data, recordedSince: 0, moments: [
    {id:'a',at:100,kind:'agent',pane:'a',agent:{pane_id:'a',agent:'claude',agent_status:'working'}},
    {id:'b',at:200,kind:'agent',pane:'b',agent:{pane_id:'b',agent:'codex',agent_status:'working'}},
  ] });
  expect(timeline.segments).toHaveLength(1);
  expect(timeline.snapshotAt(250).agents.map(a => a.agent_status)).toEqual(['working','working']);
  expect(timeline.position(timeline.wallAt(250)).stateIndex).toBe(2);
});

test('pending customer payments enter the total only after arrival', () => {
  expect(replayTotals(data, data.to, new Set(['journal:pay'])).currencies).toEqual({});
  expect(replayTotals(data, data.to).currencies).toEqual({USD:999});
});

test('recorded work gets time to animate without stretching genuinely quiet history', () => {
  const working = {...data, recordedSince:0, snapshot:{...snapshot, agents:[{pane_id:'a',agent:'claude',agent_status:'working' as const}]} };
  const busy = new ReplayTimeline(working), quiet = new ReplayTimeline(data);
  expect(busy.segments[0].activeWork).toBe(true);
  expect(busy.segments[0].end).toBeGreaterThan(quiet.segments[0].end * 2);
  expect(busy.position(busy.wallAt(1800000)).at).toBe(1800000);
  const unknown = new ReplayTimeline({...working,recordedSince:null});
  expect(unknown.segments[0].activeWork).toBe(false);
});
