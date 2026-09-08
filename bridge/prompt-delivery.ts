import type { AgentInfo } from '../shared/types';

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface DeliveryOptions {
  /** How long to wait for a just-started agent to become ready for input before typing. */
  readyTimeoutMs?: number;
  /** How long to keep watching for proof of submission after herdr's own wait gives up. */
  verifyMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const STALLED = new Set(['agent_prompt_stalled', 'agent_wait_timeout', 'timeout']);

/** Where a Claude screen keeps its input box: the ❯ line between the last two rules. What sits
 *  on that line after ❯ is text that has not been submitted. */
export function unsentInput(screen: string): string | undefined {
  const lines = screen.split('\n');
  const rule = (l: string) => /^\s*[─-╿]{6,}\s*$/.test(l);
  let last = -1, prev = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (rule(lines[i])) { if (last < 0) last = i; else { prev = i; break; } }
  if (last < 0 || prev < 0) return undefined;
  const box = lines.slice(prev + 1, last).find(l => /^\s*[❯›>]/.test(l));
  return box?.replace(/^\s*[❯›>]\s?/, '').trim();
}

const ready = (a: AgentInfo | undefined) => !!a && !a.launch_pending && a.interactive_ready !== false && a.agent_status !== 'unknown';

/** A terminal write is not proof that Claude consumed Enter, especially while loading images.
 *  Use Herdr's observed state-change wait; never replay text or send a speculative extra Enter.
 *
 *  Two things made the first message to a new desk look like a failed delivery: typing into an
 *  agent that was still starting, and giving up six seconds after submitting when a fresh
 *  session's first turn takes longer than that to show its spinner. So: wait for the agent to
 *  report itself ready before typing, and when herdr's wait times out, keep watching for a
 *  while. A status change, or the input box emptied with the message echoed above it, is
 *  proof of submission. The message still sitting in the box is proof it was not. */
export async function deliverPrompt(call: Call, kind: string, target: string, text: string, options: DeliveryOptions = {}) {
  const sleep = options.sleep ?? pause, readyTimeoutMs = options.readyTimeoutMs ?? 20_000, verifyMs = options.verifyMs ?? 15_000;
  const get = async () => { try { return (await call('agent.get', { target }) as { agent?: AgentInfo })?.agent; } catch { return undefined; } };
  let before = await get();
  for (let waited = 0; before && !ready(before) && waited < readyTimeoutMs; waited += 500) { await sleep(500); before = await get(); }
  try {
    return await call('agent.prompt', {
      target, text,
      ...(kind === 'claude' ? { wait: { until: ['working', 'idle', 'done', 'blocked'], timeout_ms: 6_000 } } : {}),
    });
  } catch (error) {
    if (kind !== 'claude' || !STALLED.has(String((error as { code?: string })?.code))) throw error;
    const unsent = () => Object.assign(new Error('Claude has not confirmed submission. Check the terminal: if the message is still in its input box, press ↵ once to submit it. Do not resend the message.'), { code: 'uncertain' });
    const head = text.split('\n')[0].trim().slice(0, 40);
    for (let waited = 0; waited < verifyMs; waited += 700) {
      const now = await get();
      if (now && before && ((now.state_change_seq ?? 0) > (before.state_change_seq ?? 0) || (before.agent_status !== 'working' && now.agent_status === 'working')))
        return { type: 'agent_prompted', agent: now, verified: 'status' };
      try {
        const screen = String((await call('agent.read', { target, source: 'visible' }) as { read?: { text?: string } })?.read?.text ?? '');
        const box = unsentInput(screen);
        if (box && head && box.startsWith(head.slice(0, Math.min(head.length, box.length)))) throw unsent();
        if (box === '' && head && screen.includes(head)) return { type: 'agent_prompted', agent: now ?? before, verified: 'screen' };
      } catch (inner) { if ((inner as { code?: string })?.code === 'uncertain') throw inner; }
      await sleep(700);
    }
    throw unsent();
  }
}
