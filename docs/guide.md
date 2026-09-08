# User guide

A Game Dev Story-styled office that shows what your [herdr](https://herdr.dev) agents are doing.
Every agent is an employee at a desk; the right column is a live roster grouped by project.
Project whiteboards, lasting employee careers, a studio journal, and movable furnishings turn
completed work into a shared studio history.

Boss sits at a movable executive desk. Click him for a pixel-art studio briefing powered by
Claude Fable 5.1: a short introduction, then up to three ideas shown one at a time with journal
evidence, why they matter, and a concrete next step. Arrow keys or Previous/Next move through the
cards; Escape returns to the office. His creative brief asks for a compelling extension, an
unexpected connection, and a bold wildcard, each with a small experiment to try. Open chat is
available when you want the full conversation.
Choose the project scope and press Ask Boss to start the agent; there is
no scheduled review or background model use. New reviews are limited to one every 24 hours,
enforced by the bridge across tabs, restarts, and replacement sessions. Until then, desk clicks
reopen saved ideas and show when the next review is available. Later reviews reuse his conversation and send only
new or changed entries from the latest twelve, with short excerpts and relevant unfinished
milestones and up to three older titles for new connections. Unchanged journals just reopen his
existing ideas; a creative-direction update requests a fresh briefing on the next eligible desk click.
Boss launches with Claude's
permission bypass enabled, including its first-use confirmation. Reviews use low effort, no tools,
and an isolated working directory; his own journal contributions are excluded. The bridge saves
his session, review fingerprints, daily limit, and briefing archive in `boss.json` under `HERDR_STORY_STATE_DIR` (or the default
studio state directory). **Archive** in Boss’s window lists dated briefings that can be replayed
as idea cards. Completed replies are saved even after the window closes; older replies still in
his transcript are recovered into the archive. Existing numbered replies also become briefing cards without another
model request. Reading cards from the roster and polling for a finished reply never trigger
a review. **Open chat** stays available while waiting; **Check again** only rereads the answer.
Run `npm run test:boss` for isolated unit and browser checks.

Click reception, or **Front desk** above the roster, for four shortcuts:

- **Who needs me?** opens by default and lists agents waiting for input. A brass bell appears on
  the reception counter while anyone needs attention; each row opens that agent’s chat.
- **I have a new task.** chooses a project and an existing agent or a new hire. Existing agents
  get a draft to review and send or queue. Hiring carries the task into the recruitment form.
  Unfinished messages are never replaced, and cancelled hiring keeps the front-desk draft.
- **Catch me up.** counts completed work, milestones, releases, and payments since the previous
  visit, including archived journal entries. First visits show the last 24 hours. Each category
  can load older results and open the original memory or payment record.
- **Find something.** searches agent names/tasks, project boards, the full journal, and Boss’s
  complete saved archive. Opening a saved idea never requests another review.

Reception uses existing records without model calls. Escape closes it and keeps its task draft;
read-only offices can browse everything and cannot send or hire. Run `npm run test:reception`
for the isolated data and browser checks.

Two office regulars share the staff's walking paths: **Miso**, a ginger cat who naps by desks,
and **Gus**, the janitor who sweeps the aisles. Click Miso to pet him or rediscover completed
tasks, releases, and milestones from the Journal. Click Gus to open the existing **Re-org**
review; he also guides the departure cutscene. Both have shortcuts at the bottom of **Front desk**.
They never occupy agent slots or send model requests, and opening Re-org only scans: you still
choose which recaps to save and which agents to close. Reduced motion keeps the residents still.
Run `npm run test:office-regulars` for isolated browser checks.

```
npm install
npm run assets      # extract sprites from assets/raw (needs ImageMagick; artwork is not committed)
npm run dev         # interactive local bridge (bun, :7788) + vite (:5173) against your running herdr
npm run dev:read-only # local viewer without prompt/terminal write access
npm run dev:mock    # same, with fake agents
npm run dev:tailscale # tailnet-only HTTPS access through Tailscale Serve
npm run shot        # screenshot http://localhost:5173 into shots/latest.png (playwright)
npm test            # durable studio and career regression tests
npm run test:studio # build + isolated mock browser checks; never touches live agents or saves
```

Redistributable third-party props live under `public/assets/open`; see the attribution file in
that directory for their source, license, and any modifications.

- `bridge/server.ts` polls `agent.list` over herdr's socket, diffs it into events, and serves them over WebSocket.
  Localhost is interactive by default: open an agent and type a prompt. Direct network binds are read-only unless
  deliberately started with `HERDR_STORY_WRITE=1`; set `HERDR_STORY_WRITE=0` to force read-only mode anywhere.
  Claude follow-up queues are persisted owner-only under `~/.local/state/herdr-story` so restarting the bridge does
  not silently discard them. Set `HERDR_STORY_STATE_DIR` to move that runtime state.
  Codex receipts are reconciled with its native pending queue while the conversation is open.
  Consumed or removed prompts leave the queued tray, including stale receipts from older builds.
  Status reads use the existing control socket or the standalone terminal's read-only queue database;
  they never replay prompts, and a failed read retains the pending receipts.
- Click the retro terminal to start a **Free agent**: a fresh Codex workspace in `~/projects`, with
  no initial task and the agent's normal model settings. Its conversation opens when it is ready.
  Set `HERDR_STORY_PROJECTS_DIR` to use another existing absolute directory. In room-edit mode,
  the terminal remains movable; clicking it does not launch an agent.
- The office's status bar shows a dollar figure, and Stripe activity appears in the roster and on the office floor.
  Start the bridge with `STRIPE_RESTRICTED_KEY` (`STRIPE_SECRET_KEY` also works) to turn both on. Use a **restricted**
  key (`rk_…`): the bridge only ever issues `GET /v1/balance_transactions` and `GET /v1/events`, so it needs *Read* on
  **Balance** (`rak_balance_read`) and **Events** (`rak_event_read`), and no write permission anywhere. The office's
  own **gear** button opens **Revenue settings**, where you choose the reporting period and use
  **Manage payment sources** to open setup with a tab per provider. Hovering over the total only shows its breakdown. A key can be pasted straight into it: the bridge checks it against the provider
  first, then writes it to `.env` itself (0600) and starts using it without a restart — it is never sent back to the
  page, which only ever sees its last four characters. This needs a writable bridge, the same `HERDR_STORY_WRITE`
  gate as every other write; a read-only bridge shows the file-and-restart instructions instead. The Stripe tab opens Stripe's key form with the name and both
  permissions already filled in via `?name=&permissions[]=`, watches the bridge, and says so when the key goes live.
  A key that is rejected or too narrow is logged as a 401/403 naming the missing permission rather than failing
  silently. The funds selector remembers 24h, 7d, 30d, 3m, YTD, or All time. `HERDR_STORY_REVENUE_DAYS`
  (default 30) sets the default for Stripe API reads without an explicit range, and `HERDR_STORY_STRIPE_POLL_MS` (default 15000) how often events are read.
- **RevenueCat** works alongside or instead of Stripe: set `REVENUECAT_API_KEY` to a **v2 secret** key with
  `charts_metrics:overview:read` (plus `project_configuration:projects:read`, or set `REVENUECAT_PROJECT_ID` and skip
  it). The same selector uses RevenueCat’s date-range gross revenue total (before taxes and store fees). RevenueCat accepts
  inclusive UTC dates, so 24h becomes Today; 7d and 30d include today plus the preceding 6 or 29 days.
  Set `HERDR_STORY_REVENUECAT_START_DATE` and `HERDR_STORY_STRIPE_START_DATE` to fixed `YYYY-MM-DD`
  dates to choose each provider’s All time start. These dates stay fixed as time passes and appear in the breakdown.
  When RevenueCat is connected, Stripe uses the same dates for the other ranges. Both books are added when they share a currency — never
  across currencies, since there is no honest rate to do it with. Individual payment notifications use
  RevenueCat webhooks (setup below), independently of the revenue range. Changes in subscriber counts
  or range totals never create synthetic payments. The API key stays on the bridge; the browser only receives the
  total. Results are cached for one minute per range across tabs. Without a key the bar counts shipped
  tasks instead and says so on its label. **Bun loads `.env` automatically, so a key placed there works with no
  further setup — `.env` is git-ignored, and the key does not belong in the repo or in the client bundle.**
- `npm run dev:tailscale` builds the optimized client, keeps the bridge on `127.0.0.1`, and proxies its static
  server with Tailscale Serve. Remote browsers receive the production bundle instead of Vite's development modules. Its
  `https://…ts.net` URL is available only to identities permitted by your tailnet access rules. Do not use
  Tailscale Funnel for this app: Funnel makes the endpoint public.
  Install Tailscale and sign in on the host and viewing device first; the command prints the private URL and
  keeps Serve in the foreground until Ctrl+C. The first run may ask you to enable tailnet HTTPS. On a shared
  tailnet, restrict access to this machine's port 443 with a Tailscale grant or ACL.
- `src/scenes/OfficeScene.ts` draws the office. `?lab=1` opens a sprite lab for checking frame names and face offsets.
- `src/feed/feed.ts` renders the timeline; post wording lives in the `T` table.
- `src/audio.ts` plays the office music and maps game events to sampled effects after the first user interaction.
- The bridge enriches agents with their exact runtime model from local Codex/Claude session metadata. It caches the
  result and checks active session tails periodically, so changing models does not require restarting the office.
- **Model and effort:** hiring a Codex or Claude agent offers optional model and reasoning-effort choices. Blank
  choices preserve the CLI defaults. Codex suggestions come from the installed CLI's bundled catalog; Claude
  offers aliases, and either accepts an explicit model ID. Account access and model support still apply.
  Open an employee's conversation and expand **Model & effort** to change an existing agent. Codex applies each
  choice to subsequent turns through its existing app-server control socket (`HERDR_STORY_CODEX_SOCKET` can
  select a custom socket). If that session has no accessible daemon, **Open terminal picker** opens `/model`
  in Herdr so you can select both settings there. Claude sends `/model` or `/effort` only while idle/done;
  apply one choice at a time and check the terminal for confirmation. Claude may persist these choices as CLI
  defaults. Runtime model labels continue to come from observed session metadata rather than requested changes.
  Read-only bridges reject all settings changes. `npm run test:agent-settings` checks the controls against an
  isolated mock bridge without changing live agents.
- Agent progression follows the game's work balloons: every real completion awards one Program, Scenario, Graphics,
  Sound, Debug, or Promotion point based on the task title. Three completed tasks earn a level. The bridge records
  one completion per observed work cycle when an agent reports done, or returns to idle after more than a minute.
  Short idle transitions and repeated snapshots do not award points. The journal labels inferred completions;
  removing an incorrect completion also removes its career point.

A desk's furniture follows its occupant's rank, the way the game's item shop upgrades a studio:
everyone starts on a folding chair at a white table, the chair upgrades at levels 3, 5, 7, 9, 12
and 15, and the desk at 4 and 9. The office also keeps local time. Dusk warms the room, night
turns it blue and lights every occupied monitor, red where someone is stuck. `?hour=19.5` (or
`?hour=19:30`) pins the clock for screenshots and recordings.

The gear in the roster header opens the office settings, saved in the browser: follow the day or
pin the light to an hour, furniture by rank, agents wandering when idle, name tags on hover or
always, sound with separate music and effects levels, browser notifications when an agent needs
you, the "while you were away" recap, and a low-power mode that halves the frame rate. The
revenue settings are reachable from there too.

Sales rows with more to say fold open: a cancellation shows why the customer left, in Stripe's
terms and in their own words when they left any in the Customer Portal, the plan, and when access
ends, with a link into the Stripe record. Every Stripe row links to its payment, dispute, invoice
or subscription. The bridge also reports a cancellation the moment the customer asks for it
(`customer.subscription.updated` with `cancel_at_period_end`), not only when the period runs out,
and a cancellation that came with a reason is kept in the journal.

The studio controls sit at the bottom of the office. You can also click a project's floor label
or whiteboard, the filing cabinet, or the trophy shelf:

- **Whiteboards:** choose a project, customize its name, marker color, and team notes, then add milestones with
  checklists, contributors, optional due dates, and real artifact links. Milestones can be edited, reordered,
  completed, reopened, and removed. Completed milestones appear in the journal and on the trophy shelf.
- **Employees:** edit names and biographies, choose from 36 portraits and 26 outfits, and pin favorites. Open an
  agent's **Employee profile** from its conversation window to find its career. Session ids carry careers to new
  panes. For a new session, use **Continue this career with another agent** to select its existing employee record;
  other careers remain saved. When no session id is available, identity falls back to pane, agent type, name, and
  project. Old browser progression imports once into the matching active careers.
- **Journal / Trophies:** filter or search completed work, record your own notes and releases, edit memories,
  and attach links to actual artifacts. The non-blocking **While you were away** recap uses this browser's last
  visit time. Work keeps being recorded while the bridge is running, even with no browser connected. It cannot
  reconstruct work from before tracking began or unobserved work cycles while the bridge was stopped.
  Leaving a tab, closing it, and returning through browser history preserve when you actually left.
  RevenueCat webhook purchases/refunds are saved to the journal even with the page closed. The private
  event log survives restarts and deduplicates retries by event id. Tracking starts when the integration
  is connected; it does not backfill payments from before then.
- **Room:** drag furnishings, add pieces from the catalog, or select a furnishing and use the directional buttons.
  Drag one project's floor label onto another to swap areas, or use the project order controls. **Save layout**
  commits the draft; **Cancel** restores the saved room. Occupied/out-of-room drops snap back. As the team changes,
  furnishings move to the nearest available spot when a desk needs their old space. One whiteboard per active
  project, one cabinet, and one trophy shelf remain available. **Fit office** frames the room.
- **Re-org:** review idle/done agents grouped by workspace, using a 15-minute, 1-hour (default), 4-hour,
  or 1-day cutoff. Review their last prompt, recorded findings, artifact references, and session ID;
  choose **Save recaps only** or **Save recaps & close**. Recaps are durable Journal notes titled
  “Re-org” and do not add career points. The review names workspaces that would close with their last
  pane. Other terminal panes keep a workspace open. Before each close, the bridge rechecks the
  session, status, recorded activity, terminal focus, and native Codex or bridge-managed pending prompts.
  Failed saves prevent closing. Agents that changed since review remain open.
  Inactivity is retained in `sweep.sqlite` beside the studio database; the first observation uses
  the saved conversation's modification time when available, or starts a new clock otherwise.
  Recaps use recorded replies and mentioned links/paths, not a fresh model request. Run
  `npm run test:sweep` for isolated cleanup tests; the captured demo has no Re-org action. Confirmed
  closures open a game-style cutscene: the selected agents walk past reception, wave, and leave
  through the exit using their actual office sprites. The window counts each departure, supports
  skipping and reduced motion, then returns to the saved results. The office keeps your view.

The host stores careers, goals, journal entries, and room layouts in a SQLite database,
`~/.local/state/herdr-story/studio.sqlite` (owner-only permissions, WAL mode, one row per employee, project and
journal entry, so a change writes only what it touched), alongside the existing prompt queue. The first start
after upgrading converts an older `studio.json` and leaves it beside the database as `studio.json.migrated`.
`HERDR_STORY_STATE_DIR` changes this location. Back up that directory to preserve the studio. Browser tabs and
devices connected to this bridge share the same studio. Read-only bridges allow viewing but reject studio edits.
Conflicting edits to the same item are rejected instead of silently overwriting another window's changes.

The recap's USD estimate sums recorded payments minus refunds/adjustments within the selected period and filters.
Trials and other non-payment billing events do not add money. SQLite maintains indexed amount/currency columns
alongside the journal JSON and sums them directly, including entries beyond the displayed page. Foreign currency
totals are converted with the latest available Frankfurter USD reference rates (not payment-day settlement rates
or processor fees). The card shows the rate date. Rates refresh after six hours and are saved in `recap-rates.json`
in the state directory; dated cached rates can be used for up to seven days during an outage. The browser retains
the previous total for each filter while refreshing it, so unrelated agent updates do not blank the amount.

Mock mode uses temporary in-memory studio state unless `HERDR_STORY_STATE_DIR` is explicitly set;
`HERDR_STORY_MOCK_STATIC=1` disables random mock activity for repeatable checks.

The optional Kairosoft artwork and audio under `assets/raw` and `public/assets/gds` are copyrighted and git-ignored: not covered by this repository’s license.


Agent windows show their cached or visible terminal screen first; longer history loads afterward.
The selected conversation receives shared WebSocket output updates. Hovering a desk or roster entry
preloads its screen, and background tabs suspend subscriptions. The bridge coalesces reads across tabs,
reserves capacity for interactive reads, and publishes status independently of transcript enrichment.
Transcripts process appended records, with replacement/truncation detection.
Successful-read heartbeats keep quiet conversations fresh without duplicate fallback requests.
Unchanged idle screens back off from 800 ms to 5 seconds; commands and status changes wake them
immediately, while working agents poll every 250 ms. Terminal updates reuse unchanged lines and
coalesce within a frame, retaining links, text selection, and reading position.
Scrolling upward loads earlier output when the live screen has no more rows. Live updates stay
buffered while reading; **Back to live output** resumes them, as does sending a new prompt.

Recent conversations retain drafts, attachments, and reading position in this tab. Images upload as
soon as they are attached and reuse successful uploads. The fixed composer remains usable while earlier
messages are sending. Receipts distinguish sending, accepted, working, and unconfirmed delivery;
**Check delivery** reconciles an interrupted send. Client requests have deadlines and never automatically
replay writes. Durable message receipts prevent duplicate retries across bridge restarts (confirmed
receipts are retained for 24 hours, up to 500; unconfirmed receipts remain protected).

Chat connects before Phaser downloads. The canvas sleeps behind modal windows and in hidden tabs,
then resumes with current agent state. Only the active theme and needed character art load initially;
room graphics are cached, furniture updates individually, and roster rows retain their DOM nodes.
Quiet offices render at 30 FPS and interactions temporarily raise the budget to 60 FPS. Status lights
animate opacity, with obscured office animations paused while chat feedback remains active.
The bridge sends changed agents and studio entries; initial journal downloads contain the newest 100
memories, with older pages and searches fetched on demand. Studio writes are serialized and acknowledged
after a SQLite transaction commits in a background worker. Each commit transfers only changed records;
journal pagination and search use SQL, and history counts update incrementally. A failed save keeps
the last committed studio visible and retains history enrichment work for retry. Save replies use patches
when the browser has the matching revision. Unrelated studio edits have independent browser queues;
related milestones stay ordered. Tabs retain their contents, and journal filtering reuses unchanged
rows, portraits, and rendered Markdown.

Unfinished studio forms and arrangements are kept on the current device. Use **Drafts** to resume
them after a refresh; **Cancel** discards them. Archive and furniture removal offer **Undo**.
Slow saves show a status message. If a reply is lost, **Check saves** asks the bridge whether the
edit committed; **Retry saved edits** checks first and reuses the same durable save ID. Receipts
survive bridge restarts, and expired receipts are rejected rather than creating duplicate work.
Run `node scripts/studio-interactions-smoke.mjs` after building to check these recovery flows.

Run `npm run test:conversation`, `npm run test:performance`, and `npm run test:journal` for isolated
mock browser checks. `window.herdrPerformance()` returns the latest 120 interaction timings, including
RPC durations and time to the selected agent's first pushed screen, without prompts or terminal content.

## Demo and recording

Open `/?demo=1` for the fictional read-only sample in `public/demo/office.json`. No live
agents or payment account are contacted. Activity is simulated. `?live=0` freezes the desks,
and `?seed=N` makes the simulation repeatable. Without artwork, the sample uses the roster view.

`npm run demo:sample` regenerates this public fixture without reading any private state.
`npm run demo:export` is different: it reads a running bridge and saves actual studio history,
terminal output, and revenue to ignored `captures/office.json`. The optional curation in
`scripts/demo-curation.json` is cosmetic, not anonymization. Keep personal overrides in captures/.
Do not copy a live capture into public/. Home-path shortening does not remove sensitive content.

`npm run demo:record` saves recordings to ignored `recordings/`. Recordings of the full office
may contain proprietary artwork; do not redistribute them without the necessary permissions.

## RevenueCat payment notifications

RevenueCat sends purchases, renewals, trials, cancellations, refunds, billing issues and expirations to a
**separate webhook-only listener**. Paid purchases use the existing Sales feed, reception coins and celebration.
The event log (`revenuecat-events.sqlite` in the bridge state directory) saves provider metadata before acknowledging
HTTP 200. The shared feed excludes customer identities and attributes. Customer details supplied by
new RevenueCat notifications are committed atomically with the event in a private `detail` column
in `revenuecat-events.sqlite`, before returning HTTP 200. The separate `payment-details.sqlite`
index can be rebuilt from these receipts. Details load only when a payment is opened. Failed journal writes retry from the durable outbox;
restarts restore recent notifications without replaying old celebrations. Test/sandbox events are acknowledged
but never shown as sales. RevenueCat events for `store=STRIPE` are ignored when Stripe is connected to avoid duplicates.

1. Prepare the receiver, substituting your public HTTPS host:
   ```sh
   bun scripts/setup-revenuecat-webhook.ts --url https://your-public-host/webhooks/revenuecat
   npm run bridge
   ```
   The script creates a random authorization header in owner-only `.env` and defaults to `127.0.0.1:7789`.
   Restart an already-running bridge to load it. The game remains on `127.0.0.1:7788`.
2. Proxy **only port 7789** through your HTTPS ingress. With Tailscale, keep private Serve on port 443 and
   use a separate Funnel port for webhooks:
   ```sh
   tailscale funnel --bg --https=8443 http://127.0.0.1:7789
   ```
   In this case use `https://YOUR-HOST.YOUR-TAILNET.ts.net:8443/webhooks/revenuecat` in step 1.
   Never point Funnel at the game port: the game has terminal controls. The webhook listener returns 404
   for all other routes, including `/api/call`, `/api/state`, `/ws` and `/`.
3. In the game, open **Revenue settings → Manage payment sources → RevenueCat**, then press
   **Connect notifications in RevenueCat**. The API key needs **Integrations → Read & Write**
   (`project_configuration:integrations:read_write`) for this configuration step. Connection takes effect immediately.
   You can also register from the command line:
   ```sh
   bun scripts/setup-revenuecat-webhook.ts --register
   ```
   This creates **herdr-story payments** alongside existing integrations. Re-running updates only a configuration
   with that exact name and URL. Restart the bridge to load its integration id and any returned signing secret.
   Alternatively, add it in **RevenueCat → Integrations → Webhooks**, choose **Production**, and copy the URL
   and authorization header from **Revenue settings → Connect payments → RevenueCat → Payment notifications**.
4. Send a dashboard test event. The settings panel shows when it arrived. Genuine production payments then
   appear automatically; no browser needs to remain open to record them.

Authorization is required. Optional HMAC checks verify `X-RevenueCat-Webhook-Signature` against the raw body,
with a five-minute timestamp tolerance. When both are configured, both must pass. Keep the receiver online;
RevenueCat retries failed deliveries, and failed events can also be resent from its dashboard. The webhook log
is a notification history, not a complete subscription state database or a replacement for RevenueCat's metrics API.
Gross amounts use the purchased currency (or explicit USD fallback), without subtracting estimated taxes/store fees.
The HUD refreshes the selected API total rather than adding unrelated currencies or late events into it.

Reference: [RevenueCat webhooks](https://www.revenuecat.com/docs/integrations/webhooks),
[event fields](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields),
[integration API](https://www.revenuecat.com/docs/api-v2/integration).

Payment rows in **Sales** and the **Journal** open a detail window for Stripe or RevenueCat.
It shows customer name, email, phone and ID when supplied, plus product, store, transaction,
cancellation and timing information. Details are kept out of studio snapshots and demo exports.
Older RevenueCat notifications cannot recover customer fields discarded before this feature.
Stripe customer refresh needs **Customers → Read**; RevenueCat customer refresh needs
**Customer information → Customers → Read**. Saved event details remain available without those scopes.

All supported RevenueCat lifecycle notifications, including trials, billing issues, resumptions,
and cancellations/expirations without a reason, are retained in the studio journal. Lifecycle
entries carry no revenue amount. A one-time upgrade queues previously excluded stored notifications
for journal recovery without replaying celebrations or restoring subsequently deleted entries.
