# Office replay

Open **↶ Replay** in the roster header, or visit `/?replay=1` on your local office.
Choose the past hour, 24 hours, seven days, or a custom range of up to seven days.
Press **Play** to watch and start the office music. **Music on / Sound off** controls sound. **Whole office** fits every desk on screen. **Pause**, speed controls, the time slider, and the highlight
list let you explore individual moments. Returning to the live office ends replay.

The activity strip marks payments in gold and other highlights in blue; taller marks
mean more nearby activity. Click a marker or use **Previous/next highlight** to jump.
The running net-payment and finished-task totals rewind when you seek. Refunds and
disputes reduce net payments; failed invoices and trials do not count as earnings.
Amounts without a reference conversion stay explicitly labelled. At the end, the viewer
shows payments, tasks, releases and milestones for the selected period.

Routine agent changes share a continuous time-lapse; they do not each stop the clock.
Quiet stretches take at most 1.2 seconds. Gaps containing recorded work get up to
4.5 seconds so the team has time to visibly work, while selected highlights get readable holds.
During fast-forward, office motion accelerates to 6× at normal playback speed (capped
at 8×, or 3× in low-power mode). Highlights return to the selected playback speed.
Reduced-motion settings suppress the extra animation acceleration; unknown history is
not shown as invented work.
**Everything** shows every saved highlight. **Daily highlights** chooses up to twelve
moments across the day, favouring payments, launches and milestones. **Payments only**
skips other celebration windows. These modes keep the full underlying history for
seeking and totals. A **Project** selection limits the recorded cast, highlights and
totals to that project; unassigned payments stay under **Unassigned**.

Each payment gets a consistent customer face and outfit from the existing sprite sets.
The customer walks in, hands over their coin at reception, and then the payment
card and running total update together. Pause freezes their arrival; seeking, changing
filters or loading another period cancels it. Clicking a highlight previews its settled
state immediately. Reduced-motion and roster-only views show payments immediately.

Net payments combine into USD using the bridge's cached reference exchange rates.
Converted totals have an ≈ prefix and a tooltip with the rate date; they are estimates,
not historical settlement amounts. If a currency cannot be converted, it remains
explicitly labelled alongside the USD total. Refunds and disputes reduce net payments;
failed invoices and trials do not contribute.

**Auto camera** focuses on task contributors and the payment counter above the
celebration card, then returns to the whole office during long quiet gaps. Turn it off
to choose your own view; **Whole office** also disables automatic direction. Hatched
portions of the activity strip precede detailed office recording and use reconstructed
context. Music stays at its natural tempo; playback speed drives the scene clocks.
Switching away from the tab pauses playback.

## What is recorded

The bridge saves changes to agent identity, project, status, task title, model,
and rate-limit notice, plus room/profile snapshots and original office/billing events, in `replay.sqlite` under the existing state directory
(default `~/.local/state/herdr-story`). Unchanged polling results do not create
new events. History survives restarts. Changes are kept for 14 days, plus the
last baseline needed to reconstruct each retained agent. Cleanup runs hourly
while agents are polled. The file is local and private, like the studio database.

Tasks, milestones, releases, notes, and Stripe/RevenueCat payment events come from
the existing saved journal. Archived/read entries remain available. Deleting an
journal entry removes its narrative from future replays; original recorded payment events remain. Editing an entry changes its replayed text.
Payment amounts use their saved currencies and event timestamps. Revenue charts
and subscriber-count changes are not treated as individual cash payments.

Agent states mean **last observed state**, not continuous recording. Bridge outages
and periods before this version have no detailed agent activity. Before recording
began, completed tasks can show their contributors at reconstructed desks; the
viewer labels this coverage. Older periods retain the full current office as context, with unknown agent states clearly labelled. Recording now also retains room layouts, profiles, career totals, and milestone progress; those snapshots are restored for covered periods. The clock drives historical daylight. Terminal output and prompts with attachments are not recorded. This is a replay of recorded state and events, not a screen recording: walking paths, random animation frames, and music phase are recreated.

## Isolation and limits

The viewer makes a read-only `studio.replay` request when loading a period, plus
`money.rates` when foreign currencies need conversion. Filters run locally.
Playback and seeking run in memory, without a live agent connection. They do not
send prompts, alter payment records, mark journals read, or update visit/recap state.
A range with over 10,000 moments is rejected with a request to choose a shorter
period instead of silently dropping events. The highlight list shows its first
200 entries; playback includes all loaded moments. The roster viewer works without
the optional office artwork.

After upgrading, restart the bridge to enable recording and the replay endpoint.
Existing saved journal history is available immediately.

Run `npm run test:replay` for persistence, timeline, and isolated browser checks.
On the shared VPS, run that command through `vps-job`.

Startup shows artwork download progress. Slow downloads can continue past 15 seconds;
only 60 seconds without loader progress in a visible tab triggers the artwork fallback.
If artwork stalls, recorded history remains available in the roster view. **Load replay**
retries the office without a page refresh, and abandoned scenes are disposed before retry.

History and artwork metadata start loading together. For periods with saved layouts,
only decor assets referenced by those layouts are downloaded; procedural rooms keep
the complete catalogue so their layout remains consistent. Celebration backdrops and
additional outfits continue to load on demand.
