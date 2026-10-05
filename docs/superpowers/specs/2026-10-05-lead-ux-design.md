# The lead flow's interface, designed again from nothing

Date: 2026-10-05. Status: written for the operator; built in the same session without waiting for a reply
(the operator's instruction). Step 2 of the change of direction decided on 2026-10-04
(`2026-10-04-lead-flow-design.md`, R-5): "The interface is rebuilt from nothing on shadcn/ui, with the theme in
variables." It replaces `docs/ia.md` as the map of the web app.

## 1. Why

The operator's verdict on the interface on `main`: very hard to use, far too complicated. It was built for the
packages flow -- a board of tasks, departments, hiring, a planner, a Supervisor chat, a graph with five modes, a
pixel office, two "modes" of one product -- and it shows almost nothing of the lead flow, which is driven today
from the command line (`set-flow`, `set-lead`, `lead-status`, `retry-goal`, `confirm-goal-merge`).

`docs/ia.md` lists 6 rail destinations, 7 project tabs, a right panel with 3 contents, a header with a split
button, two modes, and a table of where 9 deleted blocks went. It is the thing being replaced. Its rule 2
("Nothing is removed, only moved") is retired: this design removes.

## 2. What a person does, and nothing else

The design starts from seven things a person does, in order:

1. **Describe** what they want built (the intake conversation that exists today).
2. **Cap the cost**: a budget, a working-time limit, or both.
3. **Watch** it being built: what the lead is doing now, what its helpers are doing, what was spent.
4. **Answer** when the build needs them: a decision about an unproven build, a merge only they can do.
5. **See the proof**: what was checked, what passed, what failed and why.
6. **Get the result**: merged, or waiting for their merge, with the full report.
7. **Stop, continue, check again or delete** a project.

Everything on screen serves one of these. Anything that serves none of them is not on screen (section 9).

## 3. Rulings

- U-1. **Four screens a person uses, two they rarely visit.** Home, New project, Project, Report; Helpers and
  Settings. Plus Sign in. One project is understood from ONE screen: the Project screen has no tabs.
- U-2. **One persistent frame.** A left sidebar (260 px) with the projects, each with its state dot and an amber
  "needs you" marker, and three links: New project, Helpers, Settings. The main area is the screen. No rail, no
  right panel, no header split button, no modes, no command palette.
- U-3. **A decision is impossible to miss.** When a build needs the person: the project's sidebar row turns amber
  with a count, Home lists it first under "Waiting for you", the browser tab's title starts with `(n)`, and the
  Project screen opens with an amber decision card at the very top, above everything, with the buttons in it.
  Nothing is answered anywhere else, and nothing needs a second screen to answer.
- U-4. **Plain words.** No internal term reaches the screen (section 6). A raw value may sit in a `title` or a
  `data-` attribute for the operator and the tests; it is never the visible text.
- U-5. **The cap is chosen, not defaulted.** New project asks "How much may it spend?" with four choices --
  a budget, a time limit, both, or no limit -- and "no limit" needs a ticked box that says what it means.
- U-6. **Every control that exists only in the CLI today has one place** (section 7), and it is on the Project
  screen or its Settings sheet.
- U-7. **Packages-flow projects open read-only** on the same Project screen, in a reduced form (section 8).
- U-8. **shadcn/ui is the only component system.** The hand-made primitives in `components/ui/` are replaced by
  shadcn components (new-york style, Tailwind 4, CSS variables, `lucide-react` icons). Light and dark themes both,
  from the same variables; System is the default.
- U-9. **Live by polling.** The Project screen re-reads one read model every 3 seconds while something runs and
  every 15 seconds otherwise; Home and the sidebar every 10 seconds. No event stream on the client: one read model
  per screen is simpler to reason about than a stream folded into five stores, and 3 seconds is live enough for
  a build measured in tens of minutes.
- U-10. **Delete is real.** A project can be deleted: its rows go, its repository on disk stays. Archive stays
  as the reversible way to hide a project.

The references the operator pointed at shaped three choices: the sidebar of projects with a live status line and
an "asked you" marker (U-2, U-3); the team shown as faces at work, each with what it is doing (the Project
screen's "Who is working" strip); and a catalogue of specialists grouped by what they are good at (Helpers).

## 4. The words, said once

| Internal (never on screen) | On screen |
|---|---|
| workspace | project |
| goal version, `v3` | build (Build 3) |
| goal text | what you asked for |
| request a change (`request-change`) | Ask for a change |
| lead, lead session | the lead (subtitle on first use: "the AI session that builds the whole thing") |
| subordinate, subagent, roster | helper; the helpers the lead may call |
| person (catalogue), persona, template | helper (in the catalogue: "specialist") |
| verifier | the checker |
| confirmer | the second checker |
| verification round | a check |
| requirement key `R3` | requirement 3 (the key stays visible as a small label: it is how the report names it) |
| pass / fail / unverifiable / disputed | Works / Doesn't work / Couldn't check / Checkers disagree |
| work branch, integration branch | branch (shown in mono only where the person must type it) |
| automatic merge, `autoMerge` | Merge automatically when everything is proven |
| `budgetUsd` | budget |
| `goalTimeLimitMs` | time limit (working time) |
| emergency stop, halt | Stop / Paused |
| clear halt + resume | Continue |
| `retry-goal` | Check again |
| accept as is (`acceptLeadGoalAsIs`) | Accept as it is |
| leave (`leaveLeadGoal`) | Leave it unmerged |
| `confirm-goal-merge` | I merged it |
| flow `lead` / `packages` | "One lead builds everything" / "Older way: many separate tasks" |
| provider `claude_code` | Claude Code |

## 5. The state of a project, in one word and one sentence

A project's state is derived from its newest build (the domain's `projectPhaseOf`, section 10) and is the same
word on every screen. The badge shows the word; the Project screen's header shows the sentence under the name.

| State (`data-phase`) | Badge | Sentence on the Project screen | Sidebar dot |
|---|---|---|---|
| `empty` | Not started | Nothing has been asked for yet. Describe what you want built below. | grey |
| `starting` | Getting ready | Slave is reading your request and setting up a branch. This takes a minute. | blue, pulsing |
| `building` | Building | The lead is building what you asked for. You don't need to do anything. | blue, pulsing |
| `checking` | Checking | An independent checker is starting the product and trying every requirement. | violet, pulsing |
| `needs_decision` | Needs your decision | The build stopped before everything was proven. Choose what happens next. | amber + count |
| `ready_to_merge` | Ready to merge | Everything that could be checked was checked. Merge it yourself, or let Slave merge it. | amber + count |
| `delivered` | Delivered | Merged into `<base>`. The proof is below. | green |
| `closed` | Left unmerged | You left this build. Its branch is kept; nothing was merged. | grey |
| `paused` | Paused | You stopped this project. Nothing runs until you press Continue. | grey, hollow |
| `failed` | Stopped by a problem | Slave stopped this project: `<reason in words>`. Fix it, then press Continue. | red |
| `older` | Older project | This project uses the older way of building. You can read it here; it cannot be driven from this screen. | grey |

Why a build stopped (`stopReason`), as the decision card and the report say it:

| Reason | Words |
|---|---|
| `proven` | Everything was checked on the running product and works. |
| `not_all_proven` | Some requirements could not be confirmed. |
| `no_progress` | The same problems came back two checks in a row. |
| `budget_spent` | The budget ran out. |
| `time_spent` | The time limit ran out. |
| `nothing_built` | The lead finished without building anything. |
| `lead_failed` | The lead kept failing and was stopped. |
| `proof_unusable` | The checks themselves kept failing, so nothing could be proven. |
| `accepted_as_is` | You accepted it as it was. |
| `left` | You left it unmerged. |

## 6. The screens

The frame (U-2) at desktop width: sidebar 256 px on the left, the screen to its right with a max content width
of 1200 px. Below 768 px (shadcn's own breakpoint) the sidebar slides in behind a menu button (shadcn `Sheet`)
and the screen takes the whole width; the Project screen's two columns fold to one below 1024 px.

The sidebar, top to bottom: the product mark "Slave of AI"; **New project** (a button); **Projects**, one row
per project: the state dot, the name, and on the right either an amber pill with the count of decisions waiting
or the state word in small grey text; **Helpers**; **Settings**; at the bottom the theme switch (Light / Dark /
System) and, with accounts on, the signed-in name and Sign out. An archived project is not listed; Home lists
archived projects in a collapsed group.

### 6.1 Home -- `/`

**Question it answers:** Is anything waiting for me, and how are my projects doing?

Layout: a heading "Projects" with a **New project** button on the right. Then, only when something waits, the
section **Waiting for you** (amber border): one row per waiting build -- project name, the decision's one-line
reason, how long it has waited, and an **Open** button that goes to the Project screen. Then a grid of project
cards, three across at 1200 px: name, state badge, the sentence of section 5 cut to two lines, a spend line
("$4.20 of $20 spent" with a thin bar; "$4.20 spent, no budget" without one) and "updated 3 min ago". Then a
collapsed **Archived (n)** group: name, Restore, Delete.

States and words:

- empty: an illustration-free empty state -- "No projects yet." / "Describe what you want built, and a lead
  builds it while Slave checks the result." / button **New project**.
- working, waiting, delivered, stopped, failed: the cards carry their own state (section 5); the page has no
  state of its own beyond "Waiting for you" being present or not.
- the read failed: "Could not load your projects. Retrying…" in a muted alert, the last good list kept.

### 6.2 New project -- `/new`

**Question it answers:** What do I want built, and how much may it spend?

Layout: two columns. Left (flexible): the conversation -- the assistant's questions and the person's answers as
bubbles, the "what we found" facts about a folder as a small muted card, a composer at the bottom ("Describe
what you want built…", **Send**). Right (400 px): the **Project card**, which fills in when the assistant has a
draft and is editable from then on:

1. **Name**.
2. **Where the code lives** -- three choices: "A folder I already have" (path field), "A new folder in
   `<repositories folder>`" (shows the full path that will be made), "A new folder at…" (path field).
3. **How much may it spend?** (U-5) -- four choices as radio cards:
   - **Budget** -- "Stop when this much has been spent." `$ [20]`
   - **Time limit** -- "Stop after this much working time." `[90] minutes` (10 to 1440)
   - **Both** (preselected) -- "Stop at whichever comes first."
   - **No limit** -- "Let it run until it is proven." With the box "I understand this project can spend without
     limit." The **Start building** button stays off until the box is ticked.
   Under it, one line: "A fifth of the budget is kept for checking the work."
4. **Merge automatically when everything is proven** (a switch, on).
5. **More options** (collapsed): base branch (a select of the branches found), the checks that prove the work
   ("found in the repository" / "proposed for this stack" / "typed by you"), setup commands, and the runtime
   (Claude Code; choosing another runtime says "This project will use the older way of building").

A button **Start building**. While it creates, the button reads "Starting…" and a step list under it says each
step in words ("Create the repository", "Create the project", "Write the goal", "Finish"), each with a check or a
cross. On success the screen goes to the new Project screen.

States and words:

- empty: the assistant's first line is already there: "What do you want built? Say it the way you would to a
  person -- what it does, who uses it, and where the code is if it exists." The Project card reads "The details
  appear here once there is enough to go on."
- thinking: a typing row "Thinking…"; the composer is off.
- drafted: the card is filled and editable; the composer is gone; "Not right? **Keep talking**" brings it back.
- creating: as above.
- failed: the step that failed is red with its reason in words, and **Try again** continues from that step; if
  the project was already made, a link "Open the project it made".
- the conversation used all its turns without a draft: "This conversation has used all its turns without a
  draft. Start a new one." (Amended in the build: a hand-filled card cannot name an existing repository the
  conversation never saw, so a fresh conversation is the way on.)

### 6.3 Project -- `/w/:id`

**Question it answers:** What is happening to this project, and does it need me?

Layout, top to bottom, one column of sections with a right column of facts at 1200 px:

**Header.** The project name (h1), the state badge, the sentence of section 5 under it. On the right:
**Stop** (while something runs; red outline) or **Continue** (while paused or stopped by a problem; primary),
a **Settings** button (opens the Settings sheet), and a `⋯` menu with **Open the full report**, **Archive**,
**Delete…**.

**The decision card** (only when the state is `needs_decision` or `ready_to_merge`; amber, full width, first
thing under the header, `role="alert"`):

- `needs_decision`: title "Build 2 needs your decision". The stop reason (section 5). A short list of what is
  not proven ("Requirement 3: Doesn't work -- the login page returns 500", "Requirement 5: Checkers disagree").
  What was spent and how long it took. Three buttons with one line each under them:
  - **Accept as it is** -- "Merge what was built, unproven parts included."
  - **Check again** -- "Run the checker once more on the same code." (the CLI's `retry-goal`)
  - **Leave it unmerged** -- "Keep the branch, merge nothing. You can ask for a change later."
  Accept and Leave ask once more in a small confirm (shadcn `AlertDialog`), because they are final.
- `ready_to_merge`: title "Build 2 is ready to merge". If git refused the merge: "Slave could not merge it:
  `<git's reason>`." Otherwise: "Automatic merge is off for this project." The branch to merge, in mono with a
  copy button, and the base branch. Two buttons: **I merged it** -- "Slave checks that the branch is in `main`
  and records it." and **Merge automatically from now on** -- "Turns on automatic merge for this project; Slave
  merges on its next pass."

**What you asked for.** The goal text of the newest build (three lines, "Show all" expands). Under it the
composer **Ask for a change** ("Describe what should change…", **Send**): it opens the next build. While a build
runs it says "The current build keeps going; your change becomes the next build."

**Who is working** (only while `starting`, `building` or `checking`). A strip of faces: the lead first, then
each helper the lead has called, then the checker. A face is a round avatar with initials and a colour from the
name, a green pulse while it works, its name, and one line of what it is doing now in words ("Running
`npm test`", "Editing `src/app.ts`", "Reading the code", "Waiting for its helpers"). Under the strip, **Recent
commits**: up to five, subject and short hash. Empty: "The lead has not started yet."

**Proof.** A table, one row per requirement: the small key (`R3`), the requirement in words, the result (Works /
Doesn't work / Couldn't check / Checkers disagree / Not checked yet, each a coloured badge), and the checker's
reason, with "Show how it was checked" expanding the check that was run and its output (mono, scrollable). Above
the table, one summary line: "7 of 9 work · 1 doesn't work · 1 couldn't check · checked 2 times". Before any
check: "Nothing has been checked yet. When the lead finishes, an independent checker starts the product and tries
every requirement." While the requirements are being read from the request: "Reading the requirements from your
request…".

**Result** (only when `delivered`, `ready_to_merge`, `closed`): "Merged into `main` at `<commit>` on
`<date>`", or "Waiting for your merge", or "Left unmerged. The branch `<branch>` is kept." and the link **Open the
full report**.

**Right column -- Limits.** "Spent" with a bar: "$4.20 of $20" ("at least $4.20" when part of it was not
measured; "$4.20, no budget" without one; red past 100%). "Working time" with a bar: "38 min of 90 min"
("38 min, no time limit"). Under both: "Change limits" opens the Settings sheet. Below, **Builds**: one line
per build, newest first -- "Build 3 · Building", "Build 2 · Left unmerged" -- each linking to its report. Below,
**Notes**: the lead's notes in words, newest first, at most ten ("Waited for the provider's limit to reset",
"The lead's decisions were recorded", "Told the lead to wrap up").

States of the whole screen, each with its words (section 5 for the badge and sentence):

- empty: the decision card, Who is working, Proof and Result are absent; What you asked for reads "Nothing has
  been asked for yet." and its composer is **Start a build** ("Describe what you want built…").
- working (`starting`, `building`): Who is working and Proof (its empty text) are shown; Stop is shown.
- proving (`checking`): Who is working shows the checker as the working face; Proof fills in as checks land.
- waiting for the person: the decision card (above).
- delivered: Result, Proof complete, no Who is working.
- stopped (`paused`): Continue instead of Stop; the faces greyed with "Paused".
- failed (`failed`): a red alert under the header with the reason in words and Continue.
- not found: "There is no project here. It may have been deleted." and a link back to Projects.

**Settings sheet** (shadcn `Sheet` from the right, 480 px), sections in this order; every field saves on its
own with a toast ("Saved" / the refusal's words):

1. **Limits** -- Budget (`$`, or "No budget"), Time limit (minutes, or "No time limit"). The same warning as
   New project when both are off.
2. **The lead** -- Model: "Default (Claude Code chooses)" or a model the runtime lists.
3. **Helpers the lead may call** -- up to 15 specialists from the catalogue, chosen with a searchable picker
   (shadcn `Command` in a `Popover`), shown as removable chips. "With none, the lead uses general helpers."
4. **Delivery** -- the switch "Merge automatically when everything is proven".
5. **How it is built** -- "One lead builds everything" / "Older way: many separate tasks". Switching is refused
   while a build is open, and the refusal says why in words.
6. **Danger zone** -- **Archive** ("Hides it from the list; nothing is deleted.") and **Delete…**.

**Delete…** opens an `AlertDialog`: "Delete `<name>`?" / "This removes the project, every build, check, note and
cost record of it from Slave. The code in `<repository path>` is not touched." / a field "Type the project's
name to confirm" / **Delete project** (red, off until the name matches). Refused while something runs: "Stop the
project and wait for its work to end first."

### 6.4 Report -- `/w/:id/goals/:n`

**Question it answers:** What exactly was asked, checked, decided and spent for this build?

One printable column, outcome first: the title "Build n of `<project>`", the state badge and the stop reason;
**Download as Markdown**; then the sections Requirements (as the Project screen's Proof, with every check's
history), Smoke check (each attempt: outcome, exit code, output), Decisions (the person's and the lead's, each
with its reason) and Spend (this build and the project, against the budget). The step-by-step trail and the
report's caveats are written in Slave's internal vocabulary, so they stay in the Markdown download, and the page
says so. Empty sections are left out; a build with no report reads "This build has no report yet: its
requirements have not been read."

### 6.5 Helpers -- `/helpers`

**Question it answers:** Who can the lead call on?

The catalogue of specialists, read-only: a search box, chips by speciality, and cards (name, role, one line on
when to use them, their skills as chips). A card says on which projects' helper lists it is. Empty: "No
specialists in the catalogue yet. Import a catalogue from the command line (`import-catalog`)." Choosing helpers
for a project is done in that project's Settings sheet, not here.

### 6.6 Settings -- `/settings`

**Question it answers:** How is this installation set up?

Three cards: **Runtimes** (each runtime: found or not, its version, where it is), **Where new repositories go**
(the folder, and how to change it), **Appearance** (Light / Dark / System). With accounts on, **Account** (who is
signed in, Sign out). In development only, **Reset demo data**.

### 6.7 Sign in -- `/login`

One centred card: name, password, **Sign in**; the refusal in words under it.

## 7. Where each CLI-only control lives

| Control | CLI today | Where it is | Route |
|---|---|---|---|
| flow | `set-flow --flow` | Settings sheet → How it is built | `POST /api/w/:id/flow` (new) |
| time limit | `set-lead --time-limit-min` | New project → How much may it spend; Settings sheet → Limits | `PATCH /api/w/:id/lead` (new); intake draft `timeLimitMs` (new field) |
| budget | `create-workspace --budget` | New project; Settings sheet → Limits | `PUT /api/w/:id/budget` (kept) |
| the lead's model | `set-lead --model`, `set-flow --model` | Settings sheet → The lead | `PATCH /api/w/:id/lead` |
| roster | `set-lead --roster` | Settings sheet → Helpers the lead may call | `PATCH /api/w/:id/lead` |
| stop | `emergency-stop` | Project header → Stop | `POST /api/w/:id/emergency-stop` (kept) |
| continue | `clear-halt` + `resume` per run | Project header → Continue | `POST /api/w/:id/continue` (new) |
| retry a build | `retry-goal` | decision card → Check again | `POST /api/w/:id/goals/:n/retry` (new) |
| approve a delivery | `approve-decision` on the card | decision card → Accept as it is | `POST /api/w/:id/goals/:n/accept` (new) |
| reject a delivery | `reject-decision` on the card | decision card → Leave it unmerged | `POST /api/w/:id/goals/:n/leave` (new) |
| confirm a hand merge | `confirm-goal-merge` | decision card → I merged it | `POST /api/w/:id/goals/:n/merged` (new) |
| automatic merge | `set-auto-merge` | New project; Settings sheet → Delivery; decision card | `PUT /api/w/:id/integration` (kept) |
| lead status | `lead-status` | the Project screen itself | `GET /api/w/:id/project` (new) |
| delete a project | none (SQL by hand) | ⋯ → Delete…; Settings sheet; Home → Archived | `DELETE /api/w/:id` (new); CLI `delete-workspace --workspace <id> --yes` (new) |

The four goal verbs go through one control function, `decideBuild` (section 10), so that each one also closes
the Supervisor's open `goal_needs_human` card about that build, as an approval on the card would have.

## 8. A project still in the packages flow

It opens on the same Project screen with the state `older` and the badge "Older project". What it shows:

- the header without Stop/Continue (the header's ⋯ menu keeps Report, Archive, Delete);
- an info alert: "This project uses the older way of building: many separate tasks with their own reviews. You
  can read it here; to drive it, use the command line, or switch it to the lead in Settings once its open work
  is finished.";
- What you asked for (read-only, no composer);
- **Tasks**: one row per task of the newest build -- title, status in words (the domain's `USER_TASK_LABEL`) --
  with the count per status above;
- Limits (project spend against the budget) and Builds (with their report links, which keep working);
- the Settings sheet with only How it is built and Danger zone.

It does not show the board's columns, the team, departments, the Supervisor conversation or its decision cards:
those are the packages flow's machinery, which step 3 deletes. A decision pending on such a project is counted
in the sidebar and Home ("Waiting for you" says "Answer it from the command line: `supervisor-decisions`").

## 9. What was removed, and why

| Removed | Why |
|---|---|
| The icon rail, the header with breadcrumb, `⌘K` search, budget bar and `Pause all / Stop ▾` split button | Replaced by the sidebar and the Project header: one place per control. |
| Simple and developer modes (`ModeProvider`, `Mod+Shift+D`) | One product, one set of screens. |
| The right panel and the Supervisor conversation, its composer, uploads and autonomy switch | The lead flow raises no cards while it builds and the person is asked nothing (spec R-6, §3); a change is "Ask for a change". The Supervisor still runs in the daemon and still raises its one card, which the decision card answers. |
| Project tabs Team, Work (board), Office, Activity, Graph, Knowledge, Organization | Seats, hiring, the board and packages are the packages flow's (spec R-3, R-4). The Project screen's Who is working, Proof and Notes answer what a person asked of those tabs. Memories stay in the CLI (`memories`). |
| Project Settings tab (goal editor, runtime, permission matrix, runbook, staffing, limits matrix) | The Settings sheet holds the six settings the lead flow reads; the rest belong to the packages flow or to the CLI (`permission`, `runbooks`, `set-limits`). |
| Workforce (People, Catalog, Skills, Runbooks, Evidence, departments, hiring, profiles, templates, skill editing) | The lead flow has no hiring and no seats (R-4). What a person needs is to see the specialists and choose a project's helpers: Helpers + the picker. Catalogue editing stays in the CLI (`person`, `template`, `skills`, `import-catalog`). |
| Simulations (`/sim`, compare, adopt) and Analytics | Not part of building a goal; the CLI keeps the simulation verbs. |
| Office (pixel floor), the needs-you bar, the command strip, Happening now feed, KPI strip | Replaced by Who is working, the decision card and Home's Waiting for you. |
| `/w/:id/{tasks,activity,graph,office,knowledge,organization,settings}`, `/workforce`, `/slaves`, `/skills`, `/analytics`, `/sim*` | Redirected (307) to `/w/:id`, `/helpers` or `/`, so a bookmark still lands somewhere. |
| The hand-made primitives in `components/ui/` and their tokens (`tokens/simple.css`, `tokens/developer.css`) | Replaced by shadcn/ui (U-8). |

Every API route that only a removed screen called goes with it (section 11). The control verbs behind them stay,
and the CLI reaches every one; a route nothing in the interface calls is surface nobody exercises.

## 10. What the control layer gains

All new logic lives in `packages/control`, with route files as thin envelopes:

- `deleteWorkspace(workspaceId, principal?)` (`packages/control/src/deleteWorkspace.ts`): refused while a run is
  live (`live_runs`), else in one transaction under the workspace row's lock it deletes the `ExecutionEvent`,
  `InboundEvent`, `SlaveMessage` and `Intake` rows of the project (no cascading foreign key reaches them), the
  `Workspace` row (every other table cascades), and the three system persons of the lead flow (persons with no
  catalogue template whose every seat was in this project's `Lead flow` team). It returns the footprint it
  removed. It never touches the repository on disk. CLI: `delete-workspace --workspace <id> --yes` (without
  `--yes` it prints what would go and exits non-zero).
- `continueWorkspace(workspaceId, requestedBy, principal?)` (`continue.ts`): `clearHalt`, then a resume request
  for every paused run (the loop that lived in `apps/web/src/server/runFanout.ts`, moved here).
- `decideBuild(workspaceId, version, decision, principal?)` (`lead/decide.ts`): `accept` → `acceptLeadGoalAsIs`
  then the build's `goal_needs_human` card closed; `leave` → `leaveLeadGoal`; `retry` → `retryGoal`; `merged` →
  `confirmGoalMerge`. A lead verb that answers `none` (not a stopped lead build) is refused with
  `build_not_waiting`.
- `projectView(workspaceId)` (`projectView.ts`): the one read model of the Project screen -- the workspace's
  settings, the phase, the newest build with its requirements and verdicts, `leadStatus`'s turns, helpers, notes
  and commits, what each working face is doing now, spend and time against the limits, the builds, and for an
  older project its tasks.
- `listProjects()` (`projectList.ts`): the one read model of the sidebar and Home.
- `projectPhaseOf(facts)` and the label tables (`packages/domain/src/lead/phase.ts`): section 5 as data, a total
  `Record` per table so a new state fails the build.
- `createWorkspace` takes `goalTimeLimitMs`, and the intake draft takes `timeLimitMs` (nullable, default null),
  so a project born from the conversation has its time limit before its first build starts.

## 11. Routes each screen reads

| Screen | Reads | Writes |
|---|---|---|
| frame (sidebar) | `GET /api/projects` (new; replaces `/api/sidebar`) | -- |
| Home | `GET /api/projects` | `POST /api/w/:id/restore` (kept), `DELETE /api/w/:id` (new) |
| New project | `POST /api/intakes`, `GET /api/intakes/:id`, `POST /api/intakes/:id/messages`, `POST /api/intakes/:id/accept`, `GET /api/installation` (all kept) | -- |
| Project | `GET /api/w/:id/project` (new), `GET /api/providers/claude_code/models` (kept), `GET /api/helpers` (new, the catalogue for the picker) | `POST /api/w/:id/goal/request` (kept), `POST /api/w/:id/emergency-stop` (kept), `POST /api/w/:id/continue` (new), `POST /api/w/:id/goals/:n/{accept,leave,retry,merged}` (new), `PUT /api/w/:id/budget` (kept), `PATCH /api/w/:id/lead` (new), `POST /api/w/:id/flow` (new), `PUT /api/w/:id/integration` (kept), `POST /api/w/:id/archive` (kept), `DELETE /api/w/:id` (new) |
| Report | `loadGoalReport` on the server; `GET /api/w/:id/goals/:n/report?format=markdown` (kept) | -- |
| Helpers | `GET /api/helpers` (new) | -- |
| Settings | the server reads of today's Settings page | `POST /api/auth/logout`, `POST /api/dev/reseed` (kept) |
| Sign in | -- | `POST /api/auth/login` (kept) |

Kept untouched because something outside the web reads them: `/api/hooks/:source/:hookId` (external triggers),
`/api/auth/*`. Removed with their screens, read and write alike: `/api/{org,persons,slaves,teams,skills,sim,home,
sidebar}/*`, and under `/api/w/:id`: activity, events, graph, organization, overview, shell, skill-graph, team,
teams, tasks, needs-you, memories, runbook, staffing, slaves, supervisor, messages, runs, company, limits,
provider, goal/history and clear-halt (Continue replaces it).

## 12. Not in this design

The spec stage's questions and estimate (lead-flow spec S1, S5) and the hunt (P6) are Plan B and not built; the
New project screen shows the intake conversation that exists today and no estimate. Push or e-mail
notifications. A per-helper transcript view. Editing the catalogue from the interface. A model of the lead's that
can be set back to "Default" once named (`setLeadSettings` has no clear; the sheet says so).
