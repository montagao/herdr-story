import type { AgentInfo } from './types';

export type CareerStat = 'program' | 'scenario' | 'graphics' | 'sound' | 'debug' | 'promo';
export const CAREER_STATS: CareerStat[] = ['program', 'scenario', 'graphics', 'sound', 'debug', 'promo'];
export const emptyCareer = (): Record<CareerStat, number> => ({ program: 0, scenario: 0, graphics: 0, sound: 0, debug: 0, promo: 0 });
export const BOARD_COLORS = ['#307c9b', '#39815b', '#b66a36', '#8763a6', '#b34e66', '#536b85'];

export interface Employee {
  id: string; version: number; name: string; bio: string; kind: string;
  face: number; body: number; favorite: boolean; createdAt: number;
  shipped: number; stats: Record<CareerStat, number>;
}
export interface Milestone {
  id: string; version: number; title: string; notes: string; done: boolean; completedAt?: number;
  contributors: string[]; checklist: { id: string; text: string; done: boolean }[];
  url: string; due: string;
}
export interface ProjectBoard {
  id: string; version: number; name: string; notes: string; color: string; goals: Milestone[];
}
export interface JournalEntry {
  id: string; version: number; at: number; kind: 'task' | 'milestone' | 'release' | 'note' | 'sale';
  title: string; notes: string; project: string; contributors: string[]; url: string;
  source: 'agent' | 'manual' | 'goal' | 'stripe' | 'revenuecat'; goalId?: string; stat?: CareerStat;
  /** Recorded for agent work: how long the task ran, and the model that did it. */
  minutes?: number; model?: string;
  /** Marked read entries appear in the journal archive. */
  readAt?: number;
  /** Recorded for money that moved: signed major units, and the provider's event id so a
   *  replayed poll cannot post the same sale twice. */
  amount?: number; currency?: string; moneyId?: string;
}
export interface RoomItem {
  id: string; kind: 'decor' | 'whiteboard' | 'cabinet' | 'trophy' | 'boss';
  asset?: string; project?: string; x: number; y: number;
}
export interface StudioRoom { version: number; items: RoomItem[] | null; projectOrder: string[] }
export interface StudioState {
  version: 1; revision: number; employees: Employee[]; projects: ProjectBoard[];
  journal: JournalEntry[]; room: StudioRoom;
  /** Present on compact network snapshots; omitted by full saved-state snapshots. */
  journalTotal?: number; journalCursor?: string | null;
  journalEpoch?: string; journalRetired?: string[]; journalInvalidated?: Record<string, number>;
  journalSummary?: { trophies: number; tasksByProject: Record<string, number>; achievementsByEmployee: Record<string, number> };

}
export interface JournalPageQuery {
  moneySummary?: boolean;
  cursor?: string | null; limit?: number; project?: string; kind?: string; ids?: string[];
  search?: string; since?: number; trophies?: boolean; read?: boolean;
}
export interface JournalPage { money?: import('./recap-money').RecapMoney; entries: JournalEntry[]; cursor: string | null; total: number; revision: number; epoch: string }
export interface Completion { employeeId: string; total: number; stat: CareerStat; entryId: string }

/** Full paths keep two repositories with the same folder name on different boards. */
export function projectKey(a: Pick<AgentInfo, 'foreground_cwd' | 'cwd' | 'workspace_id'>): string {
  return (a.foreground_cwd || a.cwd || '').replace(/\/+$/, '') || `workspace:${a.workspace_id || 'misc'}`;
}
export function projectName(id: string): string { return id.split('/').pop()?.replace(/^workspace:/, '') || 'Studio'; }
export function employeeName(a: AgentInfo): string {
  return a.office_name?.trim() || a.name?.trim() || (a.display_agent || a.agent || 'Agent').replace(/^./, c => c.toUpperCase());
}
export function safeArtifactUrl(value: string): string {
  if (!value.trim()) return '';
  try { const url = new URL(value.trim()); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
export function goalProgress(goal: Milestone) {
  return goal.done ? 100 : goal.checklist.length ? Math.round(goal.checklist.filter(item => item.done).length / goal.checklist.length * 100) : 0;
}
