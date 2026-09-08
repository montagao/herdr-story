import type { Employee, JournalEntry, JournalPage, JournalPageQuery } from './studio';

/**
 * The journal's page arithmetic for an in-memory journal, as the bridge does it: newest first, a
 * cursor of `[at, id]` naming the last entry handed out, each page returned oldest-first so
 * callers can append it under what they already show. The demo snapshot answers with this.
 */
export function pageJournal(journal: JournalEntry[], employees: Employee[], query: JournalPageQuery, revision: number, epoch: string): JournalPage {
  const limit = query.limit === undefined ? 100 : Math.max(1, Math.min(200, Math.floor(Number(query.limit)) || 1));
  let before: [number, string] | undefined;
  if (query.cursor) {
    try {
      const parsed = JSON.parse(String(query.cursor).slice(0, 500));
      if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isFinite(parsed[0]) || typeof parsed[1] !== 'string') throw new Error();
      before = parsed as [number, string];
    } catch { throw new Error('The journal page cursor is invalid.'); }
  }
  const search = String(query.search ?? '').slice(0, 500).toLowerCase();
  const project = String(query.project ?? ''), kind = String(query.kind ?? '');
  const since = query.since === undefined ? 0 : Number(query.since);
  if (!Number.isFinite(since) || since < 0) throw new Error('The journal start date is invalid.');
  const wanted = query.ids ? new Set(query.ids) : undefined;
  const names = new Map(employees.map(employee => [employee.id, employee.name]));
  const ordered = journal.filter(entry => (!wanted || wanted.has(entry.id)) && (!project || entry.project === project) && (!kind || entry.kind === kind)
    && (query.read === undefined || !!entry.readAt === query.read)
    && (!query.trophies || entry.kind === 'milestone' || entry.kind === 'release') && entry.at > since
    && (!search || `${entry.title} ${entry.notes} ${entry.contributors.map(id => names.get(id) ?? '').join(' ')}`.toLowerCase().includes(search)))
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const remaining = before ? ordered.filter(entry => entry.at < before![0] || (entry.at === before![0] && entry.id < before![1])) : ordered;
  const entries = remaining.slice(0, limit), last = entries.at(-1);
  return { entries: structuredClone(entries.reverse()), cursor: remaining.length > limit && last ? JSON.stringify([last.at, last.id]) : null,
    total: ordered.length, revision, epoch };
}
