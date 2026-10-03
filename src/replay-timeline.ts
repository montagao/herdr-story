import type { ReplayData, ReplayMoment } from '../shared/replay';
import { momentDuration, replayMoney } from '../shared/replay';
import { recordedWorkRanges } from './replay-motion';
import { isHighlight } from './replay-selection';
import type { DemoSnapshot } from '../shared/demo';

export interface ReplaySegment { start: number; end: number; from: number; to: number; moment?: ReplayMoment; activeWork?: boolean }
/** Wall-clock segments compress gaps, while each event gets a readable hold. */
export class ReplayTimeline {
  readonly segments: ReplaySegment[] = [];
  readonly duration: number;
  private readonly starts = new Map<string, number>();
  constructor(readonly data: ReplayData, selected: ReplayMoment[] = data.moments.filter(isHighlight), short = false) {
    let wall = 0, at = data.from;
    const work = recordedWorkRanges(data);
    const gap = (to: number) => {
      if (to <= at) return;
      const activeWork = work.some(range => range.from < to && range.to > at);
      const span = activeWork ? Math.min(short ? 1800 : 4500, Math.max(800, (to - at) / 60))
        : Math.min(1200, Math.max(0, (to - at) / (short ? 1200 : 300)));
      this.segments.push({ start: wall, end: wall + span, from: at, to, activeWork }); wall += span;
    };
    for (const moment of selected) {
      gap(moment.at);
      const span = momentDuration(moment);
      this.starts.set(moment.id, wall);
      this.segments.push({ start: wall, end: wall + span, from: moment.at, to: moment.at, moment });
      wall += span; at = moment.at;
    }
    gap(data.to);
    this.duration = wall;
  }
  position(wall: number) {
    // Binary search keeps scrubbing responsive even in busy seven-day replays.
    let lo = 0, hi = this.segments.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.segments[mid].end <= wall) lo = mid + 1; else hi = mid; }
    const segment = this.segments[lo];
    const at = segment ? segment.from + (segment.to - segment.from) * Math.max(0, (wall - segment.start) / (segment.end - segment.start)) : this.data.to;
    let left = 0, right = this.data.moments.length;
    while (left < right) { const mid = (left + right) >>> 1; if (this.data.moments[mid].at <= at) left = mid + 1; else right = mid; }
    return { at, segment, index: lo, stateIndex: left };

  }
  wallFor(id: string) { return this.starts.get(id); }
  wallAt(at: number) {
    const segment = this.segments.find(s => s.moment ? s.from >= at : s.to > at);
    if (!segment) return this.duration;
    return segment.start + (segment.to === segment.from ? 0 : Math.max(0, (at - segment.from) / (segment.to - segment.from)) * (segment.end - segment.start));
  }
  /** Side-effect free: seeking never emits notifications or repeats payment actions. */
  snapshotAt(at: number): DemoSnapshot {
    const snapshot = structuredClone(this.data.snapshot);
    let recorded = this.data.recordedSince !== null && this.data.from >= this.data.recordedSince;
    const context = recorded ? snapshot.agents : (this.data.contextAgents ?? snapshot.agents).map(agent => ({ ...agent, agent_status: 'unknown' as const, title: '', wait_notice: null }));
    const agents = new Map(context.map(agent => [agent.pane_id, structuredClone(agent)]));
    for (const moment of this.data.moments) {
      if (moment.at > at) break;
      if (moment.kind === 'studio') {
        const journal = snapshot.studio.journal;
        snapshot.studio = structuredClone(moment.studio); snapshot.studio.journal = journal;
      } else if (moment.kind === 'event') {
        snapshot.events.push(structuredClone(moment.event));
      } else if (moment.kind === 'agent') {
        if (!recorded) { agents.clear(); recorded = true; }
        if (moment.agent) agents.set(moment.pane, structuredClone(moment.agent)); else agents.delete(moment.pane);
      } else {
        const entry = moment.entry;
        if (entry) snapshot.studio.journal.push(structuredClone(entry));
        const money = moment.kind === 'money' ? moment.event : replayMoney(moment.entry);
        if (money) snapshot.money.push(structuredClone(money));
        if (entry?.kind === 'task' && !recorded) {
          for (const id of entry.contributors) {
            const employee = snapshot.studio.employees.find(e => e.id === id);
            if (!employee) continue;
            const previous = [...agents.values()].find(a => a.employee_id === id && a.cwd === entry.project)
              ?? [...agents.values()].find(a => a.employee_id === id);
            const pane = previous?.pane_id ?? `replay:${id}`;
            agents.set(pane, { ...previous, pane_id: pane, employee_id: id, agent: employee.kind,
              office_name: employee.name, office_look: { body: employee.body, face: employee.face },
              agent_status: 'done', cwd: entry.project, title: entry.title });
          }
        }
      }
    }
    snapshot.agents = [...agents.values()]; snapshot.capturedAt = at;
    snapshot.studio.journalTotal = snapshot.studio.journal.length;
    snapshot.studio.revision = snapshot.studio.journal.length;
    return snapshot;
  }
}

/** Only settled cash changes contribute; failed invoices and trials are not earnings. */
export function replayTotals(data: ReplayData, at: number, pending = new Set<string>()) {
  const currencies: Record<string, number> = {};
  let tasks = 0, releases = 0, milestones = 0, payments = 0;
  const seen = new Set<string>();
  for (const moment of data.moments) {
    if (moment.at > at) break;
    if (pending.has(moment.id)) continue;
    if (moment.kind !== 'money' && moment.kind !== 'journal') continue;
    const entry = moment.entry;
    if (entry?.kind === 'task') tasks++;
    if (entry?.kind === 'release') releases++;
    if (entry?.kind === 'milestone') milestones++;
    const money = moment.kind === 'money' ? moment.event : replayMoney(moment.entry);
    if (!money) continue;
    const id = entry?.moneyId ?? money.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const incoming = ['sale', 'subscribed', 'subscription_started'].includes(money.kind);
    const outgoing = ['refund', 'dispute'].includes(money.kind);
    if ((!incoming && !outgoing) || !Number.isFinite(money.amount) || !money.amount) continue;
    const currency = money.currency.toUpperCase();
    currencies[currency] = (currencies[currency] ?? 0) + (outgoing ? -Math.abs(money.amount) : money.amount);
    if (incoming && money.amount > 0) payments++;
  }
  return { currencies, tasks, releases, milestones, payments };
}
