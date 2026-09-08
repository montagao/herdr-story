import type { AgentInfo, OfficeEvent } from '../../shared/types';
import { WORK_KINDS, workKindForTitle, type WorkKind } from '../work';
import { projectKey, type StudioState } from '../../shared/studio';

/** One project's desk cluster. `seats` is a multiple of POD_SIZE: the bank grows in fours. */
export interface Pod { project: string; seats: (string | null)[] }
export const POD_SIZE = 4;

export function projectOf(a: AgentInfo): string {
  return projectKey(a);
}

/** How many four-desk banks a cluster is made of. */
export const pairsOf = (pod: Pod) => Math.max(1, Math.ceil(pod.seats.length / POD_SIZE));

/** Grid cells a cluster occupies. A bank runs up the (36,-18) diagonal, which is 0.5625 of a
 *  grid row per extra bank, so a cluster reaches into the cells above its own. */
export const cellsFor = (pairs: number) => 1 + Math.ceil(0.5625 * (pairs - 1));

export interface Placement { pod: Pod; col: number; row: number }

/** Shipped counts live in localStorage so a level outlasts a reload or a bridge restart. Keyed by
 *  pane id, which is the only identity herdr gives an agent; a pane reused by a new agent later
 *  inherits the count, which is the honest limit of what we can know. */
const KEY = 'herdr-story:shipped';
const STATS_KEY = 'herdr-story:stats';
function load(): [string, number][] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function save(m: Map<string, number>) { try { localStorage.setItem(KEY, JSON.stringify([...m])); } catch { /* private mode */ } }

