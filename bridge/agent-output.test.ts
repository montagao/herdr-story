import { expect, test } from 'bun:test';
import { AgentOutputHub } from './agent-output';
import type { AgentInfo } from '../shared/types';
const agent: AgentInfo = { pane_id: 'a', agent: 'codex', agent_status: 'working', cwd: '/project' };
const next = () => new Promise(resolve => setTimeout(resolve, 0));

test('read requests from multiple tabs share one backend call and a short-lived cache', async () => {
  let calls = 0, now = 1, finish!: (value: unknown) => void;
  const hub = new AgentOutputHub(async () => { calls++; return new Promise(resolve => finish = resolve); }, () => agent, () => now);
  const a = hub.read({ target: 'a', source: 'visible' });
  const b = hub.read({ target: 'a', source: 'visible' });
  await next(); expect(calls).toBe(1);
  finish({ read: { text: 'output' } });
  expect((await a).read.text).toBe('output'); expect((await b).read.text).toBe('output');
  await next(); await hub.read({ target: 'a', source: 'visible' }); expect(calls).toBe(1);
  now += 181;
  const c = hub.read({ target: 'a', source: 'visible' }); await next();
  expect(calls).toBe(2); finish({ read: { text: 'new' } }); await c;
});

test('slow background history reserves a slot for interactive screen reads', async () => {
  const calls: string[] = [], finish = new Map<string, (value: unknown) => void>();
  const hub = new AgentOutputHub(async (_method, params) => {
    const id = String(params.target); calls.push(id); return new Promise(resolve => finish.set(id, resolve));
  }, () => agent);
  const a = hub.read({ target: 'background1' }, { priority: 'background' });
  const b = hub.read({ target: 'background2' }, { priority: 'background' });
  const c = hub.read({ target: 'screen' }); await next();
  expect(calls).toEqual(['background1', 'screen']);
  finish.get('screen')!({ read: { text: 'screen' } }); await c; await next();
  expect(calls).toHaveLength(2);
  finish.get('background1')!({ read: { text: 'a' } }); await a; await next();
  expect(calls).toEqual(['background1', 'screen', 'background2']);
  finish.get('background2')!({ read: { text: 'b' } }); await b;
});

test('cancelled queued reads never reach the backend and shared readers are unaffected', async () => {
  const calls: string[] = [], finish = new Map<string, (value: unknown) => void>();
  const hub = new AgentOutputHub(async (_method, params) => {
    const id = String(params.target); calls.push(id); return new Promise(resolve => finish.set(id, resolve));
  }, () => agent);
  const first = hub.read({ target: 'one' }, { priority: 'background' });
  const controller = new AbortController();
  const cancelled = hub.read({ target: 'cancelled' }, { priority: 'background', signal: controller.signal });
  const rejection = cancelled.catch(error => error); controller.abort(); expect((await rejection).message).toBe('Read cancelled');
  const sharedController = new AbortController();
  const shared = hub.read({ target: 'one' }, { signal: sharedController.signal });
  const sharedRejection = shared.catch(error => error); sharedController.abort(); expect((await sharedRejection).message).toBe('Read cancelled');
  await next(); finish.get('one')!({ read: { text: 'okay' } }); await first; await next();
  expect(calls).toEqual(['one']);
});

test('subscriptions share output and unsubscribe stops further scheduling', async () => {
  let calls = 0;
  const hub = new AgentOutputHub(async () => { calls++; return { read: { text: 'hello' } }; }, () => agent);
  const packets: string[][] = [[], []];
  const peers = packets.map(messages => ({ send: (data: string) => messages.push(data) }));
  hub.subscribe(peers[0], 'a'); hub.subscribe(peers[1], 'a'); await next();
  expect(calls).toBe(1); expect(packets[0]).toHaveLength(1); expect(packets[1]).toHaveLength(1);
  expect(JSON.parse(packets[0][0]).text).toBe('hello');
  hub.unsubscribe(peers[0]); hub.unsubscribe(peers[1]);
  await new Promise(resolve => setTimeout(resolve, 300)); expect(calls).toBe(1); hub.dispose();
});

