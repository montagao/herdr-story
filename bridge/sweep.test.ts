import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SweepService, type SweepSnapshot } from './sweep';
import type { AgentInfo } from '../shared/types';
import { StudioStore } from './studio';

const NOW = 1_800_000_000_000;
const agent = (pane_id = 'w1:p1', extra: Partial<AgentInfo> = {}): AgentInfo => ({ pane_id, workspace_id: pane_id.split(':')[0], agent: 'codex', agent_status: 'idle',
  cwd: '/projects/example', state_change_seq: 2, agent_session: { kind: 'id', value: pane_id + '-session' }, ...extra });
function fixture(list = [agent()], directory?: string) {
  let now = NOW, activity: number | undefined = NOW - 5 * 3_600_000;
  const snapshot: SweepSnapshot = { agents: list, workspaces: [...new Set(list.map(a => a.workspace_id!))].map(id => ({ workspace_id: id, label: id })), panes: list.map(a => ({ pane_id: a.pane_id, workspace_id: a.workspace_id! })) };
  const calls: string[] = [], saved = new Map<string, string>();
  let failSave = false, queued = false, failAfterClose = false, snapshotFailed = false;
  let reply = 'Created [report](https://example.com/report) and /tmp/findings.md. Tests passed.';
  const service = new SweepService({ now: () => now, snapshot: async () => { if (snapshotFailed) throw new Error('Disconnected'); return structuredClone(snapshot); }, lastActivity: async () => activity,
    transcript: async () => ({ prompt: 'Build the report', reply, turns: [] }),
    read: async () => { throw new Error('Transcript should be enough'); }, queued: () => queued,
    save: async (id, a, recap) => { calls.push('save:' + a.pane_id); if (failSave) throw new Error('Disk full'); saved.set(id, recap.notes); return id; },
    call: async (method, params) => {
      calls.push(method + ':' + (params.pane_id || params.workspace_id));
      const closed = snapshot.panes!.filter(p => method === 'workspace.close' ? p.workspace_id === params.workspace_id : p.pane_id === params.pane_id).map(p => p.pane_id);
      snapshot.agents = snapshot.agents.filter(a => !closed.includes(a.pane_id)); snapshot.panes = snapshot.panes!.filter(p => !closed.includes(p.pane_id));
      if (failAfterClose) snapshotFailed = true;
      return {};
    },
  }, directory);
  return { service, snapshot, calls, saved, setNow: (value: number) => now = value, setActivity: (value: number | undefined) => activity = value,
    setFail: () => failSave = true, setQueued: () => queued = true, setDisconnect: () => failAfterClose = true, setReply: (value: string) => reply = value };
}

