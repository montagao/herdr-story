import type { AgentInfo, ServerMsg, WorkspaceSummary } from '../shared/types';
import type { StudioState } from '../shared/studio';

function diff<T>(before: T[], after: T[], key: (item: T) => string) {
  const old = new Map(before.map(item => [key(item), JSON.stringify(item)]));
  const upsert = after.filter(item => old.get(key(item)) !== JSON.stringify(item));
  const ids = new Set(after.map(key));
  return { upsert, remove: before.map(key).filter(id => !ids.has(id)) };
}
export function agentDelta(before: AgentInfo[], after: AgentInfo[], previousWorkspaces: WorkspaceSummary[], workspaces: WorkspaceSummary[]): Extract<ServerMsg, { type: 'agents.patch' }> | undefined {
  const delta = diff(before, after, a => a.pane_id);
  const changed = JSON.stringify(previousWorkspaces) !== JSON.stringify(workspaces);
  return delta.upsert.length || delta.remove.length || changed
    ? { type: 'agents.patch', ...delta, ...(changed ? { workspaces } : {}) } : undefined;
}
export function studioDelta(before: StudioState, after: StudioState): Extract<ServerMsg, { type: 'studio.patch' }> | undefined {
  if (before.revision === after.revision) return undefined;
  const { version, revision, employees, projects, journal, room, ...metadata } = after;
  return { type: 'studio.patch', baseRevision: before.revision, revision,
    employees: diff(before.employees, employees, e => e.id), projects: diff(before.projects, projects, p => p.id),
    journal: diff(before.journal, journal, e => e.id),
    ...(JSON.stringify(before.room) !== JSON.stringify(room) ? { room } : {}), metadata };
}
