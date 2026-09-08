import { closeOnEscape } from './escape';
import type { MoneyEvent } from '../shared/types';

type Sample = Pick<MoneyEvent, 'kind' | 'amount' | 'label' | 'detail'> & {
  caption: string;
  tone: 'up' | 'flat' | 'down';
};

const SAMPLES: Sample[] = [
  { kind: 'sale', amount: 29, label: 'Preview only · successful payment', caption: 'Pay $29', tone: 'up' },
  { kind: 'subscribed', amount: 0, label: 'Preview only · first invoice paid', caption: 'Paid sub', tone: 'up' },
  { kind: 'trial_started', amount: 0, label: 'Preview only · trial subscription', caption: 'Trial', tone: 'flat' },
  { kind: 'failed', amount: 29, label: 'Preview only · payment failed', caption: 'Fail $29', tone: 'down' },
  { kind: 'refund', amount: -29, label: 'Preview only · payment refunded', caption: 'Refund', tone: 'down' },
  { kind: 'churned', amount: 0, label: 'Preview only · cancels at period end', caption: 'Cancel', tone: 'down',
    detail: { reason: 'Customer cancelled', feedback: 'Too expensive', comment: 'Loved it, but I only needed it for one project.', plan: 'Pro monthly', ends: Date.now() + 9 * 86_400_000, url: 'https://dashboard.stripe.com/subscriptions/sub_preview' } },
];

/** Browser-only QA palette. Callbacks keep it physically disconnected from the bridge and Stripe. */
export function installEventDebugger(
  mount: HTMLElement,
  preview: (event: MoneyEvent) => void,
  clear: () => void,
  initiallyOpen = false,
  scenes: { caption: string; run: () => void }[] = [],
) {
  const root = document.createElement('div');
  root.id = 'event-debug';
  root.innerHTML = `<button type="button" class="event-debug-toggle" aria-expanded="false" aria-controls="event-debug-tray">
      <span class="debug-coin" aria-hidden="true"></span><span>Test events</span><span class="debug-caret" aria-hidden="true">▴</span>
    </button>
    <div id="event-debug-tray" data-block-office-input hidden>
      <div class="event-debug-head"><span><b>Event preview</b><small>browser only</small></span><button type="button" data-clear>clear previews</button></div>
      <div class="event-debug-buttons">${SAMPLES.map((sample, index) =>
        `<button type="button" data-sample="${index}" data-tone="${sample.tone}">${sample.caption}</button>`).join('')}</div>
      ${scenes.length ? `<div class="event-debug-head"><span><b>Scenes</b><small>cutscenes and gags</small></span></div>
      <div class="event-debug-buttons">${scenes.map((scene, index) => `<button type="button" data-scene="${index}" data-tone="flat">${scene.caption}</button>`).join('')}</div>` : ''}
    </div>`;
  mount.append(root);

  const toggle = root.querySelector<HTMLButtonElement>('.event-debug-toggle')!;
  const tray = root.querySelector<HTMLElement>('#event-debug-tray')!;
  const caret = root.querySelector<HTMLElement>('.debug-caret')!;
  const setOpen = (open: boolean) => {
    tray.hidden = !open;
    root.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    caret.textContent = open ? '▾' : '▴';
  };
  toggle.addEventListener('click', () => setOpen(tray.hidden === true));
  tray.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.hasAttribute('data-clear')) { clear(); return; }
    if (button.dataset.scene !== undefined) { scenes[Number(button.dataset.scene)]?.run(); return; }
    const sample = SAMPLES[Number(button.dataset.sample)];
    if (!sample) return;
    preview({ id: `debug_${Date.now()}_${crypto.randomUUID()}`, ts: Date.now(), currency: 'usd',
      kind: sample.kind, amount: sample.amount, label: sample.label, ...(sample.detail ? { detail: sample.detail } : {}) });
  });
  closeOnEscape(tray, () => { setOpen(false); toggle.focus(); });
  setOpen(initiallyOpen);
}
