import type { AgentInfo } from '../shared/types';

type BackendCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type Peer = { send(data: string): unknown };
type ReadResult = { read: { text: string; [key: string]: unknown }; [key: string]: unknown };
type ReadOptions = { priority?: 'interactive' | 'background'; signal?: AbortSignal };
type Job = { key: string; params: Record<string, unknown>; background: boolean; started: boolean;
  waiters: Set<{ resolve(value: ReadResult): void; reject(error: unknown): void; cleanup(): void }> };
type Stream = { target: string; peers: Set<Peer>; timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController; last?: string; packet?: string; identity?: string; idleDelay: number; freshUntil?: number; settlingUntil?: number };
type StreamOptions = { activeMs?: number; idleMs?: number; maxIdleMs?: number; healthGraceMs?: number;
  schedule?: typeof setTimeout; cancel?: typeof clearTimeout };

/** One bounded read scheduler/cache for every browser and background enrichment job. */
export class AgentOutputHub {
  private cache = new Map<string, { at: number; value: ReadResult }>();
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = 0;
  private backgroundRunning = 0;
  private streams = new Map<string, Stream>();
  private peers = new Map<Peer, string>();
  private epochs = new Map<string, number>();
  constructor(private call: BackendCall, private agent: (target: string) => AgentInfo | undefined,
    private now = Date.now, private options: StreamOptions = {}) {}

  private get idleMs() { return this.options.idleMs ?? 800; }
  private schedule(callback: () => void, delay: number) { return (this.options.schedule ?? setTimeout)(callback, delay); }
  private cancel(timer?: ReturnType<typeof setTimeout>) { (this.options.cancel ?? clearTimeout)(timer); }

  private identity(target: string) {
    const a = this.agent(target);
    return JSON.stringify([target, a?.agent_session, a?.employee_id, a?.cwd, this.epochs.get(target) ?? 0]);
  }

