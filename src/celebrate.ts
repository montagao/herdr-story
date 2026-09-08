// The window that opens when an agent ships something.
//
// Game Dev Story throws a party when a game goes out: the staff put their arms up and confetti
// falls over the whole screen. event0.png is that scene, and this uses it — four cheering figures
// and the confetti field, with the game's own "happy" jingle from the sound pack.
//
// It fires on the same signal that counts a shipped task for levels: a 'done' event, or a return
// to idle after real work. One window at a time, briefly, and never while the agent dialog is
// open — a monitor that covers itself in pop-ups stops being a monitor. ?celebrate=0 turns it off.
import type { AgentInfo, MoneyEvent, OfficeEvent } from '../shared/types';
import { agentKind, titleOf } from '../shared/types';
import { avatarCanvas } from './feed/avatar';
import { displayName, clip, dur, moneyAmount } from './feed/feed';
import { audio } from './audio';
import { WORK, type WorkKind } from './work';
import type { AgentProgress } from './model/office';
import { closeOnEscape } from './escape';
import { employeeName, type JournalEntry } from '../shared/studio';
import { anchorOfficeNotification } from './office-notification';

/** Only money arriving throws a party. Refunds, failures and cancellations do not. */
const PAYDAY = new Set<MoneyEvent['kind']>(['sale', 'subscribed', 'subscription_started']);
const PAYDAY_WORDS: Partial<Record<MoneyEvent['kind'], string>> = {
  sale: 'payment received',
  subscribed: 'new subscriber',
  subscription_started: 'subscription started',
};

const FIGURES = [[29, 44], [58, 42], [58, 47], [29, 45]] as const;
const SHOW_MS = 5200;
const GAP_MS = 4000;      // quiet time between parties, however fast work lands

export class Celebrate {
  private root = document.getElementById('party')!;
  private timer?: number;
  private last = 0;
  enabled = new URLSearchParams(location.search).get('celebrate') !== '0';
  /** Set from main so the card can show what the agent has done overall. */
  progress?: (paneId: string) => AgentProgress;
  /** True while the agent dialog is up; the party waits rather than stacking on it. */
  busy = () => false;
  onJournalEntry?: (id: string) => void;
  private entryId?: string;

