// Live office roster, grouped by the project each agent is working in.
import type { AgentInfo, AgentStatus, MoneyEvent, OfficeEvent } from '../../shared/types';
import { agentKind, taskOf, titleOf } from '../../shared/types';
import { avatarCanvas } from './avatar';
import { lookFor } from '../sprites';
import { reconcileChildren } from './reconcile';
import { rankForLevel, tierForLevel, type AgentProgress } from '../model/office';
import { employeeName, projectKey } from '../../shared/studio';

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', grok: 'Grok', gemini: 'Gemini', aider: 'Aider' };
export function displayName(agent: string) { return NAMES[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1); }
export function handleOf(agent: string, paneId: string) { return `@${agent}_${paneId.replace(/^w/, '').replace(':', '')}`; }
export function statusLabel(s: AgentStatus) { return { working: 'working', blocked: 'needs you', idle: 'idle', done: 'done', unknown: '???' }[s]; }

/** Trim a task title down to something that fits in a speech bubble, on a word boundary. */
export function clip(s: string, n: number) {
  const t = (s || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).trimEnd() + '\u2026';
}

/** The last thing the pane actually said, if it is short enough to put in a bubble. A blocked
 *  agent's last line is usually the question it is waiting on, which beats anything canned. */
function lastLine(snippet?: string) {
  const l = (snippet || '').split('\n').map((x) => x.replace(/^[\s>·•*\-\u2502\u2503\u250c-\u257f]+/, '').trim())
    .filter(Boolean).pop();
  return l && l.length >= 6 && l.length <= 64 ? l : '';
}

/** What an agent says out loud at its desk. Same facts as the timeline, in fewer words: an agent
 *  should be talking about the task it is on, not muttering a canned line. */
export function speechFor(status: AgentStatus | 'title' | 'joined' | 'left', title: string, snippet?: string): string {
  const t = clip(title, 44);
  switch (status) {
    case 'joined':  return t ? `clocked in \ud83d\udc4b ${t}` : 'clocked in \ud83d\udc4b';
    case 'left':    return 'clocking out \ud83d\udc4b';
    case 'working': return t ? `on it: ${t}` : 'on it';
    case 'blocked': return lastLine(snippet) || (t ? `needs you: ${t}` : 'needs you \ud83d\ude4b');
    case 'done':    return t ? `shipped ${t} \u2705` : 'shipped it \u2705';
    case 'idle':    return t ? `done: ${t}` : 'all yours';
    case 'title':   return t ? `now: ${t}` : '';
    default:        return t;
  }
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
export function dur(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; return `${(s / 3600).toFixed(1)}h`;
}
const STATUS_ORDER: Record<AgentStatus, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const COLLAPSED_PROJECTS_KEY = 'herdr-story:collapsed-projects';
const COLLAPSED_SALES_KEY = 'herdr-story:collapsed-sales';
function projectOf(a: AgentInfo) {
  const path = (a.foreground_cwd || a.cwd || '').replace(/\/+$/, '');
  return { path: projectKey(a), name: path.split('/').pop() || 'misc' };
}

/** How a money event reads in the roster, and which way it points. */
const MONEY_WORDS: Record<MoneyEvent['kind'], { verb: string; tone: 'up' | 'down' | 'flat' }> = {
  sale:       { verb: 'Payment', tone: 'up' },
  refund:     { verb: 'Refund', tone: 'down' },
  failed:     { verb: 'Payment failed', tone: 'down' },
  dispute:    { verb: 'Disputed', tone: 'down' },
  subscribed: { verb: 'New paid subscriber', tone: 'up' },
  subscription_started: { verb: 'Subscription started', tone: 'flat' },
  subscription_pending: { verb: 'Subscription pending', tone: 'flat' },
  trial_started: { verb: 'Trial started', tone: 'flat' },
  churned:    { verb: 'Cancelled', tone: 'down' },
  expired: { verb: 'Expired', tone: 'down' },
  subscription_resumed: { verb: 'Subscription resumed', tone: 'flat' },
};

export function moneyText(ev: MoneyEvent) {
  const { verb } = MONEY_WORDS[ev.kind];
  return ev.amount ? `${verb} ${moneyAmount(ev)}` : verb;
}

export function moneyAmount(ev: MoneyEvent) {
  const n = Math.abs(ev.amount);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: ev.currency.toUpperCase(),
      maximumFractionDigits: n < 100 && n % 1 ? 2 : 0 }).format(n);
  } catch { return `$${n.toFixed(2)}`; }
}

