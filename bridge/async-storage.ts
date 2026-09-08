import { Worker } from 'node:worker_threads';
import type { Saved, SavedPatch } from './storage';

type Pending = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
/** SQLite commits run off the bridge's event loop. A successful promise means the transaction
 * committed; worker failure rejects every outstanding operation instead of silently hanging. */
export class AsyncStorage {
  private worker?: Worker;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private failure?: Error;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private directory: string) {}

  private start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./storage-worker.ts', import.meta.url), { workerData: { directory: this.directory } });
    this.worker = worker;
    worker.on('message', (message: { id?: number; ok?: boolean; error?: string }) => {
      if (typeof message?.id !== 'number') return;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.ok === true) pending.resolve(); else pending.reject(new Error(message.error || 'Studio commit failed.'));
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => {
      if (this.pending.size || !this.closing) this.fail(new Error(`Studio storage worker exited before completion (${code}).`));
      this.closed = true;
    });
    worker.unref(); return worker;
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear(); this.closed = true;
    void this.worker?.terminate().catch(() => {});
  }
  private request(type: 'save' | 'patch' | 'close', state?: Saved | SavedPatch) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('Studio storage is closed.'));
    if (this.pending.size >= 64 && type !== 'close') return Promise.reject(new Error('Too many studio commits are pending.'));
    let worker: Worker;
    try { worker = this.start(); } catch (error) { this.fail(error as Error); return Promise.reject(error); }
    const id = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Studio storage worker timed out; commit status is unknown.')), 30_000);
      this.pending.set(id, { resolve, reject, timer }); worker.ref();
      try { worker.postMessage({ type, id, state }); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
        if (!this.pending.size) worker.unref();
      }
    });
  }
  save(state: Saved): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Studio storage is closing.'));
    return this.request('save', state);
  }
  patch(patch: SavedPatch): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Studio storage is closing.'));
    return this.request('patch', patch);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.worker || this.closed) { this.closed = true; return Promise.resolve(); }
    this.closing = this.request('close').finally(() => { this.closed = true; });
    return this.closing;
  }
}
