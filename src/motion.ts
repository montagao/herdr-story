// How windows arrive and leave.
//
// Every window in the office opens and closes by flipping `hidden` on its root, in the same task
// as the click or key that asked for it. The smoke tests, the Escape stack and the office's own
// sleep/wake all read that attribute, so nothing here ever delays it. Instead:
//
//  * arriving — one observer notices a root becoming visible and gives its window a short landing
//    (the class is on for a moment; the keyframes are in motion.css);
//  * the veil — the dimming behind a window is one shared sheet rather than each root's own, so
//    it can fade in, fade out after the window has gone, and stay put when one window hands over
//    to another instead of jumping between their different darknesses;
//  * leaving — a blank stand-in the size and colour of the window snaps shut where it stood.
//
// Nothing in this file touches the DOM at import time: modules that tests load without a browser
// may import it.

export function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface WindowMotionHooks {
  /** A window or popover came up. `full` is a whole-screen window; otherwise it is a popover. */
  opened?: (root: HTMLElement, full: boolean) => void;
  /** The last one went away. */
  closed?: (full: boolean) => void;
}

/** Things that block the office (see syncModalInput in main.ts), plus the native dialogs that
 *  deliberately do not: the settings window keeps the room live behind it as its preview. */
const WINDOWS = '[data-block-office-input]:not([hidden]), dialog[open]:not([hidden])';
const LAND_MS = 220;
/** A whole-screen window that is up. */
const HANDOVER = 'body > [data-block-office-input]:not([hidden]):not(dialog)';

/** Start watching for windows. Call once, after <body> exists. */
export function installWindowMotion(hooks: WindowMotionHooks = {}) {
  const veil = document.createElement('div');
  veil.id = 'veil'; veil.setAttribute('aria-hidden', 'true');
  document.body.append(veil);
  /** Each root's own backdrop colour, taken over by the veil the first time the root is seen. */
  const scrims = new Map<HTMLElement, string>();
  let shown = new Set<HTMLElement>();
  let anyFull = false;

  /** A whole-screen root directly under <body> that paints its own dim backdrop. */
  const scrimOf = (root: HTMLElement) => {
    if (scrims.has(root)) return scrims.get(root)!;
    let colour = '';
    if (root.parentElement === document.body && !(root instanceof HTMLDialogElement)) {
      const style = getComputedStyle(root);
      const alpha = /^rgba?\(([^)]+)\)/.exec(style.backgroundColor)?.[1].split(/[,/ ]+/).filter(Boolean)[3];
      const dim = style.position === 'fixed' && style.backgroundColor !== 'transparent' && (alpha === undefined || Number(alpha) > 0);
      if (dim) { colour = style.backgroundColor; root.style.backgroundColor = 'transparent'; }
    }
    scrims.set(root, colour);
    return colour;
  };

  const sync = () => {
    const now = new Set(document.querySelectorAll<HTMLElement>(WINDOWS));
    let first: HTMLElement | undefined, top: HTMLElement | undefined, topZ = -Infinity, full = false;
    for (const root of now) {
      const isFull = root.parentElement === document.body && !(root instanceof HTMLDialogElement);
      if (!shown.has(root)) {
        first ??= root;
        if (isFull) {
          // The class goes the moment the landing ends, so nothing later (a resize, a repaint of
          // the window's first child) can find it still there and play the landing again.
          const landed = () => root.classList.remove('win-enter');
          root.classList.add('win-enter');
          root.addEventListener('animationend', function done(event) {
            if (event.animationName !== 'win-in') return;
            root.removeEventListener('animationend', done); landed();
          });
          window.setTimeout(landed, LAND_MS);
        }
      }
      if (!isFull) continue;
      full = true;
      if (!scrimOf(root)) continue;
      const z = Number(getComputedStyle(root).zIndex) || 0;
      if (z >= topZ) { topZ = z; top = root; }
    }
    // The veil sits just under the topmost window, in that window's own darkness.
    if (top) { veil.style.zIndex = String(topZ - 1); veil.style.backgroundColor = scrims.get(top)!; }
    veil.classList.toggle('on', !!top);
    if (first) hooks.opened?.(first, first.parentElement === document.body && !(first instanceof HTMLDialogElement));
    else if (shown.size && !now.size) hooks.closed?.(anyFull);
    for (const root of scrims.keys()) if (!root.isConnected) scrims.delete(root);
    shown = now; anyFull = full;
  };

  // `hidden` anywhere, and roots that are added to or taken out of <body> whole.
  const attributes = new MutationObserver(sync), children = new MutationObserver(sync);
  attributes.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
  children.observe(document.body, { childList: true });
  sync();
  return () => { attributes.disconnect(); children.disconnect(); veil.remove(); };
}

/** A window is about to be hidden: leave a blank panel of its size, colour and frame behind, and
 *  snap that shut like a screen switching off. The window itself still goes at once. Call it just
 *  before hiding; it does nothing for a window that is not on screen. */
export function snapShut(win: Element | null | undefined) {
  if (!(win instanceof HTMLElement) || !win.isConnected || reducedMotion() || document.hidden) return;
  const box = win.getBoundingClientRect();
  if (box.width < 2 || box.height < 2 || typeof win.animate !== 'function') return;
  const style = getComputedStyle(win);
  if (style.visibility === 'hidden') return;
  const ghost = document.createElement('div');
  ghost.className = 'win-ghost'; ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
    background: style.backgroundColor, border: style.border, borderRadius: style.borderRadius, boxShadow: style.boxShadow,
    zIndex: String(Number(getComputedStyle(win.parentElement ?? win).zIndex) || 20),
  });
  // Wait for the task to finish: when one window is handing over to another, the newcomer's
  // landing is the whole move, and a shutter collapsing across it would only be noise.
  queueMicrotask(() => {
    if (document.querySelector(HANDOVER)) return;
    document.body.append(ghost);
    const gone = () => ghost.remove();
    const timer = window.setTimeout(gone, 260);
    ghost.animate(
      [{ transform: 'scale(1,1)', opacity: 1 }, { transform: 'scale(1,.05)', opacity: 1, offset: 0.6 }, { transform: 'scale(0,.05)', opacity: 0.6 }],
      // 'start' so the first frame is already closing: a full-size blank panel would read as a flash
      { duration: 150, easing: 'steps(6,start)', fill: 'forwards' },
    ).finished.then(() => { clearTimeout(timer); gone(); }, gone);
  });
}

/** Close a window from its backdrop only when the press and the release both landed there. A
 *  text selection dragged out past the window's edge ends on the backdrop too, and must not
 *  dismiss the conversation it was selecting from. */
export function dismissOnBackdrop(root: HTMLElement, close: () => void) {
  let pressed = false;
  root.addEventListener('pointerdown', (event) => { pressed = event.target === root; });
  root.addEventListener('click', (event) => {
    // detail 0 is a click with no pointer behind it: the keyboard, or a script
    if (event.target === root && (pressed || event.detail === 0)) close();
    pressed = false;
  });
}

/** Run a one-shot CSS animation class again from its start, even if it is already on. */
export function replayAnimation(el: Element | null | undefined, name: string) {
  if (!el) return;
  el.classList.remove(name);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(name);
}
