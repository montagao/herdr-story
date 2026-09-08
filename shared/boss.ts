import type { AgentInfo } from './types';

export interface BossIdea { title: string; evidence: string; why: string; nextStep: string }
export interface BossBriefing { projectId?: string; projectName?: string; id: string; at: number; intro: string; ideas: BossIdea[] }
export interface BossBriefingStatus {
  state: 'ready' | 'thinking' | 'attention' | 'empty';
  message: string; briefing?: BossBriefing; agent?: AgentInfo; nextReviewAt?: number;
}
export interface BossArchivePage { briefings: BossBriefing[]; cursor: string | null; total: number; nextReviewAt?: number }