  constructor() {
    anchorOfficeNotification(this.root);
    this.root.addEventListener('click', () => {
      const id = this.entryId;
      this.close();
      if (id) this.onJournalEntry?.(id);
    });
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.root.click(); }
    });
    closeOnEscape(this.root, () => this.close());
  }

  close() {
    this.root.hidden = true;
    this.entryId = undefined;
    this.root.removeAttribute('tabindex');
    this.root.removeAttribute('role');
    this.root.removeAttribute('aria-label');
    this.root.innerHTML = '';
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  /** The journal entry a completion wrote, so the party can say what the journal says. */
  entryOf?: (id: string) => JournalEntry | undefined;
  show(a: AgentInfo, ev: OfficeEvent, gained?: WorkKind) {
    const now = Date.now();
    if (!this.enabled || this.busy() || now - this.last < GAP_MS) return;
    this.last = now;
    this.close();
    this.entryId = ev.completion?.entryId;
    this.root.tabIndex = 0;
    this.root.setAttribute('role', 'button');
    this.root.setAttribute('aria-label', this.entryId ? 'Open completion in journal' : 'Dismiss notification');
    const kind = agentKind(a);
    const p = this.progress?.(a.pane_id);
    const took = ev.prev_for_ms && ev.prev_for_ms > 4000 ? `${dur(ev.prev_for_ms)} of work` : '';
    // The bridge describes the entry from the agent's transcript before the event goes out, so
    // the card can carry the task as the person asked it and the agent's own account of the work.
    const entry = ev.completion?.entryId ? this.entryOf?.(ev.completion.entryId) : undefined;
    const placeholder = !entry || /^(Agent reported completion\.|Returned to idle after working)/.test(entry.notes);
    const title = entry?.title || ev.title || titleOf(a);
    // one sentence-ish of plain text: the first paragraph, inline markdown marks removed
    const plain = (s: string) => s.replace(/\*\*|__|`|~~/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^[#>\-•\s]+/, '').replace(/\s+/g, ' ').trim();
    const summary = placeholder ? '' : clip(plain(entry.notes.split(/\n\s*\n/)[0]), 170);
    const fig = Math.floor(Math.random() * FIGURES.length);
    this.root.innerHTML = `<div class="party-win">
      <div class="party-sky"></div>
      <div class="party-body">
        <img class="party-fig" style="--figure-width:${FIGURES[fig][0]};--figure-height:${FIGURES[fig][1]}" src="/assets/gds/celebrate/cheer_${fig}.png" alt="" />
        <div class="party-text">
          <div class="party-head"><span class="party-avatar"></span><b>${esc(employeeName(a))}</b> shipped it!</div>
          <div class="party-task">${esc(clip(title, 72)) || 'a task'}</div>
          ${summary ? `<div class="party-summary">${esc(summary)}</div>` : ''}
          <div class="party-meta">${[gained ? `${WORK[gained].stat} +1` : '', took, p ? `Lv ${p.level}` : '', p ? `${p.shipped} shipped` : ''].filter(Boolean).join(' · ')}</div>
        </div>
        <img class="party-trophy" src="/assets/gds/celebrate/trophy.png?v=2" alt="" />
      </div>
    </div>`;
    this.root.querySelector('.party-avatar')!.appendChild(avatarCanvas(a.pane_id, 24));
    this.root.hidden = false;
    this.cheer();
    // a card with something to read stays a little longer
    this.timer = window.setTimeout(() => this.close(), summary ? SHOW_MS + 2500 : SHOW_MS);
  }

  /** Getting paid, celebrated like a shipped game.
   *
   *  Money is the thing this whole office is for, so a payment gets the same window a finished
   *  game gets — cheering figure, confetti, fanfare — with the amount as the headline instead of a
   *  task title. Only money actually arriving: a refund or a failed charge still gets its coin on
   *  the floor and its line in the roster, but nobody throws a party for those. */
  money(ev: MoneyEvent) {
    if (ev.source === 'revenuecat' && ev.amount <= 0) return;
    const now = Date.now();
    if (!this.enabled || !PAYDAY.has(ev.kind) || this.busy() || now - this.last < GAP_MS) return;
    this.last = now;
    this.close();
    const fig = Math.floor(Math.random() * FIGURES.length);
    const amount = ev.amount ? moneyAmount(ev) : '';
    // A subscription with no charge on it is still news, it just has no figure to shout.
    const headline = amount || (ev.kind === 'sale' ? 'Paid!' : 'New subscriber!');
    this.root.innerHTML = `<div class="party-win payday">
      <div class="party-sky"></div>
      <div class="party-body">
        <img class="party-fig" style="--figure-width:${FIGURES[fig][0]};--figure-height:${FIGURES[fig][1]}" src="/assets/gds/celebrate/cheer_${fig}.png" alt="" />
        <div class="party-text">
          <div class="party-head"><span class="payday-coin" aria-hidden="true"></span><b class="payday-amount">${esc(headline)}</b></div>
          <div class="party-task">${esc(clip(ev.label, 64)) || 'a payment'}</div>
          <div class="party-meta">${esc(PAYDAY_WORDS[ev.kind] ?? 'payment received')}</div>
        </div>
        <img class="party-trophy" src="/assets/gds/celebrate/trophy.png?v=2" alt="" />
      </div>
    </div>`;
    this.root.hidden = false;
    this.cheer();
    this.timer = window.setTimeout(() => this.close(), SHOW_MS);
  }

  /** The fanfare goes through the shared audio gate rather than holding its own copy of the file:
   *  'done' plays the same jingle, so two of them would otherwise sound over each other. */
  private cheer() { audio.play('party'); }
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
