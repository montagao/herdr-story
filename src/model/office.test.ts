import { expect, test } from 'bun:test';
import { OfficeModel } from './office';
import type { AgentInfo } from '../../shared/types';

const agent = (id: string): AgentInfo => ({ pane_id: id, cwd: `/projects/${id}`, agent_status: 'idle' } as AgentInfo);

test('Boss remains available for chat without taking a regular workstation', () => {
  const model = new OfficeModel();
  model.setAgents([agent('worker'), { ...agent('boss'), office_role: 'boss' }]);
  expect(model.agents.has('boss')).toBe(true);
  expect(model.pods).toHaveLength(1);
  expect(model.pods[0].seats.some(seat => seat === 'boss')).toBe(false);
});

test('the whole departing group keeps its desks until every agent is outside', () => {
  const model = new OfficeModel();
  model.setAgents([agent('one'), agent('two'), agent('working')]);
  model.beginDeparture('one'); model.beginDeparture('two');
  model.setAgents([agent('working')]);
  model.finishDeparture('one');
  expect(model.pods).toHaveLength(3);
  expect(model.isDeparting('one')).toBe(true);
  model.setAgents([agent('working'), agent('newcomer')]);
  model.finishDeparture('two');
  expect([...model.agents.keys()]).toEqual(['working', 'newcomer']);
  expect(model.pods).toHaveLength(2);
  expect(model.hasDepartures).toBe(false);
});

test('repeated departure completion cannot remove an unrelated or new agent', () => {
  const model = new OfficeModel();
  model.setAgents([agent('one'), agent('two')]);
  model.beginDeparture('one'); model.finishDeparture('one');
  model.setAgents([agent('one'), agent('two')]);
  model.finishDeparture('one'); model.finishDeparture('two');
  expect(model.agents.size).toBe(2);
});

test('a pane reused by a new session during the walk stays in the live office', () => {
  const model = new OfficeModel();
  model.setAgents([{ ...agent('one'), agent_session: { kind: 'id', value: 'old' } }]);
  model.beginDeparture('one');
  model.setAgents([{ ...agent('one'), agent_session: { kind: 'id', value: 'new' } }]);
  model.finishDeparture('one');
  expect(model.agents.get('one')?.agent_session?.value).toBe('new');
});
