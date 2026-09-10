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

Four ways in: **Projects**, **Workforce**, **Simulations**, **Settings**. Everything else is inside
one of them — `docs/ia.md` is the map, and says where anything that left a main path went.

| Page | What it shows |
|---|---|
| **Projects** `/` | Every active project (workspace) with its status in one word, how many things need you, its spend and its team; click one to open it. **New project** attaches a repo; **show archived** also lists archived projects (an "archived" chip, no spend bar, a **restore** button); below the cards, the same all-project figures the Analytics page shows. |
| **Overview** `/w/<id>` | The project in one screen: what it is for and at which version, what the Supervisor is doing, what is being worked on, what it has cost, what needs you, the latest verified result, who is on the team and what changed lately — above a timeline of the project's own history in six lanes, where the things waiting on you can be answered in place. One box tells the Supervisor what changed. `Advanced ▾` on the page holds the live event river, the blocked list, the merge queue and the Supervisor's own panel. |
| **Tasks** `/w/<id>/tasks` | The board by status. Each card says its state in one word, who has it, and one line about why it is not moving. Click one for the rest, grouped under `Details ▾`: the run, its messages, what it saw, its verification attempts, its cost, its worktree and its events. |
| **Graph** (Advanced ▾) `/w/<id>/graph` | Five views: the org tree, live execution, the task dependency DAG (draw or delete an edge to change it), the skill chain, and who handed work to whom. Reached from the project's `Advanced ▾` menu, or by its URL. |
| **Office** (Advanced ▾) `/w/<id>/office` | The project's departments and slaves as a pixel office: who is working, blocked or paused, on what and how far; pause, resume or stop the focused slave's run; scroll to zoom, drag to pan, click a slave to focus. Reached from the project's `Advanced ▾` menu, or by its URL. |
| **Activity** `/w/<id>/activity` | Every event, live, filterable by kind, slave and task; the filters live in the URL. Events made from the UI name the user who made them. |
| **Settings** `/w/<id>/settings` | This project's goal, its runtime (provider, budget, and the read-only concurrency/timeout/attempts limits), its own slave permissions, its emergency stop, and its danger zone to archive/restore the project. |
| **Workforce** `/workforce` | Everyone who works here, in four tabs. **Slaves**: every slave, project-materialized or still catalog-only, with its department as a select, rename/re-role/delete with its history and a model chosen from the provider's own list inline; **+ New slave** adds one to the catalog and, optionally, to a project. **Departments**: add, rename or delete a project's department and see who is on it. **Catalog**: every slave template as one searchable catalog — filter by division, capability, skill or where it came from, and click a row for its specialist profile: who it is, what it is for, what it must never do and where all of that came from, with any field customisable in place and the raw Markdown a run is given under `Advanced ▾` — beside the companies and their department templates, with the log of catalog imports under the tab's own `Advanced ▾`. **Skills**: the skill catalog and its assignments. `/slaves` and `/skills` still work — they redirect here. |
| **Simulations** `/sim` | Company simulation runs (M29): create one from a catalog company — a trade company on synthetic data, decided by the rules provider, no repository and no model call; step it by day, run it to a horizon, pause, halt, add customer demand or a supplier delay; the simulated company's cash and the real model cost are two separate panels; metrics are computed from the run's own journal; clone a run under another policy, let the daemon auto-run it, compare two runs side by side (no verdict); adopt a software run's organisation into a company-less project (M33). |
| **Analytics** `/analytics` | Spend and throughput, for every project or for one (`?workspace=`). The all-project view is also a section on the Projects page; a project's own view is one click from it. |
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
npm run orchestrator -- messages [--workspace <id>]         # every question a slave is waiting on
npm run orchestrator -- answer --message <id> --text "use Postgres" [--by <name>]
npm run orchestrator -- confirm-integration --task <id>     # after a hand merge (autoMerge off); unblocks its dependents
npm run orchestrator -- unblock-task --task <id> [--allow-another-attempt]  # move a blocked task back to rework
npm run orchestrator -- emergency-stop --workspace <id> --by <name>
npm run orchestrator -- clear-halt --workspace <id>         # lift a workspace halt (starts nothing)
npm run orchestrator -- archive-workspace --workspace <id>  # nothing runs until restored; refused while a run is live
npm run orchestrator -- restore-workspace --workspace <id>
npm run orchestrator -- list-workspaces                     # every project, archived ones marked
npm run orchestrator -- rename-slave --slave <id> --name <n>
npm run orchestrator -- set-role --slave <id> --role <r>    # the TITLE only; dispatch reads set-runtime-roles
npm run orchestrator -- set-runtime-roles --slave <id> --roles backend,reviewer [--by <name>]   # --roles '' parks it
npm run orchestrator -- set-profile --slave <id> | --template <id> | --company-slave <id> (--file <path> | --clear) [--by <name>]
npm run orchestrator -- show-context --run <id> [--prompt]  # the manifest of what a run was told
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

