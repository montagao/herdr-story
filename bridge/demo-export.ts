#!/usr/bin/env bun
/**
 * Captures the live office and dresses it for the demo. Reads the bridge over HTTP — desks,
 * books, the whole journal, what each terminal showed — applies `scripts/demo-curation.json`
 * (names and stories for the crew, real wins promoted to milestones, noise boards hidden, raw
 * prompts retitled) and writes a PRIVATE capture to `captures/office.json`. Review before any sharing.
 *
 *   npm run demo:export                       # bridge at http://127.0.0.1:7788
 *   HERDR_STORY_BRIDGE=http://host:7788 bun run bridge/demo-export.ts [curation.json] [out.json]
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentInfo, AgentStatus, MoneyEvent, OfficeEvent, ServerMsg, WorkspaceSummary } from '../shared/types';
import type { CareerStat, Employee, JournalEntry, Milestone, ProjectBoard, RoomItem, StudioState } from '../shared/studio';
import { projectKey, projectName } from '../shared/studio';
import type { DemoRevenue, DemoSnapshot } from '../shared/demo';
import { REVENUE_RANGES, type RevenueRange } from '../shared/revenue-range';

export interface RawCapture {
  agents: AgentInfo[]; workspaces: WorkspaceSummary[]; events: OfficeEvent[]; money: MoneyEvent[];
  studio: StudioState; revenue: Partial<Record<RevenueRange, DemoRevenue>>; transcripts: Record<string, string>;
}
export interface GoalCuration {
  /** Case-insensitive fragment of an existing goal's title to update; otherwise a goal is added. */
  match?: string; id?: string; title?: string; notes?: string; done?: boolean; completedAt?: string;
  contributors?: string[]; url?: string; due?: string; checklist?: { text: string; done: boolean }[];
}
export interface Curation {
  theme?: string; redactHome?: boolean;
  /** Regular expressions whose matches become "[private link]" in notes, titles and terminals. */
  redactPatterns?: string[];
  namePool?: string[];
  employees?: Record<string, Partial<Pick<Employee, 'name' | 'bio' | 'favorite' | 'face' | 'body'>>>;
  mergeEmployees?: Record<string, string>;
  projects?: { hide?: string[]; rename?: Record<string, string>; notes?: Record<string, string>; goals?: Record<string, GoalCuration[]> };
  journal?: { dropGenericNotes?: boolean; drop?: string[]; retitle?: Record<string, string> };
  agents?: { drop?: string[]; status?: Record<string, AgentStatus>; titles?: Record<string, string> };
  room?: { add?: RoomItem[] };
}
export interface CurateOptions { now?: number; home?: string; warn?: (message: string) => void }

const GENERIC_NOTES = /^(Agent reported completion\.|Returned to idle after working for more than a minute\.)?$/;
const DEFAULT_TITLES = new Set(['Pixel art AI agent viewer with Game Dev Story style', 'Summary', 'Added', 'Done', 'Update']);
const GENERIC_NAMES = /^(claude|codex|gemini|agent|)$/i;
const TRANSCRIPT_LINES = 120;

/** `abcd1234` names the one id that starts with it; a full id names itself. */
function resolve(key: string, ids: string[], what: string, warn: (m: string) => void): string | undefined {
  const exact = ids.find(id => id === key); if (exact) return exact;
  const hits = ids.filter(id => id.startsWith(key));
  if (hits.length === 1) return hits[0];
  warn(hits.length ? `${what} ${key} is ambiguous` : `${what} ${key} is not in the capture`);
  return undefined;
}
function findProject(key: string, projects: ProjectBoard[]) {
  return projects.find(p => p.id === key || projectName(p.id) === key);
}
/** The first plain sentence of a reply makes a fair title for a raw prompt: headings, bullets,
 *  Markdown and the "Done —" that agents open with are all dropped. */
export function titleFromNotes(notes: string, max = 96): string {
  const text = notes.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*#+[^\n]*\n/g, '').replace(/^\s*[-*]\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^(both done|all done|done|fixed|verified|implemented|yes|got it|sorry)[\s.!:—–-]*/i, '');
  const first = text.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  const cut = first.length > max ? `${first.slice(0, max - 1).replace(/\s\S*$/, '')}…` : first;
  return cut.replace(/[.:,;]$/, '').replace(/^[a-z]/, c => c.toUpperCase());
}
const redactor = (home: string | undefined, patterns: string[]) => {
  const rules = patterns.map(pattern => new RegExp(pattern, 'g'));
  return (text: string) => rules.reduce((out, rule) => out.replace(rule, '[private link]'), home ? text.split(home).join('~') : text);
};

