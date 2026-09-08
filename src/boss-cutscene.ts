import { closeOnEscape } from './escape';
import type { AgentInfo } from '../shared/types';
import type { BossArchivePage, BossBriefing, BossBriefingStatus } from '../shared/boss';
import type { OfficeClient } from './net/office-client';
import type { OfficeScene } from './scenes/OfficeScene';
import { BODY_POSE, bodyKey, faceKey } from './sprites';
import { drawExecutiveDesk, type PixelPen } from './scenes/studioFurniture';
import { renderMarkdown } from './markdown';
import './boss-cutscene.css';

/** The desk is the trigger; this window only polls for the answer while it is open. */
export class BossCutscene {
  private root = document.createElement('div');
  private token = 0;
  private timer = 0;
  private controller?: AbortController;
  private previousFocus?: HTMLElement;
  private briefing?: BossBriefing;
  private agent?: AgentInfo;
  private page = -1;
  private started = 0;
  private archiveView = false;
  private archiveCursor?: string;
  private nextReviewAt?: number;
  private projectId = '';
  private requesting = false;
  canReview = () => true;
  onChat?: (agent: AgentInfo) => void;
  get isOpen() { return this.root.isConnected; }
  constructor(private client: OfficeClient, private office: OfficeScene) {
    this.root.id = 'boss-cutscene'; this.root.dataset.blockOfficeInput = '';
    this.root.innerHTML = `<section class="boss-window" role="dialog" aria-modal="true" aria-labelledby="boss-heading">
      <header><span class="boss-stamp">STUDIO BRIEFING</span><b id="boss-heading">A word from Boss</b><button data-archive>Archive</button><button data-close aria-label="Close briefing">×</button></header>
      <div class="boss-scope"><label for="boss-project">Focus on</label><select id="boss-project" data-project><option value="">All projects</option></select><button data-review>Ask Boss</button></div>
      <div class="boss-stage"><canvas width="288" height="112" aria-label="Boss relaxing at his executive desk"></canvas><span>EXECUTIVE OFFICE</span><i aria-hidden="true">✦</i></div>
      <div class="boss-speaker"><b>Boss</b><span>Ideas guy</span><span data-count></span></div>
      <div class="boss-dialogue" aria-live="polite" aria-atomic="true">
        <p data-intro></p><article hidden><h2 data-title></h2>
          <div class="boss-evidence"><span>FROM THE JOURNAL</span><div data-evidence></div></div>
          <div class="boss-why"><span>WHY IT MATTERS</span><div data-why></div></div>
          <div class="boss-next"><span>ONE SMALL NEXT STEP</span><div data-step></div></div>
        </article><section class="boss-archive" hidden><h2>Boss’s idea archive</h2><p data-archive-summary></p><div data-archive-list></div></section>
      </div>
      <p class="boss-cadence" data-cadence></p>
      <footer><button data-chat hidden>Open chat</button><span data-progress aria-label="Briefing progress"></span><button data-check hidden>Check again</button><button data-back hidden>Previous</button><button data-next>Back to office</button></footer>
    </section>`;
    this.el<HTMLButtonElement>('[data-close]').onclick = () => this.close();
    this.el<HTMLButtonElement>('[data-archive]').onclick = () => { void this.showArchive(); };
    this.el<HTMLButtonElement>('[data-next]').onclick = () => this.next();
    this.el<HTMLButtonElement>('[data-back]').onclick = () => { if (this.archiveView) void this.showArchive(); else { this.page--; this.render(); } };
    this.el<HTMLButtonElement>('[data-chat]').onclick = () => { const agent = this.agent; this.close(); if (agent) this.onChat?.(agent); };
    this.el<HTMLButtonElement>('[data-check]').onclick = () => {
      this.started = Date.now(); this.message('Checking for Boss’s answer…', true); void this.read(this.token);
    };
    this.el<HTMLButtonElement>('[data-review]').onclick = () => { void this.requestReview(); };
    this.el<HTMLSelectElement>('[data-project]').onchange = event => {
      this.projectId = (event.target as HTMLSelectElement).value;
      this.briefing = undefined; this.nextReviewAt = undefined;
      ++this.token; clearTimeout(this.timer); this.controller?.abort();
      this.message('Ask Boss for ideas focused on this project, or browse saved briefings in the archive.', false);
      this.cadence();
    };
    closeOnEscape(this.root, () => this.close());
    this.root.addEventListener('keydown', event => {
      if ((event.target as HTMLElement).matches('select, option')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); this.next(); }
      if (event.key === 'ArrowLeft' && !this.archiveView && this.briefing && this.page >= 0) { event.preventDefault(); this.page--; this.render(); }
      if (event.key === 'Tab') {
        const buttons = [...this.root.querySelectorAll<HTMLElement>('button, select')].filter(button => !button.hidden && !button.hasAttribute('disabled'));
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
  }
  private el<T extends HTMLElement = HTMLElement>(selector: string) { return this.root.querySelector<T>(selector)!; }
  async open(review: boolean) {
    this.close(); const token = ++this.token;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.agent = undefined; this.briefing = undefined; this.page = -1; this.started = Date.now();
    this.archiveView = false; this.nextReviewAt = undefined; this.el('[data-cadence]').textContent = 'New reviews per scope at most once every 24 hours.';
    this.populateProjects();
    document.body.append(this.root); this.drawStage();
    this.message(review ? 'Let me take a look at what the team has been up to…' : 'Let’s open my notes…', true);
    this.el<HTMLButtonElement>('[data-next]').focus();
    if (review) { this.message('Choose all projects or one project, then ask Boss for ideas.', false); return; }
    await this.read(token);
  }
  private populateProjects() {
    const select = this.el<HTMLSelectElement>('[data-project]');
    select.disabled = !this.canReview() || this.requesting;
    this.el('[data-review]').hidden = !this.canReview();
    select.replaceChildren(new Option('All projects', ''), ...(this.office.model.studio?.projects ?? []).map(p => new Option(p.name || p.id, p.id)));
    if (![...select.options].some(o => o.value === this.projectId)) this.projectId = '';
    select.value = this.projectId;
  }
  private async requestReview() {
    if (this.requesting || !this.canReview()) return;
    this.requesting = true;
    const token = ++this.token; clearTimeout(this.timer); this.controller?.abort();
    this.started = Date.now(); this.briefing = undefined;
    const button = this.el<HTMLButtonElement>('[data-review]'), select = this.el<HTMLSelectElement>('[data-project]');
    button.disabled = true; select.disabled = true;
    this.message('Let me read through the journal…', true);
    try {
      const result = await this.client.call('agent.boss', this.projectId ? { project: this.projectId } : {}, { onProgress: stage => {
        if (token === this.token) this.message(stage === 'creating' ? 'I’m getting my office ready…' : 'Let me read through the journal…', true);
      } }) as { agent?: AgentInfo; reviewed: boolean; message: string; nextReviewAt?: number };
      if (token !== this.token) return;
      this.agent = result.agent; this.nextReviewAt = result.nextReviewAt; this.cadence();
      if (!result.reviewed) { this.message(result.message, false); return; }
      await this.read(token);
    } catch (error) { if (token === this.token) this.message(`I couldn’t start the review. ${(error as Error).message}`, false); }
    finally { this.requesting = false; button.disabled = false; select.disabled = !this.canReview(); }
  }
  /** Open an archived search result without starting a review or polling the current agent. */
  openSaved(briefing: BossBriefing, idea = 0) {
    this.close();
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.projectId = briefing.projectId ?? ''; this.populateProjects();
    this.agent = undefined; this.briefing = briefing; this.archiveView = false;
    this.page = Math.max(0, Math.min(idea, briefing.ideas.length - 1)); this.nextReviewAt = undefined;
    document.body.append(this.root); this.drawStage(); this.render();
    this.el<HTMLButtonElement>('[data-next]').focus();
  }
  private async read(token: number) {
    this.controller = new AbortController();
    try {
      const result = await this.client.call('agent.boss.briefing', {}, { signal: this.controller.signal }) as BossBriefingStatus;
      if (token !== this.token) return;
      this.agent = result.agent ?? this.agent;
      this.nextReviewAt = result.nextReviewAt; this.cadence();
      if (result.state === 'ready' && result.briefing) { this.projectId = result.briefing.projectId ?? ''; this.populateProjects(); this.briefing = result.briefing; this.page = -1; this.render(); return; }
      const waiting = result.state === 'thinking' && Date.now() - this.started < 180_000;
      this.message(waiting ? result.message : result.state === 'thinking' ? 'I’m still working on my notes. You can come back to the briefing in a little while.' : result.message, waiting);
      if (waiting) this.timer = window.setTimeout(() => { void this.read(token); }, 1800);
    } catch (error) { if (token === this.token) this.message(`The briefing connection was interrupted. ${(error as Error).message}`, false); }
  }
  private message(text: string, thinking: boolean) {
    this.archiveView = false; this.el('.boss-archive').hidden = true;
    this.root.dataset.thinking = String(thinking);
    this.el('[data-intro]').hidden = false; this.el('[data-intro]').textContent = text;
    this.el('article').hidden = true; this.el('[data-count]').textContent = thinking ? 'Thinking…' : '';
    this.el('[data-progress]').replaceChildren(); this.el('[data-back]').hidden = true;
    this.el('[data-chat]').hidden = !this.agent;
    this.el('[data-check]').hidden = thinking || !this.agent;
    this.el('[data-next]').textContent = 'Back to office';
  }
  private next() {
    if (this.archiveView) { if (this.archiveCursor) void this.showArchive(this.archiveCursor); else this.close(); return; }
    if (!this.briefing || this.page >= this.briefing.ideas.length - 1) { this.close(); return; }
    this.page++; this.render();
  }
  private render() {
    const briefing = this.briefing!;
    this.projectId = briefing.projectId ?? ''; this.populateProjects();
    this.archiveView = false; this.el('.boss-archive').hidden = true;
    this.el('[data-back]').textContent = 'Previous';
    this.cadence();
    this.el('[data-check]').hidden = true;
    this.root.dataset.thinking = 'false';
    const intro = this.page < 0, idea = briefing.ideas[this.page];
    this.el('[data-intro]').hidden = !intro; this.el('[data-intro]').textContent = briefing.intro;
    this.el('article').hidden = intro;
    if (idea) {
      this.el('[data-title]').textContent = idea.title;
      for (const [selector, text] of [['[data-evidence]', idea.evidence], ['[data-why]', idea.why], ['[data-step]', idea.nextStep]]) this.el(selector).innerHTML = renderMarkdown(text);
    }
    this.el('#boss-heading').textContent = briefing.projectName ? `Ideas for ${briefing.projectName}` : 'A word from Boss';
    this.el('[data-count]').textContent = intro ? `${briefing.ideas.length} ideas on my mind` : `IDEA ${String(this.page + 1).padStart(2, '0')} / ${String(briefing.ideas.length).padStart(2, '0')}`;
    this.el('[data-progress]').replaceChildren(...briefing.ideas.map((_, index) => {
      const pip = document.createElement('i'); pip.dataset.active = String(index === this.page); pip.textContent = String(index + 1); return pip;
    }));
    this.el('[data-chat]').hidden = !this.agent;
    this.el('[data-back]').hidden = intro;
    this.el('[data-next]').textContent = intro ? 'Let’s hear them →' : this.page === briefing.ideas.length - 1 ? 'Back to office ✓' : 'Next idea →';
    this.el('.boss-dialogue').scrollTop = 0;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.el('.boss-dialogue').animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 160 });
  }
  private cadence() {
    this.el('[data-cadence]').textContent = this.nextReviewAt && this.nextReviewAt > Date.now()
      ? `Next review: ${new Date(this.nextReviewAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · Saved ideas are always available.`
      : 'New reviews per scope at most once every 24 hours, when you ask Boss.';
  }
  private async showArchive(cursor?: string) {
    const token = ++this.token; clearTimeout(this.timer); this.controller?.abort();
    this.archiveView = true; this.root.dataset.thinking = 'false';
    this.el('[data-intro]').hidden = true; this.el('article').hidden = true; this.el('.boss-archive').hidden = false;
    this.el('[data-count]').textContent = 'PAST BRIEFINGS'; this.el('[data-progress]').replaceChildren();
    this.el('[data-check]').hidden = true; this.el('[data-back]').hidden = true;
    this.el('[data-next]').textContent = 'Back to office'; this.archiveCursor = undefined;
    this.el('[data-archive-summary]').textContent = 'Opening the archive…'; this.el('[data-archive-list]').replaceChildren();
    this.controller = new AbortController();
    try {
      const result = await this.client.call('agent.boss.archive', cursor ? { cursor } : {}, { signal: this.controller.signal }) as BossArchivePage;
      if (token !== this.token) return;
      this.nextReviewAt = result.nextReviewAt; this.cadence(); this.archiveCursor = result.cursor ?? undefined;
      this.el('[data-archive-summary]').textContent = result.total ? `${result.total} saved briefing${result.total === 1 ? '' : 's'}. Revisit any idea without requesting a new review.` : 'No briefings saved yet. Boss’s finished ideas will appear here automatically.';
      this.el('[data-archive-list]').replaceChildren(...result.briefings.map(briefing => {
        const button = document.createElement('button'); button.className = 'boss-archive-entry';
        const date = document.createElement('span'); date.textContent = new Date(briefing.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        const title = document.createElement('b'); title.textContent = briefing.ideas.map(idea => idea.title).join(' · ');
        const detail = document.createElement('span'); detail.textContent = `${briefing.projectName ?? 'All projects'} · ${briefing.ideas.length} ideas · ${briefing.intro}`;
        button.append(date, title, detail); button.onclick = () => { this.briefing = briefing; this.page = -1; this.render(); this.el<HTMLButtonElement>('[data-next]').focus(); };
        return button;
      }));
      this.el('[data-next]').textContent = result.cursor ? 'Older briefings →' : 'Back to office';
      this.el('[data-back]').hidden = !cursor; this.el('[data-back]').textContent = 'Newest';
      this.el('.boss-dialogue').scrollTop = 0;
    } catch (error) { if (token === this.token) this.el('[data-archive-summary]').textContent = `Couldn’t open the archive. ${(error as Error).message}`; }
  }
  private drawStage() {
    const canvas = this.el<HTMLCanvasElement>('canvas'), ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#886a48'; ctx.fillRect(0, 0, 288, 112);
    for (let y = 54; y < 112; y += 8) for (let x = (y % 16 ? -8 : 0); x < 288; x += 16) { ctx.fillStyle = '#92754f'; ctx.fillRect(x, y, 10, 3); }
    ctx.fillStyle = '#dcd8c8'; ctx.fillRect(0, 0, 288, 54);
    ctx.fillStyle = '#aaa993'; ctx.fillRect(0, 51, 288, 3);
    for (const x of [15, 72, 159, 216]) {
      ctx.fillStyle = '#f6f1df'; ctx.fillRect(x, 7, 48, 35);
      ctx.fillStyle = '#a0c4c6'; ctx.fillRect(x + 3, 10, 42, 29);
      ctx.fillStyle = '#cbe1d9'; ctx.fillRect(x + 5, 12, 37, 2);
      ctx.fillStyle = '#e8e6d3'; ctx.fillRect(x + 23, 9, 3, 31);
    }
    ctx.fillStyle = '#536251'; ctx.fillRect(127, 47, 23, 31);
    ctx.fillStyle = '#352e29'; ctx.fillRect(126, 47, 2, 31);
    const draw = (key: string, name: string, x: number, y: number) => {
      const texture = this.office.textures.get(key), frame = texture.get(name);
      ctx.drawImage(texture.getSourceImage() as CanvasImageSource, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, x, y, frame.cutWidth, frame.cutHeight);
    };
    const pose = BODY_POSE.sitFront;
    draw(bodyKey(0), 'sitFront', 131 + pose.dx, 36 + pose.dy);
    draw(faceKey(6), pose.face, 131 + pose.fx, 36 + pose.fy);
    ctx.save(); ctx.translate(144, 92);
    const pen: PixelPen = { fillStyle(color) { ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`; return pen; }, fillRect(x, y, w, h) { ctx.fillRect(x, y, w, h); return pen; } };
    drawExecutiveDesk(pen); ctx.restore();
  }
  close() {
    ++this.token; clearTimeout(this.timer); this.controller?.abort(); this.root.remove();
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.previousFocus = undefined;
  }
}