## What a slave is told

Every run's prompt is assembled in one place, from named sections, and the assembled text is
recorded before the model is started — so you can always read exactly what a slave saw.

**Its persona is a profile.** Markdown, up to 16k characters: who this worker is, what it is good
at, how it works. It resolves through the same override chain as the model — **the worker's own
profile, else its roster row's, else its template's** — so you can write one persona for a template
and override it on a single project's copy:

```bash
npm run orchestrator -- set-profile --template <id> --file atlas.md   # the catalog persona
npm run orchestrator -- set-profile --slave <id> --file atlas-here.md # this project's copy only
npm run orchestrator -- set-profile --slave <id> --clear              # back to the inherited one
```

The slave panel has a **Profile** block that shows the effective text with where it came from
(*this worker's own profile*, *inherited from its roster row*, *inherited from its template*);
saving there always writes an override on the worker, never on the roster row or the template.

**A title is not a role.** `Slave.role` — what `set-role` writes and what the UI prints under a
name — is the heading of the persona, read by humans. What the system matches on is
`runtimeRoles`: the scheduler picks a slave for a task when the task's required role is in that
set, reviewer and manager staffing look for `reviewer` and `manager` in it, and a message
addressed to a role is delivered by it. So a worker titled *Senior Engineer* can be dispatched as
`backend` and staffed as the reviewer, and nothing anywhere matches the words "Senior Engineer".

```bash
npm run orchestrator -- set-runtime-roles --slave <id> --roles backend,reviewer
npm run orchestrator -- set-runtime-roles --slave <id> --roles ''    # parks it
```

An empty set means the worker **cannot be dispatched at all** — that is a real state, not a
mistake, and it is how you bench somebody without deleting them. The role chips appear wherever a
worker is listed (its card on the Overview, its panel, the all-workers table on `/slaves`), and a
parked worker shows *cannot be dispatched — no runtime roles* instead of chips, with a compact mark
on its node in the org graph.

**Its skills are really there.** The skills you assign on `/skills` are copied into
`<worktree>/.claude/skills/<name>` before the run starts, so the runtime actually finds them. A
skill the catalog knows but the disk no longer has is *not* named in the prompt — the run starts
without it and the manifest records it under `missing`, rather than sending the slave looking for
something that is not there. A skill your repository ships itself is left alone and recorded as
`shadowedByRepo`: the runtime discovers the repo's own copy anyway, and overwriting it would put a
diff in front of your merge.

Nothing that is copied in shows up in `git status`, because the injected paths are added to **the
repository's `info/exclude`** (`git rev-parse --git-path info/exclude`) rather than to a
`.gitignore`, which would itself be a file in the tree. Two consequences worth knowing, both
accepted deliberately: that file is repository-wide, so it accumulates one line per skill name ever
injected and never removes one, and an *untracked* `.claude/skills/<name>/` of your own in the main
checkout is hidden from `git status` too. Tracked files are never affected — git does not ignore
what it already tracks.

**And you can read back what any run saw.**

```bash
npm run orchestrator -- show-context --run <id>            # the manifest: section by section, where each came from
npm run orchestrator -- show-context --run <id> --prompt   # and the prompt itself, after a rule
```

In the UI, every run in the task panel has a **What this run saw** button (served by
`GET /api/w/<id>/runs/<runId>/context`): the same section list, with any missing skills highlighted,
and the full prompt in a collapsed block underneath.

## Requirements have versions

The goal you set is the requirement the whole project works from, and it is **versioned**. Every
accepted `set-goal` writes a new immutable version — v1, v2, v3 — and prints the number it wrote
with the hash of the text:

```bash
npm run orchestrator -- set-goal --workspace <id> --goal "Ship the importer, and document it"
# {"version":2,"sha256":"ed9aad…"}
npm run orchestrator -- goal-history --workspace <id>   # every version, newest first, with diffs
```

Setting the goal to the text it already reads is **not** an edit: nothing is recorded and the
command exits non-zero saying which version already reads that. The **Goal** panel in the UI shows
`v<N>`, keeps the same history with a line-by-line diff of each edit, says *no change — still v2*
when you save the same words, and tells you *a re-plan will run on the next tick* when you save a
new goal on a board that already has tasks.

**Every planned task remembers which version produced it.** The board shows `goal v<N>` on each
card, and a card whose version is behind the project's carries a **stale** badge — the work was
derived from a requirement that has since moved. Hand-made tasks are *unstamped*: no plan derived
them, so there is no version for them to be behind.

**Changing the goal on a board that already has tasks runs a re-plan.** On the next tick a manager
gets one run whose prompt carries the previous goal, the new goal and the current board, and asks
for a **delta** — what to add, what to cancel, what to keep. Then:

- **Additions apply at once.** They land on the board as `ready` tasks stamped with the new
  version, exactly like a first plan's.
- **Cancellations are only proposals.** Each one becomes a Supervisor proposal you approve or
  reject ([The Supervisor](#the-supervisor)); nothing is taken off the board until you say so. A
  wrong addition costs one row you can cancel; a wrong cancellation costs real planned work.
- **Nothing in flight is ever touched.** A running, reviewing, merging or finished task cannot be
  cancelled by a re-plan at all — the request is dropped and recorded in the log with the status
  that refused it.
- **One re-plan per version**, and its failures count against the same planning retry cap as a
  first plan. Edit the goal twice before a tick runs and it is the latest version that gets the
  re-plan.

The activity timeline records all three moments — the re-plan starting, what it decided, and each
cancellation. Approving one greys the card (and its node in the org graph) with the reason on it,
and leaves anything that **depended** on it blocked: the work was never done, so the dependent
stays unschedulable until you remove the dependency. You can take a task off the board yourself the
same way:

```bash
npm run orchestrator -- cancel-task --task <id> --reason "the goal no longer needs this"
```

Only a task that has not started (`backlog`, `ready` or `blocked`) can be cancelled, by you or by
an approved proposal.

To see what the next tick will do about a goal you just changed — and read the exact prompt the
re-plan would be given, without starting anything:

```bash
npm run orchestrator -- replan-status --workspace <id>            # willReplan, and what is in the way
npm run orchestrator -- replan-status --workspace <id> --prompt   # …and the prompt that run would get
```

`willReplan` comes with `blockedBy`, which names the first thing standing in the way when a re-plan
is due and not happening: `archived`, `halted`, `dedup` (this version was already re-planned),
`retry_cap` or `live_planning_run`. Reading the prompt starts no run and records nothing — the tick
is the only thing that dispatches one.

## Importing a catalog

A team you already have written down does not have to be typed in again. Point the CLI at a
directory of persona files and they become templates:

```bash
npm run orchestrator -- import-catalog --dir /srv/personas --by you
npm run orchestrator -- import-catalog --dir /srv/personas --role-map engineering=backend --dry-run
npm run orchestrator -- list-imports
```

A persona is a Markdown file with a small front matter block — `name` and a non-empty body are the
only fields that are required — under a directory named for its division. The division becomes the template's role, and
`--role-map` translates one into whatever your workers are dispatched as; only `manager` and
`reviewer` mean anything to the scheduler, everything else is a label. The persona's own text
becomes the template's profile, kept word for word, with one line in front of it saying where it
came from and when.

Re-running an import is the ordinary case, and it is safe. A file that has not changed is left
alone. A file that has changed updates the template it created. **A profile you have edited yourself
is never overwritten** — that row is skipped and says so. Nothing is ever deleted: a persona that
leaves the directory leaves its template exactly where it was. Every row that is not imported is
reported with a reason — its name is already taken, its text is longer than a profile may be, or the
file is not a persona at all — and the whole run is recorded, so `list-imports` and the Projects
page can tell you afterwards what happened.

`--dry-run` does the whole thing, database reads included, and writes nothing.

## Specialist profiles

An imported persona is not a wall of text any more. The import reads it into a SPECIALIST PROFILE:
who the worker is, what it is for, what it can do, what it knows, how it works, what it must never
do, what it produces, what "done" looks like, who it works with, which skills it wants — and where
all of that came from: the catalog, the file, the commit, the licence and the day it arrived.

```bash
npm run orchestrator -- show-profile --template <id>
npm run orchestrator -- show-profile --template <id> --markdown
```

A persona whose headings the mapper recognises comes through in full; one written to a different
shape comes through in part; one written to no shape at all comes through as itself. The profile
says which of the three happened rather than pretending. **Nothing is thrown away**: the sections
the mapper does not know are still in the profile, in the persona's own words, and they are the
first thing dropped if a profile is too long for a prompt rather than the only thing kept.

A specialist profile stays distinct from a RUNTIME ROLE. The profile says what a worker is for; the
runtime roles (`set-runtime-roles`) are what it can be dispatched as, and they are the only thing
the scheduler reads.

**You can change any field, and your change survives the next import.** Open Workforce → Catalog,
click a specialist, press `Customise`, edit one field and save it. Your words and the catalog's are
kept in different places, so re-importing the file brings every other field up to date and leaves
yours exactly as you wrote them — the import even tells you how many it kept. `Reset` on a field
puts the catalog's version back.

Under `Advanced ▾` in the same drawer is the profile as a run actually receives it, and a raw
override: your own Markdown, replacing the rendered profile entirely. That one is all-or-nothing,
and a template carrying it is skipped by every import until you clear it — which is exactly what
you want when you have written a persona yourself, and exactly what you do not want when you only
meant to change a sentence. The catalog marks the two differently: `customised` for fields,
`raw override` for the whole text.

## The whole story

Every section above describes one seam. `npm run gate:m41-scenario` runs them in sequence, once,
against real orchestrator daemons and the fake slave CLI — one requirement, one plan, a worker that
stops to ask a question nobody in the company can answer, a Supervisor that answers it from a
sentence in the worker's own task and wakes it up, work verified, reviewed by a slave that wrote
none of it and merged onto `main` by a person, a changed requirement that produces a delta re-plan,
and a human approving the one cancellation it proposed. Then, with nothing running, it asks the
board, the goal history, the Supervisor, the mailbox, the spend and the event log what happened, and
they all have to say the same thing. Running the seams together is how it found a defect none of
them could see alone: a review run's own `run.succeeded` woke the daemon before the task had left
`reviewing`, and a second reviewer started on the same branch — a review run now claims its task the
way an implementation run does.

`docs/scenarios/e2e-software-team.md` tells that story act by act, with what each one asserts.

## The Supervisor

Every project has one, and it is not a slave: no `Slave` row, no runs, no worktree, no prompt of
its own written for anybody else. At the end of every tick it looks at the project, names what is
stuck, picks an action for each stuck thing out of a catalogue **the rules built**, does the
routine ones itself through the ordinary control verbs, and puts the risky ones in front of you as
proposals. Every decision is a row you can read afterwards, with the situation it was made on, the
whole catalogue it chose from, and why.

**What it watches for.** A task waiting in review with nobody holding `reviewer`; a goal with no
tasks and nobody holding `manager`; a task parked at the review retry cap; a failed task other
tasks depend on; a task blocked for any other reason; a question that has waited half an hour, or
one addressed to a role nobody holds; a startable task whose required role has no holder; work
that has been done but unmerged for six hours with dependents waiting; and a project whose
scheduling has stopped.

**Two tiers, fixed in code.** Routine actions apply immediately: sending a task parked *by the
review retry cap* back to `rework` while it still has attempts, re-addressing an unanswered
question to somebody who can answer it, and sending an answer it can *prove* (see below).
Everything else is a proposal that waits for you — raising an attempt cap, writing a worker's
runtime roles, declaring a task failed, and **unblocking a task that anything else parked**. That
last one is the rule worth knowing: `blocked` means a human has to look at this,
and two of the ways a task gets there are deliberate (a cancelled run, a worktree the daemon
refused to adopt), so the review cap is the one park the Supervisor knows a safe exit from. While
the project is **halted** every action is a proposal — a guardrail has already said this project
should not be moving, so the Supervisor may say what it would do and nothing more. "Halted" here
means an emergency stop, a spent budget or a tripped circuit breaker; a project merely at its
concurrency cap is busy, not stuck, and nothing is frozen for it.

**The model picks, the rules offer.** Where a model is wired and the budget allows it, the
Supervisor asks for an *index into the catalogue* and a rationale — it can never add an action,
and an answer that will not parse or points outside the list falls back to the rules. It asks
about at most three situations per tick; the rest are decided by the rules in the same pass, not
held over. A situation already in front of you is not asked again, and one decided in the last
fifteen minutes is left alone; proposals nobody answers expire after a day.

**Its mailbox.** A question one slave asked another no longer waits on you by default. Every tick
the Supervisor reads the questions still waiting for an answer and, for each one, does one of four
things. It **answers it itself** when it can prove the answer: the model is asked for an answer
*and its sources*, and the answer is only sent when every quote it cites is found **verbatim** in
the thing it named — the asking task's title or description, the project goal, a message in the
thread (never the question itself), or the asker's own recorded run context. That is a **sourced**
answer, and it goes out immediately as `system`, waking the waiting slave on the next tick. Any
other answer is an **interpretation**: written down as a proposal with the citations that failed
and *why*, and sent to nobody until you approve it — you can rewrite it first, and the row keeps
both texts. It **re-addresses** a question instead, routinely, when the slave it was sent to is
busy and somebody else holds the role that can answer it. And it **escalates** — never answers —
when a blunt, deterministic word list matches the question: `scope` (scope changes and new
requirements), `permissions` (credentials, tokens, sudo, admin), `secrets` (API keys, passwords,
private keys), `spend` (budget, cost, pay), `destructive` (delete, drop, force-push, `rm -rf`), and
`external` (email, contact, a customer or client). That check runs *before* the model is asked, so
a question about an API key never reaches one; the model can also flag a question critical itself,
and both signals are recorded. The list is deliberately blunt — a false positive costs one
escalation.

**In the UI**, a drafted answer appears in *waiting on you* as the question, an editable box seeded
with the draft, its confidence, each verified quote with the source it was found in, each rejected
quote with the reason, and the critical flags; **Approve** sends your edit only if you changed it.
A **questions waiting** block under it lists every pending question with who it waits on. From the
shell, `approve-decision --id <id> --body-file <path>` sends your own words instead of the
Supervisor's (read untrimmed — it is also how you answer a question it escalated with an empty
draft), and `reassign-question --message <id> --to <slaveId>` moves a question by hand. Decisions
are kept for **30 days** — counted from when they were resolved, or from when they were written if
they never waited on you — and then deleted on an ordinary tick. Two kinds are kept for good: a
proposal still waiting on you, however old, and **any decision that called a model**, because those
rows are the record of what the Supervisor spent and the budget guardrail reads them with no time
limit.

**Upgrading turns it on.** The Supervisor is on by default, so the first time the daemon starts
after this upgrade it begins supervising **every project you already have** — including the pass
that may call a model. Every question that has already been waiting longer than **30 minutes**
counts as stale on the very first tick after the upgrade, so the Supervisor starts working through
the backlog at up to **three model decisions per tick** until it is clear. A project with a **budget** stops calling the model the moment the budget
guardrail says the money is gone, so its unattended spend is bounded by the budget you already
set. A project with **no budget** (`budgetUsd` cleared) has no such ceiling: nothing but the $1
per-call cap and the three-calls-per-tick limit stands between it and a model call on every tick.
To switch it off:

```bash
npm run orchestrator -- set-supervisor --workspace <id> --disable
```

**Its spend is the project's spend.** A Supervisor call is capped at $1, and a call whose cost the
provider never reported is charged at that cap rather than counted as free — so the budget
guardrail sees it. The Overview's spend tile names the Supervisor's share beside the total. When
the budget guardrail halts the project, or no model is wired, the Supervisor decides by the rules
and calls nobody at all.

**In the UI**, the Overview page carries a **Supervisor** panel under the halt banner: *done* /
*stuck* / *next*, then *waiting on you* — each pending proposal with what it would do, why, and
**Approve** / **Reject** (with an optional reason) — then the recent decisions with their tier,
status, who decided (model or rules) and the rationale, and finally a switch that turns the
Supervisor down to report-only and a box for its own profile (its persona and house rules, which
go into the decision prompt). The five `supervisor.*` events have their own cards on Activity.

**From the shell:**

```bash
npm run orchestrator -- supervise --workspace <id>              # one pass, with the model seam
npm run orchestrator -- supervise --workspace <id> --dry-run    # what it WOULD decide; writes nothing
npm run orchestrator -- supervisor-decisions --workspace <id> [--pending] [--limit <n>]
npm run orchestrator -- approve-decision --id <id>              # carry the proposal out
npm run orchestrator -- approve-decision --id <id> --body-file <path>   # ...with your own answer
npm run orchestrator -- reject-decision --id <id> [--reason <text>]
npm run orchestrator -- reassign-question --message <id> --to <slaveId> [--by <name>]
npm run orchestrator -- set-supervisor --workspace <id> (--enable | --disable)
npm run orchestrator -- set-supervisor --workspace <id> (--profile-file <path> | --clear-profile)
```

`supervise` is the one command that spends on a model call by hand; the daemon's own pass does the
same thing on every tick. `--dry-run` writes no decision row, no event and makes no call, so it
costs nothing to look. A switched-off Supervisor still reports and still retires stale proposals —
it just stops deciding.

## One Supervisor

You do not manage the workers. You talk to the project's Supervisor, and the project page is that
conversation.

The top of the page is a brief: what this project is for and at which version of that requirement,
what the Supervisor is doing right now in one word, how much work is in flight and in what state,
what it has cost against its budget, what is waiting on you, the last thing anybody verified, who
is on the team, and what changed lately. Eight facts, one screen — `gate:m45-project-experience`
measures that literally, by asserting every tile's bottom edge is above the fold at 1440×900.

Under it is the project's own history, in six lanes:

| Lane | What is in it |
|---|---|
| **USER REQUEST** | What you asked for — a goal you set, a change you requested, a task you cancelled |
| **SUPERVISOR INTERPRETATION** | What it understood: the delta a re-plan produced, in its own words — "understood v3: +Add Apple Pay; proposes cancelling the gift-card page; 4 kept" |
| **PLAN CHANGE** | What actually changed on the board |
| **WORK IN PROGRESS** | What workers are doing, one line per task |
| **DECISION REQUIRED** | What is waiting on you — pinned above everything else, and answerable here |
| **VERIFIED RESULT** | What passed, was approved, or landed in the base branch |

What a model said while it worked is not on this timeline. That is the event river, one click away
under `Advanced ▾`, and the Activity tab keeps all of it.

**Telling it what changed.** One box, one sentence: *"Also support Google Pay."* That writes a new
version of the project's requirement — the goal document keeps its body and gains a dated line
saying what you asked — and the next tick re-plans that version as a delta. What the re-plan adds
becomes tasks; what it wants to cancel becomes a proposal you approve or refuse, in the DECISION
REQUIRED lane. Your words are kept beside the version, so the timeline shows what you asked and not
only what it produced.

```bash
npm run orchestrator -- request-change --workspace <id> --request "Also support Google Pay"
npm run orchestrator -- replan-status --workspace <id>      # why the next tick will, or will not, re-plan
```

Nothing here is new authority. Every button on that timeline is a verb that already existed — the
Supervisor's approve and reject, the answer that unsticks a waiting worker, the unblock that sends a
parked task back for another attempt. The Supervisor still proposes and you still decide.

## When a slave asks a question

A slave that hits a decision it cannot make alone can ask another slave instead of guessing. Every
implementation run is told how, and given the roster of who it may address, so this needs no setup
from you — reviewers are not, because a review run's question could never be answered. Its
run stops with the question on record and its task moves to **waiting** — an amber `WAITING` pill,
still on the **In Progress** column, because the work is mid-flight: the session is alive, the
worktree is still held, and nothing has failed. No attempt is charged, no verify or review pass is
spent, and the slave panel shows `waiting for <whoever was asked>` with the question underneath.

**`waiting` is not `blocked`.** `blocked` is the **Blocked** column and means the project needs you
before anything can move. `waiting` usually resolves itself: the slave who was asked answers on its
own next run, and the asker is resumed inside its original session — same conversation, same
worktree — with the answer in front of it. Answering is the way to unstick it *early*, not a duty.

**You are not the first responder.** On every tick the Supervisor reads the pending questions and
may answer this one itself — but only from a quote it can find in the task, the goal, the thread or
the asker's own context — draft an answer for you to approve or rewrite, or put the question in
front of a colleague who can reply. See [Its mailbox](#the-supervisor).

Two ways to answer yourself:

```bash
npm run orchestrator -- messages                                    # the pending questions, with their ids
npm run orchestrator -- answer --message <id> --text "use Postgres"
```

or type into the answer box on the waiting slave's panel in the UI. Either way the answer is
delivered on the next tick and the slave picks up where it stopped. Answering twice with the same
text writes one answer and resumes once. Resuming the slave *without* answering (`resume --run`, or
the panel's Resume button) is also a way out: the question stops being pending, and nobody is asked
about it again.

If somebody else answers first, a later answer is **not** thrown away and **not** delivered: it
stays in the thread marked *superseded*, so the thread still reads as the conversation it was, and
the daemon logs which answer won.

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
they spend nothing. CI runs `gate:m26-vocabulary`, `gate:m15-boundary`, `gate:m20-auth`,
`gate:m21-loose-ends`, `gate:m23-onboarding`, `gate:m29-simulation`, `gate:m30-simulation-compare`,
`gate:m31a-llm-decisions`, `gate:m31b-software-sector`, `gate:m33-adopt`,
`gate:m35-pipeline-honesty`, `gate:m36-messaging`, `gate:m37-run-context`, `gate:m38-supervisor`,
`gate:m39-supervisor-mailbox`, `gate:m40-requirement-versioning`, `gate:m41-scenario`,
`gate:m42-catalog-import`, `gate:m44-ux-foundation`, `gate:m45-project-experience` and
`gate:m46-workforce-catalog` on every push — `m36` stops the orchestrator and starts it again
mid-scenario, to prove a waiting slave's question survives a restart, `m37` reads a real run's prompt and worktree back to prove a slave was
given the persona and the skills it was assigned, `m38` drives a real daemon until the Supervisor
proposes the staffing a reviewer-less project needs, waits for a human to approve it, unblocks a
review-capped task by itself, and escalates a project whose budget is gone without spending a cent
to decide that, and `m39` drives one until the Supervisor answers a question from a quote in the
asking task and wakes the slave that was waiting, drafts an answer it cannot prove and sends only
the words a human typed over it, refuses to answer a question about an API key at all, re-addresses
a stale one to a colleague who can, and deletes a month-old decision while leaving a month-old
proposal alone, and `m40` drives one until a changed goal produces a delta re-plan whose addition is
on the board and whose cancellation is still only a proposal, then approves it and shows the task
that depended on the cancelled work still cannot start, and `m41` runs all of it as ONE story —
plan, ask, a Supervisor answer, a resume, a review, a hand merge, a re-plan and an approval — and
then asks every operator surface at once whether they agree about what happened
(`docs/scenarios/e2e-software-team.md`), and `m42` imports a directory of persona files into the
template catalog twice over — creating what is new, skipping what an operator has edited, updating
what changed on disk, and staffing a project from the result until the imported persona itself turns
up in a real run's recorded prompt, and `m44` drives a real browser over every page at once to
check that there are four ways into the product, that the project's own strip answers "what is
happening" in four tabs with Graph and Office still one menu away, that nothing on any of eleven
pages is a database value a person would have to decode, that a drawer traps the Tab key and hands
focus back on Escape, that the skip link is the first thing the keyboard finds, that the sidebar
collapses on a narrow window, and that simulated money is never shown beside real model cost,
and `m45` opens a fixed project in a real browser and checks that you can understand it in one
screen: the eight facts render above the fold with the words they promise, the six lanes carry the
seeded entries in the right lanes with no model chatter among them, exactly four things need a
person and every one of their links resolves, approving a proposal from the timeline really cancels
the task, one sentence typed into the box really becomes goal v3 with your words stored and a
re-plan armed, and a task's raw values are reachable only inside its `Details` groups,
and `m46` imports a fixture catalog out of a real git checkout and proves the profile is structure
rather than prose: four personas map to full, partly and not at all, each one's stored Markdown is
byte-identical to a re-render of its own spec and inside the cap, the source record carries the
checkout's commit and the licence off its LICENSE file, one field customised in a real browser is
still the operator's after the file behind it changes (and the import says it kept it), a raw
Markdown override still stops an import dead while the row beside it updates, and the profile a
worker is finally given — rendered sections, the operator's sentence and the persona's own words —
turns up in a real run's recorded prompt. That is 21 gates. Tests and gates share one Postgres — run one at a time.

## Learn more

- `docs/architecture.md` — how the pieces fit: control verbs, the event log, the orchestrator, the UI
- `docs/domain-model.md` and `docs/event-model.md` — the entities and every event type
- `docs/decisions/` — the architecture decision records
- `docs/superpowers/specs/` — the design spec of every milestone, M3 through M24
