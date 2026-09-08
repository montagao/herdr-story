import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HerdrClient } from './herdr-client';

async function socketTest(reply: (request: any) => unknown, check: (client: HerdrClient) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-transport-')), path = join(dir, 'test.sock');
  const server = createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const response = reply(JSON.parse(buffer.trim()));
      socket.end(response === undefined ? '' : JSON.stringify(response) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try { await check(new HerdrClient(path)); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}

test('Herdr id-less schema rejection surfaces its actual error rather than socket closed', async () => {
  await socketTest(() => ({ id: '', error: { code: 'invalid_request', message: 'invalid type: sequence, expected a map' } }), async client => {
    const error = await client.call('workspace.create', { env: [] }).catch(error => error) as Error & { code?: string; notSent?: boolean };
    expect(error.message).toBe('invalid type: sequence, expected a map');
    expect(error.code).toBe('invalid_request'); expect(error.notSent).toBe(true);
  });
});
test('valid workspace response succeeds even when Herdr closes after its reply', async () => {
  await socketTest(request => ({ id: request.id, result: { type: 'workspace_created' } }), async client => {
    expect(await client.call('workspace.create', { env: {} })).toEqual({ type: 'workspace_created' });
  });
});
test('genuine lost replies identify the failed operation without claiming no side effect', async () => {
  await socketTest(() => undefined, async client => {
    const error = await client.call('workspace.create', {}).catch(error => error) as Error & { notSent?: boolean };
    expect(error.message).toContain('workspace.create'); expect(error.notSent).toBeUndefined();
  });
});
