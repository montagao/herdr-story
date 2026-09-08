// Getting a payments key into the office, in four steps — Stripe or RevenueCat, or both.
//
// The two differ in how much can be done for you, so each gets its own first step:
//
//   * Stripe's key form takes the permissions in the URL, so its link arrives with the key named
//     and its read permissions already ticked; the person only presses Create.
//   * RevenueCat's takes no parameters at all, so its step names the screen, the button and the
//     scopes, and offers the project id as a way to drop one of them.
//
// Everything after that is shared: the same file, the same restart, the same watcher.
//
// Stripe's key form takes the permissions in the URL, so the link arrives with the permissions already
// selected and the key named — the person only has to press Create. The parameters are `name` and
// a repeated `permissions[]`, each an `rak_`-prefixed permission from Stripe's permissions
// reference; this is the same shape other products use to onboard a read-only key.
//
// Which permissions, and why:
//   * rak_balance_read  — GET /v1/balance_transactions, the revenue figure. Not
//     balance_transaction_source_read: that one is for expanding a transaction's `source`, which
//     this never asks for, and it drags several other read permissions along with it.
//   * rak_customer_read — customer profiles opened from a payment.
//   * rak_event_read    — GET /v1/events, the sales feed and the office's reactions.
//
// The permission table is still on screen, because this part of the Dashboard has changed before
// and prefill links have broken with it. If the form ever comes up empty the table is what to set
// by hand, and an unrecognised parameter costs nothing — Stripe just renders the ordinary form.
//
// The last step watches the bridge instead of asking "did it work?": once the key is live the
// window says so on its own.
import { audio } from './audio';
import { closeOnEscape } from './escape';
import { mountRevenueCatWebhook } from './revenuecat-webhook-setup';

const KEY_NAME = 'herdr-story';
/** Read on Balance, Events, and Customers for the payment detail view. No writes. */
const PERMISSIONS: [string, string, string][] = [
  ['Balance', 'Read', 'rak_balance_read'],
  ['Events', 'Read', 'rak_event_read'],
  ['Customers', 'Read', 'rak_customer_read'],
];
function createUrl(test = false) {
  const q = new URLSearchParams({ name: KEY_NAME });
  for (const [, , id] of PERMISSIONS) q.append('permissions[]', id);
  return `https://dashboard.stripe.com/${test ? 'test/' : ''}apikeys/create?${q}`;
}
const CREATE_URL = createUrl();
const CREATE_URL_TEST = createUrl(true);
const WATCH_MS = 2500;

type Provider = 'stripe' | 'revenuecat';

interface Setup { configured: boolean; stripe?: boolean; revenuecat?: boolean; writable?: boolean;
  stripe_hint?: string | null; revenuecat_hint?: string | null;
  env_path: string; cwd: string; var_name: string; error: string | null }

/** RevenueCat has no equivalent of Stripe's prefill: its key form takes no query parameters, so
 *  this names the screen and the one scope instead. Discovering the project needs a second scope;
 *  setting REVENUECAT_PROJECT_ID skips that. */
const RC_KEYS_URL = 'https://app.revenuecat.com/';
const RC_DOCS_URL = 'https://www.revenuecat.com/docs/projects/authentication';

export class BillingSetup {
  private root = document.getElementById('billing-setup');
  private watch?: number;
  private stopWebhook?: () => void;
  private setup: Setup = { configured: false, env_path: '.env', cwd: '.', var_name: 'STRIPE_RESTRICTED_KEY', error: null };
  /** Called when the key goes live, so the rest of the page can pick the number up. */
  onConnected?: () => void;
  /** Which provider's instructions are on screen. */
  private choice: Provider = 'stripe';

  constructor() {
    this.root?.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
    if (this.root) closeOnEscape(this.root, () => this.close());
  }

  async open() {
    if (!this.root) return;
    try {
      const res = await fetch('/api/setup', { headers: { accept: 'application/json' } });
      if (res.ok) this.setup = { ...this.setup, ...(await res.json() as Setup) };
    } catch { /* the paths fall back to something sensible */ }
    // Land on whichever is still missing, so the window opens on the useful half.
    this.choice = this.setup.stripe && !this.setup.revenuecat ? 'revenuecat' : 'stripe';
    this.render();
    this.root.hidden = false;
    audio.play('open');
    this.watch = window.setInterval(() => void this.poll(), WATCH_MS);
  }

