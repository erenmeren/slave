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

**Done is not the same as integrated.** A task reaches `done` once it has been reviewed and its
verify commands pass — that is the only thing `done` means. Whether its code has actually reached
your base branch is a separate fact, `Task.integratedAt`.

**In practice, every workspace is hand-merge.** `autoMerge` defaults to `false` in the schema, and
nothing in this codebase ever sets it `true`: `create-workspace` has no flag for it,
`adopt-simulation` writes `false` explicitly and refuses to carry over a prior `true` (a project
that had it on loses it, on purpose), and there is no web setting or other CLI verb that turns it
on. So this is not one policy among two — it is the only one you will hit unless you reach into the
database by hand. Every task merges by hand: `done` leaves the branch and worktree sitting there for
you and `integratedAt` stays null. Any task depending on one that is `done` but not yet integrated
waits — the scheduler will not provision it from a base branch that does not yet have its
dependency's commits on it. Merge the branch yourself, then say so:

```bash
npm run orchestrator -- confirm-integration --task <id>
```

and its dependents become schedulable on the next tick. Expect to run this after every task your
dependency graph has downstream work waiting on.

`autoMerge = true` exists in the schema and is exercised by tests and simulation gates, and would
skip the step above by merging (and stamping `integratedAt`) the moment a task's review is
approved — but nothing ships a way to turn it on for a real workspace, so treat it as a future
switch rather than a normal mode. One consequence worth knowing if you ever do flip it (by hand, in
the database) on a workspace with history: turning `autoMerge` on does not retroactively stamp
anything. Tasks that already reached `done` by hand merge keep `integratedAt` null — correct, since
no merge happened through the new path — and stay unstamped, still blocking their dependents, until
you run `confirm-integration` on each of them once.

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

## Try a company simulation

A simulation is not a project: it needs no repository and, by default, calls no model. `npm run db:seed` ships
"Demo Trading Co." with the four roles the trade sector uses (sales, purchasing, operations,
finance). From **Simulations** → **+ New simulation** pick it, choose policy A (wait for the normal
supplier) or B (hedge with the fast one when a delivery is at risk), and run to day 30. Every
number on the page is synthetic and every metric is derived from the run's journal; the spec at
`docs/superpowers/specs/2026-09-06-m29-company-simulation-design.md` lists the assumptions.

With `npm run orchestrator -- daemon` running, **Auto-run** steps a run for you at its own pace
instead of clicking Step or Run to day. **Clone…** then the run page's "compare with" dropdown
puts two policies side by side — same scenario, same roster, same start, only the policy (or seed)
different — with no verdict, just the b − a deltas; `docs/superpowers/specs/2026-09-06-m30-simulation-reliability-and-comparison-design.md`
covers the reliability and comparison work.

### Try the software company

Choose sector `software` in the drawer instead, and the roster shape changes with it: a Product
slave who accepts requests into the queue, a Management slave (the `lead`) who assigns them to
engineers, a reviewer (or QA) slave, and at least two more Engineering slaves who do the work.
`npm run db:seed` ships one that fits: the catalog company **Checkout Platform** — the seeded
workspace's own crew, as a company — with a Business Analyst in Product, a manager in Management,
and Backend/Frontend/DevOps/QA/reviewer slaves in Engineering. (Build your own the same shape with
`create-company`, `add-team`, `add-slave` if you would rather.)

Policy A ships fast — whoever is free takes the task — which is quick but lets a mismatched or
unreviewed task surface a defect three days later; policy B reviews everything and waits up to two
days for an engineer who actually knows the area, so it never reworks. From the run
page, **Add external event** injects a feature request, an incident, or an engineer's absence into
the same queue; the sector's own metrics (delivered, on time, late, tasks reworked, defect
incidents, idle engineer-days…) come from the same journal every other sector reads.
`docs/superpowers/specs/2026-09-07-m31b-software-sector-design.md` has the full design.

**Adopt the organisation.** Once you like how a software run's crew works, you can put it on a
real project. From the run's page, **Adopt this organisation…** takes a project that has no
company yet (create one from Projects first) and materialises the run's roster onto it: the run's
lead becomes the project's manager and its reviewer the reviewer; every other member keeps its
catalog role. The drawer proposes `maxConcurrentRuns` (one per engineer) and `maxAttempts` from the
run's policy, both editable; `autoMerge` stays off. On an `llm` run a checkbox offers to set the
run's model on the lead's roster row — that is real, paid use, so it is only written when you tick
it. Adoption starts nothing: no daemon, no run, no deploy — the project waits for you to start it
as before. Afterwards the project's Overview says which simulation its organisation came from, and
the run's card shows an **adopted →** chip naming the project. A trade run has no adopt button:
its roles are not software roles.

