# Information architecture

What each surface is for, and where anything that left a main path went. Written in M44 from an
audit of every route, panel, control, token and test in `apps/web`; it is the contract M45–M56 read
before adding a surface.

## The rules

1. **Do not build a dashboard for everything.** A number belongs on the page where somebody can act
   on it. A new page needs a question no existing page answers.
2. **Nothing is removed, only moved.** Every capability below is still reachable — by a tab, by a
   menu, or by its own unchanged URL. This table is where you find out which.
3. **One vocabulary.** Task, run, slave, PERSON and workspace STATUSES a person reads come from
   `packages/domain/src/status/user.ts` — a slave is `IN THE POOL`, `ASSIGNED` or `RELEASED`
   (M58 R28), and which of the three is DERIVED from their seats rather than stored. Everything else a surface must put a word to keeps its own
   label table beside the thing it names — skills, simulations, event families, Supervisor
   situations and tiers, provider kinds. What is not negotiable is the second half of the rule: the
   raw value stays available — in `title`, in a `data-` attribute, or in the expanded view — and no
   surface prints a bare enum member as its visible text.
4. **Real is not simulated.** Simulations live under `/sim`, carry a SIMULATION chip, and their
   money is never shown beside model cost.
5. **Advanced is a promise, not a graveyard.** Anything under Advanced keeps working, keeps its
   tests and keeps its URL.
6. **Two modes, one product (M61 R1).** The console runs in `simple` for a person who runs a
   company and does not read code, and in `developer` for the person who built it. A mode is
   `data-mode="developer"` on `<html>`, the `localStorage` key `mode`, a pre-hydration `<head>`
   clause and `components/mode/ModeProvider.tsx` — built exactly the way the theme is, and the
   ABSENCE of the attribute is simple, which is the default for anybody who has never chosen. The
   switch is the rail's bottom control (`mode-toggle`), `Mod+Shift+D`, and a segmented control on
   Settings → Appearance. **A mode never changes a URL and never removes a destination**: rule 2
   holds across both, which is why a developer-only route opened in simple mode does not redirect
   — the tab bar renders it as an extra current tab marked `data-outside-mode="true"`.

## Modes

What each mode is, said once (M61 R1/R18/R19):

- **Simple hides, it never removes.** The rail is Home · People · Settings; a project's tabs are
  Team · Work · Office · Activity; Activity opens on the digest; the Workforce page IS the People
  tab with its segments hidden; the Team card carries no `technical` line and the board's cards no
  run details; Home carries no KPI strip. Every one of those destinations still answers at its own
  URL, and the tab bar marks one you reached that way `data-outside-mode="true"` so you can see
  where you are and leave by any other tab.
- **Developer ADDS; it never re-skins.** It adds Simulations and Analytics to the rail, Graph and
  Knowledge to the tab strip, the `technical` line to each Team card, the run/worktree/artifact
  groups to a task's detail panel, the staffing preferences and the roster to the Team tab, the
  all-projects KPI strip to Home, and the `Knowledge: N verified · M candidates` line to the Team
  tab. Same frame, same primitives, same testids — a different palette (`app/tokens/developer.css`),
  a denser scale (`--fs-body` 13px, `--row-h` 34px) and a larger set of things on screen.
- **Nothing hidden is unreachable.** `gate:m61-simple-mode`'s stage 10 walks every route in the
  tables below, and every `?tab=`, `?section=` and `?view=` value, in BOTH modes.

## Top-level navigation

There are two of them, and they answer different questions (M61 R5/R18). **The rail** is a 56 px
icon column on the left with the global destinations — the ones that are not a project — and
expands to 208 px over the content while the pointer is on it. **The project switcher** is the
header's breadcrumb crumb: a button (`project-switcher`) that opens a popover listing every
project from the same `GET /api/sidebar` read the tree used, one `project-switcher-item` per row
with the same dot, the same amber `data-needs-you` count and the same `data-status`, plus a
`New project` row that opens the intake Sheet. The M57 sidebar tree is gone as a widget; no
destination went with it.

