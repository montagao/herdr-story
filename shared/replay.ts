import { isCashEvent, journalCategory, journalMoneyKind } from './billing';
import type { DemoSnapshot } from './demo';
import type { AgentInfo, MoneyEvent, OfficeEvent } from './types';
import type { JournalEntry, StudioState } from './studio';

export type ReplayMoment =
  | { id: string; at: number; kind: 'agent'; pane: string; agent: AgentInfo | null }
  | { id: string; at: number; kind: 'journal'; entry: JournalEntry }
  | { id: string; at: number; kind: 'studio'; studio: StudioState }
  | { id: string; at: number; kind: 'money'; event: MoneyEvent; entry?: JournalEntry }
  | { id: string; at: number; kind: 'event'; event: OfficeEvent };
export interface ReplayData {
  from: number; to: number; recordedSince: number | null;
  studioRecordedSince?: number | null;
  contextAgents?: AgentInfo[];
  snapshot: DemoSnapshot; moments: ReplayMoment[];
}
export const REPLAY_LIMIT = 10_000;
export function replayRange(from: unknown, to: unknown, now = Date.now()) {
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to)
    || from < 0 || from >= now || to <= from || to > now + 60_000 || to - from > 7 * 86400_000)
    throw new Error('Choose a past time range of up to seven days.');
  return { from, to: Math.min(to, now) };
}
export function momentDuration(moment: ReplayMoment) {
  if (moment.kind === 'studio') return 20;
  if (moment.kind === 'money') return isCashEvent(moment.event) ? 7000 : 3500;
  if (moment.kind === 'event') return 80;
  if (moment.kind === 'journal') return moment.entry.kind === 'sale' ? journalCategory(moment.entry) === 'sale' ? 7000 : 3500 : 8000;
  return moment.agent?.agent_status === 'blocked' || moment.agent?.wait_notice ? 1800 : 80;
}
export function replayMoney(entry: JournalEntry): MoneyEvent | undefined {
  if (entry.kind !== 'sale') return;
  return { id: `replay:${entry.id}`, ts: entry.at, source: entry.source === 'revenuecat' ? 'revenuecat' : 'stripe',
    kind: journalMoneyKind(entry)!,
    amount: entry.amount ?? 0, currency: entry.currency ?? 'usd', label: entry.title };
}
