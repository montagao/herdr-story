import { RecapFX } from './recap-fx';
import { browserAccess } from './browser-access';
import { extractWaitNotice } from './agent-wait';
import { PaymentDetailsStore, stripePaymentDetails, enrichStripeCustomer, cleanDetail } from './payment-details';
import { interruptAgent } from './interrupt';
import { attachmentImage, publicPromptImage } from './attachment-images';
import { promptWithImages, type ConversationTurn } from '../shared/prompt-images';
import { HerdrClient } from './herdr-client';
import { agentLaunchName, validAgentName } from './agent-name';
import { revenueCatTotal } from './revenuecat';
import { RevenueCatWebhook } from './revenuecat-webhook';
import { registerRevenueCatWebhook, webhookSetupOriginAllowed } from './revenuecat-registration';
import { agentLaunchArgs, checkedAgentSettings } from '../shared/agent-settings';
import { agentSettingsOptions, codexSettingsCall } from './agent-settings';
import { isRevenueRange, revenueWindow, revenueCalendarWindow, type RevenueRange } from '../shared/revenue-range';
// herdr-story bridge: herdr unix socket (newline JSON) -> WebSocket broadcast.
// Polls agent.list, diffs it into office events, and proxies an allowlisted set of
// socket methods for the page. Run: bun bridge/server.ts [--mock]
import type { AgentInfo, AgentQueueItem, AgentStatus, ClientMsg, MoneyEvent, OfficeEvent, ServerMsg, WorkspaceSummary } from '../shared/types';
import { agentKind, titleOf } from '../shared/types';
import { extractCurrent, extractOutcome, type Current, type Outcome } from './outcome';
import { STRIPE_EVENT_TYPES, ZERO_DECIMAL, stripeMoney } from './stripe-events';
import { outcomeFor, promptAgrees, readTranscript, type Transcript } from './transcript';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { StudioStore } from './studio';
import { MessageReceipts } from './message-receipts';
import { Boss, BOSS_MODEL } from './boss';
import { deliverPrompt } from './prompt-delivery';
import { agentDelta, studioDelta } from './deltas';
import { AgentOutputHub } from './agent-output';
import { CodexQueueReader, localCodexQueue } from './codex-queue';
import { SweepService, type SweepSnapshot } from './sweep';
import { stat as fileStat } from 'node:fs/promises';

const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.HERDR_STORY_PORT ?? 7788);
const HOST = process.env.HERDR_STORY_HOST ?? '127.0.0.1';
const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
// The bridge stays on loopback, including when Tailscale Serve fronts it through Vite. Binding it
// directly to another interface is read-only unless its owner explicitly opts in.
const WRITABLE = process.env.HERDR_STORY_WRITE === '1'
  || (process.env.HERDR_STORY_WRITE === undefined && LOOPBACK);
