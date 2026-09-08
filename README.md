# Herdr Story

A local agent dashboard with an isometric office: watch your [Herdr](https://herdr.dev)
agents work, open their conversations, and keep a journal of what they ship.

[Getting started](#getting-started) · [User guide](docs/guide.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Sponsorship](docs/sponsorship.md)

**Status: experimental, for a trusted local machine or private tailnet.** The source code is
ISC licensed. The full pixel-art office currently requires separately supplied artwork;
it is **not** a fully redistributable game asset pack. A clean checkout opens a roster/chat
view without that artwork. See [asset requirements and credits](docs/assets.md).

## Screenshots

The isometric office with four fictional demo agents, two project teams, and sample revenue.
These office screenshots use the optional local artwork; it is not bundled with a clean checkout.

![Isometric office with demo agents working at desks and a project-grouped roster](docs/screenshots/office.png)

<details>
<summary>Agents at their desks, terminal output, and clean-checkout views</summary>

![Close-up of four demo agents at their isometric desks](docs/screenshots/office-agents.png)

![An agent’s terminal output in the read-only demo](docs/screenshots/conversation.png)

![Desktop agent roster grouped by project, without optional artwork](docs/screenshots/roster.png)

<img src="docs/screenshots/roster-mobile.png" alt="Agent roster on a mobile screen" width="390" />

</details>

## What it does

- Groups live agents by project, with conversations, model/effort controls, queues, and stop controls.
- Saves project milestones, employee careers, a journal/archive, and a “while you were away” recap.
- Offers project-scoped Boss suggestions and a review of inactive agents before closing them.
- Optionally records Stripe and RevenueCat activity and estimates recap revenue in USD.
- Includes a fictional, read-only demo that does not need Herdr or payment credentials.

The full office has movable desks, plants, trophies, a cat, and a janitor. It needs the optional
local art pack. The fallback provides the live roster and existing-agent chat; room controls
and studio windows require the full office.

## Getting started

Use Linux or macOS with **Node.js 22.12+**, **npm**, and **Bun 1.3.14+**. Windows is not tested;
use WSL for the Bash scripts and Unix socket bridge. Herdr is a separate prerequisite for
live agents; install it from [herdr.dev](https://herdr.dev) and start a session first.

```sh
git clone https://github.com/montagao/herdr-story.git
cd herdr-story
npm ci
npm run dev:mock
```

Open **http://127.0.0.1:5173**. Mock mode needs no agents, credentials, or paid API calls.
Open **http://127.0.0.1:5173/?demo=1** for the fictional, read-only sample.

For real agents:

```sh
npm run dev             # local terminal controls enabled
npm run dev:read-only   # viewing only; terminal contents remain private
```

If Herdr is not found, set `HERDR_SOCKET_PATH` to its Unix socket, or `HERDR_SESSION` to the
session name. The bridge listens on `127.0.0.1:7788`. A “socket closed” message means the
bridge lost its Herdr connection; check that Herdr is running and the socket belongs to the
current session. It is not an expected permanent state.

Payment integrations are optional. Copy `.env.example` to `.env` only when needed, and uncomment
the settings you use. Never use a `VITE_` variable for secrets. See the [user guide](docs/guide.md)
for payment setup, backups, model settings, private Tailscale access, and office features.

## Development

```sh
npm run check           # types, unit tests, publication checks, and build
npm run build:public    # build without copying any private local art
npx playwright install chromium
npm run test:release    # isolated fresh-checkout UI and bridge access checks
```

`src/` contains the browser UI and Phaser scenes, `bridge/` the Bun server and persistence,
and `shared/` their contracts. Tests sit beside the code. More feature-specific browser checks
are listed in `package.json`; most require the optional artwork. CI uses only committed files,
a temporary mock bridge, and fictional data.

## Sharing and support

The bundled demo is generated fiction. `npm run demo:export` captures **private live data** into
ignored `captures/`; it is not an anonymizer. `npm run demo:sample` restores the public sample.

`npm run release:source` prepares an archive in `release/` from the current source tree, without
Git history, secrets, private captures, dependencies, or proprietary artwork. This checkout
starts with a fresh initial commit. Read the [publication checklist](docs/publishing.md) before
publishing: the previous private repository and its GitHub copy retain their original history.

Bug reports and small improvements are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Sponsorship configuration is prepared for **@montagao**, pending activation of GitHub Sponsors.
See [sponsorship](docs/sponsorship.md) for status and setup.

## License

Original code: [ISC](LICENSE). Third-party assets retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Herdr Story is an independent project and is
not affiliated with Kairosoft, Anthropic, OpenAI, Stripe, or RevenueCat.
