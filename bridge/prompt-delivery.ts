import type { AgentInfo } from '../shared/types';

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export interface DeliveryOptions {
  /** How long to wait for a just-started agent to become ready for input before typing. */
  readyTimeoutMs?: number;
  /** How long to keep watching for proof of submission after herdr's own wait gives up. */
  verifyMs?: number;
  /** A desk that was just started: nothing is typed until Claude has drawn its input box. Other
   *  desks only wait while the screen shows the signs of starting up. */
  fresh?: boolean;
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
/** Claude asking whether to trust the folder it was started in; Enter takes "Yes, proceed". */
const TRUST_PROMPT = /trust the files in this (folder|directory)/i;
/** What a Claude screen shows before it can take typing. */
const STARTING = /Welcome to Claude Code|Loading…|Checking for updates|trust the files in this|Press Enter to continue/i;
/** Claude's spinner: a glyph, a phase, an ellipsis — "✻ Thinking… (esc to interrupt)". */
const BUSY = /esc to interrupt|[✻✽✶✳✢·]\s+\S[^\n]*…/;
/** A Claude screen with its input box drawn is a Claude that will take typing. */
export const inputBoxVisible = (screen: string) => unsentInput(screen) !== undefined;

/** A terminal write is not proof that Claude consumed Enter, especially while loading images.
 *  Use Herdr's observed state-change wait; never replay text or send a speculative extra Enter.
 *
 *  Two things made the first message to a new desk look like a failed delivery: typing into an
 *  agent that was still starting, and giving up six seconds after submitting when a fresh
 *  session's first turn takes longer than that to show its spinner. Herdr's readiness flags are
 *  not enough for the first: on a fresh desk they are usually absent, and a splash screen or the
 *  folder-trust question swallows anything typed at it. So readiness is read off the screen —
 *  the input box is drawn — with the trust question answered once on the way. When herdr's wait
 *  times out, keep watching for a while. A status change, or the input box emptied with the
 *  message echoed above it, is proof of submission. The message still sitting in the box is
 *  proof it was not. An empty box with the message nowhere on screen means it never arrived,
 *  which is the one outcome that is safe to send again. */
export async function deliverPrompt(call: Call, kind: string, target: string, text: string, options: DeliveryOptions = {}) {
  const sleep = options.sleep ?? pause, readyTimeoutMs = options.readyTimeoutMs ?? 45_000, verifyMs = options.verifyMs ?? 15_000;
  const get = async () => { try { return (await call('agent.get', { target }) as { agent?: AgentInfo })?.agent; } catch { return undefined; } };
  const look = async () => { try { return String((await call('agent.read', { target, source: 'visible' }) as { read?: { text?: string } })?.read?.text ?? ''); } catch { return ''; } };
  let before = await get(), trusted = false;
  for (let waited = 0; waited < readyTimeoutMs; waited += 500) {
    if (kind === 'claude') {
      const screen = await look();
      if (!trusted && TRUST_PROMPT.test(screen)) { trusted = true; try { await call('agent.send_keys', { target, keys: ['Enter'] }); } catch { /* the wait below notices either way */ } }
      else if ((!before || ready(before)) && (inputBoxVisible(screen) || (!options.fresh && screen.trim() !== '' && !STARTING.test(screen)))) break;
    } else if (!before || ready(before)) break;
    await sleep(500); before = await get();
  }
  try {
    return await call('agent.prompt', {
      target, text,
      ...(kind === 'claude' ? { wait: { until: ['working', 'idle', 'done', 'blocked'], timeout_ms: 6_000 } } : {}),
    });
  } catch (error) {
    if (kind !== 'claude' || !STALLED.has(String((error as { code?: string })?.code))) throw error;
    const unsent = () => Object.assign(new Error('Claude has not confirmed submission. Check the terminal: if the message is still in its input box, press ↵ once to submit it. Do not resend the message.'), { code: 'uncertain' });
    const lost = () => Object.assign(new Error('Claude did not receive the message: its input box is empty and the message is not on screen. Send it again.'), { code: 'unsent', notSent: true });
    const head = text.split('\n')[0].trim().slice(0, 40);
    let lastBox: string | undefined, echoed = false, quiet = true;
    for (let waited = 0; waited < verifyMs; waited += 700) {
      const now = await get();
      if (now && before && ((now.state_change_seq ?? 0) > (before.state_change_seq ?? 0) || (before.agent_status !== 'working' && now.agent_status === 'working')))
        return { type: 'agent_prompted', agent: now, verified: 'status' };
      const screen = await look();
      const box = unsentInput(screen);
      if (box !== undefined) lastBox = box;
      if (head && screen.includes(head)) echoed = true;
      // Any sign of work, on screen or in status, and the message may be in flight after all.
      if (now?.agent_status === 'working' || BUSY.test(screen)) quiet = false;
      if (box && head && box.startsWith(head.slice(0, Math.min(head.length, box.length)))) throw unsent();
      if (box === '' && head && screen.includes(head)) return { type: 'agent_prompted', agent: now ?? before, verified: 'screen' };
      await sleep(700);
    }
    if (lastBox === '' && !echoed && quiet) throw lost();
    throw unsent();
  }
}
