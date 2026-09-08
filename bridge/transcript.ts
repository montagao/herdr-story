import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promptWithImages, type ConversationTurn, type PromptImage } from '../shared/prompt-images';
import type { Outcome } from './outcome';
// What an agent said, from its own session transcript — the honest source, unaffected by what
// happens to fit on a terminal screen. Claude Code keeps one JSONL per session under
// ~/.claude/projects; Codex keeps rollouts under ~/.codex/sessions. Both are append-only, so the
// tail holds the latest turn.
export interface Turn extends ConversationTurn {}
export interface Transcript { completedAt?: number; prompt?: string; reply?: string; title?: string; turns: Turn[] }
const KEEP_TURNS = 12;

const text = (blocks: unknown, kinds: string[]) =>
  Array.isArray(blocks) ? blocks.filter((b: any) => b && kinds.includes(b.type) && typeof b.text === 'string').map((b: any) => b.text as string).join('\n').trim() : typeof blocks === 'string' ? blocks.trim() : '';

function inlineImages(blocks: unknown): PromptImage[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(b => b?.type === 'image' || b?.type === 'input_image').slice(0, 16).map((b, i) => ({
    name: `Image ${i + 1}`, key: createHash('sha256').update(String(b.image_url ?? b.source?.data ?? b.source?.url ?? i)).digest('hex'),
  }));
}

/** Oldest to newest; the last of each kind wins. */
export function parseTranscript(lines: string[], initial?: Transcript): Transcript {
  const out: Transcript = initial ? structuredClone(initial) : { turns: [] };
  // a prompt opens a turn; every assistant text after it is that turn's reply so far, the last one
  // standing when the next prompt arrives (Claude stamps each record; Codex does not)
  const when = (row: any) => { const t = Date.parse(row?.timestamp); return Number.isFinite(t) ? t : undefined; };
  const asked = (raw: string, blocks: unknown, at?: number) => {
    const { text: words, images } = promptWithImages(raw, inlineImages(blocks));
    const p = words || (images.length ? 'Image attached' : '');
    if (!p && !images.length) return;
    if (p === out.prompt && JSON.stringify(images) === JSON.stringify(out.turns.at(-1)?.images ?? [])) return;
    out.prompt = p; delete out.reply; delete out.completedAt;
    out.turns.push({ prompt: p, at, ...(images.length ? { images } : {}) });
    if (out.turns.length > KEEP_TURNS) out.turns.shift();
  };
  const replied = (r: string, at?: number) => { out.reply = r; const turn = out.turns.at(-1) ?? (out.turns.push({}), out.turns[0]); turn.reply = r; turn.at = at ?? turn.at; };
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: any; try { row = JSON.parse(line); } catch { continue; }
    // Claude's last-prompt records are abbreviated metadata, sometimes written between the
    // actual user message and its answer. They must not open a turn or end the backwards search
    // for the full user message: doing either detaches answers from their real prompt.
    if (row?.type === 'event_msg' && row.payload?.type === 'task_complete') {
      if (typeof row.payload.last_agent_message === 'string' && row.payload.last_agent_message.trim()) {
        replied(row.payload.last_agent_message.trim(), when(row));
        out.completedAt = when(row);
      }
    } else if (row?.type === 'event_msg' && ['task_started', 'turn_aborted'].includes(row.payload?.type)) {
      delete out.completedAt;
    } else if (row?.type === 'ai-title' && typeof row.aiTitle === 'string') out.title = row.aiTitle.trim() || out.title;
    else if (row?.type === 'user' && !row.isMeta && row.message) {
      const c = row.message.content;
      if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) continue;
      asked(text(c, ['text']), c, when(row));
    } else if (row?.type === 'assistant' && row.message) {
      const r = text(row.message.content, ['text']); if (r) replied(r, when(row));
    } else if (row?.type === 'response_item' && row.payload?.type === 'message') {
      const c = row.payload.content;
      if (row.payload.role === 'user') asked(text(c, ['input_text']), c, when(row));
      else if (row.payload.role === 'assistant') { const r = text(c, ['output_text']); if (r) replied(r, when(row)); }
    }
  }
  return out;
}

/** The turn that produced a journal entry: the newest reply written before the entry was recorded
 *  and after the work began, allowing a minute of slack either way. */
export function turnFor(t: Transcript, at: number, minutes = 1): Turn | undefined {
  return [...t.turns].reverse().find(turn => turn.reply && turn.at !== undefined && turn.at <= at + 60_000 && turn.at >= at - (minutes + 2) * 60_000);
}

/** A journal entry's outcome from its own turn, clipped the way the journal keeps replies. A
 *  transcript's latest reply is never taken on trust: herdr's session id for a pane can go stale
 *  when a new conversation starts in it, and then the file's last reply belongs to an old task. */
export function outcomeFor(t: Transcript, at: number, minutes = 1): Outcome | undefined {
  const turn = turnFor(t, at, minutes);
  if (!turn?.reply) return undefined;
  return { prompt: turn.prompt, summary: turn.reply.length > 900 ? turn.reply.slice(0, 900).replace(/\s+\S*$/, '') + '…' : turn.reply };
}