| Rail entry | Route | Modes | The question it answers |
|---|---|---|---|
| Home | `/` | both | What am I building, and what needs me? |
| People | `/workforce` | both | Who works here, and what can they do? |
| Settings | `/settings` | both | How is this installation set up? |
| Simulations | `/sim` | developer | What would a company like this do? |
| Analytics | `/analytics` | developer | Spend and throughput across every project |

The rail's footer keeps the live chip (`sidebar-live`) and the theme pill (`theme-toggle`), and
gains the mode switch (`mode-toggle`). `skip-link` is still the first focusable element and the
rail's landmark is `nav[aria-label="Main"]`.

A project's own strip is the `command-strip` inside `/w/[workspaceId]/layout.tsx`: the needs-you
bar, then the tab bar (`project-tabs`, one `project-tab` per `tabsFor(mode)`), then the gear
(`project-settings`) at its right in both modes.

| A project's tab | Route | Label | Modes |
|---|---|---|---|
| Team | `/w/:id` | **Team** | both |
| Work | `/w/:id/tasks` | **Work** | both |
| Office | `/w/:id/office` | Office | both |
| Activity | `/w/:id/activity` | Activity | both (simple's `href` carries `?view=digest`) |
| Graph | `/w/:id/graph` | Graph | developer |
| Knowledge | `/w/:id/knowledge` | Knowledge | developer |
| (the gear) | `/w/:id/settings` | Settings | both |

`lib/routes.ts` is still the one table: `TABS`/`tabsFor`, `RAIL`/`railFor`, `sectionOf`, `viewOf`,
`workspaceIdOf`, `breadcrumbOf`. `VIEWS` is reduced to `analytics` alone, because Graph and Office
are tabs now. The six section rows and the `VIEWS` chip group M57 drew in the tree are these two
tables; every destination is at the URL it always had.

## The header

48 px, on every page, mounted by the ROOT layout (M57 R7, M61 R6): a breadcrumb
`Projects / <project> / <tab>` whose PROJECT crumb is the switcher's trigger, the `⌘K` search
(`search`, which was `sidebar-search`), a HALTED pill while the project is halted, the budget
`$x / $y` beside a 100 × 5 px bar, the `⌘J` hint for the Supervisor on project routes, and one
split button — `Pause all | Stop ▾`, where `Stop ▾` arms on the first click and fires on the
second, and reads `Clear halt` while the project is halted. A page contributes its own primary
action (`+ New project`, `Hire from catalogue`, `+ New slave`, `+ New simulation`) into the
header's slot. It is a glass surface (`--glass`, blur, an `--edge` bottom edge instead of a 1 px
line) and it keeps every testid it had.

`Pause all` and `Resume all` are the web's own fan-outs over verbs that already existed — the first
is `pauseActiveRuns`, which an emergency stop has always used; the second is a loop over the same
per-run `requestResume` a single worker's Resume button calls. `Clear halt` is `clearHalt`, which
until M57 was two columns written inline in the CLI's own `clear-halt` case and had no web route at
all. None of the three adds an event type.

The live/latency chip that used to sit here is the rail's footer now, beside the theme pill and the
mode switch.

**One width.** The frame has a **1024 px minimum** and no breakpoints (M61 R4, down from M57's
1280): a desktop app window is smaller than a browser tab, and the rail shrinking from 236 px to
56 px is most of what makes the lower floor fit a usable middle column. Below the floor the shell
scrolls as a whole. **The page itself never scrolls at all**: `html, body { overflow: hidden }`,
the shell is `h-dvh`, `<main>` is `overflow-hidden`, and every page puts its scrolling content
inside `ui/ScrollArea` (`data-scroll-axis`, `overscroll-behavior: contain`) — the board's columns,
the Supervisor's messages, a Sheet's body. The three long tables — People, Activity's river and
Knowledge — render their rows through `@tanstack/react-virtual` inside one.