const POLL_MS = Number(process.env.HERDR_STORY_POLL_MS ?? 1000);
const BRIDGE_STARTED_AT = Date.now();
const READ_METHODS = new Set(['ping', 'agent.list', 'agent.get', 'agent.read', 'agent.transcript', 'agent.explain', 'agent.settings.options', 'agent.queue.status', 'agent.boss.briefing', 'agent.boss.archive']);
const WRITE_METHODS = new Set(['agent.prompt', 'agent.queue', 'agent.queue.dismiss', 'agent.send_keys', 'agent.interrupt', 'agent.focus', 'pane.close', 'pane.zoom', 'agent.hire', 'agent.free', 'agent.boss', 'agent.settings.update', 'agent.settings.picker']);
const HIRE_KINDS = new Set(['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp',
  'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'maki']);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = new Map([['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif']]);
const UPLOAD_DIR = join(tmpdir(), 'herdr-story-images');
mkdirSync(UPLOAD_DIR, { recursive: true });

// --- money -------------------------------------------------------------------------------------
// The office HUD shows a dollar figure, the way the game shows funds. When STRIPE_SECRET_KEY is
// set it is real Stripe revenue; the key is read here and never leaves the bridge, so the page
// only ever sees a total. A restricted read-only key with 'Balance transactions: read' is enough.
// Without a key the endpoint says so and the page counts shipped work instead.
// A restricted key (rk_…) is the right thing here and the variable is named for it; the older
// names still work. Nothing in this file ever POSTs to Stripe — it reads two endpoints — so the
// key needs Read on Balance transactions and on Events, and no write permission at all.
let STRIPE_KEY = process.env.STRIPE_RESTRICTED_KEY ?? process.env.STRIPE_SECRET_KEY ?? process.env.STRIPE_API_KEY ?? '';
const REVENUE_DAYS = Math.max(1, Number(process.env.HERDR_STORY_REVENUE_DAYS ?? 30));
const STRIPE_ALL_TIME_START = process.env.HERDR_STORY_STRIPE_START_DATE;
const RC_ALL_TIME_START = process.env.HERDR_STORY_REVENUECAT_START_DATE;
const REVENUE_TTL = 60_000;         // Stripe is asked at most once a minute however many tabs poll
const revenueCache = new Map<string, Revenue>();
const revenuePending = new Map<string, Promise<Revenue>>();
/** Currencies Stripe quotes in whole units, where amounts are not hundredths. */
type Revenue = { source: 'stripe' | 'revenuecat' | 'both' | 'none'; amount?: number; currency?: string;
  label?: string; note?: string; days?: number; at: number; error?: string; parts?: { source: string; amount: number; currency: string; note?: string }[] };
let revenue: Revenue | null = null;

// --- RevenueCat -------------------------------------------------------------------------------
// A second revenue source, for apps that bill through the stores rather than through Stripe.
//
// Totals use the metrics API; individual notifications come from authenticated webhooks.
let RC_KEY = process.env.REVENUECAT_API_KEY ?? process.env.REVENUECAT_SECRET_KEY ?? '';
const RC_PROJECT = process.env.REVENUECAT_PROJECT_ID ?? '';
const RC_ROOT = 'https://api.revenuecat.com/v2';
let rcProjectId = RC_PROJECT;

async function rcGet(path: string) {
  const res = await fetch(`${RC_ROOT}${path}`, {
    headers: { authorization: `Bearer ${RC_KEY}`, accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(keyProblem(res.status, 'RevenueCat') ?? `RevenueCat replied ${res.status}`);
  return res.json() as Promise<any>;
}

/** The project to report on: the configured one, else the account's first. */
async function rcProject() {
  if (rcProjectId) return rcProjectId;
  const body = await rcGet('/projects');
  const first = body?.items?.[0]?.id ?? body?.data?.[0]?.id;
  if (!first) throw new Error('RevenueCat returned no projects — set REVENUECAT_PROJECT_ID');
  rcProjectId = String(first);
  return rcProjectId;
}

async function revenueCatRevenue(range: RevenueRange = '30d', now = new Date()): Promise<Revenue> {
  const project = await rcProject();
  return revenueCatTotal(rcGet, project, range, now, RC_ALL_TIME_START);
}

/** Stripe's own event feed, polled and turned into office events.
 *
 *  Polling rather than a webhook because the bridge is loopback-only by design — Stripe has
 *  nowhere to deliver to. The event list is newest-first and keyed by a stable event id, so the
 *  worst a repeated or overlapping poll can do is see something it has already reported.
 *
 *  The first poll after a restart is silent: it only records where the feed had got to. Otherwise
 *  every restart would replay the last hour of sales into the office as if they had just landed. */
const STRIPE_POLL_MS = Math.max(5_000, Number(process.env.HERDR_STORY_STRIPE_POLL_MS ?? 15_000));
const moneyEvents: MoneyEvent[] = [];
let seenStripeEvents = new Set<string>();
let stripeSeeded = false;


/** 401 and 403 are the key being wrong or too narrow, which is worth saying plainly: it is the one
 *  failure a person can actually fix, and it otherwise looks identical to having no key at all. */
function keyProblem(status: number, who = 'Stripe') {
  const fix = who === 'Stripe'
    ? 'it needs Read on Balance and Events'
    : 'it needs a v2 secret key with charts_metrics:overview:read';
  if (status === 401) return `${who} rejected the key (401) — it is wrong, expired, or for the other mode`;
  if (status === 403) return `${who} refused the key (403) — ${fix}`;
  return null;
}

/** Saving a key that was pasted into the office.
 *
 *  Two rules make this safe enough to offer. It is gated on the same WRITABLE flag as every other
 *  write, so a bridge someone else can reach cannot be handed a key; and a key is verified against
 *  the provider before it is stored, so a wrong one fails in the window with the provider's own
 *  message rather than being written to disk and quietly doing nothing.
 *
 *  The key goes to .env — the same file a person would edit — so nothing here invents a second
 *  place for secrets, and it survives a restart. It is written 0600 and is never read back out:
 *  the browser only ever learns the last four characters, enough to tell one key from another. */
const ENV_FILE = () => join(process.cwd(), '.env');

function envUpsert(name: string, value: string) {
  const file = ENV_FILE();
  const line = `${name}=${value}`;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* first key: the file is about to exist */ }
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  const next = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n*$/, '')}\n${line}\n`.replace(/^\n/, '');
  // Write beside the target and rename, so an interrupted save cannot truncate an existing file.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, next, { mode: 0o600 });
  renameSync(temp, file);
}

/** Last four characters, so the window can say which key is in place without revealing it. */
const keyHint = (k: string) => (k ? `…${k.slice(-4)}` : null);

const KEY_SHAPES: Record<string, { env: string; prefix: RegExp; hint: string }> = {
  stripe: { env: 'STRIPE_RESTRICTED_KEY', prefix: /^(rk|sk)_(live|test)_[A-Za-z0-9]/,
    hint: 'a Stripe key starts with rk_live_ (restricted) or sk_' },
  revenuecat: { env: 'REVENUECAT_API_KEY', prefix: /^sk_[A-Za-z0-9]/,
    hint: 'a RevenueCat v2 secret key starts with sk_' },
};

/** Spend one request proving the key works, and that it has the scopes we actually use. */
async function verifyKey(provider: string, key: string) {
  if (provider === 'stripe') {
    const res = await fetch('https://api.stripe.com/v1/balance_transactions?limit=1', {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(keyProblem(res.status) ?? `Stripe replied ${res.status}`);
    const events = await fetch('https://api.stripe.com/v1/events?limit=1', {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
    if (!events.ok) throw new Error('The key works, but it cannot read Events — add that permission and try again.');
    return;
  }
  const was = RC_KEY;
  RC_KEY = key;                     // rcGet reads the live key; put it back if it does not work out
  try {
    const id = RC_PROJECT || (await rcProject());
    await rcGet(`/projects/${encodeURIComponent(id)}/metrics/overview`);
  } finally { RC_KEY = was; }
}

/** Both books, added up.
 *
 *  A provider failure is reported as unavailable so a partial sum never looks like the total. Two currencies are never added together —
 *  there is no honest exchange rate to do it with — so the larger book wins and the label says
 *  which one it is. */
async function combinedRevenue(range?: RevenueRange): Promise<Revenue> {
  const now = new Date();
  const selected = range ?? '30d';
  const [stripe, rc] = await Promise.all([
    STRIPE_KEY ? stripeRevenue(range, RC_KEY || selected === 'all' ? revenueCalendarWindow(selected, now, STRIPE_ALL_TIME_START) : undefined).catch((e): Revenue => ({ source: 'none', error: (e as Error).message, at: Date.now() })) : null,
    RC_KEY ? revenueCatRevenue(selected, now).catch((e): Revenue => ({ source: 'none', error: (e as Error).message, at: Date.now() })) : null,
  ]);
  const good = [stripe, rc].filter((r): r is Revenue => !!r && r.source !== 'none' && typeof r.amount === 'number');
  const error = [stripe, rc].find((r) => r?.error)?.error;
  const part = (r: Revenue) => ({ source: r.source, amount: r.amount ?? 0, currency: r.currency ?? 'usd', note: r.note ?? (r.source === 'stripe' ? `${r.label} · net after Stripe fees` : r.label) });
  if (!good.length || error) return { source: 'none', error, at: Date.now() };
  // Even a single book reports its parts, so the bar's breakdown has a row to show either way.
  if (good.length === 1) return { ...good[0], error, parts: [part(good[0])] };

  const [a, b] = good;
  const name = (r: Revenue) => (r.source === 'stripe' ? 'Stripe' : 'RevenueCat');
  if (a.currency !== b.currency) {
    const bigger = (a.amount ?? 0) >= (b.amount ?? 0) ? a : b;
    return { ...bigger, error, label: bigger.label, note: `${name(bigger === a ? b : a)} excluded: currency is ${(bigger === a ? b : a).currency?.toUpperCase()}`, parts: [part(bigger)] };
  }
  return { source: 'both', amount: (a.amount ?? 0) + (b.amount ?? 0), currency: a.currency,
    label: `2 sources · ${revenueCalendarWindow(selected, now).label}`, at: Date.now(),
    parts: good.map(part) };
}

async function pollStripeEvents() {
  if (!STRIPE_KEY) return;
  const q = new URLSearchParams({ limit: '25' });
  for (const t of STRIPE_EVENT_TYPES) q.append('types[]', t);
  let rows: any[] = [];
  try {
    const res = await fetch(`https://api.stripe.com/v1/events?${q}`, {
      headers: { authorization: `Bearer ${STRIPE_KEY}` }, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(keyProblem(res.status) ?? `Stripe replied ${res.status}`);
    rows = ((await res.json()) as { data?: any[] }).data ?? [];
  } catch (e) {
    console.warn('[money] stripe events:', (e as Error).message);   // never carries the key
    return;
  }
  const fresh = rows.filter((r) => r && !seenStripeEvents.has(r.id)).reverse();   // oldest first
  for (const r of fresh) seenStripeEvents.add(r.id);
  // Remember only as many ids as a poll could show us again, so this cannot grow without limit.
  if (seenStripeEvents.size > 500) seenStripeEvents = new Set([...seenStripeEvents].slice(-250));
  let journaled = false;
  for (const r of fresh) {
    const money = stripeMoney(r);
    if (!money) continue;
    paymentDetails.put(stripePaymentDetails(r));
    moneyEvents.push(money);
    if (moneyEvents.length > 40) moneyEvents.shift();
    if (stripeSeeded) broadcast({ type: 'money', event: money });
    journaled = (await studio.run(() => studio.recordSale(money))) || journaled;
  }
  if (journaled) broadcast({ type: 'studio', studio: studio.snapshot(100) });
  stripeSeeded = true;
}

async function stripeRevenue(range?: RevenueRange, calendar?: ReturnType<typeof revenueCalendarWindow>): Promise<Revenue> {
  const window = calendar ?? (range ? revenueWindow(range) : { since: Math.floor(Date.now() / 1000) - REVENUE_DAYS * 86_400, end: Math.floor(Date.now() / 1000), label: `last ${REVENUE_DAYS} days` });
  const { since } = window;
  // Per currency, not one running total: an account taking both USD and EUR would otherwise have
  // its cents added together into a number that means nothing.
  const totals = new Map<string, number>();
  let after = '';
  while (true) {
    const q = new URLSearchParams({ limit: '100', 'created[lte]': String(window.end) });
    if (since !== undefined) q.set('created[gte]', String(since));
    if (after) q.set('starting_after', after);
    const res = await fetch(`https://api.stripe.com/v1/balance_transactions?${q}`, {
      headers: { authorization: `Bearer ${STRIPE_KEY}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(keyProblem(res.status) ?? `Stripe replied ${res.status}`);
    const body = await res.json() as { data?: { id: string; net: number; currency: string; type: string }[]; has_more?: boolean };
    const rows = body.data ?? [];
    for (const t of rows) {
      // net is already after fees, and refunds arrive as negatives. A payout is this money moving
      // to a bank account, not new money, so counting it would cancel the revenue that earned it —
      // and the same goes for a payout being cancelled or failing, which pays it back in.
      if (t.type?.startsWith('payout') || t.type?.startsWith('transfer')) continue;
      const c = t.currency || 'usd';
      totals.set(c, (totals.get(c) ?? 0) + t.net);
    }
    if (!body.has_more) break;
    if (!rows.length || rows[rows.length - 1].id === after) throw new Error('Stripe pagination did not advance.');
    after = rows[rows.length - 1].id;
  }
  // The account's main currency is the one that moved the most money; anything else is a sideline
  // and is left out rather than silently folded in at a made-up exchange rate.
  const [currency, minor] = [...totals].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0] ?? ['usd', 0];
  const scale = ZERO_DECIMAL.has(currency) ? 1 : 100;
  return { source: 'stripe', amount: minor / scale, currency, days: since === undefined ? undefined : (window.end - since) / 86400,
    label: `Stripe · ${window.label}`,
    note: `Net after Stripe fees · ${since === undefined ? 'first available transaction' : new Date(since * 1000).toISOString().slice(0, 10)} to ${new Date(window.end * 1000).toISOString().slice(0, 10)} (UTC; today is partial)`, at: Date.now() };
}

// herdr identifies the active agent session but does not currently include its model in
// agent.list. Both Codex and Claude record the exact model in their local JSONL session, so index
// those filenames once and read only the tail on a slow cadence. This avoids 30 extra terminal
// reads on every one-second office poll, and still follows an in-session model switch.
const MODEL_ROOTS = [join(homedir(), '.codex', 'sessions'), join(homedir(), '.claude', 'projects')];
const MODEL_INDEX_MS = 60_000;
const MODEL_CHECK_MS = 15_000;
const MODEL_TAIL_BYTES = 512 * 1024;
const sessionFiles = new Map<string, string>();
const modelCache = new Map<string, { checked: number; size: number; model: string | null }>();
let modelIndexAt = 0;
let modelIndexing: Promise<void> | null = null;
const WORKSPACE_CHECK_MS = 5_000;
const workspaceLabels = new Map<string, string>();
let workspaceCheckedAt = 0;
let workspaceListChanged = false;

function workspaceSummaries(): WorkspaceSummary[] {
  return [...workspaceLabels].map(([workspace_id, label]) => ({ workspace_id, label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.workspace_id.localeCompare(b.workspace_id));
}

async function refreshSessionFiles() {
  if (Date.now() - modelIndexAt < MODEL_INDEX_MS) return;
  if (modelIndexing) return modelIndexing;
  modelIndexing = (async () => {
    const next = new Map<string, string>();
    for (const root of MODEL_ROOTS) {
      if (!existsSync(root)) continue;
      const glob = new Bun.Glob('**/*.jsonl');
      for await (const rel of glob.scan({ cwd: root })) {
        const match = basename(rel).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
        if (match) next.set(match[1], join(root, rel));
      }
    }
    sessionFiles.clear();
    for (const [id, path] of next) sessionFiles.set(id, path);
    modelIndexAt = Date.now();
  })().finally(() => { modelIndexing = null; });
  return modelIndexing;
}

function recordedModel(line: string): string | null {
  try {
    const row = JSON.parse(line);
    const value = row?.type === 'assistant' ? row.message?.model
      : row?.type === 'turn_context' ? row.payload?.model
      : row?.model;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch { return null; }
}

/** Search newest-to-oldest without loading a multi-megabyte transcript into memory. Once a model
 *  is cached, callers cap this at one chunk: a model switch writes a fresh turn_context near EOF,
 *  while ordinary tool output should retain the known value. */
async function latestRecordedModel(file: ReturnType<typeof Bun.file>, size: number, maxBytes = Infinity) {
  let end = size;
  const floor = Math.max(0, size - maxBytes);
  let suffix = '';
  while (end > floor) {
    const start = Math.max(floor, end - MODEL_TAIL_BYTES);
    const lines = (await file.slice(start, end).text() + suffix).split('\n');
    suffix = start > floor ? lines.shift() ?? '' : '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const model = recordedModel(lines[i]);
      if (model) return model;
    }
    end = start;
  }
  return null;
}

async function sessionModel(a: AgentInfo): Promise<string | null> {
  if (typeof a.model === 'string' && a.model.trim()) return a.model.trim();
  const id = a.agent_session?.kind === 'id' ? a.agent_session.value : null;
  if (!id) return null;
  const path = sessionFiles.get(id);
  if (!path) return null;
  const file = Bun.file(path);
  const size = file.size;
  const cached = modelCache.get(id);
  if (cached && Date.now() - cached.checked < MODEL_CHECK_MS) return cached.model;
  if (cached && cached.size === size) {
    cached.checked = Date.now();
    return cached.model;
  }
  let model: string | null = cached?.model ?? null;
  try {
    // The first lookup walks backward as far as necessary. Later checks inspect only new/recent
    // records and retain the cached model if a long tool call has pushed turn_context out of view.
    model = await latestRecordedModel(file, size, cached ? MODEL_TAIL_BYTES : Infinity) ?? model;
  } catch { /* a session may disappear while its pane is closing */ }
  modelCache.set(id, { checked: Date.now(), size, model });
  return model;
}

/** The agent's own transcript, when herdr told us its session id and the file is on this machine. */
async function transcriptOf(a: AgentInfo | undefined): Promise<Transcript | undefined> {
  const id = a?.agent_session?.kind === 'id' ? a.agent_session.value : null;
  const path = id ? sessionFiles.get(id) : undefined;
  if (!path) return undefined;
  try { return await readTranscript(path); } catch { return undefined; }
}

/** The conversation as the agent's own session file records it: prompts and replies as written,
 *  never broken to a pane's width. `available` is false when herdr gave no session id or the file
 *  is not on this machine, and the browser falls back to the screen. */
async function transcriptTurns(target: string): Promise<{ available: boolean; turns: ConversationTurn[] }> {
  const agent = agents.get(target);
  if (!agent) throw new Error('Agent is no longer active');
  if (MOCK) return { available: true, turns: mockTurns(agent).map(turn => {
    const parsed = promptWithImages(turn.prompt);
    return { ...turn, prompt: parsed.text, ...(parsed.images.length ? { images: parsed.images.map(publicPromptImage) } : {}) };
  }) };
  const transcript = await transcriptOf(agent);
  return transcript ? { available: true, turns: transcript.turns.map(turn => ({ ...turn,
    ...(turn.images ? { images: turn.images.map(publicPromptImage) } : {}) })) } : { available: false, turns: [] };
}
function mockTurns(agent: AgentInfo) {
  const now = Date.now();
  const working = agent.agent_status === 'working' || agent.agent_status === 'blocked';
  return [
    { prompt: 'Tighten the release checklist and run the suite.', at: now - 3_600_000,
      reply: 'Done. The checklist now has **three** gates:\n\n1. `bun test` green\n2. Changelog entry\n3. Reviewer sign-off\n\nAll 42 tests pass.' },
    { prompt: agent.last_prompt?.trim() || 'What is left before we can ship?', at: now - 120_000,
      ...(working ? {} : { reply: 'Nothing blocking. I updated `CHANGELOG.md` and the build is clean.\n\n| Check | Result |\n| --- | --- |\n| Build | pass |\n| Tests | 42 / 42 |' }) },
  ];
}

async function withModels(list: AgentInfo[]) {
  await refreshSessionFiles();
  // Enriched models are display cache, not a provider report. Passing one back into sessionModel
  // would prevent transcript checks from noticing a model switch made in the agent's terminal.
  return Promise.all(list.map(async (a) => ({ ...a, model: await sessionModel({ ...a, model: reportedModels.get(a.pane_id)?.model ?? null }) })));
}

/** What each pane is on, read off its visible screen — the one read herdr allows while a pane is
 *  working. Cached per pane and refreshed when its state changes, every 5s while it works and
 *  every two minutes otherwise, a few panes per poll so thirty agents never mean thirty reads. */
const current = new Map<string, { session: string; seq: number; status: string; at: number; wait_notice?: AgentInfo['wait_notice'] } & Current>();
async function withCurrent(list: AgentInfo[]) {
  const now = Date.now();
  let budget = 6;
  return Promise.all(list.map(async (a) => {
    const session = JSON.stringify([a.agent, a.agent_session?.kind, a.agent_session?.value, a.cwd]);
    if (current.get(a.pane_id)?.session !== session) current.delete(a.pane_id);
    const known = current.get(a.pane_id), seq = a.state_change_seq ?? 0;
    const stale = !known || known.seq !== seq || known.status !== a.agent_status || now - known.at > (a.agent_status === 'working' || known?.wait_notice ? 5_000 : 120_000);
    if (stale && budget > 0) {
      budget--;
      const transcript = await transcriptOf(a);
      try {
        const r = (await agentOutput.read({ target: a.pane_id, source: 'visible' }, { priority: 'background' })) as { read: { text: string } };
        const found = extractCurrent(r.read.text);
        // A stale session id would make the transcript describe an old conversation; the screen wins a disagreement.
        const prompt = promptAgrees(transcript, found.prompt) ? transcript!.prompt : found.prompt ?? transcript?.prompt ?? known?.prompt;
        current.set(a.pane_id, { session, seq, status: a.agent_status, at: now, prompt, activity: found.activity ?? known?.activity, wait_notice: a.agent === 'claude' ? extractWaitNotice(r.read.text) : null });
      } catch { current.set(a.pane_id, { session, seq, status: a.agent_status, at: now, prompt: transcript?.prompt ?? known?.prompt, activity: known?.activity, wait_notice: known?.wait_notice }); }
    }
    const c = current.get(a.pane_id);
    return c ? { ...a, last_prompt: c.prompt ?? null, activity: c.activity ?? null, wait_notice: c.status === a.agent_status && c.seq === seq ? c.wait_notice ?? null : null } : a;
  }));
}

/** agent.list identifies the workspace but omits its human label. Every few seconds use Herdr's
 * atomic session snapshot (agents + workspaces in one socket response), then keep cheap agent-only
 * polls between snapshots. This also avoids racing Herdr's one-response socket reconnect. */
async function listedAgents() {
  if (Date.now() - workspaceCheckedAt >= WORKSPACE_CHECK_MS || !workspaceLabels.size) {
    const result = await backend.call('session.snapshot', {}) as { snapshot: {
      agents: AgentInfo[];
      workspaces: Array<{ workspace_id: string; label: string }>;
    } };
    const nextLabels = new Map(result.snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
    const before = JSON.stringify(workspaceSummaries());
    workspaceLabels.clear();
    for (const [workspaceId, label] of nextLabels) workspaceLabels.set(workspaceId, label);
    workspaceListChanged ||= before !== JSON.stringify(workspaceSummaries());
    workspaceCheckedAt = Date.now();
    return result.snapshot.agents;
  }
  const result = await backend.call('agent.list', {}) as { agents: AgentInfo[] };
  return result.agents;
}

interface Backend { call(method: string, params: Record<string, unknown>): Promise<unknown>; }

// ---------- real herdr client ----------
function resolveSocket(): string {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  try {
    const out = Bun.spawnSync(['herdr', 'status']).stdout.toString();
    const m = out.match(/socket:\s*(\S+)/);
    if (m && existsSync(m[1])) return m[1];
  } catch {}
  const cfg = join(homedir(), '.config', 'herdr');
  if (process.env.HERDR_SESSION) return join(cfg, 'sessions', process.env.HERDR_SESSION, 'herdr.sock');
  return join(cfg, 'herdr.sock');
}

// ---------- mock backend ----------
class MockHerdr implements Backend {
  agents: AgentInfo[] = [];
  bossTranscripts = new Map<string, Transcript>();
  private terminal = new Map<string, string[]>();
  private workspaces = new Map<string, { workspace_id: string; label: string; cwd: string }>();
  private panes = new Map<string, { pane_id: string; workspace_id: string; cwd: string }>();
  private nextWorkspace = 20;
  private nextPane = 20;
  private titles = ['Refactor auth middleware', 'Fix flaky CI on main', 'Write release notes', 'Migrate DB to sqlite', 'Pixel art agent viewer', 'Investigate memory leak', 'Add dark mode', 'Review PR #482', 'Bump deps', 'Port CLI to bun', 'Design onboarding flow', 'Speed up cold start'];
  constructor() {
    const kinds = ['claude', 'codex', 'claude', 'claude', 'cursor', 'codex', 'claude', 'opencode', 'claude', 'codex', 'claude', 'gemini'];
    kinds.forEach((k, i) => {
      const workspaceId = `w${i + 1}`, paneId = `${workspaceId}:p1`, cwd = `/home/me/projects/proj${i}`;
      this.workspaces.set(workspaceId, { workspace_id: workspaceId, label: `proj${i} studio`, cwd });
      this.panes.set(paneId, { pane_id: paneId, workspace_id: workspaceId, cwd });
      this.agents.push({ pane_id: paneId, workspace_id: workspaceId, agent: k,
        agent_session: k === 'codex' ? { agent: 'codex', kind: 'id', source: 'herdr:codex', value: `mock-codex-${i}` } : null,
        model: k === 'claude' ? 'claude-fable-5' : k === 'codex' ? 'gpt-5.6-sol' : k === 'gemini' ? 'gemini-3-pro' : 'not reported',
        agent_status: i % 3 === 0 ? 'working' : 'idle', terminal_title_stripped: this.titles[i], cwd, state_change_seq: 0 });
    });
    if (process.env.HERDR_STORY_MOCK_STATIC !== '1') setInterval(() => this.tick(), 1800);
  }
  private tick() {
    const a = this.agents[Math.floor(Math.random() * this.agents.length)];
    const r = Math.random();
    const next: AgentStatus = r < 0.45 ? 'working' : r < 0.65 ? 'idle' : r < 0.8 ? 'blocked' : r < 0.9 ? 'done' : a.agent_status;
    if (next !== a.agent_status) { a.agent_status = next; a.state_change_seq = (a.state_change_seq ?? 0) + 1; }
    if (Math.random() < 0.15) a.terminal_title_stripped = this.titles[Math.floor(Math.random() * this.titles.length)];
    if (Math.random() < 0.04 && this.agents.length < 16) {
      const workspaceId = `w${++this.nextWorkspace}`, paneId = `${workspaceId}:p1`, cwd = `/home/me/projects/new${this.nextWorkspace}`;
      this.workspaces.set(workspaceId, { workspace_id: workspaceId, label: `new${this.nextWorkspace} studio`, cwd });
      this.panes.set(paneId, { pane_id: paneId, workspace_id: workspaceId, cwd });
      this.agents.push({ pane_id: paneId, workspace_id: workspaceId, agent: 'claude', agent_status: 'working', cwd, terminal_title_stripped: 'New hire onboarding', state_change_seq: 0 });
    }
    else if (Math.random() < 0.03 && this.agents.length > 6) this.agents.splice(Math.floor(Math.random() * this.agents.length), 1);
  }
  async call(method: string, params: Record<string, unknown>) {
    if (method === 'ping') return { type: 'pong' };
    if (method === 'agent.list') return { type: 'agent_list', agents: structuredClone(this.agents) };
    if (method === 'session.snapshot') return { type: 'session_snapshot', snapshot: {
      agents: structuredClone(this.agents),
      workspaces: structuredClone([...this.workspaces.values()]),
      panes: structuredClone([...this.panes.values()]),
    } };
    if (method === 'workspace.create') {
      // Match Herdr's wire schema so browser smoke tests catch malformed create requests.
      if (params.env !== undefined && (!params.env || Array.isArray(params.env) || typeof params.env !== 'object')) {
        throw Object.assign(new Error('workspace.create env must be an object'), { code: 'invalid_request', notSent: true });
      }
      const workspaceId = `w${++this.nextWorkspace}`, paneId = `${workspaceId}:p1`;
      const cwd = String(params.cwd), label = String(params.label || basename(cwd));
      const workspace = { workspace_id: workspaceId, label, cwd };
      const root_pane = { pane_id: paneId, workspace_id: workspaceId, cwd };
      this.workspaces.set(workspaceId, workspace); this.panes.set(paneId, root_pane);
      return { type: 'workspace_created', workspace, tab: { tab_id: `${workspaceId}:t1` }, root_pane };
    }
    if (method === 'pane.split') {
      const workspaceId = String(params.workspace_id), workspace = this.workspaces.get(workspaceId);
      if (!workspace) throw new Error('workspace is no longer active');
      const paneId = `${workspaceId}:p${++this.nextPane}`;
      const pane = { pane_id: paneId, workspace_id: workspaceId, cwd: workspace.cwd };
      this.panes.set(paneId, pane);
      return { type: 'pane_info', pane };
    }
    if (method === 'agent.start') {
      const paneId = String(params.pane_id), pane = this.panes.get(paneId);
      if (!pane) throw new Error('pane is no longer active');
      const kind = String(params.kind), name = String(params.name);
      if (!validAgentName(name)) throw new Error("agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)");
      if (this.agents.some(a => a.name === name)) throw new Error('agent name is already in use');
      const args = params.args as string[] ?? [];
      const selectedModel = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
      const agent: AgentInfo = { pane_id: paneId, workspace_id: pane.workspace_id, agent: kind, display_agent: kind,
        name, agent_session: { agent: kind, kind: 'id', source: `herdr:${kind}`, value: `mock-${kind}-${crypto.randomUUID()}` },
        model: selectedModel || (kind === 'claude' ? 'claude-fable-5' : kind === 'codex' ? 'gpt-5.6-sol' : null),
        agent_status: 'idle', terminal_title_stripped: 'Ready for work', cwd: pane.cwd, state_change_seq: 0 };
      this.agents.push(agent);
      return { type: 'agent_started', agent: structuredClone(agent), argv: [kind, ...args] };
    }
    if (method === 'agent.get') {
      const agent = this.agents.find(a => a.pane_id === params.target);
      if (!agent) throw new Error('Agent is no longer active');
      return { type: 'agent_info', agent: structuredClone(agent) };
    }
    if (method === 'agent.settings.update') {
      const agent = this.agents.find(a => a.pane_id === params.target);
      if (!agent) throw new Error('Agent is no longer active');
      if (params.model) agent.model = String(params.model);
      return { message: `Mock settings applied${params.effort ? ` · ${params.effort} effort` : ''}` };
    }
    if (method === 'agent.read') {
      const delay = Math.min(10_000, Math.max(0, Number(process.env.HERDR_STORY_MOCK_HISTORY_DELAY_MS) || 0));
      if (params.source !== 'visible' && delay) await new Promise(resolve => setTimeout(resolve, delay));
      const a = this.agents.find((x) => x.pane_id === params.target);
      const lines = a?.agent_status === 'blocked' ? ['⏺ Edit src/auth/session.ts', 'Do you want to make this edit?', '❯ 1. Yes  2. Yes, and don\'t ask again  3. No'] : ['⏺ Ran 42 tests, all passed', '⏺ Updated CHANGELOG.md', 'Done. Anything else?'];
      return { type: 'pane_read', read: { text: [...lines, ...(this.terminal.get(String(params.target)) ?? [])].join('\n'), truncated: false } };
    }
    if (method === 'agent.prompt') {
      const target = String(params.target), text = String(params.text);
      if (text.startsWith('You are Boss,')) this.bossTranscripts.set(target, { turns: [{ prompt: text, at: Date.now(), reply: JSON.stringify({
        intro: 'The studio is making progress. Here are a few ideas worth a look.',
        ideas: [
          { title: 'Give long chats a bookmark', evidence: 'The journal records improvements to chat scrolling.', why: 'It would be easier to return to a useful answer.', nextStep: 'Try one saved position per conversation.' },
          { title: 'Show the milestone in the room', evidence: 'The team has a new multiplayer milestone.', why: 'Everyone can see what the next release needs.', nextStep: 'Pin the next co-op test to its whiteboard.' },
          { title: 'Keep a tiny release reel', evidence: 'The journal now holds several completed tasks.', why: 'A quick look back makes the progress visible.', nextStep: 'Pick three completed changes for a short demo.' },
        ],
      }) }] });
      const log = this.terminal.get(target) ?? []; this.terminal.set(target, log);
      log.push(`› ${text}`, '⏺ Got it — working on that now.');
      const a = this.agents.find((x) => x.pane_id === target);
      if (a) { a.agent_status = 'working'; a.state_change_seq = (a.state_change_seq ?? 0) + 1; }
      setTimeout(() => { log.push('Done. Anything else?'); if (a) { a.agent_status = 'idle'; a.state_change_seq = (a.state_change_seq ?? 0) + 1; } }, 1200);
      return { type: 'agent_prompted', target };
    }
    if (method === 'agent.queue') {
      const target = String(params.target), text = String(params.text);
      const log = this.terminal.get(target) ?? []; this.terminal.set(target, log);
      log.push(`› [queued] ${text}`);
      return { type: 'agent_queued', target };
    }
    if (method === 'pane.zoom') return { type: 'pane_zoomed', pane_id: String(params.pane_id), zoomed: params.mode !== 'off', changed: true };
    if (method === 'agent.send_keys') { const target = String(params.target); const log = this.terminal.get(target) ?? []; this.terminal.set(target, log); log.push(`› [${(params.keys as string[])[0]}]`); if ((params.keys as string[])[0] === 'Escape') { const a = this.agents.find(a => a.pane_id === target); if (a) a.agent_status = 'idle'; } return { type: 'keys_sent', target }; }
    if (method === 'agent.focus') return { type: 'agent_focused', target: params.target };
    if (method === 'pane.close') {
      const paneId = String(params.pane_id);
      const index = this.agents.findIndex((agent) => agent.pane_id === paneId);
      if (index >= 0) this.agents.splice(index, 1);
      if (!this.panes.delete(paneId) && index < 0) throw new Error('pane is no longer active');
      this.terminal.delete(paneId);
      return { type: 'pane_closed', pane_id: paneId };
    }
    if (method === 'workspace.close') {
      const workspaceId = String(params.workspace_id);
      if (!this.workspaces.delete(workspaceId)) throw new Error('workspace is no longer active');
      for (const [paneId, pane] of this.panes) if (pane.workspace_id === workspaceId) this.panes.delete(paneId);
      this.agents = this.agents.filter((agent) => agent.workspace_id !== workspaceId);
      return { type: 'workspace_closed', workspace_id: workspaceId };
    }
    throw new Error(`mock: unsupported ${method}`);
  }
}

// ---------- state + diffing ----------
const backend: Backend = MOCK ? new MockHerdr() : new HerdrClient(resolveSocket());
let agents = new Map<string, AgentInfo>();
const reportedModels = new Map<string, { model: string | null }>();
const agentOutput = new AgentOutputHub((method, params) => backend.call(method, params), target => agents.get(target));
const socketReads = new Map<unknown, Map<string, AbortController>>();
const since = new Map<string, number>(); // pane -> when its current status began
const events: OfficeEvent[] = [];
let evSeq = 0;
const clients = new Set<any>();
const deltaClients = new Set<any>();
const studioActions = new Set<string>();
const initialSnapshots = new Map<unknown, ReturnType<typeof setTimeout>>();
const recapFX = new RecapFX(fetch, Date.now, !MOCK || process.env.HERDR_STORY_STATE_DIR
  ? join(process.env.HERDR_STORY_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-story'), 'recap-rates.json') : undefined);
if (!MOCK) recapFX.warm();
const studio = new StudioStore(!MOCK || process.env.HERDR_STORY_STATE_DIR
  ? process.env.HERDR_STORY_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-story') : undefined, { asyncWrite: true });
const receipts = new MessageReceipts(!MOCK || process.env.HERDR_STORY_STATE_DIR
  ? process.env.HERDR_STORY_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-story') : undefined);
const paymentDetails = new PaymentDetailsStore(!MOCK || process.env.HERDR_STORY_STATE_DIR ? process.env.HERDR_STORY_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-story') : undefined);
const rcWebhook = new RevenueCatWebhook({
  recordDetail: detail => paymentDetails.put(detail),
  directory: !MOCK || process.env.HERDR_STORY_STATE_DIR
    ? process.env.HERDR_STORY_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-story') : undefined,
  authorization: process.env.REVENUECAT_WEBHOOK_AUTH,
  signingSecret: process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET,
  stripeConnected: () => Boolean(STRIPE_KEY),
  record: async event => { await studio.run(() => studio.recordSale(event)); },
  publish: (event, live) => {
    if (!moneyEvents.some(e => e.id === event.id)) moneyEvents.push(event);
    moneyEvents.sort((a, b) => a.ts - b.ts);
    if (moneyEvents.length > 40) moneyEvents.splice(0, moneyEvents.length - 40);
    revenueCache.clear(); revenuePending.clear();
    if (live) broadcast({ type: 'money', event });
    broadcast({ type: 'studio', studio: studio.snapshot(100) });
  },
});
moneyEvents.push(...rcWebhook.recent());
let rcWebhookListening = false;
let rcWebhookIntegrationId = process.env.REVENUECAT_WEBHOOK_INTEGRATION_ID || null;
let rcWebhookRegistration: Promise<void> | undefined;
const rcWebhookStatus = () => ({ ...rcWebhook.status(), listening: rcWebhookListening,
  url: process.env.REVENUECAT_WEBHOOK_PUBLIC_URL || null,
  integrationId: rcWebhookIntegrationId });
// A client-generated message id stays bound to its pane even if session metadata arrives late.
const messageKey = (target: unknown) => String(target);
const activeAgentWrites = new Map<string, number>();
const sweep = new SweepService({
  snapshot: async () => {
    const result = await backend.call('session.snapshot', {}) as { snapshot: SweepSnapshot };
    return { ...result.snapshot, agents: result.snapshot.agents.map(raw => {
      const cached = agents.get(raw.pane_id);
      return studio.decorate({ ...(cached && sessionKey(cached) === sessionKey(raw) ? cached : {}), ...raw });
    }) };
  },
  lastActivity: async a => {
    await refreshSessionFiles();
    const path = a.agent_session?.value && sessionFiles.get(a.agent_session.value);
    return path ? (await fileStat(path)).mtimeMs : undefined;
  },
  transcript: transcriptOf,
  read: async a => {
    const result = await agentOutput.read({ target: a.pane_id, source: 'recent_unwrapped', lines: 900 }, { priority: 'background' }) as { read: { text: string } };
    return result.read.text;
  },
  save: async (id, a, recap) => {
    const entry = await studio.run(() => studio.archiveSweep(id, a, recap.notes, recap.artifacts.find(link => /^https?:\/\//.test(link)) || ''));
    broadcast({ type: 'studio', studio: studio.snapshot(100) });
    return entry;
  },
  call: (method, params) => backend.call(method, params),
  queued: async (a, fresh) => {
    if (activeAgentWrites.get(a.pane_id) || queueItems().some(item => item.target === a.pane_id && item.state !== 'sent')) return true;
    if (MOCK || agentKind(a) !== 'codex') return false;
    const thread = a.agent_session?.kind === 'id' && a.agent_session.value;
    if (!thread) throw new Error('Codex session is not available.');
    if (fresh) codexQueueReader.invalidate(thread);
    return (await codexQueueReader.read(thread)).length > 0;
  },
}, !MOCK || process.env.HERDR_STORY_STATE_DIR ? process.env.HERDR_STORY_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-story') : undefined);

let publishedAgents: AgentInfo[] = [], publishedWorkspaces: WorkspaceSummary[] = [];
let publishedStudio = studio.snapshot(100);
function broadcast(msg: ServerMsg) {
  let wire: ServerMsg | undefined = msg;
  if (msg.type === 'agents') {
    const workspaces = msg.workspaces ?? publishedWorkspaces;
    wire = agentDelta(publishedAgents, msg.agents, publishedWorkspaces, workspaces);
    publishedAgents = msg.agents.map(a => ({ ...a })); publishedWorkspaces = workspaces;
  } else if (msg.type === 'studio') {
    const next = studio.snapshot(100);
    wire = studioDelta(publishedStudio, next); publishedStudio = next;
  }
  if (!wire) return;
  const text = JSON.stringify(wire);
  let legacyText: string | undefined;
  for (const client of clients) {
    if (initialSnapshots.has(client)) continue;
    try {
      if (deltaClients.has(client)) client.send(text);
      else {
        // Already-open tabs keep the full protocol until they load a client that opts into deltas.
        legacyText ??= JSON.stringify(msg.type === 'studio' ? { type: 'studio', studio: studio.snapshot() } : msg);
        client.send(legacyText);
      }
    } catch { clients.delete(client); deltaClients.delete(client); }
  }
}
function pushEvent(e: Omit<OfficeEvent, 'id' | 'ts'>) {
  const ev: OfficeEvent = { id: `${BRIDGE_STARTED_AT}-${++evSeq}`, ts: Date.now(), ...e };
  events.push(ev); if (events.length > 200) events.shift();
  broadcast({ type: 'event', event: ev });
}

/** Narrow the browser's write capability to the controls the UI actually exposes. */
type HireParams = { mode: 'new' | 'existing'; kind: string; name: string; task: string;
  model: string; effort: string; cwd?: string; label?: string; workspace_id?: string; launchArgs?: string[] };

function checkedWriteParams(method: string, params: Record<string, unknown>): Record<string, any> {
  if (method === 'agent.free') return checkedWriteParams('agent.hire', {
    mode: 'new', kind: 'codex', name: 'Free agent', task: '',
    cwd: process.env.HERDR_STORY_PROJECTS_DIR || join(homedir(), 'projects'), label: 'Free agent',
  });
  if (method === 'agent.hire') {
    const mode = params.mode === 'new' ? 'new' : params.mode === 'existing' ? 'existing' : '';
    if (!mode) throw new Error('choose a new or existing workspace');
    const kind = typeof params.kind === 'string' ? params.kind.trim().toLowerCase() : '';
    if (!HIRE_KINDS.has(kind)) throw new Error('unsupported agent type');
    const settings = checkedAgentSettings(kind, params);
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(name)) throw new Error('name must be 1–40 letters, numbers, spaces, dots, dashes, or underscores');
    const task = typeof params.task === 'string' ? params.task.trim() : '';
    if (task.length > 20_000) throw new Error('first task is too long (20,000 character limit)');
    if (mode === 'existing') {
      const workspace_id = typeof params.workspace_id === 'string' ? params.workspace_id : '';
      if (!workspaceLabels.has(workspace_id)) throw new Error('workspace is no longer active');
      return { mode, kind, name, task, workspace_id, ...settings } satisfies HireParams;
    }
    const rawCwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
    if (!rawCwd || rawCwd.length > 4096 || !isAbsolute(rawCwd)) throw new Error('working directory must be an absolute path');
    const cwd = normalize(rawCwd);
    if (!MOCK && (!existsSync(cwd) || !statSync(cwd).isDirectory())) throw new Error('working directory does not exist or is not a directory');
    const suppliedLabel = typeof params.label === 'string' ? params.label.trim() : '';
    if (suppliedLabel.length > 80) throw new Error('workspace name is too long (80 character limit)');
    const label = suppliedLabel || basename(cwd);
    return { mode, kind, name, task, cwd, label, ...settings } satisfies HireParams;
  }
  const target = typeof params.target === 'string' ? params.target : '';
  if (!target || !agents.has(target)) throw new Error('agent is no longer active');
  if (method === 'agent.queue.dismiss') {
    const id = typeof params.queue_id === 'string' ? params.queue_id : '';
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new Error('Invalid queue ID.');
    return { target, queue_id: id };
  }
  if (method === 'agent.settings.update' || method === 'agent.settings.picker') {
    if (method === 'agent.settings.picker') {
      if (agentKind(agents.get(target)!) !== 'codex') throw new Error('Terminal picker is only available for Codex');
      return { target };
    }
    const settings = checkedAgentSettings(agentKind(agents.get(target)!), params);
    if (!settings.model && !settings.effort) throw new Error('Choose a model or effort level');
    return { target, ...settings };
  }
  if (method === 'agent.prompt' || method === 'agent.queue') {
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) throw new Error(method === 'agent.queue' ? 'queued prompt cannot be empty' : 'prompt cannot be empty');
    if (text.length > 20_000) throw new Error('prompt is too long (20,000 character limit)');
    if (method === 'agent.queue') {
      const a = agents.get(target)!;
      const kind = agentKind(a);
      if (kind !== 'codex' && kind !== 'claude') throw new Error('only Codex and Claude agents support queued prompts');
      if (kind === 'codex' && (a.agent_session?.kind !== 'id' || !a.agent_session.value)) throw new Error('Codex session is not available yet');
      const suppliedId = typeof params.queue_id === 'string' ? params.queue_id : '';
      const queueId = /^[A-Za-z0-9_-]{8,100}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
      const suppliedAt = typeof params.queued_at === 'number' ? params.queued_at : Date.now();
      const queuedAt = Number.isFinite(suppliedAt) && suppliedAt > 0 ? suppliedAt : Date.now();
      return { target, text, queue_id: queueId, queued_at: queuedAt };
    }
    return { target, text };
  }
  if (method === 'agent.send_keys') {
    if (!Array.isArray(params.keys) || params.keys.length !== 1 || params.keys[0] !== 'Enter') throw new Error('only the Enter key is allowed');
    return { target, keys: ['Enter'] };
  }
  if (method === 'pane.zoom') {
    // Zooming gives a cramped agent pane the whole tab, so its app reflows to full width.
    const mode = params.mode === 'on' || params.mode === 'off' ? params.mode : 'toggle';
    return { pane_id: target, mode };
  }
  if (method === 'pane.close') {
    // Require the browser to repeat the exact live pane id after showing its confirmation step.
    // The sentinel is stripped before forwarding Herdr's canonical { pane_id } request.
    if (params.confirm !== target) throw new Error('pane close was not confirmed');
    return { pane_id: target };
  }
  return { target };
}

import { ClaudeQueueFile, claudeQueueIdentity, restoredClaudeQueue, type StoredClaudeQueue } from './claude-queue';
const claudeQueues = new Map<string, StoredClaudeQueue[]>();
const codexQueueReader = new CodexQueueReader((method, params) => {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const socket = process.env.HERDR_STORY_CODEX_SOCKET || join(home, 'app-server-control', 'app-server-control.sock');
  if (existsSync(socket)) return codexSettingsCall(method, params);
  return Promise.resolve(localCodexQueue(join(home, 'queue_1.sqlite'), String(params.threadId)));
});
const claudeDispatching = new Set<string>();
const deliveredClaudeQueueIds = new Map<string, number>();
const queueStateDir = process.env.HERDR_STORY_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-story');
const queueStateFile = join(queueStateDir, 'claude-queue.json');
const persistClaudeQueue = !MOCK || process.env.HERDR_STORY_STATE_DIR !== undefined;

const claudeQueueFile = new ClaudeQueueFile(persistClaudeQueue ? queueStateDir : undefined);
function queueItems() { return [...claudeQueues.values()].flat().map(({ attempts: _a, next_attempt_at: _n, session: _s, persisted: _p, ...item }) => item); }

/** Claude lacks a native queue, so keep pending prompts across bridge/dev-server restarts. The
 * file is owner-only because prompts can contain source code or other private project details. */
async function saveClaudeQueues() {
  const delivered = [...deliveredClaudeQueueIds].sort((a, b) => b[1] - a[1]).slice(0, 100);
  await claudeQueueFile.write({ version: 2, queues: [...claudeQueues], delivered });
}

function restoreClaudeQueues() {
  if (!persistClaudeQueue || !existsSync(queueStateFile)) return;
  try {
    const saved = JSON.parse(readFileSync(queueStateFile, 'utf8')) as {
      queues?: [string, StoredClaudeQueue[]][]; delivered?: [string, number][];
    };
    for (const [target, items] of saved.queues ?? []) {
      if (typeof target !== 'string' || !Array.isArray(items)) continue;
      const valid = items.filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string');
      if (valid.length) claudeQueues.set(target, valid.map(restoredClaudeQueue));
    }
    for (const [id, at] of saved.delivered ?? []) if (typeof id === 'string' && typeof at === 'number') deliveredClaudeQueueIds.set(id, at);
  } catch (e) { console.log('[bridge] ignored unreadable Claude queue state:', (e as Error).message); }
}
restoreClaudeQueues();

function queueUpdate(item: AgentQueueItem) { broadcast({ type: 'queue', item }); }

/** Claude has no equivalent of `codex queue`, and a normal mid-turn prompt can steer/interrupt
 * the current response. Hold follow-ups here and submit exactly one whenever Herdr reports the
 * pane idle; the next prompt is not released until that turn has visibly started and finished. */
async function pumpClaudeQueue(target: string) {
  const a = agents.get(target), queue = claudeQueues.get(target);
  if (!a || agentKind(a) !== 'claude' || !queue?.length || claudeDispatching.has(target)) return;
  if (a.agent_status === 'working') return;
  if (a.agent_status !== 'idle' && a.agent_status !== 'done') return;
  const item = queue[0];
  if (!item.persisted || item.state === 'failed' || item.next_attempt_at > Date.now()) return;

  claudeDispatching.add(target);
  try {
    if (item.session !== claudeQueueIdentity(a, BRIDGE_STARTED_AT)) {
      item.state = 'failed'; item.error = 'Agent session changed. Inspect this saved prompt before queueing it for another agent.';
      await saveClaudeQueues(); queueUpdate(item); return;
    }
    item.state = 'dispatching'; await saveClaudeQueues(); queueUpdate(item);
    // Herdr's wait mode requires an observed state change when dispatching from idle. A plain
    // agent.prompt can report that text was written even if a TUI redraw swallowed its Enter.
    agentOutput.invalidate(target);
    try {
      await receipts.run(`${target}:dispatch`, item.id, { text: item.text }, () => {
        const current = agents.get(target);
        if (!current || claudeQueueIdentity(current, BRIDGE_STARTED_AT) !== item.session) throw Object.assign(new Error('Agent session changed before dispatch.'), { notSent: true });
        return deliverPrompt(backend.call.bind(backend), 'claude', target, item.text);
      });
    } finally { agentOutput.invalidate(target); }
    queue.shift();
    if (!queue.length) claudeQueues.delete(target);
    deliveredClaudeQueueIds.set(item.id, Date.now());
    item.state = 'sent'; delete item.error;
    await saveClaudeQueues(); queueUpdate(item);
    // Keep another queued message behind the turn that Herdr just observed starting. The next
    // agent.list poll replaces this optimistic status with the authoritative one.
    a.agent_status = 'working';
    console.log(`[bridge] dispatched Claude queue item ${item.id} to ${target}`);
  } catch (e) {
    item.attempts++;
    item.state = 'failed'; item.error = `Delivery unconfirmed; inspect the agent output before retrying. ${(e as Error).message}`;
    item.next_attempt_at = 0;
    try { await saveClaudeQueues(); } catch (saveError) { console.log('[bridge] could not save stopped Claude queue:', (saveError as Error).message); }
    queueUpdate(item);
    console.log(`[bridge] Claude queue stopped for ${target}:`, item.error);
  } finally { claudeDispatching.delete(target); }
}

/** Codex uses its native session queue; Claude uses the ordered bridge queue above. */
async function queueAgent(target: string, text: string, id: string, queuedAt: number) {
  const a = agents.get(target);
  const kind = a ? agentKind(a) : '';
  if (kind === 'claude') {
    if (deliveredClaudeQueueIds.has(id)) return { type: 'agent_queued', target, provider: 'claude', id, state: 'sent' };
    const duplicate = [...claudeQueues.values()].flat().find((item) => item.id === id);
    if (duplicate) {
      if (duplicate.target !== target || duplicate.text !== text) throw new Error('Queue ID belongs to different prompt contents.');
      return { type: 'agent_queued', target, provider: 'claude', id, state: duplicate.state };
    }
    const queue = claudeQueues.get(target) ?? [];
    const item: StoredClaudeQueue = { id, target, text, queued_at: queuedAt, state: 'queued', attempts: 0, next_attempt_at: 0, session: claudeQueueIdentity(a!, BRIDGE_STARTED_AT), persisted: false };
    queue.push(item); claudeQueues.set(target, queue);
    try { await saveClaudeQueues(); item.persisted = true; }
    catch (error) {
      queue.splice(queue.indexOf(item), 1); if (!queue.length) claudeQueues.delete(target);
      throw Object.assign(new Error(`Prompt was not queued: ${(error as Error).message}`), { notSent: true });
    }
    queueUpdate(item);
    const position = queue.length;
    void pumpClaudeQueue(target);
    return { type: 'agent_queued', target, provider: 'claude', position, id, state: 'queued' };
  }

  const thread = a?.agent_session?.kind === 'id' ? a.agent_session.value : undefined;
  if (!a || kind !== 'codex' || !thread) throw new Error('Codex session is not available yet');
  if (MOCK) return backend.call('agent.queue', { target, text });

  const proc = Bun.spawn(['codex', 'queue', '--thread', thread, '--message', text], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `Codex queue exited with ${exitCode}`);
    return { type: 'agent_queued', target, thread };
  } finally { clearTimeout(timer); codexQueueReader.invalidate(thread); }
}

/** Dismissing a stopped item acknowledges inspection; it never resends that item. */
async function dismissClaudeQueue(target: string, id: string) {
  const queue = claudeQueues.get(target), item = queue?.find(candidate => candidate.id === id);
  if (!queue || !item) return { dismissed: false };
  if (item.state !== 'failed' || claudeDispatching.has(target)) throw new Error('Only a stopped queue item can be dismissed.');
  const index = queue.indexOf(item); queue.splice(index, 1);
  if (!queue.length) claudeQueues.delete(target);
  try { await saveClaudeQueues(); }
  catch (error) { queue.splice(index, 0, item); claudeQueues.set(target, queue); throw error; }
  void pumpClaudeQueue(target);
  return { dismissed: true };
}

/** A browser gets one deliberate operation, while the bridge performs Herdr's create/split/start
 * sequence. If start fails, remove the empty desk we just made so the session is not littered with
 * half-created panes. A prompt failure does not fire the new agent: the successful hire is useful. */
const pendingLaunchNames = new Set<string>();
async function hireAgent(params: HireParams, onProgress?: (stage: 'creating' | 'starting' | 'ready') => void) {
  onProgress?.('creating');
  let paneId = '', workspaceId = '', createdWorkspace = false;
  let startedAgent: AgentInfo | undefined;
  let launchName = '';
  try {
    const listed = await backend.call('agent.list', {}) as { agents: AgentInfo[] };
    launchName = agentLaunchName(params.name, [...listed.agents.flatMap(a => a.name ? [a.name] : []), ...pendingLaunchNames]);
    // Reserve synchronously after the list read so simultaneous hires cannot pick the same id.
    pendingLaunchNames.add(launchName);
    if (params.mode === 'new') {
      const created = await backend.call('workspace.create', { cwd: params.cwd!, label: params.label!, env: {}, focus: false }) as any;
      paneId = String(created?.root_pane?.pane_id ?? '');
      workspaceId = String(created?.workspace?.workspace_id ?? '');
      createdWorkspace = true;
      if (!paneId || !workspaceId) throw new Error('Herdr did not return the new workspace pane');
      workspaceLabels.set(workspaceId, params.label!);
    } else {
      workspaceId = params.workspace_id!;
      const split = await backend.call('pane.split', { workspace_id: workspaceId, direction: 'right', focus: false }) as any;
      paneId = String(split?.pane?.pane_id ?? '');
      if (!paneId) throw new Error('Herdr did not return the new pane');
    }
    onProgress?.('starting');
    const started = await backend.call('agent.start', { name: launchName, kind: params.kind, pane_id: paneId, args: [...agentLaunchArgs(params.kind, params), ...params.launchArgs ?? []], timeout_ms: 60_000 }) as { agent?: AgentInfo };
    startedAgent = started?.agent;
  } catch (error) {
    if (paneId || (createdWorkspace && workspaceId)) {
      try {
        if (createdWorkspace && workspaceId) await backend.call('workspace.close', { workspace_id: workspaceId });
        else if (paneId) await backend.call('pane.close', { pane_id: paneId });
      } catch (cleanup) { console.warn('[hire] could not remove incomplete desk:', (cleanup as Error).message); }
    }
    throw error;
  } finally { if (launchName) pendingLaunchNames.delete(launchName); }

  if (startedAgent) {
    try {
      await studio.run(() => studio.nameHiredAgent(startedAgent!, params.name));
      startedAgent = studio.decorate(startedAgent);
      broadcast({ type: 'studio', studio: studio.snapshot(100) });
    } catch (error) {
      // The agent is already running. A display-name save failure must not report a failed
      // launch, remove its workspace, or encourage a duplicate start.
      console.warn('[hire] could not save office display name:', (error as Error).message);
      startedAgent = { ...startedAgent, office_name: params.name };
    }
  }

  let promptError = '';
  if (params.task) {
    try { await deliverPrompt(backend.call.bind(backend), params.kind, paneId, params.task); }
    catch (error) { promptError = (error as Error).message; }
  }
  workspaceCheckedAt = 0;
  void poll();
  onProgress?.('ready');
  return { type: 'agent_hired', pane_id: paneId, workspace_id: workspaceId, kind: params.kind,
    name: params.name, agent: startedAgent, prompted: !!params.task && !promptError, prompt_error: promptError || undefined };
}

// One terminal activation at a time, including simultaneous requests from multiple browsers.
let freeAgentPending: ReturnType<typeof hireAgent> | undefined;
function hireFreeAgent(params: HireParams, onProgress?: (stage: 'creating' | 'starting' | 'ready') => void) {
  if (freeAgentPending) return freeAgentPending;
  freeAgentPending = (async () => {
    const listed = await backend.call('agent.list', {}) as { agents: AgentInfo[] };
    const names = new Set(listed.agents.flatMap(a => [a.name, studio.decorate(a).office_name]));
    let name = 'Free agent';
    for (let n = 2; names.has(name) || names.has(agentLaunchName(name)); n++) name = `Free agent ${n}`;
    return hireAgent({ ...params, name, label: name }, onProgress);
  })().finally(() => { freeAgentPending = undefined; });
  return freeAgentPending;
}

const bossDirectory = !MOCK || process.env.HERDR_STORY_STATE_DIR
  ? process.env.HERDR_STORY_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-story') : undefined;
const boss = new Boss(bossDirectory, {
  list: async () => ((await backend.call('agent.list', {}) as { agents: AgentInfo[] }).agents).map(a => studio.decorate(a)),
  transcript: async agent => {
    if (backend instanceof MockHerdr) return backend.bossTranscripts.get(agent.pane_id);
    await refreshSessionFiles(); return transcriptOf(agent);
  },
  studio: async () => {
    await studio.flush();
    return { ...studio.snapshot(1), journal: ['task', 'milestone', 'release', 'note'].flatMap(kind => studio.journalPage({ kind, limit: 24 }).entries) };
  },
  hire: progress => {
    const cwd = join(bossDirectory ?? tmpdir(), 'boss-office');
    if (!MOCK) mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return hireAgent({ mode: 'new', kind: 'claude', name: 'Boss', label: 'Boss', cwd, task: '',
      model: BOSS_MODEL, effort: 'low',
      launchArgs: ['--dangerously-skip-permissions', '--settings', '{"skipDangerousModePermissionPrompt":true}',
        '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands'],
    }, progress);
  },
  prompt: async (agent, text, id) => {
    const target = agent.pane_id;
    if (sweep.isClosing(target)) throw new Error('Boss is closing. Wait for it to finish.');
    sweep.touch(agent);
    activeAgentWrites.set(target, (activeAgentWrites.get(target) || 0) + 1);
    agentOutput.invalidate(target);
    try { return await receipts.run(`${target}:boss`, id, { text }, () => deliverPrompt(backend.call.bind(backend), 'claude', target, text)); }
    finally {
      const count = (activeAgentWrites.get(target) || 1) - 1;
      if (count) activeAgentWrites.set(target, count); else activeAgentWrites.delete(target);
      agentOutput.invalidate(target); void poll();
    }
  },
});

const settingsBusy = new Set<string>();
async function updateAgentSettings(params: { target: string; model: string; effort: string }) {
  if (settingsBusy.has(params.target)) throw new Error('A settings change is already in progress');
  settingsBusy.add(params.target);
  try {
    const listed = await backend.call('agent.list', {}) as { agents: AgentInfo[] };
    const agent = listed.agents.find(a => a.pane_id === params.target);
    if (!agent) throw new Error('Agent is no longer active');
    const kind = agentKind(agent), settings = checkedAgentSettings(kind, params);
    if (kind === 'claude' && settings.model && settings.effort) throw new Error('Apply the model first, then the effort level');
    if (kind === 'claude' && !['idle', 'done'].includes(agent.agent_status)) throw new Error('Wait until Claude is ready for input before changing settings');
    if (MOCK) {
      return backend.call('agent.settings.update', { target: params.target, ...settings });
    }
    if (kind === 'codex') {
      const threadId = agent.agent_session?.kind === 'id' ? agent.agent_session.value : undefined;
      if (!threadId) throw new Error('Codex session is not available yet');
      await codexSettingsCall('thread/settings/update', { threadId, ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}) });
      return { message: 'Settings accepted for subsequent turns. The runtime model updates after the next turn starts.' };
    }
    await backend.call('agent.prompt', { target: params.target, text: settings.model ? `/model ${settings.model}` : `/effort ${settings.effort}` });
    return { message: 'Command sent. Check the terminal below for confirmation or a model-switch prompt. Claude may save this choice as its default.' };
  } finally { settingsBusy.delete(params.target); }
}

const interrupting = new Set<string>();

async function callFromPage(method: string, params: Record<string, unknown>, signal?: AbortSignal, onProgress?: (stage: 'creating' | 'starting' | 'ready') => void) {
  const target = WRITE_METHODS.has(method) ? String(params.target ?? params.pane_id ?? '') : '';
  if (target) {
    if (sweep.isClosing(target)) throw new Error('This agent is closing as part of Re-org. Wait for it to finish.');
    activeAgentWrites.set(target, (activeAgentWrites.get(target) || 0) + 1);
  }
  try { return await dispatchFromPage(method, params, signal, onProgress); }
  finally { if (target) { const count = (activeAgentWrites.get(target) || 1) - 1; if (count) activeAgentWrites.set(target, count); else activeAgentWrites.delete(target); } }
}
async function dispatchFromPage(method: string, params: Record<string, unknown>, signal?: AbortSignal, onProgress?: (stage: 'creating' | 'starting' | 'ready') => void) {
  if (method === 'sweep.scan' || method === 'sweep.prepare') {
    await refreshSessionFiles();
    return method === 'sweep.scan' ? sweep.scan(params.minutes) : sweep.prepare(params);
  }
  if (method === 'sweep.finish') {
    if (!WRITABLE) throw Object.assign(new Error('This office is read-only.'), { code: 'forbidden' });
    const result = await sweep.finish(params);
    void poll();
    return result;
  }
  if (method === 'studio.get') { await studio.flush(); return studio.snapshot(params.compact ? 100 : undefined); }
  if (method === 'payment.detail') {
    const id = String(params.id ?? '');
    if (!/^(evt_[A-Za-z0-9]{1,255}|revenuecat:[\w-]{1,255})$/.test(id)) throw new Error('This entry has no individual payment record.');
    let detail = paymentDetails.get(id);
    if (id.startsWith('revenuecat:')) {
      const stored = rcWebhook.detail(id);
      if (stored && !stored.note) detail = stored;
      else detail ??= stored;
      if (!detail) throw new Error('This RevenueCat notification is no longer available on this host.');
      if (detail.customer?.id && RC_KEY && (params.refresh === true || (!detail.customer.name && !detail.customer.email))) {
        try {
          const project = await rcProject();
          const customer = await rcGet(`/projects/${encodeURIComponent(project)}/customers/${encodeURIComponent(detail.customer.id)}`);
          const attrs = new Map<string, string>((customer.attributes?.items ?? []).map((a: any) => [a.name, cleanDetail(a.value)]));
          detail.customer = { ...detail.customer, name: attrs.get('$displayName') || detail.customer.name, email: attrs.get('$email') || detail.customer.email, phone: attrs.get('$phoneNumber') || detail.customer.phone };
        } catch { detail.note = 'Customer lookup is unavailable. Showing information saved with this notification. RevenueCat customer lookups require Customer information → Customers → Read.'; }
      }
      // RevenueCat links are supplied only when their owning project is known.
      if (rcProjectId && detail.customer?.id) detail.customer.url = `https://app.revenuecat.com/customers/${encodeURIComponent(rcProjectId)}/${encodeURIComponent(detail.customer.id)}`;
      detail.url = detail.customer?.url ?? (rcProjectId ? `https://app.revenuecat.com/customers/${encodeURIComponent(rcProjectId)}` : 'https://app.revenuecat.com/');
      return detail;
    }
    if (!detail) {
      if (!STRIPE_KEY) throw new Error('Connect Stripe to load this payment record.');
      const response = await fetch(`https://api.stripe.com/v1/events/${id}`, { headers: { authorization: `Bearer ${STRIPE_KEY}` }, signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error(response.status === 404 ? 'Stripe no longer provides this event. Use its saved Stripe link to open the original record.' : 'Stripe could not load this event. Check the connection and Events → Read permission.');
      detail = stripePaymentDetails(await response.json() as any); paymentDetails.put(detail);
    }
    return STRIPE_KEY && (params.refresh === true || (!detail.customer?.name && !detail.customer?.email)) ? enrichStripeCustomer(detail, STRIPE_KEY) : detail;
  }
  if (method === 'studio.action.status') {
    const id = String(params.id);
    const status = studio.actionStatus(id);
    return status.state === 'confirmed' ? status : { state: studioActions.has(id) ? 'pending' : 'unknown' };
  }
  if (method === 'studio.journal') {
    await studio.flush(); const page = studio.journalPage(params);
    if (page.money) page.money = await recapFX.convert(page.money);
    return page;
  }
  if (method === 'agent.message.status') return receipts.status(messageKey(params.target), params.message_id);
  if (method === 'studio.change') {
    if (!WRITABLE) throw Object.assign(new Error('Studio is read-only.'), { code: 'forbidden' });
    const id = typeof params.action_id === 'string' ? params.action_id : undefined;
    if (id) studioActions.add(id);
    let before: ReturnType<typeof studio.snapshot> | undefined;
    try {
      await studio.run(() => {
        if (params.response === 'patch' && params.base_revision === studio.revision) before = studio.snapshot(100);
        studio.changeOnce(params, [...agents.values()]);
      });
    } finally { if (id) studioActions.delete(id); }
    const state = studio.snapshot(100);
    broadcast({ type: 'studio', studio: state });
    if (!['entry.read', 'room.save', 'goal.move'].includes(String(params.op))) {
      agents = new Map([...agents.values()].map(a => { const next = studio.decorate(a); return [next.pane_id, next]; }));
      broadcast({ type: 'agents', agents: [...agents.values()], workspaces: workspaceSummaries() });
    }
    if (params.response === 'patch') return before
      ? { type: 'studio.ack', revision: state.revision, patch: studioDelta(before, state) }
      : { type: 'studio.ack', revision: state.revision, studio: state };
    return state;
  }
  const allowed = READ_METHODS.has(method) || (WRITABLE && WRITE_METHODS.has(method));
  if (!allowed) throw Object.assign(new Error(`${method} not allowed${WRITABLE ? '' : ' (read-only bridge)'}`), { code: 'forbidden' });
  if (method === 'agent.boss') return boss.click(onProgress, params.project);
  if (method === 'agent.boss.briefing') return boss.briefing();
  if (method === 'agent.boss.archive') return boss.archive(params.cursor, params.search);
  const checked = WRITE_METHODS.has(method) ? checkedWriteParams(method, params) : params;
  if (method === 'agent.queue.status') {
    const target = String(params.target), agent = agents.get(target);
    const thread = agent?.agent_session?.kind === 'id' ? agent.agent_session.value : undefined;
    if (!agent || agentKind(agent) !== 'codex' || !thread || params.session !== thread) throw new Error('Codex queue session is no longer active.');
    const pending = MOCK ? [] : await codexQueueReader.read(thread);
    if (agents.get(target)?.agent_session?.value !== thread) throw new Error('Codex queue session changed.');
    return { pending };
  }
  if (WRITE_METHODS.has(method)) {
    const target = String(checked.target ?? checked.pane_id ?? '');
    if (sweep.isClosing(target)) throw new Error('This agent is closing as part of Re-org. Wait for it to finish.');
    if (['agent.prompt', 'agent.queue', 'agent.send_keys', 'agent.interrupt'].includes(method) && agents.has(target)) sweep.touch(agents.get(target)!);
  }
  if (method === 'agent.read') return agentOutput.read(params, { signal, priority: params.source === 'visible' ? 'interactive' : 'background' });
  if (method === 'agent.transcript') return transcriptTurns(String(params.target));
  if (method === 'agent.interrupt') {
    const target = String(checked.target);
    if (interrupting.has(target)) throw Error('Stop is already in progress.');
    interrupting.add(target);
    agentOutput.invalidate(target);
    const lastPrompt = agents.get(target)?.last_prompt ?? '';
    try {
      const result = await interruptAgent(backend.call.bind(backend), target, async () => {
        // A stopped Claude must not immediately start the next queued task. Preserve those
        // prompts in the existing stopped-queue UI, durably, for explicit review/requeue.
        if (claudeDispatching.has(target)) throw Error('A queued prompt is being submitted. Try Stop once it starts.');
        const queue = claudeQueues.get(target);
        if (queue?.length) {
          for (const item of queue) { item.state = 'failed'; item.error = 'Paused when you stopped this agent. Review this prompt before queueing it again.'; }
          await saveClaudeQueues();
          for (const item of queue) queueUpdate(item);
        }
      });
      return { ...result, prompt: result.prompt || lastPrompt };
    } finally { interrupting.delete(target); agentOutput.invalidate(target); void poll(); }
  }
  if (method === 'agent.settings.options') return agentSettingsOptions(String(params.kind));
  if (method === 'agent.settings.picker') {
    const listed = await backend.call('agent.list', {}) as { agents: AgentInfo[] };
    const agent = listed.agents.find(a => a.pane_id === checked.target);
    if (!agent || agentKind(agent) !== 'codex' || !['idle', 'done'].includes(agent.agent_status)) throw new Error('Wait until Codex is ready for input before opening its picker');
    await backend.call('agent.prompt', { target: checked.target, text: '/model' });
    await backend.call('agent.focus', { target: checked.target });
    return { message: 'Model picker opened in Herdr. Choose the model and effort there.' };
  }
  if (method === 'agent.settings.update') return updateAgentSettings(checked as { target: string; model: string; effort: string });
  if (method === 'agent.hire') return hireAgent(checked as HireParams, onProgress);
  if (method === 'agent.free') return hireFreeAgent(checked as HireParams, onProgress);
  if (method === 'agent.queue.dismiss') return dismissClaudeQueue(String(checked.target), String(checked.queue_id));
  if (method === 'agent.queue') return receipts.run(messageKey(checked.target) + ':queue', checked.queue_id,
    { target: checked.target, text: checked.text }, () => queueAgent(String(checked.target), String(checked.text), String(checked.queue_id), Number(checked.queued_at)));
  if (method === 'agent.prompt') return receipts.run(messageKey(checked.target), params.message_id, checked, async () => {
    agentOutput.invalidate(String(checked.target));
    try { return await deliverPrompt(backend.call.bind(backend), agentKind(agents.get(String(checked.target))!), String(checked.target), String(checked.text)); }
    finally { agentOutput.invalidate(String(checked.target)); void poll(); }
  });
  if (WRITE_METHODS.has(method)) agentOutput.invalidate(String(checked.target ?? checked.pane_id));
  try { return await backend.call(method, checked); }
  finally { if (WRITE_METHODS.has(method)) agentOutput.invalidate(String(checked.target ?? checked.pane_id)); }
}

/** Read an upload without allowing a missing/forged Content-Length to grow memory without bound. */
async function limitedBody(req: Request, limit: number) {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw Object.assign(new Error('image is too large (12 MB limit)'), { status: 413 }); }
    chunks.push(value);
  }
  const out = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/** MIME headers are user-controlled, so also require the corresponding image signature. */
function hasImageSignature(type: string, b: Uint8Array) {
  if (type === 'image/png') return b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => b[i] === n);
  if (type === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const word = (start: number, text: string) => [...text].every((c, i) => b[start + i] === c.charCodeAt(0));
  if (type === 'image/webp') return b.length >= 12 && word(0, 'RIFF') && word(8, 'WEBP');
  if (type === 'image/gif') return b.length >= 6 && (word(0, 'GIF87a') || word(0, 'GIF89a'));
  return false;
}

/** Last few non-empty lines of a pane, for the feed. Best effort. */
async function snippetOf(paneId: string): Promise<string | undefined> {
  try {
    const r = (await agentOutput.read({ target: paneId, source: 'recent', lines: 12 }, { priority: 'background' })) as { read: { text: string } };
    const lines = r.read.text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !/^[\s─═╌│┃└┌┐┘╭╮╰╯>]*$/.test(l));
    const s = lines.slice(-3).join('\n');
    return s.length > 240 ? '…' + s.slice(-240) : s || undefined;
  } catch { return undefined; }
}

/** The agent's account of a finished task, from the tail of its pane. Best effort: herdr only
 *  hands out scrollback while a pane is idle, and a person often types the next prompt in the
 *  same minute a task ends, so the visible screen — always readable, and still showing the reply
 *  for a while — is the fallback. `deep` says whether the scrollback was actually read. */
async function outcomeOf(paneId: string, when: { at: number; minutes: number }): Promise<{ outcome: Outcome; deep: boolean } | undefined> {
  const transcript = await transcriptOf(agents.get(paneId));
  // Only a reply from the task's own window counts; a transcript with nothing there is the wrong file.
  const own = transcript && outcomeFor(transcript, when.at, when.minutes);
  if (own) return { outcome: own, deep: true };
  for (const source of ['recent_unwrapped', 'recent', 'visible']) {
    try {
      // a ten-minute task's prompt is a long way up the scrollback
      const r = (await agentOutput.read({ target: paneId, source, ...(source === 'visible' ? {} : { lines: 900 }) }, { priority: 'background' })) as { read: { text: string } };
      return { outcome: extractOutcome(r.read.text), deep: source !== 'visible' };
    } catch { /* try the plainer source */ }
  }
  return undefined;
}
/** Panes whose newest journal entry has been checked against their transcript this run. */
const backfilled = new Set<string>();
/** Completions whose pane could not be read in full yet; tried again on later polls. */
const undescribed = new Map<string, { entryId: string; title: string; tries: number; at: number; minutes: number }>();

const sessionKey = (a: AgentInfo) => JSON.stringify([a.pane_id, a.agent, a.agent_session?.kind, a.agent_session?.value, a.cwd]);
let enriching = false;
/** Disk scanning and terminal history have their own clock. A slow history read cannot stall
 * status, the selected conversation, or release of a queued follow-up. */
async function enrichAgents() {
  if (enriching) return;
  enriching = true;
  const stagedBackfills: string[] = [];
  const stagedPending = new Map<string, { entryId: string; title: string; tries: number; at: number; minutes: number }>();
  try {
    const enriched = await withCurrent(await withModels([...agents.values()]));
    let updated = false;
    for (const a of enriched) {
      const live = agents.get(a.pane_id);
      if (!live || sessionKey(live) !== sessionKey(a)) continue;
      // Status can advance while a terminal read is pending. Never restore that older status.
      const sameState = live.agent_status === a.agent_status && live.state_change_seq === a.state_change_seq;
      const next = { ...live, model: a.model ?? live.model,
        ...(sameState ? { last_prompt: a.last_prompt, activity: a.activity, wait_notice: a.wait_notice } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(live)) { agents.set(a.pane_id, next); updated = true; }
    }
    // The terminal may say idle before Codex flushes task_complete. Recheck the saved
    // record in background so a short turn can be credited on a later idle poll.
    for (const a of [...agents.values()]) {
      if (a.agent !== 'codex' || a.agent_status !== 'idle' || a.completed_task || a.wait_notice) continue;
      const transcript = await transcriptOf(a);
      const live = agents.get(a.pane_id);
      if (!transcript?.completedAt || !live || live.agent_status !== 'idle' || sessionKey(live) !== sessionKey(a) || live.state_change_seq !== a.state_change_seq) continue;
      const verified = { ...live, last_turn_completed_at: transcript.completedAt };
      if (!studio.needsObservation([verified])) continue;
      const observed = await studio.run(() => {
        const current = agents.get(a.pane_id);
        if (!current || current.agent_status !== 'idle' || sessionKey(current) !== sessionKey(a) || current.state_change_seq !== a.state_change_seq) return { changed: false, completions: new Map() };
        return studio.observe([verified]);
      });
      for (const completion of observed.completions.values()) {
        await studio.run(() => studio.describe(completion.entryId, { prompt: transcript.prompt, summary: transcript.reply?.slice(0, 900) }, titleOf(a)));
      }
      if (observed.changed) { broadcast({ type: 'studio', studio: studio.snapshot(100) }); updated = true; }
      // Do not overwrite a status that advanced during the durable write.
      const latest = agents.get(a.pane_id);
      if (latest) agents.set(a.pane_id, studio.decorate(latest));
    }
    if (updated) broadcast({ type: 'agents', agents: [...agents.values()], workspaces: workspaceSummaries() });
    const descriptions: Array<{ id: string; outcome: Outcome; title: string }> = [];
    let budget = 4;
    for (const a of agents.values()) {
      const key = sessionKey(a);
      if (backfilled.has(key) || budget-- <= 0) continue;
      const entries = studio.placeholdersFor(a);
      const transcript = entries.length ? await transcriptOf(a) : undefined;
      if (entries.length && !transcript) continue;
      stagedBackfills.push(key);
      for (const entry of entries) {
        const outcome = transcript && outcomeFor(transcript, entry.at, entry.minutes ?? 1);
        if (outcome) descriptions.push({ id: entry.id, outcome, title: titleOf(a) });
      }
    }
    // Rotate a bounded batch so one busy/unreadable pane cannot starve later completions.
    for (const [paneId, pending] of [...undescribed].slice(0, 2)) {
      undescribed.delete(paneId);
      if (!agents.has(paneId)) continue;
      stagedPending.set(paneId, pending);
      const read = await outcomeOf(paneId, pending);
      if (read?.outcome.summary) descriptions.push({ id: pending.entryId, outcome: read.outcome, title: pending.title });
      if (!(read?.deep && read.outcome.summary) && ++pending.tries <= 120 && !undescribed.has(paneId)) undescribed.set(paneId, pending);
    }
    if (descriptions.length) {
      const changed = await studio.run(() => descriptions.reduce((changed, d) => studio.describe(d.id, d.outcome, d.title) || changed, false));
      if (changed) broadcast({ type: 'studio', studio: studio.snapshot(100) });
    }
    for (const key of stagedBackfills) backfilled.add(key);
  } catch (error) {
    // A failed durable description write must leave its retry work available.
    for (const [pane, pending] of stagedPending) if (!undescribed.has(pane)) undescribed.set(pane, pending);
    console.warn('[bridge] background enrichment:', (error as Error).message);
  }
  finally { enriching = false; }
}
let pollingAgents = false;
async function poll() {
  if (pollingAgents) return;
  pollingAgents = true;
  try {
    const listed = await listedAgents();
    await sweep.observe(listed);
    reportedModels.clear();
    for (const a of listed) reportedModels.set(a.pane_id, { model: a.model || null });
    const previous = agents;
    const next = new Map<string, AgentInfo>();
    for (const raw of listed) {
      const workspaceId = raw.workspace_id || raw.pane_id.split(':', 1)[0];
      const old = previous.get(raw.pane_id), sameSession = old && sessionKey(old) === sessionKey(raw);
      const cached = sameSession ? { model: old.model, last_prompt: old.last_prompt, activity: old.activity, wait_notice: old.agent_status === raw.agent_status && old.state_change_seq === raw.state_change_seq ? old.wait_notice : null } : {};
      const a = studio.decorate({ ...cached, ...raw,
        office_role: boss.matches(raw) ? 'boss' : undefined,
        model: raw.model || cached.model || null,
        last_prompt: raw.last_prompt ?? cached.last_prompt, activity: raw.activity ?? cached.activity,
        workspace_id: workspaceId, workspace_name: workspaceLabels.get(workspaceId) || null });
      next.set(a.pane_id, a);
      boss.capture(a);
    }
    // Publish authoritative live state before transcript or persistence work.
    agents = next;
    for (const [id, a] of next) {
      const before = previous.get(id);
      if (before && (sessionKey(before) !== sessionKey(a) || before.agent_status !== a.agent_status
        || before.state_change_seq !== a.state_change_seq)) agentOutput.agentChanged(id);
    }
    for (const id of previous.keys()) if (!next.has(id)) agentOutput.agentChanged(id);
    // Announce departures while browsers still have their actors and desks. This stays
    // before the snapshot and does not wait for transcript or persistence work.
    for (const [id, prev] of previous) if (!next.has(id)) {
      pushEvent({ kind: 'left', pane_id: id, agent: agentKind(prev), status: prev.agent_status, title: titleOf(prev), prev_for_ms: Date.now() - (since.get(id) ?? Date.now()), cwd: prev.foreground_cwd || prev.cwd || null });
    }
    broadcast({ type: 'agents', agents: [...next.values()], workspaces: workspaceSummaries() });
    workspaceListChanged = false;
    for (const target of claudeQueues.keys()) void pumpClaudeQueue(target);
    const observed = studio.needsObservation(listed)
      ? await studio.run(() => studio.observe([...next.values()]))
      : { changed: false, completions: new Map() };
    for (const [paneId, completion] of observed.completions) {
      const entry = studio.journalEntry(completion.entryId);
      undescribed.set(paneId, { entryId: completion.entryId, title: titleOf(next.get(paneId)!), tries: 0, at: entry?.at ?? Date.now(), minutes: entry?.minutes ?? 1 });
    }
    if (observed.changed) {
      broadcast({ type: 'studio', studio: studio.snapshot(100) });
      // Identity/career changes become visible after their durable save.
      for (const [id, a] of agents) agents.set(id, studio.decorate(a));
      broadcast({ type: 'agents', agents: [...agents.values()], workspaces: workspaceSummaries() });
    }
    for (const a of next.values()) {
      const prev = previous.get(a.pane_id);
      const base = { pane_id: a.pane_id, agent: agentKind(a), status: a.agent_status, title: titleOf(a), cwd: a.foreground_cwd || a.cwd || null };
      if (!prev) { since.set(a.pane_id, Date.now()); if (previous.size || events.length) pushEvent({ kind: 'joined', ...base }); continue; }
      if (prev.agent_status !== a.agent_status) {
        const prev_for_ms = Date.now() - (since.get(a.pane_id) ?? Date.now()); since.set(a.pane_id, Date.now());
        pushEvent({ kind: 'status', prev: prev.agent_status, prev_for_ms, ...base, completion: observed.completions.get(a.pane_id) });
      } else if (titleOf(prev) !== base.title && base.title) pushEvent({ kind: 'title', ...base });
    }
    for (const [id, prev] of previous) if (!next.has(id)) {
      const abandoned = claudeQueues.get(id) ?? [];
      for (const item of abandoned) { item.state = 'failed'; item.error = 'agent closed before this prompt was sent'; queueUpdate(item); }
      since.delete(id); claudeQueues.delete(id); claudeDispatching.delete(id); current.delete(id);
      if (abandoned.length) await saveClaudeQueues();
    }
    void enrichAgents();
  } catch (e) { console.log('[bridge] poll failed:', (e as Error).message); }
  finally { pollingAgents = false; }
}
setInterval(poll, POLL_MS); poll();
// Stripe keeps its own clock; nothing about the office should hold it up, or vice versa.
// Always scheduled, and a no-op until there is a key: one can arrive at any time from the office's
// own setup window, and nothing should need restarting for it to start working.
setInterval(() => void pollStripeEvents(), STRIPE_POLL_MS); void pollStripeEvents();
setInterval(() => void rcWebhook.drain(), 5000); void rcWebhook.drain();
// Only this listener may be exposed publicly. It cannot serve the game or forward terminal RPCs.
const webhookPort = Number(process.env.HERDR_STORY_WEBHOOK_PORT || 0);
if (webhookPort && rcWebhook.enabled && (!MOCK || process.env.HERDR_STORY_WEBHOOK_MOCK === '1')) {
  try {
    Bun.serve({ hostname: '127.0.0.1', port: webhookPort, maxRequestBodySize: 256 * 1024, idleTimeout: 10,
      fetch: req => rcWebhook.fetch(req) });
    rcWebhookListening = true;
    console.log(`[revenuecat] Webhook-only listener on 127.0.0.1:${webhookPort}`);
  } catch { console.warn('[revenuecat] Could not start webhook listener; check HERDR_STORY_WEBHOOK_PORT.'); }
}

// ---------- websocket + static ----------
const DIST = join(import.meta.dir, '..', 'dist');
const allowBrowser = browserAccess({ port: PORT, host: HOST, origins: process.env.HERDR_STORY_ALLOWED_ORIGINS });
const gzipCache = new Map<string, Uint8Array>();
const snapshot = (): Extract<ServerMsg, { type: 'snapshot' }> => ({
  type: 'snapshot', agents: [...agents.values()], events: events.slice(-60), writable: WRITABLE, mock: MOCK,
  queues: queueItems(), delivered_queue_ids: [...deliveredClaudeQueueIds.keys()], bridge_started_at: BRIDGE_STARTED_AT,
  money: moneyEvents.slice(-12), workspaces: workspaceSummaries(),
  studio: publishedStudio,
});
Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (!allowBrowser(req)) return new Response('Untrusted browser origin or host. See HERDR_STORY_ALLOWED_ORIGINS.', { status: 403 });
    if (url.pathname === '/ws') return server.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 });
    if (url.pathname === '/health') return Response.json({ ok: true, agents: agents.size, mock: MOCK, writable: WRITABLE });
    // Safari/WebKit can occasionally fail a WebSocket behind a development reverse proxy. These
    // same-origin HTTP endpoints keep the office usable without exposing any additional methods.
    if (url.pathname === '/api/state') return Response.json(snapshot());
    if (url.pathname === '/api/call') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return new Response('JSON required', { status: 415 });
      if (Number(req.headers.get('content-length') ?? 0) > 25_000) return new Response('request too large', { status: 413 });
      return req.json().then(async (body: any) => {
        if (!body || body.type !== 'call' || typeof body.method !== 'string') throw new Error('invalid call');
        return Response.json({ result: await callFromPage(body.method, body.params ?? {}, req.signal) });
      }).catch((e) => Response.json({ error: { code: (e as any).code ?? 'error', message: (e as Error).message } }, { status: (e as any).code === 'forbidden' ? 403 : 400 }));
    }
    if (url.pathname === '/api/image') {
      if (req.method === 'GET') return attachmentImage(url.searchParams.get('path') || '');
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!WRITABLE) return Response.json({ error: { message: 'bridge is read-only' } }, { status: 403 });
      const type = (req.headers.get('content-type') ?? '').split(';', 1)[0].toLowerCase();
      const ext = IMAGE_TYPES.get(type);
      if (!ext) return Response.json({ error: { message: 'paste a PNG, JPEG, WebP, or GIF image' } }, { status: 415 });
      if (Number(req.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return Response.json({ error: { message: 'image is too large (12 MB limit)' } }, { status: 413 });
      try {
        const bytes = await limitedBody(req, MAX_IMAGE_BYTES);
        if (!hasImageSignature(type, bytes)) return Response.json({ error: { message: 'file content does not match its image type' } }, { status: 415 });
        const path = join(UPLOAD_DIR, `${crypto.randomUUID()}${ext}`);
        await Bun.write(path, bytes);
        return Response.json({ path }, { headers: { 'cache-control': 'no-store' } });
      } catch (e) {
        return Response.json({ error: { message: (e as Error).message } }, { status: (e as any).status ?? 400 });
      }
    }
    if (url.pathname === '/api/revenuecat/webhook') {
      const headers = { 'cache-control': 'no-store' };
      if (req.method === 'GET') return Response.json(rcWebhookStatus(), { headers });
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (!WRITABLE) return Response.json({ error: 'This bridge is read-only.' }, { status: 403, headers });
      if (!webhookSetupOriginAllowed(req))
        return new Response('same origin required', { status: 403 });
      if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return new Response('JSON required', { status: 415 });
      if (Number(req.headers.get('content-length') ?? 0) > 1000) return new Response('too large', { status: 413 });
      const body = await req.json().catch(() => null) as { action?: string } | null;
      if (!body) return new Response('invalid JSON', { status: 400 });
      if (body.action === 'register') {
        if (!RC_KEY || !rcWebhookListening || !process.env.REVENUECAT_WEBHOOK_PUBLIC_URL || !process.env.REVENUECAT_WEBHOOK_AUTH)
          return Response.json({ error: 'Configure the RevenueCat API key and public webhook receiver first.' }, { status: 400, headers });
        try {
          if (!rcWebhookRegistration) rcWebhookRegistration = (async () => {
            const result = await registerRevenueCatWebhook({ key: RC_KEY, project: await rcProject(),
              url: process.env.REVENUECAT_WEBHOOK_PUBLIC_URL!, authorization: process.env.REVENUECAT_WEBHOOK_AUTH! });
            if (result.signingSecret) {
              envUpsert('REVENUECAT_WEBHOOK_SIGNING_SECRET', result.signingSecret);
              rcWebhook.setSigningSecret(result.signingSecret);
            }
            envUpsert('REVENUECAT_WEBHOOK_INTEGRATION_ID', result.id);
            rcWebhookIntegrationId = result.id;
          })().finally(() => { rcWebhookRegistration = undefined; });
          server.timeout(req, 120);
          await rcWebhookRegistration;
          return Response.json({ ok: true, ...rcWebhookStatus() }, { headers });
        } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400, headers }); }
      }
      // Explicit copy action, private app only. The ordinary status response never includes secrets.
      return Response.json({ authorization: process.env.REVENUECAT_WEBHOOK_AUTH || null }, { headers });
    }
    if (url.pathname === '/api/setup' && req.method === 'POST') {
      const noStore = { 'cache-control': 'no-store' };
      // Same gate as every other write. A bridge someone else can reach is never handed a key.
      if (!WRITABLE) return Response.json({ error: 'This bridge is read-only — put the key in .env instead.' }, { status: 403, headers: noStore });
      if (Number(req.headers.get('content-length') ?? 0) > 4_000) return new Response('too large', { status: 413 });
      try {
        const body = await req.json() as { provider?: string; key?: string };
        const shape = KEY_SHAPES[String(body.provider)];
        const key = String(body.key ?? '').trim();
        if (!shape) return Response.json({ error: 'Unknown provider.' }, { status: 400, headers: noStore });
        if (!key) return Response.json({ error: 'Paste a key first.' }, { status: 400, headers: noStore });
        if (!shape.prefix.test(key)) return Response.json({ error: `That does not look right — ${shape.hint}.` }, { status: 400, headers: noStore });
        await verifyKey(String(body.provider), key);     // throws with the provider's own words
        if (body.provider === 'stripe') STRIPE_KEY = key; else RC_KEY = key;
        envUpsert(shape.env, key);
        revenue = null;
        revenueCache.clear();
        revenuePending.clear();
        if (body.provider === 'stripe') void pollStripeEvents();
        return Response.json({ ok: true, provider: body.provider, hint: keyHint(key) }, { headers: noStore });
      } catch (e) {
        // Never the key, and never a stack: the provider's message is the useful part.
        return Response.json({ error: (e as Error).message }, { status: 400, headers: noStore });
      }
    }
    if (url.pathname === '/api/setup') {
      // What the setup wizard needs to tell someone exactly where their key goes. Paths only, and
      // only ever the project's own — never the key, which the browser has no business seeing.
      return Response.json({
        configured: Boolean(STRIPE_KEY || RC_KEY),
        stripe: Boolean(STRIPE_KEY),
        revenuecat: Boolean(RC_KEY),
        writable: WRITABLE,
        stripe_hint: keyHint(STRIPE_KEY),
        revenuecat_hint: keyHint(RC_KEY),
        env_path: join(process.cwd(), '.env'),
        cwd: process.cwd(),
        var_name: 'STRIPE_RESTRICTED_KEY',
        error: revenue?.error ?? null,
      }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/api/revenue') {
      // Historical Stripe pagination can outlast Bun's default 10-second idle timeout.
      server.timeout(req, 120);
      const noStore = { 'cache-control': 'no-store' };
      if (!STRIPE_KEY && !RC_KEY) return Response.json({ source: 'none', at: Date.now() } satisfies Revenue, { headers: noStore });
      const requested = url.searchParams.get('range');
      if (requested !== null && !isRevenueRange(requested)) return Response.json({ error: 'Unknown revenue range.' }, { status: 400, headers: noStore });
      const range = requested ?? undefined;
      const key = range ?? 'default';
      let result = revenueCache.get(key);
      if (!result || Date.now() - result.at > REVENUE_TTL) {
        let pending = revenuePending.get(key);
        if (!pending) {
          pending = combinedRevenue(range);
          revenuePending.set(key, pending);
        }
        result = await pending;
        if (revenuePending.get(key) === pending) {
          revenueCache.set(key, result);
          revenuePending.delete(key);
        }
      }
      revenue = result;
      return Response.json({ ...result, rangeSelectable: Boolean(STRIPE_KEY || RC_KEY), calendarRanges: Boolean(RC_KEY) }, { headers: noStore });
    }
    if (url.pathname === '/api/seatmap') { // layout editor (public/lab) saves its placements here
      if (req.method === 'POST' && !WRITABLE) return new Response('bridge is read-only', { status: 403 });
      const file = join(import.meta.dir, '..', 'seatmap.json');
      if (req.method === 'POST') return req.text().then((t) => { JSON.parse(t); return Bun.write(file, t); }).then(() => Response.json({ ok: true })).catch((e) => new Response(String(e), { status: 400 }));
      return existsSync(file) ? new Response(Bun.file(file), { headers: { 'content-type': 'application/json' } }) : Response.json({ items: [] });
    }
    const file = Bun.file(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.size) return new Response('not found (run `npm run build` for static hosting; dev uses vite on :5173)', { status: 404 });
    const headers = new Headers({
      'content-type': file.type,
      'cache-control': /^\/assets\/[^/]+-[A-Za-z0-9_-]+\./.test(url.pathname)
        ? 'public, max-age=31536000, immutable'
        : url.pathname.startsWith('/assets/gds/') ? 'public, max-age=86400' : 'no-cache',
    });
    const compressible = /\.(?:js|css|html|json|svg)$/.test(url.pathname) || url.pathname === '/';
    if (compressible && file.size > 1024 && (req.headers.get('accept-encoding') ?? '').includes('gzip')) {
      // Built HTML is no-cache because its hashed asset references change on every build. Never
      // retain its compressed bytes in-process, or a rebuild can leave remote clients requesting
      // bundles that no longer exist. Hashed assets themselves are safe to keep indefinitely.
      const immutable = headers.get('cache-control')?.includes('immutable') ?? false;
      let body = immutable ? gzipCache.get(url.pathname) : undefined;
      if (!body) {
        body = Bun.gzipSync(new Uint8Array(await file.arrayBuffer()));
        if (immutable) gzipCache.set(url.pathname, body);
      }
      headers.set('content-encoding', 'gzip'); headers.set('vary', 'Accept-Encoding');
      return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, { headers });
    }
    return new Response(file, { headers });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      // Capability negotiation avoids sending a full history to a new client just to trim it again.
      initialSnapshots.set(ws, setTimeout(() => {
        initialSnapshots.delete(ws);
        if (clients.has(ws)) ws.send(JSON.stringify({ ...snapshot(), studio: studio.snapshot() }));
      }, 100));
    },
    close(ws) {
      clients.delete(ws); deltaClients.delete(ws); agentOutput.close(ws);
      clearTimeout(initialSnapshots.get(ws)); initialSnapshots.delete(ws);
      for (const controller of socketReads.get(ws)?.values() ?? []) controller.abort();
      socketReads.delete(ws);
    },
    async message(ws, raw) {
      let msg: ClientMsg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'hello' && msg.deltas === true) {
        clearTimeout(initialSnapshots.get(ws)); initialSnapshots.delete(ws); deltaClients.add(ws);
        ws.send(JSON.stringify(snapshot())); return;
      }
      if (msg.type === 'output.subscribe') { if (typeof msg.target === 'string') agentOutput.subscribe(ws, msg.target); return; }
      if (msg.type === 'output.unsubscribe') { agentOutput.unsubscribe(ws); return; }
      if (msg.type === 'cancel') { socketReads.get(ws)?.get(msg.id)?.abort(); return; }
      if (msg.type !== 'call' || typeof msg.id !== 'string' || typeof msg.method !== 'string') return;
      const controller = msg.method === 'agent.read' ? new AbortController() : undefined;
      if (controller) {
        let reads = socketReads.get(ws);
        if (!reads) { reads = new Map(); socketReads.set(ws, reads); }
        reads.set(msg.id, controller);
      }
      try {
        const result = await callFromPage(msg.method, msg.params ?? {}, controller?.signal,
          stage => { if (clients.has(ws)) ws.send(JSON.stringify({ type: 'launch', id: msg.id, stage })); });
        if (!controller?.signal.aborted && clients.has(ws)) ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
      }
      catch (e) {
        if (!controller?.signal.aborted && clients.has(ws)) ws.send(JSON.stringify({ type: 'result', id: msg.id,
          error: { code: (e as any).code ?? 'error', message: (e as Error).message } }));
      }
      finally { if (controller) socketReads.get(ws)?.delete(msg.id); }
    },
  },
});
console.log(`[bridge] ws://${HOST}:${PORT}/ws  mock=${MOCK} writable=${WRITABLE}`);
