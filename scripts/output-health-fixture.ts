// Local browser-test fixture only. It cannot launch agents or forward commands to Herdr.
import { join, normalize } from 'node:path';
import { AgentOutputHub } from '../bridge/agent-output';
import type { AgentInfo } from '../shared/types';
const target = 'fixture:quiet';
const agent: AgentInfo = { pane_id: target, workspace_id: 'fixture', workspace_name: 'Output health fixture',
  agent: 'codex', name: 'Quiet fixture', agent_status: 'idle', cwd: '/tmp/fixture', agent_session: { kind: 'fixture', value: 'quiet' } };
const studio = { version: 1, revision: 0, employees: [], projects: [], journal: [], room: { version: 0, items: null, projectOrder: [] } };
const snapshot = () => ({ type: 'snapshot', agents: [agent], workspaces: [{ workspace_id: 'fixture', label: 'Output health fixture' }],
  events: [], writable: false, mock: true, studio, queues: [] });
let failed = false, connectAllowed = true;
const peers = new Set<any>(), backendReads: { at: number; source: unknown; failed: boolean }[] = [], rpcReads: { at: number; transport: string }[] = [];
const hub = new AgentOutputHub(async (_method, params) => {
  backendReads.push({ at: performance.now(), source: params.source, failed });
  if (failed) throw new Error('Fixture read failed');
  return { read: { text: 'Quiet agent output\nhttps://example.com/artifact\nReady for the next task.' } };
}, id => id === target ? agent : undefined);
async function call(message: any, transport: string) {
  if (message.method === 'agent.read') { rpcReads.push({ at: performance.now(), transport }); return hub.read(message.params); }
  if (message.method === 'ping') return { okay: true };
  if (message.method === 'studio.get') return studio;
  throw new Error('This isolated fixture supports reads only');
}
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.OUTPUT_HEALTH_PORT),
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (connectAllowed && server.upgrade(request)) return;
      return new Response('Fixture socket unavailable', { status: 503 });
    }
    if (url.pathname === '/api/state') return Response.json(snapshot());
    if (url.pathname === '/fixture/metrics') return Response.json({ backendReads, rpcReads });
    if (url.pathname === '/fixture/control' && request.method === 'POST') {
      const value = await request.json() as { failed?: boolean; connectAllowed?: boolean; disconnect?: boolean };
      if (value.failed !== undefined) { failed = value.failed; if (!failed) hub.invalidate(target); }
      if (value.connectAllowed !== undefined) connectAllowed = value.connectAllowed;
      if (value.disconnect) for (const peer of peers) peer.close(1001, 'Fixture disconnect');
      return Response.json({ okay: true });
    }
    if (url.pathname === '/api/call' && request.method === 'POST') {
      try { return Response.json({ result: await call(await request.json(), 'http') }); }
      catch (error) { return Response.json({ error: { message: (error as Error).message } }); }
    }
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    const file = Bun.file(join(process.cwd(), 'dist', path || 'index.html'));
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  },
  websocket: {
    open(peer) { peers.add(peer); peer.send(JSON.stringify(snapshot())); },
    close(peer) { peers.delete(peer); hub.close(peer); },
    async message(peer, data) {
      const msg = JSON.parse(String(data));
      if (msg.type === 'hello') peer.send(JSON.stringify(snapshot()));
      if (msg.type === 'output.subscribe') hub.subscribe(peer, msg.target);
      if (msg.type === 'output.unsubscribe') hub.unsubscribe(peer);
      if (msg.type === 'call') {
        try { peer.send(JSON.stringify({ type: 'result', id: msg.id, result: await call(msg, 'socket') })); }
        catch (error) { peer.send(JSON.stringify({ type: 'result', id: msg.id, error: { message: (error as Error).message } })); }
      }
    },
  },
});
console.log(`Output health fixture listening on ${server.port}`);