## The right panel

340 px on every `/w/:id/*` route, collapsing to a 52 px dock, and an OVERLAY below 1280 px — the
same content `position: fixed` at the right, glass, no scrim, with the grid's third track set to
`none` (M57 R8, M61 R4/R14). It is absent on every global route. **It opens by default and
remembers being closed**: `collapsed` is read from `localStorage['supervisor']` after hydration and
written on every collapse and expand. `Mod+J` toggles it, and a keyboard toggle animates nothing.

Its default content is the **Supervisor**, which is a conversation: a thread is one local calendar
day of this project's `workspace.goal_set` (the operator's own typed words, which M45 put on the
payload), its `supervisor.*` rows and — since F — the conversation's own turns, and its decision
cards are the same pending list the command strip's needs-you bar reads. M57 added no table and no
event type; F added the one table, and no event type.

**F gives the conversation rows of its own, and three routes.** The composer is a MESSAGE now, not
a goal change: it sends to `POST /api/w/:id/supervisor/messages` (`{ text, attachments? }` → the
person's line and the reply placeholder; 409 for a message past the cap or an attachment that is
not a file this conversation put in the inbox), and the panel reads the thread back from `GET` on
the same path (`?limit=`, newest end). Asking for the goal to change is something the REPLY may
propose — a `request_goal_change` card under it, answered like every other proposal — so a question
that wanted an answer no longer re-plans the whole board. `POST /api/w/:id/goal/request` is
untouched and still serves the CLI; nothing in the panel calls it.

A reply that has not landed yet is a **thinking…** row (`supervisor-thinking`), and the thread is
re-read every two seconds while one is on screen — a model call in flight writes nothing, so the
shell's own wake-up cannot report it. A turn nothing could answer is a `supervisor-failed` row
carrying the reason as a sentence (no runtime for the provider, the budget, a reply that would not
parse; anything else is the runtime's own words, shown verbatim with the raw reason in `title`). A
reply whose every citation checked out wears the **sourced** chip, and the cards under a reply are
one per action it asked for — the ones the view still holds keep Approve and Decline, and one
already carried out shows the verb and its tier with nothing to press.

The **Attach** button and the drop zone around the composer hold files until Send, then send a
multipart form to `POST /api/w/:id/supervisor/uploads` FIRST and post the message with the paths it
answered — so a message can only ever name a file that is really in the repository, and a refused
upload keeps the words and the files on screen. That route writes every file into the repository's
`docs/inbox/` on the base branch, commits it and answers with each path — **413** past twenty
megabytes, **415** for an extension nothing here can read, **400** for more than five files or a
name that is a path. What is waiting to go is a chip per file with a way to take it back off; what
went is a chip per file on the message, name and size, with the path one hover away.

The header's runtime and model selects (`supervisor-provider`, `supervisor-model`) PATCH
`/api/w/:id/supervisor/settings` the moment they move (`{ provider, model }`, either one `null` for
the installation default; a provider this installation does not have is a **400**), and a refused
change puts the select back and says why. They govern every Supervisor call for the project, not
just this thread, which is why they sit here rather than in Settings alone. Changing the runtime
clears the model with it: a model id is a name one vendor knows. Beside them is the conversation's
**cost so far** — the measured money, and `N turns unpriced` when some turn reported none, never
the two folded together (a Cursor turn reports no price at all).

Those message rows are **merged into the same day buckets as the events above, in time order** — so
a decision still appears beside the message that caused it — and nothing is deduplicated: a goal set
that echoes a message somebody typed renders as both, because nothing on either row says one caused
the other.

Its scope line carries the project's one autonomy switch (`supervisor-autonomy`, label **act on its
own**), which PATCHes `/api/w/:id/supervisor/settings` and moves `Workspace.supervisorAutonomy`
between `propose` and `act` — the same setting Project Settings → runtime shows beside **merge approved work
automatically**. It belongs on the scope line rather than in Settings alone because it is the one
thing that changes what every decision card below it means: under `act` the cards are a record of
what was done, and only an escalation is still a question.

