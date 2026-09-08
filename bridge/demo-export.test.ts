import { expect, test } from 'bun:test';
import { curate, titleFromNotes, type RawCapture } from './demo-export';
import type { Employee, JournalEntry } from '../shared/studio';
import { emptyCareer } from '../shared/studio';

const person = (id: string, name: string, shipped = 0, createdAt = 0): Employee => ({ id, version: 1, name, bio: '', kind: 'claude', face: 1, body: 1, favorite: false, createdAt, shipped, stats: { ...emptyCareer(), program: shipped } });
const entry = (id: string, project: string, title: string, notes: string, contributors: string[], at: number): JournalEntry => ({ id, version: 1, at, kind: 'task', title, notes, project, contributors, url: '', source: 'agent', stat: 'program' });
const P = '/home/me/projects/app', NOISE = '/home/me/projects';
function raw(): RawCapture {
  return {
    agents: [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', cwd: P, employee_id: 'aaaa-1', office_name: 'Claude', state_change_seq: 0 },
      { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'codex', agent_status: 'idle', cwd: NOISE, employee_id: 'bbbb-1', state_change_seq: 0 },
      { pane_id: 'w3:p1', workspace_id: 'w3', agent: 'codex', agent_status: 'idle', cwd: P, employee_id: 'cccc-1', state_change_seq: 0 },
    ],
    workspaces: [{ workspace_id: 'w1', label: 'app' }, { workspace_id: 'w2', label: 'projects' }, { workspace_id: 'w3', label: 'app' }],
    events: [{ id: 'e1', ts: 5, kind: 'status', pane_id: 'w2:p1', agent: 'codex', status: 'idle', title: 'x' }],
    money: [{ id: 'm1', ts: 1, kind: 'sale', amount: 9, currency: 'usd', label: 'Sub' }],
    studio: { version: 1, revision: 3, employees: [person('aaaa-1', 'Claude', 2, 1), person('bbbb-1', 'Claude', 0, 2), person('cccc-1', 'Codex', 1, 3), person('dddd-1', 'Codex', 4, 4)],
      projects: [{ id: P, version: 1, name: 'app', notes: '', color: '#000', goals: [{ id: 'g1', version: 1, title: 'Reach 100 users', notes: '', done: false, contributors: [], checklist: [], url: '', due: '' }] },
        { id: NOISE, version: 1, name: 'projects', notes: '', color: '#000', goals: [] }],
      journal: [entry('j1', P, 'app', 'Agent reported completion.', ['aaaa-1'], 10), entry('j2', P, 'app', '**Done** — the button now toggles. Also fixed the hover.', ['aaaa-1'], 20),
        entry('j3', P, 'aight fix it all', 'Fixed all six in /home/me/projects/app.', ['cccc-1'], 30), entry('j4', NOISE, 'Save artifacts', 'ok', ['bbbb-1'], 40)],
      room: { version: 4, items: [{ id: 'b1', kind: 'whiteboard', project: P, x: 0, y: 0 }, { id: 'b2', kind: 'whiteboard', project: NOISE, x: 1, y: 1 }], projectOrder: [P, NOISE] },
      journalTotal: 4, journalCursor: null },
    revenue: { '30d': { source: 'stripe', amount: 100, currency: 'usd' } },
    transcripts: { 'w1:p1': 'cd /home/me/projects/app\n● Working at https://box.tail1234.ts.net/x', 'w2:p1': 'noise' },
  };
}
const curation = {
  redactPatterns: ['https?://[a-z0-9.-]+\\.ts\\.net\\S*'],
  namePool: ['Ada', 'Bea', 'Cal'],
  employees: { 'aaaa': { name: 'Mona', favorite: true, bio: 'Draws /home/me things.' } },
  mergeEmployees: { 'dddd': 'cccc' },
  projects: { hide: ['projects'], rename: { app: 'The App' }, goals: { app: [
    { match: 'reach 100', checklist: [{ text: '25', done: true }] },
    { id: 'launch', title: 'Launched', done: true, completedAt: '2026-09-05T00:00:00Z', contributors: ['cccc'], url: 'https://x' },
  ] } },
  journal: { retitle: { 'j3': 'Six fixes' } },
  agents: { status: { 'w1:p1': 'working' as const }, titles: { 'w1:p1': 'Painting' } },
};

