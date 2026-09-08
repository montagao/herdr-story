import type { BossIdea } from '../shared/boss';

const plain = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\*\*/g, '').trim().slice(0, max) : '';
/** Accept the structured contract, plus the numbered briefings produced before it existed.
 * Never expose the terminal, input prompt, or malformed JSON as a dialogue page. */
export function parseBossReply(reply: string): { intro: string; ideas: BossIdea[] } | undefined {
  if (!reply || reply.length > 30_000) return;
  const raw = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(raw);
    const ideas = Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, 3).map((idea: any) => ({
      title: plain(idea?.title, 100), evidence: plain(idea?.evidence, 500), why: plain(idea?.why, 500), nextStep: plain(idea?.nextStep, 500),
    })) : [];
    if (ideas.length && ideas.every((idea: BossIdea) => idea.title && idea.evidence && idea.why && idea.nextStep))
      return { intro: plain(parsed.intro, 300) || 'I have a few ideas for the studio.', ideas };
  } catch { /* Older Boss conversations are prose. */ }
  const text = reply.replace(/\*\*/g, '').trim();
  const starts = [...text.matchAll(/^(?:#{1,3}\s*)?\d+[.)]\s+(.+)$/gm)];
  const ideas = starts.slice(0, 3).map((match, index) => {
    const section = text.slice(match.index! + match[0].length, starts[index + 1]?.index ?? text.length);
    const fields = section.match(/Evidence:\s*([\s\S]*?)\s*Why(?: it matters)?:\s*([\s\S]*?)\s*Next step:\s*([\s\S]*)/i);
    return fields ? { title: plain(match[1], 100), evidence: plain(fields[1], 500), why: plain(fields[2], 500), nextStep: plain(fields[3], 500) } : undefined;
  }).filter((idea): idea is BossIdea => !!idea);
  if (ideas.length) return { intro: plain(text.slice(0, starts[0].index), 300) || 'Here are my ideas for the studio.', ideas };
}
