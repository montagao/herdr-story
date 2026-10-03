import type { ReplayData } from '../shared/replay';
import type { AgentInfo } from '../shared/types';

/** Visual time-lapse is intentionally bounded: literal hours-per-second would flicker. */
export function replayAnimationRate(speed: number, fastForward: boolean, lowPower: boolean, reduced: boolean) {
  if (reduced) return 1;
  return Math.min(lowPower ? 3 : 8, speed * (fastForward ? 6 : 1));
}

/** Only observed work counts; unknown history and rate-limited agents are not invented work. */
export function recordedWorkRanges(data: ReplayData) {
  const agents = new Map<string, AgentInfo>();
  if (data.recordedSince !== null && data.from >= data.recordedSince)
    for (const a of data.snapshot.agents) agents.set(a.pane_id, a);
  const ranges: {from:number;to:number}[] = [];
  let at = data.from;
  const active = () => [...agents.values()].some(a => a.agent_status === 'working' && !a.wait_notice);
  const append = (to: number) => {
    if (to > at && active()) {
      const previous = ranges.at(-1);
      if (previous?.to === at) previous.to = to; else ranges.push({from:at,to});
    }
    at = to;
  };
  for (const m of data.moments) {
    if (m.kind !== 'agent') continue;
    append(m.at);
    if (m.agent) agents.set(m.pane,m.agent); else agents.delete(m.pane);
  }
  append(data.to);
  return ranges;
}
