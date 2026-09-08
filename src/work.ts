// What kind of work an agent is doing, in the game's terms.
//
// Game Dev Story shows a balloon over every dev while they work — GameForm.DrawObj calls
// DrawFukidashi with HumanDexFukiIndex — and the balloon says which stat they are producing:
// program, graphics, sound, scenario, debugging, promotion. The points that fly out carry the
// matching small icon. Agent task titles usually say what sort of work is happening, so this maps
// one to the other: an agent titled "fix flaky test" debugs, one on "landing page styling" draws.
// That same classification now decides which persistent stat receives a point on completion.
import type { AgentInfo } from '../shared/types';
import { titleOf } from '../shared/types';

export type WorkKind = 'program' | 'graphics' | 'sound' | 'debug' | 'scenario' | 'promo';
export const WORK_KINDS: WorkKind[] = ['program', 'scenario', 'graphics', 'sound', 'debug', 'promo'];

/** Balloon cell on main01, and the small icon on main00 the points use. */
export const WORK: Record<WorkKind, { balloon: number; icon: string; job: number; title: string; stat: string; short: string }> = {
  program:  { balloon: 0, icon: 'gamepad', job: 0, title: 'Coder',          stat: 'Program',   short: 'PGM' },
  graphics: { balloon: 2, icon: 'art',     job: 1, title: 'Designer',       stat: 'Graphics',  short: 'GFX' },
  scenario: { balloon: 5, icon: 'disk',    job: 2, title: 'Writer',         stat: 'Scenario',  short: 'SCN' },
  sound:    { balloon: 3, icon: 'sound',   job: 3, title: 'Sound Engineer', stat: 'Sound',     short: 'SND' },
  promo:    { balloon: 7, icon: 'coin',    job: 5, title: 'Producer',       stat: 'Promotion', short: 'PRM' },
  debug:    { balloon: 4, icon: 'bug',     job: 7, title: 'Hacker',         stat: 'Debug',     short: 'DBG' },
};
/** jobtype.png: eight 42x30 job icons, four to a row, in the game's job order. */
export function jobIconStyle(kind: WorkKind) {
  const j = WORK[kind].job;
  return `background-position:-${(j % 4) * 42}px -${Math.floor(j / 4) * 30}px`;
}

const ICON_POS: Record<WorkKind, [number, number]> = {
  program: [132, 115], scenario: [134, 130], graphics: [168, 114],
  sound: [186, 114], debug: [204, 114], promo: [150, 114],
};
/** Crop a stat icon directly from the game's main UI sheet. */
export function statIconStyle(kind: WorkKind) {
  const [x, y] = ICON_POS[kind];
  return `background-position:-${x}px -${y}px`;
}

const RULES: [WorkKind, RegExp][] = [
  ['debug',    /\b(fix|bug|flaky|fail|crash|regress|debug|repro|broken|error|test|tests|lint|ci)\b/i],
  ['graphics', /\b(css|style|styling|ui|ux|layout|pixel|sprite|art|icon|theme|design|render|animation|mobile)\b/i],
  ['sound',    /\b(audio|sound|music|voice|tts|speech|bgm|sfx)\b/i],
  ['promo',    /\b(readme|blog|launch|release|announce|marketing|landing|changelog|publish|store|growth|churn|viral|onboarding|trials?)\b/i],
  ['scenario', /\b(plan|spec|proposal|rfc|write|draft|scenario|prompt|copy|content|translat\w*|wiki|docs?|strategy|audit|review|research|analysis|milestones?|goals|handoff|comparison)\b/i],
];

export function workKindForTitle(title: string): WorkKind {
  for (const [kind, re] of RULES) if (re.test(title)) return kind;
  return 'program';
}

export function workKindOf(a: AgentInfo | null): WorkKind {
  return workKindForTitle(a ? titleOf(a) : '');
}
