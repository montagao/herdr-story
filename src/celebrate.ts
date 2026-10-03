// The window that opens when an agent ships something.
//
// Game Dev Story throws a party when a game goes out: the staff put their arms up and confetti
// falls over the whole screen. event0.png is that scene, and this uses it — four cheering figures
// and the confetti field, with the game's own "happy" jingle from the sound pack.
//
// It fires on the same signal that counts a shipped task for levels: a 'done' event, or a return
// to idle after real work. One window at a time, briefly, and never while the agent dialog is
// open — a monitor that covers itself in pop-ups stops being a monitor. A card that cannot go up
// when it is earned waits for the screen instead of being lost, and work that lands while a card
// is already up joins it as one more line. ?celebrate=0 turns it off.
import type { AgentInfo, MoneyEvent, OfficeEvent } from '../shared/types';
import { titleOf } from '../shared/types';
import { avatarCanvas } from './feed/avatar';
import { displayName, clip, dur, moneyAmount } from './feed/feed';
import { audio } from './audio';
import { gameCurrency } from './currency';
import { WORK, type WorkKind } from './work';
import { rankForLevel, type AgentProgress } from './model/office';
import { closeOnEscape } from './escape';
import { employeeName, type JournalEntry } from '../shared/studio';
import { Lifetime, anchorOfficeNotification } from './office-notification';
import { replayAnimation, snapShut } from './motion';
import './celebrate.css';

/** Only money arriving throws a party. Refunds, failures and cancellations do not. */
const PAYDAY = new Set<MoneyEvent['kind']>(['sale', 'subscribed', 'subscription_started']);
const PAYDAY_WORDS: Partial<Record<MoneyEvent['kind'], string>> = {
  sale: 'payment received',
  subscribed: 'new subscriber',
  subscription_started: 'subscription started',
};

const FIGURES = [[29, 44], [58, 42], [58, 47], [29, 45]] as const;
const SHOW_MS = 5200;
const GAP_MS = 4000;      // the least time between one card going up and the next, however fast work lands
const REST_MS = 1500;     // and the least the office is left clear once a card has gone
const WAIT_MS = 60_000;  // a card that has waited this long for the screen is old news
const POLL_MS = 600;
const JOIN_MS = 2200;     // what each task that joins an open card adds to its time
const STREAK_MS = 9000;   // the longest a card stays up, however many join it
const READ_MS = 1500;     // the least time a new line needs to be read
const JOIN_ROWS = 2;

/** A shipped task, with the agent's progress as it stood when the task landed. */
interface Ship { a: AgentInfo; ev: OfficeEvent; gained?: WorkKind; progress?: AgentProgress; at: number }
interface Payday { ev: MoneyEvent; described: string; at: number }

export class Celebrate {
  private root = document.getElementById('party')!;
  private life = new Lifetime(() => this.close());
  private pumpTimer?: number;
  /** No new card before this: the gap after one goes up, and the rest after one comes down. */
  private notBefore = 0;
  private shownAt = 0;
  /** The tasks on the open card, its headline first. A payday card has none. */
  private ships: Ship[] = [];
  /** Cards that could not go up when they were earned. */
  private waiting: { ships: Ship[]; paydays: Payday[] } = { ships: [], paydays: [] };
  private remaining = 0;
  advance(delta: number) {
    if (!this.replay || !this.isOpen) return;
    this.remaining -= delta;
    if (this.remaining <= 0) this.close();
  }
  /** Call once the card is drawn: outside a replay, a pointer on the card can hold it longer. */
  private dismissAfter(ms: number) {
    if (this.replay) { this.remaining = ms; return; }
    this.life.start(ms);
    this.life.watch(this.root.querySelector('.party-win')!);
  }
  /** Timeline playback already spaces events; do not discard recorded celebrations. */
  replay = false;
  get isOpen() { return !this.root.hidden; }
  enabled = new URLSearchParams(location.search).get('celebrate') !== '0';
  /** Set from main so the card can show what the agent has done overall. */
  progress?: (paneId: string) => AgentProgress;
  /** True while the agent dialog is up; the party waits rather than stacking on it. */
  busy = () => false;
  onJournalEntry?: (id: string) => void;
  /** The card was sent away by hand, so whatever tune it started should stop with it. */
  onDismiss?: () => void;
  private entryId?: string;