test('a command invalidates cached reads and late pre-command output', async () => {
  let calls = 0;
  const hub = new AgentOutputHub(async () => ({ read: { text: String(++calls) } }), () => agent);
  expect((await hub.read({ target: 'a' })).read.text).toBe('1');
  hub.invalidate('a');
  expect((await hub.read({ target: 'a' })).read.text).toBe('2');
});

test('an immediate retry after backend failure is a new job', async () => {
  let calls = 0;
  const hub = new AgentOutputHub(async () => {
    if (++calls === 1) throw new Error('temporary read error');
    return { read: { text: 'recovered' } };
  }, () => agent);
  const result = await hub.read({ target: 'a' }).catch(() => hub.read({ target: 'a' }));
  expect(result.read.text).toBe('recovered'); expect(calls).toBe(2);
});

test('command invalidation refreshes an idle stream immediately instead of waiting its idle cadence', async () => {
  let calls = 0;
  const hub = new AgentOutputHub(async () => ({ read: { text: String(++calls) } }), () => ({ ...agent, agent_status: 'idle' }));
  const packets: string[] = [], peer = { send: (packet: string) => packets.push(packet) };
  hub.subscribe(peer, 'a'); await next();
  hub.invalidate('a'); hub.invalidate('a');
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(packets.length).toBeGreaterThan(1);
  hub.dispose();
});

class StreamClock {
  now = 1;
  private seq = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  schedule = ((callback: () => void, delay = 0) => {
    const id = ++this.seq; this.timers.set(id, { at: this.now + delay, callback }); return id;
  }) as unknown as typeof setTimeout;
  cancel = ((id: number | undefined) => { if (id !== undefined) this.timers.delete(id); }) as unknown as typeof clearTimeout;
  get nextDelay() { return Math.min(...[...this.timers.values()].map(timer => timer.at - this.now)); }
  async tick() {
    const [id, timer] = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    this.now = timer.at; this.timers.delete(id); timer.callback(); await next();
  }
}

test('quiet idle streams back off, heartbeat completed reads and wake immediately for status changes', async () => {
  const clock = new StreamClock(), current = { ...agent, agent_status: 'idle' as AgentInfo['agent_status'] };
  let calls = 0, text = 'quiet';
  const hub = new AgentOutputHub(async () => { calls++; return { read: { text } }; }, () => current, () => clock.now, clock);
  const packets: any[] = [], peer = { send: (data: string) => packets.push(JSON.parse(data)) };
  hub.subscribe(peer, 'a'); await next();
  expect(clock.nextDelay).toBe(800);
  for (const delay of [1000, 1000, 1000, 1000]) {
    await clock.tick(); expect(clock.nextDelay).toBe(delay);
    expect(packets.at(-1)).toEqual({ type: 'output.health', target: 'a', healthyForMs: delay + 2500 });
  }
  expect(calls).toBe(5); expect(packets.filter(packet => packet.type === 'output')).toHaveLength(1);
  current.agent_status = 'working'; hub.agentChanged('a'); await next();
  expect(calls).toBe(6); expect(clock.nextDelay).toBe(250);
  text = 'working output'; await clock.tick();
  expect(packets.at(-1).text).toBe(text); expect(clock.nextDelay).toBe(250);
  current.agent_status = 'idle'; hub.agentChanged('a'); await next();
  expect(clock.nextDelay).toBe(250);
  hub.dispose(); expect(clock.timers.size).toBe(0);
});

