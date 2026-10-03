import { replayAnimationRate } from './replay-motion';
import { billingLabel } from '../shared/billing';
import { isPayment, projectReplay, replayHighlights, replayUSD, type ReplayWatch } from './replay-selection';
import { gameCurrency, type Rates } from './currency';
import { ReplayTimeline, replayTotals } from './replay-timeline';
import type { ReplayData, ReplayMoment } from '../shared/replay';
import { replayMoney, replayRange } from '../shared/replay';
import { OfficeModel } from './model/office';
import { Feed } from './feed/feed';
import { setOfficeLooks } from './sprites';
import { hasOfficeArt } from './roster-only';
import { seedFrom, type Prop } from './decor';
import { activeTheme } from './themes';
import { bootSucceeded, type Loading } from './loading';
import { employeeName, projectName } from '../shared/studio';
import type { OfficeScene } from './scenes/OfficeScene';
import './replay.css';
import { audio } from './audio';
import { settings } from './settings';
import { ReplayPresentation } from './replay-presentation';

const stamp = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const localInput = (at: number) => { const d = new Date(at); return new Date(at - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
function describe(moment: ReplayMoment) {
  if (moment.kind === 'agent') return moment.agent
    ? `${employeeName(moment.agent)} · ${moment.agent.wait_notice ? 'waiting: ' + moment.agent.wait_notice.detail : moment.agent.agent_status}\n${moment.agent.title || ''}`
    : 'An agent left the office';
  if (moment.kind === 'studio') return 'Office layout and profiles updated';
  if (moment.kind === 'event') return `${moment.event.agent} · ${moment.event.status}\n${moment.event.title}`;
  if (moment.kind === 'money') {
    const event = moment.event;
    const detail = moment.entry?.notes || [event.detail?.reason, event.detail?.plan ? `Plan: ${event.detail.plan}` : ''].filter(Boolean).join('\n');
    return `${event.label}${isPayment(moment) ? ` · ${event.amount} ${event.currency.toUpperCase()}` : ''}\n${event.source === 'revenuecat' ? 'RevenueCat' : 'Stripe'} · ${moment.entry?.project ? projectName(moment.entry.project) : 'Unassigned project'}${detail ? '\n' + detail : ''}`;
  }
  const entry = moment.entry;
  let amount = '';
  if (entry.kind === 'sale' && entry.amount) {
    try { amount = new Intl.NumberFormat(undefined, { style: 'currency', currency: entry.currency || 'usd' }).format(entry.amount) + ' · '; } catch {}
  }
  return `${amount}${entry.title}${entry.kind === 'sale' ? `\n${entry.source === 'revenuecat' ? 'RevenueCat' : 'Stripe'} · ${entry.project ? projectName(entry.project) : 'Unassigned project'}` : ''}${entry.notes ? '\n' + entry.notes : ''}`;
}

/** Dedicated viewer: no live socket, agent client, visit tracking, or mutation endpoints. */
export async function openReplay(loading: Loading) {
  document.body.classList.add('replay-mode');
  document.title = 'herdr story · replay';
  const controls = document.createElement('section'); controls.id = 'replay-controls'; controls.setAttribute('aria-label', 'Office replay');
  controls.innerHTML = `<div class="replay-row"><h1>↶ Office replay</h1><details id="replay-options" open><summary>Playback options</summary><div class="replay-options-body"><button id="replay-sound" type="button">Music on</button><button id="replay-fit" type="button">Whole office</button><button id="replay-camera" type="button" aria-pressed="true">Auto camera on</button>
    <label>Period <select id="replay-range"><option value="1">Past hour</option><option value="24" selected>Past 24 hours</option><option value="168">Past 7 days</option><option value="custom">Custom</option></select></label>
    <label id="replay-from-label" hidden>From <input id="replay-from" type="datetime-local"></label>
    <label id="replay-to-label" hidden>To <input id="replay-to" type="datetime-local"></label>
    <label>Watch <select id="replay-watch"><option value="all">Everything</option><option value="highlights">Daily highlights</option><option value="payments">Payments only</option></select></label><label>Project <select id="replay-project"><option value="*">All projects</option></select></label><button id="replay-load" type="button">Load replay</button></div></details><a href="/">Back to live ↗</a></div>
    <div class="replay-row"><button id="replay-play" type="button" disabled>▶ Play</button><button id="replay-restart" type="button" disabled aria-label="Restart replay">↶</button>
    <button id="replay-prev" type="button" disabled aria-label="Previous highlight">◀│</button><button id="replay-next" type="button" disabled aria-label="Next highlight">│▶</button><time id="replay-clock">Loading history…</time><input id="replay-seek" type="range" min="0" max="1000" value="0" disabled aria-label="Replay time">
    <label>Speed <select id="replay-speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label></div>
    <div id="replay-film" aria-label="Activity timeline"><div id="replay-unknown" title="Detailed office recording unavailable"></div><div id="replay-markers"></div><i id="replay-playhead" aria-hidden="true"></i></div>
    <div id="replay-score"><span id="replay-phase">Ready to replay</span><span>Net payments <b id="replay-earned">$0.00</b></span><span><b id="replay-shipped">0</b> tasks finished</span><span id="replay-length"></span></div>
    <p id="replay-coverage">Read-only · current room layout · quiet stretches fast-forward automatically.</p><p id="replay-error" role="alert" hidden></p>`;
  document.body.prepend(controls);
  const compact = matchMedia('(max-width:700px)');
  const syncOptions = () => { (document.getElementById('replay-options') as HTMLDetailsElement).open = !compact.matches; };
  syncOptions(); compact.addEventListener('change', syncOptions);
  const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const range = node<HTMLSelectElement>('replay-range'), fromInput = node<HTMLInputElement>('replay-from'), toInput = node<HTMLInputElement>('replay-to');
  const play = node<HTMLButtonElement>('replay-play'), restart = node<HTMLButtonElement>('replay-restart'), seek = node<HTMLInputElement>('replay-seek');
  const watch = node<HTMLSelectElement>('replay-watch'), project = node<HTMLSelectElement>('replay-project');
  let sourceData: ReplayData | undefined, rates: Rates = { rates: {} };
  const speed = node<HTMLSelectElement>('replay-speed'), load = node<HTMLButtonElement>('replay-load');
  const error = node<HTMLElement>('replay-error'), clock = node<HTMLElement>('replay-clock'), coverage = node<HTMLElement>('replay-coverage');
  fromInput.value = localInput(Date.now() - 86400_000); toInput.value = localInput(Date.now());
  range.onchange = () => { node('replay-from-label').hidden = node('replay-to-label').hidden = range.value !== 'custom'; };
  const eventCard = document.createElement('section'); eventCard.id = 'replay-event';
  eventCard.innerHTML = '<strong>RECORDED ACTIVITY</strong><p>Choose a period to explore.</p>';
  document.querySelector('.feed-head')!.after(eventCard);
  const activity = document.createElement('section'); activity.id = 'replay-activity'; activity.setAttribute('aria-label', 'Replay highlights');
  document.getElementById('feed')!.append(activity);
  const model = new OfficeModel(), feed = new Feed();
  feed.unknownLabel = 'Unrecorded';
  document.querySelector('.feed-title small')!.textContent = 'replay roster';
  let office: OfficeScene | undefined, timeline: ReplayTimeline | undefined;
  const presentation = new ReplayPresentation(() => office?.sys?.isActive() ? office : undefined, model);
  audio.setMuted(!settings.value.sound); audio.setLevels(settings.value.music, settings.value.effects);
  const sound = node<HTMLButtonElement>('replay-sound');
  const paintSound = () => { sound.textContent = audio.muted ? 'Sound off' : 'Music on'; sound.setAttribute('aria-pressed', String(!audio.muted)); };
  paintSound();
  sound.onclick = () => { audio.setMuted(!audio.muted); settings.set({ sound: !audio.muted }); audio.unlock(); paintSound(); };
  const camera = node<HTMLButtonElement>('replay-camera');
  const paintCamera = () => { camera.textContent = presentation.autoCamera ? 'Auto camera on' : 'Auto camera off'; camera.setAttribute('aria-pressed', String(presentation.autoCamera)); };
  camera.onclick = () => { presentation.autoCamera = !presentation.autoCamera; paintCamera(); };
  node<HTMLButtonElement>('replay-fit').onclick = () => { presentation.autoCamera = false; paintCamera(); office?.fitOffice(); refreshFrame(); };
  let wall = 0, playing = false, rendered = '', lastFrame = 0, sceneRate = 1;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const setPlaying = (value: boolean) => { playing = value; lastFrame = 0; document.body.classList.toggle('replay-paused', !value); office?.setPresentationPaused(!value || document.hidden); play.textContent = value ? 'Ⅱ Pause' : '▶ Play'; play.setAttribute('aria-pressed', String(value)); };
  const message = (text: string, title = 'RECORDED ACTIVITY') => { eventCard.querySelector('strong')!.textContent = title; eventCard.querySelector('p')!.textContent = text; };
  feed.onSelect = pane => { const agent = model.agents.get(pane); if (agent) { office?.frameReplay(pane); refreshFrame(); message(`${employeeName(agent)} · ${agent.agent_status}\n${agent.title || 'No recorded task title.'}`, 'RECORDED DESK · TERMINAL OUTPUT IS NOT RECORDED'); } };
  const previous = node<HTMLButtonElement>('replay-prev'), next = node<HTMLButtonElement>('replay-next');
  let highlights: ReplayMoment[] = [];
  function refreshFrame() {
    if (!office?.sys?.isActive() || !sceneReady) return;
    office.setPresentationPaused(false);
    office.game.events.once('postrender', () => office?.setPresentationPaused(!playing || document.hidden));
  }
  function formatTotals(at: number) {
    if (!timeline) return '';
    const pending = new Set(presentation.pendingPayments);
    if (playing) for (const m of highlights) if ((timeline.wallFor(m.id) ?? 0) > wall) pending.add(m.id);
    const total = replayTotals(timeline.data, at, pending);
    const usd = replayUSD(total.currencies, rates.rates);
    const native = usd.missing.map(currency => `${total.currencies[currency].toFixed(2)} ${currency} unconverted`);
    const money = `${usd.estimated ? '≈' : ''}${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', currencyDisplay: 'code' }).format(usd.amount)}${native.length ? ' + ' + native.join(' + ') : ''}`;
    node('replay-earned').title = usd.estimated ? `Reference-rate estimate${rates.date ? ' · rates from ' + rates.date : ''}; not settlement FX` : '';
    node('replay-earned').textContent = money;
    node('replay-shipped').textContent = String(total.tasks);
    return `${money} net payments · ${total.payments} payments · ${total.tasks} tasks finished · ${total.releases} releases · ${total.milestones} milestones`;
  }
  presentation.onPaid = () => { if (timeline) formatTotals(timeline.position(wall).at); };
  function render(pulse = false, preview = false) {
    if (!timeline) return;
    const position = timeline.position(wall);
    applySpeed();
    clock.textContent = stamp(position.at); seek.value = String(position.at);
    node('replay-playhead').style.left = `${100 * (position.at - timeline.data.from) / (timeline.data.to - timeline.data.from)}%`;
    previous.disabled = !highlights.some(m => (timeline!.wallFor(m.id) ?? 0) < wall - 1);
    next.disabled = !highlights.some(m => (timeline!.wallFor(m.id) ?? 0) > wall + 1);
    node('replay-phase').textContent = wall >= timeline.duration ? 'Day complete' : !playing ? 'Paused · explore the day' : presentation.pendingPayments.size ? 'Customer arriving…' : position.segment?.moment ? 'Watching activity' : `» ${position.segment?.activeWork ? 'Work time-lapse' : 'Fast-forward'} · ${sceneRate}× motion`;
    const historicalTime = new Date(position.at);
    if (office?.sys?.isActive()) office.setHour(historicalTime.getHours() + historicalTime.getMinutes() / 60);
    seek.setAttribute('aria-valuetext', stamp(position.at));
    const segmentChanged = rendered.split(':')[0] !== String(position.index);
    const key = `${position.index}:${position.stateIndex}`;
    if (rendered === key) return;
    rendered = key;
    const totals = () => formatTotals(position.at);
    const snapshot = timeline.snapshotAt(position.at);
    // Agent outfits can first appear later in a recording; preload the whole cast below.
    model.setStudio(snapshot.studio); model.setAgents(snapshot.agents); feed.summary(snapshot.agents);
    const moment = position.segment?.moment;
    if (moment) {
      eventCard.classList.toggle('subscription', !isPayment(moment) && (moment.kind === 'money' || (moment.kind === 'journal' && moment.entry.kind === 'sale')));
      message(describe(moment), `${stamp(moment.at)} · ${moment.kind === 'money' ? billingLabel(moment.event.kind).toUpperCase() : moment.kind === 'journal' && moment.entry.kind === 'sale' ? billingLabel(replayMoney(moment.entry)!.kind).toUpperCase() : moment.kind === 'journal' ? moment.entry.kind.toUpperCase() : moment.kind.toUpperCase()}`);
      if (pulse && segmentChanged) presentation.show(moment, preview);
      totals();
    } else {
      eventCard.classList.remove('subscription');
      if (pulse && segmentChanged && presentation.autoCamera && (position.segment?.to ?? 0) - (position.segment?.from ?? 0) > 60000) office?.fitOffice();
      message(timeline.data.moments.length ? (wall >= timeline.duration ? totals() : position.segment?.activeWork ? 'The team is working · fast-forwarding recorded activity…' : 'Fast-forwarding a quiet stretch…')
        : 'No saved activity in this period. Try a wider time range.', wall >= timeline.duration ? 'YOUR DAY, REPLAYED' : 'OFFICE REPLAY');
      totals();
    }
  }
  const jump = (at: number, preview = false, id?: string) => { if (!timeline) return; setPlaying(false); presentation.reset(); wall = (id ? timeline.wallFor(id) : undefined) ?? timeline.wallAt(at); rendered = ''; render(preview, preview); refreshFrame(); };
  previous.onclick = () => { const moment = [...highlights].reverse().find(m => (timeline?.wallFor(m.id) ?? 0) < wall - 1); if (moment) jump(moment.at, true, moment.id); };
  next.onclick = () => { const moment = highlights.find(m => (timeline?.wallFor(m.id) ?? 0) > wall + 1); if (moment) jump(moment.at, true, moment.id); };
  seek.oninput = () => jump(Number(seek.value));
  restart.onclick = () => { if (timeline) jump(timeline.data.from); };
  play.onclick = () => { if (!timeline) return; audio.unlock(); if (wall >= timeline.duration) { wall = 0; rendered = ''; render(); } if (!playing && wall === 0 && !presentation.busy) { rendered = ''; render(true); } setPlaying(!playing); render(); };
  document.addEventListener('visibilitychange', () => {
    if (!sceneReady) return; // Loading must keep running even when playback starts paused.
    if (document.hidden) setPlaying(false);
    office?.setPresentationPaused(document.hidden || !playing);
  });
  let game: import('phaser').Game | undefined;
  let sceneReady = false;
  window.addEventListener('resize', () => {
    if (!office?.sys?.isActive() || !sceneReady) return;
    // Resizing a sleeping canvas clears it; render its new size before freezing again.
    requestAnimationFrame(() => { office?.fitOffice(); refreshFrame(); });
  });
  async function startOffice(Scene: new () => OfficeScene) {
    game!.loop.wake();
    const next = office = new Scene();
    sceneReady = false;
    next.theme = activeTheme(); next.fitOnCreate = true;
    if (sourceData) {
      const rooms = [sourceData.snapshot.studio.room, ...sourceData.moments.flatMap(m => m.kind === 'studio' ? [m.studio.room] : [])];
      if (rooms.every(room => room.items !== null)) next.replayPropAssets = new Set(rooms.flatMap(room => room.items!.flatMap(item => item.asset ? [item.asset] : [])));
    }
    loading.step('art', 'Loading the replay office…');
    loading.setNote('Downloading office artwork. Larger offices can take a little longer.');
    await new Promise<void>((resolve, reject) => {
      let timeout = 0, settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        next.load?.off('progress', progress);
        next.load?.off('filecomplete', heartbeat);
        next.load?.off('loaderror', heartbeat);
      };
      const fail = (cause: unknown) => {
        if (settled) return;
        settled = true; cleanup();
        // Do not let a late asset response create an abandoned scene after retry.
        game!.scene.stop('office'); game!.scene.remove('office');
        if (office === next) office = undefined;
        reject(cause);
      };
      const heartbeat = () => {
        clearTimeout(timeout);
        timeout = window.setTimeout(() => {
          // Background tabs may suspend Phaser and network scheduling.
          if (document.hidden) { heartbeat(); return; }
          fail(new Error('Office artwork stopped loading. You can still replay the history below; use Load replay to retry the office.'));
        }, 60_000);
      };
      const progress = (value: number) => {
        heartbeat();
        loading.setNote(`Loading office artwork · ${Math.round(value * 100)}%`);
      };
      const preload = next.preload.bind(next);
      next.preload = () => {
        next.load.on('progress', progress);
        next.load.on('filecomplete', heartbeat);
        next.load.on('loaderror', heartbeat);
        preload();
      };
      heartbeat();
      const create = next.create.bind(next);
      next.create = () => {
        if (settled) return;
        try {
          create();
          let sceneTime = next.time.now;
          const step = next.sys.step.bind(next.sys);
          next.sys.step = (_time, delta) => { const scaled = Math.min(100, delta) * sceneRate; sceneTime += scaled; step(sceneTime, scaled); };
          if (settled) return;
          sceneReady = true; settled = true; cleanup(); resolve();
        }
        catch (cause) { fail(cause); }
      };
      try {
        game!.scene.add('office', next, true, { model, props, seed: seedFrom(location.host + ':office'), onSelect: (a: { pane_id: string }) => feed.onSelect?.(a.pane_id) });
      } catch (cause) { fail(cause); }
    });
    document.body.classList.remove('roster-only');
    applySpeed(); refreshFrame();
  }
  function officeFallback(cause: unknown) {
    document.body.classList.add('roster-only'); sceneReady = true;
    error.textContent = (cause as Error).message; error.hidden = false;
  }
  function applySpeed() {
    if (!office || !sceneReady) return;
    const segment = timeline?.position(wall).segment;
    sceneRate = replayAnimationRate(Number(speed.value), !!segment && !segment.moment && !presentation.busy,
      settings.value.lowPower, reducedMotion.matches);
    // Phaser tweens have their own wall clock; timers, sprites and walkers use scaled scene time.
    office.tweens.timeScale = sceneRate;
    // Two-frame typing loops can look frozen when sampled at a low frame rate.
    if (playing && sceneRate > 1) office.renderBudget?.boost(250);
  }
  speed.onchange = applySpeed;
  function configureReplay(original: ReplayData) {
    const data = projectReplay(original, project.value);
      highlights = replayHighlights(data, watch.value as ReplayWatch);
      timeline = new ReplayTimeline(data, highlights, watch.value === 'highlights'); wall = 0; rendered = '';
      const cast = [...(data.contextAgents ?? []), ...data.snapshot.agents, ...data.moments.flatMap(m => m.kind === 'agent' && m.agent ? [m.agent] : [])];
      // Include employees with journal-only coverage so their outfits are ready on first appearance.
      for (const employee of data.snapshot.studio.employees) cast.push({ pane_id: `replay:${employee.id}`, agent: employee.kind, agent_status: 'idle', office_look: { face: employee.face, body: employee.body } });
      setOfficeLooks(cast);
      const exact = data.studioRecordedSince !== null && data.studioRecordedSince !== undefined && data.from >= data.studioRecordedSince;
      const coverageLabel = exact ? 'Recorded office, agent states and events' : 'Reconstructed history · full current office; older agent states/layout were not recorded';
      coverage.textContent = `${coverageLabel}. ${data.moments.length.toLocaleString()} moments · quiet time fast-forwards; payment and task markers jump to highlights. Hatched time has no detailed office recording.`;
      seek.min = String(data.from); seek.max = String(data.to); seek.step = '1000';
      activity.replaceChildren();

      node('replay-length').textContent = `About ${Math.max(1, Math.ceil(timeline.duration / 60000))} min at 1× · ${highlights.length} highlights`;
      const recordedFrom = Math.max(data.recordedSince ?? data.to, data.studioRecordedSince ?? data.to);
      node('replay-unknown').style.width = `${100 * Math.max(0, Math.min(1, (recordedFrom - data.from) / (data.to - data.from)))}%`;
      const markers = node('replay-markers'); markers.replaceChildren();
      // One target per time bucket keeps a busy week navigable without thousands of buttons.
      const buckets = new Map<number, ReplayMoment[]>();
      for (const moment of highlights) {
        const bin = Math.min(99, Math.floor(100 * (moment.at - data.from) / (data.to - data.from)));
        const list = buckets.get(bin) ?? []; list.push(moment); buckets.set(bin, list);
      }
      for (const [bin, moments] of buckets) {
        const moment = moments.find(isPayment) ?? moments[0];
        const marker = document.createElement('button'); marker.type = 'button';
        marker.className = isPayment(moment) ? 'payment' : moment.kind === 'money' || (moment.kind === 'journal' && moment.entry.kind === 'sale') ? 'subscription' : 'task';
        marker.style.left = `${bin}%`; marker.style.height = `${Math.min(28, 10 + moments.length * 3)}px`;
        marker.title = `${stamp(moment.at)} · ${describe(moment).split('\n')[0]}${moments.length > 1 ? ` · ${moments.length} highlights nearby` : ''}`;
        marker.setAttribute('aria-label', marker.title);
        marker.onclick = () => jump(moment.at, true, moment.id); markers.append(marker);
      }
      for (const moment of highlights.slice(0, 200)) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = `${stamp(moment.at)} · ${describe(moment).split('\n')[0]}`;
        button.onclick = () => { audio.unlock(); jump(moment.at, true, moment.id); }; activity.append(button);
      }
      if (highlights.length > 200) { const note = document.createElement('p'); note.textContent = 'First 200 highlights listed. Playback includes every moment.'; activity.append(note); }
      render();
  }
  const changeSelection = () => {
    if (!sourceData) return;
    setPlaying(false); presentation.reset(); configureReplay(sourceData); office?.fitOffice(); refreshFrame();
  };
  watch.onchange = project.onchange = changeSelection;
  async function fetchReplay() {
    setPlaying(false); presentation.reset(); load.disabled = watch.disabled = project.disabled = true; play.disabled = restart.disabled = seek.disabled = true; error.hidden = true;
    try {
      const to = range.value === 'custom' ? new Date(toInput.value).getTime() : Date.now();
      const from = range.value === 'custom' ? new Date(fromInput.value).getTime() : to - Number(range.value) * 3600_000;
      replayRange(from, to);
      const response = await fetch('/api/call', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'call', method: 'studio.replay', params: { from, to } }), signal: AbortSignal.timeout(20_000), cache: 'no-store' });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(body.error?.message || 'Could not load replay history.');
      const data = body.result as ReplayData;
      sourceData = data;
      if (data.moments.some(m => m.kind === 'money' ? m.event.currency.toLowerCase() !== 'usd' : m.kind === 'journal' && m.entry.currency && m.entry.currency.toLowerCase() !== 'usd')) {
        try {
          const response = await fetch('/api/call', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'call', method: 'money.rates', params: {} }), signal: AbortSignal.timeout(5000) });
          const body = await response.json();
          if (response.ok && body.result?.rates) { rates = body.result; await gameCurrency.loadRates(async () => rates); }
        } catch { /* Show explicitly unconverted amounts when rates are unavailable. */ }
      }
      const selectedProject = project.value;
      project.replaceChildren(new Option('All projects', '*'));
      const projects = new Set([...(data.contextAgents ?? []), ...data.snapshot.agents].map(a => a.cwd ?? ''));
      for (const moment of data.moments) {
        if (moment.kind === 'agent' && moment.agent) projects.add(moment.agent.cwd ?? '');
        if (moment.kind === 'journal' || moment.kind === 'money') projects.add(moment.entry?.project ?? '');
      }
      for (const path of [...projects].sort()) project.add(new Option(path ? projectName(path) : 'Unassigned', path));
      project.value = projects.has(selectedProject) ? selectedProject : '*';
      configureReplay(data);
      if (game) {
        // A new range may contain outfits absent from the previous scene's preload.
        // Phaser remove() destroys directly; stop() first runs shutdown cleanup.
        game.scene.stop('office');
        game.scene.remove('office');
        const { OfficeScene: Scene } = await import('./scenes/OfficeScene');
        try { await startOffice(Scene); } catch (cause) { officeFallback(cause); }
      }
    } catch (e) { timeline = undefined; message('Replay could not be loaded. Choose another period or retry.'); error.textContent = (e as Error).message; error.hidden = false; }
    finally { load.disabled = watch.disabled = project.disabled = false; play.disabled = restart.disabled = seek.disabled = !timeline || !sceneReady; }
  }
  let props: Prop[] = [];
  load.onclick = () => { void fetchReplay(); };
  // Fetch small art metadata alongside history, before the Phaser loader starts.
  const artReady = hasOfficeArt();
  const manifestsReady = Promise.allSettled(['/assets/gds/decor/manifest.json', '/assets/open/decor/manifest.json'].map(path => fetch(path, { signal: AbortSignal.timeout(2000) }).then(r => r.ok ? r.json() : [])));
  loading.step('bridge', 'Loading replay history…');
  await fetchReplay();
  load.disabled = true;
  if (await artReady) {
    const [{ default: Phaser }, { OfficeScene: Scene }] = await Promise.all([import('phaser'), import('./scenes/OfficeScene')]);
    const manifests = await manifestsReady;
    props = manifests.flatMap(r => r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []);
    game = new Phaser.Game({ type: Phaser.CANVAS, parent: 'game', pixelArt: true, roundPixels: true, backgroundColor: '#6ec6f2', scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: [] });
    try { await startOffice(Scene); }
    catch (cause) {
      // An art failure must not strand the user behind the startup screen.
      officeFallback(cause);
    }
  } else { document.body.classList.add('roster-only'); document.getElementById('game')?.remove(); sceneReady = true; }
  load.disabled = false;
  play.disabled = restart.disabled = seek.disabled = !timeline;
  function frame(now: number) {
    try {
      if (playing && timeline) {
        const delta = lastFrame ? Math.min(100, now - lastFrame) * Number(speed.value) : 0;
        presentation.advance(delta);
        // Celebrations use the same playback time, overlapping their highlight hold.
        // Only an unfinished scene at the boundary extends the hold.
        const edge = timeline.position(wall).segment?.end ?? timeline.duration;
        wall = Math.min(timeline.duration, presentation.busy ? edge - 0.01 : edge, wall + delta); render(true);
        if (wall >= timeline.duration) setPlaying(false);
      }
    } catch (cause) {
      setPlaying(false);
      error.textContent = `Playback stopped: ${(cause as Error).message}. Load the replay to try again.`;
      error.hidden = false;
    } finally {
      // Keep the controller alive so reloading can recover from a rendering failure.
      lastFrame = now; requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
  setPlaying(false); refreshFrame();
  loading.finish(model.agents.size); bootSucceeded();
  (window as any).__herdrReady = true;
}
