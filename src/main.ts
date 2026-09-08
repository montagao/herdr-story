import { PaymentWindow } from './payment-details';
import { hasOfficeArt, openRosterOnly } from './roster-only';
import { closeOnEscape } from './escape';
import type { AgentInfo, MoneyEvent, WorkspaceSummary } from '../shared/types';
import { agentKind } from '../shared/types';
import { projectKey } from '../shared/studio';
import { BridgeClient } from './net/client';
import type { OfficeClient } from './net/office-client';
import { OfficeModel } from './model/office';
import { Feed } from './feed/feed';
import { Dialog } from './dialog';
import { seedFrom, type Prop } from './decor';
import { audio } from './audio';
import { soundIcon, galleryIcon } from './icons';
import { THEMES, themeById } from './themes';
import { Hud } from './hud';
import { BillingSetup } from './billing-setup';
import { Celebrate } from './celebrate';
import { installEventDebugger } from './debug-events';
import { Studio } from './studio';
import { setOfficeLooks } from './sprites';
import { Loading } from './loading';
import { settings, SettingsDialog, gearIcon } from './settings';
import { BossCutscene } from './boss-cutscene';
import { Reception } from './reception';
import { OfficeCat } from './office-cat';
import { Cutscenes, actorOf, salesReport, awardsNight, launchDay, crunchTime, trainingSeminar, conventionDay, type Actor, type RankRow } from './cutscenes';
import { projectOf } from './model/office';
import { projectName, employeeName, type StudioState } from '../shared/studio';
import { taskOf } from '../shared/types';

