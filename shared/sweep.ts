import type { AgentInfo } from './types';

export const SWEEP_INTERVALS = [{ minutes: 15, label: '15 min' }, { minutes: 60, label: '1 hour' }, { minutes: 240, label: '4 hours' }, { minutes: 1440, label: '1 day' }];
export interface SweepAgent {
  agent: AgentInfo; lastActiveAt: number; eligible: boolean; reason?: string;
}
export interface SweepWorkspace {
  id: string; name: string; agents: SweepAgent[]; otherPanes: number; activeAgents: number;
}
export interface SweepScan { at: number; minutes: number; workspaces: SweepWorkspace[]; protectedCount: number }
export interface SweepRecap {
  paneId: string; name: string; workspace: string; project: string; status: string;
  prompt: string; findings: string; artifacts: string[]; session: string; notes: string;
  source: 'transcript' | 'terminal' | 'unavailable';
}
export interface SweepReview {
  token: string; expiresAt: number; recaps: SweepRecap[]; closeWorkspaces: { id: string; name: string }[];
}
export interface SweepResult {
  saved: { paneId: string; entryId: string }[]; closed: string[]; closedWorkspaces: string[];
  kept: { paneId: string; reason: string }[];
}