  constructor() {
    anchorOfficeNotification(this.root);
    this.root.addEventListener('click', () => {
      const id = this.entryId;
      this.dismiss(!id);
      if (id) this.onJournalEntry?.(id);
    });
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.root.click(); }
    });
    closeOnEscape(this.root, () => this.dismiss(true));
  }

  /** A click or Escape. The journal window makes its own sound when the click leads there. */
  private dismiss(blip: boolean) {
    this.onDismiss?.();
    if (blip) audio.blip('back');
    this.close();
  }

  close() {
    const open = this.isOpen;
    if (!this.replay) snapShut(this.root.querySelector('.party-win'));
    this.clear();
    if (!open || this.replay) return;
    this.notBefore = Math.max(this.notBefore, Date.now() + REST_MS);
    this.pump();
  }

  /** Take the card down with no ceremony, as when one card makes way for the next. */
  private clear() {
    this.root.hidden = true;
    this.entryId = undefined;
    this.ships = [];
    this.root.removeAttribute('tabindex');
    this.root.removeAttribute('role');
    this.root.removeAttribute('aria-label');
    this.root.innerHTML = '';
    this.life.stop();
  }

  /** Whether a new card has to wait: something else has the screen, nobody is looking, or the
   *  last card is too recent. Money may take over from a shipped task, though never from other
   *  money and never from under a pointer that is reading the card. */
  private held(now: number, payday = false) {
    if (this.busy() || document.hidden || now < this.notBefore) return true;
    return this.isOpen && !(payday && this.ships.length > 0 && !this.life.holding);
  }

  /** Put up whatever has been waiting, money first, as soon as it may be seen. */
  private pump() {
    clearTimeout(this.pumpTimer); this.pumpTimer = undefined;
    const now = Date.now(), waiting = this.waiting;
    waiting.ships = waiting.ships.filter(ship => now - ship.at < WAIT_MS);
    waiting.paydays = waiting.paydays.filter(payday => now - payday.at < WAIT_MS);
    if (waiting.paydays.length) { if (!this.held(now, true)) this.payday(waiting.paydays.shift()!); }
    else if (waiting.ships.length && !this.held(now)) this.raise(waiting.ships.splice(0));
    if (waiting.ships.length || waiting.paydays.length) this.pumpTimer = window.setTimeout(() => this.pump(), POLL_MS);
  }

  /** The journal entry a completion wrote, so the party can say what the journal says. */
  entryOf?: (id: string) => JournalEntry | undefined;
  private taskOf(ship: Ship) {
    const id = ship.ev.completion?.entryId;
    return (id ? this.entryOf?.(id)?.title : '') || ship.ev.title || titleOf(ship.a);
  }

  /** Says whether the task has a card, up now or on its way, so one that never will still gets
   *  a sound. */
  show(a: AgentInfo, ev: OfficeEvent, gained?: WorkKind): boolean {
    if (!this.enabled) return false;
    const ship: Ship = { a, ev, gained, progress: this.progress?.(a.pane_id), at: Date.now() };
    if (this.replay) { this.raise([ship]); return true; }
    if (this.join(ship)) return true;
    this.waiting.ships.push(ship);
    // Behind a window or in a hidden tab the card may be a while: one chord says the work landed.
    if (this.busy() || document.hidden) audio.play('ship');
    this.pump();
    return true;
  }

  /** A task that lands while a shipped card is up becomes one more line on it: a streak, not a
   *  second pop-up. */
  private join(ship: Ship) {
    if (!this.isOpen || !this.ships.length || this.busy() || document.hidden) return false;
    const left = Math.min(this.shownAt + STREAK_MS - Date.now(), this.life.left + JOIN_MS);
    // with no time left to read it, the line is better off on the next card
    if (!this.life.holding && left < READ_MS) return false;
    this.ships.push(ship);
    this.joined(ship);
    audio.blip('pop');
    this.life.start(Math.max(READ_MS, left));
    return true;
  }

  private joined(ship: Ship) {
    const text = this.root.querySelector('.party-text')!;
    let list = text.querySelector('.party-also');
    if (!list) {
      list = document.createElement('div'); list.className = 'party-also';
      list.innerHTML = '<span class="party-streak"></span>';
      text.append(list);
    }
    const streak = list.querySelector('.party-streak')!, extra = this.ships.length - 1;
    streak.textContent = `${this.ships.length} in a row!`;
    replayAnimation(streak, 'bump');
    if (extra <= JOIN_ROWS) {
      const row = document.createElement('div'); row.className = 'party-also-row';
      row.innerHTML = `<b>${esc(employeeName(ship.a))}</b> ${esc(clip(this.taskOf(ship), 60)) || 'a task'}`;
      list.append(row);
      return;
    }
    let more = list.querySelector('.party-also-more');
    if (!more) { more = document.createElement('div'); more.className = 'party-also-more'; list.append(more); }
    more.textContent = `+${extra - JOIN_ROWS} more`;
  }

  private raise(ships: Ship[]) {
    const now = Date.now();
    this.clear();
    const [first, ...rest] = ships, { a, ev, gained, progress: p } = first;
    this.ships = [first]; this.shownAt = now; this.notBefore = now + GAP_MS;
    this.entryId = ev.completion?.entryId;
    this.root.tabIndex = 0;
    this.root.setAttribute('role', 'button');
    this.root.setAttribute('aria-label', this.entryId ? 'Open completion in journal' : 'Dismiss notification');
    const took = ev.prev_for_ms && ev.prev_for_ms > 4000 ? `${dur(ev.prev_for_ms)} of work` : '';
    // a card that had to wait says how long ago its news is
    const ago = now - first.at > 20_000 ? `${dur(now - first.at)} ago` : '';
    // The bridge describes the entry from the agent's transcript before the event goes out, so
    // the card can carry the task as the person asked it and the agent's own account of the work.
    const entry = ev.completion?.entryId ? this.entryOf?.(ev.completion.entryId) : undefined;
    const placeholder = !entry || /^(Agent reported completion\.|Returned to idle after working)/.test(entry.notes);
    // one sentence-ish of plain text: the first paragraph, inline markdown marks removed
    const plain = (s: string) => s.replace(/\*\*|__|`|~~/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^[#>\-•\s]+/, '').replace(/\s+/g, ' ').trim();
    const summary = placeholder ? '' : clip(plain(entry.notes.split(/\n\s*\n/)[0]), 170);
    // Three shipped tasks make a level, so the task that empties the bar is the one that filled it.
    const levelled = !!p && p.shipped > 0 && p.inLevel === 0;
    const promoted = levelled && p.level > 1 && p.rank !== rankForLevel(p.level - 1);
    const pips = p ? Array.from({ length: p.toNext }, (_, i) => `<i${i < p.inLevel ? ` class="on${i === p.inLevel - 1 ? ' new' : ''}"` : ''}></i>`).join('') : '';
    const level = p ? `Lv ${p.level}<span class="party-xp${levelled ? ' full' : ''}" aria-hidden="true">${pips}</span>` : '';
    const fig = Math.floor(Math.random() * FIGURES.length);
    // The gold frame and the banner are for a new rank. A level comes every third task; it gets the
    // filled bar and the words, and stays an ordinary card.
    this.root.innerHTML = `<div class="party-win${promoted ? ' levelup' : ''}">
      <div class="party-sky"></div>
      <div class="party-body">
        <img class="party-fig" style="--figure-width:${FIGURES[fig][0]};--figure-height:${FIGURES[fig][1]}" src="/assets/gds/celebrate/cheer_${fig}.png" alt="" />
        <div class="party-text">
          ${promoted ? `<div class="party-banner"><span class="party-levelup" role="img" aria-label="Level up!"></span><span>Promoted to <b>${esc(p.rank)}</b></span></div>` : ''}
          <div class="party-head"><span class="party-avatar"></span><b>${esc(employeeName(a))}</b> ${levelled ? `reached Lv ${p.level}!` : 'shipped it!'}</div>
          <div class="party-task">${esc(clip(this.taskOf(first), 72)) || 'a task'}</div>
          ${summary ? `<div class="party-summary">${esc(summary)}</div>` : ''}
          <div class="party-meta">${[gained ? `${WORK[gained].stat} +1` : '', took, ago, level, p ? `${p.shipped} shipped` : ''].filter(Boolean).join(' · ')}</div>
        </div>
        <img class="party-trophy" src="/assets/gds/celebrate/trophy.png?v=2" alt="" />
      </div>
    </div>`;
    this.root.querySelector('.party-avatar')!.appendChild(avatarCanvas(a.pane_id, 24));
    for (const ship of rest) { this.ships.push(ship); this.joined(ship); }
    this.root.hidden = false;
    // The level-up has its own tune. The floor may have just played it, and then it is not repeated.
    if (!promoted || !audio.play('levelup')) audio.play('done');
    // a card with something to read stays a little longer
    this.dismissAfter(Math.min(STREAK_MS, (summary ? SHOW_MS + 2500 : SHOW_MS) + rest.length * JOIN_MS));
  }

  /** Getting paid, celebrated like a shipped game.
   *
   *  Money is the thing this whole office is for, so a payment gets the same window a finished
   *  game gets — cheering figure, confetti, fanfare — with the amount as the headline instead of a
   *  task title. Only money actually arriving: a refund or a failed charge still gets its coin on
   *  the floor and its line in the roster, but nobody throws a party for those. */
  money(ev: MoneyEvent, described = '') {
    if (ev.source === 'revenuecat' && ev.amount <= 0) return;
    if (!this.enabled || !PAYDAY.has(ev.kind)) return;
    const payday: Payday = { ev, described, at: Date.now() };
    if (this.replay) { this.payday(payday); return; }
    // A scene or another card in the way delays the party; it does not cancel it.
    this.waiting.paydays.push(payday);
    if (this.waiting.paydays.length > 3) this.waiting.paydays.shift();
    this.pump();
  }

  private payday({ ev, described }: Payday) {
    this.clear();
    this.notBefore = Date.now() + GAP_MS;
    const fig = Math.floor(Math.random() * FIGURES.length);
    const amount = ev.amount ? gameCurrency.display(ev.amount, ev.currency) : '';
    // A subscription with no charge on it is still news, it just has no figure to shout.
    const headline = amount || (ev.kind === 'sale' ? 'Paid!' : 'New subscriber!');
    this.root.innerHTML = `<div class="party-win payday">
      <div class="party-sky"></div>
      <div class="party-body">
        <img class="party-fig" style="--figure-width:${FIGURES[fig][0]};--figure-height:${FIGURES[fig][1]}" src="/assets/gds/celebrate/cheer_${fig}.png" alt="" />
        <div class="party-text">
          <div class="party-head"><span class="payday-coin" aria-hidden="true"></span><b class="payday-amount">${esc(headline)}</b></div>
          <div class="party-task">${esc(clip(described.replace(new RegExp(`\\s·\\s${amount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') || ev.label, 72)) || 'a payment'}</div>
          <div class="party-meta">${esc(PAYDAY_WORDS[ev.kind] ?? 'payment received')}${described && ev.label ? ` · ${esc(clip(ev.label, 40))}` : ''}</div>
        </div>
        <img class="party-trophy" src="/assets/gds/celebrate/trophy.png?v=2" alt="" />
      </div>
    </div>`;
    this.root.hidden = false;
    // Two beats: the till has just rung on the floor, and the fanfare answers it. A big payment
    // or a new subscriber gets the whole tune; a small one the same phrase a shipped task gets,
    // and so does a big one when a ceremony has only just used the tune up.
    const big = ev.kind !== 'sale' || Math.abs(ev.amount) >= 20;
    window.setTimeout(() => { if (this.isOpen && !(big && audio.play('party'))) audio.play('done'); }, this.replay ? 0 : 420);
    this.dismissAfter(SHOW_MS);
  }
}

function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
