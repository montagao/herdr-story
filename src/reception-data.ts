import type { AgentInfo } from '../shared/types';
import { employeeName, projectKey, projectName, type ProjectBoard, type StudioState } from '../shared/studio';
import { taskOf } from '../shared/types';

export const attentionAgents = (agents: AgentInfo[]) => agents.filter(a => a.agent_status === 'blocked')
  .sort((a, b) => employeeName(a).localeCompare(employeeName(b)));
export function taskAgents(agents: AgentInfo[], project: string) {
  const order = { idle: 0, done: 1, working: 2, blocked: 3, unknown: 4 };
  return agents.filter(a => a.office_role !== 'boss' && !!a.agent && projectKey(a) === project)
    .sort((a, b) => order[a.agent_status] - order[b.agent_status] || employeeName(a).localeCompare(employeeName(b)));
}
export function receptionProjects(state: StudioState | undefined, agents: AgentInfo[]) {
  const projects = new Map<string, Pick<ProjectBoard, 'id' | 'name' | 'notes'>>((state?.projects ?? []).map(p => [p.id, p]));
  for (const a of agents) if (a.office_role !== 'boss' && !projects.has(projectKey(a))) {
    const id = projectKey(a); projects.set(id, { id, name: projectName(id), notes: '' });
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function matchesReception(query: string, ...values: (string | null | undefined)[]) {
  return values.filter(Boolean).join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
export const findReceptionAgents = (agents: AgentInfo[], query: string) => agents.filter(a => matchesReception(query,
  employeeName(a), a.agent, a.workspace_name, projectKey(a), taskOf(a), a.last_prompt, a.activity));
export function visitStart(value: string | null, now = Date.now()) {
  const at = Number(value);
  return { since: Number.isFinite(at) && at > 0 && at <= now ? at : now - 864e5,
    firstVisit: !(Number.isFinite(at) && at > 0 && at <= now) };
}