/** How long ago, in the roster's shorthand. */
function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export class Feed {
  private root = document.getElementById('posts')!;
  private pinned = document.getElementById('pinned')!;
  private tabs = [...document.querySelectorAll<HTMLButtonElement>('.feed-tabs > *')];
  private agents: AgentInfo[] = [];
  private collapsedProjects = this.loadCollapsedProjects();
  private salesCollapsed = this.loadSalesCollapsed();
  private filter: 'all' | 'blocked' = 'all';
  /** Newest first. Keep the bridge's recent snapshot available in the scrollable list. */
  private moneyLog: MoneyEvent[] = [];
  private moneyPreviews: MoneyEvent[] = [];
  private animateMoney = new Set<string>();
  private renderedKey = '';
  private static readonly MONEY_ROWS = 12;
  onPayment?: (event: MoneyEvent) => void;
  onSelect?: (paneId: string) => void;
  onPreview?: (paneId: string) => void;
  onProjectSelect?: (project: string) => void;
  progressOf?: (paneId: string) => AgentProgress;

  constructor() {
    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const collapse = target.closest<HTMLButtonElement>('.project-collapse');
      if (collapse) {
        const key = decodeURIComponent(collapse.dataset.project!);
        if (this.collapsedProjects.has(key)) this.collapsedProjects.delete(key); else this.collapsedProjects.add(key);
        this.saveCollapsedProjects(); this.render(); return;
      }
      const project = target.closest<HTMLButtonElement>('.project-focus');
      if (project) { this.onProjectSelect?.(decodeURIComponent(project.dataset.project!)); return; }
      const row = target.closest<HTMLButtonElement>('.agent-row');
      if (row) { this.onSelect?.(row.dataset.pane!); return; }
      const money = target.closest<HTMLElement>('.money-row.expandable');
      if (money) { this.toggleMoney(money.dataset.money!); return; }
      const head = target.closest<HTMLButtonElement>('.money-head');
      if (!head) return;
      this.salesCollapsed = !this.salesCollapsed;
      try { localStorage.setItem(COLLAPSED_SALES_KEY, String(this.salesCollapsed)); }
      catch { /* the choice still lasts for the current page */ }
      head.setAttribute('aria-expanded', String(!this.salesCollapsed));
      head.querySelector('.project-toggle')!.textContent = this.salesCollapsed ? '▸' : '▾';
      this.root.querySelector<HTMLElement>('#sales-events')!.hidden = this.salesCollapsed;
    });
    const preview = (event: Event) => {
      const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.agent-row');
      if (row && (!(event instanceof PointerEvent) || !row.contains(event.relatedTarget as Node | null))) this.onPreview?.(row.dataset.pane!);
    };
    this.root.addEventListener('pointerover', preview);
    this.root.addEventListener('focusin', preview);
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const money = (event.target as HTMLElement).closest<HTMLElement>('.money-row.expandable');
      if (money) { event.preventDefault(); this.toggleMoney(money.dataset.money!); }
    });
    this.tabs.forEach((el) => el.addEventListener('click', () => {
      this.filter = (el.dataset.filter as 'all' | 'blocked') ?? 'all';
      this.tabs.forEach((x) => { x.classList.toggle('active', x === el); x.setAttribute('aria-selected', String(x === el)); });
      this.render();
    }));
    // Relative times still advance, but the roster does not need rebuilding on every agent poll.
    window.setInterval(() => this.render(), 30_000);
  }

  private loadSalesCollapsed() {
    try { return localStorage.getItem(COLLAPSED_SALES_KEY) === 'true'; }
    catch { return false; }
  }

  private loadCollapsedProjects() {
    try {
      const value = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) || '[]');
      return new Set<string>(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
    } catch { return new Set<string>(); }
  }
  private saveCollapsedProjects() {
    try { localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...this.collapsedProjects])); }
    catch { /* the choice still lasts for the current page */ }
  }

  /** Replace the event stream with one stable row per live pane. */
  summary(agents: AgentInfo[]) {
    this.agents = agents;
    const n = (s: AgentStatus) => agents.filter((a) => a.agent_status === s).length;
    const blocked = n('blocked');
    const pinned = `<span class="roster-live"><i></i>${agents.length} desks</span><span class="st working">${n('working')} working</span><span class="st blocked">${blocked} need you</span><span class="st idle">${n('idle') + n('done')} idle</span>`;
    if (this.pinned.innerHTML !== pinned) this.pinned.innerHTML = pinned;
    const allTab = this.tabs.find((t) => t.dataset.filter === 'all');
    const blockedTab = this.tabs.find((t) => t.dataset.filter === 'blocked');
    const allText = `All (${agents.length})`, blockedText = blocked ? `Needs you (${blocked})` : 'Needs you';
    if (allTab && allTab.textContent !== allText) allTab.textContent = allText;
    if (blockedTab && blockedTab.textContent !== blockedText) blockedTab.textContent = blockedText;
    this.render();
  }

  /** A Stripe event. Ignores one it has already been told about, so a reconnect's snapshot
   *  replaying the recent tail cannot double it up. */
  money(events: MoneyEvent[]) {
    let added = false;
    for (const ev of events) {
      if (this.moneyLog.some((m) => m.id === ev.id)) continue;
      this.moneyLog.push(ev); this.animateMoney.add(ev.id); added = true;
    }
    if (!added) return;
    this.moneyLog.sort((a, b) => b.ts - a.ts);
    this.moneyLog.length = Math.min(this.moneyLog.length, Feed.MONEY_ROWS);
    this.render();
  }

  /** Browser-only samples live beside, rather than inside, Stripe history so testing never pushes
   *  a real event out of the retained list. */
  previewMoney(event: MoneyEvent) {
    this.moneyPreviews.unshift(event);
    this.moneyPreviews.length = Math.min(this.moneyPreviews.length, Feed.MONEY_ROWS);
    this.animateMoney.add(event.id);
    this.render();
  }

  clearMoneyPreviews() {
    if (!this.moneyPreviews.length) return;
    // Force the Sales section to be rebuilt once; its normal preservation path would otherwise
    // correctly keep the old preview nodes alive through this roster render.
    for (const event of this.moneyPreviews) this.animateMoney.add(event.id);
    this.moneyPreviews = [];
    this.render();
  }

  private moneyRows() {
    return [...this.moneyPreviews, ...this.moneyLog].sort((a, b) => b.ts - a.ts).slice(0, Feed.MONEY_ROWS);
  }
  /** Rows opened to read what the provider said; kept so a redraw does not fold them again. */
  private openMoney = new Set<string>();
  private static expandable(ev: MoneyEvent) { if (/^(evt_|revenuecat:)/.test(ev.id)) return true; const d = ev.detail; return !!d && !!(d.reason || d.feedback || d.comment || d.plan || d.url); }
  /** Fold or unfold one row in place: the Sales DOM is preserved across roster redraws, so the
   *  panel is edited there rather than rebuilt with everything else. */
  private toggleMoney(id: string) {
    const row = this.root.querySelector<HTMLElement>(`.money-row[data-money="${CSS.escape(id)}"]`);
    const ev = this.moneyRows().find((m) => m.id === id);
    if (!row || !ev) return;
    if (this.onPayment && /^(evt_|revenuecat:)/.test(id)) { this.onPayment(ev); return; }
    const open = !this.openMoney.has(id);
    if (open) this.openMoney.add(id); else this.openMoney.delete(id);
    row.classList.toggle('open', open); row.setAttribute('aria-expanded', String(open));
    row.nextElementSibling?.matches('.money-detail') && row.nextElementSibling.remove();
    if (open) row.insertAdjacentHTML('afterend', this.moneyDetailHtml(ev));
  }
  private moneyDetailHtml(ev: MoneyEvent) {
    const d = ev.detail ?? {}, lines: string[] = [];
    const why = [d.reason, d.feedback].filter(Boolean).join(' · ');
    if (why) lines.push(`<span><small>WHY</small>${esc(why)}</span>`);
    if (d.comment) lines.push(`<q>${esc(d.comment)}</q>`);
    if (d.plan) lines.push(`<span><small>PLAN</small>${esc(d.plan)}</span>`);
    if (d.ends) lines.push(`<span><small>${ev.kind === 'churned' || ev.kind === 'expired' ? 'ENDS' : 'RENEWS'}</small>${esc(new Date(d.ends).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span>`);
    if (!why && !d.comment && (ev.kind === 'churned' || ev.kind === 'expired')) lines.push('<span class="money-quiet">No reason given.</span>');
    const link = d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">Open in ${ev.source === 'revenuecat' ? 'RevenueCat' : 'Stripe'} ↗</a>` : '';
    return `<div class="money-detail" data-money-detail="${esc(ev.id)}">${lines.join('')}${link}</div>`;
  }

  private moneyHtml() {
    const rows = this.moneyRows();
    if (!rows.length) return '';
    return `<section data-roster-key="sales" class="roster-money"><button type="button" class="money-head" aria-expanded="${!this.salesCollapsed}" aria-controls="sales-events"><span class="project-toggle" aria-hidden="true">${this.salesCollapsed ? '▸' : '▾'}</span><span class="money-coin" aria-hidden="true"></span><b>Sales</b></button><div id="sales-events" tabindex="0" role="region" aria-label="Recent sales"${this.salesCollapsed ? ' hidden' : ''}>${
      rows.map((ev) => {
        const { tone } = MONEY_WORDS[ev.kind];
        const fresh = this.animateMoney.has(ev.id) ? ' new' : '';
        const source = ev.source === 'revenuecat' ? 'RevenueCat · ' : '';
        const expandable = Feed.expandable(ev), open = expandable && this.openMoney.has(ev.id);
        const opensDialog = !!this.onPayment && /^(evt_|revenuecat:)/.test(ev.id);
        const attrs = opensDialog ? ' role="button" tabindex="0" aria-haspopup="dialog" title="View payment details"' : expandable ? ` role="button" tabindex="0" aria-expanded="${open}" title="Read more"` : '';
        return `<div class="money-row ${tone}${fresh}${expandable ? ' expandable' : ''}${open ? ' open' : ''}" data-money="${esc(ev.id)}"${attrs}><span class="money-what"><b>${esc(moneyText(ev))}</b><small>${esc(source + ev.label)}</small></span><span class="money-when">${esc(ago(ev.ts))}</span>${expandable ? '<span class="money-caret" aria-hidden="true">▸</span>' : ''}</div>${open ? this.moneyDetailHtml(ev) : ''}`;
      }).join('')}</div></section>`;
  }

  /** Agent status changes redraw the roster below Sales. Preserve the existing Sales DOM so its
   *  rows never blink or restart their entrance animation; only a genuinely new Stripe event is
   *  allowed to replace it. Relative timestamps are updated in place. */
  private preserveMoney(existing: HTMLElement | null) {
    if (!existing) return;
    this.root.querySelector('.roster-money')?.replaceWith(existing);
    const events = new Map(this.moneyRows().map((ev) => [ev.id, ev]));
    existing.querySelectorAll<HTMLElement>('.money-row').forEach((row) => {
      const ev = events.get(row.dataset.money ?? '');
      const when = row.querySelector<HTMLElement>('.money-when');
      if (ev && when) when.textContent = ago(ev.ts);
    });
  }

  refresh() { this.render(); }
  post(_ev: OfficeEvent) { /* events animate the office; the roster is driven by live AgentInfo */ }
  system(_text: string) { /* connection state is represented by the global bridge-offline banner */ }

  private patch(html: string) {
    const template = document.createElement('template'); template.innerHTML = html;
    reconcileChildren(this.root, template.content);
  }

  private render() {
    const shown = this.filter === 'blocked' ? this.agents.filter((a) => a.agent_status === 'blocked') : this.agents;
    // agent.list includes bookkeeping fields that change frequently. Hash only the values this
    // panel actually renders, so an invisible backend update cannot replace the whole DOM.
    const key = JSON.stringify([
      this.filter,
      [...this.collapsedProjects].sort(),
      this.moneyRows().map((ev) => [ev.id, ev.ts, ev.kind, ev.amount, ev.currency, ev.label, ago(ev.ts)]),
      shown.map((a) => {
        const project = projectOf(a);
        return [a.pane_id, a.agent_status, agentKind(a), employeeName(a), !!a.favorite, taskOf(a), a.activity,
          project.path, project.name, lookFor(a.pane_id), this.progressOf?.(a.pane_id)?.level ?? 0];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const scrollTop = this.root.scrollTop;
    const salesScrollTop = this.root.querySelector<HTMLElement>('#sales-events')?.scrollTop ?? 0;
    const salesListFocused = document.activeElement?.id === 'sales-events';
    const restoreSalesScroll = () => {
      const list = this.root.querySelector<HTMLElement>('#sales-events');
      if (!list) return;
      list.scrollTop = salesScrollTop;
      if (salesListFocused) list.focus({ preventScroll: true });
    };
    const existingMoney = this.animateMoney.size ? null : this.root.querySelector<HTMLElement>('.roster-money');
    const salesFocused = document.activeElement?.classList.contains('money-head');
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-pane]')?.dataset.pane;
    const projectFocused = (document.activeElement as HTMLElement | null)?.dataset.project;
    const collapseFocused = document.activeElement?.classList.contains('project-collapse');
    const groups = new Map<string, { name: string; path: string; agents: AgentInfo[] }>();
    for (const agent of shown) {
      const project = projectOf(agent), key = project.path || project.name;
      const group = groups.get(key) ?? { ...project, agents: [] };
      group.agents.push(agent); groups.set(key, group);
    }
    const ordered = [...groups.values()].sort((a, b) => {
      const urgency = (g: typeof a) => Math.min(...g.agents.map((agent) => STATUS_ORDER[agent.agent_status]));
      return urgency(a) - urgency(b) || a.name.localeCompare(b.name);
    });
    if (!ordered.length) {
      this.patch(this.moneyHtml() + `<div class="roster-empty"><span>✓</span><b>${this.filter === 'blocked' ? 'Nobody needs you' : 'No agents at their desks'}</b><small>${this.filter === 'blocked' ? 'You are all caught up.' : 'Start an agent and they will appear here.'}</small></div>`);
      this.preserveMoney(existingMoney);
      restoreSalesScroll();
      if (salesFocused) this.root.querySelector<HTMLButtonElement>('.money-head')?.focus({ preventScroll: true });
      this.root.scrollTop = scrollTop;
      this.animateMoney.clear();
      return;
    }
    this.patch(this.moneyHtml() + ordered.map((group) => {
      group.agents.sort((a, b) => STATUS_ORDER[a.agent_status] - STATUS_ORDER[b.agent_status] || Number(!!b.favorite) - Number(!!a.favorite) || employeeName(a).localeCompare(employeeName(b)) || a.pane_id.localeCompare(b.pane_id));
      const blocked = group.agents.filter((a) => a.agent_status === 'blocked').length;
      const working = group.agents.filter((a) => a.agent_status === 'working' && !a.wait_notice).length;
      const key = group.path || group.name;
      // Needs-you is a triage view: never hide the agents who require action just because their
      // project was collapsed in the full roster.
      const collapsed = this.filter === 'all' && this.collapsedProjects.has(key);
      return `<section data-roster-key="${encodeURIComponent(key)}" class="roster-project${collapsed ? ' collapsed' : ''}">
        <div class="project-head">
          <button type="button" class="project-collapse project-toggle" data-project="${encodeURIComponent(key)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(group.name)}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>
          <button type="button" class="project-focus" title="Pan to ${esc(key)}" data-project="${encodeURIComponent(key)}" aria-label="Pan to ${esc(group.name)} desks"><span class="project-folder" aria-hidden="true">▰</span><b>${esc(group.name)}</b><span class="project-count">${working ? `${working} working · ` : ''}${blocked ? `${blocked} need you · ` : ''}${group.agents.length} ${group.agents.length === 1 ? 'desk' : 'desks'}</span></button>
        </div>
        <div class="project-agents"${collapsed ? ' hidden' : ''}>${group.agents.map((a) => {
          const kind = agentKind(a), progress = this.progressOf?.(a.pane_id), task = taskOf(a) || 'No active task';
          const state = a.wait_notice ? 'retry-wait' : a.completed_task ? 'done' : a.agent_status;
          const label = a.wait_notice ? a.wait_notice.kind === 'rate_limit' ? 'Rate limited' : 'Waiting to retry' : a.completed_task ? 'done' : statusLabel(a.agent_status);
          return `<button type="button" class="agent-row ${state}" data-pane="${esc(a.pane_id)}" aria-label="Open ${esc(employeeName(a))}, ${esc(label)}, ${esc(task)}">
            <span class="roster-avatar"><span class="status-lamp ${state}" title="${esc(label)}"></span></span>
            <span class="agent-copy"><span class="agent-line"><b>${a.favorite ? '★ ' : ''}${esc(employeeName(a))}</b>${progress ? `<span class="level-badge" data-level-tier="${tierForLevel(progress.level)}" title="${rankForLevel(progress.level)} · Level ${progress.level}">Lv ${progress.level}</span>` : ''}<span class="agent-handle">${esc(handleOf(kind, a.pane_id))}</span></span><span class="agent-task">${esc(a.wait_notice?.detail ?? task)}</span></span>
            <span class="agent-state st ${state}">${esc(label)}</span><span class="agent-open" aria-hidden="true">›</span>
          </button>`;
        }).join('')}</div>
      </section>`;
    }).join(''));
    this.preserveMoney(existingMoney);
    restoreSalesScroll();
    this.root.querySelectorAll<HTMLButtonElement>('.project-focus').forEach((head) => {
      if (!collapseFocused && head.dataset.project === projectFocused) head.focus({ preventScroll: true });
    });
    this.root.querySelectorAll<HTMLButtonElement>('.project-collapse').forEach((head) => {
      if (collapseFocused && head.dataset.project === projectFocused) head.focus({ preventScroll: true });
    });
    this.root.querySelectorAll<HTMLButtonElement>('.agent-row').forEach((row) => {
      const appearance = JSON.stringify(lookFor(row.dataset.pane!));
      const avatar = row.querySelector<HTMLElement>('.roster-avatar')!;
      if (avatar.dataset.appearance !== appearance || !avatar.querySelector('canvas')) {
        avatar.querySelector('canvas')?.remove();
        avatar.prepend(avatarCanvas(row.dataset.pane!, 32)); avatar.dataset.appearance = appearance;
      }
      if (row.dataset.pane === focused) row.focus({ preventScroll: true });
    });
    if (salesFocused) this.root.querySelector<HTMLButtonElement>('.money-head')?.focus({ preventScroll: true });
    this.root.scrollTop = scrollTop;
    this.animateMoney.clear();
  }
}
