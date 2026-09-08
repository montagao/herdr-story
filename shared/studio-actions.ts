import type { StudioState } from './studio';
import type { ServerMsg } from './types';

export type StudioPatch = Extract<ServerMsg, { type: 'studio.patch' }>;
export type StudioAck = { type: 'studio.ack'; revision: number; patch?: StudioPatch; studio?: StudioState };
export function applyStudioPatch(state: StudioState, patch: StudioPatch): StudioState {
  if (state.revision !== patch.baseRevision) throw new Error('Studio update needs a fresh snapshot.');
  const rows = <T extends { id: string }>(items: T[], delta?: { upsert: T[]; remove: string[] }) => {
    if (!delta || (!delta.upsert.length && !delta.remove.length)) return items;
    const next = new Map(items.map(item => [item.id, item]));
    delta.remove.forEach(id => next.delete(id)); delta.upsert.forEach(item => next.set(item.id, item));
    return [...next.values()];
  };
  const journal = rows(state.journal, patch.journal);
  return { ...state, ...patch.metadata, revision: patch.revision,
    employees: rows(state.employees, patch.employees), projects: rows(state.projects, patch.projects),
    journal: journal === state.journal ? journal : journal.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)), room: patch.room ?? state.room };
}

/** Related edits share an ordering lane; unrelated objects can save independently. */
export function studioLane(params: Record<string, unknown>) {
  const op = String(params.op);
  if (op.startsWith('goal.') || op === 'project.save') return `project:${params.project ?? params.id}`;
  if (op.startsWith('entry.')) return `entry:${params.id ?? 'new'}`;
  if (op.startsWith('employee.')) return `employee:${params.id ?? params.pane}`;
  return op.startsWith('room.') ? 'room' : op;
}
export function actionPayload(params: Record<string, unknown>) {
  const { action_id, response, base_revision, ...payload } = params;
  return payload;
}
export function canonicalAction(params: Record<string, unknown>) {
  return JSON.stringify(actionPayload(params), (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