export type AgentStats = Record<WorkKind, number>;
export interface AgentProgress {
  level: number;
  rank: string;
  shipped: number;
  inLevel: number;
  toNext: number;
  stats: AgentStats;
  specialty: WorkKind;
}
const emptyStats = (): AgentStats => ({ program: 0, scenario: 0, graphics: 0, sound: 0, debug: 0, promo: 0 });
function loadStats(): [string, AgentStats][] {
  try {
    const saved = JSON.parse(localStorage.getItem(STATS_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((row) => Array.isArray(row) && typeof row[0] === 'string').map(([id, raw]) => {
      const stats = emptyStats();
      for (const kind of WORK_KINDS) stats[kind] = Math.max(0, Number(raw?.[kind]) || 0);
      return [id, stats];
    });
  } catch { return []; }
}
function saveStats(m: Map<string, AgentStats>) { try { localStorage.setItem(STATS_KEY, JSON.stringify([...m])); } catch { /* private mode */ } }

const RANKS = ['Rookie', 'Junior', 'Regular', 'Senior', 'Lead', 'Principal', 'Legend'];
export function rankForLevel(level: number) { return RANKS[Math.min(RANKS.length - 1, Math.floor((level - 1) / 3))]; }
export function tierForLevel(level: number) { return rankForLevel(level).toLowerCase(); }

/** Flat office of per-project desk clusters. Seats are sticky: an agent keeps its desk. */
export class OfficeModel {
  studio?: StudioState;
  setStudio(state: StudioState) { this.studio = state; this.emit('agents'); }
  private employeeOf(paneId: string) { return this.studio?.employees.find(e => e.id === this.agents.get(paneId)?.employee_id); }
  get totalShipped() { return this.studio ? this.studio.employees.reduce((n, e) => n + e.shipped, 0) : [...this.shipped.values()].reduce((n, count) => n + count, 0); }
  agents = new Map<string, AgentInfo>();
  pods: Pod[] = [];
  /** Agents kept in their seats just long enough for the office to animate them clocking out. */
  private departing = new Map<string, string>();
  private departed = new Set<string>();
  /** Tasks finished per pane in this browser. Nothing here is invented: a 'done' event,
   *  or a return to idle after more than a minute of work, is one shipped task. */
  shipped = new Map<string, number>(load());
  /** A point goes to the same real work category used by the in-office task balloon. */
  stats = new Map<string, AgentStats>(loadStats());
  static readonly PER_LEVEL = 3;
  levelOf(paneId: string) { return 1 + Math.floor((this.employeeOf(paneId)?.shipped ?? this.shipped.get(paneId) ?? 0) / OfficeModel.PER_LEVEL); }
  progressOf(paneId: string): AgentProgress {
    const employee = this.employeeOf(paneId);
    const shipped = employee?.shipped ?? this.shipped.get(paneId) ?? 0;
    const stats = employee?.stats ?? this.stats.get(paneId) ?? emptyStats();
    const specialty = WORK_KINDS.reduce((best, kind) => stats[kind] > stats[best] ? kind : best, 'program' as WorkKind);
    const level = this.levelOf(paneId);
    return { level, rank: rankForLevel(level), shipped, inLevel: shipped % OfficeModel.PER_LEVEL,
      toNext: OfficeModel.PER_LEVEL, stats, specialty };
  }
  /** Record an event: whether it counted as a shipped task, and whether that was a level. */
  noteEvent(ev: OfficeEvent): { shipped: boolean; levelled: boolean; stat?: WorkKind } {
    if (this.studio) return ev.completion
      ? { shipped: true, levelled: ev.completion.total % OfficeModel.PER_LEVEL === 0, stat: ev.completion.stat }
      : { shipped: false, levelled: false };
    if (ev.kind !== 'status') return { shipped: false, levelled: false };
    const finished = ev.status === 'done' || (ev.status === 'idle' && ev.prev === 'working' && (ev.prev_for_ms ?? 0) > 60_000);
    if (!finished) return { shipped: false, levelled: false };
    const n = (this.shipped.get(ev.pane_id) ?? 0) + 1;
    this.shipped.set(ev.pane_id, n);
    const stat = workKindForTitle(ev.title);
    const stats = { ...(this.stats.get(ev.pane_id) ?? emptyStats()) };
    stats[stat]++;
    this.stats.set(ev.pane_id, stats);
    save(this.shipped);
    saveStats(this.stats);
    return { shipped: true, levelled: n % OfficeModel.PER_LEVEL === 0, stat };
  }
  private listeners = new Set<(change: 'agents' | 'event', ev?: OfficeEvent) => void>();

  on(l: (change: 'agents' | 'event', ev?: OfficeEvent) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(change: 'agents' | 'event', ev?: OfficeEvent) { for (const l of this.listeners) l(change, ev); }

  private identity(a: AgentInfo) { return JSON.stringify([a.agent, a.agent_session?.kind, a.agent_session?.value, a.foreground_cwd || a.cwd]); }
  beginDeparture(paneId: string) {
    const a = this.agents.get(paneId);
    if (a && !this.departing.has(paneId)) this.departing.set(paneId, this.identity(a));
  }
  isDeparting(paneId: string) { return this.departing.has(paneId); }
  get hasDepartures() { return this.departing.size > 0; }
  finishDeparture(paneId: string) {
    if (!this.departing.has(paneId)) return;
    this.departed.add(paneId);
    // Hold the entire floor until the last person is outside. Removing the first empty
    // workspace would otherwise rebuild the room under everybody still walking.
    if (this.departed.size !== this.departing.size) return;
    const remaining = [...this.agents.values()].filter(a => !this.departed.has(a.pane_id)
      || this.identity(a) !== this.departing.get(a.pane_id));
    this.departing.clear(); this.departed.clear();
    this.setAgents(remaining);
  }

  seatOf(paneId: string): { pod: number; seat: number } | null {
    for (let p = 0; p < this.pods.length; p++) { const s = this.pods[p].seats.indexOf(paneId); if (s >= 0) return { pod: p, seat: s }; }
    return null;
  }

  setAgents(list: AgentInfo[]) {
    const next = new Map(list.map((a) => [a.pane_id, a]));
    // A left event reaches the browser before the following agents snapshot. Preserve its last
    // AgentInfo and desk until Wander calls finishDeparture at the far side of the doorway.
    for (const paneId of this.departing.keys()) {
      const leaving = this.agents.get(paneId);
      if (leaving && !next.has(paneId)) next.set(paneId, leaving);
    }
    const byProject = new Map<string, AgentInfo[]>();
    for (const a of next.values()) {
      if (a.office_role === 'boss') continue; // Boss sits at his executive desk.
      const p = projectOf(a);
      const bucket = byProject.get(p) ?? [];
      if (!bucket.length) byProject.set(p, bucket);
      bucket.push(a);
    }
    // vacate seats whose agent left, or moved to another project's cluster
    for (const pod of this.pods)
      pod.seats = pod.seats.map((id) => {
        const a = id ? next.get(id) : undefined;
        return a && a.office_role !== 'boss' && projectOf(a) === pod.project ? id : null;
      });
    this.pods = this.pods.filter((p) => byProject.has(p.project));

    for (const [project, members] of byProject) {
      let pod = this.pods.find((p) => p.project === project);
      if (!pod) { pod = { project, seats: [] }; this.pods.push(pod); }
      // grow the bank in fours until everyone fits, and shrink back once a whole bank is empty
      const need = Math.max(1, Math.ceil(members.length / POD_SIZE)) * POD_SIZE;
      while (pod.seats.length < need) pod.seats.push(null);
      while (pod.seats.length > need && pod.seats.slice(-POD_SIZE).every((s) => !s)) pod.seats.length -= POD_SIZE;
      // seat newcomers in a stable order so the office does not reshuffle between polls
      const seated = new Set(pod.seats.filter(Boolean) as string[]);
      const newcomers = members.filter((a) => !seated.has(a.pane_id))
        .sort((a, b) => (a.state_change_seq ?? 0) - (b.state_change_seq ?? 0) || a.pane_id.localeCompare(b.pane_id));
      for (const a of newcomers) {
        const i = pod.seats.indexOf(null);
        if (i >= 0) pod.seats[i] = a.pane_id; else pod.seats.push(a.pane_id);
      }
    }
    this.agents = next;
    this.emit('agents');
  }
  addEvent(ev: OfficeEvent) { this.emit('event', ev); }

  /**
   * Where each cluster sits on the pod grid. Clusters are placed into a column of free cells,
   * reaching upward because that is the direction a bank grows, so a wide cluster never lands on
   * top of the one behind it.
   */
  layout(): { cols: number; rows: number; placed: Placement[] } {
    const order = this.studio?.room.projectOrder ?? [];
    const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? order.length : index; };
    const pods = [...this.pods].sort((a, b) => rank(a.project) - rank(b.project));
    const cells = pods.reduce((n, p) => n + cellsFor(pairsOf(p)), 0);
    // Squarest grid that holds them. An isometric room is 2:1 whatever shape the grid is —
    // width is (cols+rows)*8 tiles and height half that — so the only way to keep the floor small
    // is to keep cols+rows small, and that means as square as possible. A wider grid used to be
    // chosen here for looks; it cost 12% of the room's width and, with it, the zoom.
    const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(cells, 1))));
    for (let rows = Math.max(1, Math.ceil(cells / cols)); ; rows++) {
      const taken = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
      const placed: Placement[] = [];
      const fits = (c: number, r: number, n: number) => {
        if (r - n + 1 < 0) return false;
        for (let i = 0; i < n; i++) if (taken[r - i][c]) return false;
        return true;
      };
      let ok = true;
      for (const pod of pods) {
        const n = cellsFor(pairsOf(pod));
        // bottom-up, so the cells a bank reaches into are still free when we get to them
        let spot: Placement | null = null;
        for (let r = rows - 1; r >= 0 && !spot; r--)
          for (let c = 0; c < cols && !spot; c++)
            if (fits(c, r, n)) spot = { pod, col: c, row: r };
        if (!spot) { ok = false; break; }
        for (let i = 0; i < n; i++) taken[spot.row - i][spot.col] = true;
        placed.push(spot);
      }
      if (ok) return { cols, rows, placed };
      if (rows > cells + 2) return { cols, rows, placed: [] };   // cannot happen; fail safe
    }
  }
}
