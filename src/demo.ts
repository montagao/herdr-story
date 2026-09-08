import type { DemoSnapshot } from '../shared/demo';
import type { RevenueRange } from '../shared/revenue-range';
import type { Revenue } from './hud';
import { StaticBridgeClient } from './net/static-client';
import './demo.css';

/**
 * Demo mode: the office as it really was, from `/demo/office.json`, with no bridge behind it.
 * The snapshot is a curated capture of a real studio (see `bridge/demo-export.ts`); the static
 * client serves it and re-enacts a working day on its desks. `?capture=1` strips the badge and
 * fixes the books to one period for a recording; `?live=0` freezes the desks; `?seed=N` replays
 * the same day.
 */
export interface Demo {
  client: StaticBridgeClient;
  snapshot: DemoSnapshot;
  capture: boolean;
  revenue: (range: RevenueRange) => Promise<Revenue>;
}

export async function loadDemo(): Promise<Demo> {
  const q = new URLSearchParams(location.search);
  const capture = q.get('capture') === '1';
  const response = await fetch('/demo/office.json', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('The sample office is missing. Run `npm run demo:sample` to restore the fictional demo.');
  const snapshot = await response.json() as DemoSnapshot;
  const client = new StaticBridgeClient(snapshot, { live: q.get('live') !== '0', seed: Number(q.get('seed')) || 7 });
  document.body.classList.add('demo-mode');
  document.body.classList.toggle('capture-mode', capture);
  document.title = 'herdr story · demo office';
  const revenue = async (range: RevenueRange): Promise<Revenue> => {
    const book = snapshot.revenue[capture ? '30d' : range];
    if (!book) return { source: 'none', error: 'This interval was not included in the snapshot.', rangeSelectable: true };
    return capture ? { ...book, rangeSelectable: false, label: 'Last 30 days' } as Revenue : book as Revenue;
  };
  return { client, snapshot, capture, revenue };
}

/** The one piece of chrome the demo adds: a badge that says so, with the way out. */
export function installDemoChrome(mount: HTMLElement, side: HTMLElement, snapshot: DemoSnapshot) {
  const when = new Date(snapshot.capturedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  mount.insertAdjacentHTML('beforeend', `<a id="demo-badge" href="/" title="Leave the demo office"><b>DEMO</b><span>Exit ↗</span></a>
    <div id="demo-caption" hidden><small></small><p></p></div>`);
  side.insertAdjacentHTML('beforeend', `<footer class="demo-foot">Fictional sample office. Activity is simulated; nothing here is saved.</footer>`);
  const caption = mount.querySelector<HTMLElement>('#demo-caption')!;
  return {
    /** Recording captions; hidden until a chapter is named. */
    caption(chapter: string, text: string) {
      caption.querySelector('small')!.textContent = chapter; caption.querySelector('p')!.textContent = text;
      caption.hidden = !chapter && !text;
    },
  };
}
