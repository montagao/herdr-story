import { billingLabel, isCashEvent } from '../../shared/billing';
import Phaser from 'phaser';
import { waitIconTexture } from './wait-icon';
import type { AgentInfo, AgentStatus, MoneyEvent, OfficeEvent } from '../../shared/types';
import { agentKind, genericTitle, taskOf, titleOf } from '../../shared/types';
import { OfficeModel, pairsOf, type Placement } from '../model/office';
import { BODY_POSE, bodyKey, defineFrames, faceKey, loadSheets, lookFor, lookOf, ensureAppearance, ensureTheme } from '../sprites';
import { FACE_OFFSET } from '../feed/avatar';
import { displayName, speechFor, clip, moneyAmount, statusLabel } from '../feed/feed';
import { anchorsFor, chairFor, deskFor, poseFor, seatSprites } from '../seats';
import { Daylight } from './daylight';
import { settings } from '../settings';
import { hourOverride } from './daylight-curve';
import { loadProps, preparePropTextures, rng, seedFrom, type Prop, type Rect } from '../decor';
import { audio } from '../audio';
import { Wander, type Spot } from './wander';
import { WORK, workKindOf, type WorkKind } from '../work';
import { activeTheme, saveTheme, themeById, THEMES, type Theme } from '../themes';
import { employeeName, projectName } from '../../shared/studio';
import { Furnishings, fromOfficeCanvas } from './Furnishings';
import { beginBakedGraphics } from './bakeGraphics';
import { RenderBudget } from './render-budget';
import { drawEntrance, type Entrance } from './exit';
import { floorDepth, walkerDepth } from './depth';
import { speechBubble, pointBubble } from './bubble';
import { POP_MS, QUICK_MS, cut, drawBrackets, floatOff, hop, popIn, sparkles } from './fx';
import { reducedMotion } from '../motion';
import { Visitor, type VisitorKind } from './visitor';
import { customerLine } from '../money-words';
import { gameCurrency } from '../currency';
import { DepartureCutscene } from '../departure-cutscene';
import { OfficeRegulars } from './office-regulars';

export const TW = 32, TH = 16;           // iso tile footprint on screen
const POD_PITCH = 8;                     // tiles between pod anchors (leaves a walkway and room for the floor label)
const MARGIN = 3;                        // tiles of walkway around the pods
type Vec2 = { x: number; y: number };
const V = (p: Vec2[]) => p as unknown as Phaser.Math.Vector2[];
export function iso(col: number, row: number) { return { x: (col - row) * (TW / 2), y: (col + row) * (TH / 2) }; }
/** Whatever the pointer is on: over every desk's own tags and badges, under the daylight sheet. */
const HOVER_DEPTH = 900_000;
/** A payday's coins and confetti fall in front of the night, not under it (see daylight.ts). */
const OVER_LIGHT = 1_000_100;
/** The same order the floor gives them, but above the daylight sheet: the signals an owner reads
 *  at a glance (a '!', a waiting clock, what somebody is saying) are not dimmed with the furniture. */
const lit = (depth: number) => OVER_LIGHT + 10 + depth * 0.001;

/** One desk in a pod: desk, chair, monitor, person; plus bubbles, popups and a name tag. */
export class Workstation {
  chair: Phaser.GameObjects.Image; desk: Phaser.GameObjects.Image; pc: Phaser.GameObjects.Image;
  flame: Phaser.GameObjects.Image;
  waitIcon: Phaser.GameObjects.Image;
  kb?: Phaser.GameObjects.Image;
  chairFront?: Phaser.GameObjects.Image;
  body: Phaser.GameObjects.Image; face: Phaser.GameObjects.Image; person: Phaser.GameObjects.Container;
  bubble: Phaser.GameObjects.Image; tag: Phaser.GameObjects.Text; workspaceTag: Phaser.GameObjects.Text; talk: Phaser.GameObjects.Text;
  /** The work balloon: which stat this dev is producing, in the game's terms. */
  balloon: Phaser.GameObjects.Image;
  kind: WorkKind = 'program';
  level = 1;
  private balloonTimer?: Phaser.Time.TimerEvent;
  private bugTimer?: Phaser.Time.TimerEvent;
  pose: ReturnType<typeof poseFor>;
  private parts: Phaser.GameObjects.GameObject[] = [];
  private sp!: ReturnType<typeof seatSprites>;
  agent: AgentInfo | null = null;
  status: AgentStatus | 'empty' = 'empty';
  /** When the current stretch of work began, as this page saw it; 0 when not working. */
  workingSince = 0;
  /** The crunch scene has already played for this stretch of work. */
  crunchNoted = false;
  /** Flat out after a long task, or up cheering: nothing else touches the pose until it ends. */
  private collapsed = false;
  private cheering?: Phaser.Time.TimerEvent;
  private collapseTimer?: Phaser.Time.TimerEvent;
  /** Where the occupant sits, and where their name tag hangs when they are in that chair. */
  readonly seat = { x: 0, y: 0 };
  private tagHome = { x: 0, y: 0 };
  private workspaceTagHome = { x: 0, y: 0 };
  private talkHome = { x: 0, y: 0 };
  /** True while they are off wandering; their chair and desk stay put without them. */
  away = false;
  private ax: number; private ay: number;   // seat anchor, in game px (DeskZahyou)
  private typing?: Phaser.Time.TimerEvent; private ambient?: Phaser.Time.TimerEvent; private popTimer?: Phaser.Time.TimerEvent; private frame = 0;
  private fire?: Phaser.Time.TimerEvent;
  private glancing = false;
  private hovered = false;
  /** The status they are in arrived with its entrance: said, sounded and animated. Someone seated
   *  silently has not had theirs, and the event that follows the agent list still owes it. */
  entered = false;
  /** Pointed out from the roster: bracketed and named like a hover, without the plate. */
  private marked = false;
  private pressed = false;
  private brackets?: Phaser.GameObjects.Graphics;
  private bracketKey = '';
  /** The event a hover last ended on, so crossing from the desk to its chair is not a new arrival. */
  private leftOn?: Event;
  private bubbleHome = { x: 0, y: 0 };
  private speech?: Phaser.GameObjects.Container; private speechTimer?: Phaser.Time.TimerEvent;
  private clickTargets: Phaser.GameObjects.GameObject[] = [];
  assignTag: Phaser.GameObjects.Text;
  assignButton: Phaser.GameObjects.Container;
  canAssign = () => false;
  canSpeak = () => true;

  constructor(public scene: Phaser.Scene, mirror: boolean, ax: number, ay: number) {
    this.ax = ax; this.ay = ay;
    this.pose = poseFor(mirror);
    this.sp = seatSprites(mirror);
    const sp = this.sp;
    // Everything hangs off the seat anchor with a top-left origin, and every object carries its
    // own depth so objects from neighbouring seats interleave the way the game's sort key does.
    const img = (l: { key: string; frame: string; dx: number; dy: number; sort: number; flip?: boolean }) =>
      scene.add.image(ax + l.dx, ay + l.dy, l.key, l.frame).setOrigin(0, 0).setFlipX(!!l.flip).setDepth(ay * 10 + l.sort);
    this.desk = img(sp.desk); this.pc = img(sp.pc); this.chair = img(sp.chair);
    if (sp.kb) this.kb = img(sp.kb);
    if (sp.chairFront) this.chairFront = img(sp.chairFront);
    this.person = scene.add.container(ax + sp.person.x, ay + sp.person.y).setDepth(ay * 10 + sp.person.sort);
    this.body = scene.add.image(0, 0, 'body0', this.pose.typing[0]).setOrigin(0, 0).setFlipX(this.pose.flip);
    this.face = scene.add.image(0, 0, 'face0', this.pose.face).setOrigin(0, 0).setFlipX(this.pose.flip).setVisible(false);
    this.person.add([this.body, this.face]);
    // The game's "hard at work" flame is a blaze the occupant sits in: wider than their body and
    // rising a head above it (cluster_ref.png). It draws just behind the person — on a facing
    // seat that is behind the desk and monitor too, on a seat that has its back to us it is in
    // front of them, wrapping the silhouette the way the reference does. The 33x60 cell is
    // three-quarter scale so the base sits at the seat and the tongues clear the hair.
    this.flame = scene.add.image(ax + sp.person.x + 8, ay + sp.person.y + 24, 'main00', 'flame0')
      .setOrigin(0.5, 1).setScale(0.75).setVisible(false).setDepth(ay * 10 + sp.person.sort - 0.5);
    const hx = ax + sp.person.x, hy = ay + sp.person.y;   // head reference
    const top = ay * 10 + 4000;                                  // bubbles and tags sit above everything
    this.bubble = scene.add.image(hx + 14, hy - 34, 'bang').setOrigin(0.5, 1).setVisible(false).setDepth(lit(top + 2));
    this.balloon = scene.add.image(hx + 14, hy - 20, 'balloon0').setOrigin(0.5, 1).setVisible(false).setDepth(top);
    // Sits on the occupant's head: centred on the body (which runs hx..hx+16, so the middle is
    // hx+8) with its underside 2px above the hair. Anchored at the top-left with a 34px lift, it
    // read as a caption hovering in the aisle instead of a label on anybody.
    this.tag = scene.add.text(hx + 8, hy - 12, '', { fontFamily: 'DotGothic16', fontSize: '10px', color: '#ffffff', stroke: '#222a35', strokeThickness: 3 }).setOrigin(0.5, 1).setResolution(2).setDepth(top);
    this.waitIcon = scene.add.image(0, 0, waitIconTexture(scene), 0)
      .setOrigin(0.5).setDepth(lit(top)).setVisible(false);
    // The hover plate: what they were asked, and what they are doing about it right now.
    this.workspaceTag = scene.add.text(hx + 8, hy - 2, '', { fontFamily: 'DotGothic16', fontSize: '6px', color: '#ffffff', backgroundColor: '#203f5a', align: 'left', lineSpacing: 1, wordWrap: { width: 160, useAdvancedWrap: true } })
      .setPadding(3, 2, 3, 2).setOrigin(0.5, 1).setResolution(2).setDepth(top + 1).setVisible(false);
    // A small physical-looking badge, with a drawn cross instead of a tiny font glyph.
    this.assignButton = scene.add.container(hx + 8, hy - 8).setSize(12, 12).setDepth(top + 1).setVisible(false);
    const badge = scene.add.graphics();
    badge.fillStyle(0x172d36, 0.25).fillCircle(0, 1, 6);
    badge.fillStyle(0xfff5d8).fillCircle(0, 0, 6);
    badge.lineStyle(1, 0x887c5e).strokeCircle(0, 0, 6);
    badge.fillStyle(0x50674d).fillRect(-3, -1, 6, 2).fillRect(-1, -3, 2, 6);
    this.assignButton.add(badge);
    this.assignTag = scene.add.text(hx + 8, hy - 18, 'Assign an agent here', { fontFamily: 'DotGothic16', fontSize: '16px', color: '#ffffff', backgroundColor: '#203f5a' })
      .setPadding(6, 4).setScale(0.5).setOrigin(0.5, 1).setResolution(2).setDepth(top + 2).setVisible(false);
    this.talk = scene.add.text(hx + 8, hy - 29, 'talk', { fontFamily: 'DotGothic16', fontSize: '9px', color: '#ffffff', backgroundColor: '#1d9bf0', stroke: '#154c78', strokeThickness: 1 })
      .setPadding(4, 2, 4, 2).setOrigin(0.5, 1).setResolution(2).setVisible(false).setDepth(top + 3);
    this.parts = [this.desk, this.pc, this.chair, this.person, this.flame, this.bubble, this.balloon, this.tag, this.waitIcon, this.workspaceTag, this.talk, this.assignTag, this.assignButton];
    if (this.kb) this.parts.push(this.kb);
    if (this.chairFront) this.parts.push(this.chairFront);
    this.seat.x = this.person.x; this.seat.y = this.person.y;
    this.tagHome.x = this.tag.x; this.tagHome.y = this.tag.y;
    this.workspaceTagHome.x = this.workspaceTag.x; this.workspaceTagHome.y = this.workspaceTag.y;
    this.talkHome.x = this.talk.x; this.talkHome.y = this.talk.y;
    this.bubbleHome.x = this.bubble.x; this.bubbleHome.y = this.bubble.y;
    this.person.setVisible(false);
  }

  /** Where this desk's own bubbles and tags draw: above everything standing on the floor. */
  private get top() { return this.ay * 10 + 4000; }

  destroy() {
    // A replay can rebuild the floor while the staff are cheering. Those completion
    // timers must not restart work animations on an already destroyed workstation.
    this.cheering?.remove(); this.collapseTimer?.remove();
    this.status = 'empty'; this.agent = null;
    this.stopAnims(); this.hush();
    this.scene.tweens.killTweensOf(this.parts);
    for (const p of this.parts) p.destroy();
  }

  /** Stand the occupant somewhere on the floor. Depth follows their feet so they pass in front of
   *  the desks below them and behind the ones above (see depth.ts). Inside their own desk's floor,
   *  which is where they stand up and where the last step home lands, they keep the seat's order
   *  so the chair and monitor stay on the correct side of them. */
  place(x: number, y: number) {
    this.away = true;
    const box = this.floorBox(), fx = x + 8, fy = y + 20;
    const atDesk = fx >= box.x && fx < box.x + box.w && fy >= box.y && fy < box.y + box.h;
    const depth = atDesk ? this.ay * 10 + this.sp.person.sort : walkerDepth(y);
    this.person.setPosition(x, y).setDepth(depth);
    this.tag.setPosition(x + 8, y - 12);
    this.workspaceTag.setPosition(x + 8, y - 2);
    if (!this.hovered) this.workspaceTag.setDepth(walkerDepth(y) + 4001);
    this.talk.setPosition(x + 8, y - 29).setDepth(walkerDepth(y) + 4003);
    // What they are saying goes with them, instead of hanging in the aisle where they said it.
    if (this.speech) pointBubble(this.speech, x + 6, y - this.speechLift).setDepth(lit(walkerDepth(y) + 4003));
    this.flame.setVisible(false); this.bubble.setVisible(false); this.balloon.setVisible(false);
  }

  /** Put them back in their chair and let the status animation take over again. */
  sitAgain() {
    this.away = false;
    this.person.setPosition(this.seat.x, this.seat.y).setDepth(this.ay * 10 + this.sp.person.sort);
    this.tag.setPosition(this.tagHome.x, this.tagHome.y);
    this.workspaceTag.setPosition(this.workspaceTagHome.x, this.workspaceTagHome.y);
    if (!this.hovered) this.workspaceTag.setDepth(this.top + 1);
    this.talk.setPosition(this.talkHome.x, this.talkHome.y).setDepth(this.top + 3);
    if (this.speech) pointBubble(this.speech, this.seat.x + 6, this.seat.y - this.speechLift).setDepth(lit(this.top + 3));
    if (this.status !== 'empty') this.setStatus(this.status, false);
  }

  /** One step of the shared animation clock: 8 a second, the same for every desk. */
  tick(t: number) {
    if (this.away || this.collapsed || this.cheering) return;
    if (this.agent?.wait_notice) {
      // Hold upright, then turn over in four sprite-clock steps every two seconds.
      const phase = t % 16;
      this.waitIcon.setFrame(phase < 12 ? Math.floor(phase / 3) : phase - 8);
      return;
    }
    if (this.status !== 'working') return;
    this.body.setFrame(this.pose.typing[(t >> 1) % 2]); this.layoutFace();
    if (this.sp.screen) this.pc.setFrame('on' + ((t >> 2) % 5));
    if (this.flame.visible) this.flame.setFrame('flame' + (t % 4));
  }

