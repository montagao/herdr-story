import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Boss, bossBrief, BOSS_REVIEW_INTERVAL } from './boss';
import { parseTranscript } from './transcript';
import type { AgentInfo } from '../shared/types';
import type { JournalEntry, StudioState } from '../shared/studio';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const entry = (id: string, at = 1): JournalEntry => ({ id, at, version: 0, kind: 'task', title: `Shipped ${id}`,
  notes: 'Reduced lag in the agent chat', project: '/game', contributors: [], url: '', source: 'agent' });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'boss-unit-')); dirs.push(dir);
  const state: StudioState = { version: 1, revision: 0, employees: [], projects: [], journal: [entry('first')], room: { version: 0, items: null, projectOrder: [] } };
  const agents: AgentInfo[] = [], prompts: string[] = [];
  let hires = 0, fail = false, now = Date.now();
  const ops = {
    list: async () => agents,
    studio: async () => state,
    hire: async () => {
      hires++;
      const agent: AgentInfo = { pane_id: `w${hires}:p1`, workspace_id: `w${hires}`, agent: 'claude', name: 'Boss',
        agent_status: 'idle', agent_session: { kind: 'id', value: `boss-${hires}` }, employee_id: `boss-${hires}` };
      agents.push(agent);
      return { pane_id: agent.pane_id, workspace_id: agent.workspace_id!, agent };
    },
    prompt: async (_agent: AgentInfo, text: string) => { prompts.push(text); if (fail) throw Error('Timeout'); },
  };
  return { dir, state, agents, prompts, ops, now: () => now, advance: () => { now += BOSS_REVIEW_INTERVAL; }, hires: () => hires, fail: () => { fail = true; } };
}

test('construction does nothing; simultaneous clicks share one hire and review', async () => {
  const f = setup(), boss = new Boss(f.dir, f.ops, f.now);
  await Promise.resolve();
  expect(f.hires()).toBe(0); expect(f.prompts).toHaveLength(0);
  const results = await Promise.all([boss.click(), boss.click(), boss.click()]);
  expect(f.hires()).toBe(1); expect(f.prompts).toHaveLength(1);
  expect(new Set(results.map(r => r.pane_id)).size).toBe(1);
  expect(results[0].agent?.office_role).toBe('boss');
  expect(statSync(join(f.dir, 'boss.json')).mode & 0o777).toBe(0o600);
});

test('a normalized Boss launch name is reused before session metadata arrives', async () => {
  const f = setup(), hire = f.ops.hire;
  f.ops.hire = async () => {
    const hired = await hire();
    hired.agent.name = 'boss-2'; hired.agent.office_name = 'Boss'; hired.agent.agent_session = null;
    return hired;
  };
  const first = await new Boss(f.dir, f.ops, f.now).click();
  const next = await new Boss(f.dir, f.ops, f.now).click();
  expect(next.pane_id).toBe(first.pane_id); expect(next.reviewed).toBe(false); expect(f.hires()).toBe(1);
});

test('unchanged entries and restarts reuse the chat; only new or changed evidence is sent', async () => {
  const f = setup(); await new Boss(f.dir, f.ops, f.now).click();
  const boss = new Boss(f.dir, f.ops, f.now);
  expect((await boss.click()).reviewed).toBe(false);
  f.state.journal.push(entry('next', 2)); f.advance();
  expect((await boss.click()).reviewed).toBe(true);
  expect(f.hires()).toBe(1); expect(f.prompts).toHaveLength(2);
  const evidence = JSON.parse(f.prompts[1].split('JOURNAL EVIDENCE (new or changed entries, newest first):\n')[1].split('\n')[0]);
  expect(evidence.map((row: { title: string }) => row.title)).toEqual(['Shipped next']);
  expect(f.prompts[1]).toContain('OTHER RECENT THREADS'); // Older titles can inspire connections without resending their notes.
  f.state.journal[1].notes = 'Edited the evidence'; f.advance();
  expect((await boss.click()).reviewed).toBe(true);
  expect(f.prompts[2]).toContain('Edited the evidence');
});

test('Boss does not review his own output or send another prompt while occupied', async () => {
  const f = setup(), boss = new Boss(f.dir, f.ops, f.now); await boss.click();
  f.state.journal.push({ ...entry('boss-result', 3), contributors: ['boss-1'] });
  expect((await boss.click()).reviewed).toBe(false);
  f.advance(); f.state.journal.push(entry('next', 4)); f.agents[0].agent_status = 'working';
  expect((await boss.click()).message).toContain('occupied');
  expect(f.prompts).toHaveLength(1);
  f.agents[0].agent_status = 'idle'; await boss.click();
  expect(f.prompts).toHaveLength(2); expect(f.prompts[1]).not.toContain('boss-result');
});

