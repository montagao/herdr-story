// What an agent said it did, read off its pane when a task finishes.
//
// Both coding agents draw a turn the same way: the person's prompt on a `›` (Codex) or `❯`
// (Claude) line, tool calls and replies as `•`/`●`/`⏺` blocks, and a closing rule — Codex's
// "─ Worked for 10m 12s ─", Claude's "✻ Baked for 16s · done". The reply worth keeping is the last
// text block before the rule: the agent's own account of the work. The prompt that led to it is the
// nearest one *above* it — a prompt typed after the reply is the next task, not this one.
import { genericTitle } from '../shared/types';

export interface Outcome { prompt?: string; summary?: string }
/** What a pane is on right now: the latest prompt, and the head of the latest block after it. */
export interface Current { prompt?: string; activity?: string }

const PROMPT = /^\s*[›❯](?:\s+(.*\S))?\s*$/;
const MARK = /^[•●⏺]\s+(.*)$/;
const RULE = /^\s*[─═]{4,}/;
/** The empty input box, and the hints agents print in it. */
const PLACEHOLDER = /^(?:Ask Codex to do anything|Try ["“]|Type your|\/\w+$)/;
/** Codex tool lines lead with a verb and a target; Claude's are Name(args). */
const CODEX_TOOL = /^(?:Ran|Edited|Viewed|Waited|Read|Searched|Listed|Explored|Called|Fetched)\b|^(?:Added|Deleted|Wrote|Created|Removed)\s+\S*[/.]\S*/;
const CLAUDE_TOOL = /^[A-Z][A-Za-z]*\(|^Running(?: \d+)? (?:shell )?commands?…|^Running…/;
/** The line that closes a task: Claude's "✻ Baked for 16s · done", Codex's "─ Worked for 10m ─". */
const DONE = /^\s*[✻✽✶✳✢·]\s.*·\s*done\b|Worked for \d/;
/** Status bars, footers and spinners that sit between or after blocks. */
const NOISE = /ctrl \+ t to view transcript|^\s*⚠|bypass permissions|\/ps to view|new task\? \/clear|^\s*[✻✽✶✳✢]\s|Worked for \d|^\s*⏵|tokens\s*$|Update installed · Restart/;

export function extractOutcome(text: string): Outcome {
  type Block = { kind: 'prompt' | 'text' | 'tool' | 'done'; lines: string[] };
  const blocks: Block[] = [];
  let open: Block | undefined;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (DONE.test(line)) { open = undefined; blocks.push({ kind: 'done', lines: [] }); continue; }
    const prompt = PROMPT.exec(line);
    if (prompt) { open = undefined; if (prompt[1] && !PLACEHOLDER.test(prompt[1])) blocks.push({ kind: 'prompt', lines: [prompt[1]] }); continue; }
    const mark = MARK.exec(line);
    if (mark) { open = { kind: CODEX_TOOL.test(mark[1]) || CLAUDE_TOOL.test(mark[1]) ? 'tool' : 'text', lines: [mark[1]] }; blocks.push(open); continue; }
    if (RULE.test(line) || NOISE.test(line)) { open = undefined; continue; }
    if (open?.kind === 'text' && (line.trim() || open.lines.at(-1)?.trim())) open.lines.push(line.replace(/^ {1,2}/, ''));
  }
  // Whatever follows the last closing rule is the next task starting, not this one finishing.
  const kinds = blocks.map(b => b.kind), end = kinds.lastIndexOf('done');
  const index = kinds.lastIndexOf('text', end < 0 ? kinds.length - 1 : end);
  if (index < 0) return {};
  const prompt = blocks.slice(0, index).reverse().find(b => b.kind === 'prompt')?.lines[0];
  return { prompt: prompt ? clip(prompt.trim(), 300) : undefined, summary: clip(blocks[index].lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), 900) };
}

/** The latest prompt on screen and what the agent was last seen doing after it — for a busy pane,
 *  the task in hand; for an idle one, the task it just finished. Only the visible screen is
 *  needed, which herdr hands out while a pane is working. */
export function extractCurrent(text: string): Current {
  let prompt: string | undefined, activity: string | undefined;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const p = PROMPT.exec(line);
    if (p) { if (p[1] && !PLACEHOLDER.test(p[1])) { prompt = p[1].trim(); activity = undefined; } continue; }
    const mark = MARK.exec(line);
    if (mark) { activity = mark[1].trim(); continue; }
    // Claude's spinner names the phase and the time spent: the liveliest sign of work
    const spin = /^\s*[✻✽✶✳✢·]\s+(\S.*?…)/.exec(line);
    if (spin && !DONE.test(line)) activity = spin[1];
  }
  return { prompt: prompt && clip(prompt, 300), activity: activity && clip(activity.replace(/\s+·\s+ctrl \+ t.*$/, ''), 120) };
}

/** Cut long text at a sentence or line end where possible. */
export function clip(s: string, max: number) {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'), head.lastIndexOf('; '));
  return (stop > max * 0.5 ? head.slice(0, stop + 1) : head.replace(/\s+\S*$/, '')).trim() + '…';
}

/** A title for the journal. Claude names its window after the task; Codex names it after the
 *  folder, which the entry already records as the project — so a title that is just the project
 *  is replaced by what the person asked for, or failing that by the reply's first line. */
export function taskTitle(title: string, project: string, outcome?: Outcome) {
  if (!genericTitle(title, project)) return title;
  // a prompt often names a file by its full path; the title only has room for the file
  const headline = (s?: string) => s && clip(s.split('\n').find(l => l.trim())?.replace(/^[#*\-•\s]+/, '').replace(/[:：]\s*$/, '').replace(/\S*\/(\S+)/g, (m, tail) => m.length > 32 ? tail : m).trim() || '', 120);
  return headline(outcome?.prompt) || headline(outcome?.summary) || title || 'Completed task';
}
