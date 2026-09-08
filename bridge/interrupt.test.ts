import { expect, test } from 'bun:test';
import { interruptAgent } from './interrupt';
const agent = { pane_id: 'w1:p1', agent: 'codex', agent_status: 'working', last_prompt: 'Fix the bug', agent_session: { kind: 'id', value: 'same' } };
test('stop sends one Escape, preserves prompt, and waits for a non-working state', async () => {
  let reads = 0; const keys: unknown[] = [];
  const result = await interruptAgent(async (method, params) => {
    if (method === 'agent.list') return { agents: [{ ...agent, agent_status: ++reads > 2 ? 'idle' : 'working' }] };
    keys.push(params.keys);
  }, agent.pane_id, async () => {}, async () => {});
  expect(keys).toEqual([['Escape']]); expect(result).toEqual({ stopped: true, prompt: 'Fix the bug', status: 'idle' });
});
test('idle or unsupported agents never receive a key', async () => {
  for (const changed of [{ agent_status: 'idle' }, { agent: 'gemini' }]) {
    const calls: string[] = [];
    await expect(interruptAgent(async method => { calls.push(method); return { agents: [{ ...agent, ...changed }] }; }, agent.pane_id)).rejects.toThrow();
    expect(calls).toEqual(['agent.list']);
  }
});
test('unconfirmed stop does not resend Escape or report success', async () => {
  let keys = 0;
  await expect(interruptAgent(async method => {
    if (method === 'agent.list') return { agents: [agent] };
    keys++;
  }, agent.pane_id, async () => {}, async () => {})).rejects.toThrow('has not stopped');
  expect(keys).toBe(1);
});
test('queued work must be held successfully before interrupting', async () => {
  let keys = 0;
  await expect(interruptAgent(async method => {
    if (method === 'agent.list') return { agents: [agent] };
    keys++;
  }, agent.pane_id, async () => { throw Error('cannot save queue'); })).rejects.toThrow('cannot save queue');
  expect(keys).toBe(0);
});