test('uncertain delivery is never replayed by another click or a bridge restart', async () => {
  const f = setup(); f.fail();
  expect((await new Boss(f.dir, f.ops, f.now).click()).reviewed).toBe(false);
  expect((await new Boss(f.dir, f.ops, f.now).click()).reviewed).toBe(false);
  f.advance(); expect((await new Boss(f.dir, f.ops, f.now).click()).message).toContain('not confirmed');
  expect(f.hires()).toBe(1); expect(f.prompts).toHaveLength(1);
});

test('empty journal gets one first milestone suggestion, then free reopens', async () => {
  const f = setup(); f.state.journal = []; const boss = new Boss(f.dir, f.ops, f.now);
  expect((await boss.click()).reviewed).toBe(true);
  expect((await boss.click()).reviewed).toBe(false);
  expect(f.prompts).toHaveLength(1);
});

test('a creative direction update refreshes an unchanged journal once, only on the next click', async () => {
  const f = setup(); await new Boss(f.dir, f.ops, f.now).click();
  const path = join(f.dir, 'boss.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
  delete saved.briefStyle; writeFileSync(path, JSON.stringify(saved));
  const boss = new Boss(f.dir, f.ops, f.now);
  await boss.briefing(); expect(f.prompts).toHaveLength(1);
  expect((await boss.click()).reviewed).toBe(false); f.advance();
  expect((await boss.click()).reviewed).toBe(true);
  expect(f.prompts[1]).toContain('Shipped first');
  expect(f.hires()).toBe(1);
  expect((await new Boss(f.dir, f.ops, f.now).click()).reviewed).toBe(false);
  expect(f.prompts).toHaveLength(2);
});

test('a reused pane with a different session is never mistaken for Boss', async () => {
  const f = setup(), boss = new Boss(f.dir, f.ops, f.now); await boss.click();
  f.agents[0].agent_session = { kind: 'id', value: 'someone-else' };
  expect(boss.matches(f.agents[0])).toBe(false);
  expect((await boss.click()).reviewed).toBe(false); expect(f.hires()).toBe(1);
  f.advance(); await boss.click(); expect(f.hires()).toBe(2);
});

test('brief caps evidence and ignores sales even when they dominate the journal', () => {
  const f = setup();
  f.state.journal = Array.from({ length: 100 }, (_, n) => ({ ...entry(String(n), n), notes: 'x'.repeat(10000), title: 'y'.repeat(10000), url: 'z'.repeat(10000) }));
  f.state.journal.push({ ...entry('payment', 999), kind: 'sale' });
  const brief = bossBrief(f.state, {}, []);
  expect(brief.changed).toBeLessThanOrEqual(12);
  expect(brief.text.length).toBeLessThan(8500);
  expect(brief.text).not.toContain('payment');
  expect(bossBrief(f.state, brief.seen, []).changed).toBe(0);
});

test('briefing reads never launch agents, await the exact completed review, and persist the cards', async () => {
  const f = setup(); let latest = 0;
  const reply = JSON.stringify({ intro: 'A thought.', ideas: [{ title: 'A bookmark', evidence: 'Chat scrolling', why: 'Find useful replies', nextStep: 'Try one saved reply' }] });
  const ops = { ...f.ops, transcript: async () => ({ turns: [{ prompt: f.prompts[latest], reply }] }) };
  const boss = new Boss(f.dir, ops, f.now);
  expect((await boss.briefing()).state).toBe('empty'); expect(f.hires()).toBe(0);
  await boss.click(); f.agents[0].agent_status = 'working';
  expect((await boss.briefing()).state).toBe('thinking');
  f.agents[0].agent_status = 'idle';
  const ready = await boss.briefing(); expect(ready.state).toBe('ready'); expect(ready.briefing?.ideas[0].title).toBe('A bookmark');
  expect((await new Boss(f.dir, ops, f.now).briefing()).briefing).toEqual(ready.briefing);
  f.state.journal.push(entry('another', 9)); f.advance(); await boss.click();
  expect((await boss.briefing()).state).toBe('thinking'); // Old reply is not the new answer.
  latest = 1; expect((await boss.briefing()).state).toBe('ready');
  expect(f.prompts).toHaveLength(2);
});

test('blocked and malformed replies give a recovery state without replaying the request', async () => {
  const f = setup();
  const boss = new Boss(f.dir, { ...f.ops, transcript: async () => ({ turns: [{ prompt: f.prompts[0], reply: '{"ideas":[' }] }) });
  await boss.click(); f.agents[0].agent_status = 'blocked';
  expect((await boss.briefing()).state).toBe('attention');
  f.agents[0].agent_status = 'idle'; expect((await boss.briefing()).state).toBe('attention');
  expect(f.prompts).toHaveLength(1);
});

test('Claude shortened metadata still produces the exact requested briefing', async () => {
  const f = setup();
  const boss = new Boss(f.dir, { ...f.ops, transcript: async () => parseTranscript([
    JSON.stringify({ type: 'user', message: { content: f.prompts[0] } }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: f.prompts[0].slice(0, 200) + '…' }),
    JSON.stringify({ type: 'assistant', message: { content: JSON.stringify({ intro: 'An idea.', ideas: [{ title: 'A room with a memory', evidence: 'The studio journal', why: 'Let the room celebrate progress', nextStep: 'Prototype a changing wall' }] }) } }),
  ]) });
  await boss.click(); expect((await boss.briefing()).state).toBe('ready');
  expect(f.prompts).toHaveLength(1);
});

