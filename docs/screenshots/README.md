# Screenshots

All screenshots use the bundled fictional demo. No bridge, real agents, customer information,
or private terminal history is used. The demo is read-only; live mode also provides prompt
and agent controls.

- `office.png`: full isometric office and roster (1440 × 960).
- `office-agents.png`: close-up of four agents at their desks (1080 × 960).
- `roster.png`: clean-checkout desktop roster (1120 × 840).
- `conversation.png`: an agent’s terminal screen in the demo (1120 × 840).
- `roster-mobile.png`: clean-checkout mobile roster (390 × 844).

The two office images depict the optional local Game Dev Story artwork (copyright Kairosoft),
alongside the project's original elements and attributed open props. This artwork is not covered
by the repository's ISC source-code license. The underlying proprietary sheets are not committed.
The other three screenshots use a public build without that artwork.

To refresh the clean-checkout screenshots, install Chromium with `npx playwright install chromium`,
then run `node scripts/screenshots.mjs` from the repository root. To capture the full office,
install the optional local art pack first (see ../assets.md), then run
`node scripts/screenshots.mjs --office`.

On the shared VPS, prefix either command with `/home/montagao/.local/bin/vps-job`.
The script builds into a temporary directory, serves only that static build, checks for browser
errors and accidental bridge requests, captures the images, and removes temporary files.
Office mode copies only the local art directory into the temporary build; it does not read live data.
