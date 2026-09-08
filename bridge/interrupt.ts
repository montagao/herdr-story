import { agentKind, type AgentInfo } from '../shared/types';
type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/** Escape interrupts the current turn; it does not kill the agent or erase its conversation. */
export async function interruptAgent(call: Call, target: string, beforeStop: () => Promise<void> = async () => {}, sleep = (ms: number) => Bun.sleep(ms)) {
  const get = async () => ((await call('agent.list', {})) as { agents: AgentInfo[] }).agents.find(a => a.pane_id === target);
  const agent = await get();
  if (!agent || !['codex', 'claude'].includes(agentKind(agent))) throw Error('Stop is supported for active Codex and Claude agents.');
  if (agent.agent_status !== 'working') throw Error('This agent is no longer working.');
  await beforeStop();
  await call('agent.send_keys', { target, keys: ['Escape'] });
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const current = await get();
    if (!current || JSON.stringify(current.agent_session) !== JSON.stringify(agent.agent_session)) throw Error('Agent session changed while stopping. Check its terminal.');
    if (['idle', 'done', 'blocked'].includes(current.agent_status)) return { stopped: true, prompt: agent.last_prompt ?? '', status: current.agent_status };
  }
  throw Error('Stop requested, but the agent has not stopped yet. Check its live output before trying again.');
}
