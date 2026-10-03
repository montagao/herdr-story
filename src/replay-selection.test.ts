import { expect, test } from 'bun:test';
import { projectReplay, replayHighlights, replayUSD } from './replay-selection';
import type { ReplayData, ReplayMoment } from '../shared/replay';
import type { DemoSnapshot } from '../shared/demo';
import demo from '../public/demo/office.json';
const snapshot = structuredClone(demo) as unknown as DemoSnapshot;
const data: ReplayData = { from:0, to:86400000, recordedSince:0, snapshot, moments:[] };

test('USD combines reference currencies, including refunds, without hiding missing rates', () => {
  expect(replayUSD({USD:29,EUR:9.2,GBP:-7.8}, {eur:.92,gbp:.78})).toEqual({amount:29,estimated:true,missing:[]});
  expect(replayUSD({USD:29,ZZZ:50}, {})).toEqual({amount:29,estimated:false,missing:['ZZZ']});
  expect(replayUSD({EUR:5}, {eur:0}).missing).toEqual(['EUR']);
});

test('project filtering handles pane transfers and leaves unassigned money out', () => {
  const agent = {pane_id:'a',agent:'claude',agent_status:'working' as const,cwd:'/garden'};
  const history: ReplayData = {...data, snapshot:{...snapshot,agents:[agent]}, moments:[
    {id:'move',at:100,kind:'agent',pane:'a',agent:{...agent,cwd:'/lantern'}},
    {id:'sale',at:200,kind:'money',event:{id:'sale',ts:200,kind:'sale',amount:9,currency:'usd',label:'Garden in description'}},
  ]};
  expect(projectReplay(history,'/garden').moments).toEqual([{id:'move',at:100,kind:'agent',pane:'a',agent:null}]);
  expect(projectReplay(history,'').moments.map(m => m.id)).toEqual(['sale']);
  expect(history.moments[0]).toMatchObject({agent:{cwd:'/lantern'}});
});

test('daily highlights cover the day without deleting the full history or totals', () => {
  const moments: ReplayMoment[] = Array.from({length:120}, (_,i) => ({id:String(i),at:1000+i*700000,kind:'journal',entry:{...snapshot.studio.journal[0],id:String(i),at:1000+i*700000,kind:'task'}}));
  const history = {...data,moments};
  expect(replayHighlights(history,'highlights').length).toBeLessThanOrEqual(12);
  expect(replayHighlights(history,'all')).toHaveLength(120);
  expect(replayHighlights(history,'payments')).toHaveLength(0);
  expect(history.moments).toHaveLength(120);
});
