# Contributing

Start with the README and `npm ci`. Use `npm run dev:mock` while developing; never point tests
at your real agents, payment account, or saved studio. Run `npm run check` before opening a PR.
For bridge access or bootstrap changes, also run `npm run test:release` after installing
Playwright Chromium. Office-specific smoke tests need the optional art described in docs/assets.md.

Keep changes focused. Explain the problem, resulting behavior, and validation in your PR.
Add regression coverage for behavior changes; small visual adjustments need a screenshot
using fictional data and redistributable artwork. Discuss large redesigns in an issue first.

Use TypeScript and the surrounding style. Keep browser/bridge contracts in `shared/`, sanitize
untrusted text before rendering, preserve read-only gates, and never automatically replay writes
whose outcome is unknown. Persistence changes must cover migration and restart behavior.

Do not submit `.env`, terminal captures, customer information, local databases, proprietary art,
or screenshots containing it. New third-party assets need a source, license, and modification
notes. Contributions to original code use the repository's ISC license.

For bugs, include OS, Node/Bun versions, reproduction steps, expected/actual behavior, and a
redacted error. Do not paste full real transcripts. Report security issues privately as described
in SECURITY.md. Be respectful, assume good intent, and keep discussions focused on the work.
