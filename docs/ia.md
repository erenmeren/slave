# Information architecture

What each surface is for, and where anything that left a main path went. Written in M44 from an
audit of every route, panel, control, token and test in `apps/web`; it is the contract M45–M56 read
before adding a surface.

## The rules

1. **Do not build a dashboard for everything.** A number belongs on the page where somebody can act
   on it. A new page needs a question no existing page answers.
2. **Nothing is removed, only moved.** Every capability below is still reachable — by a tab, by a
   menu, or by its own unchanged URL. This table is where you find out which.
3. **One vocabulary.** Task, run, slave and workspace STATUSES a person reads come from
   `packages/domain/src/status/user.ts`. Everything else a surface must put a word to keeps its own
   label table beside the thing it names — skills, simulations, event families, Supervisor
   situations and tiers, provider kinds. What is not negotiable is the second half of the rule: the
   raw value stays available — in `title`, in a `data-` attribute, or in the expanded view — and no
   surface prints a bare enum member as its visible text.
4. **Real is not simulated.** Simulations live under `/sim`, carry a SIMULATION chip, and their
   money is never shown beside model cost.
5. **Advanced is a promise, not a graveyard.** Anything under Advanced keeps working, keeps its
   tests and keeps its URL.

## Top-level navigation

| Entry | Route | The question it answers |
|---|---|---|
| Projects | `/` | What am I building, and what needs me? |
| Workforce | `/workforce` | Who works here, and what can they do? |
| Simulations | `/sim` | What would a company like this do? |
| Settings | `/settings` | How is this installation set up? |

## Global surfaces

| Route | User goal | Decision | M44 | Later |
|---|---|---|---|---|
| `/` | See every project and what needs me | keep | Project cards read one word from `userWorkspaceStatus` and carry a "needs you" count; the all-workspaces KPI strip moved in from `/analytics`; the team catalog moved out to Workforce → Catalog | M45 rewrites the project card around the Supervisor |
| `/workforce` | Everyone who works here | **new** | Five tabs: Slaves, Departments, Catalog, Skills, Runbooks — the panels are the existing ones, moved | M46 rebuilt Catalog as the Workforce Catalog — search, filters, one row per specialist and a profile drawer; the hand-made template form, the company manager and the import log are still there, the last under the tab's own Advanced. M47 adds capabilities. M48 adds Runbooks: the stage plans a project can adopt, seeded, translated from a persona's own workflow, or written by hand |
| `/slaves` | — | **merged into** `/workforce` (Slaves tab) | 307 redirect | — |
| `/skills` | — | **merged into** `/workforce?tab=skills` | 307 redirect | — |
| `/analytics` | Spend and throughput | **demoted** from the sidebar, route kept | All-workspaces view is a section on `/`; per-workspace view is reached from a project; the URL and its `?workspace=` scope are unchanged and bookmarkable | M53 replaces the tiles with per-profile evidence |
| `/sim`, `/sim/:id`, `/sim/compare` | Try a company on synthetic data | unchanged | Status chips read words instead of enum values | — |
| `/settings` | Provider adapters, security, reset demo data | unchanged | Reseed uses the one destructive recipe | — |
| `/login` | Sign in | unchanged | — | — |

## Project surfaces (`/w/:id/…`)

