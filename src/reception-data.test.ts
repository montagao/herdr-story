import { expect, test } from 'bun:test';
import type { AgentInfo } from '../shared/types';
import { attentionAgents, findReceptionAgents, receptionProjects, taskAgents, visitStart } from './reception-data';

const agent = (pane_id: string, agent_status: AgentInfo['agent_status'], extra: Partial<AgentInfo> = {}): AgentInfo => ({ pane_id, agent_status, agent: 'claude', cwd: '/studio/nebula', ...extra });
test('the bell counts requests for input, not working agents retrying automatically', () => {
  const waiting = agent('waiting', 'blocked', { name: 'Waiting for approval' });
  expect(attentionAgents([agent('rate', 'working', { wait_notice: { kind: 'rate_limit', detail: 'Retrying shortly' } }), agent('idle', 'idle'), agent('done', 'done'), waiting])).toEqual([waiting]);
});
test('task candidates stay in the chosen project and exclude Boss and empty terminals', () => {
  const agents = [agent('busy', 'working'), agent('idle', 'idle'), agent('done', 'done'), agent('boss', 'idle', { office_role: 'boss' }), agent('shell', 'idle', { agent: null }), agent('elsewhere', 'idle', { foreground_cwd: '/other' })];
  expect(taskAgents(agents, '/studio/nebula').map(a => a.pane_id)).toEqual(['idle', 'done', 'busy']);
  expect(taskAgents(agents, '/other').map(a => a.pane_id)).toEqual(['elsewhere']);
  expect(receptionProjects(undefined, agents).map(p => p.id)).toEqual(['/studio/nebula', '/other']);
});
test('agent search includes project paths, task text, and workspace names', () => {
  const a = agent('p1', 'working', { office_name: 'Ada', workspace_name: 'Launch team', last_prompt: 'Fix image previews' });
  for (const q of ['ADA', 'launch', 'nebula', 'image previews']) expect(findReceptionAgents([a], q)).toEqual([a]);
  expect(findReceptionAgents([a], 'missing')).toEqual([]);
});
test('recaps use the previous visit, with an explicit first-visit day and safe date fallbacks', () => {
  const now = 1_000_000_000;
  expect(visitStart(String(now - 5000), now)).toEqual({ since: now - 5000, firstVisit: false });
  for (const value of [null, '', 'bad', '-1', String(now + 1)]) expect(visitStart(value, now)).toEqual({ since: now - 864e5, firstVisit: true });
});
