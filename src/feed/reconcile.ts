/** Keep rows and their canvases alive across snapshots. Stable keys also preserve selection and
 * assistive-technology focus when another project changes. Only changed attributes/text are set. */
function key(node: Node): string | undefined {
  if (!(node instanceof HTMLElement)) return;
  if (node.dataset.pane) return `pane:${node.dataset.pane}`;
  if (node.dataset.rosterKey) return `group:${node.dataset.rosterKey}`;
  if (node.dataset.money) return `money:${node.dataset.money}`;
  if (node.id) return `id:${node.id}`;
}
function compatible(a: Node, b: Node) {
  return a.nodeType === b.nodeType && (!(a instanceof Element) || (b instanceof Element && a.tagName === b.tagName));
}
function patch(current: Node, desired: Node) {
  if (current instanceof HTMLElement && desired instanceof HTMLElement) {
    for (const name of current.getAttributeNames()) if (!desired.hasAttribute(name) && name !== 'data-appearance') current.removeAttribute(name);
    for (const name of desired.getAttributeNames()) if (current.getAttribute(name) !== desired.getAttribute(name)) current.setAttribute(name, desired.getAttribute(name)!);
    // Avatar pixels are filled asynchronously. Preserve that canvas while updating its lamp.
    if (current.classList.contains('roster-avatar')) {
      const lamp = current.querySelector('.status-lamp'), next = desired.querySelector('.status-lamp');
      if (lamp && next) patch(lamp, next);
      return;
    }
    reconcileChildren(current, desired);
  } else if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
}
export function reconcileChildren(current: Element | DocumentFragment, desired: Element | DocumentFragment) {
  const keyed = new Map([...current.childNodes].map(node => [key(node), node] as const).filter(([key]) => key));
  let cursor = current.firstChild;
  for (const next of [...desired.childNodes]) {
    const wanted = key(next);
    let node = wanted ? keyed.get(wanted) : cursor && !key(cursor) && compatible(cursor, next) ? cursor : undefined;
    if (node && !compatible(node, next)) node = undefined;
    if (!node) { node = next; current.insertBefore(node, cursor); }
    else { if (node !== cursor) current.insertBefore(node, cursor); patch(node, next); }
    cursor = node.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; current.removeChild(cursor); cursor = next; }
}
