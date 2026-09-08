import { Database } from 'bun:sqlite';

type Call = (method: string, params: Record<string, unknown>) => Promise<any>;
export type NativeQueuedPrompt = { id: string; clientId: string; text: string };

/** Read the native queue, including all pages. A failed or incomplete read is never an empty
 * queue. Coalesce tabs and briefly cache results without retaining an unbounded prompt history. */
export class CodexQueueReader {
  private pending = new Map<string, Promise<NativeQueuedPrompt[]>>();
  private cache = new Map<string, { at: number; items: NativeQueuedPrompt[] }>();
  constructor(private call: Call, private now = Date.now) {}
  invalidate(thread: string) { this.cache.delete(thread); this.pending.delete(thread); }
  read(thread: string): Promise<NativeQueuedPrompt[]> {
    const pending = this.pending.get(thread); if (pending) return pending;
    const cached = this.cache.get(thread);
    if (cached && this.now() - cached.at < 2000) return Promise.resolve(cached.items);
    const request = this.fetch(thread).then(items => {
      if (this.pending.get(thread) !== request) return items;
      this.cache.delete(thread); this.cache.set(thread, { at: this.now(), items });
      let size = [...this.cache.values()].reduce((sum, entry) => sum + entry.items.reduce((n, item) => n + item.text.length, 0), 0);
      while (this.cache.size > 32 || size > 1_000_000) {
        const oldest = this.cache.keys().next().value!;
        size -= this.cache.get(oldest)!.items.reduce((n, item) => n + item.text.length, 0); this.cache.delete(oldest);
      }
      return items;
    }).finally(() => { if (this.pending.get(thread) === request) this.pending.delete(thread); });
    this.pending.set(thread, request); return request;
  }
  private async fetch(threadId: string) {
    const items: NativeQueuedPrompt[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.call('thread/queue/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data)) throw new Error('Codex queue status is unavailable.');
      for (const item of result.data) {
        if (typeof item?.id !== 'string' || !Array.isArray(item.input)) throw new Error('Invalid Codex queue status.');
        items.push({ id: item.id, clientId: item.clientUserMessageId ?? '',
          text: item.input.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') });
      }
      if (result.nextCursor === null) return items;
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) break;
      cursor = result.nextCursor; cursors.add(result.nextCursor);
    }
    throw new Error('Codex queue status was incomplete.');
  }
}

/** Standalone Codex terminals share this queue database without an app-server control socket.
 * Open it read-only for one consistent query; never create, migrate, or mutate Codex's state. */
export function localCodexQueue(path: string, thread: string) {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query('SELECT id, payload_json FROM queued_items WHERE thread_id = ? ORDER BY queue_order, id LIMIT 1001').all(thread) as { id: string; payload_json: string }[];
    if (rows.length > 1000) throw new Error('Codex queue status was incomplete.');
    const data = rows.map(row => {
      const payload = JSON.parse(row.payload_json);
      // Verified against a queued prompt in an isolated CODEX_HOME: SQLite uses the internal
      // UserInput enum, whereas the app-server protocol exposes the flattened input shape.
      const input = payload.UserInput?.content ?? payload.input;
      if (!Array.isArray(input)) throw new Error('Codex queue format is unsupported.');
      return { id: row.id, input, clientUserMessageId: payload.UserInput?.client_id ?? payload.clientUserMessageId ?? payload.client_user_message_id ?? '' };
    });
    return { data, nextCursor: null };
  } finally { db.close(); }
}
