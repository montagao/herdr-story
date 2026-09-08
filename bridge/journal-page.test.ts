import { describe, expect, test } from 'bun:test';
import { StudioStore } from './studio';
import type { JournalEntry } from '../shared/studio';

const entry = (n: number): JournalEntry => ({ id: `memory-${String(n).padStart(4, '0')}`, version: 0, at: 1_000 + Math.floor(n / 3),
  kind: n % 20 === 0 ? 'release' : 'task', title: `Memory ${n}`, notes: n === 3 ? 'a distant searchable artifact' : '',
  project: n % 2 ? '/projects/one' : '/projects/two', contributors: ['veteran'], url: '', source: 'manual' });
function fixture() {
  const store = new StudioStore();
  (store as any).state.journal = Array.from({ length: 245 }, (_, n) => entry(n));
  return store;
}

describe('on-demand studio history', () => {
  test('compact head preserves aggregate achievement counts and full snapshot compatibility', () => {
    const store = fixture(), compact = store.snapshot(100), full = store.snapshot();
    expect(compact.journal).toHaveLength(100); expect(compact.journalTotal).toBe(245);
    expect(compact.journalCursor).toBeTruthy(); expect(compact.journalSummary?.trophies).toBe(13);
    expect(compact.journalSummary?.achievementsByEmployee.veteran).toBe(13);
    expect(Object.values(compact.journalSummary!.tasksByProject).reduce((a, b) => a + b, 0)).toBe(232);
    expect(full.journal).toHaveLength(245); expect(full.journalTotal).toBeUndefined();
    compact.journal[0].notes = 'do not mutate storage';
    expect(store.snapshot().journal.some(e => e.notes === 'do not mutate storage')).toBe(false);
  });
  test('keyset pages survive deletion and arrivals including identical timestamps', () => {
    const store = fixture(), first = store.snapshot(100);
    const cursorEntry = first.journal[0];
    (store as any).state.journal = (store as any).state.journal.filter((e: JournalEntry) => e.id !== cursorEntry.id);
    (store as any).state.journal.push(entry(999));
    (store as any).state.revision++;
    const second = store.journalPage({ cursor: first.journalCursor, limit: 100 });
    const third = store.journalPage({ cursor: second.cursor, limit: 100 });
    expect(second.entries).toHaveLength(100); expect(third.entries).toHaveLength(45); expect(third.cursor).toBeNull();
    expect(new Set([...first.journal, ...second.entries, ...third.entries].map(e => e.id)).size).toBe(245);
    expect(store.snapshot(100).journalRetired).toContain(cursorEntry.id);
  });
  test('invalidates changed old records and bounds deletion metadata with an epoch reset', () => {
    const store = fixture(), first = store.snapshot(100);
    (store as any).state.journal[3].notes = 'Edited by another browser';
    (store as any).state.revision++;
    const edited = store.snapshot(100);
    expect(edited.journalInvalidated?.['memory-0003']).toBe(1);
    expect(store.journalPage({ ids: ['memory-0003'] }).entries[0].notes).toBe('Edited by another browser');
    (store as any).journalRetired = new Set(Array.from({ length: 501 }, (_, n) => `gone-${n}`));
    (store as any).state.revision++;
    const reset = store.snapshot(100);
    expect(reset.journalEpoch).not.toBe(first.journalEpoch);
    expect(reset.journalRetired).toEqual([]); expect(reset.journalInvalidated).toEqual({});
  });
  test('finds remote history and trophies without downloading every intervening note', () => {
    const store = fixture();
    expect(store.journalPage({ search: 'distant searchable' }).entries.map(e => e.id)).toEqual(['memory-0003']);
    expect(store.journalPage({ trophies: true }).total).toBe(13);
    expect(store.journalPage({ project: '/projects/one', kind: 'release' }).total).toBe(0);
    expect(store.journalPage({ since: 1_080 }).total).toBe(2);
    expect(() => store.journalPage({ cursor: 'oops' })).toThrow('cursor');
    expect(() => store.journalPage({ limit: 10_000 })).toThrow();
  });
});
