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
- **M4** — the web app: a read-only Overview page showing every agent's live status, streamed over
  SSE. See the Web UI section below and `docs/architecture.md`.
- **M5** — the Tasks board, the agent detail panel, and intervention from the browser: pause,
  message, resume, stop, all routed through `packages/control`. See the Web UI section below and
  `docs/architecture.md`.
- **M6** — the Activity page: a live, filterable, infinitely-scrollable timeline of every workspace
  event, plus tool-call sparklines. See the Web UI section below and `docs/architecture.md`.

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

## Web UI

```bash
npm run web
```

Serves the Next.js app at `http://localhost:3000` (or the next free port — Next prints which one
it picked if 3000 is taken). `npm run web` loads the root `.env` itself (`--env-file=.env`), the
same file the orchestrator and the seed script use, so it needs no separate configuration: point it
at a workspace with `http://localhost:3000/w/<workspaceId>` and it reads that workspace straight
out of the development database.

The **Overview** page (`/w/<workspaceId>`) shows one card per agent — status, current task, live
action line, provider, budget — a top strip with task counts and spend against the workspace
budget, and a halt banner when the workspace is stopped. The page updates itself: the initial
render is a server-side snapshot, and an SSE connection (`/api/w/<workspaceId>/events`) wakes the
client to refetch that snapshot on every event rather than streaming state piecemeal — see
`docs/architecture.md` for why. The one exception is each card's action line, which updates live
and directly from the event payload, because it is display-only and never confused for state.

The **Tasks board** (`/w/<workspaceId>/tasks`) lays every task out in columns by status — backlog,
ready, running, verifying, reviewing, blocked, done, failed. Clicking a card opens a detail panel
with its description, branch, rejection reason and its runs, newest first, each with its status,
cost, tool calls and (for a paused run) the step it paused at.

The **Activity page** (`/w/<workspaceId>/activity`, in the Sidebar next to Overview and Tasks) is a
live, filterable, infinitely-scrollable timeline of every `ExecutionEvent` in the workspace — every
run, tool call, task transition, intervention and guardrail trip, oldest at top, newest at bottom.
The filter bar's five kind chips (Runs, Tool calls, Tasks, Interventions, Guardrails) group the 20
underlying event types for everyday use; an "Advanced" popover lists all 20 raw types individually
for anyone who needs a narrower cut than a kind gives, alongside agent and task roster filters. Every
dimension round-trips through the URL (`?kinds=`, `?types=`, `?agents=`, `?tasks=`) — refreshing or
sharing the link restores the same view. The timeline itself is virtualized: scrolling up toward the
top pages in older history automatically, so deep scrollback stays cheap regardless of how far back
it goes, while staying pinned to the bottom live-follows new events as they arrive (an unpinned
timeline instead shows a "N new events" badge that jumps back and re-pins on click). The same
connection indicator as the Overview page's top bar — `connected` while the SSE stream is open,
`reconnecting` while `EventSource` is re-establishing it — doubles as the page's liveness signal for
the one-second delivery bar (spec §6; see `scripts/measure-activity-latency.mjs` below). A header
sparkline plots the workspace's tool-call rate over the last ten minutes, live-rotated every minute;
each agent card on the Overview page carries the same sparkline in miniature, scoped to that agent.

```bash
node --env-file=.env scripts/measure-activity-latency.mjs
```

The gate's measured half (spec §6, M6): seeds a throwaway workspace, starts the real web server,
opens the activity stream over plain `fetch`, appends 50 events at 100ms intervals, and reports the
min/p50/p95/max gap between each event's own `ts` and its frame's arrival — exiting non-zero if p95
is at or above 1000ms. It cleans up the workspace and the web server it started before exiting.

Clicking an agent's card on the Overview page opens its **detail panel**: the live event feed, and
the controls M5 adds — pause, message, resume, stop. What each control does is a claim through
`packages/control`, not a direct write (`docs/architecture.md`'s dependency rule):

- **Pause** is enabled while a run is `starting`/`working`/`resuming`. It arms the pause gate; the
  run stops at its next tool call, not immediately, same as the CLI's `pause` (see "Interrupting a
  run" above).
- Once the run is `paused`, the **message box** is writable — it POSTs to the run's `message`
  route and overwrites the one queued instruction (there is only ever one slot).
- **Resume** POSTs to `resume`, optionally carrying a message in the same request; it is disabled
  while the workspace is halted, with the halt reason shown next to it. The POST only ever records
  an intent — the run stays `paused` in the database until the daemon's tick claims it and spawns
  the continuation, because the web process never owns a child (`docs/architecture.md`).
- **Stop** is enabled whenever a run exists and hasn't concluded; it kills the process (with a
  grace period before SIGKILL), concludes the run, and blocks its task. The worktree is preserved,
  same as the CLI's `cancel`.

Every control POST is fire-and-forget from the UI's point of view: on success it does nothing
itself and waits for the next SSE-triggered snapshot to show the new state; on a refusal (409) it
shows the refusal text inline. There is no optimistic UI — the snapshot is always the source of
truth (spec §4, §7).

```bash
npm run demo
```

The one-command live demo (spec §8): resets `~/.aiteamos/demo-repo` to a fresh git repository,
seeds a new workspace, team, agent and task into the *development* database, and starts the
orchestrator daemon against it, printing the workspace id and its Overview URL. Run `npm run web`
in a second terminal and open the printed URL (or its `/tasks` board) to watch it live. It spends
real money against the real `claude` CLI by default; to rehearse it for free, point it at the fake
adapter the same way the orchestrator tests do:

```bash
AITEAMOS_CLAUDE_BIN=node \
AITEAMOS_CLAUDE_ARGS="$(pwd)/packages/providers/test/fake-claude.mjs --fixture complete" \
npm run demo
```

`AITEAMOS_CLAUDE_ARGS` must be an absolute path here: the adapter spawns the child in the run's
worktree, not the repo root, so a relative path to the fixture script resolves against the wrong
directory and the child dies before writing anything.

**Under the fake adapter the task ends `failed`, and that is expected, not broken.** The fake
CLI replays a canned transcript — it never actually runs the `Write`/`Bash` tool calls the
transcript narrates, so the worktree ends the run with none of `notes/note1.txt` through
`note3.txt` on disk. The demo's `verifyCommands` (`test -f notes/note3.txt`) then fails for real,
and the task exhausts its attempts into `failed` exactly as it would for a real agent that never
wrote the files. This is not the adapter lying about success — `run.succeeded` and "verify passed"
are different claims, and the fake only ever earns the first one. Watching this once end to end is
the point of the exercise: it is what "verify fails by design under the fake" looks like on the
board, so it doesn't get mistaken for a real defect later. To rehearse the intervention flow
(pause/message/resume/stop) rather than a full verify pass, that's enough — none of the four
controls need verify to succeed, only a run to be alive when you reach for them.
