import type { AgentInfo } from '../shared/types';

/** Read only the final terminal block before the input, never earlier conversation text. */
export function extractWaitNotice(text: string): AgentInfo['wait_notice'] {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').split('\n');
  let input = -1;
  lines.forEach((line, index) => { if (/^\s*❯/.test(line)) input = index; });
  if (input < 0) return null;
  const tail = lines.slice(Math.max(0, input - 14), input);
  const retry = tail.findIndex(line => /(?:·|⎿)\s*Retrying in\b/i.test(line));
  if (retry >= 0) {
    if (tail.slice(retry + 1).some(line => /^\s*[●⏺✻✽✶✳✢]/.test(line))) return null;
    // Claude wraps the attempt counter onto another line in narrow panes.
    const detail = tail[retry].slice(tail[retry].search(/Retrying in/i)).replace(/[·\s]+$/, '');
    const attempt = tail.slice(retry, retry + 3).join(' ').match(/attempt\s+\d+\/\d+/i)?.[0];
    const limited = /rate.?limit|usage limit|session limit|hit your limit/i.test(tail.slice(Math.max(0, retry - 1), retry + 2).join(' '));
    return { kind: limited ? 'rate_limit' : 'retry', detail: detail + (attempt && !detail.includes(attempt) ? ` · ${attempt}` : '') };
  }
  const limit = tail.findIndex(line => /^\s*(?:⎿\s*)?(?:You've hit your limit|You have hit your limit|Usage limit reached|Rate limit reached)/i.test(line));
  if (limit < 0 || tail.slice(limit + 1).some(line => /^\s*[●⏺✻✽✶✳✢]/.test(line))) return null;
  return { kind: 'rate_limit', detail: tail.slice(limit, limit + 2).join(' ').replace(/^\s*⎿\s*/, '').trim().slice(0, 240) };
}