  read(params: Record<string, unknown>, options: ReadOptions = {}): Promise<ReadResult> {
    if (options.signal?.aborted) return Promise.reject(new DOMException('Read cancelled', 'AbortError'));
    const target = String(params.target ?? '');
    const source = String(params.source ?? 'visible');
    const key = JSON.stringify([this.identity(target), source, params.lines ?? null]);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < (source === 'visible' ? 180 : 1_500)) return Promise.resolve(cached.value);
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, params, background: options.priority === 'background', started: false, waiters: new Set() };
      this.jobs.set(key, job); this.queue.push(job);
    } else if (options.priority !== 'background' && !job.started) job.background = false;
    const active = job;
    const promise = new Promise<ReadResult>((resolve, reject) => {
      const cancel = () => {
        active.waiters.delete(waiter); waiter.cleanup();
        reject(new DOMException('Read cancelled', 'AbortError'));
        if (!active.started && !active.waiters.size) {
          this.jobs.delete(key); this.queue = this.queue.filter(item => item !== active);
        }
      };
      const waiter = { resolve, reject, cleanup: () => options.signal?.removeEventListener('abort', cancel) };
      active.waiters.add(waiter); options.signal?.addEventListener('abort', cancel, { once: true });
    });
    this.drain();
    return promise;
  }

  private drain() {
    while (this.running < 2) {
      // At most one background read: a slow history request cannot occupy the interactive slot.
      let index = this.queue.findIndex(job => !job.background);
      if (index < 0 && !this.backgroundRunning) index = this.queue.findIndex(job => job.background);
      if (index < 0) return;
      const job = this.queue.splice(index, 1)[0]; job.started = true;
      this.running++; if (job.background) this.backgroundRunning++;
      void Promise.resolve().then(() => this.call('agent.read', job.params)).then(result => {
        const value = result as ReadResult;
        if (typeof value?.read?.text !== 'string') throw new Error('Invalid terminal response');
        this.cache.delete(job.key);
        if (value.read.text.length <= 250_000) this.cache.set(job.key, { at: this.now(), value });
        let size = [...this.cache.values()].reduce((n, entry) => n + entry.value.read.text.length, 0);
        while (this.cache.size > 64 || size > 2_000_000) {
          const oldest = this.cache.keys().next().value!;
          size -= this.cache.get(oldest)!.value.read.text.length; this.cache.delete(oldest);
        }
        this.jobs.delete(job.key);
        for (const waiter of job.waiters) waiter.resolve(value);
      }).catch(error => {
        this.jobs.delete(job.key);
        for (const waiter of job.waiters) waiter.reject(error);
      }).finally(() => {
        for (const waiter of job.waiters) waiter.cleanup();
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.running--; if (job.background) this.backgroundRunning--;
        this.drain();
      });
    }
  }

  /** Do not reuse pre-command frames or accept their late response into a new subscription. */
  invalidate(target: string) {
    this.epochs.set(target, (this.epochs.get(target) ?? 0) + 1);
    const stream = this.streams.get(target);
    if (stream) {
      stream.idleDelay = this.idleMs; stream.freshUntil = 0;
      // Status hooks can precede the TUI's final paint. Keep reading through that boundary.
      stream.settlingUntil = this.now() + 4_000;
      for (const peer of stream.peers) this.send(peer, JSON.stringify({ type: 'output.health', target, healthyForMs: 0 }));
      if (stream.controller) stream.controller.abort();
      else { this.cancel(stream.timer); stream.timer = undefined; void this.tick(stream); }
    }
    // Only identities of currently live panes are useful; pane ids can accumulate over long runs.
    if (this.epochs.size > 1_000) for (const id of this.epochs.keys()) if (!this.agent(id)) this.epochs.delete(id);
  }

  /** A status/session transition wakes quiet streams without waiting for their backed-off timer. */
  agentChanged(target: string) { this.invalidate(target); }

  subscribe(peer: Peer, target: string) {
    this.unsubscribe(peer);
    if (!this.agent(target)) return;
    this.peers.set(peer, target);
    let stream = this.streams.get(target);
    if (!stream) {
      stream = { target, peers: new Set(), idleDelay: this.idleMs }; this.streams.set(target, stream);
    }
    stream.peers.add(peer);
    if (stream.packet && stream.identity === this.identity(target)) {
      // Cached snapshots are immediate, but replay must not renew an old read's health lease.
      this.send(peer, JSON.stringify({ ...JSON.parse(stream.packet), healthyForMs: Math.max(0, (stream.freshUntil ?? 0) - this.now()) }));
    }
    if (!stream.controller) { this.cancel(stream.timer); stream.timer = undefined; void this.tick(stream); }
  }

  unsubscribe(peer: Peer) {
    const target = this.peers.get(peer); this.peers.delete(peer);
    if (!target) return;
    const stream = this.streams.get(target); if (!stream) return;
    stream.peers.delete(peer);
    if (!stream.peers.size) {
      this.cancel(stream.timer); stream.controller?.abort(); this.streams.delete(target);
    }
  }
  close(peer: Peer) { this.unsubscribe(peer); }
  dispose() { for (const peer of this.peers.keys()) this.unsubscribe(peer); }

  private send(peer: Peer, packet: string) { try { peer.send(packet); } catch { this.unsubscribe(peer); } }
  private async tick(stream: Stream) {
    stream.timer = undefined;
    if (this.streams.get(stream.target) !== stream) return;
    const a = this.agent(stream.target);
    if (!a) { for (const peer of [...stream.peers]) this.unsubscribe(peer); return; }
    stream.controller = new AbortController();
    const identity = this.identity(stream.target);
    let delay = a.agent_status === 'working' || a.agent_status === 'blocked' ? this.options.activeMs ?? 250 : this.idleMs;
    try {
      const result = await this.read({ target: stream.target, source: 'visible' }, { signal: stream.controller.signal });
      if (this.streams.get(stream.target) !== stream || identity !== this.identity(stream.target)) return;
      const live = a.agent_status === 'working' || a.agent_status === 'blocked';
      const changed = stream.last !== result.read.text || stream.identity !== identity;
      stream.idleDelay = live || changed ? this.idleMs : Math.min(stream.idleDelay * 2, this.options.maxIdleMs ?? 1_000);
      delay = live || this.now() < (stream.settlingUntil ?? 0) ? this.options.activeMs ?? 250 : stream.idleDelay;
      // Health is earned by a completed read, never by a timer: hung/failed reads expire naturally.
      const healthyForMs = delay + (this.options.healthGraceMs ?? 2_500);
      stream.freshUntil = this.now() + healthyForMs;
      let packet: string;
      if (changed) {
        stream.last = result.read.text; stream.identity = identity;
        packet = stream.packet = JSON.stringify({ type: 'output', target: stream.target, text: result.read.text,
          source: 'visible', at: this.now(), live, healthyForMs });
      } else packet = JSON.stringify({ type: 'output.health', target: stream.target, healthyForMs });
      for (const peer of stream.peers) this.send(peer, packet);
    } catch { /* Failed reads earn no heartbeat; the client's existing health deadline expires. */ }
    finally {
      const invalidated = stream.controller?.signal.aborted;
      stream.controller = undefined;
      if (this.streams.get(stream.target) === stream) stream.timer = this.schedule(() => void this.tick(stream),
        invalidated ? 0 : delay);
    }
  }
}
