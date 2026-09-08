export type PendingPrompt = { id: string; clientId: string; text: string };
// Image uploads append paths to the submitted prompt; the browser receipt keeps the user's text.
const textOf = (text: string) => text.replace(/\n*Attached image files? \(available locally on this machine\):[\s\S]*$/, '').trim();

/** Native Codex owns delivery. Match its remaining submissions, consuming duplicates once.
 * Older CLI receipts have no native ID, so reconcile those by exact text, newest receipt first. */
export function pendingQueueIds(receipts: { id: string; text: string }[], pending: PendingPrompt[]) {
  const remaining = [...pending], ids = new Set<string>();
  for (const receipt of [...receipts].reverse()) {
    let index = remaining.findIndex(item => item.clientId === receipt.id || item.id === receipt.id);
    if (index < 0) index = remaining.findIndex(item => textOf(item.text) === textOf(receipt.text));
    // Old attachment-only receipts did not retain submitted paths. Keep them if any native
    // attachment-only submission remains, without guessing from unrelated agent status changes.
    if (index < 0 && /^\d+ image attachments?$/.test(receipt.text)) index = remaining.findIndex(item => !textOf(item.text));
    if (index >= 0) { ids.add(receipt.id); remaining.splice(index, 1); }
  }
  return ids;
}