  close() {
    if (!this.root || this.root.hidden) return;
    this.stopWebhook?.();
    this.root.hidden = true;
    this.root.innerHTML = '';
    if (this.watch) { clearInterval(this.watch); this.watch = undefined; }
    audio.play('close');
  }

  /** Hand a pasted key to the bridge, which checks it with the provider before keeping it. */
  private async save(input: HTMLInputElement) {
    const status = this.root?.querySelector('.setup-status');
    const key = input.value.trim();
    if (!status || !key) return;
    status.className = 'setup-status';
    status.textContent = `Checking the key with ${this.choice === 'revenuecat' ? 'RevenueCat' : 'Stripe'}…`;
    try {
      const res = await fetch('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: this.choice, key }) });
      const body = await res.json() as { ok?: boolean; error?: string; hint?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `The bridge replied ${res.status}`);
      input.value = '';                       // the field never keeps it around
      if (this.choice === 'revenuecat') { this.setup.revenuecat = true; this.setup.revenuecat_hint = body.hint ?? null; }
      else { this.setup.stripe = true; this.setup.stripe_hint = body.hint ?? null; }
      this.render();
      void this.poll();                       // the watcher takes it from here and turns green
    } catch (err) {
      status.className = 'setup-status bad';
      status.textContent = (err as Error).message;
    }
  }

  /** Ask the bridge whether the key has arrived yet. */
  private async poll() {
    try {
      const res = await fetch('/api/revenue', { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const r = await res.json() as { source: string; error?: string };
      const status = this.root?.querySelector('.setup-status');
      if (!status) return;
      if (r.source !== 'none') {
        status.className = 'setup-status ok';
        status.textContent = `Connected. The office is on ${r.source === 'both' ? 'Stripe and RevenueCat' : r.source === 'revenuecat' ? 'RevenueCat' : 'Stripe'}.`;
        if (this.watch) { clearInterval(this.watch); this.watch = undefined; }
        audio.play('done');
        this.onConnected?.();
      } else if (r.error) {
        status.className = 'setup-status bad';
        status.textContent = r.error;
      } else {
        status.className = 'setup-status';
        status.textContent = 'Waiting for the bridge to come back with a key…';
      }
    } catch { /* bridge restarting: exactly what step 3 asked for */ }
  }

  private render() {
    if (!this.root) return;
    this.stopWebhook?.();
    const rc = this.choice === 'revenuecat';
    const current = rc ? this.setup.revenuecat_hint : this.setup.stripe_hint;
    const varName = rc ? 'REVENUECAT_API_KEY' : this.setup.var_name;
    const envLine = `${varName}=${rc ? 'sk_…' : 'rk_live_…'}`;
    const restart = 'npm run bridge';
    const tab = (id: Provider, name: string, done?: boolean) =>
      `<button type="button" class="setup-tab${this.choice === id ? ' on' : ''}" data-pick="${id}">`
      + `${name}${done ? '<i class="setup-tick" title="already connected">✓</i>' : ''}</button>`;

    this.root.innerHTML = `<div class="setup-win" role="dialog" aria-label="Connect payments">
      <div class="setup-head"><span class="setup-coin"></span><b>Connect payments</b><button type="button" class="setup-x" aria-label="Close">×</button></div>
      <div class="setup-body">
        <p class="setup-intro">See real revenue and sales in the office. Customer details stay private.</p>
        <div class="setup-tabs" role="tablist">${tab('stripe', 'Stripe', this.setup.stripe)}${tab('revenuecat', 'RevenueCat', this.setup.revenuecat)}</div>

        <section class="setup-step"><h3><i>1</i>Create a read-only key</h3>${rc ? `
          <p>RevenueCat's key form takes no parameters, so this one is by hand. In
             <a href="${RC_KEYS_URL}" target="_blank" rel="noopener noreferrer">the dashboard</a>, open
             <b>Project settings → API keys</b> and press <b>+ New secret API key</b> — a <b>v2</b> key
             (<a href="${RC_DOCS_URL}" target="_blank" rel="noopener noreferrer">docs</a>).</p>
          <table class="setup-perms"><tbody>
            <tr><td>Charts &amp; metrics<small>charts_metrics:overview:read</small></td><td><b>Read</b></td></tr>
            <tr><td>Projects<small>project_configuration:projects:read</small></td><td><b>Read</b></td></tr>
          </tbody></table>
          <p class="setup-hint">The second is only used to find your project id — set
             <button type="button" class="copy-inline" data-copy="REVENUECAT_PROJECT_ID=">REVENUECAT_PROJECT_ID</button>
             in the same file and you can leave it off.</p>
          <p class="setup-hint">RevenueCat reports gross revenue before taxes and store fees for your selected date range.
             Ranges use UTC calendar dates; Today includes the current partial day. Connect webhooks below
             to receive individual payment notifications.</p>` : `
          <p>This opens Stripe with the key named and the read permissions already selected — just press <b>Create key</b>.</p>
          <p><a class="setup-go" href="${CREATE_URL}" target="_blank" rel="noopener noreferrer">Create the key in Stripe →</a>
             <a class="setup-alt" href="${CREATE_URL_TEST}" target="_blank" rel="noopener noreferrer">test mode</a></p>
          <details class="setup-fallback"><summary>If the form comes up empty, set these permissions by hand</summary>
            <table class="setup-perms"><tbody>${PERMISSIONS.map(([res, level, id]) =>
              `<tr><td>${res}<small>${id}</small></td><td><b>${level}</b></td></tr>`).join('')}</tbody></table>
            <p class="setup-hint">Everything else stays on <b>None</b>. Read only — the office never writes.</p>
          </details>`}
        </section>

        <section class="setup-step"><h3><i>2</i>Paste it here</h3>${this.setup.writable === false ? `
          <p>This bridge is read-only, so the key has to go in by hand. Add this line to
             <code class="setup-path">${esc(this.setup.env_path)}</code> and restart it:</p>
          <div class="setup-copy"><code>${esc(envLine)}</code><button type="button" data-copy="${esc(envLine)}">Copy</button></div>
          <div class="setup-copy"><code>${esc(restart)}</code><button type="button" data-copy="${esc(restart)}">Copy</button></div>` : `
          <form class="setup-paste" autocomplete="off">
            <input type="password" name="key" spellcheck="false" autocomplete="off"
                   placeholder="${rc ? 'sk_…' : 'rk_live_…'}" aria-label="Paste your ${rc ? 'RevenueCat' : 'Stripe'} key" />
            <button type="submit">Save</button>
          </form>
          <p class="setup-hint">${current ? `A key ending ${esc(current)} is already in place — pasting replaces it. ` : ''}The key is
             checked against ${rc ? 'RevenueCat' : 'Stripe'} before it is kept, written to
             <code class="setup-path">${esc(this.setup.env_path)}</code> with owner-only permissions, and never sent back
             to this page. No restart needed.</p>`}
        </section>

        ${rc ? '<section class="setup-step setup-webhook"></section>' : ''}
        <section class="setup-step"><h3><i>${rc ? '4' : '3'}</i>Revenue connection</h3>
          <div class="setup-status">${this.setup.writable === false ? 'Waiting for the bridge to come back with a key…' : 'Waiting for a key…'}</div>
        </section>
      </div>
    </div>`;

    this.root.querySelector('.setup-x')!.addEventListener('click', () => this.close());
    const webhook = this.root.querySelector<HTMLElement>('.setup-webhook');
    if (webhook) this.stopWebhook = mountRevenueCatWebhook(webhook, this.setup.writable !== false);
    this.root.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => {
      b.addEventListener('click', () => { this.choice = b.dataset.pick as Provider; this.render(); });
    });
    this.root.querySelector<HTMLFormElement>('.setup-paste')?.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.save((e.target as HTMLFormElement).elements.namedItem('key') as HTMLInputElement);
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => {
      b.addEventListener('click', async () => {
        const text = b.dataset.copy!;
        const said = b.textContent;
        try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
        catch { b.textContent = 'Select it manually'; }   // clipboard needs a secure context
        setTimeout(() => { b.textContent = said; }, 1400);
      });
    });
    if (this.setup.error) {
      const status = this.root.querySelector('.setup-status')!;
      status.className = 'setup-status bad';
      status.textContent = this.setup.error;
    }
  }
}

function esc(s: string) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
