import { isCashEvent, journalCategory } from '../shared/billing';
import type { ReplayData, ReplayMoment } from '../shared/replay';

export type ReplayWatch = 'all' | 'highlights' | 'payments';
export const isHighlight = (m: ReplayMoment) => m.kind === 'journal' || m.kind === 'money';
export const isPayment = (m: ReplayMoment) => (m.kind === 'money' && isCashEvent(m.event)) || (m.kind === 'journal' && journalCategory(m.entry) === 'sale');

/** Project membership follows the recorded pane, never guessed from a payment description. */
export function projectReplay(data: ReplayData, project: string): ReplayData {
  if (project === '*') return data;
  const panes = new Map([...(data.contextAgents ?? []), ...data.snapshot.agents].map(a => [a.pane_id, a.cwd ?? '']));
  const moments = data.moments.filter(m => {
    if (m.kind === 'studio') return true;
    if (m.kind === 'agent') {
      const previous = panes.get(m.pane);
      if (m.agent) panes.set(m.pane, m.agent.cwd ?? ''); else panes.delete(m.pane);
      // A pane leaving this project must also disappear from its replay.
      return (m.agent?.cwd ?? '') === project || previous === project;
    }
    if (m.kind === 'event') return panes.get(m.event.pane_id) === project;
    return (m.entry?.project ?? '') === project;
  }).map(m => m.kind === 'agent' && m.agent && (m.agent.cwd ?? '') !== project ? { ...m, agent: null } : m);
  return { ...data, moments, contextAgents: data.contextAgents?.filter(a => (a.cwd ?? '') === project),
    snapshot: { ...data.snapshot, agents: data.snapshot.agents.filter(a => (a.cwd ?? '') === project) } };
}

export function replayHighlights(data: ReplayData, watch: ReplayWatch) {
  const all = data.moments.filter(isHighlight);
  if (watch === 'payments') return all.filter(isPayment);
  if (watch === 'all' || all.length <= 12) return all;
  // Cover the entire day, preferring money, launches and milestones within each chapter.
  const bins = new Map<number, ReplayMoment>();
  const rank = (m: ReplayMoment) => isPayment(m) ? 3 : m.kind === 'journal' && ['release', 'milestone'].includes(m.entry.kind) ? 4 : 1;
  for (const m of all) {
    const bin = Math.min(11, Math.floor(12 * (m.at - data.from) / (data.to - data.from)));
    const previous = bins.get(bin);
    if (!previous || rank(m) > rank(previous)) bins.set(bin, m);
  }
  return [...bins.values()];
}

/** Reference estimates, not historical settlement FX. Missing rates stay explicit. */
export function replayUSD(currencies: Record<string, number>, rates: Record<string, number>) {
  let amount = 0, estimated = false;
  const missing: string[] = [];
  for (const [currency, value] of Object.entries(currencies)) {
    if (currency.toUpperCase() === 'USD' || value === 0) { amount += value; continue; }
    const rate = rates[currency.toLowerCase()];
    if (!Number.isFinite(rate) || rate <= 0) { missing.push(currency); continue; }
    amount += value / rate; estimated = true;
  }
  return { amount: Math.round(amount * 100) / 100, estimated, missing };
}
