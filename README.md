# AI Team OS

An autonomous AI engineering team: agents plan, implement, verify, review and merge real work in
real git repositories, with a human supervising rather than prompting.

## Status

- **M0** — pause/resume spike, complete. Findings in `docs/superpowers/spikes/`, decisions in
  `docs/decisions/0001-pause-semantics.md`.
- **M1** — pure domain core, complete. See `docs/domain-model.md`.
- **M2** — persistence and event log. See `docs/event-model.md`.
- **M3** — orchestrator and the Claude Code adapter: real processes, real worktrees, real verify
  commands, driven from a CLI. See the orchestrator section below and `docs/architecture.md`.

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d
npm run db:generate
npm run db:migrate
npm run db:migrate:test
npm run db:seed
git config core.hooksPath .githooks
```

`npm run db:generate` matters even though `npm run db:migrate` runs right after it: under Prisma
7, `migrate deploy` no longer generates the client as a side effect, and `packages/db/src/generated/`
is gitignored, so skipping this step leaves nothing for `packages/db/src/client.ts` to import.
Every command below that touches the database — `db:seed`, `npm test`, `npm run typecheck`, and
the pre-push hook — fails on a fresh clone with a `TS2307: Cannot find module './generated/client.js'`
build error until this has been run once.

That last line (`git config core.hooksPath .githooks`) is per-clone and is what wires the pre-push
hook that runs typecheck and tests.

On a fresh machine, `docker compose up -d` requires both a running Docker daemon and the
`docker compose` CLI plugin — neither is guaranteed to be present out of the box. If the daemon
is not running, start it first; if `docker compose` is not found, install the plugin (on Debian/
Ubuntu, `apt-get install docker-compose-plugin`) before continuing.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Both vitest projects: fast unit tests and serial database integration tests |
| `npm run typecheck` | Builds every package and typechecks the test files too |
| `npm run db:generate` | Generates the Prisma client into `packages/db/src/generated/` |
| `npm run db:migrate` | Applies migrations to the development database |
| `npm run db:migrate:test` | Applies migrations to the test database |
| `npm run db:seed` | Truncates and reseeds the development database |

Integration tests require Postgres to be running. They **fail** rather than skip when it is not:
a suite that skips reports success for work it did not do.

`npm test` runs `tsc --build && vitest run` — the build runs first because cross-package imports
(for example `packages/events` importing `@ai-team-os/db`) resolve through each package's
`package.json` to its `dist/` output, not to `src/`.

The whole `vitest run` — unit project included, not just the database integration project — runs
single-threaded: `vitest.config.ts` sets `fileParallelism: false` at the config's root level,
because a per-project setting there is silently ignored by the scheduler. This was discovered by
running two integration test files concurrently against the shared Postgres database and watching
them deadlock on overlapping `TRUNCATE`/`INSERT` statements.

## Verifying the milestone

This is the sequence that establishes the six conditions of the M2 design spec's §11
("M2 is complete only when all six conditions ... are true"), corrected from an earlier draft that
queried the development database without ever migrating or seeding it (which fails on a fresh
database with `relation "Task" does not exist`):

```bash
docker compose ps
npm run db:generate
npm run db:migrate
npm run db:migrate:test
npm run db:seed
npm test
npm run typecheck
docker compose exec postgres psql -U aiteamos -d aiteamos \
  -c 'SELECT status, count(*) FROM "Task" GROUP BY status ORDER BY status'
.githooks/pre-push
```

| # | §11 condition | Checkable without a Docker daemon? |
|---|---|---|
| 1 | Compose brings up a healthy Postgres on 5433 | **No.** `docker compose ps` requires the Docker daemon. A reachable, healthy Postgres answering on `127.0.0.1:5433` is necessary but not sufficient evidence that Compose itself produced it — on a machine without Docker, this condition can only be asserted by a substitute database, never observed as passed. |
| 2 | Migrations apply cleanly to an empty database | Yes — `npm run db:migrate` / `db:migrate:test` against an empty database; look for `All migrations have been successfully applied.` and no errors. |
| 3 | The seed produces the Atlas organisation and tasks in all twelve statuses | Yes — after `npm run db:seed`, the `psql` query (or an equivalent client) should return one row per `TaskStatus` value. |
| 4 | Enum parity passes by full enumeration | Yes — `npm test` runs `packages/db/test/integration/enum-parity.test.ts`, which compares every Postgres enum value against the domain union, not a sample. |
| 5 | All four event-path tests pass against the real database | Yes — `npm test` runs `packages/events/test/integration/append.test.ts`. |
| 6 | Typecheck and tests are green, and the pre-push hook runs them | Yes — `npm run typecheck`, `npm test`, and `.githooks/pre-push` (which runs both and refuses on failure). |

Condition 1 is the one gap: `docker compose ps` cannot be run at all without a Docker daemon, so
its check is unavoidably indirect wherever Docker is unavailable — do not read a healthy
substitute database as proof that Compose was exercised.

## Running the orchestrator

Everything below drives the *development* database configured in `.env`. It spawns real `claude`
processes, creates real git worktrees inside the workspace's own repository, and spends real money.

```bash
npm run orchestrator -- help          # the commands, and what clear-halt is not
npm run orchestrator -- tick          # one scheduling pass, then wait for the run it started
npm run orchestrator -- daemon        # the loop: a 1s timer plus the event channel
npm run orchestrator -- status        # active runs, their pids and worktrees, and any halt
```

`--workspace <id>` may be omitted while the database holds exactly one workspace; with more than
one it is required, and the error names them.

### What a worktree looks like

A run does its work in a git worktree of the workspace's own repository, on its own branch:

```
<workspace repo>/
  .aiteamos/
    .gitignore                     # `*` — the orchestrator's bookkeeping ignores itself
    worktrees/T-3f2a9c1b/          # the run's checkout, on aiteamos/T-3f2a9c1b-<slug>
    runs/<runId>/settings.json     # the per-run --settings file, registering the pause hook
    runs/<runId>/pause.flag        # written by `pause`, read by the hook
    artifacts/<taskId>/attempt-01/ # one log per verify command, per attempt
```

**A fresh worktree is empty of dependencies.** It is a new checkout, so `node_modules` is not
there and neither is anything else `.gitignore`d. That is what `Workspace.setupCommands` is for
(`npm ci`, a build) — without them the agent starts in a tree where nothing runs, and verify fails
for reasons that have nothing to do with its work. Setup runs again when a reworking task adopts
its previous worktree, because the commonest reason a worktree exists to adopt is a setup command
that failed the first time.

**Worktrees are preserved on failure and on cancellation.** They are the inspection surface: the
question after a failed run is "how far did it get", and a removed directory cannot answer it.

### Interrupting a run

```bash
npm run orchestrator -- pause  --run <id> --by <name>
npm run orchestrator -- resume --run <id> --message "try the other approach"
npm run orchestrator -- cancel --run <id>
```

`pause` arms the hook; the agent stops at its **next tool call**, not immediately — a hook deny
removes the agent's ability to act without stopping the agent, which is what ADR 0001 measured and
why the protocol has two parts. `resume` continues from the checkpoint written at the pause, in the
same worktree and session.

`clear-halt --workspace <id>` is **not** a variant of `resume`. It retracts a workspace-wide safety
halt — raised when a pause gate fails or a workspace cannot verify — and it starts nothing by
itself: it removes the reason nothing was starting.
