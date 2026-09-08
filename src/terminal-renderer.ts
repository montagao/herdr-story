const TERMINAL_LINK = /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:localhost|127(?:\.\d{1,3}){3}):\d{2,5}(?:\/[^\s<>"'`]*)?/gi;
type Line = { text: string; node: HTMLSpanElement; ending: Text };
const screens = new WeakMap<HTMLPreElement, { text: string; lines: Line[] }>();

function line(doc: Document, text: string): Line {
  const node = doc.createElement('span'); node.className = 'terminal-line';
  let cursor = 0;
  for (const match of text.matchAll(TERMINAL_LINK)) {
    const start = match.index;
    let label = match[0];
    while (/[.,;:!?]$/.test(label)) label = label.slice(0, -1);
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      while (label.endsWith(close) && label.split(close).length > label.split(open).length) label = label.slice(0, -1);
    }
    if (!label) continue;
    if (start > cursor) node.append(doc.createTextNode(text.slice(cursor, start)));
    const anchor = doc.createElement('a');
    anchor.href = /^(?:https?:\/\/)/i.test(label) ? label
      : /^(?:localhost|127\.)/i.test(label) ? `http://${label}` : `https://${label}`;
    anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.textContent = label;
    anchor.title = `Open ${label} in a new tab`; node.append(anchor);
    cursor = start + label.length;
  }
  if (cursor < text.length) node.append(doc.createTextNode(text.slice(cursor)));
  const ending = doc.createTextNode(''); node.append(ending);
  return { text, node, ending };
}

/** Reuse unchanged lines, including their anchors and selection endpoints. Matching rows before
 * reconciling avoids moving every retained node when the terminal scrolls its first line away. */
export function renderTerminal(pre: HTMLPreElement, text: string): boolean {
  const previous = screens.get(pre);
  if (previous?.text === text && previous.lines[0]?.node.parentNode === pre) return false;
  const available = new Map<string, { rows: Line[]; next: number }>();
  for (const row of previous?.lines ?? []) if (row.node.parentNode === pre) {
    const same = available.get(row.text) ?? { rows: [], next: 0 }; same.rows.push(row); available.set(row.text, same);
  }
  const lines = text.split('\n').map(text => {
    const same = available.get(text);
    return same?.rows[same.next++] ?? line(pre.ownerDocument, text);
  });
  const wanted = new Set(lines.map(row => row.node));
  const selection = pre.ownerDocument.getSelection();
  const anchor = selection?.anchorNode, focus = selection?.focusNode;
  const endpoints = anchor && focus && pre.contains(anchor) && pre.contains(focus)
    ? { anchor, focus, anchorOffset: selection!.anchorOffset, focusOffset: selection!.focusOffset } : undefined;
  for (const node of [...pre.childNodes]) if (!wanted.has(node as HTMLSpanElement)) node.remove();
  let cursor = pre.firstChild;
  for (const [index, row] of lines.entries()) {
    if (row.node !== cursor) pre.insertBefore(row.node, cursor);
    else cursor = cursor.nextSibling;
    const ending = index < lines.length - 1 ? '\n' : '';
    if (row.ending.data !== ending) row.ending.data = ending;
  }
  // Reordering surviving rows can reset a DOM selection in some browsers. Restore only endpoints
  // that still exist; never fabricate a selection over replacement text or touch another window.
  if (endpoints && pre.contains(endpoints.anchor) && pre.contains(endpoints.focus)
    && (selection!.anchorNode !== endpoints.anchor || selection!.focusNode !== endpoints.focus
      || selection!.anchorOffset !== endpoints.anchorOffset || selection!.focusOffset !== endpoints.focusOffset)) {
    const bound = (node: Node, offset: number) => Math.min(offset, node.nodeType === Node.TEXT_NODE ? node.textContent?.length ?? 0 : node.childNodes.length);
    selection!.setBaseAndExtent(endpoints.anchor, bound(endpoints.anchor, endpoints.anchorOffset), endpoints.focus, bound(endpoints.focus, endpoints.focusOffset));
  }
  screens.set(pre, { text, lines });
  return true;
}
