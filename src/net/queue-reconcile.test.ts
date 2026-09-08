import { expect, test } from 'bun:test';
import { pendingQueueIds } from './queue-reconcile';
const item = (id: string, text: string, clientId = '') => ({ id, text, clientId });

test('completed native queues clear old receipts; unrelated pending work does not keep them alive', () => {
  const receipts = [{ id: 'old', text: 'Already handled' }, { id: 'next', text: 'Next request' }];
  expect([...pendingQueueIds(receipts, [item('native-next', 'Next request')])]).toEqual(['next']);
  expect([...pendingQueueIds(receipts, [])]).toEqual([]);
});
test('identical queued prompts consume native matches once, retaining the newest waiting receipt', () => {
  expect([...pendingQueueIds([{ id: 'first', text: 'Again' }, { id: 'second', text: 'Again' }], [item('native', 'Again')])]).toEqual(['second']);
});
test('native ids survive edited text; image-path suffixes match original browser text', () => {
  expect([...pendingQueueIds([{ id: 'known', text: 'Original' }], [item('native', 'Edited in terminal', 'known')])]).toEqual(['known']);
  expect([...pendingQueueIds([{ id: 'image', text: 'Inspect this' }], [item('native', 'Inspect this\n\nAttached image file (available locally on this machine):\n- /tmp/file.png')])]).toEqual(['image']);
});