  /** Arms up for a moment, the way the whole floor looks up when money lands. */
  cheerFor(ms = 1800) {
    if (this.away || this.collapsed || !this.agent || this.status === 'empty') return;
    this.cheering?.remove();
    this.settle();
    this.glancing = false;
    this.body.setFrame('cheer'); this.face.setFrame('front3'); this.layoutFace();
    // as many hops as land before the cheer ends: a last one cut off in mid-air reads as a glitch
    hop(this.scene, this.person, 6, Math.max(1, Math.floor(ms / 360)));
    this.cheering = this.scene.time.delayedCall(ms, () => {
      this.cheering = undefined;
      if (!this.away && !this.collapsed && this.status !== 'empty') this.setStatus(this.status, false);
    });
  }

  /** Flat on the floor after a long haul, the way the game's staff drop after a crunch. The pose
   *  holds for a few seconds against fidgets and ticks, then the current status takes over again. */
  collapse(ms = 4200) {
    if (this.away || !this.agent || (window as any).__quiet) return;
    this.collapsed = true;
    this.settle();
    this.flame.setVisible(false); this.balloon.setVisible(false);
    this.body.setFrame('lieDown'); this.layoutFace();
    // Face down on the desk, in front of the monitor: a far-row seat would otherwise hide the
    // whole pose behind the screen's back. The seat order comes back when they get up.
    this.person.setDepth(this.ay * 10 + 5);
    this.say('phew…', 2600);
    this.collapseTimer?.remove();
    this.collapseTimer = this.scene.time.delayedCall(ms, () => {
      this.collapsed = false; this.collapseTimer = undefined;
      if (!this.away) this.person.setDepth(this.ay * 10 + this.sp.person.sort);
      if (this.status !== 'empty') this.setStatus(this.status, false);
    });
  }

  /** The game's LevelUP!! banner over the head, held long enough to read, and then whatever the
   *  level bought. It says nothing itself: the banner and the name tag carry the number, and the
   *  bubble under it is still naming the task that earned it. The fanfare is the scene's to play,
   *  because a level earned behind a window is shown when the window closes. */
  levelUp(level: number) {
    if (!this.person.scene || (window as any).__quiet) return;
    const scene = this.scene, px = this.person.x + 8;
    const py = this.speech ? this.speech.y - this.speech.height / 2 - 3 : this.person.y - 40;
    const banner = scene.add.image(px, py, 'main00', 'levelup').setOrigin(0.5, 1).setDepth(this.top + 4);
    popIn(scene, banner, 0.5);
    floatOff(scene, banner, 1300, 10);
    sparkles(scene, px, py - 6, this.top + 5, 6, 30);
    // A promotion buys furniture; dress() has already swapped it, so this is the unveiling.
    if (!settings.value.furnitureByRank || level < 2) return;
    const chair = chairFor(level) !== chairFor(level - 1), desk = deskFor(level) !== deskFor(level - 1);
    const fresh = [...(desk ? [this.desk] : []), ...(chair ? [this.chair, ...(this.chairFront ? [this.chairFront] : [])] : [])];
    if (!fresh.length) return;
    // From where each piece lives, not from where a hop still under way has it: a second level
    // close behind the first must not leave the chair a few pixels up for good.
    scene.tweens.killTweensOf(fresh);
    this.desk.setY(this.ay + this.sp.desk.dy); this.chair.setY(this.ay + this.sp.chair.dy);
    if (this.chairFront && this.sp.chairFront) this.chairFront.setY(this.ay + this.sp.chairFront.dy);
    if (!reducedMotion()) scene.tweens.add({ targets: fresh, y: '-=4', duration: 120, yoyo: true, ease: 'Quad.out' });
    for (const piece of desk && chair ? [this.desk, this.chair] : [fresh[0]]) sparkles(scene, piece.x + piece.width / 2, piece.y + piece.height / 2 + 6, this.top + 5, 4, 14);
    const line = desk && chair ? 'new desk and chair!' : desk ? 'new desk!' : 'new chair!';
    // once the line about the task has had its time, and only if nothing else has come up since
    scene.time.delayedCall(3800, () => { if (this.agent && !this.away && !this.collapsed && !this.speech) this.say(line, 2200); });
  }

  /** The floor this desk and its chair stand on: the desk's content is 50x40 from the anchor and
   *  the chair sits at its front, so the ground they cover runs from about +10 down to +44.
   *  Per desk rather than per cluster, because a bank is diagonal and one rectangle over the
   *  whole of it would fence off the aisle in front of every middle chair. */
  floorBox(): Rect {
    const chair = this.sp.chair;
    const bottom = Math.max(44, chair.dy + 32);
    return { x: this.ax - 4, y: this.ay + 10, w: 58, h: bottom - 10 };
  }

  /** Show one body frame; the face follows from the pose table. */
  setPose(frame: string) { if (this.collapsed) return; this.body.setFrame(frame); this.layoutFace(); }

  /** Speak an event out loud. The bridge attaches the pane's last lines to anything that is not
   *  'working', so a blocked agent says the question it is actually waiting on. */
  announce(ev: OfficeEvent) {
    if (this.status === 'empty') return;
    const kind = ev.kind === 'status' ? ev.status : ev.kind;
    const title = kind === 'done' || kind === 'idle' ? this.completedTask(ev.title) : ev.title;
    const said = speechFor(kind, title, ev.snippet);
    // The owner has just answered this one's question: the first thing it says is thanks.
    const thanks = ev.kind === 'status' && ev.prev === 'blocked' && ev.status === 'working';
    if (said) this.say(thanks ? `thanks! ${said}` : said, ev.status === 'blocked' ? 5200 : 3600);
  }

  private completedTask(fallback?: string) {
    if (!this.agent) return fallback || '';
    const task = this.agent.last_prompt?.trim() || fallback || taskOf(this.agent);
    return genericTitle(task, this.agent.foreground_cwd || this.agent.cwd) ? '' : task;
  }

  /** Whether this seat's monitor faces the camera, showing a lit screen. */
  get screenVisible() { return this.sp.screen; }
  /** Furniture follows rank: a promotion swaps the chair, and at the top tiers the desk. */
  private dress(level: number) {
    const rank = settings.value.furnitureByRank ? level : 1;
    const chair = chairFor(rank), desk = deskFor(rank), sp = this.sp;
    if (chair !== sp.chair.key) {
      sp.chair.key = chair; this.chair.setTexture(chair, sp.chair.frame);
      if (this.chairFront && sp.chairFront) { sp.chairFront.key = chair; this.chairFront.setTexture(chair, sp.chairFront.frame); }
    }
    if (desk !== sp.desk.key) { sp.desk.key = desk; this.desk.setTexture(desk, sp.desk.frame); }
  }
  setLevel(level: number) {
    this.level = level;
    this.dress(level);
    if (this.agent) {
      this.tag.setText(`${this.agent.wait_notice ? '\u2003 ' : ''}${this.agent.favorite ? '★ ' : ''}${employeeName(this.agent)} · Lv ${level}`);
      const workspaceId = this.agent.workspace_id?.trim() || this.agent.pane_id.split(':', 1)[0];
      const workspace = this.agent.workspace_name?.trim() || workspaceId;
      // Let the task wrap across lines; keep the live activity or status underneath it.
      const prompt = this.agent.last_prompt?.trim();
      const status = this.status === 'empty' ? this.agent.agent_status : this.status;
      const task = taskOf(this.agent), busy = status === 'working';
      const line1 = prompt ? `Last prompt: ${clip(prompt, 240)}`
        : !genericTitle(task, this.agent.foreground_cwd || this.agent.cwd) ? `› ${clip(task, 240)}` : 'Last prompt unavailable';
      const line2 = this.agent.wait_notice ? `${this.agent.wait_notice.kind === 'rate_limit' ? 'Rate limited' : 'Waiting to retry'} · ${this.agent.wait_notice.detail}` : busy ? clip(this.agent.activity || 'working…', 80) : `${statusLabel(status)} · ${clip(workspace, 40)}`;
      this.workspaceTag.setText(`${line1}\n${line2}`);
    }
  }

  setAgent(a: AgentInfo | null, level = 1) {
    const prev = this.status, wasWaiting = !!this.agent?.wait_notice;
    this.agent = a;
    this.refreshAssignment();
    if (!a) { this.hovered = false; this.status = 'empty'; this.dress(1); this.person.setVisible(false); this.tag.setText(''); this.workspaceTag.setText('').setVisible(false); this.talk.setVisible(false); this.refreshAssignment(); this.stopAnims(); this.bubble.setVisible(false); this.flame.setVisible(false); this.hush(); this.highlight(); this.pc.setFrame(this.sp.pc.frame); return; }
    const look = this.loadedLook(a.pane_id);
    this.kind = workKindOf(a);
    // A sync only changes the sheets when the look changed; resetting the frame on every poll
    // would cut off a cheer or a collapse mid-pose.
    if (this.body.texture.key !== bodyKey(look.body)) this.body.setTexture(bodyKey(look.body), this.pose.typing[0]);
    if (this.face.texture.key !== faceKey(look.face)) this.face.setTexture(faceKey(look.face), this.pose.face);
    this.layoutFace(); this.face.setVisible(true);
    this.person.setVisible(true).setAlpha(1);
    this.setClickEnabled(true);
    this.setLevel(level);
    this.setNameplateVisible(this.hovered);
    if (a.agent_status !== prev || wasWaiting !== !!a.wait_notice) this.setStatus(a.agent_status, a.agent_status !== prev && prev !== 'empty');
  }

  /** Settings changed what a name tag shows; redraw this one as it stands. */
  refreshTags() { this.setNameplateVisible(this.hovered); }
  private setNameplateVisible(visible: boolean) {
    this.tag.setVisible((visible || this.marked || !!this.agent?.favorite || !!this.agent?.wait_notice || settings.value.nameTags === 'always') && !!this.agent);
    this.workspaceTag.setVisible(visible && !!this.agent);
    this.speech?.setVisible(!this.workspaceTag.visible);
    this.tag.setPosition(this.away ? this.person.x + 8 : this.tagHome.x, this.away ? this.person.y - 12 : this.tagHome.y);
    this.layoutNameplate();
  }

  /** Fit the expanded hover text to the camera, including while the agent or view moves. */
  layoutNameplate() {
    this.layoutWaitIcon();
    if (this.brackets?.visible) this.layoutBrackets();
    if (!this.workspaceTag.visible) return;
    const cam = this.scene.cameras.main, margin = 8 / cam.zoom;
    const width = cam.width / cam.zoom, height = cam.height / cam.zoom;
    const left = cam.scrollX + cam.width / 2 - width / 2 + margin;
    const top = cam.scrollY + cam.height / 2 - height / 2 + margin;
    const right = left + width - margin * 2, bottom = top + height - margin * 2;
    const wrapWidth = Math.max(24, Math.min(160, Math.floor(right - left - 6)));
    if (this.workspaceTag.style.wordWrapWidth !== wrapWidth) this.workspaceTag.setWordWrapWidth(wrapWidth, true);
    const fitX = (w: number) => Phaser.Math.Clamp(this.person.x + 8, left + w / 2, Math.max(left + w / 2, right - w / 2));
    const y = Phaser.Math.Clamp(this.person.y - 2, top + this.workspaceTag.height + this.tag.height + 2, bottom);
    this.workspaceTag.setPosition(fitX(this.workspaceTag.width), y);
    this.tag.setPosition(fitX(this.tag.width), y - this.workspaceTag.height - 2);
    this.layoutWaitIcon();
  }

  private layoutWaitIcon() {
    const visible = this.tag.visible && !!this.agent?.wait_notice;
    this.waitIcon.setVisible(visible);
    if (!visible) this.waitIcon.setFrame(0);
    this.waitIcon.setPosition(Math.round(this.tag.x - this.tag.width / 2 + 8) + 0.5, Math.round(this.tag.y - this.tag.height / 2) + 0.5);
  }

  private loadingLook = '';
  private loadedLook(paneId: string) {
    const look = lookFor(paneId), textures = this.scene.textures;
    if (textures.exists(bodyKey(look.body)) && textures.exists(faceKey(look.face))) return look;
    const key = `${look.body}:${look.face}`;
    if (this.loadingLook !== key) {
      this.loadingLook = key;
      void ensureAppearance(textures, look).then(() => {
        if (this.person.scene && this.agent?.pane_id === paneId) this.refreshLook();
      }).catch(() => { /* retain the default look; a later sync can retry */ })
        .finally(() => { if (this.loadingLook === key) this.loadingLook = ''; });
    }
    return { body: 0, face: 0 };
  }

  refreshLook() {
    if (!this.agent) return;
    const look = this.loadedLook(this.agent.pane_id);
    this.body.setTexture(bodyKey(look.body), this.body.frame.name);
    this.face.setTexture(faceKey(look.face), this.face.frame.name);
    this.setNameplateVisible(this.hovered);
  }

  /** Treat the person, screen, desk and chair as one selectable workstation. */
  makeClickable(select: () => void, canSelect: () => boolean, preview?: (agent: AgentInfo) => void) {
    this.person.setSize(24, 30);
    const targets = this.clickTargets = [this.desk, this.pc, this.chair, this.person, this.assignButton];
    if (this.kb) this.clickTargets.push(this.kb);
    if (this.chairFront) this.clickTargets.push(this.chairFront);
    const hover = (on: boolean, p?: Phaser.Input.Pointer) => {
      if (!canSelect()) on = false;
      if (!this.agent && !this.canAssign()) on = false;
      const arriving = on && !this.hovered && p?.event !== this.leftOn;
      if (!on && this.hovered) this.leftOn = p?.event;
      this.hovered = on;
      if (!on) this.pressed = false;
      if (on && this.agent) preview?.(this.agent);
      this.talk.setVisible(false); // the two-tier nameplate is the hover affordance now
      this.setNameplateVisible(on);
      this.assignTag.setVisible(on && !this.agent && this.canAssign());
      // The plate of the desk under the pointer goes over its neighbours' badges, not under them.
      // above the lit signals, so a neighbour's '!' never lands on the plate being read
      this.tag.setDepth(on ? OVER_LIGHT + 101 : this.top);
      this.workspaceTag.setDepth(on ? OVER_LIGHT + 102 : (this.away ? walkerDepth(this.person.y) + 4001 : this.top + 1));
      this.assignTag.setDepth(on ? HOVER_DEPTH + 2 : this.top + 2);
      this.highlight(arriving);
      this.layoutFace();
    };
    const press = (down: boolean) => { if (this.pressed !== down) { this.pressed = down; this.highlight(); } };
    for (const target of targets) {
      (target as any).setInteractive({ useHandCursor: true });
      target.on('pointerover', (p: Phaser.Input.Pointer) => hover(true, p));
      target.on('pointerout', (p: Phaser.Input.Pointer) => hover(false, p));
      // The press answers before the window does, and lets go if it turns into a drag of the room.
      target.on('pointerdown', (p: Phaser.Input.Pointer) => { if (this.hovered && fromOfficeCanvas(this.scene, p)) press(true); });
      target.on('pointermove', (p: Phaser.Input.Pointer) => { if (this.pressed && Math.abs(p.x - p.downX) + Math.abs(p.y - p.downY) >= 5) press(false); });
      target.on('pointerup', (p: Phaser.Input.Pointer) => {
        press(false);
        if (canSelect() && fromOfficeCanvas(this.scene, p) && Math.abs(p.downX - p.upX) < 5 && Math.abs(p.downY - p.upY) < 5 && (this.agent || this.canAssign())) select();
      });
    }
    this.refreshAssignment();
  }

  /** Point this desk out, or stop: brackets and the name, for the scene's own glove. */
  mark(on: boolean) {
    if (on === this.marked) return;
    this.marked = on;
    this.setNameplateVisible(this.hovered);
    this.highlight(on);
  }

