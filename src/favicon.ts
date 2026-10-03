// The tab's icon. This page sits open all day in a row of other tabs, and the title text carrying
// "(2) needs you" is the first thing a narrow tab cuts off; the icon is what is left. Drawn here
// rather than shipped as a file, so a public build without the game's art still has one.
//
// Two states: the office's own desk monitor, and the front desk's bell with a red pip when an
// agent is waiting on you.

type Px = [x: number, y: number, w: number, h: number, colour: string];

const STEEL = '#7b8794', DARK = '#3b4a57', SKY = '#6ec6f2', SHINE = '#d6f1ff', GOLD = '#f5c94b', BRASS = '#b88a32', RED = '#a34b38', CREAM = '#fff8e8';

/** A desk monitor on its stand, the screen the office's sky. 16x16. */
const MONITOR: Px[] = [
  [1, 2, 14, 10, DARK], [2, 3, 12, 8, STEEL], [3, 4, 10, 6, SKY],
  [4, 5, 3, 1, SHINE], [4, 6, 1, 1, SHINE],
  [9, 7, 3, 2, GOLD],                                       // a lamp lit in the window
  [7, 12, 2, 2, DARK], [4, 14, 8, 1, DARK], [5, 13, 6, 1, STEEL],
];
/** The service bell from the front desk, with a pip for whoever is waiting. */
const BELL: Px[] = [
  [7, 2, 2, 1, DARK],                                       // the button
  [5, 3, 6, 1, BRASS], [4, 4, 8, 1, GOLD], [3, 5, 10, 4, GOLD], [2, 9, 12, 2, GOLD],
  [4, 5, 2, 1, CREAM], [3, 6, 1, 2, CREAM],                 // the shine
  [11, 5, 2, 4, BRASS], [12, 9, 2, 2, BRASS],               // its shaded side
  [1, 11, 14, 1, BRASS], [1, 12, 14, 2, DARK],              // the base plate
  [10, 0, 6, 6, CREAM], [11, 1, 4, 4, RED],                 // the pip
];

let link: HTMLLinkElement | undefined;
let shown: boolean | undefined;

/** Show the bell while someone needs the owner, and the monitor otherwise. Redraws only when the
 *  state flips; a browser with no canvas keeps whatever icon it had. */
export function setFavicon(needsYou: boolean) {
  if (shown === needsYou) return;
  shown = needsYou;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const c = canvas.getContext('2d');
    if (!c) return;
    for (const [x, y, w, h, colour] of needsYou ? BELL : MONITOR) { c.fillStyle = colour; c.fillRect(x * 2, y * 2, w * 2, h * 2); }
    if (!link) {
      link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link');
      link.rel = 'icon'; link.type = 'image/png';
      if (!link.isConnected) document.head.append(link);
    }
    link.href = canvas.toDataURL('image/png');
  } catch { /* an icon is decoration */ }
}
