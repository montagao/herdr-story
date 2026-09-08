# Security

This is a local control plane for terminal agents, not a multi-user hosted service. Only the
current main branch receives fixes; there is no security response SLA.

## Reporting

Use GitHub's **Security → Report a vulnerability** when enabled:
https://github.com/montagao/herdr-story/security/advisories/new

If that option is unavailable, open an issue titled “Private security contact requested” without
exploit details, credentials, or private data; the maintainer can arrange a private channel.
Include affected versions, reproduction steps using mock data, and impact in the private report.

## Trust boundary

The bridge can read private terminal output and, when writable, send prompts, interrupt agents,
hire agents, close panes, and update local files. Boss reviews launch a tool-disabled Claude
session with permission bypass configured; prompts still leave the machine for that provider.
Connected users share the host's permissions. There is no per-user login or authorization.

Keep the game/bridge on loopback or behind authenticated private access such as Tailscale Serve
with restrictive access rules. Never expose the game port through a public tunnel, including in
read-only mode. Read-only prevents writes; it does not redact terminal output or payment details.
Only the separate authenticated RevenueCat webhook listener is intended for public ingress.

The main listener validates Host and browser Origin, including WebSocket upgrades. Configure
exact `HERDR_STORY_ALLOWED_ORIGINS` for private reverse proxies; never trust arbitrary forwarded
headers or use a public proxy as authentication. These checks protect against foreign websites
and DNS rebinding, not a malicious local process or an authorized viewer.

Secrets stay in owner-only `.env` and private host state. Backups and image uploads may contain
sensitive data. The browser retains drafts and UI preferences, so use trusted devices. Payment
providers receive API requests; Frankfurter receives a public exchange-rate request with no
payment/customer data. Google Fonts is loaded by the page. No application analytics are configured.

Live demo exports contain private history and are not automatically safe to publish. The public
demo must remain generated fiction. Historical commits also need review before publication.