  /** Corner brackets while the pointer is on this desk: the canvas has no tint to light it with.
   *  They tighten and whiten under a press. `arriving` lands them with a small squeeze and the
   *  plate with a small pop: gentler than a bubble's, because the plate is there to be read. */
  private highlight(arriving = false) {
    if (!this.hovered && !this.marked) { this.brackets?.setVisible(false); return; }
    if (!this.brackets) { this.brackets = this.scene.add.graphics().setDepth(HOVER_DEPTH); this.parts.push(this.brackets); this.bracketKey = ''; }
    this.brackets.setVisible(true);
    this.layoutBrackets();
    if (!arriving || reducedMotion()) return;
    const plate = [this.tag, this.workspaceTag], tweens = this.scene.tweens;
    tweens.killTweensOf([this.brackets, this.assignTag, ...plate]);
    this.brackets.setScale(1.12); this.assignTag.setScale(0.43); for (const text of plate) text.setScale(0.86);
    tweens.add({ targets: [this.brackets, ...plate], scale: 1, duration: QUICK_MS, ease: 'Back.out' });
    tweens.add({ targets: this.assignTag, scale: 0.5, duration: QUICK_MS, ease: 'Back.out' });
  }

  /** Around the occupant, wherever they are: desks in a bank overlap, and a box round the whole
   *  desk takes in half of its neighbours. An empty desk has nobody to hug, so it gets the box,
   *  badge and all. The top edge sits just under where the plate hangs, so the two read as one. */
  private layoutBrackets() {
    const g = this.brackets!, inset = this.pressed ? 2 : 0;
    const box = !this.agent ? { x: this.ax - 2, y: this.seat.y - 16, w: 54, h: (this.ay + 59 - this.seat.y) & ~1 }
      : { x: this.person.x - 4, y: this.person.y - 1, w: 24, h: this.away ? 34 : 30 };
    g.setPosition(Math.round(box.x) + box.w / 2, Math.round(box.y) + box.h / 2);
    const key = `${box.w}x${box.h}:${inset}`;
    if (key === this.bracketKey) return;
    this.bracketKey = key;
    drawBrackets(g, box.w - inset * 2, box.h - inset * 2, this.pressed ? 0xffffff : 0xf2cf60, this.agent ? 4 : 6);
  }

  refreshAssignment() {
    const available = !this.agent && this.canAssign();
    this.assignButton.setVisible(available);
    this.assignTag.setVisible(available && this.hovered);
    this.setClickEnabled(!!this.agent || available);
  }

  private setClickEnabled(enabled: boolean) {
    for (const target of this.clickTargets) if (target.input) target.input.enabled = enabled;
  }

  private stopAnims() {
    this.typing?.remove(); this.typing = undefined; this.ambient?.remove(); this.ambient = undefined; this.popTimer?.remove(); this.popTimer = undefined;
    this.fire?.remove(); this.fire = undefined; this.flame.setVisible(false); this.waitIcon.setVisible(false).setFrame(0);
    this.balloonTimer?.remove(); this.balloonTimer = undefined; this.balloon.setVisible(false);
    this.bugTimer?.remove(); this.bugTimer = undefined;
    this.settle();
    this.layoutFace();
    this.pc.setFrame(this.sp.pc.frame);
  }

  /** Stop whatever is moving the occupant, their '!' or their flame, and put each back where it
   *  lives: a quick change of status must not leave anyone a few pixels off their chair. */
  private settle() {
    this.scene.tweens.killTweensOf([this.person, this.bubble, this.flame]);
    this.bubble.setPosition(this.bubbleHome.x, this.bubbleHome.y).setScale(1);
    this.flame.setScale(0.75);
    if (!this.away) this.person.setPosition(this.seat.x, this.seat.y);
  }

