import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentLaunchName, validAgentName } from './agent-name';
import { StudioStore } from './studio';
import type { AgentInfo } from '../shared/types';

test('friendly launch labels satisfy Herdr naming rules', () => {
  expect(agentLaunchName('Free agent')).toBe('free-agent');
  expect(agentLaunchName('Free agent 2')).toBe('free-agent-2');
  expect(agentLaunchName('Boss')).toBe('boss');
  expect(agentLaunchName('Settings test')).toBe('settings-test');
  expect(agentLaunchName('9 Build.v2')).toBe('agent-9-build-v2');
  for (const name of ['a', 'abc_def', 'A'.repeat(40), '9', '...']) expect(validAgentName(agentLaunchName(name))).toBe(true);
  for (const name of ['Free agent', 'Boss', 'agent.v2', '9agent', 'a'.repeat(33), '']) expect(validAgentName(name)).toBe(false);
});

test('normalized and truncated names cannot collide with live or reserved names', () => {
  expect(agentLaunchName('Free agent', ['free-agent', 'free-agent-2'])).toBe('free-agent-3');
  expect(agentLaunchName('Build.v2', ['build-v2'])).toBe('build-v2-2');
  const names = new Set<string>();
  for (let i = 0; i < 15; i++) {
    const name = agentLaunchName('A'.repeat(40), names);
    expect(validAgentName(name)).toBe(true); expect(names.has(name)).toBe(false); names.add(name);
  }
});

test('office display names survive a restart and late session metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-agent-name-'));
  const agent = { pane_id: 'w1:p1', agent: 'codex', name: 'free-agent', cwd: '/projects', agent_status: 'idle' } as AgentInfo;
  const store = new StudioStore(dir, { asyncWrite: true });
  try {
    await store.run(() => store.nameHiredAgent(agent, 'Free agent'));
    const withSession = { ...agent, agent_session: { kind: 'id', value: 'test-session' } };
    await store.run(() => store.observe([withSession]));
    await store.close();
    const restored = new StudioStore(dir);
    try {
      expect(restored.decorate(withSession).name).toBe('free-agent');
      expect(restored.decorate(withSession).office_name).toBe('Free agent');
      expect(restored.snapshot().employees).toHaveLength(1);
    } finally { await restored.close(); }
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