test('idle without a matching answer offers recovery after a short grace period; checking never resends', async () => {
  const f = setup(); let now = 1000, finished = false;
  const boss = new Boss(f.dir, { ...f.ops, transcript: async () => ({ turns: finished ? [{ prompt: f.prompts[0], reply: JSON.stringify({ ideas: [{ title: 'Idea', evidence: 'Journal', why: 'A new experience', nextStep: 'Try a prototype' }] }) }] : [] }) }, () => now);
  await boss.click(); expect((await boss.briefing()).state).toBe('thinking');
  now += 15_001;
  expect((await boss.briefing()).state).toBe('attention');
  finished = true; expect((await boss.briefing()).state).toBe('ready');
  expect(f.prompts).toHaveLength(1);
});

test('the daily limit survives restarts, new journal entries, and a closed Boss session', async () => {
  const f = setup(), boss = new Boss(f.dir, f.ops, f.now); await boss.click();
  f.state.journal.push(entry('new-work', 4));
  const limited = await new Boss(f.dir, f.ops, f.now).click();
  expect(limited.reviewed).toBe(false); expect(limited.nextReviewAt).toBe(f.now() + BOSS_REVIEW_INTERVAL);
  f.agents.length = 0;
  expect((await new Boss(f.dir, f.ops, f.now).click()).reviewed).toBe(false);
  expect(f.hires()).toBe(1); expect(f.prompts).toHaveLength(1);
  f.advance(); expect((await new Boss(f.dir, f.ops, f.now).click()).reviewed).toBe(true);
  expect(f.hires()).toBe(2); expect(f.prompts).toHaveLength(2);
});

test('completed briefings are archived without an open scene, deduplicated, and survive session loss', async () => {
  const f = setup(), turns: { prompt: string; reply: string; at: number }[] = [];
  const ops = { ...f.ops, transcript: async () => ({ turns }) };
  const boss = new Boss(f.dir, ops, f.now);
  for (let n = 0; n < 2; n++) {
    f.state.journal.push(entry(`day-${n}`, n + 2));
    await boss.click();
    turns.push({ prompt: f.prompts[n], at: f.now(), reply: JSON.stringify({ intro: `Day ${n}`, ideas: [{ title: `Idea ${n}`, evidence: 'The journal', why: 'A new experience', nextStep: 'A small prototype' }] }) });
    boss.capture(f.agents[0]); await boss.briefing();
    if (!n) f.advance();
  }
  expect((await boss.archive()).briefings.map(b => b.intro)).toEqual(['Day 1', 'Day 0']);
  expect((await boss.archive()).total).toBe(2);
  f.agents.length = 0;
  const restored = new Boss(f.dir, ops, f.now);
  expect((await restored.archive()).total).toBe(2);
  expect((await restored.briefing()).state).toBe('ready');
  expect(f.prompts).toHaveLength(2);
});

