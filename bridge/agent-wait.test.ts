import { expect, test } from 'bun:test';
import { extractWaitNotice } from './agent-wait';
test('narrow Claude retry footer preserves reset time and wrapped attempt', () => {
  expect(extractWaitNotice('● Running commands\n✻\nSession · Retrying in 1h (6:50pm) ·\nl… attempt 1/300\n ⎿ ◻ task\n────────\n❯\n────────')).toEqual({ kind: 'retry', detail: 'Retrying in 1h (6:50pm) · attempt 1/300' });
});
test('explicit rate limit distinguishes cause from generic retry', () => {
  expect(extractWaitNotice('✻ Rate limit · Retrying in 20s · attempt 2/10\n─────\n❯')?.kind).toBe('rate_limit');
  expect(extractWaitNotice("You've hit your limit · resets 7pm\n─────\n❯")?.kind).toBe('rate_limit');
});
test('clears resumed output and ignores ordinary discussion or historical limits', () => {
  expect(extractWaitNotice('● Retrying in 1h is an example\n─────\n❯')).toBeNull();
  expect(extractWaitNotice('✻ Session · Retrying in 1h · attempt 1/300\n● Resumed\n─────\n❯')).toBeNull();
  expect(extractWaitNotice('✻ Working…\n─────\n❯')).toBeNull();
  expect(extractWaitNotice("You've hit your limit · resets 7pm\n● Resumed\n─────\n❯")).toBeNull();
  expect(extractWaitNotice('· Retrying in 1h\n' + '\n'.repeat(20) + '❯')).toBeNull();
});