| Route | User goal | Decision | M44 | Later |
|---|---|---|---|---|
| `/w/:id` Overview | What is happening right now, and what needs me | keep (tab 1) | M44: untouched content, and the six leaks in its panels closed. **M45**: rebuilt as a brief (eight facts), one input to the Supervisor, and a six-lane timeline whose decisions are answerable in place; the live-events river, the blocked panel, the merge queue and the Supervisor panel moved under `Advanced ▾` on the page; the team is the same card grid, under a `Team` label | M47 lifted the org graph's content into an Organization tab (M46's scope was the catalog; it did not). M48 adds the runbook panel between the request box and the timeline: what this project has adopted, which stage it is on, and which stages the plan skipped. M49 adds one line to the `latest verified` fact — `Knowledge: N verified · M candidates`, linking to the tab. M50 marks a temporary specialist on the team strip and greys a released one |
| `/w/:id/tasks` Tasks | What work exists, in what state | keep (tab 2) | Untouched | M45 adds progressive disclosure |
| `/w/:id/organization` Organization | Who works on this, why they were chosen, and what is missing | **new** (tab 3) | — | M47: one row per worker — their lifecycle, the capabilities they provide, why they are here and what they are doing — plus a Needs section whose proposals are answered in place, and the advisory edges a persona's profile carries. M50 marks each worker's lifecycle — Permanent, Project or Ephemeral — as a chip beside their name, and a worker brought in for one assignment and since released keeps their row, greyed and sorted last, with the date the engagement ended |
| `/w/:id/knowledge` Knowledge | What this project has learnt, and who says it is true | **new** (tab 4) | — | M49: one row per memory — what kind of knowledge, its scope, the provenance sentence that says where it came from and who verified it — with filters by scope, type and status, a search on the title, and Verify / Correct / Remove in place; the expanded row shows the chain (what it replaced, what replaced it, what it summarises) |
| `/w/:id/activity` Activity | What happened, in order | keep (tab 5) | The event-type rail reads words; the raw prefix is on `data-prefix` and in `title` | — |
| `/w/:id/settings` Settings | Goal, runtime, permissions, danger | keep (tab 6) | Emergency stop uses the one destructive recipe | — |
| `/w/:id/graph` Graph | Five structural views of the project | **demoted to Advanced ▾** | Reachable from `Advanced ▾ → Graph` and by URL; all five modes intact; the mode nav is a real tablist now | M47 lifted the org mode's content into an Organization tab; Graph stays |
| `/w/:id/office` Office | The team as a pixel office | **demoted to Advanced ▾** | Reachable from `Advanced ▾ → Office` and by URL; the canvas gains a label and a text line saying what it shows | — |
| `/analytics?workspace=:id` Analytics | Spend and throughput for THIS project | **reached from the project** | The third item in `Advanced ▾`, carrying the project's `?workspace=` scope; the route and the scope are the global page's, unchanged and bookmarkable | M53 replaces the tiles with per-profile evidence |

## Panels that stay where they are, deliberately

- `SlavePanel`, `GraphDrawer` and `TaskDetailPanel` are persistent side panels, not modals: they do
  not close on Escape and do not trap focus, because a person reads them while working in the page
  behind them. `Dialog`/`Drawer` are for the six things that ARE modal.
- `HaltBanner` keeps its own component rather than becoming an `Alert`: four gates key off it.
- The Tasks board's pill keeps its board vocabulary in M44. `userTaskStatus` is the domain's task
  word and is wired to one thing here — the "needs you" count on a project card.
- The Overview's own `Advanced ▾` holds the four panels that left its first viewport — the
  Supervisor panel, `blocked · needs you`, the live-events river and the merge queue. All four
  keep their components, their tests and their behaviour; the river keeps its 340 px, which
  `gate:m14-fidelity` still measures (it opens the disclosure first).

## What "needs you" counts, exactly

Every project card's number is `needsYou(...)` from `packages/domain/src/status/user.ts`, asked per
task-status group rather than restated in the query — three of its four clauses are answerable from
grouped counts:

- tasks that are `blocked`;
- work that is `done` and not integrated, on a project that does not merge by itself;
- **`SupervisorDecision` rows that are `pending`** — DECISIONS, not the tasks they are about. That
  table has no task column: its `subjectId` is a task id, a message id, a role name or the
  workspace's own id depending on the situation, and plenty of pending decisions are about no task
  at all (`ready_unstaffed` is about a role). Counting rows never claims a task needs a person that
  does not, and at most one decision per situation is open at a time, so one question is never
  counted twice.

Not yet: a task waiting on a question nobody can answer — that needs a per-task read, and it
arrives with M45's needs-you queue. The number is honest about being a floor, and no surface calls
it a total.

M45 shipped that queue on the project Overview (`apps/web/src/server/needsYou.ts`) and it does make
that per-task read, so the two numbers can disagree: the card's count (`apps/web/src/server/org.ts`,
grouped) stays the FLOOR and the queue is the fuller answer. Reconciling them — one reader, one
number, on both surfaces — is booked for M46.
