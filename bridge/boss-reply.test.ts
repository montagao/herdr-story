import { expect, test } from 'bun:test';
import { parseBossReply } from './boss-reply';

test('structured ideas have a bounded, complete dialogue contract', () => {
  const idea = { title: 'Bookmark a reply', evidence: 'Chat scrolling shipped', why: 'Find a useful reply quickly', nextStep: 'Try one bookmark' };
  expect(parseBossReply(JSON.stringify({ intro: 'A thought for the studio.', ideas: [idea] }))?.ideas).toEqual([idea]);
  expect(parseBossReply('```json\n' + JSON.stringify({ ideas: Array(9).fill(idea) }) + '\n```')?.ideas).toHaveLength(3);
  expect(parseBossReply(JSON.stringify({ ideas: [{ title: 'Incomplete' }] }))).toBeUndefined();
  expect(parseBossReply('Permission needed')).toBeUndefined();
  expect(parseBossReply('x'.repeat(30001))).toBeUndefined();
});

test('existing numbered Boss replies become the same cards without another model call', () => {
  const reply = `Here are two follow-ups grounded in the journal.\n\n1. Minimum-width guard for agent panes\nEvidence: “Game layering issues” records a narrow pane.\nWhy it matters: Small panes make the demo hard to read.\nNext step: Try a minimum width.\n\n2. Layout preset for demo recording\nEvidence: The milestone “Ship demo on X.”\nWhy it matters: Two panes tell a clearer story.\nNext step: Record a short clip.`;
  const result = parseBossReply(reply)!;
  expect(result.ideas).toHaveLength(2);
  expect(result.ideas[0].title).toBe('Minimum-width guard for agent panes');
  expect(result.ideas[0].nextStep).toBe('Try a minimum width.');
  expect(result.ideas[1].evidence).toContain('Ship demo on X');
});
