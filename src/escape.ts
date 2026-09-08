type EscapeWindow = { root: HTMLElement; close: () => void };
const windows = new Map<HTMLElement, EscapeWindow>();
let listening = false;

/** Match the rendered stacking order, including menus inside a window and native modal dialogs. */
function layers(root: HTMLElement) {
  const order: number[] = [];
  for (let node: HTMLElement | null = root; node; node = node.parentElement) {
    const z = getComputedStyle(node).zIndex;
    if (z !== 'auto') order.unshift(Number(z) || 0);
  }
  return order;
}

function above(a: HTMLElement, b: HTMLElement) {
  const aModal = !!a.closest('dialog:modal'), bModal = !!b.closest('dialog:modal');
  if (aModal !== bModal) return aModal;
  const x = layers(a), y = layers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing) return;
  let top: EscapeWindow | undefined;
  for (const entry of windows.values()) {
    const { root } = entry;
    if (!root.isConnected || root.closest('[hidden], [inert]') || !root.getClientRects().length
        || getComputedStyle(root).visibility !== 'visible') continue;
    if (!top || above(root, top.root)) top = entry;
  }
  if (!top) return;
  // A single press belongs to one window. Don't also cancel a native dialog, run another global
  // shortcut, or send Escape into the terminal. Holding the key must not peel off more windows.
  event.preventDefault(); event.stopImmediatePropagation();
  if (!event.repeat) top.close();
}

/** The close callback is the same one used by ×, so drafts and cleanup follow the normal path.
 * Capture at window level also works after a redraw has left focus on the page or canvas. */
export function closeOnEscape(root: HTMLElement, close: () => void): () => void {
  if (!listening) { window.addEventListener('keydown', escape, { capture: true }); listening = true; }
  const entry = { root, close };
  windows.set(root, entry);
  return () => { if (windows.get(root) === entry) windows.delete(root); };
}
