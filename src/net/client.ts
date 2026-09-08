import { applyStudioPatch, type StudioAck } from '../../shared/studio-actions';
import type { ClientMsg, ServerMsg } from '../../shared/types';
import type { CallOptions, InteractionTiming, OfficeClient, OutputUpdate } from './office-client';

export type { CallOptions, InteractionTiming, OfficeClient, OutputUpdate } from './office-client';
type Listener = (msg: ServerMsg) => void;
const readOnly = (method: string) => ['ping', 'agent.list', 'agent.get', 'agent.read', 'agent.transcript', 'agent.explain',
  'agent.settings.options', 'agent.boss.briefing', 'agent.boss.archive', 'studio.get', 'studio.journal', 'studio.action.status', 'payment.detail', 'agent.message.status', 'sweep.scan', 'sweep.prepare'].includes(method);
const interrupted = (method: string, message: string) => Object.assign(new Error(readOnly(method) ? message
  : `${message}. The bridge may have accepted this action; check its status before retrying.`),
  { code: readOnly(method) ? 'unavailable' : 'uncertain', uncertain: !readOnly(method) });


export class BridgeClient implements OfficeClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, { method: string; onProgress?: CallOptions['onProgress']; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private outputWatch?: { target: string; callback: (update: OutputUpdate) => void; started: number; measured: boolean; received: boolean; freshUntil: number };
  private timings: InteractionTiming[] = [];
  private resyncing = false;
  private listeners = new Set<Listener>();
  private backoff = 500;
  private polling = false;
  private pollTimer?: number;
  private haveSnapshot = false;
  private latestSnapshot?: Extract<ServerMsg, { type: 'snapshot' }>;
  private agentKey = '';
  private seenEvents = new Set<string>();
  private studioRevision = -1;
  connected = false;

  constructor(private url: string, private now = () => performance.now()) {
    this.connect();
    (window as unknown as { herdrPerformance: () => InteractionTiming[] }).herdrPerformance = () => this.performanceSnapshot();
    document.addEventListener('visibilitychange', () => this.syncOutputSubscription());
  }

  /** Timings contain operation names and durations only, never prompts or terminal content. */
  performanceSnapshot() { return this.timings.map(timing => ({ ...timing })); }
  private measure(name: string, start: number, outcome: 'ok' | 'error' = 'ok') {
    const durationMs = Math.max(0, performance.now() - start);
    this.timings.push({ name, durationMs, at: Date.now(), outcome });
    // Stable names retain only the most recent native Performance entry for each operation.
    performance.clearMeasures(name);
    performance.measure(name, { start, duration: durationMs, detail: { outcome } });
    while (this.timings.length > 120) {
      const removed = this.timings.shift()!;
      if (!this.timings.some(item => item.name === removed.name)) performance.clearMeasures(removed.name);
    }
  }

  get outputStreaming() { return this.ws?.readyState === WebSocket.OPEN && !document.hidden; }
  /** Freshness uses this browser's monotonic receipt clock, independent of bridge clock skew. */
  outputFresh(target: string) {
    return this.outputStreaming && this.outputWatch?.target === target && this.outputWatch.received
      && this.now() < this.outputWatch.freshUntil;
  }
  watchOutput(target: string, callback: (update: OutputUpdate) => void) {
    const watch = { target, callback, started: performance.now(), measured: false, received: false, freshUntil: 0 }; this.outputWatch = watch; this.syncOutputSubscription();
    return () => { if (this.outputWatch === watch) { this.outputWatch = undefined; this.syncOutputSubscription(); } };
  }
  private syncOutputSubscription() {
    if (this.outputWatch) { this.outputWatch.freshUntil = 0; this.outputWatch.received = false; }
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg: ClientMsg = this.outputWatch && !document.hidden
      ? { type: 'output.subscribe', target: this.outputWatch.target } : { type: 'output.unsubscribe' };
    this.ws.send(JSON.stringify(msg));
  }