test('curation folds duplicates, names the crew, and pins favourites onto their desks', () => {
  const out = curate(raw(), curation, { now: 1000, home: '/home/me' });
  const names = out.studio.employees.map(e => e.name).sort();
  expect(names).toEqual(['Ada', 'Bea', 'Mona']);
  const merged = out.studio.employees.find(e => e.id === 'cccc-1')!;
  expect(merged.shipped).toBe(5);
  expect(out.studio.employees.some(e => e.id === 'dddd-1')).toBe(false);
  const mona = out.studio.employees.find(e => e.id === 'aaaa-1')!;
  expect(mona.bio).toBe('Draws ~ things.');
  const desk = out.agents.find(a => a.pane_id === 'w1:p1')!;
  expect(desk.office_name).toBe('Mona'); expect(desk.favorite).toBe(true);
  expect(desk.agent_status).toBe('working'); expect(desk.title).toBe('Painting'); expect(desk.state_change_seq).toBe(1);
});

test('hidden boards vanish from projects, room, order, journal, desks and events', () => {
  const out = curate(raw(), curation, { now: 1000, home: '/home/me' });
  expect(out.studio.projects.map(p => p.name)).toEqual(['The App']);
  expect(out.studio.room.items?.map(i => i.id)).toEqual(['b1']);
  expect(out.studio.room.projectOrder).toEqual([P]);
  expect(out.agents.map(a => a.pane_id)).toEqual(['w1:p1', 'w3:p1']);
  expect(out.workspaces.map(w => w.workspace_id)).toEqual(['w1', 'w3']);
  expect(out.events).toEqual([]);
  expect(Object.keys(out.transcripts)).toEqual(['w1:p1']);
  expect(out.transcripts['w1:p1']).toBe('cd ~/projects/app\n● Working at [private link]');
});

test('goals gain checklists, done goals become trophies, and the journal reads like a story', () => {
  const out = curate(raw(), curation, { now: 1000, home: '/home/me' });
  const app = out.studio.projects[0];
  expect(app.goals[0].checklist).toEqual([{ id: 'g1-1', text: '25', done: true }]);
  const launched = app.goals.find(g => g.id === 'demo-goal-launch')!;
  expect(launched.done).toBe(true); expect(launched.contributors).toEqual(['cccc-1']);
  const trophy = out.studio.journal.find(e => e.goalId === 'demo-goal-launch')!;
  expect(trophy.kind).toBe('milestone'); expect(trophy.at).toBe(Date.parse('2026-09-05T00:00:00Z')); expect(trophy.url).toBe('https://x');
  expect(out.studio.journalSummary).toEqual({ trophies: 1, tasksByProject: { [P]: 2 }, achievementsByEmployee: { 'cccc-1': 1 } });
  const titles = out.studio.journal.filter(e => e.kind === 'task').map(e => e.title);
  expect(titles).toEqual(['The button now toggles', 'Six fixes']);
  expect(out.studio.journal.find(e => e.id === 'j3')!.notes).toBe('Fixed all six in ~/projects/app.');
  expect('journalTotal' in out.studio).toBe(false);
});

test('titleFromNotes takes the first plain sentence and trims long ones', () => {
  expect(titleFromNotes('Fixed—the gear now sits beside the total. More.')).toBe('The gear now sits beside the total');
  expect(titleFromNotes('## Summary\n\n- Added [durable](http://x) editing with **R2** uploads. Next: y')).toBe('Added durable editing with R2 uploads');
  expect(titleFromNotes('Both done.  Tailscale page (tailnet only): https://x')).toBe('Tailscale page (tailnet only): https://x');
  expect(titleFromNotes('word '.repeat(40)).length).toBeLessThanOrEqual(96);
});

test('unknown keys warn instead of throwing, so an older curation survives a fresh capture', () => {
  const warnings: string[] = [];
  const out = curate(raw(), { employees: { zzzz: { name: 'Nobody' } }, projects: { goals: { gone: [{ title: 'x' }] } }, journal: { drop: ['nope'] } }, { warn: m => warnings.push(m) });
  expect(warnings).toEqual(['employee zzzz is not in the capture', 'journal entry nope is not in the capture', 'project gone is not in the capture']);
  expect(out.studio.employees).toHaveLength(4);
});
