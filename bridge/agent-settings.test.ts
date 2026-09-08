import { expect, test } from 'bun:test';
import { agentLaunchArgs, checkedAgentSettings } from '../shared/agent-settings';
import { codexSettingsCall } from './agent-settings';
import { mkdtempSync, rmSync } from 'node:fs';

test('launch overrides are discrete arguments and defaults preserve agent configuration', () => {
  expect(agentLaunchArgs('codex', checkedAgentSettings('codex', {}))).toEqual([]);
  expect(agentLaunchArgs('codex', checkedAgentSettings('codex', { model: 'custom/model', effort: 'high' })))
    .toEqual(['--model', 'custom/model', '-c', 'model_reasoning_effort="high"']);
  expect(agentLaunchArgs('claude', checkedAgentSettings('claude', { model: 'opus[1m]', effort: 'max' })))
    .toEqual(['--model', 'opus[1m]', '--effort', 'max']);
});

test('reject command injection, malformed values and unsupported settings', () => {
  for (const model of ['--help', 'opus\n/exit', '$(touch /tmp/bad)', 'model;exit', 'a'.repeat(161), 123]) {
    expect(() => checkedAgentSettings('codex', { model })).toThrow();
  }
  expect(() => checkedAgentSettings('claude', { effort: 'ultra' })).toThrow();
  expect(() => checkedAgentSettings('gemini', { model: 'model' })).toThrow();
  expect(checkedAgentSettings('gemini', {})).toEqual({ model: '', effort: '' });
});

test('Codex adapter initializes over a Unix WebSocket and preserves upstream rejection', async () => {
  const dir = mkdtempSync('/tmp/herdr-settings-rpc-'), socket = `${dir}/rpc.sock`;
  const previous = process.env.HERDR_STORY_CODEX_SOCKET;
  const server = Bun.spawn(['node', '--input-type=module', '-e', `
    import http from 'node:http';
    import { WebSocketServer } from 'ws';
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (req.headers['sec-websocket-extensions']) return socket.destroy();
      wss.handleUpgrade(req, socket, head, ws => {
        let initialized = false;
        ws.on('message', raw => {
          const m = JSON.parse(raw);
          if (m.method === 'initialize') return ws.send(JSON.stringify({ id: m.id, result: {} }));
          if (m.method === 'initialized') { initialized = true; return; }
          if (!initialized) return ws.close();
          const result = m.params.model === 'rejected'
            ? { id: m.id, error: { message: 'Model is unavailable' } }
            : { id: m.id, result: { received: m.params } };
          const text = JSON.stringify(result);
          ws.send(text.slice(0, 8), { fin: false }); ws.send(text.slice(8));
        });
      });
    });
    server.listen(process.argv[1], () => process.stdout.write('ready\\n'));
  `, socket], { stdout: 'pipe', stderr: 'inherit' });
  try {
    const reader = server.stdout.getReader(); await reader.read(); reader.releaseLock();
    process.env.HERDR_STORY_CODEX_SOCKET = socket;
    const params = { threadId: 'test-thread', model: 'custom-model', effort: 'high' };
    expect(await codexSettingsCall('thread/settings/update', params)).toEqual({ received: params });
    await expect(codexSettingsCall('thread/settings/update', { model: 'rejected' })).rejects.toThrow('Model is unavailable');
  } finally {
    if (previous === undefined) delete process.env.HERDR_STORY_CODEX_SOCKET;
    else process.env.HERDR_STORY_CODEX_SOCKET = previous;
    server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true });
  }
});