test('a closed Boss can still have his final answer recovered from his saved session', async () => {
  const f = setup();
  const ops = { ...f.ops, transcript: async () => ({ turns: [{ prompt: f.prompts[0], reply: JSON.stringify({ ideas: [{ title: 'Recovered', evidence: 'Journal', why: 'Useful', nextStep: 'Try it' }] }) }] }) };
  const boss = new Boss(f.dir, ops, f.now); await boss.click(); f.agents.length = 0;
  expect((await new Boss(f.dir, ops, f.now).archive()).briefings[0].ideas[0].title).toBe('Recovered');
  expect(f.hires()).toBe(1); expect(f.prompts).toHaveLength(1);
});

test('archive pages are stable and no older briefings are discarded', async () => {
  const f = setup();
  const archive = Array.from({ length: 25 }, (_, n) => ({ id: `saved-${n}`, at: n, intro: `Day ${n}`, ideas: [{ title: 'Idea', evidence: 'Journal', why: 'Useful', nextStep: 'Try it' }] }));
  writeFileSync(join(f.dir, 'boss.json'), JSON.stringify({ seen: {}, employees: [], archive }));
  const boss = new Boss(f.dir, f.ops, f.now), first = await boss.archive(), second = await boss.archive(first.cursor), third = await boss.archive(second.cursor);
  expect(first.total).toBe(25); expect(first.briefings).toHaveLength(10); expect(third.briefings).toHaveLength(5);
  expect(third.cursor).toBeNull();
  expect(new Set([...first.briefings, ...second.briefings, ...third.briefings].map(b => b.id)).size).toBe(25);
  expect(f.hires()).toBe(0); expect(f.prompts).toHaveLength(0);
});

test('front desk searches the full idea archive without requesting a review', async () => {
  const f = setup();
  const archive = Array.from({ length: 30 }, (_, n) => ({ id: `saved-${n}`, at: n, intro: `Day ${n}`, ideas: [{ title: n === 0 ? 'Nebula launch' : 'Idea', evidence: n % 2 ? 'Searchable journal evidence' : 'Journal', why: 'Useful', nextStep: 'Try it' }] }));
  writeFileSync(join(f.dir, 'boss.json'), JSON.stringify({ seen: {}, employees: [], archive }));
  const boss = new Boss(f.dir, f.ops, f.now);
  expect((await boss.archive(undefined, 'NEBULA')).briefings.map(b => b.id)).toEqual(['saved-0']);
  const first = await boss.archive(undefined, 'Searchable'), next = await boss.archive(first.cursor, 'Searchable');
  expect(first.total).toBe(15); expect(first.briefings).toHaveLength(10); expect(next.briefings).toHaveLength(5);
  expect(next.cursor).toBeNull();
  await expect(boss.archive(undefined, 'x'.repeat(501))).rejects.toThrow('500');
  expect(f.hires()).toBe(0); expect(f.prompts).toHaveLength(0);
});

test('focused reviews exclude other projects and retain selected milestones even with no journal', () => {
  const f = setup();
  f.state.projects = [
    {id:'/game',name:'Game',version:0,notes:'',color:'blue',goals:[{id:'g',title:'Game launch',done:false}]},
    {id:'/other',name:'Other',version:0,notes:'',color:'blue',goals:[{id:'o',title:'Other launch',done:false}]},
  ] as StudioState['projects'];
  f.state.journal.push({...entry('private-other'),project:'/other'});
  const brief = bossBrief(f.state,{},[], '/game');
  expect(brief.text).toContain('Game launch');
  expect(brief.text).not.toContain('private-other');
  expect(brief.text).not.toContain('Other launch');
  f.state.journal = [];
  expect(bossBrief(f.state,{},[], '/game').text).toContain('Game launch');
});

test('project selection is validated before hiring and daily limits are scoped and durable', async () => {
  const f = setup(), boss = new Boss(f.dir,f.ops,f.now);
  f.state.projects = [{id:'/game',name:'Game',version:0,notes:'',color:'blue',goals:[]}] as StudioState['projects'];
  await expect(boss.click(undefined,'/missing')).rejects.toThrow('no longer available');
  expect(f.hires()).toBe(0);
  await boss.click();
  expect((await boss.click(undefined,'/game')).reviewed).toBe(true);
  expect(f.prompts[1]).toContain('Only project "Game"');
  const restored = new Boss(f.dir,f.ops,f.now);
  expect((await restored.click(undefined,'/game')).reviewed).toBe(false);
  expect((await restored.click()).reviewed).toBe(false);
  expect(f.prompts).toHaveLength(2);
});