  static defaultUrl() {
    const q = new URLSearchParams(location.search).get('ws');
    if (q) return q;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`; // vite proxies /ws to the bridge in dev; the bridge serves it directly in prod
  }

  on(l: Listener) {
    this.listeners.add(l);
    // The loopback bridge can answer before Phaser and the UI finish registering their listener.
    // Replay that first snapshot instead of leaving a perfectly connected page empty forever.
    if (this.latestSnapshot) queueMicrotask(() => { if (this.listeners.has(l) && this.latestSnapshot) l(this.latestSnapshot); });
    return () => this.listeners.delete(l);
  }

  private emit(msg: ServerMsg) {
    if (msg.type === 'output' || msg.type === 'output.health') {
      const watch = this.outputWatch;
      if (watch?.target === msg.target && !document.hidden) {
        const lease = Number(msg.healthyForMs ?? 4_500);
        watch.freshUntil = this.now() + (Number.isFinite(lease) ? Math.max(0, Math.min(15_000, lease)) : 0);
        if (msg.type === 'output.health') return;
        watch.received = true; watch.callback(msg);
        if (!watch.measured) { watch.measured = true; this.measure('herdr.chat.first-output', watch.started); }
      }
      return;
    }
    if (msg.type === 'agents.patch') {
      if (!this.latestSnapshot) { void this.resync(); return; }
      const agents = new Map(this.latestSnapshot.agents.map(a => [a.pane_id, a]));
      msg.remove.forEach(id => agents.delete(id)); msg.upsert.forEach(a => agents.set(a.pane_id, a));
      msg = { type: 'agents', agents: [...agents.values()], workspaces: msg.workspaces ?? this.latestSnapshot.workspaces };
    }
    if (msg.type === 'studio.patch') {
      const state = this.latestSnapshot?.studio;
      if (!state || state.revision !== msg.baseRevision) { void this.resync(); return; }
      msg = { type: 'studio', studio: applyStudioPatch(state, msg) };
    }
    if (msg.type === 'snapshot') {
      this.resyncing = false;
      this.haveSnapshot = true;
      this.latestSnapshot = msg;
      this.studioRevision = msg.studio?.revision ?? -1;
      this.agentKey = JSON.stringify([msg.agents, msg.workspaces ?? []]);
      msg.events.forEach((event) => this.seenEvents.add(event.id));
    } else if (msg.type === 'studio') {
      this.studioRevision = msg.studio.revision;
      if (this.latestSnapshot) this.latestSnapshot = { ...this.latestSnapshot, studio: msg.studio };
    } else if (msg.type === 'agents') {
      this.agentKey = JSON.stringify([msg.agents, msg.workspaces ?? []]);
      if (this.latestSnapshot) this.latestSnapshot = { ...this.latestSnapshot, agents: msg.agents, workspaces: msg.workspaces };
    }
    else if (msg.type === 'event') {
      if (this.seenEvents.has(msg.event.id)) return;
      this.seenEvents.add(msg.event.id);
      if (this.seenEvents.size > 2_000) this.seenEvents.delete(this.seenEvents.values().next().value!);
      if (this.latestSnapshot) this.latestSnapshot = { ...this.latestSnapshot, events: [...this.latestSnapshot.events, msg.event].slice(-60) };
    }
    for (const l of this.listeners) l(msg);
  }

  private async resync() {
    if (this.resyncing) return;
    this.resyncing = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      // A socket snapshot is ordered with subsequent patches; an HTTP response could arrive stale.
      this.ws.send(JSON.stringify({ type: 'hello', deltas: true }));
      return;
    }
    try {
      const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error('Snapshot unavailable');
      this.emit(await response.json());
    } catch { /* The next socket snapshot or polling cycle retries reconciliation. */ }
    finally { this.resyncing = false; }
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    const timeout = window.setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) { this.startPolling(); ws.close(); } }, 2500);
    ws.onopen = () => { clearTimeout(timeout); this.connected = true; this.backoff = 500; this.stopPolling(); ws.send(JSON.stringify({ type: 'hello', deltas: true })); this.syncOutputSubscription(); };
    ws.onmessage = (ev) => {
      let msg: ServerMsg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'launch') { this.pending.get(msg.id)?.onProgress?.(msg.stage); return; }
      if (msg.type === 'result') {
        const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
        msg.error ? p.reject(Object.assign(new Error((msg.error as any).message), msg.error as object)) : p.resolve(msg.result);
        return;
      }
      this.emit(msg);
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      this.connected = false; this.ws = null; this.resyncing = false;
      if (this.outputWatch) { this.outputWatch.freshUntil = 0; this.outputWatch.received = false; }
      for (const p of this.pending.values()) p.reject(interrupted(p.method, 'Disconnected')); this.pending.clear();
      this.startPolling();
      setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(this.backoff * 2, 8000);
    };
    ws.onerror = () => ws.close();
  }

  call(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<unknown> {
    const start = performance.now();
    const suffix = method === 'agent.read' && ['visible', 'recent', 'recent_unwrapped'].includes(String(params.source)) ? `.${params.source}` : '';
    const name = `herdr.rpc.${method}${suffix}`;
    const base = method === 'studio.change' ? this.latestSnapshot?.studio : undefined;
    const sent = base ? { ...params, response: 'patch', base_revision: base.revision } : params;
    return this.request(method, sent, options).then(value => {
      this.measure(name, start);
      const ack = value as StudioAck;
      if (method === 'studio.change' && ack?.type === 'studio.ack') {
        if (ack.studio) return ack.studio;
        if (base && ack.patch) return applyStudioPatch(base, ack.patch);
        if (base && ack.revision === base.revision) return base;
        throw new Error('Save confirmed; reload the studio to see its latest state.');
      }
      return value;
    }, error => {
      this.measure(name, start, 'error'); throw error;
    });
  }

  private request(method: string, params: Record<string, unknown>, options: CallOptions): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(new DOMException('Request cancelled', 'AbortError'));
    const id = `c${++this.seq}`, msg: ClientMsg = { type: 'call', id, method, params };
    const timeoutMs = options.timeoutMs ?? (readOnly(method) ? 12_000 : 100_000);
    if (this.ws?.readyState === WebSocket.OPEN) {
      const ws = this.ws;
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); this.pending.delete(id); };
        const stop = (error: Error) => {
          cleanup();
          if (readOnly(method) && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel', id }));
          reject(error);
        };
        const cancel = () => stop(readOnly(method) ? new DOMException('Request cancelled', 'AbortError') : interrupted(method, 'Request cancelled'));
        const timer = window.setTimeout(() => stop(interrupted(method, 'Request timed out')), timeoutMs);
        this.pending.set(id, { method, onProgress: options.onProgress, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
        options.signal?.addEventListener('abort', cancel, { once: true });
        try { ws.send(JSON.stringify(msg)); } catch (error) { cleanup(); reject(interrupted(method, String(error))); }
      });
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = window.setTimeout(cancel, timeoutMs);
    return fetch('/api/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg), signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { result?: unknown; error?: { message?: string; code?: string } };
        if (!response.ok || body.error) throw Object.assign(new Error(body.error?.message ?? `bridge returned ${response.status}`), { code: body.error?.code ?? 'rejected' });
        return body.result;
      }).catch(error => {
        if (error.code && error.name !== 'AbortError') throw error;
        if (readOnly(method) && options.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
        throw interrupted(method, controller.signal.aborted ? 'Request timed out' : 'Connection failed');
      }).finally(() => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); });
  }

  /** Upload a pasted image to the bridge host, where the terminal agent can read its path. */
  async uploadImage(image: Blob) {
    const response = await fetch('/api/image', { method: 'POST', headers: { 'content-type': image.type }, body: image, signal: AbortSignal.timeout(40_000) });
    const body = await response.json() as { path?: string; error?: { message?: string } };
    if (!response.ok || !body.path) throw new Error(body.error?.message ?? `image upload returned ${response.status}`);
    return body.path;
  }

  private startPolling() {
    if (this.polling) return;
    this.polling = true;
    void this.poll();
  }

  private stopPolling() {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`bridge returned ${response.status}`);
      const state = await response.json() as Extract<ServerMsg, { type: 'snapshot' }>;
      if (!this.polling) return; // The reconnected socket owns state; a late HTTP poll cannot rewind it.
      this.connected = true;
      if (!this.haveSnapshot) this.emit(state);
      else {
        if (state.studio && state.studio.revision !== this.studioRevision) this.emit({ type: 'studio', studio: state.studio });
        for (const event of state.events) if (!this.seenEvents.has(event.id)) this.emit({ type: 'event', event });
        const key = JSON.stringify([state.agents, state.workspaces ?? []]);
        if (key !== this.agentKey) this.emit({ type: 'agents', agents: state.agents, workspaces: state.workspaces });
      }
    } catch { if (this.polling) this.connected = false; }
    finally { if (this.polling) this.pollTimer = window.setTimeout(() => void this.poll(), 1200); }
  }
}