describe('office sweep', () => {
  test('unknown activity starts a fresh clock rather than guessing that a desk is old', async () => {
    const f = fixture(); f.setActivity(undefined);
    try { const row = (await f.service.scan()).workspaces[0].agents[0]; expect(row.lastActiveAt).toBe(NOW); expect(row.eligible).toBe(false); }
    finally { f.service.dispose(); }
  });
  test('a connection loss after a partial sweep preserves the result and stops further closes', async () => {
    const f = fixture([agent(), agent('w2:p1')]);
    try {
      const review = await f.service.prepare({ paneIds: ['w1:p1', 'w2:p1'] }); f.setDisconnect();
      const result = await f.service.finish({ token: review.token, close: true, confirm: ['w1:p1', 'w2:p1'] });
      expect(result.closed).toEqual(['w1:p1']); expect(result.saved.length).toBe(2);
      expect(result.kept[0].paneId).toBe('w2:p1'); expect(result.kept[0].reason).toContain('no further close');
    } finally { f.service.dispose(); }
  });
  test('every artifact shown in a long review fits in the saved recap', async () => {
    const f = fixture();
    try {
      f.setReply('Detailed findings. '.repeat(500) + Array.from({ length: 12 }, (_, i) => `https://example.com/${i}/${'x'.repeat(300)}`).join('\n'));
      const recap = (await f.service.prepare({ paneIds: ['w1:p1'] })).recaps[0];
      expect(recap.notes.length).toBeLessThanOrEqual(6000);
      for (const artifact of recap.artifacts) expect(recap.notes).toContain(artifact);
      expect(recap.notes).toContain(recap.findings);
    } finally { f.service.dispose(); }
  });
  test('finds old idle/done agents; protects active, blocked, focused, queued and recent agents', async () => {
    const f = fixture([agent(), agent('w1:p2', { agent_status: 'done' }), agent('w1:p3', { agent_status: 'working' }), agent('w1:p4', { agent_status: 'blocked' }), agent('w1:p5', { focused: true })]);
    try {
      const scan = await f.service.scan(60);
      expect(scan.protectedCount).toBe(2);
      expect(scan.workspaces[0].agents.filter(a => a.eligible).map(a => a.agent.pane_id)).toEqual(['w1:p1', 'w1:p2']);
      f.service.touch(f.snapshot.agents[0]);
      expect((await f.service.scan(60)).workspaces[0].agents.find(a => a.agent.pane_id === 'w1:p1')?.reason).toBe('Recently active');
      f.setQueued();
      expect((await f.service.scan(60)).workspaces[0].agents.some(a => a.eligible)).toBe(false);
    } finally { f.service.dispose(); }
  });
  test('reviews findings and artifacts, then durably saves ALL recaps before closing a whole workspace', async () => {
    const f = fixture([agent(), agent('w1:p2', { agent_status: 'done' })]);
    try {
      const review = await f.service.prepare({ paneIds: ['w1:p1', 'w1:p2'] });
      expect(review.closeWorkspaces.map(w => w.id)).toEqual(['w1']);
      expect(review.recaps[0].artifacts).toContain('https://example.com/report');
      expect(review.recaps[0].artifacts).toContain('/tmp/findings.md');
      expect(review.recaps[0].notes).toContain('w1:p1-session');
      await expect(f.service.finish({ token: review.token, close: true, confirm: ['w1:p1'] })).rejects.toThrow('exact agents');
      const request = { token: review.token, close: true, confirm: ['w1:p1', 'w1:p2'] };
      const [result, duplicate] = await Promise.all([f.service.finish(request), f.service.finish(request)]);
      expect(f.calls).toEqual(['save:w1:p1', 'save:w1:p2', 'workspace.close:w1']);
      expect(result.closed).toEqual(['w1:p1', 'w1:p2']); expect(result).toEqual(duplicate);
      await f.service.finish(request); expect(f.calls.length).toBe(3);
    } finally { f.service.dispose(); }
  });
  test('a failed save cannot close even the first agent', async () => {
    const f = fixture();
    try {
      const review = await f.service.prepare({ paneIds: ['w1:p1'] }); f.setFail();
      await expect(f.service.finish({ token: review.token, close: true, confirm: ['w1:p1'] })).rejects.toThrow('Disk full');
      expect(f.calls).toEqual(['save:w1:p1']); expect(f.service.isClosing('w1:p1')).toBe(false);
    } finally { f.service.dispose(); }
  });
  for (const change of ['working', 'reused', 'activity', 'queued', 'focused']) test(`keeps an agent open if ${change} changes after review`, async () => {
    const f = fixture();
    try {
      const review = await f.service.prepare({ paneIds: ['w1:p1'] });
      if (change === 'working') f.snapshot.agents[0].agent_status = 'working';
      if (change === 'reused') f.snapshot.agents[0].agent_session = { kind: 'id', value: 'replacement' };
      if (change === 'activity') f.setActivity(NOW - 2 * 3_600_000);
      if (change === 'queued') f.setQueued();
      if (change === 'focused') f.snapshot.agents[0].focused = true;
      const result = await f.service.finish({ token: review.token, close: true, confirm: ['w1:p1'] });
      expect(result.closed).toEqual([]); expect(result.saved.length).toBe(1); expect(result.kept.length).toBe(1);
    } finally { f.service.dispose(); }
  });
  test('keeps other terminal panes and refuses an unreviewed implicit workspace closure', async () => {
    const f = fixture();
    try {
      f.snapshot.panes!.push({ pane_id: 'w1:p2', workspace_id: 'w1' });
      const review = await f.service.prepare({ paneIds: ['w1:p1'] }); expect(review.closeWorkspaces).toEqual([]);
      f.snapshot.panes!.pop();
      const result = await f.service.finish({ token: review.token, close: true, confirm: ['w1:p1'] });
      expect(result.closed).toEqual([]); expect(result.kept[0].reason).toContain('Workspace contents changed');
    } finally { f.service.dispose(); }
  });
  test('closes selected panes while another terminal keeps the workspace open', async () => {
    const f = fixture();
    try {
      f.snapshot.panes!.push({ pane_id: 'w1:p2', workspace_id: 'w1' });
      const review = await f.service.prepare({ paneIds: ['w1:p1'] });
      const result = await f.service.finish({ token: review.token, close: true, confirm: ['w1:p1'] });
      expect(result.closedWorkspaces).toEqual([]); expect(f.snapshot.panes!.map(p => p.pane_id)).toEqual(['w1:p2']);
    } finally { f.service.dispose(); }
  });
  test('can archive without closing and rejects expired reviews', async () => {
    const f = fixture();
    try {
      const review = await f.service.prepare({ paneIds: ['w1:p1'] });
      expect((await f.service.finish({ token: review.token, close: false })).closed).toEqual([]);
      const next = await f.service.prepare({ paneIds: ['w1:p1'] }); f.setNow(NOW + 16 * 60_000);
      await expect(f.service.finish({ token: next.token, close: true, confirm: ['w1:p1'] })).rejects.toThrow('expired');
    } finally { f.service.dispose(); }
  });
  test('inactivity survives a bridge restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-sweep-'));
    const first = fixture([agent()], dir);
    try {
      await first.service.observe(first.snapshot.agents); first.service.touch(first.snapshot.agents[0]); first.service.dispose();
      const next = fixture([agent()], dir);
      try { next.setNow(NOW + 2 * 3_600_000); expect((await next.service.scan(60)).workspaces[0].agents[0].lastActiveAt).toBe(NOW); }
      finally { next.service.dispose(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('archived recaps survive storage restart and retries never duplicate achievements', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-sweep-journal-'));
    const store = new StudioStore(dir, { asyncWrite: true });
    try {
      const a = agent(); await store.run(() => store.observe([a]));
      await store.run(() => store.archiveSweep('sweep:one', a, 'Saved findings with /tmp/report.md', 'https://example.com/report'));
      await store.run(() => store.archiveSweep('sweep:one', a, 'duplicate', ''));
      await store.close();
      const restored = new StudioStore(dir);
      try {
        const entries = restored.journalPage({ search: 'Re-org' }).entries;
        expect(entries.length).toBe(1); expect(entries[0].notes).toContain('/tmp/report.md');
        expect(restored.snapshot().employees[0].shipped).toBe(0);
      } finally { await restored.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