`SlavePanel` and `TaskDetailPanel` render in the SAME slot while one is selected, replacing the
Supervisor and handing it back on close. `?slave=` and `?task=` are still the source of truth and
still what a refresh restores. The dock's `S` button carries the pending-decision count, which is
why the dock exists at all: a person who collapsed the panel still has to be told when something is
waiting on them. On `/workforce` the person panel is a `Sheet` (`person-sheet`) rather than this
slot — that page has no project to supervise.

## Global surfaces

| Route | User goal | Decision | M44 | Later |
|---|---|---|---|---|
| `/` | See every project and what needs me | keep | Project cards read one word from `userWorkspaceStatus` and carry a "needs you" count; the all-workspaces KPI strip moved in from `/analytics`; the team catalog moved out to Workforce → Catalog | M45 rewrites the project card around the Supervisor. M59 replaced the New project form with a conversation; the form is one link away inside the same drawer. **M61** rebuilds Home as a LIST beside a live feed: a greeting, the needs-you queue across every project (answerable in place), one `project-row` per project, **Happening now** (`home-feed`/`feed-item`, every project's events as sentences), three numbers, and — in developer mode only — the all-projects KPI strip under them. **E** adds the two rows that say what the Supervisor DID rather than what it proposed: `supervisor.applied` ("The Supervisor retried “Read the market”") and `supervisor.failed` (the same phrase, with the refusal after it), both read off the whole action the applied event now carries. The needs-you queue is unchanged: under `act` it holds only escalations and questions |
| `/workforce` | Everyone who works here | **new** | Five tabs: Slaves, Departments, Catalog, Skills, Runbooks — the panels are the existing ones, moved | M46 rebuilt Catalog as the Workforce Catalog — search, filters, one row per specialist and a profile drawer; the hand-made template form, the company manager and the import log are still there, the last under the tab's own Advanced. M47 adds capabilities. M48 adds Runbooks: the stage plans a project can adopt, seeded, translated from a persona's own workflow, or written by hand. M53 adds Evidence, the sixth tab: two tables — per profile and per model, because they are two different questions — with counts, rates, and `Insufficient evidence` wherever the sample is too thin to claim one. No chart. M55 turns the Catalog into a surface that works at three hundred rows: the filtering and the paging happen in the database, there are two more filters (whether a row is hirable, and whether anything in the catalog looks like it), a `Show more` under the list, and a two-state toggle on every row — because nothing an import creates is hirable until somebody says so. Each row that looks like another carries one chip saying which and how, with the raw class one attribute away, and the profile drawer gains a fourteenth group listing every pair with a Dismiss beside it. Nothing is ever deleted by any of it. M57 shows four tabs — People, Catalog, Skills & runbooks, Evidence — and keeps all six `?tab=` values, the two folded ones as segments inside their new parent. M58 turns the People tab into one row per SLAVE rather than one row per project seat: their persona, their departments, how many skills they have, and one chip per project they work on — or "in the pool", which is what a slave with no seat and no release is. The filters are pool / assigned / released, department and skill; `⋯` opens the slave, whose panel gains a Projects group (every seat, "remove from project" on each, "assign to project" below) and a Skills group showing the effective set with the persona's own rows muted and labelled. The Catalog's persona drawer gains a Default skills editor, and the Skills tab stops assigning: each skill lists who has it, read-only, linking to the slave — rule 2's one click away. **M61**: in simple mode this page IS the People tab, its segments hidden and `Hire from catalogue` in the header opening the Catalog in a `Sheet`; a row opens the person in a `Sheet` (`person-sheet`) with `?slave=` still the source of truth; in developer mode the four segments render as before. Every `?tab=` value still answers, and one reached in simple mode renders the strip marked `data-outside-mode`. |
| `/slaves` | — | **merged into** `/workforce` (Slaves tab) | 307 redirect | — |
| `/skills` | — | **merged into** `/workforce?tab=skills` | 307 redirect | — |
| `/analytics` | Spend and throughput | **demoted** from the sidebar, route kept | All-workspaces view is a section on `/`; per-workspace view is reached from a project; the URL and its `?workspace=` scope are unchanged and bookmarkable | M53 did it: the per-slave table and the Spend tile are gone — the first because it counted one project's materialised workers, the second because its figure was a raw `SUM(costUsd)` with no provenance — and the route, its five remaining tiles and its `?workspace=` scope are unchanged, with a line pointing at Workforce → Evidence |
| `/sim`, `/sim/:id`, `/sim/compare` | Try a company on synthetic data | unchanged | Status chips read words instead of enum values | **M61** makes `/sim` a DEVELOPER rail item and restyles all three inside `ScrollArea`s; every route, every id and every testid is unchanged, and they still answer in simple mode by URL |
| `/settings` | Provider adapters, security, reset demo data | unchanged | Reseed uses the one destructive recipe | M59 adds Repositories. **M61** makes it two fixed columns — Providers, Appearance, Repositories, Security, Danger — with `?section=` round-tripped and only the chosen section mounted; Appearance keeps the theme control and gains the MODE one (`appearance-mode-simple`/`appearance-mode-developer`) |
| `/login` | Sign in | unchanged | — | **M61** re-draws it as one centred glass card on the same palette; it still renders no shell body (ruling T3-3) |

## Project surfaces (`/w/:id/…`)

M61 rebuilt this set as ONE command screen (R7): the `command-strip` above every tab, and the
**Team tab at `/w/:id`** — the project's canonical URL is its team. `/w/:id/organization` now
**redirects** (307, query string preserved) to it, because one page should not answer at two URLs;
`gate-m47-team-formation.mjs` follows the redirect and finds the `organization-*` testids on the
Team tab, which keeps them. `/w/:id/activity` has TWO VIEWS at one URL — the bare route is the raw
river (the developer tab's `href`), `?view=digest` is the simple tab's — and Graph and Knowledge
are developer tabs, reachable by URL in simple mode and marked `data-outside-mode="true"` there.

**Where each of the deleted Overview's blocks went** (`OverviewClient.tsx` and `ProjectBrief.tsx`
are gone as widgets, not as capabilities):

| Overview block | Where it is now |
|---|---|
| the brief's `work` tile | `stat-work` under the Team grid |
| the brief's `cost` tile | `stat-spend` (its total, and its unmeasured-calls / unmeasured-runs caveats as the tile's note) and the header's budget. `actual` / `estimated` / `upper bound` have no surface yet — booked, not forgotten |
| the brief's `objective` | `stat-goal`, with the version as its note (`data-goal-version`) and `Edit goal` beside it |
| the brief's `supervisor` state | the right panel, on every project route |
| the brief's `latest verified` | the Activity tab's river, where `task.integrated` already was |
| the brief's `Knowledge: N verified · M candidates` line | the Team tab, in developer mode, linking to the tab |
| `Needs you` | the command strip's `needs-you` bar, answerable in place |
| `Team` | the Team tab (`team-live`, one `team-card` per seat) |
| `How this project works` (runbook adopt) | project Settings → Runbook (`runbook-panel` kept) |
| `Recent changes` (timeline, live events, merge queue) | the Activity tab's raw view, under **Recent changes** |

