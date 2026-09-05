# Slave of AI

An autonomous AI engineering team for your git repositories. You attach a repo and set a goal; a
team of slaves plans the work into tasks, implements each one in its own git worktree, runs your
verify commands, reviews the diff and merges the branch. You supervise from a web UI: watch every
slave live, pause or redirect a run, read every event, and stop everything with one button.

It runs on your machine against your own Claude Code or Cursor CLI. Nothing leaves the host except
the model calls those CLIs already make.

## What you need

- Node 26 (see `.nvmrc`), git, Docker with the `docker compose` plugin
- A logged-in slave CLI: `claude` (Claude Code) and/or `cursor-agent`. The orchestrator finds them on
  `PATH`; set `SLAVEOFAI_CLAUDE_BIN` or `SLAVEOFAI_CURSOR_BIN` to point elsewhere.

## Quick start

```bash
npm install
cp .env.example .env
docker compose up -d                 # Postgres on localhost:5433
npm run db:generate
npm run db:migrate
npm run db:migrate:test
npm run db:seed                      # a demo company and workspace
git config core.hooksPath .githooks  # pre-push runs typecheck + tests
```

Then, in two terminals:

```bash
npm run orchestrator -- daemon       # the scheduler: picks up ready tasks, runs slaves
npm run web                          # the UI at http://127.0.0.1:3000
```

Everything uses the development database named in `.env`. Running slaves spend real money on your
provider account.

## Attach your repository

A workspace is a local git clone you already have. Attach it from the CLI or from the **Projects**
page's **New project** button in the UI:

```bash
npm run orchestrator -- create-workspace --name <name> --repo /abs/path/to/repo \
  --verify "npm test" [--verify "<cmd>" ...] [--setup "<cmd>" ...] \
  [--base main] [--budget <usd> | --no-budget] [--provider claude_code|cursor]
```

`--repo` must be an absolute path to a git working tree, `--base` an existing branch, and at least
one `--verify` command is required: a task is only done when your verify commands pass. The
orchestrator keeps its worktrees and logs under `<repo>/.slaveofai/` and gitignores them for you.

Staff it and give the team something to do:

```bash
npm run orchestrator -- assign-company --workspace <id> --company <id>   # or from the project card on the Projects page
npm run orchestrator -- set-goal --workspace <id> --goal "Add rate limiting to the public API"
```

A workspace with a goal and an empty board gets a planning run on the next tick. The planner writes
tasks; slaves whose role matches pick them up. A company is a persistent roster of slaves built
from templates — manage it on the Projects page's team catalog and the Slaves page, or with
`create-company`, `add-team`, `add-slave`. Departments are per project; the catalog holds
department templates that `assign-company` copies.

## The web UI

| Page | What it shows |
|---|---|
| **Projects** `/` | Every active project (workspace) with its spend and team; click one to open it. **New project** attaches a repo; **show archived** also lists archived projects (an "archived" chip, no spend bar, a **restore** button); below the cards, the team catalog (slave templates, companies and their department templates — every row there can be deleted, down to the company or template itself). |
| **Overview** `/w/<id>` | One card per slave: status, current task, live action line, spend against budget. A halt banner when the workspace is stopped. |
| **Tasks** `/w/<id>/tasks` | The board by status. Click a task for its runs and cost, its verify logs under **Artifacts**, and a **Collect worktree** button once it has finished. |
| **Graph** `/w/<id>/graph` | Five views: the org tree, live execution, the task dependency DAG (draw or delete an edge to change it), the skill chain, and who handed work to whom. |
| **Office** `/w/<id>/office` | The project's departments and slaves as a pixel office: who is working, blocked or paused, on what and how far; pause, resume or stop the focused slave's run; scroll to zoom, drag to pan, click a slave to focus. |
| **Activity** `/w/<id>/activity` | Every event, live, filterable by kind, slave and task; the filters live in the URL. Events made from the UI name the user who made them. |
| **Settings** `/w/<id>/settings` | This project's goal, its runtime (provider, budget, and the read-only concurrency/timeout/attempts limits), its own slave permissions, its emergency stop, and its danger zone to archive/restore the project. |
| **Slaves** `/slaves` | One table + Departments: every slave, project-materialized or still catalog-only, with its department as a select, rename/re-role/delete a slave with its history and a model chosen from the provider's own list inline; **+ New slave** adds one to the catalog and, optionally, to a project; a **Departments** tab beside it to add, rename or delete a project's department, along with the slaves on it. |
| **Skills** `/skills` | The skill catalog and its assignments. |
| **Analytics** `/analytics` | Spend and throughput. |
| **Settings** `/settings` | Provider adapters, security, and reset demo data (development only). |

