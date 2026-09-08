<p align="center">
  <img src="docs/art/wordmark.svg" alt="Herdr Story" width="800" />
</p>

<h3 align="center">Your coding agents. Their own little game studio.</h3>

<p align="center">
  Watch them work at their desks. Jump into a conversation.<br />
  Come back to a journal of what shipped.
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#a-small-office-with-a-lot-going-on">Explore the office</a> ·
  <a href="docs/guide.md">User guide</a> ·
  <a href="#keep-the-office-lights-on">Sponsor me ♥</a>
</p>

<p align="center"><kbd>LOCAL FIRST</kbd> &nbsp; <kbd>CODEX + CLAUDE</kbd> &nbsp; <kbd>BUN + PHASER</kbd> &nbsp; <a href="LICENSE">ISC source license</a></p>

![Herdr Story: four demo agents at their desks in an isometric office, with a live-style project roster](docs/screenshots/office.png)

<p align="center"><sub>Actual app, fictional demo data. The pictured office uses an optional local art pack; <a href="docs/assets.md">a fresh checkout opens the roster and chat</a>.</sub></p>

Herdr Story turns your [Herdr](https://herdr.dev) agent sessions into a place you can look around.
Codex and Claude get desks. Projects get whiteboards. Finished work becomes studio history.
There’s a boss with ideas, a janitor with a cleanup plan, and a cat you can pet between tasks.

## A small office with a lot going on

| In the office | What you can do |
| --- | --- |
| **Every agent gets a desk** | See who’s working, finished, waiting on you, or rate limited. Open their conversation from the room or roster. |
| **You’re still in charge** | Send prompts and images, queue follow-ups, choose model and effort, or stop a task and recover its last prompt. |
| **The whiteboards remember** | Give projects milestones and checklists. Save releases and completed work in a searchable journal, then mark entries read. |
| **Catch up when you return** | See what shipped while you were away, including recorded payments and a USD revenue estimate. |
| **Make the place yours** | Move desks and plants, change the room theme, rename employees, and watch their careers grow. |
| **Meet the regulars** | Ask Boss for project-scoped ideas, let Gus help review inactive agents, or say hello to Miso the cat. |

Optional **Stripe and RevenueCat** integrations bring payment activity into the office.
The bridge keeps recording while the page is closed, as long as it remains running.

<details>
<summary><b>Take a closer look: agents, terminal output, and mobile</b></summary>

### The team, up close

![Four fictional agents at their desks, with project boards, plants, and the boss’s desk](docs/screenshots/office-agents.png)

### Open a conversation

The terminal viewer below uses the read-only demo. Live sessions also have prompt, queue,
model, and stop controls.

![Terminal output for a fictional demo agent](docs/screenshots/conversation.png)

### No art pack? Start with the roster.

The clean-checkout view supports existing-agent chat and controls. Room, hiring, studio,
and billing windows currently need the full office. [Artwork details →](docs/assets.md)

![Desktop roster grouped by project without the optional artwork](docs/screenshots/roster.png)

<img src="docs/screenshots/roster-mobile.png" alt="The agent roster on a mobile screen" width="320" />

</details>

## Get started

You’ll need **Node.js 22.12+**, **npm**, and **Bun 1.3.14+** on Linux or macOS.
Windows is untested; use WSL for the Bash scripts and Unix socket bridge.

```sh
git clone https://github.com/montagao/herdr-story.git
cd herdr-story
npm ci
npm run dev:mock
```

Open **http://127.0.0.1:5173**. Mock mode needs no credentials, paid API calls, or running agents.
For the fictional, read-only demo, open **[/?demo=1](http://127.0.0.1:5173/?demo=1)**.

> **About the artwork:** the screenshots show the full office with separately supplied Game Dev
> Story artwork. Those sheets aren’t included in the repo. Your fresh checkout opens a working
> roster/chat view. [Asset setup and credits →](docs/assets.md)

### Bring your own agents

Install [Herdr](https://herdr.dev), start a session, then run:

```sh
npm run dev             # connect to Herdr with local terminal controls
npm run dev:read-only   # browse without sending prompts or changing the studio
```

The bridge listens on `127.0.0.1:7788`. Set `HERDR_SOCKET_PATH` for a custom Unix socket, or
`HERDR_SESSION` for a named session. Payment sources are optional; `.env.example` lists their settings.

This is an **experimental local tool**. Keep it on your machine or a trusted private tailnet;
read-only mode still exposes private terminal output. [Security and trust model →](SECURITY.md)

<details>
<summary><b>Setup help and the rest of the manual</b></summary>

- **Socket closed / agents missing:** check that Herdr is running and that the configured socket
  belongs to the current session. A persistent disconnect is not expected.
- **Office artwork missing:** see [asset requirements](docs/assets.md); the roster remains available.
- **Payments:** copy `.env.example` to `.env` and uncomment only what you need. Never put secrets in
  `VITE_` variables. [Provider setup, webhooks, and revenue calculations](docs/guide.md).
- **Remote access:** use the [private Tailscale setup](docs/guide.md), not a public game endpoint.
- **Backups, model settings, journals, and room controls:** [read the user guide](docs/guide.md).

</details>

## Keep the office lights on

[![Sponsor me — keep the office lights on. Support @montagao.](docs/art/sponsor.png)](docs/sponsorship.md)

I’m building Herdr Story to make running a bunch of coding agents feel a little more human.
If you’d like to support its development, **[sponsor me →](docs/sponsorship.md)**.
Stars, thoughtful bug reports, and contributions help too.

<sub>GitHub Sponsors for @montagao is being set up. The card links to the sponsorship page;
donations aren’t live yet.</sub>

## Build something for the studio

Found a rough edge? Have an idea for the office? [Open an issue](https://github.com/montagao/herdr-story/issues)
or read [CONTRIBUTING.md](CONTRIBUTING.md). An independently licensed replacement art pack
would be a particularly welcome contribution.

```sh
npm run check           # types, unit tests, publication checks, and build
npm run build:public    # app build without the local proprietary art pack
npx playwright install chromium
npm run test:release    # isolated browser and bridge-access checks
```

| Directory | What lives there |
| --- | --- |
| [`src/`](src/) | Browser UI, conversations, and the Phaser office |
| [`bridge/`](bridge/) | Bun server, agent connections, and durable studio state |
| [`shared/`](shared/) | Contracts shared by the browser and bridge |

Feature-specific checks are listed in `package.json`. CI uses fictional data and an isolated mock
bridge. [Screenshot capture instructions](docs/screenshots/README.md) · [Artwork provenance](docs/art/README.md)

<details>
<summary><b>Preparing a build or source archive to share</b></summary>

`npm run demo:sample` regenerates the fictional demo. `npm run demo:export` instead captures
**private live data** into ignored `captures/`; it is not an anonymizer.

`npm run release:source` prepares the current source tree without Git history, credentials,
private captures, dependencies, or the local asset pack. The checked-in office screenshots do
show that artwork. Review the [publication checklist](docs/publishing.md) and asset rights
before public distribution; replacing a branch doesn’t erase all historical GitHub content.

</details>

---

Original code: **[ISC](LICENSE)**. Third-party artwork retains its own rights and licenses;
see [notices and credits](THIRD_PARTY_NOTICES.md). The sponsor illustration is promotional art,
not an in-app screenshot. Herdr Story is independent of Kairosoft, Anthropic, OpenAI, Stripe,
and RevenueCat.