| Route | User goal | Decision | M44 | Later |
|---|---|---|---|---|
| `/w/:id` **Team** | Who is working on this right now, and what needs me | keep (tab 1) | M44: untouched content, and the six leaks in its panels closed. **M45**: rebuilt as a brief (eight facts), one input to the Supervisor, and a six-lane timeline whose decisions are answerable in place; the live-events river, the blocked panel, the merge queue and the Supervisor panel moved under `Advanced ▾` on the page; the team is the same card grid, under a `Team` label | M47 lifted the org graph's content into an Organization tab (M46's scope was the catalog; it did not). M48 adds the runbook panel between the request box and the timeline: what this project has adopted, which stage it is on, and which stages the plan skipped. M49 adds one line to the `latest verified` fact — `Knowledge: N verified · M candidates`, linking to the tab. M50 marks a temporary specialist on the team strip and greys a released one. **M61** replaced the Overview with the Team tab: one `team-card` per seat with the person's name, role, an English `doing` sentence, a `LiveDot`, a 3px progress bar and (in developer mode) a `technical` line, over `server/teamLive.ts`; the three `Stat` tiles are under it and the table above says where every old block went |
| `/w/:id/tasks` Tasks | What work exists, in what state | keep (tab 2) | Untouched | M45 adds progressive disclosure. M54 stamps a task derived from an externally-originated requirement with where it came from, beside its goal version and never instead of it. **M61** renames the tab **Work**, fixes the filter row, puts the board in one sideways `ScrollArea` with a vertical one per column, and shows a card's run details in developer mode instead of behind a `Details` toggle |
| `/w/:id/organization` Organization | Who works on this, why they were chosen, and what is missing | **new** (tab 3) | — | M47: one row per worker — their lifecycle, the capabilities they provide, why they are here and what they are doing — plus a Needs section whose proposals are answered in place, and the advisory edges a persona's profile carries. M50 marks each worker's lifecycle — Permanent, Project or Ephemeral — as a chip beside their name, and a worker brought in for one assignment and since released keeps their row, greyed and sorted last, with the date the engagement ended. M53 puts the staffing preference where the staffing decision is read: one choice per capability, naming a profile, a model or both, which the Supervisor's ranking obeys ahead of any record and behind any refusal. M58 keeps this page showing SEATS — who is on THIS project — and makes a name open the slave rather than the seat, because the same slave may be on three other boards; "Add" offers the pool before it offers a new hire. **M61** redirects this route (307, query preserved) to `/w/:id`: the Team tab IS this page's content, every `organization-*` testid renders there, and the roster table and the staffing preferences render in developer mode |
| `/w/:id/knowledge` Knowledge | What this project has learnt, and who says it is true | **new** (tab 4) | — | M49: one row per memory — what kind of knowledge, its scope, the provenance sentence that says where it came from and who verified it — with filters by scope, type and status, a search on the title, and Verify / Correct / Remove in place; the expanded row shows the chain (what it replaced, what replaced it, what it summarises). **M61** makes it a developer tab, restyled not redesigned, with its rows virtualised inside a `ScrollArea` |
| `/w/:id/activity` Activity | What happened, in order | keep (tab 5) | The event-type rail reads words; the raw prefix is on `data-prefix` and in `title` | M52 adds the two brokered-operation cards and the permission change, and the tool-denial card finally prints the operation's name instead of its key. M53 adds the staffing-preference card. M54 adds the two external-delivery cards, and the rail gains an `External` family: what arrived, what it was about, and which goal version it produced. **M61** gives this route two views at one URL — the raw river, and `?view=digest`, one `digest-day` per local day of `digest-item` sentences — and re-homes the deleted Overview's **Recent changes** (the Supervisor timeline, the live-events river and the merge queue) under the raw one |
| `/w/:id/settings` Settings | Goal, runtime, permissions, danger | keep (tab 6) | Emergency stop uses the one destructive recipe | M52 turns the permission matrix into six OPERATIONS with words for column headers, a third click that takes a decision back, and copy that says what is enforced where instead of saying it is not enforced at all. M54 adds one line to the goal history: the version a connected repository asked for says which repository, and which issue or commit. Connecting a repository is a CLI act (`triggers map`) and deliberately not a form — it has to be paired with exporting a variable into the web process's environment and pasting a url into a provider's settings, and a form that could do only the first would imply the other two happened. **M61** makes it two fixed columns — a 180px `settings-nav` and the chosen section in a `ScrollArea`, `?section=` round-tripped, only the chosen one mounted — and adds the **Runbook** section the Overview used to carry |
| `/w/:id/graph` Graph | Five structural views of the project | **demoted to Advanced ▾** | Reachable from `Advanced ▾ → Graph` and by URL; all five modes intact; the mode nav is a real tablist now | M47 lifted the org mode's content into an Organization tab; Graph stays. M57 re-homed it from the `Advanced ▾` menu to the sidebar's `VIEWS` chips; the route and all five modes are unchanged. **M61** makes it a developer TAB on the project's own strip |
| `/w/:id/office` Office | The team as a pixel office | **demoted to Advanced ▾** | Reachable from `Advanced ▾ → Office` and by URL; the canvas gains a label and a text line saying what it shows | M57 re-homed it from the `Advanced ▾` menu to the sidebar's `VIEWS` chips; the route is unchanged. **M61** makes it a TAB in both modes and re-draws the black HUD boxes as one glass `office-toolbar` above the canvas with the focused character in an `office-focus` card beside it; the canvas, the engine and the `Silkscreen` font are untouched, and mono type in the DOM around the canvas is gone |
| `/analytics?workspace=:id` Analytics | Spend and throughput for THIS project | **reached from the project** | The third item in `Advanced ▾`, carrying the project's `?workspace=` scope; the route and the scope are the global page's, unchanged and bookmarkable | M53 did it: the per-slave table and the Spend tile are gone — the first because it counted one project's materialised workers, the second because its figure was a raw `SUM(costUsd)` with no provenance — and the route, its five remaining tiles and its `?workspace=` scope are unchanged, with a line pointing at Workforce → Evidence |