let feed: Feed;
const loading = new Loading();
async function boot() {
  // Conversations connect before the canvas engine, optional artwork, and remote font finish.
  void document.fonts.load('16px "DotGothic16"').catch(() => {});
  const q = new URLSearchParams(location.search);
  const priorVisit = Reception.previousVisit();
  // Demo mode is this same office on a captured snapshot, with no bridge behind it.
  const demo = q.get('demo') === '1' ? await (await import('./demo')).loadDemo() : undefined;
  const lab = q.has('lab');
  const people = q.get('lab') === 'people';
  if (lab) loading.finish(0);   // the sprite labs are tools, not the office
  loading.step('art', 'Loading the office art');
  if (lab) document.body.classList.add('lab');   // debug pages get the whole window
  const model = new OfficeModel();
  const client: OfficeClient = demo?.client ?? new BridgeClient(BridgeClient.defaultUrl());
  feed = new Feed();
  const dialog = new Dialog(client);
  if (demo) dialog.readOnlyNote = 'this office is a snapshot · replies go nowhere in the demo';
  let workspaces: WorkspaceSummary[] = [];
  const loadingRoot = document.getElementById('loading');
  if (!lab && loadingRoot) { loadingRoot.style.position = 'absolute'; loadingRoot.style.zIndex = '7'; document.getElementById('game')?.append(loadingRoot); }
  feed.progressOf = pane => model.progressOf(pane);
  dialog.progressOf = feed.progressOf;
  feed.onSelect = pane => { const agent = model.agents.get(pane); if (agent) void dialog.open(agent); };
  feed.onPreview = pane => { const agent = model.agents.get(pane); if (agent) dialog.prefetch(agent); };
  const stopEarly = client.on(msg => {
    if (msg.type === 'snapshot' || msg.type === 'agents') {
      if (msg.type === 'snapshot') {
        dialog.writable = msg.writable;
        if (msg.studio) model.setStudio(msg.studio);
        dialog.syncQueues(msg.queues ?? [], msg.delivered_queue_ids ?? [], msg.bridge_started_at ?? Date.now(), msg.agents);
      }
      workspaces = msg.workspaces ?? workspaces;
      setOfficeLooks(msg.agents); model.setAgents(msg.agents); feed.summary(msg.agents); dialog.sync(msg.agents);
    } else if (msg.type === 'studio') model.setStudio(msg.studio);
    else if (msg.type === 'queue') dialog.queueUpdate(msg.item);
  });
  (window as any).hs = { model, client, dialog, feed };
  if (q.get('roster') === '1' || !(await hasOfficeArt())) {
    openRosterOnly(client, !!demo);
    return;
  }
  const [{ default: Phaser }, { OfficeScene }] = await Promise.all([import('phaser'), import('./scenes/OfficeScene')]);
  const party = new Celebrate();
  party.busy = () => !document.getElementById('dialog')!.hidden;
  const progressOf = (paneId: string) => model.progressOf(paneId);
  dialog.progressOf = progressOf;
  feed.progressOf = progressOf;
  party.progress = progressOf;
  party.entryOf = (id) => model.studio?.journal.find((e) => e.id === id);
  const office = new OfficeScene();
  const bossCutscene = new BossCutscene(client, office);
  bossCutscene.onChat = agent => { void dialog.open(agent); };
  const studio = lab ? undefined : new Studio(client, office, { sweep: !demo });
  let reception: Reception | undefined;
  let cat: OfficeCat | undefined;
  const payments = new PaymentWindow(client);
  if (studio) studio.onPayment = summary => { scenes.close(); void payments.open(summary); };
  feed.onPayment = event => { scenes.close(); void payments.open({ id: event.id, source: event.source, title: event.label, at: event.ts, amount: event.amount || undefined, currency: event.currency, url: event.detail?.url }); };
  party.onJournalEntry = id => { void studio?.openJournalEntry(id); };
  // Any overlay can opt into blocking the canvas. Querying the marker rather than naming current
  // windows also protects future dialogs without another Phaser-specific integration.
  const officeInputBlocked = () => [...document.querySelectorAll<HTMLElement>('[data-block-office-input]')]
    .some((node) => !node.hasAttribute('hidden'));
  office.canInteract = () => !officeInputBlocked();
  party.busy = () => !document.getElementById('dialog')!.hidden || bossCutscene.isOpen || !!studio?.isOpen || !!studio?.sweepOpen || !!reception?.isOpen || office.furnishings.editing;
  const hud = new Hud(demo ? { loadRevenue: demo.revenue, persistRange: false } : {});

  // ---- the event scenes: what the office cuts away to, and what earns each one ----
  const scenes = new Cutscenes(() => office.textures);
  if (studio) cat = new OfficeCat(client, {
    state: () => model.studio,
    beforeOpen: () => { dialog.close(); studio.close(); reception?.close(false); bossCutscene.close(); scenes.close(); payments.close(); },
    onPet: () => office.regulars?.pet(), onEntry: id => { void studio.openJournalEntry(id); },
  });
  const openJanitor = () => { cat?.close(false); bossCutscene.close(); payments.close(); studio?.openReorg(); };
  if (studio) reception = new Reception(client, {
    agents: () => [...model.agents.values()], state: () => model.studio, workspaces: () => workspaces,
    writable: () => dialog.writable, visit: priorVisit,
    beforeOpen: () => { dialog.close(); studio.close(); cat?.close(false); bossCutscene.close(); scenes.close(); payments.close(); },
    onCat: () => cat?.open(), onJanitor: demo ? undefined : openJanitor,
    onAgent: agent => { office.focus(agent.pane_id); void dialog.open(agent); },
    onProject: id => studio.open('boards', id), onEntry: id => { void studio.openJournalEntry(id); },
    onIdea: (briefing, index) => bossCutscene.openSaved(briefing, index),
    onTask: (agent, text) => dialog.prepareTask(agent, text),
    onHire: (task, project, workspace, onTaskSent) => dialog.openHire(workspaces, [...model.agents.values()], workspace, { task, project, newWorkspace: !project, onTaskSent }),
  });
  office.onReception = () => { if (office.canInteract()) { audio.unlock(); reception?.open(); } };
  office.onCat = () => { if (office.canInteract()) { audio.unlock(); cat?.open(); } };
  if (!demo) office.onJanitor = openJanitor;
  const baseBusy = party.busy;
  party.busy = () => baseBusy() || scenes.isOpen || payments.isOpen || !!cat?.isOpen;
  scenes.busy = () => payments.isOpen || !!cat?.isOpen || baseBusy() || !document.getElementById('party')!.hidden;
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const plain = (s: string) => s.replace(/\*\*|__|`|~~/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^[#>\-•\s]+/gm, '').replace(/\s+/g, ' ').trim();
  const clipTo = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;
  const actorForEmployee = (id: string): Actor | undefined => {
    const e = model.studio?.employees.find((x) => x.id === id);
    return e ? { name: e.name, look: { body: e.body, face: e.face } } : undefined;
  };
  const crewActor = (project: string) => { const a = [...model.agents.values()].find((x) => projectOf(x) === project && x.office_role !== 'boss'); return a ? actorOf(a) : undefined; };
  const anyAgent = () => [...model.agents.values()].find((a) => a.office_role !== 'boss');
  const colorOf = (id: string) => model.studio?.projects.find((p) => p.id === id)?.color ?? '#307c9b';
  const journalSince = (days: number) => (model.studio?.journal ?? []).filter((e) => e.at > Date.now() - days * 864e5);
  // Weekly report: the ranking board for the last seven days, then employee of the week.
  const weeklyReport = (label: string) => {
    const entries = journalSince(7);
    const sales = new Map<string, number>(), tasks = new Map<string, number>(), byEmployee = new Map<string, number>();
    for (const e of entries) {
      if (e.kind === 'sale' && (e.amount ?? 0) > 0) sales.set(e.project, (sales.get(e.project) ?? 0) + e.amount!);
      if (e.kind === 'task') { tasks.set(e.project, (tasks.get(e.project) ?? 0) + 1); for (const id of e.contributors) byEmployee.set(id, (byEmployee.get(id) ?? 0) + 1); }
    }
    const rows: RankRow[] = sales.size
      ? [...sales].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ name: projectName(id), value: money(n), color: colorOf(id) }))
      : [...tasks].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ name: projectName(id), value: `${n} shipped`, color: colorOf(id) }));
    scenes.play(salesReport(label, rows, sales.size ? 'sales' : 'shipments'));
    const [best] = [...byEmployee].sort((a, b) => b[1] - a[1]);
    const winner = best && actorForEmployee(best[0]);
    if (winner) scenes.play(awardsNight(winner, 'Employee of the week', `${best[1]} task${best[1] === 1 ? '' : 's'} shipped · ${label}`));
  };
  const WEEK_KEY = 'herdr-story:reported-week';
  hud.onWeek = (label, previous) => { weeklyReport(previous); try { localStorage.setItem(WEEK_KEY, label); } catch { /* private mode */ } };
  let weekChecked = false;
  // The first open in a new week gets last week's report, a little after the room settles.
  const checkWeek = () => {
    if (weekChecked || !hud.week) return;
    weekChecked = true;
    try {
      const seen = localStorage.getItem(WEEK_KEY);
      if (seen && seen !== hud.week) window.setTimeout(() => weeklyReport(seen), 5000);
      localStorage.setItem(WEEK_KEY, hud.week);
    } catch { /* private mode */ }
  };
  // Journal news: a trophy is an awards night, a release is launch day.
  let knownEntries: Set<string> | undefined;
  const noteJournal = (state?: StudioState) => {
    if (!state) return;
    if (!knownEntries) { knownEntries = new Set(state.journal.map((e) => e.id)); return; }
    for (const e of state.journal) {
      if (knownEntries.has(e.id)) continue;
      knownEntries.add(e.id);
      if (Date.now() - e.at > 6 * 3600e3) continue;   // history restored from disk, not news
      if (e.kind === 'milestone') {
        const winner = e.contributors.map(actorForEmployee).find(Boolean) ?? crewActor(e.project);
        if (winner) scenes.play(awardsNight(winner, clipTo(e.title, 40), `Trophy for ${projectName(e.project)}`));
      }
      if (e.kind === 'release') scenes.play(launchDay(`${projectName(e.project)} is out`, clipTo(e.title, 80), e.notes ? clipTo(plain(e.notes), 120) : undefined));
    }
  };
  // Best day at the till, judged against the best day before it.
  const DAY_KEY = 'herdr-story:daily-sales';
  const noteSale = (ev: MoneyEvent) => {
    if ((ev.kind !== 'sale' && ev.kind !== 'subscribed') || !(ev.amount > 0)) return;
    const day = new Date().toDateString();
    let s: { day: string; total: number; best: number; celebrated?: string } = { day, total: 0, best: 0 };
    try { s = { ...s, ...JSON.parse(localStorage.getItem(DAY_KEY) ?? '{}') }; } catch { /* fresh */ }
    if (s.day !== day) { s.best = Math.max(s.best, s.total); s.day = day; s.total = 0; }
    s.total += ev.amount;
    if (s.best > 0 && s.total > s.best && s.celebrated !== day) {
      s.celebrated = day;
      scenes.play(launchDay('Best day yet', `${money(s.total)} today, past the old record of ${money(s.best)}`));
    }
    try { localStorage.setItem(DAY_KEY, JSON.stringify(s)); } catch { /* private mode */ }
  };
  // Three projects shipping in one day is a convention day.
  const shippedToday = { day: '', crews: new Map<string, AgentInfo>(), done: false };
  const noteShip = (who: AgentInfo) => {
    const day = new Date().toDateString();
    if (shippedToday.day !== day) { shippedToday.day = day; shippedToday.crews.clear(); shippedToday.done = false; }
    shippedToday.crews.set(projectOf(who), who);
    if (shippedToday.done || shippedToday.crews.size < 3) return;
    shippedToday.done = true;
    scenes.play(conventionDay([...shippedToday.crews.values()].map(actorOf), [...shippedToday.crews.keys()].map(projectName)));
  };
  dialog.onSettingsApplied = (agent, field, value) => scenes.play(trainingSeminar(actorOf(agent), `${employeeName(agent)} goes to a seminar`, field === 'model' ? `Now running ${value}` : `Effort set to ${value}`));
  office.onCrunch = (agent, ms) => scenes.play(crunchTime(actorOf(agent), Math.round(ms / 60_000), clipTo(taskOf(agent), 90)));
  const sceneSamples = [
    { caption: 'Sales report', run: () => weeklyReport(hud.week || 'this week') },
    { caption: 'Awards', run: () => { const a = anyAgent(); if (a) scenes.play(awardsNight(actorOf(a), 'Employee of the week', 'Preview only')); } },
    { caption: 'Launch day', run: () => scenes.play(launchDay('Best day yet', '$420 today, past the old record of $180', 'Preview only')) },
    { caption: 'Crunch', run: () => { const a = anyAgent(); if (a) { scenes.play(crunchTime(actorOf(a), 42, 'Preview only')); office.previewCollapse(a.pane_id); } } },
    { caption: 'Training', run: () => { const a = anyAgent(); if (a) scenes.play(trainingSeminar(actorOf(a), `${employeeName(a)} goes to a seminar`, 'Preview only')); } },
    { caption: 'Convention', run: () => { const crew = [...model.agents.values()].filter((a) => a.office_role !== 'boss').slice(0, 3); if (crew.length) scenes.play(conventionDay(crew.map(actorOf), [...new Set(crew.map((a) => projectName(projectOf(a))))])); } },
    { caption: 'Visitor', run: () => void office.visit(Math.random() < 0.5 ? 'mascot' : 'fan', 'Preview only!') },
    { caption: 'Boom', run: () => office.previewBoom() },
  ];

  const reactToMoney = (event: MoneyEvent) => {
    noteSale(event);
    if (event.kind === 'trial_started') void office.visit('fan', 'Just trying it out!');
    else if (event.kind === 'subscribed' || event.kind === 'subscription_started') void office.visit('mascot', 'A new subscriber!');
    office.money(event);
    party.money(event);          // money arriving gets the same window a shipped game gets
    // Failed and disputed payments include an attempted amount, but no funds arrived.
    if (event.source === 'revenuecat') hud.refreshAfterPayment();
    else if (event.kind === 'sale' || event.kind === 'refund') hud.credit(event.amount);
  };
  const billingSetup = new BillingSetup();
  hud.onConnect = () => void billingSetup.open();
  // The moment the key lands, take the real number rather than making them reload.
  billingSetup.onConnected = () => void (hud as unknown as { refresh(): Promise<void> }).refresh();
  // Without Stripe the panel counts the office's own output, so it needs the shipped tally.
  hud.shipped = () => model.totalShipped;
  hud.staff = () => { const all = [...model.agents.values()];
    return { total: all.length, working: all.filter((a) => a.agent_status === 'working').length }; };
  // Arrows pan the office, but not while the agent sheet is up — it scrolls its own output.
  office.canPan = () => office.canInteract();
  const hint = !lab ? document.createElement('div') : null;
  if (hint) { hint.id = 'agent-hint'; hint.textContent = 'click an agent to talk'; document.getElementById('game')?.append(hint); }
  const openAgent = (a: AgentInfo) => { if (!office.canInteract()) return; hint?.remove(); if (a.office_role === 'boss') void bossCutscene.open(false); else void dialog.open(a); };
  if (studio) {
    studio.beforeOpen = () => { dialog.close(); scenes.close(); reception?.close(false); cat?.close(false); hint?.remove(); };
    studio.onTalk = openAgent;
    dialog.onJournalEntry = id => { void studio.openJournalEntry(id); };
    dialog.onProfile = a => studio.open('people', a.employee_id);
  }
  feed.onSelect = (paneId) => { if (!office.canInteract()) return; const a = model.agents.get(paneId); if (a) { office.focus(paneId); openAgent(a); } };
  office.onPreview = agent => { if (office.canInteract()) dialog.prefetch(agent); };
  feed.onPreview = paneId => { const agent = model.agents.get(paneId); if (agent) office.onPreview?.(agent); };
  feed.onProjectSelect = project => { if (office.canInteract()) office.focusProject(project); };

  let freeAgentBusy = false;
  office.canHire = () => dialog.writable;
  office.onAssign = project => {
    if (!dialog.writable || !office.canInteract()) return;
    const agents = [...model.agents.values()];
    const workspace = agents.find(a => projectKey(a) === project)?.workspace_id;
    audio.unlock(); dialog.openHire(workspaces, agents, workspace || undefined);
  };
  office.furnishings.onFreeAgent = async () => {
    if (freeAgentBusy || !office.canInteract()) return;
    if (!dialog.writable) { studio?.toast('Starting agents is unavailable on a read-only bridge.'); return; }
    freeAgentBusy = true;
    const launch = dialog.showLaunch('Creating a free agent in the projects directory…');
    let started = false;
    try {
      const result = await client.call('agent.free', {}, { onProgress: stage => {
        dialog.showLaunch(stage === 'creating' ? 'Creating workspace…' : stage === 'starting' ? 'Starting agent…' : 'Opening conversation…', launch);
      } }) as { pane_id: string; agent?: AgentInfo };
      started = true;
      const agent = result.agent ?? (await client.call('agent.list') as { agents: AgentInfo[] }).agents.find(a => a.pane_id === result.pane_id);
      studio?.toast('Free agent ready in the projects directory.');
      if (agent && dialog.launchActive(launch)) { office.focus(result.pane_id); void dialog.open(agent); }
    } catch (error) {
      dialog.showLaunch(started ? 'Free agent started. Select its desk to open the conversation.' : `Could not start a free agent: ${(error as Error).message}`, launch, true);
      studio?.toast(started ? 'Free agent started. Select its desk to open the conversation.' : `Could not start a free agent: ${(error as Error).message}`);
    } finally { freeAgentBusy = false; }
  };

  bossCutscene.canReview = () => dialog.writable;
  office.furnishings.onBoss = () => {
    if (!office.canInteract()) return;
    audio.unlock(); hint?.remove();
    void bossCutscene.open(dialog.writable);
  };

  const game = new Phaser.Game({
    type: Phaser.CANVAS, // geometry masks + crisp pixels; WebGL masks need Phaser 4 filters
    parent: 'game',
    pixelArt: true,
    roundPixels: true,
    backgroundColor: '#6ec6f2',
    scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
    scene: [],
  });
  if (people) game.scene.add('people', (await import('./scenes/PeopleScene')).PeopleScene, true);
  else if (lab) game.scene.add('lab', (await import('./scenes/LabScene')).LabScene, true);
  else {
    // Props come from both the local game extraction and redistributable open-art packs. The seed
    // keeps a given office stable, while either collection remains optional during local setup.
    let props: Prop[] = [];
    // Decorations are optional. Safari must not hold the entire office at its blue loading canvas
    // if this tiny request is stalled by a cache, VPN transition, or suspended network process.
    const controller = new AbortController();
    const manifestTimeout = window.setTimeout(() => controller.abort(), 1500);
    try {
      const manifests = await Promise.allSettled([
        fetch('/assets/gds/decor/manifest.json', { signal: controller.signal }).then((r) => r.ok ? r.json() : []),
        fetch('/assets/open/decor/manifest.json', { signal: controller.signal }).then((r) => r.ok ? r.json() : []),
      ]);
      props = manifests.flatMap(result => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
    } catch {}
    finally { clearTimeout(manifestTimeout); }
    const seedParam = q.get('seed');
    const seed = seedParam ? seedFrom(seedParam) : seedFrom(location.host + ':office');
    if (demo) office.theme = themeById(demo.snapshot.theme);
    game.scene.add('office', office, true, { model, onSelect: openAgent, props, seed });
    // Phaser boots the scene on its own clock; the bar moves on once the room can draw.
    const sceneUp = window.setInterval(() => { if ((office.sys?.settings?.status ?? 0) >= Phaser.Scenes.RUNNING) { clearInterval(sceneUp); loading.step('bridge', 'Connecting to the bridge'); } }, 100);
    if (demo) {
      const { installDemoChrome } = await import('./demo');
      const chrome = installDemoChrome(document.getElementById('game')!, document.getElementById('feed')!, demo.snapshot);
      // For the smoke test and the recorder: the snapshot, the re-enactment, and the office's controls.
      (window as any).herdrDemo = { client: demo.client, snapshot: demo.snapshot, capture: demo.capture, caption: chrome.caption,
        office, hud, model, dialog, studio, get ready() { return (window as any).__herdrReady === true; } };
    } else {
      const demoLink = document.createElement('a');
      demoLink.id = 'demo-launch'; demoLink.href = '?demo=1'; demoLink.textContent = '▶ Watch demo';
      document.getElementById('game')!.append(demoLink);
      installEventDebugger(document.getElementById('game')!, (event) => {
        audio.unlock();
        feed.previewMoney(event);
        reactToMoney(event);
      }, () => feed.clearMoneyPreviews(), q.has('debug'), sceneSamples);
    }

    // Phaser owns canvas input separately from the DOM. Observe every modal's hidden state and
    // suspend the scene until after an opening/closing event has completely propagated.
    const syncModalInput = () => {
      const blocked = officeInputBlocked();
      document.documentElement.classList.toggle('office-obscured', blocked);
      document.documentElement.classList.toggle('page-hidden', document.hidden);
      office.setInteractionBlocked(blocked);
      office.setPresentationPaused(document.hidden || blocked);
    };
    const modalObserver = new MutationObserver(syncModalInput);
    modalObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
    queueMicrotask(syncModalInput);
    document.addEventListener('visibilitychange', syncModalInput);
  }

  // Sound: nothing plays until the page has been interacted with, which is the browser's rule,
  // not ours. The office is the only page that gets audio; the labs stay quiet.
  const muteBtn = document.getElementById('mute') as HTMLButtonElement | null;
  const hireBtn = document.getElementById('hire-agent') as HTMLButtonElement | null;
  if (demo) hireBtn?.remove();   // nothing can be started in a snapshot
  const paint = () => {
    if (!muteBtn) return;
    muteBtn.innerHTML = soundIcon(!audio.muted);
    muteBtn.classList.toggle('off', audio.muted);
    muteBtn.title = audio.muted ? 'Sound off' : 'Sound on';
    muteBtn.setAttribute('aria-label', muteBtn.title);
  };
  // Sound is a setting; the mute button is a shortcut to it. A browser that muted before there
  // was a settings window keeps that choice.
  if (!settings.stored) settings.set({ sound: !audio.muted });
  const applySound = () => { audio.setMuted(!settings.value.sound); audio.setLevels(settings.value.music, settings.value.effects); paint(); };
  applySound(); settings.on(applySound);
  const settingsBtn = document.getElementById('settings') as HTMLButtonElement | null;
  if (settingsBtn) settingsBtn.innerHTML = gearIcon(18);
  const settingsDialog = new SettingsDialog(settings, {
    revenue: lab || people ? undefined : () => hud.openSettings(),
    askNotifications: async () => 'Notification' in window && (await Notification.requestPermission()) === 'granted',
  });
  if (!lab) {
    const start = () => { audio.unlock(); removeEventListener('pointerdown', start); removeEventListener('keydown', start); };
    addEventListener('pointerdown', start); addEventListener('keydown', start);
    muteBtn?.addEventListener('click', (e) => { e.stopPropagation(); audio.unlock(); settings.set({ sound: !settings.value.sound }); });
    settingsBtn?.addEventListener('click', (e) => { e.stopPropagation(); audio.unlock(); settingsDialog.open(settingsBtn); });
    hireBtn?.addEventListener('click', (e) => {
      e.stopPropagation(); audio.unlock(); dialog.openHire(workspaces, [...model.agents.values()]);
    });
  } else { muteBtn?.remove(); hireBtn?.remove(); settingsBtn?.remove(); }

  // The tab title carries how many agents are waiting on you, and a browser notification fires
  // for each new one once permission is granted (add ?notify=1 once to be asked).
  const badge = (agents: AgentInfo[]) => {
    const n = agents.filter((a) => a.agent_status === 'blocked').length;
    document.title = n ? `(${n}) needs you · herdr story` : 'herdr story';
  };
  if ((q.has('notify') || settings.value.notifications) && 'Notification' in window && Notification.permission === 'default') {
    const ask = () => { void Notification.requestPermission(); removeEventListener('pointerdown', ask); };
    addEventListener('pointerdown', ask);
  }
  const notify = (a: AgentInfo | undefined, ev: { title: string; status: string }) => {
    if (!a || ev.status !== 'blocked' || !(settings.value.notifications || q.has('notify')) || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(`${agentKind(a)} needs you`, { body: ev.title || a.pane_id, tag: a.pane_id });
  };
  // and a plain sign when the bridge is gone, rather than an office that quietly stops moving
  let offline: HTMLElement | null = null;
  setInterval(() => {
    const down = !client.connected;
    document.body.classList.toggle('offline', down);
    if (down && !offline) { offline = document.createElement('div'); offline.id = 'offline'; offline.textContent = 'bridge offline · reconnecting…'; document.body.appendChild(offline); }
    if (!down && offline) { offline.remove(); offline = null; }
  }, 1000);

  // Office theme: a floating gallery over the room rather than a dropdown in the sidebar. Each
  // swatch is that theme's own wall colour, carpet tile and brick, stacked — a cross-section of
  // the office you are choosing.
  const themeBtn = document.getElementById('theme-btn') as HTMLButtonElement | null;
  const gallery = document.getElementById('theme-gallery') as HTMLElement | null;
  const themer = document.getElementById('themer');
  if (themeBtn && gallery && themer && !lab) {
    const paintBtn = () => { themeBtn.innerHTML = `${galleryIcon()}<span class="label">${office.theme.name}</span>`; };
    gallery.innerHTML = THEMES.map((t) => `<button class="theme-card" type="button" data-id="${t.id}">
        <span class="sw" style="--carpet:url(/assets/gds/ui/${t.carpet}.png);--facade:url(/assets/gds/ui/${t.facade}_r.png);--wall:#${t.wallLight.toString(16).padStart(6, '0')}"></span>
        <span>${t.name}</span></button>`).join('');
    const mark = () => gallery.querySelectorAll<HTMLElement>('.theme-card')
      .forEach((el) => el.setAttribute('aria-current', String(el.dataset.id === office.theme.id)));
    const open = (yes: boolean) => {
      gallery.hidden = !yes; themer.classList.toggle('open', yes);
      themeBtn.setAttribute('aria-expanded', String(yes)); if (yes) mark();
    };
    paintBtn(); open(false);
    closeOnEscape(gallery, () => { open(false); themeBtn.focus(); });
    themeBtn.addEventListener('click', () => open(gallery.hidden === true));
    gallery.addEventListener('click', async (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.theme-card');
      if (!card) return;
      await office.setTheme(card.dataset.id!);
      paintBtn(); mark(); open(false);
    });
    // A press anywhere outside puts it away, including a drag on the office. It has to ignore
    // presses inside the control: this fires before 'click', so closing on the button's own press
    // let the click reopen it — the gallery could never be shut from the button — and closing on a
    // swatch's press pulled the card out from under its own click.
    addEventListener('pointerdown', (e) => { if (!themer.contains(e.target as Node)) open(false); });
    addEventListener('keydown', (e: Event) => {
      const ev = e as KeyboardEvent;
      // T opens the gallery. The button itself is never hidden — it only dims when left alone, so
      // there is always something on screen to click.
      const el = ev.target as HTMLElement | null;
      if (ev.key.toLowerCase() !== 't' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      open(gallery.hidden === true);
    });
  } else document.getElementById('themer')?.remove();

  let welcomed = false;
  stopEarly();
  client.on((msg) => {
    if (msg.type === 'snapshot') {
      if (!welcomed) { welcomed = true; loading.step('agents', `Seating ${msg.agents.length} ${msg.agents.length === 1 ? 'agent' : 'agents'}`); window.setTimeout(() => loading.finish(msg.agents.length), 500); }
      workspaces = msg.workspaces ?? workspaces;
      dialog.writable = msg.writable;
      if (hireBtn) {
        hireBtn.disabled = !msg.writable;
        hireBtn.title = msg.writable ? 'Hire an agent' : 'Hiring is unavailable on a read-only bridge';
      }
      setOfficeLooks(msg.agents);
      if (msg.studio) model.setStudio(msg.studio);
      model.setAgents(msg.agents); feed.summary(msg.agents); badge(msg.agents);
      studio?.sync(msg.studio, msg.agents, msg.writable);
      dialog.sync(msg.agents);
      dialog.syncQueues(msg.queues ?? [], msg.delivered_queue_ids ?? [], msg.bridge_started_at ?? Date.now(), msg.agents);
      hud.clock();
      noteJournal(msg.studio); checkWeek();
      // The tail the bridge kept, so a reload does not come back to an empty sales strip. It is
      // history, not news: the roster lists it, the office does not re-enact it.
      if (msg.money?.length) feed.money(msg.money);
    } else if (msg.type === 'agents') { workspaces = msg.workspaces ?? workspaces; setOfficeLooks(msg.agents); model.setAgents(msg.agents); feed.summary(msg.agents); badge(msg.agents); dialog.sync(msg.agents); studio?.sync(model.studio, msg.agents, dialog.writable); hud.clock(); }
    else if (msg.type === 'studio') { model.setStudio(msg.studio); noteJournal(msg.studio); studio?.sync(msg.studio, [...model.agents.values()], dialog.writable); feed.refresh(); hud.bump(); }
    else if (msg.type === 'queue') dialog.queueUpdate(msg.item);
    else if (msg.type === 'money') {
      feed.money([msg.event]);
      reactToMoney(msg.event);
    }
    else if (msg.type === 'event') {
      const rankBefore = model.progressOf(msg.event.pane_id).rank;
      const shipped = model.noteEvent(msg.event);          // also true only on a real completion
      if (shipped.shipped) dialog.refreshProgress(msg.event.pane_id);
      feed.refresh();
      office.react(msg.event, shipped.levelled ? model.levelOf(msg.event.pane_id) : 0, shipped.stat);
      const who = model.agents.get(msg.event.pane_id);
      if (msg.event.kind === 'status') notify(who, msg.event);
      if (shipped.shipped && who) party.show(who, msg.event, shipped.stat);
      if (shipped.shipped && who) noteShip(who);
      if (shipped.levelled && who) { const after = model.progressOf(who.pane_id); if (after.rank !== rankBefore) scenes.play(trainingSeminar(actorOf(who), `${employeeName(who)} is promoted`, `Now ${after.rank} · Lv ${after.level}`)); }
      if (shipped.shipped) hud.bump();
    }
    if (msg.type === 'snapshot' || msg.type === 'agents' || msg.type === 'studio') reception?.sync();
  });
  // The lab and people scenes are tools, not the office; they get no funds panel.
  if (!lab && !people) hud.start(); else document.getElementById('hud')?.remove();
  (window as any).hs = { model, client, game, party, dialog, office, hud, billingSetup, studio, bossCutscene, scenes, reception, cat };
  (window as any).__herdrReady = true;
}
void boot().catch((error) => {
  loading.fail((error as Error).message || String(error));
  const box = document.getElementById('boot-error');
  if (box) { box.hidden = false; box.textContent = `Could not start the office: ${(error as Error).message || String(error)}`; }
  console.error(error);
});
