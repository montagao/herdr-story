import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

type Receipt = { fingerprint: string; state: 'pending' | 'confirmed'; at: number; result?: unknown };
const DAY = 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** JSON object order is irrelevant to the identity of a retried request. */
function canonical(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  if (json === undefined) return 'undefined';
  return json;
}
function uncertain(cause?: unknown) {
  const detail = cause instanceof Error ? ` ${cause.message}` : '';
  return Object.assign(new Error(`Delivery is unconfirmed. Check the agent's conversation before sending this as a new message.${detail}`),
    { code: 'uncertain', uncertain: true });
}

/** Idempotency for agent writes. A durable pending marker precedes every side effect.
 * An interrupted or failed delivery stays protected indefinitely; only confirmed receipts expire.
 * One instance owns a bridge's receipt file. Prompts are hashed, never stored in the receipt file. */
export class MessageReceipts {
  private records = new Map<string, Receipt>();
  private inflight = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private ready: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();
  private file?: string;
  constructor(private directory?: string) {
    this.file = directory ? join(directory, 'message-receipts.json') : undefined;
    this.ready = this.load();
    // Loading is reported to the first caller, not as an unhandled startup rejection.
    void this.ready.catch(() => {});
  }
  private async load() {
    if (!this.file || !this.directory) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let content: string;
    try { content = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const saved = JSON.parse(content);
    if (saved.version !== 1 || !Array.isArray(saved.receipts)) throw Error('Message receipt save is invalid; preserve it before restoring a backup.');
    for (const entry of saved.receipts) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[0])) throw Error('Invalid message receipt key.');
      const receipt = entry[1] as Receipt;
      if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !['pending', 'confirmed'].includes(receipt.state)
        || !Number.isFinite(receipt.at)) throw Error('Invalid message receipt.');
      this.records.set(entry[0], receipt);
    }
    await chmod(this.file, 0o600);
    this.prune();
  }
  private prune() {
    const confirmed = [...this.records.entries()].reverse().filter(([, receipt]) => receipt.state === 'confirmed').sort((a, b) => b[1].at - a[1].at);
    for (const [index, [key, receipt]] of confirmed.entries()) if (index >= 500 || Date.now() - receipt.at > DAY) this.records.delete(key);
  }
  private persist(): Promise<void> {
    if (!this.file || !this.directory) return Promise.resolve();
    const write = this.writeTail.then(async () => {
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, receipts: [...this.records] })); await file.sync(); }
        finally { await file.close(); }
        await rename(temp, this.file!);
        const directory = await open(this.directory!, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temp).catch(() => {}); }
    });
    this.writeTail = write.catch(() => {});
    return write;
  }
  /** A read-only reconciliation never invokes the delivery callback. */
  async status(key: string, id: unknown): Promise<{ state: 'unknown' | 'pending' | 'confirmed'; result?: unknown }> {
    if (typeof id !== 'string' || !id.trim() || id.length > 160) throw Object.assign(new Error('Invalid message_id.'), { code: 'invalid_params' });
    await this.ready; this.prune();
    const identity = digest(JSON.stringify([key, id]));
    if (this.inflight.has(identity)) return { state: 'pending' };
    const receipt = this.records.get(identity);
    if (!receipt) return { state: 'unknown' };
    return receipt.state === 'confirmed' ? { state: 'confirmed', result: structuredClone(receipt.result) } : { state: 'pending' };
  }
  run(key: string, id: unknown, payload: unknown, send: () => Promise<unknown>): Promise<unknown> {
    if (id === undefined) return Promise.resolve().then(send);
    if (typeof id !== 'string' || !id.trim() || id.length > 160) return Promise.reject(Object.assign(new Error('message_id must be a non-empty string up to 160 characters.'), { code: 'invalid_params' }));
    let fingerprint: string;
    try { fingerprint = digest(canonical(payload)); } catch { return Promise.reject(new Error('Message payload must be JSON serializable.')); }
    const identity = digest(JSON.stringify([key, id]));
    const conflict = () => Object.assign(new Error('This message_id belongs to different message contents.'), { code: 'conflict' });
    const pending = this.inflight.get(identity);
    if (pending) return pending.fingerprint === fingerprint ? pending.promise : Promise.reject(conflict());
    const promise = (async () => {
      await this.ready;
      this.prune();
      const existing = this.records.get(identity);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw conflict();
        if (existing.state === 'pending') throw uncertain();
        return structuredClone(existing.result);
      }
      const receipt: Receipt = { fingerprint, state: 'pending', at: Date.now() };
      this.records.set(identity, receipt);
      try { await this.persist(); }
      catch (error) { this.records.delete(identity); throw Object.assign(new Error(`Message was not sent: unable to save its receipt. ${(error as Error).message}`), { code: 'unavailable', notSent: true }); }
      let result: unknown;
      try { result = await send(); }
      catch (error) {
        // Only an explicit transport guarantee can establish that no side effect occurred.
        if ((error as { notSent?: boolean } | null)?.notSent === true) {
          this.records.delete(identity);
          try { await this.persist(); } catch { this.records.set(identity, receipt); throw uncertain(error); }
          throw error;
        }
        throw uncertain(error);
      }
      // Clone before committing; non-serializable results cannot make retries resend a prompt.
      try {
        receipt.result = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        receipt.state = 'confirmed'; receipt.at = Date.now(); this.prune();
        await this.persist();
      } catch (error) { receipt.state = 'pending'; delete receipt.result; this.records.set(identity, receipt); throw uncertain(error); }
      return structuredClone(receipt.result);
    })();
    this.inflight.set(identity, { fingerprint, promise });
    void promise.finally(() => { if (this.inflight.get(identity)?.promise === promise) this.inflight.delete(identity); }).catch(() => {});
    return promise;
  }
}
