import { test, expect } from 'bun:test';
import { agentDelta, studioDelta } from './deltas';
import { StudioStore } from './studio';
import type { AgentInfo } from '../shared/types';
test('agent deltas omit unchanged rows and include departures and workspace changes', () => {
  const a = { pane_id: 'w1:p1', agent_status: 'idle' } as AgentInfo;
  expect(agentDelta([a], [{ ...a }], [], [])).toBeUndefined();
  const b = { ...a, agent_status: 'working' } as AgentInfo;
  expect(agentDelta([a], [b], [], [])).toMatchObject({ upsert: [b], remove: [] });
  expect(agentDelta([a], [], [], [])).toMatchObject({ upsert: [], remove: [a.pane_id] });
});
test('studio patch carries its exact base revision and bounded journal metadata', () => {
  const store = new StudioStore(), before = store.snapshot(100);
  store.observe([{ pane_id: 'w1:p1', agent: 'codex', agent_status: 'idle', cwd: '/projects/x' } as AgentInfo]);
  const after = store.snapshot(100), delta = studioDelta(before, after)!;
  expect(delta.baseRevision).toBe(before.revision);
  expect(delta.revision).toBe(after.revision);
  expect(delta.employees?.upsert).toHaveLength(1);
  expect(delta.metadata?.journalTotal).toBe(0);
  expect(studioDelta(after, after)).toBeUndefined();
});