export function curate(raw: RawCapture, curation: Curation, options: CurateOptions = {}): DemoSnapshot {
  const now = options.now ?? Date.now(), warn = options.warn ?? (() => {});
  const redact = redactor(curation.redactHome === false ? undefined : options.home, curation.redactPatterns ?? []);
  const studio = structuredClone(raw.studio);
  let agents = structuredClone(raw.agents);
  const employeeIds = () => studio.employees.map(e => e.id);
  const employee = (key: string) => { const id = resolve(key, employeeIds(), 'employee', warn); return studio.employees.find(e => e.id === id); };

  // Crew: fold duplicates, apply the stories, then hand the rest distinct names from the pool.
  for (const [fromKey, toKey] of Object.entries(curation.mergeEmployees ?? {})) {
    const from = employee(fromKey), to = employee(toKey);
    if (!from || !to || from === to) continue;
    to.shipped += from.shipped;
    for (const stat of Object.keys(to.stats) as CareerStat[]) to.stats[stat] += from.stats[stat] ?? 0;
    const swap = (ids: string[]) => [...new Set(ids.map(id => id === from.id ? to.id : id))];
    studio.journal.forEach(e => { e.contributors = swap(e.contributors); });
    studio.projects.forEach(p => p.goals.forEach(g => { g.contributors = swap(g.contributors); }));
    agents.forEach(a => { if (a.employee_id === from.id) a.employee_id = to.id; });
    studio.employees = studio.employees.filter(e => e !== from);
  }
  for (const [key, patch] of Object.entries(curation.employees ?? {})) {
    const target = employee(key); if (!target) continue;
    Object.assign(target, patch, { bio: redact(patch.bio ?? target.bio) });
  }
  const taken = new Set(studio.employees.map(e => e.name).filter(n => !GENERIC_NAMES.test(n)));
  const pool = (curation.namePool ?? []).filter(n => !taken.has(n));
  for (const e of [...studio.employees].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    if (!GENERIC_NAMES.test(e.name)) continue;
    const name = pool.shift() ?? `${e.name || e.kind} ${taken.size + 1}`;
    e.name = name; taken.add(name);
  }

  // Journal keys resolve against the full capture, before hidden boards take their entries with them.
  const journalIds = studio.journal.map(e => e.id);
  const dropped = new Set((curation.journal?.drop ?? []).map(key => resolve(key, journalIds, 'journal entry', warn)).filter(Boolean));
  const retitles = new Map(Object.entries(curation.journal?.retitle ?? {}).map(([key, title]) => [resolve(key, journalIds, 'journal entry', warn), title]));

  // Boards: hide the noise everywhere it appears, rename, annotate, and promote real wins.
  const hidden = new Set<string>();
  for (const key of curation.projects?.hide ?? []) { const p = findProject(key, studio.projects); if (p) hidden.add(p.id); }
  studio.projects = studio.projects.filter(p => !hidden.has(p.id));
  studio.room.items = studio.room.items?.filter(item => !item.project || !hidden.has(item.project)) ?? null;
  studio.room.projectOrder = studio.room.projectOrder.filter(id => !hidden.has(id));
  studio.journal = studio.journal.filter(e => !e.project || !hidden.has(e.project));
  agents = agents.filter(a => !hidden.has(projectKey(a)));
  for (const [key, name] of Object.entries(curation.projects?.rename ?? {})) { const p = findProject(key, studio.projects); if (p) p.name = name; else warn(`project ${key} is not in the capture`); }
  for (const [key, notes] of Object.entries(curation.projects?.notes ?? {})) { const p = findProject(key, studio.projects); if (p) p.notes = notes; }
  for (const [key, goals] of Object.entries(curation.projects?.goals ?? {})) {
    const p = findProject(key, studio.projects);
    if (!p) { warn(`project ${key} is not in the capture`); continue; }
    for (const g of goals) {
      let goal: Milestone | undefined = g.match ? p.goals.find(x => x.title.toLowerCase().includes(g.match!.toLowerCase())) : p.goals.find(x => x.id === `demo-goal-${g.id}`);
      if (g.match && !goal) { warn(`goal "${g.match}" is not on ${p.name}`); continue; }
      if (!goal) {
        goal = { id: `demo-goal-${g.id ?? (g.title ?? 'goal').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, version: 1, title: g.title ?? '', notes: '', done: false, contributors: [], checklist: [], url: '', due: '' };
        p.goals.push(goal);
      }
      if (g.title) goal.title = g.title; if (g.notes !== undefined) goal.notes = g.notes;
      if (g.url !== undefined) goal.url = g.url; if (g.due !== undefined) goal.due = g.due;
      if (g.contributors) goal.contributors = g.contributors.map(k => employee(k)?.id).filter((id): id is string => !!id);
      if (g.checklist) goal.checklist = g.checklist.map((item, i) => ({ id: `${goal!.id}-${i + 1}`, text: item.text, done: item.done }));
      if (g.done !== undefined) goal.done = g.done;
      if (goal.done) {
        goal.completedAt = g.completedAt ? Date.parse(g.completedAt) : goal.completedAt ?? now;
        const entry = studio.journal.find(e => e.goalId === goal!.id);
        const record: JournalEntry = { id: entry?.id ?? `demo-milestone-${goal.id}`, version: 1, at: goal.completedAt, kind: 'milestone', title: goal.title,
          notes: goal.notes, project: p.id, contributors: goal.contributors, url: goal.url, source: 'goal', goalId: goal.id };
        if (entry) Object.assign(entry, record); else studio.journal.push(record);
      } else studio.journal = studio.journal.filter(e => e.goalId !== goal!.id);
    }
  }

  // Journal: out with the empty completions, real titles for the raw prompts.
  studio.journal = studio.journal.filter(e => !dropped.has(e.id) && !(curation.journal?.dropGenericNotes !== false && e.kind === 'task' && GENERIC_NOTES.test(e.notes.trim())));
  for (const e of studio.journal) {
    const retitle = retitles.get(e.id);
    if (retitle) e.title = retitle;
    else if (e.kind === 'task' && (DEFAULT_TITLES.has(e.title) || e.title === projectName(e.project))) e.title = titleFromNotes(e.notes) || e.title;
    e.title = redact(e.title); e.notes = redact(e.notes);
  }
  studio.journal.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  // Desks: drop, restate, and carry the crew's names and looks the way the bridge does.
  const droppedPanes = new Set(curation.agents?.drop ?? []);
  agents = agents.filter(a => !droppedPanes.has(a.pane_id));
  for (const a of agents) {
    const status = curation.agents?.status?.[a.pane_id];
    if (status && status !== a.agent_status) { a.agent_status = status; a.state_change_seq = (a.state_change_seq ?? 0) + 1; }
    const title = curation.agents?.titles?.[a.pane_id];
    if (title) { a.title = title; a.last_prompt = title; a.terminal_title_stripped = title; a.activity = null; }
    else { a.last_prompt = a.last_prompt ? redact(a.last_prompt) : a.last_prompt; a.activity = a.activity ? redact(a.activity) : a.activity; }
    const person = studio.employees.find(e => e.id === a.employee_id);
    if (person) Object.assign(a, { office_name: person.name, office_look: { body: person.body, face: person.face }, favorite: person.favorite });
    delete (a as { terminal_id?: string }).terminal_id;
  }
  const panes = new Set(agents.map(a => a.pane_id));
  const seated = new Set(agents.map(a => a.workspace_id));
  const workspaces = raw.workspaces.filter(w => seated.has(w.workspace_id));
  const events = raw.events.filter(e => panes.has(e.pane_id)).slice(-30).map(e => ({ ...e, title: redact(e.title), snippet: e.snippet ? redact(e.snippet) : e.snippet }));
  const transcripts: Record<string, string> = {};
  for (const [pane, text] of Object.entries(raw.transcripts)) if (panes.has(pane)) transcripts[pane] = redact(text.split('\n').slice(-TRANSCRIPT_LINES).join('\n'));

  studio.room.items = [...(studio.room.items ?? []), ...(curation.room?.add ?? [])];
  const summary = { trophies: 0, tasksByProject: {} as Record<string, number>, achievementsByEmployee: {} as Record<string, number> };
  for (const e of studio.journal) {
    if (e.kind === 'task') summary.tasksByProject[e.project] = (summary.tasksByProject[e.project] ?? 0) + 1;
    if (e.kind === 'milestone' || e.kind === 'release') { summary.trophies++; for (const id of e.contributors) summary.achievementsByEmployee[id] = (summary.achievementsByEmployee[id] ?? 0) + 1; }
  }
  const { journalTotal: _t, journalCursor: _c, journalEpoch: _e, journalRetired: _r, journalInvalidated: _i, ...rest } = studio;
  return { version: 1, capturedAt: now, theme: curation.theme ?? 'classic', agents, workspaces, events, money: raw.money.slice(-12),
    studio: { ...rest, journalSummary: summary }, revenue: raw.revenue, transcripts };
}

export async function capture(bridge: string): Promise<RawCapture> {
  let seq = 0;
  const call = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${bridge}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call', id: `x${++seq}`, method, params }) });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (!response.ok || body.error) throw new Error(body.error?.message ?? `${method}: bridge returned ${response.status}`);
    return body.result;
  };
  const state = await (await fetch(`${bridge}/api/state`)).json() as Extract<ServerMsg, { type: 'snapshot' }>;
  if (!state.studio) throw new Error('The bridge has no studio to capture.');
  const journal: JournalEntry[] = [];
  for (let cursor: string | null = null; ;) {
    const page = await call('studio.journal', { limit: 200, ...(cursor ? { cursor } : {}) }) as { entries: JournalEntry[]; cursor: string | null };
    journal.unshift(...page.entries);
    if (!page.cursor) break; cursor = page.cursor;
  }
  const revenue: Partial<Record<RevenueRange, DemoRevenue>> = {};
  for (const { value } of REVENUE_RANGES) {
    const response = await fetch(`${bridge}/api/revenue?range=${value}`, { headers: { accept: 'application/json' } });
    revenue[value] = await response.json() as DemoRevenue;
  }
  // Terminals are read one at a time: the bridge scrolls each pane to capture it, and parallel
  // reads make it drop connections. A working desk's scrollback cannot be read at all; its
  // visible screen still tells the story.
  const transcripts: Record<string, string> = {};
  for (const a of state.agents) {
    let failure = '';
    for (const source of ['recent', 'visible']) {
      for (let attempt = 0; attempt < 2 && !(a.pane_id in transcripts); attempt++) {
        try { transcripts[a.pane_id] = ((await call('agent.read', { target: a.pane_id, source, ...(source === 'recent' ? { lines: TRANSCRIPT_LINES } : {}) })) as { read: { text: string } }).read.text; }
        catch (error) { failure = (error as Error).message; await new Promise(resolve => setTimeout(resolve, 400)); }
      }
      if (a.pane_id in transcripts) break;
    }
    if (!(a.pane_id in transcripts)) console.warn(`[demo-export] no transcript for ${a.pane_id}: ${failure}`);
  }
  return { agents: state.agents, workspaces: state.workspaces ?? [], events: state.events, money: state.money ?? [],
    studio: { ...state.studio, journal }, revenue, transcripts };
}

if (import.meta.main) {
  const bridge = process.env.HERDR_STORY_BRIDGE ?? 'http://127.0.0.1:7788';
  const curationPath = process.argv[2] ?? 'scripts/demo-curation.json', out = process.argv[3] ?? 'captures/office.json';
  const raw = await capture(bridge);
  const curation = JSON.parse(readFileSync(curationPath, 'utf8')) as Curation;
  const snapshot = curate(raw, curation, { home: process.env.HOME, warn: message => console.warn(`[demo-export] ${message}`) });
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, JSON.stringify(snapshot), { mode: 0o600 });
  chmodSync(out, 0o600);
  const s = snapshot.studio;
  console.log(`[demo-export] ${out}: ${snapshot.agents.length} desks, ${s.employees.length} employees, ${s.projects.length} boards, ${s.journal.length} journal entries, ${s.journalSummary?.trophies ?? 0} trophies, ${Object.keys(snapshot.transcripts).length} transcripts, ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB`);
}
