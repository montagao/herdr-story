import Phaser from 'phaser';
import { type RoomItem, type StudioState } from '../../shared/studio';
import { propName, type Prop, type Rect } from '../decor';
import { planRoom, retainFurnishings, type PodSite } from './roomPlan';
import { drawCabinet, drawTrophyShelf, drawWhiteboard, drawExecutiveDesk, drawExecutiveChair } from './studioFurniture';
import { BODY_POSE, bodyKey, faceKey } from '../sprites';
import { beginBakedGraphics } from './bakeGraphics';
import { floorDepth } from './depth';

type Point = { x: number; y: number };
const iso = (c: number, r: number) => ({ x: (c - r) * 16, y: (c + r) * 8 + 8 });
const overlaps = (a: Rect, b: Rect, pad = 4) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
export type OfficeObjectPage = 'boards' | 'journal' | 'trophies';
/** Phaser also receives releases from the window. DOM toolbars must never select objects behind them. */
export function fromOfficeCanvas(scene: Phaser.Scene, pointer: Phaser.Input.Pointer) {
  return pointer.event?.target === scene.game.canvas;
}

/** Movable props share the same collision geometry as their visible sprites. Editing is a draft:
 * a failed save or Cancel can never silently overwrite the saved room. */
export class Furnishings {
  items: RoomItem[] = [];
  editing = false;
  selected?: string;
  onOpen?: (page: OfficeObjectPage, project?: string) => void;
  onFreeAgent?: () => void;
  onBoss?: () => void;
  onSelection?: (item?: RoomItem) => void;
  onChange?: () => void;
  /** Shared with the office scene so DOM windows make every canvas target inert. */
  canInteract = () => true;
  private nodes = new Map<string, Phaser.GameObjects.Container>();
  private visuals = new Map<string, string>();
  private outlines = new Map<string, Phaser.GameObjects.Graphics>();
  private drag?: { id: string; from: Point; moved: boolean; offset: Point };
  private W = 0; private H = 0;
  private boxes: Rect[] = [];
  private props: Prop[] = [];
  private state?: StudioState;
  private parked: RoomItem[] = [];
  private site?: { projects: PodSite[]; seed: number };
  constructor(private scene: Phaser.Scene) {}
  install() {
    this.scene.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.drag || !p.isDown) return;
      const item = this.items.find(i => i.id === this.drag!.id)!;
      this.drag.moved ||= Math.abs(p.x - p.downX) + Math.abs(p.y - p.downY) > 5;
      if (!this.drag.moved) return;
      const world = this.scene.cameras.main.getWorldPoint(p.x, p.y);
      const point = { x: world.x - this.drag.offset.x, y: world.y - this.drag.offset.y };
      const c = Math.round(point.x / 32 + (point.y - 8) / 16), r = Math.round((point.y - 8) / 16 - point.x / 32);
      const snapped = iso(c, r);
      item.x = snapped.x; item.y = snapped.y;
      this.nodes.get(item.id)?.setPosition(item.x, item.y).setDepth(floorDepth(item.y - 12));
      this.paintOutline(item, this.clear(item) ? 0x55bd81 : 0xe16858);
    });
    this.scene.input.on('pointerup', () => this.finishDrag());
    this.scene.input.on('gameout', () => this.finishDrag());
  }
  private finishDrag() {
    if (!this.drag) return;
    const item = this.items.find(i => i.id === this.drag!.id);
    if (item) {
      if (!this.clear(item)) { item.x = this.drag.from.x; item.y = this.drag.from.y; this.nodes.get(item.id)?.setPosition(item.x, item.y).setDepth(floorDepth(item.y - 12)); }
      this.paintOutline(item, 0xf2cf60); this.onSelection?.(item);
    }
    this.drag = undefined; this.onChange?.();
  }
  cancelPointer() { this.finishDrag(); }
  get dragging() { return !!this.drag; }
  private size(item: RoomItem) {
    const prop = this.props.find(p => p.id === item.asset);
    return item.kind === 'boss' ? { w: 70, h: 70 } : item.kind === 'decor' ? { w: prop?.w ?? 24, h: prop?.h ?? 30 }
      : item.kind === 'whiteboard' ? { w: 44, h: 54 } : item.kind === 'cabinet' ? { w: 28, h: 46 } : { w: 44, h: 54 };
  }
  private box(item: RoomItem): Rect { const size = this.size(item); return { x: item.x - size.w / 2, y: item.y - size.h, ...size }; }
  private clear(item: RoomItem) {
    const box = this.box(item);
    const inside = (x: number, y: number) => { const c = x / 32 + y / 16, r = y / 16 - x / 32; return c >= 1 && c <= this.W - 1 && r >= 1 && r <= this.H - 1; };
    return inside(box.x, item.y) && inside(box.x + box.w, item.y)
      && !this.boxes.some(b => overlaps(box, b)) && !this.items.some(other => other.id !== item.id && overlaps(box, this.box(other)));
  }
  /** The nearest clear tile; with `prefer`, the nearest clear tile on the wanted side first. */
  private findSpace(item: RoomItem, near: Point, prefer?: (c: number, r: number) => boolean) {
    const candidates: (Point & { wanted: boolean })[] = [];
    for (let c = 1; c < this.W; c++) for (let r = 1; r < this.H; r++) candidates.push({ ...iso(c, r), wanted: !!prefer?.(c, r) });
    const d = (p: Point) => (p.x - near.x) ** 2 + (p.y - near.y) ** 2;
    candidates.sort((a, b) => Number(b.wanted) - Number(a.wanted) || d(a) - d(b));
    for (const p of candidates) { item.x = p.x; item.y = p.y; if (this.clear(item)) return true; }
    return false;
  }
  /** Lay out saved furnishings or tidy their positions without discarding existing inventory. */
  build(state: StudioState, props: Prop[], boxes: Rect[], W: number, H: number, projects: PodSite[], seed: number, fresh = false) {
    this.clearNodes(); this.items = []; this.parked = []; this.state = state; this.props = props; this.boxes = [...boxes]; this.W = W; this.H = H;
    this.site = { projects, seed };
    const saved = fresh ? null : state.room.items;
    const plan = planRoom(props, W, H, projects, seed);
    const planned = (id: string) => plan.find(p => p.item.id === id);
    const desired: { item: RoomItem; prefer?: (c: number, r: number) => boolean; strict?: boolean }[] = saved ? structuredClone(saved).map(item => ({ item })) : fresh ? retainFurnishings(plan, state.room.items ?? []) : plan;
    if (!desired.some(({ item }) => item.kind === 'boss')) desired.unshift(planned('studio-boss')!);
    // A saved room still gets a board for every project that joined since, behind its desks like
    // the others, and keeps its shelf and cabinet.
    for (const project of projects) if (!desired.some(({ item }) => item.kind === 'whiteboard' && item.project === project.id)) desired.unshift(planned(`board:${project.id}`)!);
    for (const kind of ['cabinet', 'trophy'] as const) if (!desired.some(({ item }) => item.kind === kind)) desired.push(planned(kind === 'cabinet' ? 'studio-cabinet' : 'studio-trophies')!);
    for (const { item, prefer, strict } of desired) {
      if (item.kind === 'decor' && !props.some(p => p.id === item.asset)) { this.parked.push(item); continue; }
      if (item.kind === 'whiteboard' && !projects.some(p => p.id === item.project)) { this.parked.push(item); continue; }
      const near = { x: item.x, y: item.y };
      if (!this.clear(item)) {
        if (strict) continue;   // a plant on a rhythm is better missing than misplaced
        if (!this.findSpace(item, near, prefer)) { Object.assign(item, near); this.parked.push(item); continue; }
      }
      this.items.push(item); this.draw(item);
    }
  }
  /** Replace the current arrangement with the planner's, as a draft for the room editor to save. */
  regenerate() {
    if (!this.state || !this.site) return;
    const draft = { ...this.state, room: { ...this.state.room, items: this.savedItems() } };
    this.build(draft, this.props, this.boxes, this.W, this.H, this.site.projects, this.site.seed, true);
  }
  footprints(): Rect[] { return this.items.map(item => ({ x: item.x - this.size(item).w / 2, y: item.y - 12, w: this.size(item).w, h: 14 })); }
  bounds(): Rect[] { return this.items.map(item => this.box(item)); }
  savedItems(): RoomItem[] { return structuredClone([...this.items, ...this.parked]); }
  hangouts(): Point[] { return this.items.map(item => ({ x: item.x - 8, y: item.y - 3 })); }
  private visualKey(item: RoomItem, state = this.state) {
    if (item.kind === 'whiteboard') return JSON.stringify(state?.projects.find(p => p.id === item.project));
    if (item.kind === 'trophy') return String(state?.journalSummary?.trophies ?? state?.journal.filter(e => e.kind === 'milestone' || e.kind === 'release').length ?? 0);
    return item.kind;
  }
  /** A new goal or trophy changes only its own furniture; seated agents retain their actors. */
  updateState(state: StudioState) {
    this.state = state;
    for (const item of this.items) {
      if (this.visuals.get(item.id) === this.visualKey(item)) continue;
      this.nodes.get(item.id)?.destroy();
      this.draw(item);
      if (this.editing && this.selected === item.id) this.paintOutline(item, 0xf2cf60);
    }
  }
  private clearNodes() { for (const node of this.nodes.values()) node.destroy(); this.nodes.clear(); this.outlines.clear(); this.visuals.clear(); }
  clearAll() { this.clearNodes(); this.items = []; }
  private draw(item: RoomItem) {
    const scene = this.scene, { w, h } = this.size(item);
    const node = scene.add.container(item.x, item.y).setDepth(floorDepth(item.y - 12));
    this.nodes.set(item.id, node);
    const art = beginBakedGraphics(scene, { x: -w / 2 - 4, y: -h - 4, w: w + 8, h: h + 8 });
    const g = art.graphics;
    this.visuals.set(item.id, this.visualKey(item));
    const board = this.state?.projects.find(p => p.id === item.project);
    const color = parseInt((board?.color || '#307c9b').slice(1), 16);
    // No ground shadow: nothing in the game's own art casts one, and a soft ellipse under
    // pixel furniture reads as a smudge rather than a base.
    if (item.kind === 'boss') {
      // Centre the chair and occupant on the desk's long rear edge, along its 2:1 diagonal.
      // Keep them together so the desktop covers the lap without separating the backrest.
      const seat = scene.add.container(18, 9); node.add(seat);
      const pose = BODY_POSE.sitFront, x = -15, y = -65;
      drawExecutiveChair(g);
      seat.add(art.finish());
      seat.add(scene.add.image(x + pose.dx, y + pose.dy, bodyKey(0), 'sitFront').setOrigin(0, 0));
      seat.add(scene.add.image(x + pose.fx, y + pose.fy, faceKey(6), pose.face).setOrigin(0, 0));
      const desk = beginBakedGraphics(scene, { x: -37, y: -40, w: 74, h: 54 });
      drawExecutiveDesk(desk.graphics);
      const deskImage = desk.finish(); deskImage.y -= 12; node.add(deskImage);
    } else if (item.kind === 'decor') node.add(scene.add.image(0, 0, `decor:${item.asset}`).setOrigin(0.5, 1));
    else if (item.kind === 'whiteboard') {
      drawWhiteboard(g, color, board?.goals.find(goal => !goal.done));
    } else if (item.kind === 'cabinet') {
      drawCabinet(g);
    } else {
      const count = this.state?.journalSummary?.trophies ?? this.state?.journal.filter(e => e.kind === 'milestone' || e.kind === 'release').length ?? 0;
      drawTrophyShelf(g, count);
      for (let i = 0; i < Math.min(3, count); i++) {
        node.add(scene.add.image(-11 + i * 10, -35 + i * 5, 'main01', 'studio-trophy').setOrigin(0.5, 1));
      }
    }
    if (item.kind !== 'boss') node.addAt(art.finish(), 0);
    const outline = scene.add.graphics().setVisible(false); node.add(outline); this.outlines.set(item.id, outline);
    const label = scene.add.text(0, -h - 8, this.label(item), { fontFamily: 'DotGothic16', fontSize: '8px', color: '#ffffff', backgroundColor: '#244558', align: 'center', wordWrap: { width: 170 } }).setPadding(4).setOrigin(0.5, 1).setResolution(2).setVisible(false); node.add(label);
    node.setInteractive(new Phaser.Geom.Rectangle(-w / 2, -h - 4, w, h + 6), Phaser.Geom.Rectangle.Contains);
    if (node.input) node.input.cursor = 'pointer';
    node.on('pointerover', () => { if (!this.canInteract()) return; label.setVisible(true); this.paintOutline(item, 0xf2cf60); });
    node.on('pointerout', () => { label.setVisible(false); outline.setVisible(this.editing && this.selected === item.id); });
    node.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!this.canInteract() || !this.editing || !fromOfficeCanvas(scene, p)) return;
      this.select(item.id);
      const world = scene.cameras.main.getWorldPoint(p.x, p.y);
      this.drag = { id: item.id, from: { x: item.x, y: item.y }, offset: { x: world.x - item.x, y: world.y - item.y }, moved: false };
    });
    node.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (!this.canInteract() || this.editing || !fromOfficeCanvas(scene, p) || Math.abs(p.x - p.downX) + Math.abs(p.y - p.downY) > 5) return;
      if (item.kind === 'whiteboard') this.onOpen?.('boards', item.project);
      else if (item.kind === 'cabinet') this.onOpen?.('journal');
      else if (item.kind === 'trophy') this.onOpen?.('trophies');
      else if (item.kind === 'boss') this.onBoss?.();
      else if (item.asset === 'zephilie-retro-terminal') this.onFreeAgent?.();
    });
  }
  label(item: RoomItem) {
    if (item.kind === 'whiteboard') {
      const board = this.state?.projects.find(p => p.id === item.project), next = board?.goals.find(g => !g.done);
      return `${board?.name || 'Project'} whiteboard\n${next?.title || 'Set a team milestone'}\n${board?.goals.filter(g => g.done).length || 0} completed · ${next?.contributors.length || 0} contributors`;
    }
    if (item.kind === 'cabinet') return 'Studio journal';
    if (item.kind === 'trophy') return 'Trophy shelf';
    if (item.kind === 'boss') return this.editing ? 'Boss’s executive desk · drag to move' : 'Boss · Ideas guy\nClick to review the journal\nClaude Fable 5.1';
    if (item.asset === 'zephilie-retro-terminal') return this.editing ? 'Free agent terminal · drag to move' : 'Start a free agent\nOpen the projects directory';
    return propName(item.asset);
  }
  private paintOutline(item: RoomItem, color: number) { const { w, h } = this.size(item); this.outlines.get(item.id)?.clear().lineStyle(1, color).strokeRect(-w / 2 - 2, -h - 2, w + 4, h + 4).setVisible(true); }
  select(id?: string) {
    this.selected = id;
    for (const [key, outline] of this.outlines) outline.setVisible(key === id);
    const item = this.items.find(i => i.id === id); if (item) this.paintOutline(item, 0xf2cf60);
    this.onSelection?.(item);
  }
  focusSelected() {
    const item = this.items.find(item => item.id === this.selected);
    if (item) this.scene.cameras.main.centerOn(item.x, item.y - this.size(item).h / 2 + 35);
  }
  startEdit() { this.editing = true; this.select(); }
  stopEdit() { this.editing = false; this.drag = undefined; this.select(); }
  add(kind: RoomItem['kind'], asset?: string, project?: string) {
    const item: RoomItem = { id: crypto.randomUUID(), kind, asset, project, x: 0, y: 0 };
    if (this.items.length >= 200) throw new Error('The office can hold up to 200 furnishings.');
    if (!this.findSpace(item, this.scene.cameras.main.midPoint)) throw new Error('There is no clear space for that furnishing. Move or remove something first.');
    this.items.push(item); this.draw(item); this.select(item.id); this.onChange?.();
    this.scene.cameras.main.centerOn(item.x, item.y - 20);
  }
  removeSelected() {
    const item = this.items.find(i => i.id === this.selected); if (!item) return;
    if (item.kind !== 'decor' && this.items.filter(i => i.kind === item.kind && i.project === item.project).length === 1) throw new Error('Keep one of these in the office so it stays easy to open.');
    this.nodes.get(item.id)?.destroy(); this.nodes.delete(item.id); this.outlines.delete(item.id);
    this.items = this.items.filter(i => i !== item); this.select(); this.onChange?.(); return structuredClone(item);
  }
  restoreItem(saved: RoomItem) {
    if (!this.editing || this.items.some(item => item.id === saved.id)) return;
    const item = structuredClone(saved);
    if (this.items.length >= 200 || (!this.clear(item) && !this.findSpace(item, saved))) throw new Error('There is no clear space to restore this furnishing.');
    this.items.push(item); this.draw(item); this.select(item.id); this.onChange?.();
  }
  restoreDraft(items: RoomItem[]) {
    if (!this.editing || !this.state || !this.site) return;
    const valid = items.filter(item => item && typeof item.id === 'string' && ['decor', 'whiteboard', 'cabinet', 'trophy', 'boss'].includes(item.kind) && Number.isFinite(item.x) && Number.isFinite(item.y)).slice(0, 200);
    this.build({ ...this.state, room: { ...this.state.room, items: valid } }, this.props, this.boxes, this.W, this.H, this.site.projects, this.site.seed);
    this.select(); this.onChange?.();
  }
  moveSelected(dx: number, dy: number) {
    const item = this.items.find(i => i.id === this.selected); if (!item) return;
    const old = { x: item.x, y: item.y }; item.x += dx; item.y += dy;
    if (!this.clear(item)) { Object.assign(item, old); throw new Error('That spot is occupied or outside the room.'); }
    this.nodes.get(item.id)?.setPosition(item.x, item.y).setDepth(floorDepth(item.y - 12)); this.onChange?.();
  }
}
