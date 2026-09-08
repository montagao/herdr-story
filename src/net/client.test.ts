import { expect, test } from 'bun:test';
import { BridgeClient } from './client';

class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 1;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor(_url: string) { Socket.latest = this; queueMicrotask(() => this.onopen?.()); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
async function withClient(work: (client: BridgeClient, socket: Socket) => Promise<void>, now?: () => number) {
  const globals = globalThis as any;
  const before = { window: globals.window, document: globals.document, WebSocket: globals.WebSocket };
  globals.window = globalThis; globals.document = { hidden: false, addEventListener() {} }; globals.WebSocket = Socket;
  try { const client = new BridgeClient('ws://test', now); await Promise.resolve(); await work(client, Socket.latest); }
  finally { Object.assign(globals, before); }
}

test('read deadlines release pending calls, cancel remote work and ignore late results', async () => {
  await withClient(async (client, socket) => {
    const error: any = await client.call('agent.read', { target: 'a' }, { timeoutMs: 5 }).catch(error => error);
    expect(error.code).toBe('unavailable');
    expect(socket.sent.map(msg => msg.type)).toEqual(['hello', 'output.unsubscribe', 'call', 'cancel']);
    socket.receive({ type: 'result', id: 'c1', result: 'too late' });
    const next = client.call('ping'); socket.receive({ type: 'result', id: 'c2', result: 'okay' });
    expect(await next).toBe('okay');
  });
});

test('uncertain writes are never cancelled remotely or replayed', async () => {
  await withClient(async (client, socket) => {
    const error: any = await client.call('agent.prompt', { target: 'a', text: 'task' }, { timeoutMs: 5 }).catch(error => error);
    expect(error.uncertain).toBe(true); expect(error.code).toBe('uncertain');
    expect(socket.sent.filter(msg => msg.type === 'call')).toHaveLength(1);
    expect(socket.sent.some(msg => msg.type === 'cancel')).toBe(false);
  });
});

test('switching subscriptions ignores obsolete agent output', async () => {
  await withClient(async (client, socket) => {
    const output: string[] = [];
    const stopOld = client.watchOutput('old', update => output.push(update.text));
    const stopNew = client.watchOutput('new', update => output.push(update.text));
    stopOld();
    socket.receive({ type: 'output', target: 'old', text: 'old' });
    socket.receive({ type: 'output', target: 'new', text: 'new' });
    expect(output).toEqual(['new']);
    stopNew(); expect(socket.sent.at(-1).type).toBe('output.unsubscribe');
  });
});

test('agent deltas reconstruct full updates and replay the latest snapshot to late listeners', async () => {
  await withClient(async (client, socket) => {
    socket.receive({ type: 'snapshot', agents: [{ pane_id: 'a', agent_status: 'idle' }], events: [], writable: false, mock: true });
    socket.receive({ type: 'agents.patch', upsert: [{ pane_id: 'b', agent_status: 'working' }], remove: ['a'] });
    let latest: any;
    client.on(message => latest = message); await Promise.resolve();
    expect(latest.agents.map((a: any) => a.pane_id)).toEqual(['b']);
  });
});

test('studio deltas preserve unchanged fields and apply additions, updates and deletions', async () => {
  await withClient(async (client, socket) => {
    const room = { version: 1, items: [], projectOrder: [] };
    socket.receive({ type: 'snapshot', agents: [], events: [], writable: false, mock: true,
      studio: { version: 1, revision: 1, room, employees: [{ id: 'e', name: 'Before' }], projects: [],
        journal: [{ id: 'removed', at: 1 }] } });
    socket.receive({ type: 'studio.patch', baseRevision: 1, revision: 2,
      employees: { upsert: [{ id: 'e', name: 'After' }], remove: [] },
      journal: { upsert: [{ id: 'new', at: 5 }], remove: ['removed'] } });
    let latest: any;
    client.on(message => latest = message); await Promise.resolve();
    expect(latest.studio.revision).toBe(2); expect(latest.studio.room).toEqual(room);
    expect(latest.studio.employees[0].name).toBe('After');
    expect(latest.studio.journal.map((entry: any) => entry.id)).toEqual(['new']);
  });
});

test('launch progress belongs to its pending call', async () => {
  await withClient(async (client, socket) => {
    const stages: string[] = [];
    const call = client.call('agent.free', {}, { onProgress: stage => stages.push(stage) });
    socket.receive({ type: 'launch', id: 'other', stage: 'creating' });
    socket.receive({ type: 'launch', id: 'c1', stage: 'starting' });
    socket.receive({ type: 'result', id: 'c1', result: { target: 'a' } });
    await call; expect(stages).toEqual(['starting']);
  });
});

test('performance samples are bounded and contain no message or terminal content', async () => {
  await withClient(async (client, socket) => {
    for (let i = 1; i <= 125; i++) {
      const request = client.call('ping', { text: 'private prompt' });
      socket.receive({ type: 'result', id: `c${i}`, result: 'private terminal output' });
      await request;
    }
    client.watchOutput('agent', () => {});
    socket.receive({ type: 'output', target: 'agent', text: 'private terminal output' });
    socket.receive({ type: 'output', target: 'agent', text: 'private terminal output again' });
    const timings = client.performanceSnapshot();
    expect(timings).toHaveLength(120);
    expect(timings.filter(entry => entry.name === 'herdr.chat.first-output')).toHaveLength(1);
    expect(performance.getEntriesByName('herdr.rpc.ping')).toHaveLength(1);
    expect(JSON.stringify(timings)).not.toContain('private');
  });
});

test('revision mismatch requests an ordered socket snapshot before accepting newer patches', async () => {
  await withClient(async (client, socket) => {
    const studio = { version: 1, revision: 1, room: { version: 1, items: [], projectOrder: [] }, employees: [], projects: [], journal: [] };
    const snapshot = { type: 'snapshot', agents: [], events: [], writable: false, mock: true, studio };
    socket.receive(snapshot);
    socket.receive({ type: 'studio.patch', baseRevision: 2, revision: 3 });
    socket.receive({ type: 'studio.patch', baseRevision: 3, revision: 4 });
    expect(socket.sent.filter(message => message.type === 'hello')).toHaveLength(2);
    socket.receive({ ...snapshot, studio: { ...studio, revision: 4 } });
    socket.receive({ type: 'studio.patch', baseRevision: 4, revision: 5, employees: { upsert: [{ id: 'new' }], remove: [] } });
    let latest: any; client.on(message => latest = message); await Promise.resolve();
    expect(latest.studio.revision).toBe(5);
    expect(latest.studio.employees.map((entry: any) => entry.id)).toEqual(['new']);
  });
});

test('a late HTTP fallback result cannot rewind state after the socket reconnects', async () => {
  await withClient(async (client, socket) => {
    const originalFetch = globalThis.fetch;
    let finish!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => finish = resolve)) as unknown as typeof fetch;
    try {
      const snapshot = (pane: string) => ({ type: 'snapshot', agents: [{ pane_id: pane }], events: [], writable: false, mock: true });
      socket.receive(snapshot('initial'));
      (client as any).polling = true;
      const pending = (client as any).poll();
      (client as any).stopPolling();
      socket.receive(snapshot('reconnected'));
      finish(Response.json(snapshot('stale-http'))); await pending;
      let latest: any; client.on(message => latest = message); await Promise.resolve();
      expect(latest.agents.map((a: any) => a.pane_id)).toEqual(['reconnected']);
      expect(client.connected).toBe(true);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('successful-read heartbeats keep quiet output fresh using the local receipt clock', async () => {
  let now = 1;
  await withClient(async (client, socket) => {
    let renders = 0;
    client.watchOutput('a', () => renders++);
    expect(client.outputFresh('a')).toBe(false);
    socket.receive({ type: 'output.health', target: 'a', healthyForMs: 7500 });
    expect(client.outputFresh('a')).toBe(false); // A heartbeat cannot replace the first screen.
    socket.receive({ type: 'output', target: 'a', text: 'quiet', at: -999_999_999, healthyForMs: 3300 });
    expect(client.outputFresh('a')).toBe(true);
    now += 3200;
    socket.receive({ type: 'output.health', target: 'a', healthyForMs: 7500 });
    now += 5000; expect(client.outputFresh('a')).toBe(true); expect(renders).toBe(1);
    now += 2500; expect(client.outputFresh('a')).toBe(false);
    socket.receive({ type: 'output.health', target: 'other', healthyForMs: 7500 });
    expect(client.outputFresh('a')).toBe(false);
    socket.receive({ type: 'output.health', target: 'a', healthyForMs: 7500 });
    expect(client.outputFresh('a')).toBe(true);
    socket.receive({ type: 'output.health', target: 'a', healthyForMs: 0 });
    expect(client.outputFresh('a')).toBe(false);
  }, () => now);
});

test('selection, reconnect and visibility reset health until a fresh screen arrives', async () => {
  let now = 1;
  await withClient(async (client, socket) => {
    client.watchOutput('a', () => {});
    const output = { type: 'output', target: 'a', text: 'quiet', healthyForMs: 7500 };
    socket.receive(output); expect(client.outputFresh('a')).toBe(true);
    (document as any).hidden = true; expect(client.outputFresh('a')).toBe(false);
    (client as any).syncOutputSubscription();
    (document as any).hidden = false; (client as any).syncOutputSubscription();
    expect(client.outputFresh('a')).toBe(false);
    socket.receive(output); expect(client.outputFresh('a')).toBe(true);
    socket.onopen?.(); expect(client.outputFresh('a')).toBe(false);
    socket.receive(output); client.watchOutput('b', () => {});
    expect(client.outputFresh('a')).toBe(false); expect(client.outputFresh('b')).toBe(false);
    socket.receive(output); expect(client.outputFresh('b')).toBe(false);
    now += 1000;
  }, () => now);
});

test('compact save replies use the captured base despite newer socket updates', async () => {
 await withClient(async(client,socket)=>{
  const studio:any={version:1,revision:1,employees:[],projects:[],journal:[],room:{version:0,items:null,projectOrder:[]}};
  socket.receive({type:'snapshot',agents:[],events:[],writable:true,mock:true,studio});
  const pending=client.call('studio.change',{op:'entry.save',title:'One'});
  expect(socket.sent.at(-1).params.base_revision).toBe(1);expect(socket.sent.at(-1).params.response).toBe('patch');
  const patch:any={type:'studio.patch',baseRevision:1,revision:2,metadata:{},journal:{upsert:[{id:'one',at:1,title:'One'}],remove:[]}};
  socket.receive(patch);
  socket.receive({type:'studio.patch',baseRevision:2,revision:3,metadata:{},journal:{upsert:[{id:'two',at:2,title:'Two'}],remove:[]}});
  socket.receive({type:'result',id:'c1',result:{type:'studio.ack',revision:2,patch}});
  const result:any=await pending;expect(result.revision).toBe(2);expect(result.journal.map((e:any)=>e.id)).toEqual(['one']);
  let latest:any;client.on(message=>latest=message);await Promise.resolve();expect(latest.studio.revision).toBe(3);
 });
});
