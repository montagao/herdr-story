import { writeFileSync } from 'node:fs';
import type { DemoSnapshot } from '../shared/demo';
import { emptyCareer } from '../shared/studio';
import { REVENUE_RANGES } from '../shared/revenue-range';

/** Entirely fictional data: never reads the bridge, environment, or local studio. */
export function sampleOffice(): DemoSnapshot {
  const at = Date.UTC(2026, 8, 1, 12);
  const projects = ['workspace:paperplane', 'workspace:lantern'];
  const names = ['Ada', 'Bea', 'Cal', 'Dex'];
  const tasks = ['Improve keyboard navigation', 'Add a welcome screen', 'Test offline recovery', 'Write the getting started guide'];
  const agents = names.map((name, i) => ({ pane_id: `demo:p${i}`, workspace_id: projects[i % 2].slice(10),
    cwd: projects[i % 2], agent: i % 2 ? 'claude' : 'codex', agent_status: i === 0 ? 'working' as const : 'done' as const,
    employee_id: `sample-employee-${i}`, office_name: name, office_look: { body: i, face: i }, name, title: tasks[i], last_prompt: tasks[i],
  }));
  const journal = agents.map((agent, i) => ({ id: `sample-task-${i}`, version: 1, at: at - (i + 1) * 3600000,
    kind: 'task' as const, title: tasks[i], notes: 'Fictional example: implementation complete and checks passed.',
    project: agent.cwd, contributors: [agent.employee_id], url: '', source: 'agent' as const, stat: 'program' as const,
  }));
  return {
    version: 1, capturedAt: at, theme: 'classic', agents,
    workspaces: projects.map(id => ({ workspace_id: id.slice(10), label: id.slice(10) })),
    events: [], money: [],
    studio: { version: 1, revision: 1, employees: agents.map((agent, i) => ({
      id: agent.employee_id, version: 1, name: names[i], bio: 'A fictional member of the sample office.', kind: agent.agent,
      face: i, body: i, favorite: i === 0, createdAt: at - 86400000, shipped: 1, stats: { ...emptyCareer(), program: 1 },
    })), projects: projects.map((id, i) => ({ id, version: 1, name: i ? 'Lantern' : 'Paperplane',
      notes: 'An imaginary project for exploring the office.', color: i ? '#39815b' : '#307c9b', goals: [],
    })), journal, room: { version: 1, items: null, projectOrder: projects }, journalTotal: journal.length,
      journalSummary: { trophies: journal.length, tasksByProject: Object.fromEntries(projects.map(id => [id, 2])),
        achievementsByEmployee: Object.fromEntries(agents.map(a => [a.employee_id, 1])) },
    },
    revenue: Object.fromEntries(REVENUE_RANGES.map(({ value }, i) => [value, {
      source: 'stripe', amount: (i + 1) * 125, currency: 'usd', rangeSelectable: true, note: 'Fictional sample revenue',
    }])),
    transcripts: Object.fromEntries(agents.map((a, i) => [a.pane_id, `> ${tasks[i]}\n\nImplemented the example change. Checks passed.\nThis is fictional terminal output, not a real agent session.`])),
  };
}

if (import.meta.main) {
  writeFileSync('public/demo/office.json', JSON.stringify(sampleOffice(), null, 2) + '\n');
  console.log('Wrote fictional public demo; no live data was read.');
}