## Panels that stay where they are, deliberately

- `SlavePanel`, `GraphDrawer` and `TaskDetailPanel` are persistent side panels, not modals: they do
  not close on Escape and do not trap focus, because a person reads them while working in the page
  behind them. Since M57 `SlavePanel` and `TaskDetailPanel` render inside the shell's right-panel
  slot rather than as their own fixed asides — the placement moved, the non-modality did not;
  `GraphDrawer` is still the Graph page's own 352 px aside. `Dialog`/`Drawer` are for the six
  things that ARE modal. M52 gives `SlavePanel` a `Permissions` group between Skills and Messages —
  one line per operation, in the operation's words, with the three marks the Settings matrix draws;
  who decided each one and when is a raw value and lives under a nested `Advanced`, beside the
  sentence that says a run kind granted it.
- `HaltBanner` keeps its own component rather than becoming an `Alert`: four gates key off it.
- M57 closed the board's two vocabularies: it is five columns (Queued / In progress / Review /
  Blocked / Done), the columns are phases and the card's pill is `USER_TASK_LABEL` — the domain's
  own word — so there is one task vocabulary and not two. `COLUMN_FOR_STATUS` stays a total
  `Record<TaskStatus, BoardColumn>`, which is what makes a fourteenth status a build failure rather
  than an invisible task.
- The Overview's own `Advanced ▾` is gone in M57 and each of its four panels has a home: the
  Supervisor panel is the RIGHT PANEL on every project page, `blocked · needs you` is the
  Overview's own **Needs you** card (which shows all four kinds `buildNeedsYou` finds, not one),
  and the live-events river and the merge queue are under **Recent changes** on the same page, with
  `/w/:id/activity` still the whole river.
- **Later, and said so (M58 §8).** A slave-level "stop everything", across every project at
  once: pause, stop and the breaker stay per run and per project, and one button that reached
  into three boards would be a fourth thing that can halt work. Project-private memories: what a
  slave learns they know everywhere, and a memory that some projects may not see needs a
  visibility rule this milestone did not design. Budget sharing across seats: a budget belongs to
  a project and a slave on two projects spends two budgets. A slave analytics page — one slave's
  record across every project they have worked on. And renaming the `Slave` table to
  `Assignment`: the table is the SEAT and its name says otherwise, which is a milestone of churn
  for a name (spec D6) and is booked, not forgotten.

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
