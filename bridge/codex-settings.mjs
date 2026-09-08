// Small Node adapter because Bun's HTTP/WebSocket implementation cannot use this Unix transport.
import WebSocket from 'ws';
import { homedir } from 'node:os';
import { join } from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { method, params } = JSON.parse(input);
const socket = process.env.HERDR_STORY_CODEX_SOCKET
  || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
const ws = new WebSocket(`ws+unix://${socket}:/`, { maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
let settled = false;
const finish = (error, result) => {
  if (settled) return;
  settled = true; clearTimeout(timer); ws.terminate();
  if (error) { process.stderr.write(error.message); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify(result));
};
const unavailable = () => finish(new Error('Direct settings are unavailable for this Codex session. Use Open terminal picker to change its model and effort.'));
const timer = setTimeout(unavailable, 10_000);
ws.on('error', unavailable);
ws.on('close', () => { if (!settled) unavailable(); });
ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {
  clientInfo: { name: 'herdr_story', version: '1.0.0' }, capabilities: { experimentalApi: true },
} })));
ws.on('message', data => {
  try {
    const message = JSON.parse(data.toString());
    if (message.id !== 1 && message.id !== 2) return;
    if (message.error) return finish(new Error(message.error.message || 'Codex rejected the settings change'));
    if (message.id === 1) {
      ws.send(JSON.stringify({ method: 'initialized' }));
      ws.send(JSON.stringify({ id: 2, method, params }));
    } else finish(undefined, message.result);
  } catch { finish(new Error('Invalid response from Codex settings connection')); }
});
