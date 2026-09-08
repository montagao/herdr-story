// Seed only the isolated smoke test's activity database; the real bridge has no test-time override.
import { SweepService } from '../bridge/sweep';
import type { AgentInfo } from '../shared/types';
const directory = process.argv[2];
if (!directory?.startsWith('/tmp/herdr-sweep-browser-')) throw new Error('Use an isolated smoke-test directory.');
const agents: AgentInfo[] = [
  { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'codex', agent_status: 'idle', cwd: '/home/me/projects/proj1', state_change_seq: 0, agent_session: { kind: 'id', value: 'mock-codex-1' } },
  { pane_id: 'w3:p1', workspace_id: 'w3', agent: 'claude', agent_status: 'idle', cwd: '/home/me/projects/proj2', state_change_seq: 0 },
];
const service = new SweepService({ now: () => Date.now() - 5 * 3_600_000,
  snapshot: async () => ({ agents, workspaces: [] }), lastActivity: async () => undefined, transcript: async () => undefined,
  read: async () => '', save: async () => '', call: async () => undefined, queued: () => false,
}, directory);
await service.observe(agents); service.dispose();
