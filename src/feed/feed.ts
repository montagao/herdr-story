// Live office roster, grouped by the project each agent is working in.
import type { AgentInfo, AgentStatus, MoneyEvent, OfficeEvent } from '../../shared/types';
import { agentKind, taskOf, titleOf } from '../../shared/types';
import { avatarCanvas } from './avatar';
import { lookFor } from '../sprites';
import { reconcileChildren } from './reconcile';
import { rankForLevel, tierForLevel, type AgentProgress } from '../model/office';
import { employeeName, projectKey } from '../../shared/studio';
import { closeOnEscape } from '../escape';
import { studioIcon } from '../icons';
import { reducedMotion } from '../motion';
import './feed.css';

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', grok: 'Grok', gemini: 'Gemini', aider: 'Aider' };
/** One line of a roster row's menu. `edit` turns the line into an inline field on click. */
export type RosterMenuItem = { label: string; run?: () => void | Promise<void>; edit?: { value: string; submit: (value: string) => void | Promise<void> }; danger?: boolean; disabled?: boolean };

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
    // Plain words only: the bubble is drawn on the canvas, where an emoji comes out as the
    // operating system's colour glyph in the middle of the pixel type.
    case 'joined':  return t ? `clocked in: ${t}` : 'clocked in!';
    case 'left':    return 'clocking out!';
    case 'working': return t ? `on it: ${t}` : 'on it';
    case 'blocked': return lastLine(snippet) || (t ? `needs you: ${t}` : 'needs you!');
    case 'done':    return t ? `shipped ${t}!` : 'shipped it!';
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

/** motion.css's tokens, restated for the Web Animations here, which cannot read a custom
 *  property: rows and groups glide to a new place, chips and badges pop. */
