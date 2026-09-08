import type { AgentInfo, MoneyEvent, OfficeEvent, WorkspaceSummary } from './types';
import type { StudioState } from './studio';
import type { RevenueRange } from './revenue-range';

/** One revenue answer, as `/api/revenue` returns it. Mirrors the HUD's Revenue shape. */
export interface DemoRevenue {
  source: 'stripe' | 'revenuecat' | 'both' | 'none'; amount?: number; currency?: string;
  calendarRanges?: boolean; rangeSelectable?: boolean; label?: string; note?: string; days?: number; error?: string;
  parts?: { source: string; amount: number; currency: string; note?: string }[];
}

/**
 * Everything the office needs to run without a bridge: a curated copy of a real studio, the desks
 * as they were, the books, and what each agent's terminal showed. Produced by `bridge/demo-export.ts`
 * and served from `/demo/office.json`.
 */
export interface DemoSnapshot {
  version: 1;
  capturedAt: number;
  /** Office theme id at capture time. */
  theme: string;
  agents: AgentInfo[];
  workspaces: WorkspaceSummary[];
  events: OfficeEvent[];
  money: MoneyEvent[];
  studio: StudioState;
  revenue: Partial<Record<RevenueRange, DemoRevenue>>;
  /** Pane id → the terminal text shown when that desk is opened. */
  transcripts: Record<string, string>;
}
