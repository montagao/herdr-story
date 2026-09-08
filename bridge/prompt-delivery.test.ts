import { expect, test } from 'bun:test';
import { deliverPrompt, unsentInput } from './prompt-delivery';
import { MessageReceipts } from './message-receipts';

const noSleep = { sleep: async () => {} };
const rule = '─'.repeat(20);
const screenWith = (box: string, above = '') => `${above}\n${rule}\n❯ ${box}\n${rule}\n  ⏵⏵ bypass permissions on`;

test('Claude image paste with swallowed Enter stays unconfirmed and cannot be replayed', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const text = 'Inspect this screenshot\n\nAttached image file:\n- /tmp/screenshot.png';
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'agent.get') return { agent: { agent_status: 'idle', state_change_seq: 4 } };
    if (method === 'agent.read') return { read: { text: screenWith('Inspect this screenshot') } };   // still in the box
    throw Object.assign(new Error('timed out waiting for agent status'), { code: 'timeout' });
  };
  const receipts = new MessageReceipts();
  const send = () => receipts.run('claude', 'image-message', { text }, () => deliverPrompt(call, 'claude', 'pane-1', text, noSleep));
  await expect(send()).rejects.toThrow('input box');
  expect(await receipts.status('claude', 'image-message')).toEqual({ state: 'pending' });
  await expect(send()).rejects.toThrow();
  const prompts = calls.filter(c => c.method === 'agent.prompt');
  expect(prompts).toHaveLength(1);
  expect(prompts[0].params.wait).toEqual({ until: ['working', 'idle', 'done', 'blocked'], timeout_ms: 6000 });
});

test('observed Claude submission confirms delivery', async () => {
  const receipts = new MessageReceipts();
  const result = { type: 'agent_prompted', agent: { agent_status: 'working' } };
  const call = async (method: string) => method === 'agent.get' ? { agent: { agent_status: 'idle' } } : result;
  await receipts.run('claude', 'confirmed-message', {}, () => deliverPrompt(call, 'claude', 'pane-1', 'Hello', noSleep));
  expect(await receipts.status('claude', 'confirmed-message')).toEqual({ state: 'confirmed', result });
});

test('a desk that is still starting is not typed into until it reports ready', async () => {
  let polls = 0;
  const calls: string[] = [];
  const call = async (method: string) => {
    calls.push(method);
    if (method === 'agent.get') return { agent: { agent_status: ++polls < 4 ? 'unknown' : 'idle', interactive_ready: polls >= 4, launch_pending: polls < 4 } };
    return { type: 'agent_prompted', agent: { agent_status: 'working' } };
  };
  await deliverPrompt(call, 'claude', 'pane-1', 'First task', noSleep);
  expect(calls.filter(m => m === 'agent.get').length).toBe(4);
  expect(calls.indexOf('agent.prompt')).toBeGreaterThan(calls.lastIndexOf('agent.get'));
});

test('a slow first turn is confirmed by the status change herdr missed', async () => {
  let reads = 0;
  const call = async (method: string) => {
    if (method === 'agent.get') return { agent: { agent_status: reads++ < 2 ? 'idle' : 'working', state_change_seq: reads < 3 ? 1 : 2 } };
    if (method === 'agent.read') return { read: { text: screenWith('') } };
    throw Object.assign(new Error('stalled'), { code: 'agent_prompt_stalled' });
  };
  const result = await deliverPrompt(call, 'claude', 'pane-1', 'Refactor the auth middleware', noSleep) as { verified?: string };
  expect(result.verified).toBe('status');
});

test('an emptied input box with the message echoed above counts as submitted', async () => {
  const call = async (method: string) => {
    if (method === 'agent.get') return { agent: { agent_status: 'idle', state_change_seq: 1 } };
    if (method === 'agent.read') return { read: { text: screenWith('', '❯ Refactor the auth middleware\n\n✻ Thinking…') } };
    throw Object.assign(new Error('stalled'), { code: 'agent_prompt_stalled' });
  };
  const result = await deliverPrompt(call, 'claude', 'pane-1', 'Refactor the auth middleware', noSleep) as { verified?: string };
  expect(result.verified).toBe('screen');
});

test('nothing observed within the verify window stays unconfirmed', async () => {
  const call = async (method: string) => {
    if (method === 'agent.get') return { agent: { agent_status: 'idle', state_change_seq: 1 } };
    if (method === 'agent.read') return { read: { text: screenWith('') } };
    throw Object.assign(new Error('stalled'), { code: 'agent_prompt_stalled' });
  };
  await expect(deliverPrompt(call, 'claude', 'pane-1', 'Hello there', { ...noSleep, verifyMs: 1400 })).rejects.toMatchObject({ code: 'uncertain' });
});

test('other providers keep their existing submission protocol', async () => {
  const methods: string[] = [];
  await deliverPrompt(async (method, params) => {
    methods.push(method);
    if (method === 'agent.get') return { agent: { agent_status: 'idle' } };
    expect(method).toBe('agent.prompt');
    expect(params).toEqual({ target: 'pane-1', text: 'Hello' });
  }, 'codex', 'pane-1', 'Hello', noSleep);
  expect(methods).toEqual(['agent.get', 'agent.prompt']);
});

test('the input box is the ❯ line between the last two rules', () => {
  expect(unsentInput(screenWith('half typed message'))).toBe('half typed message');
  expect(unsentInput(screenWith(''))).toBe('');
  expect(unsentInput('no rules here')).toBeUndefined();
});
