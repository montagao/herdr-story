import { expect, test } from 'bun:test';
import { recordedWorkRanges, replayAnimationRate } from './replay-motion';
import type { ReplayData } from '../shared/replay';
import demo from '../public/demo/office.json';

test('work intervals stop on completion and exclude provider waits', () => {
  const agent = {pane_id:'a',agent:'claude',agent_status:'working' as const};
  const data = {from:0,to:1000,recordedSince:0,snapshot:{...demo,agents:[]},moments:[
    {id:'work',at:100,kind:'agent',pane:'a',agent},
    {id:'done',at:500,kind:'agent',pane:'a',agent:{...agent,agent_status:'done'}},
    {id:'limited',at:600,kind:'agent',pane:'a',agent:{...agent,wait_notice:{detail:'Rate limited'}}},
  ]} as unknown as ReplayData;
  expect(recordedWorkRanges(data)).toEqual([{from:100,to:500}]);
});

test('fast-forward visibly accelerates motion but leaves highlights readable', () => {
  expect(replayAnimationRate(1,true,false,false)).toBeGreaterThan(replayAnimationRate(1,false,false,false));
  expect(replayAnimationRate(4,true,false,false)).toBeLessThanOrEqual(8);
  expect(replayAnimationRate(4,true,true,false)).toBeLessThanOrEqual(3);
  expect(replayAnimationRate(4,true,false,true)).toBe(1);
});