### Let a model decide

By default every role is decided by a fixed rules provider — no model, no cost. From the **+ New
simulation** drawer you can instead choose decision provider `llm`: pick a Claude model, set a cost
cap in USD, and tick the consent checkbox before **Create simulation** unlocks — this is a real,
paid, capped run on your own account. Only one role per sector asks the model — trade's purchasing,
software's lead — once per simulated day; every other role stays on the rules provider. An `llm` run's page drops Step and Run to
day — it steps only through **Auto-run**, because the model calls are made by
`npm run orchestrator -- daemon`, never by a page click. Each call is spawned `--restricted
--strict-mcp-config --tools ""` plus a deny-all hook, an empty working directory and a four-variable
environment (`PATH`, `HOME`, `LANG`, `TERM`) — it can reach no tool, no file, no database and no
real system. Every call's real cost is shown on the run page against the cap (`$<spent> of
$<cap>`, never a misleading `$0.00` for an unmeasured call — a call whose cost the provider did
not report is charged as $1.00 toward the cap, an estimate on the safe side, and the panel says
so); the run halts on its own once the cap is reached, and a tool call from the model — the
isolation failing — halts the run immediately as an isolation breach. Both halts are permanent:
nothing about them resumes automatically.
`docs/superpowers/specs/2026-09-07-m31a-llm-decision-provider-design.md` has the full design.

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
| **Simulations** `/sim` | Company simulation runs (M29): create one from a catalog company — a trade company on synthetic data, decided by the rules provider, no repository and no model call; step it by day, run it to a horizon, pause, halt, add customer demand or a supplier delay; the simulated company's cash and the real model cost are two separate panels; metrics are computed from the run's own journal; clone a run under another policy, let the daemon auto-run it, compare two runs side by side (no verdict); adopt a software run's organisation into a company-less project (M33). |
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
npm run orchestrator -- confirm-integration --task <id>     # after a hand merge (autoMerge off); unblocks its dependents
npm run orchestrator -- unblock-task --task <id> [--allow-another-attempt]  # move a blocked task back to rework
npm run orchestrator -- emergency-stop --workspace <id> --by <name>
npm run orchestrator -- clear-halt --workspace <id>         # lift a workspace halt (starts nothing)
npm run orchestrator -- archive-workspace --workspace <id>  # nothing runs until restored; refused while a run is live
npm run orchestrator -- restore-workspace --workspace <id>
npm run orchestrator -- list-workspaces                     # every project, archived ones marked
npm run orchestrator -- rename-slave --slave <id> --name <n>
npm run orchestrator -- set-role --slave <id> --role <r>
npm run orchestrator -- delete-slave --slave <id> --yes
npm run orchestrator -- delete-team --team <id> --yes       # a department WITH its slaves and their history
npm run orchestrator -- delete-company-team --team <companyTeamId> --yes
npm run orchestrator -- delete-company --company <id> --yes
npm run orchestrator -- delete-company-slave --slave <companySlaveId> --yes
npm run orchestrator -- delete-template --template <id> --yes
npm run orchestrator -- create-user --name <u>              # password read from stdin
npm run orchestrator -- list-users
npm run orchestrator -- create-simulation --sector trade|software --company <id> --name <n> --policy A|B [--seed <n>]
    [--decision-provider llm --model-provider claude_code --model <m> --max-model-cost-usd <n>]
npm run orchestrator -- step-simulation --simulation <id> [--steps <n> | --until-day <d>]
npm run orchestrator -- simulation-status --simulation <id>  # summary, the sector's own headline and metrics, model usage as JSON
npm run orchestrator -- pause-simulation --simulation <id>   # refuse every next step (clears auto-run)
npm run orchestrator -- resume-simulation --simulation <id>  # auto-run is not restored
npm run orchestrator -- halt-simulation --simulation <id> [--reason <text>]  # the emergency stop for a simulation
npm run orchestrator -- inject-simulation-event --simulation <id> --day <d> --event '<json>'
npm run orchestrator -- clone-simulation --simulation <id> --name <n> --policy A|B [--seed <n>]  # same world, day 0, nothing carried over
npm run orchestrator -- auto-run-simulation --simulation <id> [--every-ms <n>] [--until-day <d>]  # needs `orchestrator -- daemon` running
npm run orchestrator -- stop-auto-run --simulation <id>
npm run orchestrator -- compare-simulations --a <id> --b <id>  # both runs' metrics and b − a deltas as JSON, no verdict
npm run orchestrator -- adopt-simulation --simulation <id> --workspace <id> [--max-concurrent <n>] [--max-attempts <n>] [--apply-model]  # starts nothing; autoMerge stays off
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