test('failed or hung reads cannot renew stream health and cancelled late output is discarded', async () => {
  const clock = new StreamClock();
  let calls = 0, finish!: (value: unknown) => void;
  const hub = new AgentOutputHub(async () => {
    calls++;
    if (calls === 1) return { read: { text: 'initial' } };
    if (calls === 2) throw new Error('offline');
    return new Promise(resolve => finish = resolve);
  }, () => ({ ...agent, agent_status: 'idle' }), () => clock.now, clock);
  const packets: any[] = [], peer = { send: (data: string) => packets.push(JSON.parse(data)) };
  hub.subscribe(peer, 'a'); await next(); expect(packets).toHaveLength(1);
  await clock.tick(); expect(calls).toBe(2); expect(packets).toHaveLength(1);
  await clock.tick(); expect(calls).toBe(3); expect(clock.timers.size).toBe(0);
  clock.now += 20_000; expect(packets).toHaveLength(1);
  hub.unsubscribe(peer); finish({ read: { text: 'late' } }); await next();
  expect(packets).toHaveLength(1); expect(clock.timers.size).toBe(0); hub.dispose();
});

test('a new subscriber gets an immediate cached screen without renewing its old health lease', async () => {
  const clock = new StreamClock();
  let calls = 0;
  const hub = new AgentOutputHub(async () => { calls++; return { read: { text: 'same' } }; }, () => ({ ...agent, agent_status: 'idle' }), () => clock.now, clock);
  const first: any[] = [], second: any[] = [];
  hub.subscribe({ send: data => first.push(JSON.parse(data)) }, 'a'); await next();
  await clock.tick(); await clock.tick(); await clock.tick();
  clock.now += 1_000;
  hub.subscribe({ send: data => second.push(JSON.parse(data)) }, 'a');
  expect(second[0].type).toBe('output'); expect(second[0].healthyForMs).toBe(2_500);
  await next(); expect(calls).toBe(5); expect(second.at(-1).type).toBe('output.health');
  hub.dispose();
});

test('a changed idle screen resets backoff and an in-flight command wake discards the earlier frame', async () => {
  const clock = new StreamClock();
  let text = 'quiet', calls = 0, held: ((value: unknown) => void) | undefined;
  let hold = false;
  const hub = new AgentOutputHub(async () => {
    calls++;
    if (hold) { hold = false; return new Promise(resolve => held = resolve); }
    return { read: { text } };
  }, () => ({ ...agent, agent_status: 'idle' }), () => clock.now, clock);
  const packets: any[] = [], peer = { send: (data: string) => packets.push(JSON.parse(data)) };
  hub.subscribe(peer, 'a'); await next(); await clock.tick(); await clock.tick();
  expect(clock.nextDelay).toBe(1000);
  text = 'new idle result'; await clock.tick(); expect(clock.nextDelay).toBe(800);
  hold = true; await clock.tick(); expect(held).toBeDefined();
  hub.invalidate('a'); await next(); expect(clock.nextDelay).toBe(0);
  text = 'after command'; await clock.tick();
  expect(packets.at(-1).text).toBe('after command');
  held!({ read: { text: 'stale before command' } }); await next();
  expect(packets.filter(packet => packet.type === 'output').map(packet => packet.text))
    .toEqual(['quiet', 'new idle result', 'after command']);
  expect(calls).toBe(6); hub.dispose();
});

test('final terminal paint after done is pushed promptly, including after the settling window', async () => {
  const clock = new StreamClock(), current = { ...agent, agent_status: 'working' as AgentInfo['agent_status'] };
  let text = 'last tool output';
  const hub = new AgentOutputHub(async () => ({ read: { text } }), () => current, () => clock.now, clock);
  const packets: any[] = [];
  hub.subscribe({ send: data => packets.push(JSON.parse(data)) }, 'a'); await next();
  current.agent_status = 'done'; hub.agentChanged('a'); await next();
  // The completion hook arrives before the terminal renders the answer.
  for (let i = 0; i < 6; i++) { expect(clock.nextDelay).toBe(250); await clock.tick(); }
  text = 'Final answer';
  await clock.tick(); expect(packets.at(-1).text).toBe('Final answer');
  for (let i = 0; i < 16; i++) await clock.tick();
  expect(clock.nextDelay).toBeLessThanOrEqual(1000);
  text = 'Final answer with a late footer';
  await clock.tick(); expect(packets.at(-1).text).toBe(text);
  hub.dispose();
});