  /** The '!' lands over the head and bobs there until someone answers. */
  private showBang() {
    this.scene.tweens.killTweensOf(this.bubble);
    this.bubble.setPosition(this.bubbleHome.x, this.bubbleHome.y).setScale(1).setVisible(true);
    popIn(this.scene, this.bubble, 0.5);
    if (!reducedMotion()) this.scene.tweens.add({ targets: this.bubble, y: this.bubbleHome.y - 4, duration: 350, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
  }

  setStatus(s: AgentStatus, animateTransition: boolean) {
    const was = this.status;
    if (animateTransition) this.entered = true; else if (was !== s) this.entered = false;
    if (s === 'working' && !this.agent?.wait_notice) { if (this.status !== 'working' || !this.workingSince) { this.workingSince = Date.now(); this.crunchNoted = false; } }
    else { this.workingSince = 0; this.crunchNoted = false; }
    if (this.collapsed) { this.collapsed = false; this.collapseTimer?.remove(); this.collapseTimer = undefined; if (!this.away) this.person.setDepth(this.ay * 10 + this.sp.person.sort); }
    if (this.cheering) { this.cheering.remove(); this.cheering = undefined; }
    this.status = s;
    // Status events arrive before the next agent snapshot. Refresh the hover immediately.
    this.setLevel(this.level);
    // An answered question takes its '!' away with a small pop, where it hung.
    if (animateTransition && was === 'blocked' && s !== 'blocked' && this.bubble.visible && !reducedMotion()) {
      const gone = this.scene.add.image(this.bubble.x, this.bubble.y, 'bang').setOrigin(0.5, 1).setDepth(this.bubble.depth);
      this.scene.tweens.add({ targets: gone, scale: 0.3, alpha: 0, duration: 110, ease: 'Quad.in', onComplete: () => gone.destroy() });
    }
    this.stopAnims();
    this.bubble.setVisible(false); this.setNameplateVisible(this.hovered);
    this.body.setTint(0xffffff); this.face.setTint(0xffffff);
    const P = this.pose;
    // while they are off walking the wander system owns the sprite; a poll must not snap them
    // back into a typing pose in the middle of the floor
    const pose = (b: string, _f?: string) => { if (this.away || this.collapsed || this.cheering) return; this.body.setFrame(b); this.layoutFace(); };
    const t = this.scene.time;
    if (this.agent?.wait_notice) {
      pose(P.typing[0], P.face);
      this.hush();
      return;
    }
    // say what this agent is actually doing; an event, when one arrives, replaces it with the
    // pane's own words
    if (animateTransition) {
      const task = s === 'done' || s === 'idle' ? this.completedTask() : this.agent ? titleOf(this.agent) : '';
      const said = speechFor(s, task);
      // whatever they were saying is about the status they just left
      if (!this.canSpeak()) this.hush();
      if (said) this.say(was === 'blocked' && s === 'working' ? `thanks! ${said}` : said, s === 'blocked' ? 4600 : 3200);
      // only real transitions make a noise; the first sync seats everyone silently. Finishing is
      // not sounded here: whether the turn shipped anything is known where the event is counted
      // (main.ts), and that is where its fanfare, its chord or its plain settle is chosen.
      if (s === 'blocked') audio.blip('bell');
      else if (s === 'working') audio.play('working');
    }
    switch (s) {
      case 'working':
        pose(P.typing[0], P.face);
        // typing, screen and flame all advance in tick(), off the scene's shared counter
        this.schedulePops();
        if (this.kind === 'debug') this.scheduleBugs();
        this.flame.setVisible(true).setFrame('flame0');
        // the blaze catches from the seat upward when work really starts; a re-seat just has it lit
        if (animateTransition && !this.away && !reducedMotion()) {
          this.flame.setScale(0.75, 0.25);
          this.scene.tweens.add({ targets: this.flame, scaleY: 0.75, duration: 160, ease: 'Back.out' });
        }
        break;
      case 'blocked':
        pose(P.stand, P.face);
        // while they are still asking the question, its bubble is the sign; the '!' follows it
        if (!this.speech) this.showBang();
        // a small start as they stand up: this is the change the owner is scanning the floor for
        if (animateTransition && !this.away) hop(this.scene, this.person, 4);
        this.typing = t.addEvent({ delay: 700, loop: true, callback: () => { const fr = [P.face, ...P.glance]; this.frame = (this.frame + 1) % fr.length; this.face.setFrame(fr[this.frame]); this.layoutFace(); } });
        break;
      case 'done':
        pose('cheer', 'front3');
        if (!this.away) hop(this.scene, this.person, 6, animateTransition ? 6 : 2);
        // Arms up means "come and look". One small hop now and then keeps it from reading as a
        // statue for as long as the status lasts, without asking the office to redraw any faster.
        this.ambient = t.addEvent({ delay: Phaser.Math.Between(9000, 18000), loop: true, callback: () => {
          if (!this.away && !this.collapsed && !this.cheering && !this.scene.tweens.isTweening(this.person)) hop(this.scene, this.person, 4);
        } });
        break;
      case 'idle':
        pose(P.typing[0], P.face);
        if (animateTransition) { pose('cheer', 'front3'); t.delayedCall(1500, () => { if (this.status === 'idle') pose(P.typing[0], P.face); }); }
        this.scheduleFidget();
        break;
      default:
        pose(P.typing[0], P.face); this.body.setTint(0x9aa4b0); this.face.setTint(0x9aa4b0);
    }
  }
  /** Idle agents look around, blink, mutter, or stretch every few seconds so the office feels alive. */
  private scheduleFidget() {
    this.ambient = this.scene.time.addEvent({ delay: Phaser.Math.Between(1500, 6000), callback: () => {
      if (this.status !== 'idle') return;
      // fidgeting is for people in a chair: away from the desk the walk cycle owns the sprite
      if (this.away || this.collapsed || this.cheering) { this.scheduleFidget(); return; }
      const P = this.pose;
      const r = Math.random();
      // by the time a fidget ends they may be up cheering a sale, or halfway to the coffee table
      const back = () => { if (this.status === 'idle' && !this.away && !this.collapsed && !this.cheering) { this.body.setFrame(P.typing[0]); this.layoutFace(); } };
      if (r < 0.4) { this.glancing = true; this.face.setFrame(P.glance[Math.floor(Math.random() * P.glance.length)]); this.scene.time.delayedCall(900, () => { this.glancing = false; back(); }); }
      else if (r < 0.5) {
        // half the time say what they were last on, half the time just make a noise
        const t = clip(this.completedTask(), 34);
        this.say(t && Math.random() < 0.5 ? `done: ${t}` : ['coffee?', 'zzz', 'hmm', '...'][Math.floor(Math.random() * 4)]);
      }
      else if (r < 0.8) { this.body.setFrame(P.typing[1]); this.layoutFace(); this.scene.time.delayedCall(600, back); }
      else { this.body.setFrame('cheer'); this.face.setFrame('front'); this.layoutFace(); this.scene.time.delayedCall(700, back); }
      this.scheduleFidget();
    } });
  }
  /** Game Dev Story speech bubble: white rounded box with a tail, above the head, gone after a moment. */
  say(text: string, ms = 2600) {
    if (!this.person.scene || (window as any).__quiet || !this.canSpeak()) return;
    this.hush();
    this.speech = speechBubble(this.scene, this.person.x + 6, this.person.y - this.speechLift, text, lit(this.away ? walkerDepth(this.person.y) + 4003 : this.top + 3)).setVisible(!this.hovered);
    this.bubble.setVisible(false);
    this.speechTimer = this.scene.time.delayedCall(ms, () => { this.hush(); if (this.status === 'blocked' && !this.away) this.showBang(); });
  }
  /** How far above the anchor a bubble's tail sits: clear of the name tag when one is showing,
   *  and right over the head when not — a bubble hung 35px up over a bare head reads as nobody's. */
  private get speechLift() { return this.tag.visible ? 35 : 8; }
  private hush() { this.speechTimer?.remove(); this.speechTimer = undefined; this.speech?.destroy(); this.speech = undefined; }
  /** Drop a line that went stale while nobody could see the floor. A question still waiting on
   *  the owner is not stale. */
  forget() { if (this.status !== 'blocked') this.hush(); }
  /** Bug bubbles out of the monitor while a dev is on a bug hunt — GameForm.DrawObj's bugEff_,
   *  three frames of blue bubbles, rising and gone in under a second. */
  private scheduleBugs() {
    this.bugTimer = this.scene.time.addEvent({ delay: Phaser.Math.Between(900, 2600), callback: () => {
      if (this.status !== 'working' || this.kind !== 'debug' || this.away) return;
      if (!(window as any).__quiet) {
        const x = this.pc.x + 14 + Phaser.Math.Between(-4, 6), y = this.pc.y + 6;
        const b = this.scene.add.image(x, y, 'bugbubble', 0).setOrigin(0.5, 1).setDepth(this.top - 1);
        let f = 0;
        const flip = this.scene.time.addEvent({ delay: 220, repeat: 2, callback: () => b.setFrame(++f % 3) });
        if (!reducedMotion()) this.scene.tweens.add({ targets: b, y: y - 8, duration: 580, ease: 'Quad.out' });
        floatOff(this.scene, b, 580, 4, () => flip.remove());
      }
      this.scheduleBugs();
    } });
  }

  /** The work balloon, drawn the way DrawFukidashi does it: it appears above the head, lifts a
   *  little over its first moments, holds, and goes. */
  showWork() {
    if (!this.person.scene || (window as any).__quiet) return;
    const b = this.balloon.setTexture(`balloon${WORK[this.kind].balloon}`);
    b.setPosition(this.person.x + 14, this.person.y - 36).setScale(0.6).setAlpha(1).setVisible(true);
    if (reducedMotion()) b.setScale(1).setY(b.y - 5);
    else this.scene.tweens.add({ targets: b, scale: 1, y: b.y - 5, duration: 220, ease: 'Back.out' });
    this.balloonTimer?.remove();
    this.balloonTimer = this.scene.time.delayedCall(1400, () => {
      this.scene.tweens.add({ targets: b, alpha: 0, duration: 160, onComplete: () => {
        b.setVisible(false);
      } });
    });
  }

  /** Floating "+N" with a stat icon, like the game's development points. The blue ones that fly
   *  out during work are flavour. `earned` is the real point a shipped task adds to the sheet: it
   *  is gold, names its stat, carries the game's green arrow, and hangs beside the head where the
   *  bubble about the task cannot cover it. */
  pop(kind: WorkKind, n: number, earned = false) {
    if (!this.person.scene || (window as any).__quiet) return;
    audio.play('points');
    const scene = this.scene;
    const img = scene.add.image(-8, 0, 'main00', WORK[kind].icon).setOrigin(0.5, 0.5);
    const t = scene.add.text(2, 0, earned ? `+${n} ${WORK[kind].short}` : `+${n}`, { fontFamily: 'DotGothic16', fontSize: earned ? '12px' : '10px', color: earned ? '#b7791f' : '#2b4fd6', stroke: '#ffffff', strokeThickness: 3 }).setOrigin(0, 0.5).setResolution(2);
    const c = scene.add.container(this.person.x + (earned ? 36 : Phaser.Math.Between(-4, 10)), this.person.y - (earned ? 8 : 26), [img, t]).setDepth(this.top + (earned ? 4 : 1));
    if (earned) c.add(scene.add.image(Math.ceil(t.width) + 4, 0, 'main00', cut(scene, 'main00', 'gain', 131, 17, 8, 7)).setOrigin(0, 0.5));
    popIn(scene, c);
    if (!reducedMotion()) scene.tweens.add({ targets: c, y: c.y - 10, duration: POP_MS, ease: 'Back.out' });
    floatOff(scene, c, earned ? 1500 : 760);
  }
  private schedulePops() {
    this.popTimer = this.scene.time.addEvent({ delay: Phaser.Math.Between(1500, 4500), callback: () => {
      if (this.status !== 'working') return;
      // Alternate the large work balloon with point gains. Drawing both from this callback used
      // to put the small stat icon and +N text directly through the balloon artwork.
      // not from the middle of the aisle: someone walking back to their desk has nothing to show yet
      if (!this.away) { if (this.frame++ % 3 === 0) this.showWork(); else this.pop(this.kind, Phaser.Math.Between(1, 12)); }
      this.schedulePops();
    } });
  }
  /** Place body and face using the pose's own draw offset, the way DrawHuman does. */
  private layoutFace() {
    const p = BODY_POSE[this.body.frame.name] ?? BODY_POSE.standFront;
    this.body.setPosition(p.dx, p.dy);
    // Each pose names its own face cell; a glance during an idle fidget overrides it, and someone
    // at their keyboard looks up for as long as the pointer is on their desk.
    if (this.hovered && !this.away && this.pose.typing.includes(this.body.frame.name)) this.face.setFrame(this.pose.glance[0]);
    else if (!this.glancing) this.face.setFrame(p.face);
    this.face.setPosition(p.fx, p.fy);
  }
}

/** Builds a project's desk cluster around an anchor tile; returns the stations in seat order.
 *  `pairs` four-desk banks run on up the (36,-18) diagonal, so a project with a dozen agents is
 *  one long bank rather than several loose pods. */
export function buildPod(scene: Phaser.Scene, col: number, row: number, pairs = 1): Workstation[] {
  const a = iso(col, row);
  return anchorsFor(pairs).map((s) => new Workstation(scene, s.mirror, a.x + s.x, a.y + s.y + 40));
}

/** The screen box a cluster covers, for keeping props off it. */
export function podBox(col: number, row: number, pairs: number): Rect {
  const a = iso(col, row);
  return { x: a.x - 6, y: a.y + 2 - 36 * (pairs - 1), w: 112 + 72 * (pairs - 1), h: 90 + 36 * (pairs - 1) };
}

/** Project names come from a directory basename and can be long; the floor has room for about
 *  this much before one cluster's label runs into the next. */
function projectLabel(name: string) { return name.length > 18 ? name.slice(0, 17) + '\u2026' : name; }

export class OfficeScene extends Phaser.Scene {
  furnishings = new Furnishings(this);
  private daylight?: Daylight;
  private projectDrag?: { id: string; start: Vec2 };
  onSwapProjects?: (a: string, b: string) => void;
  model!: OfficeModel;
  onSelect?: (a: AgentInfo) => void;
  onPreview?: (a: AgentInfo) => void;
  /** Someone has been on one task for a long time; main may cut to the crunch scene. */
  onCrunch?: (a: AgentInfo, ms: number) => void;
  static CRUNCH_MS = 25 * 60_000;
  private visitor?: Visitor;
  private replayCustomer?: Visitor;
  private replayVisit = 0;
  private replayCustomerTimer?: Phaser.Time.TimerEvent;
  /** What is being said at the counter right now, and what is said back when it ends. */
  private tillLine?: { bubble: Phaser.GameObjects.Container; timer: Phaser.Time.TimerEvent; reply?: () => void };
  replayPropAssets?: Set<string>;
  private visitors: { kind: VisitorKind; line: string; onArrive?: (here: boolean) => void }[] = [];
  /** Where the reception counter stands, for the receptionist's own bubble. */
  private receptionDesk = { x: 0, y: 0 };
  private peekReturn?: { x: number; y: number; timer: Phaser.Time.TimerEvent };
  /** Set from main: true while something a peek went to see is still up (the payday card). */
  holdPeek = () => false;
  onAssign?: (project: string) => void;
  canHire = () => false;
  props: Prop[] = [];
  seed = 1;
  private decor: (Phaser.GameObjects.Image | Phaser.GameObjects.Graphics)[] = [];
  private pods: { stations: Workstation[]; label: Phaser.GameObjects.Text; project: string; bounds: Rect; col: number; row: number; pairs: number }[] = [];
  private byPane = new Map<string, Workstation>();
  private followedPane?: string;
  private room?: Phaser.GameObjects.Container;
  private layoutKey = '';
  private roomPlanKey = '';
  private roomGeometry?: { W: number; H: number; floor: Rect[]; bounds: Rect[] };
  /** The game runs every animation off one counter (GameForm.KeyAnimeT), so all the typing,
   *  screens and flames step together. This is ours: 8 ticks a second. */
  private tickN = -1;
  /** Just inside the entrance wall, beside the reception; new agents walk in from here. */
  private entrance: Spot = { x: 0, y: 0 };
  /** The two beats of clocking out: greet the receptionist, then cross the outside edge. */
  private receptionSpot: Spot = { x: 0, y: 0 };
  onReception?: () => void;
  onCat?: () => void;
  onJanitor?: () => void;
  regulars?: OfficeRegulars;
  private receptionSprite?: Phaser.GameObjects.Image;
  private receptionBell?: Phaser.GameObjects.Graphics;
  private receptionHint?: Phaser.GameObjects.Text;
  private receptionBrackets?: Phaser.GameObjects.Graphics;
  /** How many were waiting at the last sync; undefined until the first one, which rings nothing. */
  private waiting?: number;
  /** The game's white glove as a CSS cursor, once its sheet has loaded. */
  private glove = '';
  /** Everything the pointer is on, for letting go of it when a window covers the canvas. */
  private under = new Set<Phaser.GameObjects.GameObject>();
  /** The glove that points out one desk from the roster, and the desk it points at. */
  private pointer?: { st: Workstation; timer: Phaser.Time.TimerEvent; node?: Phaser.GameObjects.Container };
  private blocked = false;
  private stepping = false;
  /** When the floor went out of sight behind a window or a hidden tab; 0 while it can be seen. */
  private unseenSince = 0;
  /** Levels earned out of sight, by pane, shown when the floor is back. */
  private missedLevels = new Map<string, number>();
  private outside: Spot = { x: 0, y: 0 };
  private arrivals = new Set<string>();
  private departures = new Map<string, Promise<void>>();
  /** Idle agents leave their desks and walk between these. */
  private wander = new Wander(() => this.pods.flatMap((p) => p.stations), (st, text) => st.say(text, 2800));
  private placed: Placement[] = [];
  private dragging = false; private dragFrom = { x: 0, y: 0 }; private camFrom = { x: 0, y: 0 };
  private roomPx = { w: 0, h: 0 };
  private roomCentre = { x: 0, y: 0 };
  /** False until the first room exists; after that a rebuild keeps the view instead of recentring. */
  private framed = false;
  /** The part of the room worth looking at — the desks and reception. Null before the first build. */
  private viewBounds: Rect | null = null;
  private panKeys?: { left: Phaser.Input.Keyboard.Key; right: Phaser.Input.Keyboard.Key; up: Phaser.Input.Keyboard.Key; down: Phaser.Input.Keyboard.Key };
  /** Screen pixels a second while an arrow is held; about three seconds to cross a large office. */
  private static readonly PAN_SPEED = 760;
  /** Set from main: false while a panel owns the keyboard, so arrows there are not also a pan. */
  canPan = () => true;
  /** DOM windows are outside Phaser's display list, so every canvas hit target shares this gate. */
  canInteract = () => true;
  /** Presentations can keep speech focused on one person while the room stays animated. */
  canSpeak = (_paneId: string) => true;
  private roomBounds: Rect = { x: 0, y: 0, w: 0, h: 0 };
  /** Camera zoom fits the complete room in small steps and never exceeds the preferred 2x scale.
   *  Phaser's nearest-neighbour canvas keeps the sprites sharp at these fractional sizes; an
   *  explicit ?zoom=N keeps manual control. */
  private zoom = 2;
  private forcedZoom?: number;
  private previousView?: { zoom: number; x: number; y: number };
  onViewModeChange?: (wholeOffice: boolean) => void;
  get wholeOfficeView() { return !!this.previousView; }
  theme: Theme = activeTheme();
  fitOnCreate = false;

  constructor() { super('office'); }
  init(data: { model: OfficeModel; onSelect?: (a: AgentInfo) => void; props?: Prop[]; seed?: number }) {
    this.model = data.model; this.onSelect = data.onSelect;
    this.props = data.props ?? []; this.seed = data.seed ?? 1;
  }
  preload() { loadSheets(this.load, '/assets/gds', { theme: this.theme, looks: [...this.model.agents.values()].map(a => lookFor(a.pane_id)) }); loadProps(this.load, this.replayPropAssets ? this.props.filter(p => this.replayPropAssets!.has(p.id)) : this.props); }

  create() {
    // Do not call TimeStep.setFPSLimit from a running frame: its RAF restart can
    // create a second scheduling chain. Budget the existing callback instead.
    const loop = this.game.loop, originalFrame = loop.callback;
    this.renderBudget = new RenderBudget(originalFrame);
    loop.callback = this.renderBudget.step;
    this.renderBudget.boost();
    const boost = () => { if (this.canInteract()) this.renderBudget?.boost(); };
    // Two fingers on a trackpad, or the wheel, move the view. Zoom is fixed, so nothing else wants
    // the wheel, and ctrl+wheel stays the browser's.
    const wheel = (e: WheelEvent) => {
      if (!this.canInteract() || e.ctrlKey || this.wholeOfficeView || this.followedPane || this.dragging || this.furnishings.dragging) return;
      boost();
      const cam = this.cameras.main, c = this.camCentre();
      const unit = (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cam.height : 1) / cam.zoom;
      const p = this.clampCameraCentre(c.x + (e.shiftKey ? e.deltaY : e.deltaX) * unit, c.y + (e.shiftKey ? 0 : e.deltaY) * unit);
      this.takeView();
      cam.centerOn(p.x, p.y);
    };
    const canvas = this.game.canvas;
    canvas.addEventListener('pointerdown', boost, { passive: true });
    canvas.addEventListener('pointermove', boost, { passive: true });
    canvas.addEventListener('wheel', wheel, { passive: true });
    const boostKey = (event: KeyboardEvent) => {
      if (this.canPan() && event.key.startsWith('Arrow')) boost();
    };
    document.addEventListener('keydown', boostKey);
    // A settle frame must never be drawn from inside the game's own step (see settleFrame).
    const stepIn = () => { this.stepping = true; }, stepOut = () => { this.stepping = false; };
    this.game.events.on('prestep', stepIn); this.game.events.on('postrender', stepOut);
    this.events.once('shutdown', () => {
      this.cancelReplayCustomer();
      this.regulars?.destroy(); this.regulars = undefined;
      if (loop.callback === this.renderBudget?.step) loop.callback = originalFrame;
      canvas.removeEventListener('pointerdown', boost);
      canvas.removeEventListener('pointermove', boost);
      canvas.removeEventListener('wheel', wheel);
      document.removeEventListener('keydown', boostKey);
      this.game.events.off('prestep', stepIn); this.game.events.off('postrender', stepOut);
      this.under.clear(); this.pointer = undefined;
    });
    preparePropTextures(this.textures, this.props);
    defineFrames(this.textures);
    this.glove = this.gloveCursor();
    // Everything clickable on the floor wears the game's glove, whichever file made it clickable:
    // Phaser has already set the hand cursor by the time this hears about it.
    this.input.on('gameobjectover', (_p: Phaser.Input.Pointer, object: Phaser.GameObjects.GameObject) => {
      this.under.add(object);
      if (this.glove && object.input?.cursor === 'pointer') { object.input.cursor = this.glove; this.input.setCursor(object.input); }
    });
    this.input.on('gameobjectout', (_p: Phaser.Input.Pointer, object: Phaser.GameObjects.GameObject) => this.under.delete(object));
    // Phaser sends no pointerout when the pointer leaves the canvas, so a desk stayed lit until it came back.
    this.input.on('gameout', () => this.releaseHover());
    // the counter answers someone on their way out
    this.wander.onGoodbye = () => { if (!this.unseen && !(window as any).__quiet && !this.tillLine) this.time.delayedCall(500, () => { if (!this.tillLine) this.sayAtTill('see you!', this.receptionDesk.x + 12, this.receptionDesk.y - 44, 1800); }); };
    this.furnishings.install();
    this.game.events.once('postrender', () => this.setPresentationPaused(this.presentationPaused));
    this.furnishings.canInteract = () => this.canInteract();
    this.cameras.main.setBackgroundColor(this.theme.sky);
    this.daylight = new Daylight(this, () => this.theme.sky, () => this.renderBudget?.boost());
    // The settings window reaches the office here: the clock, the walking, the frame rate, and
    // what each desk shows. `?hour=` still wins over the clock setting, for recordings.
    const applySettings = () => {
      const s = settings.value;
      this.daylight?.setHour(hourOverride(location.search) ?? (s.followDay ? undefined : s.hour));
      this.wander.enabled = s.wander;
      if (this.renderBudget) this.renderBudget.lowPower = s.lowPower;
      for (const p of this.pods) for (const st of p.stations) { st.setLevel(st.level); st.refreshTags(); }
      this.renderBudget?.boost();
    };
    applySettings();
    this.events.once('shutdown', settings.on(applySettings));
    const asked = Number(new URLSearchParams(location.search).get('zoom'));
    this.forcedZoom = Number.isFinite(asked) && asked > 0 ? Phaser.Math.Clamp(asked, 0.5, 6) : undefined;
    this.zoom = this.chooseZoom();
    this.cameras.main.setZoom(this.zoom);
    // Replay replaces this scene when a different period is loaded. The old scene must
    // stop observing the shared model before its cameras and game objects are destroyed.
    this.events.once('shutdown', this.model.on((change) => { if (change === 'agents') this.sync(); }));
    this.sync();
    if (this.fitOnCreate) this.fitOffice();
    // An office with nobody in it is the first thing seen on a quiet morning. Once the title card
    // has gone, the receptionist says so, where hiring is something this page can do.
    this.time.delayedCall(5000, () => {
      if (this.model.agents.size || this.unseen || !this.canHire() || !(this.receptionDesk.x || this.receptionDesk.y)) return;
      this.sayAtTill('quiet today. hire someone?', this.receptionDesk.x + 12, this.receptionDesk.y - 44, 4200);
    });
    // A resize changes what fits on screen, not how big the office is drawn. Re-clamp the current
    // centre as well: a tall window can otherwise expose a large strip beyond the back wall.
    const resizeOffice = () => {
      this.renderBudget?.boost();
      const cam = this.cameras.main;
      if (this.wholeOfficeView) { this.applyOfficeFit(); return; }
      const was = this.camCentre();
      this.zoom = this.chooseZoom();
      cam.setZoom(this.zoom);
      const p = this.clampCameraCentre(was.x, was.y);
      cam.centerOn(p.x, p.y);
    };
    this.scale.on('resize', resizeOffice);
    this.events.once('shutdown', () => this.scale.off('resize', resizeOffice));
    // Arrow keys pan as well as dragging. Capture is left off deliberately: with it, Phaser calls
    // preventDefault on the arrows everywhere, which would stop them moving the caret in the
    // prompt box. The page itself cannot scroll, so nothing else wants them.
    const kb = this.input.keyboard;
    if (kb) {
      const K = Phaser.Input.Keyboard.KeyCodes;
      this.panKeys = { left: kb.addKey(K.LEFT, false), right: kb.addKey(K.RIGHT, false),
        up: kb.addKey(K.UP, false), down: kb.addKey(K.DOWN, false) };
    }
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (!this.canInteract() || !fromOfficeCanvas(this, p)) return;
      this.takeView();
      this.dragging = !this.furnishings.dragging && !this.projectDrag; this.dragFrom = { x: p.x, y: p.y }; this.camFrom = { x: this.cameras.main.scrollX, y: this.cameras.main.scrollY };
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      this.dragging = false;
      // A finger has no hover: whatever the touch lit up would stay lit until the next one.
      if (p.wasTouch) this.releaseHover();
      if (this.projectDrag) {
        const from = this.projectDrag; this.projectDrag = undefined;
        if (fromOfficeCanvas(this, p) && Math.abs(p.x - from.start.x) + Math.abs(p.y - from.start.y) > 8) {
          const at = this.cameras.main.getWorldPoint(p.x, p.y);
          const nearest = [...this.pods].sort((a, b) => Phaser.Math.Distance.Between(at.x, at.y, a.label.x, a.label.y) - Phaser.Math.Distance.Between(at.x, at.y, b.label.x, b.label.y))[0];
          if (nearest && nearest.project !== from.id && Phaser.Math.Distance.Between(at.x, at.y, nearest.label.x, nearest.label.y) < 100) this.onSwapProjects?.(from.id, nearest.project);
        }
      }
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.canInteract() || !this.dragging || !p.isDown) return;
      const z = this.cameras.main.zoom;
      const cam = this.cameras.main;
      const sx = this.camFrom.x - (p.x - this.dragFrom.x) / z, sy = this.camFrom.y - (p.y - this.dragFrom.y) / z;
      const centre = this.clampCameraCentre(sx + cam.width / 2, sy + cam.height / 2);
      cam.centerOn(centre.x, centre.y);
    });
  }

  /** Keep input disabled through the closing pointer event; main toggles this from a mutation
   *  observer after the DOM modal's hidden state has settled. */
  setInteractionBlocked(blocked: boolean) {
    // Main calls this on every mutation under <body>, so the frame below belongs to the moment a
    // window first comes up and to nothing else.
    const covered = blocked && !this.blocked;
    this.blocked = blocked;
    if (covered && this.sys?.isActive()) {
      // What stays on screen behind the window is the last frame drawn. Make it a finished one:
      // nothing under the pointer still lit, and a glide a roster click started already where it
      // was going, so the room shows the chosen desk now and does not drift when the window shuts.
      this.releaseHover();
      this.stopPointing();
      const cam = this.cameras.main, pan = cam.panEffect;
      if (pan.isRunning) { cam.centerOn(pan.destination.x, pan.destination.y); pan.reset(); }
      this.settleFrame();
    }
    if (this.input) this.input.enabled = !blocked;
    if (!blocked) return;
    this.receptionHint?.setVisible(false); this.receptionBrackets?.setVisible(false);
    this.regulars?.hideHints();
    this.dragging = false;
    this.projectDrag = undefined;
    this.furnishings.cancelPointer();
  }

  /** Draw the room once, now, whether or not the loop is running. Only ever from a DOM handler:
   *  stepping the game from inside its own step would re-enter it. */
  private settleFrame() {
    if (this.stepping || !this.sys?.isActive() || !this.game?.loop) return;
    this.renderBudget?.reset();
    this.game.loop.tick();
  }

  /** Whatever the pointer was on lets go. Phaser only notices a pointer leaving when it moves,
   *  and it cannot move behind a window, so plates and outlines used to stay lit until the mouse
   *  next crossed the canvas. Taking each object off Phaser's own list as well means the next
   *  move over it counts as arriving again. */
  private releaseHover() {
    const pointer = this.input.activePointer;
    for (const object of [...this.under]) {
      this.input.forceOutState(pointer, object);
      const enabled = !!object.input?.enabled;
      this.input.disable(object);
      if (object.input) object.input.enabled = enabled;
    }
    this.under.clear();
    this.input.resetCursor();
  }

  private presentationPaused = false;
  renderBudget?: RenderBudget;
  /** True while the live office is out of sight: behind a window, or in a hidden tab. A replay
   *  that is merely paused is still being looked at, and keeps its bubbles. */
  private get unseen() { return this.unseenSince > 0; }
  /** Freeze the last frame behind DOM windows. Model notifications still sync state directly. */
  setPresentationPaused(paused: boolean) {
    const changed = paused !== this.presentationPaused;
    this.presentationPaused = paused;
    let away = 0;
    if (changed) {
      this.renderBudget?.reset();
      if (!paused && this.unseenSince) away = performance.now() - this.unseenSince;
      this.unseenSince = paused && (this.blocked || document.hidden) ? performance.now() : 0;
    }
    if (!this.game?.loop || !this.sys?.isActive()) return;
    if (away) this.catchUp(away);
    if (paused && this.game.loop.running) this.game.loop.sleep();
    else if (!paused && !this.game.loop.running) { this.renderBudget?.boost(); this.game.loop.wake(); }
  }

  /** The floor is back in view. What was said before it went is old news after a few seconds, so
   *  those bubbles go; levels earned meanwhile are shown now, one after another like a roll call. */
  private catchUp(away: number) {
    if (away > 4000) for (const p of this.pods) for (const st of p.stations) st.forget();
    let i = 0;
    for (const [paneId, level] of this.missedLevels) this.time.delayedCall(300 + i++ * 220, () => this.byPane.get(paneId)?.levelUp(level));
    this.missedLevels.clear();
  }

  update(time: number, delta: number) {
    if (this.departures.size) this.renderBudget?.boost();
    if (this.dragging || this.furnishings.dragging || this.projectDrag || this.followedPane
      || this.cameras.main.panEffect.isRunning) this.renderBudget?.boost();
    const t = Math.floor(time / 125);
    if (t !== this.tickN) {
      this.tickN = t; for (const p of this.pods) for (const st of p.stations) st.tick(t);
      if (t % 8 === 0) this.checkCrunch();
    }
    if (!this.furnishings.editing) { this.wander.update(time, delta); this.regulars?.update(time, delta); }
    this.keyboardPan(delta);
    if (this.followedPane) {
      const st = this.byPane.get(this.followedPane);
      if (st) {
        const target = this.clampCameraCentre(st.person.x + 8, st.person.y - 16);
        const from = this.camCentre(), blend = 1 - Math.exp(-delta / 250);
        this.cameras.main.centerOn(from.x + (target.x - from.x) * blend, from.y + (target.y - from.y) * blend);
      }
    }
    for (const p of this.pods) for (const st of p.stations) st.layoutNameplate();
    this.pointer?.node?.setPosition(this.pointer.st.person.x + 8, this.pointer.st.tag.y - this.pointer.st.tag.height - 1);
  }

  /** The person has taken hold of the view: a glide or a peek in progress gives way at once,
   *  rather than fighting the drag and snapping back when it ends. */
  private takeView() {
    this.cameras.main.panEffect.reset();
    if (this.peekReturn) { this.peekReturn.timer.remove(); this.peekReturn = undefined; }
  }

  /** The white glove from the game's own interface sheet, as the cursor for everything clickable
   *  on the floor. Drawn at the office's 2x with no smoothing, and at 4x for dense screens where
   *  the browser can be told so; anything that cannot take it keeps the ordinary hand. */
  private gloveCursor() {
    if (!this.textures.exists('main00')) return '';
    const sheet = this.textures.get('main00').getSourceImage() as CanvasImageSource;
    const at = (scale: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = 16 * scale; canvas.height = 10 * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sheet, 66, 0, 16, 10, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL();
    };
    try {
      const plain = `url(${at(2)}) 0 5, pointer`;
      const sharp = `image-set(url(${at(2)}) 1x, url(${at(4)}) 2x) 0 5, pointer`;
      return CSS.supports('cursor', sharp) ? sharp : CSS.supports('cursor', plain) ? plain : '';
    } catch { return ''; }
  }

  /** "This one": the game's glove drops in over the agent the view was just taken to and taps
   *  for a moment, with the desk bracketed and named, so one desk among four alike is unmistakable. */
  private pointAt(st: Workstation, after: number) {
    this.stopPointing();
    this.pointer = { st, timer: this.time.delayedCall(after, () => {
      const pointer = this.pointer!;
      st.mark(true);
      const glove = this.add.image(0, 0, 'main00', cut(this, 'main00', 'glove', 131, 0, 10, 17)).setOrigin(0.5, 1);
      pointer.node = this.add.container(st.person.x + 8, st.tag.y - st.tag.height - 1, [glove]).setDepth(HOVER_DEPTH + 3);
      popIn(this, pointer.node);
      if (!reducedMotion()) this.tweens.add({ targets: glove, y: -3, duration: 150, yoyo: true, repeat: 5, ease: 'Quad.out' });
      pointer.timer = this.time.delayedCall(1800, () => this.stopPointing());
    }) };
  }
  private stopPointing() {
    const pointer = this.pointer; if (!pointer) return;
    this.pointer = undefined;
    pointer.timer.remove(); pointer.st.mark(false);
    if (pointer.node) { this.tweens.killTweensOf(pointer.node.list); pointer.node.destroy(); }
  }

  /** Move the view while an arrow is held, at a speed that feels the same at any zoom. */
  private keyboardPan(delta: number) {
    const k = this.panKeys;
    if (!k || !this.canPan()) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;   // someone is typing
    let dx = (k.right.isDown ? 1 : 0) - (k.left.isDown ? 1 : 0);
    let dy = (k.down.isDown ? 1 : 0) - (k.up.isDown ? 1 : 0);
    if (!dx && !dy) return;
    this.renderBudget?.boost();
    this.takeView();
    if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }         // diagonals move no faster
    const step = (OfficeScene.PAN_SPEED / this.cameras.main.zoom) * (delta / 1000);
    const c = this.camCentre();
    const p = this.clampCameraCentre(c.x + dx * step, c.y + dy * step);
    this.cameras.main.centerOn(p.x, p.y);
  }

  /** Rebuild the room if the cluster layout changed, then seat everyone whose desk or status
   *  changed. The layout is keyed by where each project sits and how big its bank is, so seating
   *  churn inside a cluster does not tear the room down. */
  private sync() {
    this.updateReception();
    if (this.furnishings.editing) return;
    const layout = this.model.layout();
    const key = this.layoutStructure(layout) + JSON.stringify([!!this.model.studio, this.model.studio?.room.items]);
    if (key !== this.layoutKey && this.model.hasDepartures) {
      // Workspace removals, new arrivals and room edits can all change the layout during
      // a group departure. Keep the route intact, but still show live work at other desks.
      for (const [id, st] of this.byPane) {
        const a = this.model.agents.get(id);
        if (a && !this.model.isDeparting(id)) st.setAgent(a, this.model.levelOf(id));
      }
      return;
    }
    if (key !== this.layoutKey) { this.layoutKey = key; this.buildRoom(layout); }
    else if (this.model.studio) this.furnishings.updateState(this.model.studio);
    this.placed = layout.placed;
    this.byPane.clear();
    this.pods.forEach((pod, pi) => {
      const mp = this.placed[pi]?.pod;
      pod.label.setText(mp ? projectLabel(this.model.studio?.projects.find(p => p.id === mp.project)?.name || projectName(mp.project)) : '');
      pod.stations.forEach((st, si) => {
        st.refreshAssignment();
        const paneId = mp?.seats[si] ?? null;
        const a = paneId ? this.model.agents.get(paneId) ?? null : null;
        if (!a) { if (st.agent) st.setAgent(null); return; }
        this.byPane.set(a.pane_id, st);
        if (this.model.isDeparting(a.pane_id)) return;   // Wander owns this actor until it is outside
        if (st.agent?.pane_id === a.pane_id && st.status === a.agent_status && !!st.agent.wait_notice === !!a.wait_notice) { st.agent = a; st.setLevel(this.model.levelOf(a.pane_id)); st.refreshLook(); return; } // unchanged: keep its animation running
        st.setAgent(a, this.model.levelOf(a.pane_id));
        if (this.arrivals.delete(a.pane_id)) this.wander.enter(st, this.entrance, this.time.now);
      });
    });
    this.daylight?.dress(this.pods.flatMap(p => p.stations));
  }

  /** The office's clock: local time unless pinned by `?hour=` or a recording. */
  get hour() { return this.daylight?.hour ?? 12; }
  setHour(hour?: number) { this.daylight?.setHour(hour); }

  private buildRoom(layout: { cols: number; rows: number; placed: Placement[] }) {
    this.roomPlanKey = this.layoutStructure(layout);
    const { cols, rows } = layout;
    // Nine tiles leave a walkable aisle and space for boards without the old twelve-tile gaps.
    const pitch = this.model.studio ? 9 : POD_PITCH;
    this.placed = layout.placed;
    this.wander.clear();
    this.furnishings.clearAll();
    this.room?.destroy(); this.pods.forEach((p) => { p.stations.forEach((s) => s.destroy()); p.label.destroy(); }); this.pods = [];
    // four extra tiles along the entrance wall for the reception desk, which every office in the
    // game has (DrawObj draws it alongside the desks) and which needs floor no cluster claims
    const W = cols * pitch + MARGIN * 2 - 2 + 4, H = rows * pitch + MARGIN * 2 - 2;
    const room = this.room = this.add.container(0, 0).setDepth(-500);
    const c0 = iso(0, 0), c1 = iso(W, 0), c2 = iso(W, H), c3 = iso(0, H);
    // Reception by the entrance wall, the receptionist baked into the sprite as in the game. The
    // extra aisle keeps the clusters off it, but a long bank in the last column can still reach
    // across, so walk up the wall from the front and take the first clear spot. Settled before
    // the walls are drawn, because the doorway is a notch in the room's own edge.
    const podBoxes = this.placed.map((place) => podBox(MARGIN + place.col * pitch, MARGIN + place.row * pitch, pairsOf(place.pod)));
    const receptionBox = (row: number): Rect => { const r = iso(W - 3, row); return { x: r.x - 42, y: r.y + TH / 2 - 62, w: 84, h: 66 }; };
    let receptionRow = -1;
    for (let row = H - 4; row >= 3; row--) {
      const box = receptionBox(row);
      if (podBoxes.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue;
      receptionRow = row; break;
    }
    const minX = c3.x, maxX = c1.x, minY = c0.y, maxY = c2.y;
    const th = this.theme;
    const carpet = this.add.tileSprite(minX, minY, maxX - minX, maxY - minY, th.carpet).setOrigin(0, 0);
    const maskG = this.make.graphics({}, false); maskG.fillStyle(0xffffff).fillPoints(V([c0, c1, c2, c3]), true);
    carpet.setMask(maskG.createGeometryMask());
    const wallArt = beginBakedGraphics(this, { x: minX - 3, y: -44, w: maxX - minX + 6, h: maxY + 48 });
    const g = wallArt.graphics;
    room.once('destroy', () => maskG.destroy());

    // The tower the office stands on. The game paints each room onto a building that runs off the
    // bottom of the picture; ours used a 26px lip, which left the floor hanging in mid-air. Both
    // faces are the game's own brick: its window grid drops 50px across 100px — the isometric
    // slope — and a storey is 50px, so a 100x50 crop repeats as a plain rectangle and tiles onto
    // a face with no shearing. Masked to the parallelogram under each near edge.
    const TOWER = 1200;
    const towers: Phaser.GameObjects.TileSprite[] = [];
    const face = (a: Vec2, b: Vec2, key: string, origin?: Vec2) => {
      const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
      const ts = this.add.tileSprite(left, top, Math.abs(b.x - a.x), TOWER, key).setOrigin(0, 0);
      const m = this.make.graphics({}, false);
      m.fillStyle(0xffffff).fillPoints(V([a, b, { x: b.x, y: b.y + TOWER }, { x: a.x, y: a.y + TOWER }]), true);
      ts.setMask(m.createGeometryMask());
      room.once('destroy', () => m.destroy());
      // the brick's own diagonal has to start on the roof line, not on the bounding box; a face
      // given another face's origin continues that face's pattern instead
      const o = origin ?? (a.x < b.x ? a : b);
      ts.tilePositionX = left - o.x; ts.tilePositionY = top - o.y;
      towers.push(ts);
      return ts;
    };
    face(c3, c2, `${th.facade}_l`); face(c2, c1, `${th.facade}_r`);

    // The back walls, drawn to the pattern the game's own rooms use rather than a stripe of
    // windows: a capped cream wall carrying groups of narrow panes with blank wall between them,
    // and a squat post standing on the cap every few tiles. The wall's own window period does not
    // land on tile boundaries in the source, so this is drawn to match rather than cut from it.
    const wallH = 34, CAP = 4, GROUP = 6, PANES = 4;
    const band = (a: Vec2, b: Vec2, top: number, bot: number, colour: number) =>
      g.fillStyle(colour).fillPoints(V([{ x: a.x, y: a.y - top }, { x: b.x, y: b.y - top }, { x: b.x, y: b.y - bot }, { x: a.x, y: a.y - bot }]), true);
    /** One wall run, from `at(0)` to `at(n)` along the room's edge. */
    const backWall = (n: number, at: (i: number) => Vec2, colour: number) => {
      band(at(0), at(n), wallH, 0, colour);
      band(at(0), at(n), wallH, wallH - CAP, th.wallTrim);
      for (let i = 0; i < n; i++) {
        if (i % GROUP >= PANES) continue;          // a blank stretch between groups
        for (let k = 0; k < 3; k++) {              // three narrow panes to a tile
          const u = i + (k + 0.18) / 3, v = i + (k + 0.82) / 3;
          band(at(u), at(v), wallH - CAP - 2, 9, th.wallWindow);
        }
      }
      for (let i = GROUP - 1; i < n; i += GROUP) {  // posts, sitting on the cap
        band(at(i + 0.25), at(i + 0.75), wallH + 5, wallH - CAP, th.wallTrim);
      }
    };
    backWall(W, (i) => iso(i, 0), th.wallDark);
    backWall(H, (j) => iso(0, j), th.wallLight);
    let entrance: Entrance | null = null;
    if (receptionRow >= 0) {
      // Leave a clear stretch of wall between the front desk and the doorway.
      entrance = drawEntrance(g, th, W, Math.max(1, receptionRow - 5),
        (a, b, side, continueRight) => face(a, b, `${th.facade}_${side}`, continueRight ? c2 : undefined));
    }
    // the roof parapet, broken where the doorway's landing steps out of the room
    const parapet = entrance ? [[c3, c2, entrance.gap[1]], [entrance.gap[0], c1]] : [[c3, c2, c1]];
    for (const run of parapet) g.lineStyle(3, th.wallTrim).strokePoints(V(run), false);
    g.lineStyle(1, 0x00000022).strokePoints(V([c3, c0, c1]), false);
    room.add([carpet, ...towers, wallArt.finish()]);
    this.receptionHint?.destroy(); this.receptionHint = undefined;
    this.receptionBrackets?.destroy(); this.receptionBrackets = undefined;
    this.receptionSprite = undefined; this.receptionBell = undefined;
    this.stopPointing(); this.under.clear();
    for (const d of this.decor) d.destroy();
    this.decor = [];
    const boxes: Rect[] = [];
    const floor: Rect[] = [];   // ground footprints, for walking around
    for (const place of this.placed) {
      const pairs = pairsOf(place.pod);
      const ac = MARGIN + place.col * pitch, ar = MARGIN + place.row * pitch;
      const stations = buildPod(this, ac, ar, pairs);
      // Out of sight, only a question for the owner is worth saying: anything else would be old
      // news by the time the floor is seen again.
      for (const st of stations) st.canSpeak = () => !!st.agent && this.canSpeak(st.agent.pane_id) && (!this.unseen || st.status === 'blocked');
      for (const st of stations) {
        st.canAssign = () => this.canHire() && !this.furnishings.editing;
        st.makeClickable(() => {
          if (this.furnishings.editing) return;
          if (st.agent) this.onSelect?.(st.agent);
          else if (st.canAssign()) this.onAssign?.(place.pod.project);
        }, () => this.canInteract(), agent => this.onPreview?.(agent));
      }
      // one label per project, on the floor just below the near end of the bank
      const a = iso(ac, ar);
      const label = this.add.text(a.x + 40, a.y + 96, '', { fontFamily: 'DotGothic16', fontSize: '10px', color: th.label }).setOrigin(0.5, 0).setResolution(2).setAlpha(0.85).setDepth(-400);
      const bounds = podBox(ac, ar, pairs);
      this.pods.push({ stations, label, project: place.pod.project, bounds, col: ac, row: ar, pairs });
      label.setInteractive({ useHandCursor: true });
      label.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
        if (this.canInteract() && fromOfficeCanvas(this, pointer) && this.furnishings.editing) this.projectDrag = { id: place.pod.project, start: { x: pointer.x, y: pointer.y } };
      });
      label.on('pointerup', (pointer: Phaser.Input.Pointer) => {
        if (this.canInteract() && fromOfficeCanvas(this, pointer) && !this.furnishings.editing && Math.abs(pointer.x - pointer.downX) + Math.abs(pointer.y - pointer.downY) < 5) this.furnishings.onOpen?.('boards', place.pod.project);
      });
      boxes.push(bounds);
      for (const st of stations) floor.push(st.floorBox());
    }
    if (receptionRow >= 0 && entrance) {
      const r = iso(W - 3, receptionRow), base = r.y + TH / 2;
      const box = receptionBox(receptionRow);
      const reception = this.receptionSprite = this.add.image(r.x, base, 'reception').setOrigin(0.5, 1).setDepth(floorDepth(base - 14) - 1);
      reception.setInteractive({ useHandCursor: true });
      const hint = this.receptionHint = this.add.text(r.x, base - reception.height - 4, '', {
        fontFamily: 'DotGothic16', fontSize: '8px', color: '#ffffff', backgroundColor: '#244558', align: 'center',
      }).setPadding(4).setOrigin(0.5, 1).setResolution(2).setDepth(100000).setVisible(false);
      // The same brackets a desk gets under the pointer, around the counter.
      const brackets = this.receptionBrackets = drawBrackets(this.add.graphics(), box.w + 4, reception.height + 4)
        .setPosition(r.x, base - reception.height / 2).setDepth(HOVER_DEPTH).setVisible(false);
      reception.on('pointerover', () => {
        if (!this.canInteract() || this.furnishings.editing) return;
        hint.setVisible(true); brackets.setVisible(true);
        if (reducedMotion()) return;
        this.tweens.killTweensOf(brackets);
        brackets.setScale(1.12);
        this.tweens.add({ targets: brackets, scale: 1, duration: QUICK_MS, ease: 'Back.out' });
      });
      reception.on('pointerout', () => { hint.setVisible(false); brackets.setVisible(false); });
      reception.on('pointerup', (pointer: Phaser.Input.Pointer) => {
        if (!this.canInteract() || this.furnishings.editing || !fromOfficeCanvas(this, pointer)
            || Math.abs(pointer.x - pointer.downX) + Math.abs(pointer.y - pointer.downY) > 5) return;
        hint.setVisible(false); brackets.setVisible(false); this.onReception?.();
      });
      // A small brass service bell sits on the counter when an agent needs the user's input.
      const bell = this.receptionBell = this.add.graphics().setPosition(r.x + 30, base - 20).setDepth(reception.depth + 1);
      bell.fillStyle(0x453726).fillRect(-6, 0, 12, 2).fillRect(-4, -5, 8, 5).fillRect(-2, -7, 4, 2).fillRect(-1, -9, 2, 2);
      bell.fillStyle(0xe5b75d).fillRect(-5, 0, 10, 1).fillRect(-3, -5, 6, 5).fillRect(-1, -6, 2, 1);
      bell.fillStyle(0xffeb9f).fillRect(-3, -4, 2, 3).fillRect(-1, -8, 2, 1);
      this.decor.push(reception, bell); this.updateReception();
      boxes.push(box, entrance.keepOut);
      this.receptionSpot = { x: r.x - 10, y: base + 2 };
      this.receptionDesk = { x: r.x, y: base };
      this.entrance = entrance.entrance;
      this.outside = entrance.outside;
      this.wander.landing = entrance.outside;   // new arrivals start out on the landing, the way leavers go
      floor.push({ x: box.x, y: base - 14, w: box.w, h: 16 });
    }
    this.roomGeometry = { W, H, floor: [...floor], bounds: [...boxes] };
    this.placeDecor(boxes, W, H, floor);
    this.wander.setGrid(W, H, floor);
    this.placeRegulars();
    if (this.model.studio) boxes.push(...this.furnishings.bounds());
    // Where the camera may look. Not the floor's bounding box: the floor is a diamond, so that
    // rectangle is a quarter sky, and panning to its corners filled half the screen with nothing.
    // The clusters and the reception are what there is to look at, so the view stays over them.
    this.updateViewBounds(boxes);
    this.roomPx = { w: maxX - minX, h: maxY - minY + wallH + 26 };   // the tower below is backdrop, not part of the room's frame
    this.roomBounds = { x: minX, y: minY - wallH, w: this.roomPx.w, h: this.roomPx.h };
    this.cameras.main.setBackgroundColor(th.sky);
    this.daylight?.layout();
    this.roomCentre = { x: (minX + maxX) / 2, y: (minY - wallH + maxY + 26) / 2 };
    this.zoom = this.chooseZoom();
    this.cameras.main.setZoom(this.zoom);
    // The room is rebuilt whenever the layout changes — an agent joining can do it — so hold the
    // view the person had rather than yanking it back to the middle each time. Only the first
    // build, when there is nothing to hold, starts at the centre.
    const cam = this.cameras.main;
    const keep = this.framed
      ? this.camCentre()
      : (this.viewBounds
          ? { x: this.viewBounds.x + this.viewBounds.w / 2, y: this.viewBounds.y + this.viewBounds.h / 2 }
          : this.roomCentre);
    this.framed = true;
    const at = this.clampCameraCentre(keep.x, keep.y);
    cam.centerOn(at.x, at.y);
    if (this.wholeOfficeView) this.applyOfficeFit();
  }

  /** Place the office's props.
   *
   *  The seed decides which props appear and where, but not from a uniform scatter: furniture
   *  dropped anywhere on the floor reads as debris. The game puts its loose furniture where
   *  furniture goes — backed against the walls, and tucked into the crossings of the aisles
   *  between desk banks — so those are the only spots offered, and the seed shuffles them and
   *  fills as many as fit. Big pieces take the walls, plants take the aisles.
   *
   *  Overlap is tested in screen space, not tiles: a pod is ~100px of desk, monitor, chair and
   *  occupant hanging off a single tile, so a tile footprint is far too coarse to keep a plant
   *  out of somebody's desk. */
  private placeDecor(pods: Rect[], W: number, H: number, floor: Rect[]) {
    if (this.model.studio) {
      this.furnishings.build(this.model.studio, this.props, pods, W, H, this.pods.map(p => ({ id: p.project, col: p.col, row: p.row, pairs: p.pairs })), this.seed);
      floor.push(...this.furnishings.footprints());
      this.wander.spots = this.furnishings.hangouts();
      return;
    }
    if (!this.props.length) return;

    // the spots furniture may stand in, in tiles
    // Two lanes along each of the four edges — the inner one catches the overflow where a pod
    // crowds the wall — plus the crossings of the aisles between pods. The nearest lane starts at
    // 2 tiles so even the tallest prop stays under the top edge of the back wall.
    const spots: { x: number; y: number; wall: boolean; rank: number }[] = [];
    const STEP = 2;   // offer plenty; the gap test below is what actually spaces them
    for (const inset of [2, 4]) {
      for (let c = inset; c <= W - inset - 1; c += STEP) {
        spots.push({ x: c, y: inset, wall: true, rank: inset });              // back wall
        spots.push({ x: c, y: H - 1 - inset, wall: true, rank: inset });      // front edge
      }
      for (let r = inset; r <= H - inset - 1; r += STEP) {
        spots.push({ x: inset, y: r, wall: true, rank: inset });
        spots.push({ x: W - 1 - inset, y: r, wall: true, rank: inset });
      }
    }
    for (let r = 0; r <= Math.ceil(H / POD_PITCH); r++) for (let c = 0; c <= Math.ceil(W / POD_PITCH); c++)
      spots.push({ x: MARGIN + c * POD_PITCH - 2, y: MARGIN + r * POD_PITCH - 2, wall: false, rank: 3 });

    // a prop stands on its tile: origin (0.5, 1) at the tile's bottom point
    const foot = (prop: Prop, x: number, y: number): Rect => {
      const p = iso(x, y);
      return { x: p.x - prop.w / 2, y: p.y + TH / 2 - prop.h, w: prop.w, h: prop.h };
    };
    // screen point back to tile: x = (c-r)*TW/2, y = (c+r)*TH/2
    const inRoom = (px: number, py: number) => {
      const c = px / TW + py / TH, r = py / TH - px / TW;
      return c >= 0 && c <= W && r >= 0 && r <= H;
    };
    // Only the prop's base has to be on the floor: it stands there, and its art rises off the
    // back of the tile the way a wall does, so testing its top corners would reject every prop
    // tall enough to be worth drawing.
    const clear = (b: Rect) => {
      const base = b.y + b.h;
      return inRoom(b.x, base) && inRoom(b.x + b.w, base)
        && !pods.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
    };

    const rand = rng(this.seed);
    for (let i = spots.length - 1; i > 0; i--) {   // seeded shuffle, so the same office repeats
      const j = Math.floor(rand() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    spots.sort((a, b) => a.rank - b.rank);   // fill against the walls first, then work inward
    const wallProps = this.props.filter((p) => p.zone === 'wall' || (!p.zone && p.w >= 45));
    const aisleProps = this.props.filter((p) => p.zone === 'aisle' || (!p.zone && p.w < 45));
    const taken: Rect[] = [];
    const pad = 6;
    const hangouts: Spot[] = [];
    for (const spot of spots) {
      const preferred = spot.wall ? wallProps : aisleProps;
      const pool = preferred.length ? preferred : this.props;
      const prop = pool[Math.floor(rand() * pool.length)];
      const box = foot(prop, spot.x, spot.y);
      const p = iso(spot.x, spot.y);
      const base = p.y + TH / 2;
      if (!clear(box)) continue;
      if (taken.some((t) => box.x < t.x + t.w + pad && box.x + box.w + pad > t.x
        && box.y < t.y + t.h + pad && box.y + box.h + pad > t.y)) {
        // no room for furniture here, so it is floor: somewhere to stand instead
        if (clear(foot({ id: '', w: 12, h: 12 }, spot.x, spot.y))) hangouts.push({ x: p.x - 8, y: base - 20 });
        continue;
      }
      taken.push(box);
      this.decor.push(this.add.image(p.x, base, `decor:${prop.id}`).setOrigin(0.5, 1).setDepth(floorDepth(base - 12) - 1));
      floor.push({ x: box.x, y: base - 12, w: box.w, h: 14 });   // the prop stands on its bottom rows
      hangouts.push({ x: p.x - 8, y: base + 16 - 20 });   // standing in front of it
    }
    this.wander.spots = hangouts;
  }



  /** Swap the office's look. The carpet is a different texture and every colour changes, so the
   *  room is rebuilt; desks and agents are re-seated from the model by sync(). */
  private themeRequest = 0;
  async setTheme(id: string) {
    const request = ++this.themeRequest, theme = themeById(id);
    try { await ensureTheme(this.textures, theme); }
    catch { return; } // keep the current complete theme if a request fails
    if (request !== this.themeRequest) return;
    this.theme = theme;
    saveTheme(this.theme.id);
    this.layoutKey = '';        // force buildRoom on the next sync
    this.sync();
  }

  private layoutStructure(layout: { cols: number; rows: number; placed: Placement[] }) {
    return `${layout.cols}x${layout.rows}|` + layout.placed.map(p => `${p.pod.project}@${p.col},${p.row}:${p.pod.seats.length}`).join(';');
  }
  private updateViewBounds(boxes: Rect[]) {
    if (!boxes.length) { this.viewBounds = null; return; }
    const pad = 56;
    const x0 = Math.min(...boxes.map(b => b.x)) - pad, x1 = Math.max(...boxes.map(b => b.x + b.w)) + pad;
    const y0 = Math.min(...boxes.map(b => b.y)) - pad, y1 = Math.max(...boxes.map(b => b.y + b.h)) + pad;
    this.viewBounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** The saved draft is already on screen. Keep its sprites and desks, and update walking paths.
   * Concurrent arrivals or a different saved layout still use the normal rebuild. */
  finishArrangement() {
    const state = this.model.studio, layout = this.model.layout(), geometry = this.roomGeometry;
    const saved = state?.room.items, draft = this.furnishings.savedItems();
    const matches = saved?.length === draft.length && saved.every((item, i) => {
      const other = draft[i];
      return item.id === other.id && item.kind === other.kind
        && (item.kind !== 'decor' || item.asset === other.asset)
        && (item.kind !== 'whiteboard' || item.project === other.project)
        && item.x === other.x && item.y === other.y;
    });
    this.furnishings.stopEdit();
    if (!state || !geometry || !matches || this.model.hasDepartures || this.layoutStructure(layout) !== this.roomPlanKey) {
      this.refreshRoom(); return;
    }
    this.adoptArrangement();
  }
  /** Cancelling only replaces furnishings when the desk arrangement is unchanged. */
  cancelArrangement() {
    const state = this.model.studio, geometry = this.roomGeometry;
    this.furnishings.stopEdit();
    if (!state || !geometry || this.model.hasDepartures || this.layoutStructure(this.model.layout()) !== this.roomPlanKey) {
      this.refreshRoom(); return;
    }
    this.furnishings.build(state, this.props, geometry.bounds, geometry.W, geometry.H,
      this.pods.map(p => ({ id: p.project, col: p.col, row: p.row, pairs: p.pairs })), this.seed);
    this.adoptArrangement();
  }
  private adoptArrangement() {
    const geometry = this.roomGeometry!;
    this.wander.clear();
    this.wander.setGrid(geometry.W, geometry.H, [...geometry.floor, ...this.furnishings.footprints()]);
    this.wander.spots = this.furnishings.hangouts();
    this.updateViewBounds([...geometry.bounds, ...this.furnishings.bounds()]);
    this.placeRegulars();
    this.layoutKey = this.roomPlanKey + JSON.stringify([true, this.model.studio!.room.items]);
    this.sync();
    this.renderBudget?.boost();
  }
  refreshRoom() { this.layoutKey = ''; this.sync(); }
  /** Tidy the room: the planner's arrangement replaces the current one as an unsaved draft. */
  regenerateRoom() { this.furnishings.regenerate(); this.wander.spots = this.furnishings.hangouts(); }
  /** Fit is reversible: keep the view from before the first fit, even across a room rebuild. */
  fitOffice() {
    if (!this.previousView) this.previousView = { ...this.camCentre(), zoom: this.cameras.main.zoom };
    this.applyOfficeFit();
    this.onViewModeChange?.(true);
  }
  toggleOfficeView() {
    if (!this.previousView) { this.fitOffice(); return; }
    this.restoreOfficeView();
  }
  private restoreOfficeView() {
    const view = this.previousView;
    if (!view) return;
    this.previousView = undefined;
    const cam = this.cameras.main;
    cam.panEffect.reset();
    this.zoom = view.zoom;
    cam.setZoom(view.zoom);
    const centre = this.clampCameraCentre(view.x, view.y);
    cam.centerOn(centre.x, centre.y);
    this.onViewModeChange?.(false);
  }
  private applyOfficeFit() {
    // Replay's overview includes the complete room walls, not just the desk bounds.
    const b = this.fitOnCreate ? this.roomBounds : this.viewBounds ?? this.roomBounds, cam = this.cameras.main;
    const zoom = Math.max(this.fitOnCreate ? 0.1 : 0.3, Math.min(2, (cam.width - 36) / b.w, (cam.height - 140) / b.h));
    cam.panEffect.reset(); cam.zoomEffect.reset();
    this.zoom = zoom;
    cam.setZoom(zoom).centerOn(b.x + b.w / 2, b.y + b.h / 2);
  }
  projectOrder() { return this.placed.map(p => p.pod.project); }
  previewProjectOrder(order: string[]) {
    const original = this.model.studio; if (!original) return;
    const items = this.furnishings.savedItems();
    this.furnishings.stopEdit();
    this.model.studio = { ...original, room: { ...original.room, items, projectOrder: order } };
    this.refreshRoom(); this.model.studio = original; this.furnishings.startEdit();
  }

  /** Follow an actor as they work or walk. Passing no ID releases the camera. */
  followAgent(paneId?: string) {
    this.followedPane = paneId;
    if (paneId) {
      this.restoreOfficeView();
      this.cameras.main.panEffect.reset();
    }
  }

  /** Take the camera to an agent's desk (or wherever they are standing), and point them out
   *  once it is there. */
  focus(paneId: string) {
    const st = this.byPane.get(paneId); if (!st) return false;
    this.restoreOfficeView();
    const ms = this.glideTo(st.person.x + 8, st.person.y);
    if (!this.presentationPaused) this.pointAt(st, ms);
    return true;
  }

  /** Move the view somewhere the person asked for. It leaves on the first frame and lands softly,
   *  quicker for a short trip, and a new request takes over from one still under way. Behind a
   *  window nothing would draw the trip, and with motion reduced nothing should, so there it is a
   *  cut. Returns how long the trip takes. */
  private glideTo(x: number, y: number) {
    const cam = this.cameras.main, from = this.camCentre(), to = this.clampCameraCentre(x, y);
    this.renderBudget?.boost();
    if (this.presentationPaused || reducedMotion()) {
      cam.panEffect.reset(); cam.centerOn(to.x, to.y);
      if (this.presentationPaused) this.settleFrame();
      return 0;
    }
    const ms = Phaser.Math.Clamp(120 + Math.hypot(to.x - from.x, to.y - from.y) * cam.zoom * 0.2, 140, 320);
    cam.pan(to.x, to.y, ms, Phaser.Math.Easing.Cubic.Out, true);   // v4 takes the function, not the name
    return ms;
  }

  /** Replay direction uses the recorded actor, or the payment counter. */
  frameReplay(paneId?: string) {
    const st = paneId ? this.byPane.get(paneId) : undefined;
    if (paneId && !st) return;
    this.followedPane = undefined;
    this.previousView = undefined;
    const cam = this.cameras.main;
    const point = st ? { x: st.person.x + 8, y: st.person.y } : this.receptionSpot;
    this.zoom = Math.min(2, Math.max(1, cam.width / 520));
    const reduced = this.presentationPaused || reducedMotion();
    cam.zoomTo(this.zoom, reduced ? 0 : 700, Phaser.Math.Easing.Sine.InOut, true);
    cam.pan(point.x, point.y + cam.height * 0.18 / this.zoom, reduced ? 0 : 700, Phaser.Math.Easing.Sine.InOut, true);
    this.renderBudget?.boost(900);
  }

  /** Centre the whole project's desk bank, including its unoccupied desks. */
  focusProject(project: string) {
    const pod = this.pods.find(p => p.project === project); if (!pod) return false;
    this.restoreOfficeView();
    this.stopPointing();
    const b = pod.bounds;
    this.glideTo(b.x + b.w / 2, b.y + b.h / 2);
    return true;
  }

  /** The world point currently in the middle of the screen.
   *
   *  Phaser measures scroll as though the camera were at zoom 1 — zoom is applied about the view's
   *  centre — so the middle is scroll + width/2 at any zoom, while the visible world is only
   *  width/zoom across. Mixing the two up puts the camera half a screen out at 2x, which is what
   *  the clamp and the drag used to do; it stayed invisible while the office ran at zoom 1. */
  private camCentre() {
    const c = this.cameras.main;
    return { x: c.scrollX + c.width / 2, y: c.scrollY + c.height / 2 };
  }

  /** Keep a camera centre within the actual room. When the viewport is larger than the room on
   *  one axis, lock that axis to the room centre instead of allowing empty sky on either side. */
  private clampCameraCentre(x: number, y: number) {
    const cam = this.cameras.main, b = this.viewBounds ?? this.roomBounds;
    if (!b.w || !b.h) return { x, y };
    const vw = cam.width / cam.zoom, vh = cam.height / cam.zoom;
    const axis = (value: number, start: number, size: number, view: number) => view >= size
      ? start + size / 2
      : Phaser.Math.Clamp(value, start + view / 2, start + size - view / 2);
    // The desks lie in a diamond, not a rectangle: its corners are the only places where far east
    // and far south are both possible, and there is no floor there — just tower and sky. Pull the
    // centre back onto the diamond, so travelling east also brings the view to the middle band.
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let u = (x - cx) / (b.w / 2), v = (y - cy) / (b.h / 2);
    const m = Math.abs(u) + Math.abs(v);
    if (m > 1) { u /= m; v /= m; }
    return { x: axis(cx + u * b.w / 2, b.x, b.w, vw), y: axis(cy + v * b.h / 2, b.y, b.h, vh) };
  }

  /** One fixed scale, held.
   *
   *  This used to shrink until the whole room fitted on screen, which sounds right and is not: an
   *  isometric room is 2:1 and grows with the agent count, so thirty agents make a floor about
   *  1000px wide, and no laptop fits that at 2x. The office silently dropped to 1x and everybody
   *  in it was 24px tall. Sprites drawn at their own size are the point of the art, so the scale
   *  is fixed instead and a large office simply extends past the window — drag to look around,
   *  clamped to the room. ?zoom=N overrides for a screenshot or a wall display. */
  private chooseZoom() {
    if (this.forcedZoom) return this.forcedZoom;
    // Below this a 2x office shows too little to read; a phone gets the whole room instead.
    return this.scale.width < 600 ? 1 : 2;
  }

  private updateReception() {
    const waiting = [...this.model.agents.values()].filter(a => a.agent_status === 'blocked').length;
    this.receptionBell?.setVisible(waiting > 0);
    // Someone new needs the owner: the bell on the counter they triage from gives a ring. Not on
    // the first sync, and not out of sight, where it would only play late.
    const bell = this.receptionBell;
    if (bell && this.waiting !== undefined && waiting > this.waiting && !this.unseen && !reducedMotion() && !this.tweens.isTweening(bell)) {
      const home = bell.x;
      this.tweens.add({ targets: bell, x: home + 1, duration: 50, yoyo: true, repeat: 3, ease: 'Stepped', onComplete: () => bell.setX(home) });
    }
    this.waiting = waiting;
    this.receptionHint?.setText(`Reception · ${waiting ? `${waiting} ${waiting === 1 ? 'person needs' : 'people need'} you` : 'How can I help?'}\nClick to open the front desk`);
  }

  private placeRegulars() {
    this.regulars ??= new OfficeRegulars(this, this.wander, {
      canInteract: () => this.canInteract() && !this.furnishings.editing,
      onCat: this.onCat ? () => this.onCat?.() : undefined, onJanitor: this.onJanitor ? () => this.onJanitor?.() : undefined,
      desks: () => this.pods.flatMap(p => p.stations).sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working')).map(st => {
        const box = st.floorBox();
        // A cat is too short to be visible on the staff's tile behind a monitor. Its naps and
        // Gus's sweeping stops belong in the aisle in front of the chair footprint.
        return { x: box.x + box.w / 2 - 8, y: box.y + box.h - 4 };
      }),
    });
    this.regulars.rebuild(this.receptionSpot);
  }

  /** A Stripe event, played out on the floor.
   *
   *  Money arrives at reception, so that is where it lands: a coin and the amount rise off the
   *  front desk, and whoever is nearest looks up and says something about it. Game Dev Story does
   *  the same thing with its sales reports — the number matters more when the office reacts to it.
   *
   *  Sound goes through the shared cues, so a burst of Stripe events cannot turn into a burst of
   *  noise; the coin still rises every time. */
  /** Money news. A payment is a customer: they walk in over the landing with the coin over their
   *  head, hand it over at reception, and only then does the till ring, the coins fly and the
   *  floor look up. Everything else (refunds, failures, trials) still lands at the counter at
   *  once. `describe` resolves to who paid for what, when the bridge knows; `onPaid` fires at the
   *  moment of the till so the party, the HUD and the sound line up. */
  money(ev: MoneyEvent, options: { describe?: () => Promise<string>; onPaid?: (line: string) => void; immediate?: boolean } = {}) {
    if ((window as any).__quiet) { options.onPaid?.(''); return; }
    const up = ev.kind === 'sale' || ev.kind === 'subscribed';
    const canWalk = !options.immediate && up && (this.receptionSpot.x || this.receptionSpot.y) && !reducedMotion();
    const line = options.describe?.().catch(() => '') ?? Promise.resolve('');
    if (!canWalk) { void line.then(text => { this.payAt(ev, text); options.onPaid?.(text); }); return; }
    // The counter goes low in the view, clear of the card that lands in the middle of it.
    this.peekAt(this.receptionSpot.x + 20, this.receptionSpot.y - 30, 6500, 0.22);
    void this.visit('customer', customerLine(ev), (here) => {
      this.visitor?.pay();
      void line.then(text => { this.payAt(ev, text, here); options.onPaid?.(text); });
    });
  }

  cancelReplayCustomer() {
    this.replayVisit++;
    this.replayCustomerTimer?.remove(); this.replayCustomerTimer = undefined;
    this.sayAtTill();
    this.replayCustomer?.destroy(); this.replayCustomer = undefined;
  }

  /** An isolated, cancellable arrival driven by the replay scene clock. */
  async replayPayment(ev: MoneyEvent, onPaid: () => void) {
    this.cancelReplayCustomer();
    const token = this.replayVisit;
    const valid = () => token === this.replayVisit && this.sys.isActive();
    const pay = (answering = false) => { if (valid()) { this.payAt(ev, ev.label, answering); onPaid(); } };
    if (reducedMotion() || !(this.receptionSpot.x || this.receptionSpot.y)) { pay(); return; }
    let customer: Visitor;
    // Each payment gets its own face and outfit; seeking/replaying keeps that casting.
    const appearance = lookFor(`customer:${ev.source ?? 'stripe'}:${ev.id}`);
    try { customer = await Visitor.create(this, 'customer', this.outside, appearance); }
    catch { pay(); return; }
    if (!valid()) { customer.destroy(); return; }
    this.replayCustomer = customer;
    const door = { ...this.entrance }, start = { ...this.outside };
    const desk = { x: this.receptionSpot.x + 22, y: this.receptionSpot.y - 6 };
    const path = [door, ...(this.wander.pathTo(door, desk) ?? [desk])];
    customer.walk(path, false, () => {
      if (!valid()) return;
      customer.pay(); this.sayAtTill(customerLine(ev), customer.node.x + 6, customer.node.y - 8, OfficeScene.CUSTOMER_LINE_MS); pay(true);
      this.replayCustomerTimer = this.time.delayedCall(2200, () => {
        if (!valid()) return;
        const path = [...(this.wander.pathTo(desk, door) ?? [door]), start];
        customer.walk(path, true, () => {
          if (this.replayCustomer === customer) this.replayCustomer = undefined;
          customer.destroy();
        }, 1600);
      });
    }, 2400);
  }

  /** How long a customer's line stands at the counter before the receptionist answers it. */
  private static readonly CUSTOMER_LINE_MS = 1300;

  /** One line at a time at the counter, in front of the coins the payment sets flying, which are
   *  themselves in front of everything else. When a line has had its time, its reply follows. With
   *  no text this just clears the counter, reply and all. */
  private sayAtTill(text = '', x = 0, tipY = 0, ms = 0) {
    this.tillLine?.timer.remove(); this.tillLine?.bubble.destroy(); this.tillLine = undefined;
    if (!text) return;
    const bubble = speechBubble(this, x, tipY, text, OVER_LIGHT + 3);
    this.tillLine = { bubble, timer: this.time.delayedCall(ms, () => { const reply = this.tillLine?.reply; this.sayAtTill(); reply?.(); }) };
  }

  /** The till. `answering` is true when a customer has just spoken at the counter. */
  private payAt(ev: MoneyEvent, described: string, answering = false) {
    this.renderBudget?.boost(2500);
    if (!isCashEvent(ev)) {
      const at = this.receptionSpot.x || this.receptionSpot.y ? this.receptionSpot : this.roomCentre;
      const notice = speechBubble(this, at.x + 8, at.y - 45, billingLabel(ev.kind), floorDepth(at.y) + 4000);
      this.time.delayedCall(3000, () => notice.destroy());
      return;
    }
    const up = ev.kind === 'sale' || ev.kind === 'subscribed';
    const neutral = ev.kind === 'trial_started' || ev.kind === 'subscription_started' || ev.kind === 'subscription_pending' || ev.kind === 'subscription_resumed';
    const at = this.receptionSpot.x || this.receptionSpot.y ? this.receptionSpot : this.roomCentre;
    const text = ev.amount ? gameCurrency.display(ev.amount, ev.currency) : '';
    const label = ev.kind === 'trial_started' ? 'new trial'
      : ev.kind === 'subscription_pending' ? 'sub pending'
      : ev.kind === 'subscription_started' ? 'new sub'
      : ev.kind === 'subscription_resumed' ? 'sub resumed'
      : ev.kind === 'expired' ? 'sub expired'
      : up ? (text ? `+${text}` : 'new paid sub')
      : ev.kind === 'failed' ? 'payment failed'
      : ev.kind === 'dispute' ? 'disputed'
      : ev.kind === 'refund' ? (text ? `-${text}` : 'refund') : 'cancelled';
    const colour = up ? '#136c34' : neutral ? '#245f82' : '#a1281f';

    // Money arriving is the point of the place, so it gets a shower of coins rather than one, and
    // the whole nearby desk row looks up. Anything else keeps the single coin it always had.
    const big = up && (Math.abs(ev.amount) >= 20 || ev.kind === 'subscribed');
    const coins = up ? Math.min(14, 4 + Math.floor(Math.abs(ev.amount) / 10)) : 1;
    // Coins and the amount go in front of the daylight sheet: at night the office dims, the money
    // does not. Each coin lands, rises in full view, and is gone at the top of its climb.
    const still = reducedMotion();
    for (let i = 0; i < coins; i++) {
      const spread = coins === 1 ? 0 : Phaser.Math.Between(-40, 40);
      const c = this.add.image(at.x - 10 + spread, at.y - 26, 'main00', 'coin').setOrigin(0.5, 1).setDepth(OVER_LIGHT);
      const delay = still ? 0 : i * 70;
      if (!still) {
        c.setScale(0.6).setAlpha(i ? 0 : 1);
        this.tweens.add({ targets: c, scale: 1, alpha: 1, duration: POP_MS, delay, ease: 'Back.out' });
        this.tweens.add({ targets: c, y: `-=${Phaser.Math.Between(20, 42)}`, delay: delay + 500, duration: 700, ease: 'Quad.out' });
      }
      floatOff(this, c, delay + 1200, 6);
    }
    // The amount stays down by the counter: the space above it is where the till's lines are said.
    const note = this.add.text(at.x + 8, at.y - 26, label, { fontFamily: 'DotGothic16',
      fontSize: big ? '16px' : up ? '14px' : '11px', color: colour, stroke: '#ffffff', strokeThickness: 3 })
      .setOrigin(0, 1).setDepth(OVER_LIGHT + 1).setResolution(2);
    popIn(this, note, big ? 0.5 : 0.6);
    floatOff(this, note, 1700);
    // The receptionist announces who it was, when the bridge could say. A customer standing at
    // the counter has only just spoken, so she answers them rather than talking over them.
    if (described && (this.receptionDesk.x || this.receptionDesk.y)) {
      const answer = () => this.sayAtTill(described, this.receptionDesk.x + 12, this.receptionDesk.y - 44, answering ? 3200 : 4200);
      if (answering && this.tillLine) this.tillLine.reply = answer; else answer();
    }

    // Who notices. One person for ordinary news; for a payment, the few nearest reception, so it
    // travels across the floor instead of being one quiet bubble in the corner. A real payment
    // gets the whole floor on its feet.
    const crowd = this.pods.flatMap((p) => p.stations).filter((st) => st.agent && !st.away);
    const byDistance = crowd.sort((a, b) =>
      Math.hypot(a.person.x - at.x, a.person.y - at.y) - Math.hypot(b.person.x - at.x, b.person.y - at.y));
    const cheering = byDistance.slice(0, up ? 3 : 1);
    const CHEERS = ['ka-ching!', 'nice!', 'woo!', 'sold!'], first = Phaser.Math.Between(0, CHEERS.length - 1);
    cheering.forEach((st, i) => {
      // the nearest reads out the amount, and no two of the rest say the same thing
      const line = up ? (i === 0 && text ? `${text}!` : CHEERS[(first + i) % CHEERS.length])
        : neutral ? label : `${label}\u2026`;
      // staggered, so it reads as one after another noticing rather than a chorus
      if (i === 0) st.say(line, 2600);
      else this.time.delayedCall(i * 260, () => st.say(line, 2200));
    });
    // The till rings on its own; a payday's fanfare belongs to its card, a beat behind the ring.
    if (up) audio.play('cash');
    else audio.play(neutral ? 'points' : 'sad');
    if (big) { this.cheerAll(); this.confetti(); }
    if (ev.kind === 'failed' || ev.kind === 'dispute') this.boom(at.x + 6, at.y - 6);
  }

  /** Everyone seated stands up and cheers, front row first, like the game's staff on a hit. */
  cheerAll(ms = 1900) {
    const seated = this.pods.flatMap((p) => p.stations).filter((st) => st.agent && !st.away).sort((a, b) => b.person.y - a.person.y);
    seated.forEach((st, i) => this.time.delayedCall(Math.min(600, i * 45), () => st.cheerFor(ms)));
  }

  /** Confetti over the whole view, pinned to the screen so it falls wherever the camera is. */
  confetti(count = 70) {
    if (reducedMotion()) return;
    const colours = ['#f2c94c', '#e8608a', '#5cc7f0', '#7ad37a', '#ffffff', '#f29d4c'];
    if (!this.textures.exists('confetti-px')) {
      // Tint does nothing on the canvas renderer, so each colour is a frame of one small sheet.
      const sheet = this.textures.createCanvas('confetti-px', colours.length * 3, 3)!;
      colours.forEach((colour, i) => { sheet.context.fillStyle = colour; sheet.context.fillRect(i * 3, 0, 3, 3); sheet.add(i, 0, i * 3, 0, 3, 3); });
      sheet.refresh();
    }
    const view = this.cameras.main.worldView;
    for (let i = 0; i < count; i++) {
      const size = Phaser.Math.FloatBetween(0.8, 1.6), top = view.y - Phaser.Math.Between(4, view.height / 2);
      const bit = this.add.image(view.x + Phaser.Math.Between(0, view.width), top, 'confetti-px', i % colours.length).setDepth(OVER_LIGHT + 2).setScale(size);
      // A square of paper turns edge-on and back as it falls: two widths, stepped, never a spin.
      this.tweens.add({ targets: bit, y: view.bottom + 8, x: bit.x + Phaser.Math.Between(-30, 30),
        duration: Phaser.Math.Between(1600, 2800), delay: Phaser.Math.Between(0, 700), ease: 'Sine.in',
        onUpdate: () => bit.setScale(Math.floor((bit.y - top) / 12 + i) % 2 ? size * 0.4 : size, size), onComplete: () => bit.destroy() });
    }
  }

  /** Glance at a spot that is off-screen, then come back, unless the person starts dragging.
   *  `low` puts the spot that fraction of the view below the middle. The glance does not leave
   *  while someone at the counter is still speaking, or while main says what it went to see is
   *  still up (holdPeek). */
  peekAt(x: number, y: number, ms = 5000, low = 0) {
    const cam = this.cameras.main;
    if (this.wholeOfficeView || this.followedPane || this.dragging || this.peekReturn || reducedMotion()) return;
    const view = cam.worldView, margin = 24 / cam.zoom;
    if (x > view.x + margin && x < view.right - margin && y > view.y + margin && y < view.bottom - margin) return;
    const from = this.camCentre();
    const target = this.clampCameraCentre(x, y - low * view.height);
    cam.pan(target.x, target.y, 650, 'Sine.easeInOut');
    let held = 0;
    const back = () => {
      const peek = this.peekReturn; if (!peek) return;
      if ((this.tillLine || this.holdPeek()) && held < 12_000) { held += 400; peek.timer = this.time.delayedCall(400, back); return; }
      this.peekReturn = undefined;
      if (!this.dragging && !this.wholeOfficeView && !this.followedPane) cam.pan(from.x, from.y, 650, 'Sine.easeInOut');
    };
    this.peekReturn = { x: from.x, y: from.y, timer: this.time.delayedCall(ms, back) };
  }

  /** The game's explosion (event6) over a spot on the floor: a flash, the blast, then smoke that
   *  drifts up and thins out, with a small camera jolt. */
  boom(x: number, y: number) {
    if ((window as any).__quiet) return;
    this.renderBudget?.boost(1600);
    const depth = walkerDepth(y) + 3000;
    const flash = this.add.image(x, y, 'boom0').setOrigin(0.5, 1).setDepth(depth);
    if (!reducedMotion()) this.cameras.main.shake(160, 0.004);
    this.time.delayedCall(110, () => {
      flash.destroy();
      const blast = this.add.image(x, y + 4, 'boom1').setOrigin(0.5, 1).setDepth(depth);
      popIn(this, blast, 0.7);
      this.time.delayedCall(320, () => {
        blast.destroy();
        const smoke = this.add.image(x, y - 6, 'boom2').setOrigin(0.5, 1).setDepth(depth).setAlpha(0.9);
        this.tweens.add({ targets: smoke, y: y - 30, alpha: 0, scale: 1.3, duration: 900, ease: 'Quad.out', onComplete: () => smoke.destroy() });
      });
    });
    const near = this.pods.flatMap((p) => p.stations).filter((st) => st.agent && !st.away)
      .sort((a, b) => Math.hypot(a.person.x - x, a.person.y - y) - Math.hypot(b.person.x - x, b.person.y - y))[0];
    if (near) this.time.delayedCall(400, () => near.say(['yikes!', 'uh oh', '!!'][Phaser.Math.Between(0, 2)], 2000));
  }

  /** For the test-events tray: drop one seated agent, or blow something up at reception. */
  previewCollapse(paneId?: string) { (paneId ? this.byPane.get(paneId) : this.pods.flatMap((p) => p.stations).find((st) => st.agent && !st.away))?.collapse(); }
  previewBoom() { const at = this.receptionSpot.x || this.receptionSpot.y ? this.receptionSpot : this.roomCentre; this.boom(at.x + 6, at.y - 6); }

  /** One long stretch of work per person gets the crunch scene, once. */
  private checkCrunch() {
    if (!this.onCrunch) return;
    const now = Date.now();
    for (const p of this.pods) for (const st of p.stations) {
      if (st.status !== 'working' || !st.agent || !st.workingSince || st.crunchNoted) continue;
      if (now - st.workingSince < OfficeScene.CRUNCH_MS) continue;
      st.crunchNoted = true;
      this.onCrunch(st.agent, now - st.workingSince);
    }
  }

  /** A visitor comes in over the landing, says their piece at reception, and leaves. One in the
   *  room at a time; the rest wait on the landing, a short queue at most. `onArrive` fires at the
   *  counter, before they speak: a customer hands their coin over there. */
  async visit(kind: VisitorKind, line: string, onArrive?: (here: boolean) => void) {
    if ((window as any).__quiet || !(this.receptionSpot.x || this.receptionSpot.y)) { onArrive?.(false); return; }
    if (this.visitor) { if (this.visitors.length < 4) this.visitors.push({ kind, line, onArrive }); else onArrive?.(false); return; }
    const start = { ...this.outside }, door = { ...this.entrance }, desk = { x: this.receptionSpot.x + 22, y: this.receptionSpot.y - 6 };
    let visitor: Visitor;
    try { visitor = await Visitor.create(this, kind, start); } catch { onArrive?.(false); return; }
    if (this.visitor) { visitor.destroy(); if (this.visitors.length < 4) this.visitors.push({ kind, line, onArrive }); else onArrive?.(false); return; }
    this.visitor = visitor;
    const inward = [door, ...(this.wander.pathTo(door, desk) ?? [desk])];
    const finish = () => {
      if (this.visitor === visitor) this.visitor = undefined;
      visitor.destroy();
      const next = this.visitors.shift();
      if (next) void this.visit(next.kind, next.line, next.onArrive);
    };
    visitor.walk(inward, false, () => {
      onArrive?.(true);
      // a customer says their piece and then lets the receptionist answer
      if (kind === 'customer') this.sayAtTill(line, visitor.node.x + 6, visitor.node.y - 8, OfficeScene.CUSTOMER_LINE_MS);
      else visitor.say(line, 2800);
      this.time.delayedCall(2900, () => {
        const outward = [...(this.wander.pathTo({ x: visitor.node.x, y: visitor.node.y }, door) ?? [door]), start];
        visitor.walk(outward, true, finish);
      });
    });
  }

  /** Pop a reaction on a station when an event arrives (called from main). */
  react(ev: OfficeEvent, levelUp = 0, gained?: WorkKind) {
    this.renderBudget?.boost(1600);
    if (ev.kind === 'left') { void this.depart(ev.pane_id); return; }
    if (this.model.isDeparting(ev.pane_id)) return;
    const st = this.byPane.get(ev.pane_id);
    if (ev.kind === 'joined') {
      // the desk may not exist yet if the event beat the agent list; sync() picks it up then
      if (st) this.wander.enter(st, this.entrance, this.time.now); else this.arrivals.add(ev.pane_id);
    }
    if (!st) return;
    // Behind a window nothing is drawn, and every bubble, pop and banner made there would play at
    // once when it closed. So out of sight the floor keeps its poses current and its questions
    // up, sounds as it always did, and saves only a level-up to show later.
    const unseen = this.unseen;
    st.setLevel(this.model.levelOf(ev.pane_id));
    // Asked for first, so the fanfare has the floor before this turn's everyday cues.
    if (levelUp) audio.play('levelup');
    // The agent list may have brought this status in already; doing it twice restarts its entrance.
    if (ev.kind === 'status' && (st.status !== ev.status || !st.entered)) st.setStatus(ev.status, true);
    if (!unseen && ev.kind === 'status' && ev.status === 'blocked' && /\b(error|exception|traceback|panic|fatal|crash)/i.test(ev.snippet ?? '')) this.boom(st.pc.x + 25, st.pc.y + 14);
    // back from a long haul: they drop where they sit before the next thing
    if (ev.kind === 'status' && ev.prev === 'working' && (ev.prev_for_ms ?? 0) >= OfficeScene.CRUNCH_MS && (ev.status === 'done' || ev.status === 'idle')) st.collapse();
    if (!unseen || ev.status === 'blocked') st.announce(ev);   // the event knows the title that changed and what the pane last said
    if (levelUp && unseen) this.missedLevels.set(ev.pane_id, levelUp);
    else if (levelUp) st.levelUp(levelUp);
    if (gained && !unseen) st.pop(gained, 1, true);
  }

  private depart(paneId: string, delay = 0): Promise<void> {
    const existing = this.departures.get(paneId);
    if (existing) return existing;
    const st = this.byPane.get(paneId);
    if (!st?.agent) return Promise.resolve();
    this.model.beginDeparture(paneId);
    const promise = new Promise<void>(resolve => {
      const finish = () => {
        st.setAgent(null);
        this.departures.delete(paneId);
        this.model.finishDeparture(paneId);
        resolve();
      };
      if (reducedMotion()) queueMicrotask(finish);
      else this.wander.leave(st, this.receptionSpot, this.entrance, this.outside, this.time.now, finish, delay);
    });
    this.departures.set(paneId, promise);
    return promise;
  }

  /** Confirmed closures get a close-up sprite scene while the office stays behind the window. */
  async showDepartures(agents: AgentInfo[]) {
    const selected = [...new Map(agents.map(a => [a.pane_id, a])).values()];
    if (!selected.length || !this.cameras?.main) return;
    const view = { ...this.camCentre(), zoom: this.cameras.main.zoom };
    const ids = new Set(selected.map(a => a.pane_id));
    const walks = selected.map(a => this.depart(a.pane_id));
    try {
      await Promise.all(selected.map(a => ensureAppearance(this.textures, lookOf(a)).catch(() => {})));
      await new DepartureCutscene(this.textures, this.theme).play(selected, id => this.wander.finishDepartures(new Set([id])));
    } finally {
      this.wander.finishDepartures(ids);
      await Promise.all(walks);
      if (this.wholeOfficeView) this.applyOfficeFit();
      else {
        this.zoom = view.zoom; this.cameras.main.setZoom(view.zoom);
        const at = this.clampCameraCentre(view.x, view.y); this.cameras.main.centerOn(at.x, at.y);
      }
    }
  }
}
