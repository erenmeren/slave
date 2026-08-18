# AI Team OS

An autonomous AI engineering team: agents plan, implement, verify, review and merge real work in
real git repositories, with a human supervising rather than prompting.

## Status

- **M0** — pause/resume spike, complete. Findings in `docs/superpowers/spikes/`, decisions in
  `docs/decisions/0001-pause-semantics.md`.
- **M1** — pure domain core, complete. See `docs/domain-model.md`.
- **M2** — persistence and event log. See `docs/event-model.md`.

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d
npm run db:migrate
npm run db:migrate:test
npm run db:seed
git config core.hooksPath .githooks
```

That last line is per-clone and is what wires the pre-push hook that runs typecheck and tests.

On a fresh machine, `docker compose up -d` requires both a running Docker daemon and the
`docker compose` CLI plugin — neither is guaranteed to be present out of the box. If the daemon
is not running, start it first; if `docker compose` is not found, install the plugin (on Debian/
Ubuntu, `apt-get install docker-compose-plugin`) before continuing.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Both vitest projects: fast unit tests and serial database integration tests |
| `npm run typecheck` | Builds every package and typechecks the test files too |
| `npm run db:migrate` | Applies migrations to the development database |
| `npm run db:migrate:test` | Applies migrations to the test database |
| `npm run db:seed` | Truncates and reseeds the development database |

Integration tests require Postgres to be running. They **fail** rather than skip when it is not:
a suite that skips reports success for work it did not do.

`npm test` runs `tsc --build && vitest run` — the build runs first because cross-package imports
(for example `packages/events` importing `@ai-team-os/db`) resolve through each package's
`package.json` to its `dist/` output, not to `src/`.
