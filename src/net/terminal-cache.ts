import { agentKind, type AgentInfo } from '../../shared/types';

type Source = 'visible' | 'recent_unwrapped' | 'recent';
export interface TerminalSnapshot { text: string; at: number; source: Source; live: boolean }
type Read = (pane: string, source: Source, signal?: AbortSignal) => Promise<string>;
type Pending = { promise: Promise<TerminalSnapshot>; controller: AbortController };

/** Session-scoped, bounded memory only. Terminal content never goes into browser storage. */
export class TerminalCache {
  private entries = new Map<string, TerminalSnapshot>();
  private pending = new Map<string, Pending>();
  private revisions = new Map<string, number>();
  private historySource = new Map<string, Source>();
  constructor(private reader: Read, private now = Date.now) {}

  key(agent: AgentInfo) {
    return JSON.stringify([agent.pane_id, agentKind(agent), agent.agent_session?.kind,
      agent.agent_session?.value, agent.employee_id, agent.cwd]);
  }

  peek(agent: AgentInfo) {
    const key = this.key(agent), value = this.entries.get(key);
    if (value && this.now() - value.at > 300_000) { this.entries.delete(key); return; }
    if (value) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }

  /** A command makes any older in-flight read ineligible to update the cache. */
  invalidate(agent: AgentInfo) { this.cancel(agent); }

  cancel(agent?: AgentInfo) {
    const key = agent ? this.key(agent) : undefined;
    for (const [id, pending] of this.pending) if (!key || id === `${key}:screen` || id === `${key}:history`) {
      this.pending.delete(id); pending.controller.abort();
    }
    if (key) this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
  }

  retain(agents: AgentInfo[]) {
    const active = new Set(agents.map(agent => this.key(agent)));
    for (const key of this.entries.keys()) if (!active.has(key)) this.entries.delete(key);
    for (const key of this.revisions.keys()) if (!active.has(key)) this.revisions.delete(key);
    for (const key of this.historySource.keys()) if (!active.has(key)) this.historySource.delete(key);
    for (const [id, pending] of this.pending) {
      if (!active.has(id.replace(/:(screen|history)$/, ''))) { this.pending.delete(id); pending.controller.abort(); }
    }
  }

  /** New pushed output wins over slower screen/history reads already in flight. */
  accept(agent: AgentInfo, value: TerminalSnapshot) {
    const key = this.key(agent);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.store(key, value);
  }

  private store(key: string, value: TerminalSnapshot) {
    this.entries.delete(key);
    if (value.text.length <= 250_000) this.entries.set(key, value);
    let size = [...this.entries.values()].reduce((sum, entry) => sum + entry.text.length, 0);
    while (this.entries.size > 32 || size > 1_000_000) {
      const oldest = this.entries.keys().next().value!;
      size -= this.entries.get(oldest)!.text.length; this.entries.delete(oldest);
    }
  }

  /** Even an idle pane paints its fast visible screen before fetching scrollback. */
  read(agent: AgentInfo, live = agent.agent_status === 'working' || agent.agent_status === 'blocked') {
    return this.request(agent, ['visible', 'recent_unwrapped', 'recent'], live, 'screen');
  }

  readHistory(agent: AgentInfo, options: { signal?: AbortSignal } = {}) {
    const preferred = this.historySource.get(this.key(agent)) ?? 'recent_unwrapped';
    return this.request(agent, [...new Set<Source>([preferred, 'recent', 'visible'])], false, 'history', options.signal);
  }

  private request(agent: AgentInfo, sources: Source[], live: boolean, mode: string, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Read cancelled', 'AbortError'));
    const key = this.key(agent), id = `${key}:${mode}`, waiting = this.pending.get(id);
    if (waiting) return waiting.promise;
    const revision = this.revisions.get(key) ?? 0;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const request = (async () => {
      let failure: unknown;
      for (const source of sources) {
        try {
          const text = await this.reader(agent.pane_id, source, controller.signal);
          if (mode === 'history') this.historySource.set(key, source);
          return { text, at: this.now(), source, live };
        } catch (error) {
          failure = error;
          if (controller.signal.aborted || /disconnect|timeout|timed out|network|fetch|closed|not found|no longer active/i.test(String(error))) break;
        }
      }
      throw failure;
    })();
    const pending = { promise: request, controller };
    this.pending.set(id, pending);
    void request.then(value => {
      if (this.pending.get(id) !== pending) return;
      this.pending.delete(id);
      if (!controller.signal.aborted && (this.revisions.get(key) ?? 0) === revision) this.store(key, value);
    }, () => { if (this.pending.get(id) === pending) this.pending.delete(id); })
      .finally(() => signal?.removeEventListener('abort', cancel));
    return request;
  }
}
