# Screenshots

These images show the bundled fictional demo in roster mode, using a public build without the
optional proprietary artwork. No bridge, real agents, customer information, or private terminal
history is used. The demo is read-only; live mode also provides prompt and agent controls.

- `roster.png`: desktop roster (1120 × 840).
- `conversation.png`: an agent’s terminal screen in the demo (1120 × 840).
- `roster-mobile.png`: mobile roster (390 × 844).

To refresh them, install Chromium with `npx playwright install chromium`, then run
`node scripts/screenshots.mjs` from the repository root. On the shared VPS, use
`/home/montagao/.local/bin/vps-job node scripts/screenshots.mjs`.

The script builds into a temporary directory, serves only that static build, checks for browser
errors and accidental bridge requests, captures the images, and removes temporary files.