Every page updates itself over a live event stream. Interventions — **Pause**, **Resume** (with a
message), **Stop** — live in the task panel. **Emergency stop** lives in the project header (on
every project tab) and on the project Settings tab's danger zone. A pause takes effect at the
slave's next tool call; a resume continues from the checkpoint in the same worktree.

## CLI cheat sheet

```bash
npm run orchestrator -- help
npm run orchestrator -- status                              # active runs, pids, worktrees, halts
npm run orchestrator -- tick                                # one scheduling pass
npm run orchestrator -- pause  --run <id> --by <name>
npm run orchestrator -- resume --run <id> --message "try the other approach"
npm run orchestrator -- cancel --run <id>
npm run orchestrator -- emergency-stop --workspace <id> --by <name>
npm run orchestrator -- clear-halt --workspace <id>         # lift a workspace halt (starts nothing)
npm run orchestrator -- archive-workspace --workspace <id>  # nothing runs until restored; refused while a run is live
npm run orchestrator -- restore-workspace --workspace <id>
npm run orchestrator -- list-workspaces                     # every project, archived ones marked
npm run orchestrator -- rename-slave --slave <id> --name <n>
npm run orchestrator -- set-role --slave <id> --role <r>
npm run orchestrator -- delete-slave --slave <id> --yes
npm run orchestrator -- delete-company --company <id> --yes
npm run orchestrator -- delete-company-slave --slave <companySlaveId> --yes
npm run orchestrator -- delete-template --template <id> --yes
npm run orchestrator -- create-user --name <u>              # password read from stdin
npm run orchestrator -- list-users
```

Every `delete-*` verb deletes what it names WITH everything under it (a slave's run history, a
department's slaves, a company's roster, a template's catalog slaves) and is refused only while a
live run is in the way. Omit `--yes` on any of them to preview the footprint it would delete
without deleting it.

`--workspace <id>` can be left out while there is exactly one workspace.

## Using it from another device

By default the UI binds to loopback only and needs no login. To reach it from a phone, a laptop or
your tailnet:

```bash
echo "SLAVEOFAI_SESSION_SECRET=$(openssl rand -hex 32)" >> .env
printf '%s\n' "$PASSWORD" | npm run orchestrator -- create-user --name <you>   # 12+ characters
npm run web:exposed
```

With a secret set the app runs in **accounts mode**: every page and API call needs a signed-in user,
sessions are 30-day signed cookies, and deleting a user locks them out on their next write.
`web:exposed` refuses to start without a secret of 32+ characters and at least one user.

Two things to know first:

- **Every account is a full operator.** There are no roles. A signed-in user can attach any path on
  this machine as a workspace and define the commands the orchestrator runs — that is code
  execution on the host. Create accounts only for people you would give a shell to.
- **Traffic is plain HTTP.** Use it over a tailnet (Tailscale) or a LAN you trust, never the open
  internet.

Upgrading from an older version: `SLAVEOFAI_PASSWORD` is retired and ignored; replace it with
`SLAVEOFAI_SESSION_SECRET` as above.

## Tests and CI

```bash
npm test               # unit + database integration tests (Postgres must be up)
npm run typecheck
```

The `npm run gate:*` scripts are end-to-end proofs of each milestone against fake slave CLIs, so
they spend nothing; CI runs `gate:m15-boundary`, `gate:m20-auth`, `gate:m21-loose-ends` and
`gate:m23-onboarding` on every push. Tests and gates share one Postgres — run one at a time.

## Learn more

- `docs/architecture.md` — how the pieces fit: control verbs, the event log, the orchestrator, the UI
- `docs/domain-model.md` and `docs/event-model.md` — the entities and every event type
- `docs/decisions/` — the architecture decision records
- `docs/superpowers/specs/` — the design spec of every milestone, M3 through M24