const GLIDE = { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' };
const POP = { duration: 120, easing: 'cubic-bezier(.34,1.56,.64,1)' };
/** A sprite's hop: up, half-way down, home, with nothing in between. */
export const hop = (px: number): Keyframe[] => [
  { transform: `translateY(${-px}px)`, easing: 'step-end' },
  { transform: `translateY(${-Math.ceil(px / 2)}px)`, easing: 'step-end' },
  { transform: 'none' },
];
/** Two hard flashes, for the row of an agent that has just started waiting on you. */
const ALARM: Keyframe[] = [
  { background: '#ffd0c7', easing: 'step-end' }, { background: '#fff8f0', easing: 'step-end' },
  { background: '#ffd0c7', easing: 'step-end' }, { background: '#fff8f0' },
];
/** The count chip turning red: two blinks, never fully out. */
const BLINK: Keyframe[] = [1, .35, 1, .35, 1].map((opacity) => ({ opacity, easing: 'step-end' }));
/** More things than this changing places at once is a reshuffle, not a move worth following. */
const MOVERS = 30;
/** How long after the last key press a keyboard walk through the list still holds its order. */
const STILL_MS = 1500;
/** How long a mouse that has stopped on a row is still taken to be about to click it. */
const REST_MS = 4000;
const MASCOT = '/assets/gds/ui/kairokun.png';
/** What a row shows for an agent: a wait or a finished task outranks the raw status. */
function stateOf(a: AgentInfo) { return a.wait_notice ? 'retry-wait' : a.completed_task ? 'done' : a.agent_status; }
type Group = { name: string; path: string; agents: AgentInfo[] };

export class Feed {
  unknownLabel = '???';
  private root = document.getElementById('posts')!;
  private pinned = document.getElementById('pinned')!;
  private tabs = [...document.querySelectorAll<HTMLButtonElement>('.feed-tabs > [data-filter]')];
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
  /** The row menu's entries for one desk; main decides what this office can do. */
  menuFor?: (paneId: string) => RosterMenuItem[];
  /** Set from main: an interface blip. The roster cannot load the sound module itself, because
   *  the ticker's unit test imports this file where there is no page. */
  blip?: (name: 'tick' | 'back') => void;
  private menu?: { opener: HTMLElement | null; close: () => void };
  /** The count strip, built once so that one chip can move without the rest being swapped. */
  private chips?: { desks: Text; working: HTMLElement; blocked: HTMLElement; idle: HTMLElement };
  private tabCount = document.createElement('b');
  /** How many agents needed you at the last count; none counted yet before the first. */
  private waiting = -1;
  /** The order the list stands in: each group's key with its panes, top to bottom. */
  private standing = new Map<string, string[]>();
  /** The list was held in place and is no longer in the order it would sort to. */
  private unsorted = false;
  private mouseOver = false;
  private lastMove = -Infinity;
  private mouseAt = '';
  private lastKey = -Infinity;
  private freeUntil = -Infinity;
  private settleTimer = 0;
  /** The next draw swaps one filter's list for the other's: nothing in it moved. */
  private cut = false;
  /** Slides still running from the last draw. */
  private gliding: Animation[] = [];
  /** What each agent's row last showed, to tell news from a redraw. */
  private seen = new Map<string, { state: string; shipped: number; level: number }>();
  private mascot = false;

  constructor() {
    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const collapse = target.closest<HTMLButtonElement>('.project-collapse');
      if (collapse) {
        const key = decodeURIComponent(collapse.dataset.project!), opening = this.collapsedProjects.has(key);
        if (opening) this.collapsedProjects.delete(key); else this.collapsedProjects.add(key);
        this.saveCollapsedProjects(); this.render();
        if (opening) this.unfold(collapse.closest('section')?.querySelector('.project-agents'));
        this.blip?.('tick'); return;
      }
      const project = target.closest<HTMLButtonElement>('.project-focus');
      if (project) { this.onProjectSelect?.(decodeURIComponent(project.dataset.project!)); return; }
      const more = target.closest<HTMLButtonElement>('.agent-menu');
      if (more) { this.openMenu(more.dataset.menuPane!, more.getBoundingClientRect()); return; }
      const row = target.closest<HTMLButtonElement>('.agent-row');
      if (row) { this.onSelect?.(row.dataset.pane!); return; }
      const money = target.closest<HTMLElement>('.money-row.expandable');
      if (money) { this.toggleMoney(money.dataset.money!); return; }
      const head = target.closest<HTMLButtonElement>('.money-head');
      if (!head) return;
      this.salesCollapsed = !this.salesCollapsed;
      try { localStorage.setItem(COLLAPSED_SALES_KEY, String(this.salesCollapsed)); }
      catch { /* the choice still lasts for the current page */ }
      const list = this.root.querySelector<HTMLElement>('#sales-events')!;
      this.shifting(() => { head.setAttribute('aria-expanded', String(!this.salesCollapsed)); list.hidden = this.salesCollapsed; });
      if (!this.salesCollapsed) this.unfold(list);
      this.blip?.('tick');
    });
    this.root.addEventListener('contextmenu', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.agent-row');
      if (!row || !this.menuFor) return;
      event.preventDefault();
      this.openMenu(row.dataset.pane!, new DOMRect(event.clientX, event.clientY, 0, 0));
    });
    const preview = (event: Event) => {
      const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.agent-row');
      if (row && (!(event instanceof PointerEvent) || !row.contains(event.relatedTarget as Node | null))) this.onPreview?.(row.dataset.pane!);
    };
    this.root.addEventListener('pointerover', preview);
    this.root.addEventListener('focusin', preview);
    // What held() goes by: a mouse over the list, and a keyboard walking it. A finger does not
    // rest on a row, and a touch screen goes on reporting :hover long after the tap.
    // Only a mouse that really went somewhere counts as moving: the browser also reports a move
    // when a row slides under a pointer that is lying still.
    const moved = (event: PointerEvent) => {
      const at = `${event.clientX},${event.clientY}`;
      if (event.pointerType !== 'touch' && at !== this.mouseAt) { this.mouseAt = at; this.lastMove = performance.now(); }
    };
    this.root.addEventListener('pointerover', (event) => { this.mouseOver = event.pointerType !== 'touch'; moved(event); this.settle(); });
    this.root.addEventListener('pointermove', moved);
    this.root.addEventListener('pointerleave', () => { this.mouseOver = false; this.settle(); });
    this.root.addEventListener('keydown', (event) => {
      this.lastKey = performance.now(); this.settleSoon();
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const money = (event.target as HTMLElement).closest<HTMLElement>('.money-row.expandable');
      if (money) { event.preventDefault(); this.toggleMoney(money.dataset.money!); }
    });
    this.tabs.forEach((el) => el.addEventListener('click', () => {
      this.filter = (el.dataset.filter as 'all' | 'blocked') ?? 'all';
      this.tabs.forEach((x) => { x.classList.toggle('active', x === el); x.setAttribute('aria-selected', String(x === el)); });
      this.standing.clear();
      this.cut = true; this.render(); this.cut = false;
      this.blip?.('tick');
    }));
    this.tabCount.className = 'tab-count';
    // A payment's entrance plays once. Left on the row, the class would play it again every
    // time the list was unfolded.
    this.root.addEventListener('animationend', (event) => {
      const row = event.target as Element;
      if (row.matches('.money-row.new') && !row.getAnimations().some((a) => a.playState === 'running')) row.classList.remove('new');
    });
    // The mascot stands in an empty roster when the art pack is installed; public builds have none.
    const mascot = new Image();
    mascot.onload = () => { this.mascot = true; if (this.renderedKey) this.render(); };
    mascot.src = MASCOT;
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
    this.count();
    this.render();
    this.beat();
  }

  /** Every waiting lamp blinks on the one beat, whenever its agent began to wait. Not behind a
   *  window, where the rings are stopped; they fall in with each other once it has gone. */
  private beat() {
    if (this.waiting < 2 || !this.lively()) return;
    for (const ring of this.root.getAnimations({ subtree: true })) if ((ring as CSSAnimation).animationName === 'lamp-alert' && ring.startTime !== 0) ring.startTime = 0;
  }

  /** The count strip and the tabs. Each number is written only when it changes, and only the one
   *  that asks something of you moves: red means somebody is waiting, so the chip is quiet until
   *  then, blinks when the first agent stops for you, and pops when the last one is seen to. */
  private count() {
    const agents = this.agents;
    const n = (s: AgentStatus) => agents.filter((a) => a.agent_status === s).length;
    if (!this.chips) {
      this.pinned.innerHTML = '<span class="roster-live"><i></i></span><span class="st working"></span><span class="st blocked"></span><span class="st idle"></span>';
      const [live, working, blocked, idle] = [...this.pinned.children] as HTMLElement[];
      this.chips = { desks: live.appendChild(document.createTextNode('')), working, blocked, idle };
    }
    const write = (node: Node, text: string) => { if (node.textContent !== text) node.textContent = text; };
    const blocked = n('blocked'), was = this.waiting, chip = this.chips.blocked;
    write(this.chips.desks, `${agents.length} ${agents.length === 1 ? 'desk' : 'desks'}`);
    write(this.chips.working, `${n('working')} working`);
    write(chip, blocked ? `${blocked} ${blocked === 1 ? 'needs' : 'need'} you` : 'all clear');
    chip.classList.toggle('quiet', !blocked);
    write(this.chips.idle, `${n('idle') + n('done')} idle`);
    const allTab = this.tabs.find((t) => t.dataset.filter === 'all');
    const blockedTab = this.tabs.find((t) => t.dataset.filter === 'blocked');
    if (allTab) write(allTab, `All (${agents.length})`);
    write(this.tabCount, String(blocked));
    if (!blocked) this.tabCount.remove();
    else if (blockedTab && this.tabCount.parentNode !== blockedTab) blockedTab.append(this.tabCount);
    // the badge is a bare number; say the tab's name the way it used to read
    const said = blocked ? `Needs you (${blocked})` : 'Needs you';
    if (blockedTab && blockedTab.getAttribute('aria-label') !== said) blockedTab.setAttribute('aria-label', said);
    this.waiting = blocked;
    if (was < 0 || blocked === was || !this.lively()) return;
    if (!blocked) chip.animate([{ transform: 'scale(1.25)' }, { transform: 'none' }], POP);
    else if (!was) chip.animate(BLINK, { duration: 400 });
    else if (blocked > was) chip.animate(hop(3), { duration: 160 });
    if (blocked > was) this.tabCount.animate([{ transform: 'scale(1.35)' }, { transform: 'none' }], POP);
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
  /** A small pixel menu beside the row: pin, rename, find on the floor, and the rest. */
  private openMenu(paneId: string, at: DOMRect) {
    this.closeMenu();
    const items = this.menuFor?.(paneId) ?? [];
    if (!items.length) return;
    const menu = document.createElement('div');
    menu.className = 'roster-menu'; menu.setAttribute('role', 'menu');
    const paint = () => {
      menu.innerHTML = items.map((item, i) => `<button type="button" role="menuitem" data-item="${i}"${item.disabled ? ' disabled' : ''} class="${item.danger ? 'danger' : ''}">${esc(item.label)}</button>`).join('');
    };
    paint();
    menu.addEventListener('click', async (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-item]');
      if (!button) return;
      const item = items[Number(button.dataset.item)];
      if (!item || item.disabled) return;
      if (item.edit) {
        const edit = item.edit;
        menu.innerHTML = `<form class="roster-menu-edit"><label>${esc(item.label)}<input name="value" maxlength="40" required value="${esc(edit.value)}" autocomplete="off"></label><span><button type="submit">Save</button><button type="button" data-cancel>Cancel</button></span></form>`;
        const input = menu.querySelector<HTMLInputElement>('input')!; input.focus(); input.select();
        menu.querySelector('[data-cancel]')!.addEventListener('click', () => { paint(); menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus(); });
        menu.querySelector('form')!.addEventListener('submit', async (e) => {
          e.preventDefault();
          const value = input.value.trim(); if (!value) return;
          this.closeMenu('chosen'); await edit.submit(value);
        });
        return;
      }
      this.closeMenu('chosen');
      await item.run?.();
    });
    // the arrows walk the items, the way they do in the game's own menus
    menu.addEventListener('keydown', (event) => {
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
      const here = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? here + 1 : event.key === 'ArrowUp' ? here - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
      if (next === undefined || !buttons.length) return;
      event.preventDefault(); buttons[(next + buttons.length) % buttons.length].focus();
    });
    const opener = document.activeElement as HTMLElement | null;
    document.body.append(menu);
    // beside the button, kept inside the viewport
    const width = menu.offsetWidth, height = menu.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, at.right - width));
    const above = at.bottom + 4 + height > window.innerHeight - 8;
    menu.style.left = `${left}px`; menu.style.top = `${above ? Math.max(8, at.top - height - 4) : at.bottom + 4}px`;
    if (above) menu.dataset.up = '';   // it unfolds away from the row either way
    const live = new AbortController(), { signal } = live;
    const stopEscape = closeOnEscape(menu, () => this.closeMenu('escaped'));
    this.menu = { opener, close: () => { live.abort(); stopEscape(); menu.remove(); } };
    menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const away = (event: Event) => { if (!menu.contains(event.target as Node)) this.closeMenu(); };
    // from the next task on: the press that opened the menu is still on its way up the page
    setTimeout(() => document.addEventListener('pointerdown', away, { signal }), 0);
    this.root.addEventListener('scroll', () => this.closeMenu(), { capture: true, signal });
    this.blip?.('tick');
  }
  /** Put the menu away. `chosen` when a line was picked, `escaped` when the keyboard dismissed
   *  it and focus should go back to where it came from. */
  private closeMenu(how: 'chosen' | 'escaped' | 'dismissed' = 'dismissed') {
    const menu = this.menu;
    if (!menu) return;
    this.menu = undefined; menu.close();
    // Pinning or renaming re-sorts the list, and the person who asked for it should see it move
    // even though their pointer is still resting on a row.
    if (how === 'chosen') this.freeUntil = performance.now() + 2500;
    else this.blip?.('back');
    if (how === 'escaped' && menu.opener?.isConnected) menu.opener.focus({ preventScroll: true });
    this.settle();
  }

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
    this.shifting(() => {
      row.classList.toggle('open', open); row.setAttribute('aria-expanded', String(open));
      row.nextElementSibling?.matches('.money-detail') && row.nextElementSibling.remove();
      if (open) row.insertAdjacentHTML('afterend', this.moneyDetailHtml(ev));
    });
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
    return `<section data-roster-key="sales" class="roster-money"><button type="button" class="money-head" aria-expanded="${!this.salesCollapsed}" aria-controls="sales-events"><span class="project-toggle" aria-hidden="true">▾</span><span class="money-coin" aria-hidden="true"></span><b>Payments & subscriptions</b></button><div id="sales-events" tabindex="0" role="region" aria-label="Recent billing activity"${this.salesCollapsed ? ' hidden' : ''}>${
      rows.map((ev) => {
        const { tone } = MONEY_WORDS[ev.kind];
        const fresh = this.animateMoney.has(ev.id) ? ' new' : '';
        const source = ev.source === 'revenuecat' ? 'RevenueCat · ' : '';
        const expandable = Feed.expandable(ev), open = expandable && this.openMoney.has(ev.id);
        const opensDialog = !!this.onPayment && /^(evt_|revenuecat:)/.test(ev.id);
        const attrs = opensDialog ? ' role="button" tabindex="0" aria-haspopup="dialog" title="View billing details"' : expandable ? ` role="button" tabindex="0" aria-expanded="${open}" title="Read more"` : '';
        return `<div class="money-row ${tone}${fresh}${expandable ? ' expandable' : ''}${open ? ' open' : ''}" data-money="${esc(ev.id)}"${attrs}><span class="money-what"><b>${esc(moneyText(ev))}</b><small>${esc(source + ev.label)}</small></span><span class="money-when">${esc(ago(ev.ts))}</span>${expandable ? '<span class="money-caret" aria-hidden="true">▸</span>' : ''}</div>${open ? this.moneyDetailHtml(ev) : ''}`;
      }).join('')}</div></section>`;
  }

  /** Agent status changes redraw the roster below Sales. Preserve the existing Sales DOM so its
   *  rows never blink or restart their entrance animation; only a genuinely new Stripe event is
   *  allowed to replace it. Relative timestamps are updated in place. */
  private preserveMoney(existing: HTMLElement | null) {
    if (!existing) return;
    // The keyed patch usually leaves this very node where it was. Taking it out and putting it
    // back would restart every animation inside it and lose the list's place.
    const current = this.root.querySelector('.roster-money');
    if (current && current !== existing) current.replaceWith(existing);
    const events = new Map(this.moneyRows().map((ev) => [ev.id, ev]));
    existing.querySelectorAll<HTMLElement>('.money-row').forEach((row) => {
      const ev = events.get(row.dataset.money ?? '');
      const when = row.querySelector<HTMLElement>('.money-when');
      if (ev && when && when.textContent !== ago(ev.ts)) when.textContent = ago(ev.ts);
    });
  }

  refresh() { this.render(); }
  post(_ev: OfficeEvent) { /* events animate the office; the roster is driven by live AgentInfo */ }
  system(_text: string) { /* connection state is represented by the global bridge-offline banner */ }

  private patch(html: string) {
    const template = document.createElement('template'); template.innerHTML = html;
    reconcileChildren(this.root, template.content);
  }

  /** Whether the roster may move. It keeps still behind an open window and in a hidden tab,
   *  for anyone who asked for less motion, and in a replay, where the timeline is scrubbed. */
  private lively() {
    return !reducedMotion() && !document.hidden && !document.documentElement.classList.contains('office-obscured')
      && !document.body.classList.contains('replay-mode');
  }

  /** Whether the list has to keep the order it is in. A re-sort moves rows, and a row that
   *  slides out from under a resting mouse turns the next click into a different agent. So the
   *  order stays while a mouse has just come to rest on a row or a heading, while a row menu is
   *  open, and for a moment after each key press of a keyboard walk; the rows still update where
   *  they stand. A mouse left lying on the list is not a hold: this panel is open all day beside
   *  other work, and whoever needs you has to be able to rise to the top of it. */
  private held() {
    const now = performance.now();
    if (now < this.freeUntil) return false;
    if (this.menu) return true;
    if (this.mouseOver && now - this.lastMove < REST_MS && this.root.querySelector('.agent-entry:hover, .project-head:hover')) return true;
    return now - this.lastKey < STILL_MS && this.root.contains(document.activeElement);
  }
  /** Sort a held list the moment nothing is holding it any more, and look again while it is. */
  private settle() {
    if (!this.unsorted) return;
    if (this.held()) this.settleSoon(); else this.render();
  }
  private settleSoon() {
    clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.settle(), STILL_MS + 50);
  }

  /** Sorted is what the list wants to be: whoever needs you first. A held list instead keeps
   *  every group and row where it stands, and newcomers queue at the end of theirs. */
  private arrange(ordered: Group[]) {
    const keyOf = (group: Group) => group.path || group.name;
    const order = () => JSON.stringify(ordered.map((group) => [keyOf(group), group.agents.map((a) => a.pane_id)]));
    const sorted = order();
    if (this.standing.size && this.held()) {
      const stay = <T>(list: T[], stood: string[], id: (item: T) => string) => {
        const place = new Map(stood.map((key, i) => [key, i]));
        list.sort((a, b) => (place.get(id(a)) ?? stood.length) - (place.get(id(b)) ?? stood.length));
      };
      stay(ordered, [...this.standing.keys()], keyOf);
      for (const group of ordered) stay(group.agents, this.standing.get(keyOf(group)) ?? [], (a) => a.pane_id);
    }
    this.standing = new Map(ordered.map((group) => [keyOf(group), group.agents.map((a) => a.pane_id)]));
    this.unsorted = order() !== sorted;
  }

  /** Where each group sits on screen and each row within its group, before a change. */
  private places() {
    const tops = new Map<Element, number>();
    for (const section of this.root.querySelectorAll<HTMLElement>(':scope > section')) {
      const top = section.getBoundingClientRect().top;
      tops.set(section, top);
      for (const list of section.querySelectorAll<HTMLElement>('.project-agents:not([hidden])')) {
        tops.set(list, 0);
        for (const entry of list.children) tops.set(entry, entry.getBoundingClientRect().top - top);
      }
    }
    // Anything still sliding has just been measured where it is; let go of it there.
    for (const slide of this.gliding) slide.cancel();
    this.gliding = [];
    return tops;
  }

  /** Slide every group and row from where it was to where the change put it, and walk newcomers
   *  in from the side. Web Animations rather than classes or styles: the next patch strips
   *  whatever the template did not print. */
  private glide(before: Map<Element, number>) {
    const frame = this.root.getBoundingClientRect();
    const seen = (top: number, height: number) => top < frame.bottom && top + height > frame.top;
    const groups: { el: Element; dy: number }[] = [], rows: { el: Element; dy: number }[] = [], fresh: Element[] = [];
    for (const section of this.root.querySelectorAll<HTMLElement>(':scope > section')) {
      const box = section.getBoundingClientRect(), was = before.get(section);
      if (was === undefined) { if (seen(box.top, box.height)) fresh.push(section); continue; }
      // A group whose heading is pinned to the top of a scrolled list stays put: the heading
      // would ride along with the slide.
      const dy = was - box.top;
      if (Math.abs(dy) >= 1 && Math.min(was, box.top) >= frame.top - 1 && (seen(was, box.height) || seen(box.top, box.height))) groups.push({ el: section, dy });
      for (const entry of section.querySelectorAll<HTMLElement>('.project-agents:not([hidden]) > .agent-entry')) {
        const at = entry.getBoundingClientRect(), stood = before.get(entry);
        if (stood === undefined) { if (before.has(entry.parentElement!) && seen(at.top, at.height)) fresh.push(entry); continue; }
        const move = stood - (at.top - box.top);
        if (Math.abs(move) >= 1 && (seen(was + stood, at.height) || seen(at.top, at.height))) rows.push({ el: entry, dy: move });
      }
    }
    if (groups.length + rows.length + fresh.length > MOVERS) return;
    for (const moved of [groups, rows]) {
      // whatever travels furthest is the one that changed; it passes over the rest
      const lead = moved.reduce((far, m) => Math.abs(m.dy) > Math.abs(far.dy) ? m : far, moved[0]);
      for (const { el, dy } of moved) {
        const over = el === lead.el ? { zIndex: 2 } : {};
        this.gliding.push(el.animate([{ transform: `translateY(${dy}px)`, ...over }, { transform: 'none', ...over }], GLIDE));
      }
    }
    for (const el of fresh) this.gliding.push(el.animate([{ transform: 'translateX(14px)' }, { transform: 'none' }], GLIDE));
  }

  /** Make a change to the list by hand and slide whatever it displaced. */
  private shifting(change: () => void) {
    const before = this.lively() ? this.places() : undefined;
    change();
    if (before) this.glide(before);
  }

  /** A folded list opening: it unrolls downward in four steps, like one of the game's menus. */
  private unfold(list?: Element | null) {
    if (list && this.lively()) list.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 140, easing: 'steps(4,start)' });
  }

  /** Mark what happened to each agent since the last draw: it now needs you, it shipped a task,
   *  it gained a level. With `show` off this only takes note, as on the first draw. */
  private mark(show: boolean) {
    for (const a of this.agents) {
      const progress = this.progressOf?.(a.pane_id), was = this.seen.get(a.pane_id);
      const now = { state: stateOf(a), shipped: progress?.shipped ?? 0, level: progress?.level ?? 0 };
      this.seen.set(a.pane_id, now);
      if (!show || !was) continue;
      const row = this.root.querySelector<HTMLElement>(`.agent-row[data-pane="${CSS.escape(a.pane_id)}"]`);
      if (!row) continue;
      if (now.state === 'blocked' && was.state !== 'blocked') {
        row.animate(ALARM, { duration: 480 });
        row.querySelector('.agent-state')?.animate([{ transform: 'scale(1.3)' }, { transform: 'none' }], POP);
      }
      // One more than last time is a task shipped just now; any other jump is the books arriving.
      if (now.shipped !== was.shipped + 1) continue;
      row.querySelector('canvas')?.animate(hop(4), { duration: 240 });
      const badge = row.querySelector<HTMLElement>('.level-badge');
      if (now.level === was.level) [...row.querySelectorAll('.xp-pips .on')].pop()?.animate([{ transform: 'scaleY(0)' }, { transform: 'none' }], { duration: 240, easing: 'steps(3,start)' });
      else if (badge) {
        // the level badge strikes gold; the legend's is gold already, so that one strikes white
        const lit = { background: badge.dataset.levelTier === 'legend' ? '#fff' : '#f2cd69', color: '#513509', borderColor: '#a77b20' };
        badge.animate([{ transform: 'scale(1.5)', ...lit, easing: POP.easing }, { transform: 'none', ...lit, offset: .4, easing: 'step-end' }, { transform: 'none' }], { duration: 400 });
      }
    }
    if (this.seen.size > this.agents.length) {
      const here = new Set(this.agents.map((a) => a.pane_id));
      for (const pane of this.seen.keys()) if (!here.has(pane)) this.seen.delete(pane);
    }
  }

  /** Nobody to list. The mascot stands there when the art pack has him, a steel chip when not. */
  private emptyHtml() {
    const clear = this.filter === 'blocked';
    const hire = document.getElementById('hire-agent') as HTMLButtonElement | null;
    const figure = this.mascot ? `<img class="roster-empty-fig" src="${MASCOT}" alt="">` : `<span class="roster-empty-fig">${studioIcon(clear ? 'check' : 'people', 24)}</span>`;
    return `<div class="roster-empty" data-roster-key="empty-${this.filter}">${figure}<b>${clear ? 'All clear, boss' : 'The office is empty'}</b><small>${
      clear ? 'Nobody is waiting on you.' : hire && !hire.disabled ? 'Press Hire to seat your first agent.' : 'Start an agent and they will appear here.'}</small></div>`;
  }

  private render() {
    const shown = this.filter === 'blocked' ? this.agents.filter((a) => a.agent_status === 'blocked') : this.agents;
    // agent.list includes bookkeeping fields that change frequently. Hash only the values this
    // panel actually renders, so an invisible backend update cannot replace the whole DOM.
    const key = JSON.stringify([
      this.filter, !!this.menuFor,
      [...this.collapsedProjects].sort(),
      this.moneyRows().map((ev) => [ev.id, ev.ts, ev.kind, ev.amount, ev.currency, ev.label, ago(ev.ts)]),
      shown.map((a) => {
        const project = projectOf(a), progress = this.progressOf?.(a.pane_id);
        return [a.pane_id, a.agent_status, stateOf(a), a.wait_notice?.kind, a.wait_notice?.detail, agentKind(a), employeeName(a), !!a.favorite, taskOf(a),
          project.path, project.name, lookFor(a.pane_id), progress?.level ?? 0, progress?.shipped ?? 0];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      shown.length ? '' : this.emptyHtml(),
    ]);
    // The one redraw that changes nothing visible: a held list going back into order.
    if (key === this.renderedKey && !(this.unsorted && !this.held())) return;
    const first = !this.renderedKey;
    this.renderedKey = key;
    const before = !first && !this.cut && this.lively() ? this.places() : undefined;
    const scrollTop = this.root.scrollTop;
    const salesScrollTop = this.root.querySelector<HTMLElement>('#sales-events')?.scrollTop ?? 0;
    const salesListFocused = document.activeElement?.id === 'sales-events';
    const restoreSalesScroll = () => {
      const list = this.root.querySelector<HTMLElement>('#sales-events');
      if (!list) return;
      if (list.scrollTop !== salesScrollTop) list.scrollTop = salesScrollTop;
      if (salesListFocused) list.focus({ preventScroll: true });
    };
    const existingMoney = this.animateMoney.size ? null : this.root.querySelector<HTMLElement>('.roster-money');
    const salesFocused = document.activeElement?.classList.contains('money-head');
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-pane]')?.dataset.pane;
    const projectFocused = (document.activeElement as HTMLElement | null)?.dataset.project;
    const collapseFocused = document.activeElement?.classList.contains('project-collapse');
    const groups = new Map<string, Group>();
    for (const agent of shown) {
      const project = projectOf(agent), key = project.path || project.name;
      const group = groups.get(key) ?? { ...project, agents: [] };
      group.agents.push(agent); groups.set(key, group);
    }
    const ordered = [...groups.values()].sort((a, b) => {
      const urgency = (g: typeof a) => Math.min(...g.agents.map((agent) => STATUS_ORDER[agent.agent_status]));
      return urgency(a) - urgency(b) || a.name.localeCompare(b.name);
    });
    for (const group of ordered) group.agents.sort((a, b) => STATUS_ORDER[a.agent_status] - STATUS_ORDER[b.agent_status] || Number(!!b.favorite) - Number(!!a.favorite) || employeeName(a).localeCompare(employeeName(b)) || a.pane_id.localeCompare(b.pane_id));
    this.arrange(ordered);
    this.patch(this.moneyHtml() + (ordered.length ? ordered.map((group) => {
      const blocked = group.agents.filter((a) => a.agent_status === 'blocked').length;
      const working = group.agents.filter((a) => a.agent_status === 'working' && !a.wait_notice).length;
      const key = group.path || group.name;
      // Needs-you is a triage view: never hide the agents who require action just because their
      // project was collapsed in the full roster.
      const collapsed = this.filter === 'all' && this.collapsedProjects.has(key);
      return `<section data-roster-key="${encodeURIComponent(key)}" class="roster-project${collapsed ? ' collapsed' : ''}">
        <div class="project-head">
          <button type="button" class="project-collapse" data-project="${encodeURIComponent(key)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${esc(group.name)}" aria-expanded="${!collapsed}"><span class="project-toggle" aria-hidden="true">▾</span></button>
          <button type="button" class="project-focus" title="Pan to ${esc(key)}" data-project="${encodeURIComponent(key)}" aria-label="Pan to ${esc(group.name)} desks"><span class="project-folder" aria-hidden="true">▰</span><b>${esc(group.name)}</b><span class="project-count">${working ? `${working} working · ` : ''}${blocked ? `${blocked} ${blocked === 1 ? 'needs' : 'need'} you · ` : ''}${group.agents.length} ${group.agents.length === 1 ? 'desk' : 'desks'}</span></button>
        </div>
        <div class="project-agents"${collapsed ? ' hidden' : ''}>${group.agents.map((a) => {
          const kind = agentKind(a), progress = this.progressOf?.(a.pane_id), task = taskOf(a) || 'No active task';
          const state = stateOf(a);
          const label = a.wait_notice ? a.wait_notice.kind === 'rate_limit' ? 'Rate limited' : 'Waiting to retry' : a.completed_task ? 'done' : a.agent_status === 'unknown' ? this.unknownLabel : statusLabel(a.agent_status);
          // three pips in the badge: tasks shipped toward the next level
          const badge = progress ? `<span class="level-badge" data-level-tier="${tierForLevel(progress.level)}" title="${rankForLevel(progress.level)} · Level ${progress.level} · ${progress.inLevel}/${progress.toNext} to the next">Lv ${progress.level}<span class="xp-pips" aria-hidden="true">${
            Array.from({ length: progress.toNext }, (_, i) => `<i${i < progress.inLevel ? ' class="on"' : ''}></i>`).join('')}</span></span>` : '';
          return `<div class="agent-entry${this.menuFor ? ' has-menu' : ''}" data-seat="${esc(a.pane_id)}"><button type="button" class="agent-row ${state}" data-pane="${esc(a.pane_id)}" aria-label="Open ${esc(employeeName(a))}, ${esc(label)}, ${esc(task)}">
            <span class="roster-avatar"><span class="status-lamp ${state}" title="${esc(label)}"></span></span>
            <span class="agent-copy"><span class="agent-line"><b>${a.favorite ? '★ ' : ''}${esc(employeeName(a))}</b>${badge}<span class="agent-handle">${esc(handleOf(kind, a.pane_id))}</span></span><span class="agent-task">${esc(a.wait_notice?.detail ?? task)}</span></span>
            <span class="agent-state st ${state}">${esc(label)}</span><span class="agent-open" aria-hidden="true">›</span>
          </button>${this.menuFor ? `<button type="button" class="agent-menu" data-menu-pane="${esc(a.pane_id)}" aria-label="More for ${esc(employeeName(a))}" aria-haspopup="menu" title="Pin, rename and more">⋯</button>` : ''}</div>`;
        }).join('')}</div>
      </section>`;
    }).join('') : this.emptyHtml()));
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
    if (this.root.scrollTop !== scrollTop) this.root.scrollTop = scrollTop;
    if (before) this.glide(before);
    this.mark(!!before);
    this.beat();
    // money coming in: the heading's coin hops, as the one on the funds panel does
    if (before && [...this.animateMoney].some((id) => this.root.querySelector(`.money-row.up[data-money="${CSS.escape(id)}"]`))) this.root.querySelector('.money-coin')?.animate(hop(4), { duration: 200 });
    if (this.unsorted) this.settleSoon();
    this.animateMoney.clear();
  }
}
