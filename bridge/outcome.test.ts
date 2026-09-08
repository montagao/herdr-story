import { describe, expect, test } from 'bun:test';
import { extractCurrent, extractOutcome, taskTitle } from './outcome';

const codex = `
› use the deck skill on scratchpad/audit.html and validate it on mobile

• Ran node - <<'NODE'
  │ const { chromium } = require('playwright');
  └ {"horizontalOverflow":[]}

• Viewed Image
  └ /tmp/deck-mobile.png

• Ran 3 commands · ctrl + t to view transcript

• Edited /tmp/scratchpad/audit.html (+3 -1)
    176 -                h1 { font-size: 58px; }
    176 +                h1 { font-size: 50px; }

• The corrected render now passes all 14 slides with zero clipped content. I'm opening the
  tunnel now.

• Restyled the audit as a 14-slide deck:

  Open the deck (https://example.trycloudflare.com/audit.html)

  Validated at 1280×800 and 390×844, including keyboard and print layout.

─ Worked for 10m 12s ────────────────────────────────────────────────────

⚠ The cloudflare-api MCP server is not logged in.

  2 background terminals running · /ps to view · /stop to close


› Ask Codex to do anything

  gpt-5.6-sol high fast · ~/projects/paperplane · preview
`;

const claude = `
❯ is this compatible with an api that will be built later

⏺ Read(docs/plan.md)
  ⎿  Read 120 lines

● Yes. The plan is designed so that a public API later is an addition, not a rewrite. The key is
  that everything reusable lives in the service layer.

  1. Open the Trials tab and confirm the three mobile trials show windows.
  2. Make the webhook write the trial map.

  Say the word and I'll start on item 2.

✻ Baked for 16s · done 10:26 AM
                                                   new task? /clear to save 311.7k tokens
───────────────────────────────────────────────────────────────────────────────────────────
❯ do it, draft the webhooksmom pr
───────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #40 · ← for agents               /rc
`;

describe('extractOutcome', () => {
  test('keeps the final reply and the prompt above it, not the tool calls', () => {
    const out = extractOutcome(codex);
    expect(out.prompt).toBe('use the deck skill on scratchpad/audit.html and validate it on mobile');
    expect(out.summary).toStartWith('Restyled the audit as a 14-slide deck:');
    expect(out.summary).toContain('Validated at 1280×800');
    expect(out.summary).not.toContain('Worked for');
    expect(out.summary).not.toContain('cloudflare-api MCP');
  });
  test('ignores a prompt typed after the reply and Claude footer chrome', () => {
    const out = extractOutcome(claude);
    expect(out.prompt).toBe('is this compatible with an api that will be built later');
    expect(out.summary).toStartWith('Yes. The plan is designed');
    expect(out.summary).toContain("Say the word and I'll start on item 2.");
    expect(out.summary).not.toContain('Baked for');
    expect(out.summary).not.toContain('bypass permissions');
    expect(out.summary).not.toContain('Read 120 lines');
  });
  test('the visible screen mid-way into the next turn still yields the finished reply', () => {
    const screen = `
● Done — the journal now records what actually happened. Here's what changed.

  Two things to know

  1. Restart the bridge (npm run dev again) — the running one on :7788 is the old code.
  2. Existing entries stay as they are.

✻ Sautéed for 7m 5s · done 10:49 AM

❯ [Image #77] claude still just says this
  ⎿  [Image #77]

● Running 3 shell commands…
  ⎿  $ for src in recent visible; do curl …

✽ Sprouting… (28s · ↓ 1.5k tokens)
                                                    ✔ Update installed · Restart to apply
───────────────────────────────────── Pixel art AI agent viewer ─
❯
`;
    const out = extractOutcome(screen);
    expect(out.summary).toStartWith('Done — the journal now records');
    expect(out.summary).toContain('2. Existing entries stay as they are.');
    expect(out.summary).not.toContain('Running 3 shell');
    expect(out.summary).not.toContain('Sprouting');
    expect(out.prompt).toBeUndefined();
  });
  test('a pane with only tool output has no summary', () => {
    expect(extractOutcome('⏺ Bash(npm test)\n  ⎿  42 passed\n')).toEqual({});
  });
  test('long replies are cut at a sentence', () => {
    const long = '● ' + 'A sentence that goes on. '.repeat(80);
    const { summary } = extractOutcome(long);
    expect(summary!.length).toBeLessThanOrEqual(901);
    expect(summary!.endsWith('.…')).toBe(true);
  });
});

describe('extractCurrent', () => {
  test('a busy Claude pane: the prompt in hand and the spinner phase', () => {
    const { prompt, activity } = extractCurrent(claude + '\n❯ do it, draft the webhooksmom pr\n\n● Running 3 shell commands…\n  ⎿  $ npm test\n\n✽ Sprouting… (28s · ↓ 1.5k tokens)\n');
    expect(prompt).toBe('do it, draft the webhooksmom pr');
    expect(activity).toBe('Sprouting…');
  });
  test('a finished Codex pane keeps the prompt it just did, not the empty input box', () => {
    const { prompt, activity } = extractCurrent(codex);
    expect(prompt).toBe('use the deck skill on scratchpad/audit.html and validate it on mobile');
    expect(activity).toBe('Restyled the audit as a 14-slide deck:');
  });
  test('nothing on screen yet', () => { expect(extractCurrent('\n› Ask Codex to do anything\n')).toEqual({ prompt: undefined, activity: undefined }); });
});

describe('taskTitle', () => {
  const project = '/home/me/projects/paperplane';
  test('keeps a real title, even one that begins with the folder name', () => {
    expect(taskTitle('Trial onboarding flow audit', project)).toBe('Trial onboarding flow audit');
    expect(taskTitle('Tgod trials dashboard', '/p/tgod', { prompt: 'ok whats next' })).toBe('Tgod trials dashboard');
  });
  test('a derived title loses its trailing colon', () => { expect(taskTitle('paperplane', project, { summary: 'Restyled the deck:\n\nOpen it.' })).toBe('Restyled the deck'); });
  test('replaces a folder-name title with the prompt', () => {
    expect(taskTitle('paperplane', project, { prompt: 'use the deck skill on audit.html', summary: 'Restyled the audit.' })).toBe('use the deck skill on audit.html');
    expect(taskTitle('LanternAppiOS-relea...', '/p/LanternAppiOS-release-1.1', { summary: 'Fixed the build.\nDetails follow.' })).toBe('Fixed the build.');
  });
  test('falls back to the folder when the pane gave nothing', () => { expect(taskTitle('paperplane', project)).toBe('paperplane'); });
});