/** Whether the transcript is telling the same story as the pane's screen. The screen's prompt is
 *  wrapped and cut, so the opening words are compared; with nothing on screen the transcript stands. */
export function promptAgrees(t: Transcript | undefined, seen: string | undefined): boolean {
  if (!t?.prompt) return false;
  if (!seen) return true;
  const norm = (s: string) => s.replace(/[…]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(t.prompt), b = norm(seen);
  const head = Math.min(40, a.length, b.length);
  return head > 0 && a.slice(0, head) === b.slice(0, head);
}

/** Join chronological chunks, attaching a reply whose prompt fell into the preceding chunk. */
function prependTranscript(older: Transcript, newer: Transcript): Transcript {
  const turns = older.turns.map(turn => ({ ...turn }));
  for (const turn of newer.turns) {
    if (!turn.prompt && turns.length) Object.assign(turns[turns.length - 1], turn);
    else turns.push({ ...turn });
  }
  return { completedAt: newer.prompt ? newer.completedAt : newer.completedAt ?? older.completedAt, prompt: newer.prompt ?? older.prompt, reply: newer.prompt ? newer.reply : newer.reply ?? older.reply,
    title: newer.title ?? older.title, turns: turns.slice(-KEEP_TURNS) };
}

/** Start at the tail, then walk back until the last real prompt is found. Long tool output can
 *  push even the latest prompt several megabytes back. Parse one chunk at a time and cache by
 *  file size, so an idle agent's subsequent polls still cost only a stat. */
type ParsedFile = { size: number; mtime: number; ino: number; transcript: Transcript; partial: Buffer; guard: Buffer };
const parsed = new Map<string, ParsedFile>();
const pending = new Map<string, Promise<Transcript>>();
function consume(bytes: Buffer, previous?: Transcript) {
  const last = bytes.lastIndexOf(10);
  const complete = bytes.subarray(0, last + 1), tail = bytes.subarray(last + 1);
  // A JSONL writer may not have appended its newline yet. Only retain an incomplete record.
  let partial = tail;
  const lines = complete.toString('utf8').split('\n');
  if (tail.length) { try { JSON.parse(tail.toString('utf8')); lines.push(tail.toString('utf8')); partial = Buffer.alloc(0); } catch {} }
  return { transcript: parseTranscript(lines, previous), partial };
}
export function readTranscript(path: string, maxBytes = 1_500_000): Promise<Transcript> {
  const waiting = pending.get(path); if (waiting) return waiting;
  const request = readFileTranscript(path, maxBytes).finally(() => { if (pending.get(path) === request) pending.delete(path); });
  pending.set(path, request); return request;
}
async function readFileTranscript(path: string, maxBytes: number): Promise<Transcript> {
  const info = await stat(path), file = Bun.file(path), size = info.size;
  const cached = parsed.get(path);
  const guard = Buffer.from(await file.slice(Math.max(0, size - 128), size).arrayBuffer());
  // Some filesystems expose coarse timestamps: a same-size rewrite can share the old mtime.
  if (cached && cached.size === size && cached.mtime === info.mtimeMs && cached.ino === info.ino && guard.equals(cached.guard)) return cached.transcript;
  const remember = (transcript: Transcript, partial: Buffer) => {
    parsed.delete(path); parsed.set(path, { size, mtime: info.mtimeMs, ino: info.ino, transcript, partial, guard });
    while (parsed.size > 64) parsed.delete(parsed.keys().next().value!);
    return transcript;
  };
  if (cached && cached.ino === info.ino && size > cached.size) {
    const previousTail = Buffer.from(await file.slice(Math.max(0, cached.size - 128), cached.size).arrayBuffer());
    if (previousTail.equals(cached.guard)) {
      let transcript = cached.transcript, partial = cached.partial;
      // Read just appended records, with a bounded I/O chunk; preserve split UTF-8/JSON records.
      for (let offset = cached.size; offset < size; offset += 262_144) {
        const bytes = Buffer.concat([partial, Buffer.from(await file.slice(offset, Math.min(size, offset + 262_144)).arrayBuffer())]);
        ({ transcript, partial } = consume(bytes, transcript));
      }
      return remember(transcript, partial);
    }
  }
  // First encounter, replacement, or truncation: walk backwards until the latest prompt is found.
  let transcript: Transcript = { turns: [] }, end = size, partial: Buffer = Buffer.alloc(0), unfinished: Buffer = Buffer.alloc(0), first = true;
  const chunkSize = Math.max(1, Math.floor(maxBytes));
  while (end > 0) {
    const start = Math.max(0, end - chunkSize);
    let chunk = Buffer.concat([Buffer.from(await file.slice(start, end).arrayBuffer()), partial]);
    partial = Buffer.alloc(0);
    if (start > 0) { const newline = chunk.indexOf(10); partial = chunk.subarray(0, newline < 0 ? chunk.length : newline + 1); chunk = newline < 0 ? Buffer.alloc(0) : chunk.subarray(newline + 1); }
    if (chunk.length) {
      const consumed = consume(chunk);
      if (first) { unfinished = consumed.partial; first = false; }
      transcript = prependTranscript(consumed.transcript, transcript);
    }
    if (transcript.prompt) break;
    end = start;
  }
  return remember(transcript, unfinished);
}
