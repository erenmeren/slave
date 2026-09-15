# M59 — Intake: a project begins as a conversation, and the daemon follows the projects

**Date:** 2026-09-15 · **Status:** design approved in conversation, spec for review · **Branch:** `feature/m59-chat-onboarding` (worktree `../slave-of-ai-m59`, own test database `slaveofai_test_m59`) · **Merges after:** M58 (`feature/m58-persons`); the one task that depends on M58 is last and starts only once M58 is on `main`.

## 1. Why

Creating a project today is a form with seven fields (`apps/web/src/components/ProjectsPanel.tsx:34-43`: name, absolute repo path, base branch, verify commands one per line, setup commands, budget, provider), and the form refuses until the operator has typed at least one verify command by hand (`packages/control/src/workspace.ts:156`, `verify_commands_empty`). Nothing in the tree reads a `package.json`, a `Makefile` or a `pyproject.toml` to suggest one. A person who does not know what a verify command is cannot get past that field, and a person with only an idea and no repository cannot get past the first one — a workspace is "a local git clone you already have" (README "Attach your repository").

This was foreseen. M24's spec names "chat-driven project intake" as one of the two milestones that follow it and reserves the place: `apps/web/src/components/projects/NewProjectDrawer.tsx:7-8` still says *"M26 replaces the body with the intake chat — the trigger, the `?new=1` opener and this frame are the seam it lands in."* M26 became the rename milestone and the seam stayed empty. M59 fills it.

A second gap surfaced while designing the first. The daemon serves **one** workspace: `resolveWorkspace` (`apps/orchestrator/src/cli.ts:1012-1033`) auto-picks only when exactly one active project exists and otherwise demands `--workspace`; `runDaemon` (`apps/orchestrator/src/daemon.ts:122`) carries a single `deps.workspaceId` through `reconcileOrphans`, `collectWorktrees`, `tick`, `sweep`, `serveBrokerRequests` and the LISTEN filter at `daemon.ts:279`. So a project created through a conversation is a project no daemon is watching, and "everything happens by itself" ends at the first tick that never comes. Worse, yesterday's Docker image runs `daemon` with no arguments (`docker/entrypoint.sh:52-54`): the moment a second project exists, a restarted orchestrator container exits on `--workspace is required`. The operator chose to close this here rather than ship an intake that produces orphans.

The operator's asks, verbatim in intent:

1. Attach — or create — a project by talking, sharing the idea in the same place, so that everything is created automatically. "İşleri kolaylaştırmaya çalışıyorum bilmeyen kişiler için."
2. Everything, including a suggested team from the persona catalogue.
3. A new repository goes under a folder from Settings by default, and the person may still name a different path in the conversation.
4. The daemon follows the projects, so the one the conversation created is planned without anyone typing a daemon command.

## 2. Decisions taken with the operator (2026-09-15)

| # | Question | Decision |
|---|---|---|
| D1 | Scope | **All of it**: conversation, verify detection, `git init` for idea-only projects, goal v1 from the transcript, planning starts by itself, team suggested from the catalogue. |
| D2 | Where does a new repository go? | **Both**: a *Repositories folder* in global Settings (default: `SLAVEOFAI_REPOS`, else `~/projects`) gives `<root>/<slug>`; a path named in the conversation wins. |
| D3 | Who calls the model? | **The daemon**, through the same restricted decider the Supervisor and the simulations use (`decideWithModel`, `packages/providers/src/claude/decision.ts:122`). The web process never spawns anything (`docs/architecture.md`). |
| D4 | Reuse Supervisor proposals? | **No.** `SupervisorDecision.workspaceId` is required (`packages/db/prisma/schema.prisma:1509`), `situationKind` is a closed enum, `actionSchema` a closed union (`packages/domain/src/supervisor/actions.ts:137`), and `supervisorWorld` loads one workspace. An intake exists *before* a workspace; it is its own entity. |
| D5 | Daemon serves many projects? | **Yes, in M59.** `daemon` with no `--workspace` serves every active project and picks up new ones within a discovery period. The Docker entrypoint then needs no change. |
| D6 | Facts vs. the model | The model never invents a path, a branch or a verify command. **Code detects, the model chooses among what was detected or asks.** |

Vocabulary (ia.md rule 3): the UI says **New project** and, inside it, **conversation**; the record is an **intake** (`Intake` in code and CLI, the word M24 used). `gate:m26-vocabulary` forbids only "agent"; "intake", "conversation" and "onboarding" are already in the tree (`gate:m23-onboarding`, `SupervisorThreadPanel`'s "New conversation").

## 3. Data model (R1–R4)

**R1 — `Intake`.** New table. `id`, `status` (`IntakeStatus` enum: `open` — waiting for the person · `awaiting_reply` — a human message is unanswered · `replying` — a daemon holds the claim · `drafted` — a draft stands and may be accepted · `creating` — accept is running · `created` · `failed` · `abandoned`), `draft Json?` (the last `IntakeDraft`, R8), `modelCalls Int @default(0)`, `modelCostUsd Float @default(0)`, `unmeasuredCalls Int @default(0)` (a call whose cost never came back, charged at the cap in the spend figure exactly as `packages/control/src/spend.ts:19-20` charges the Supervisor's), `claimedAt DateTime?` + `claimedBy String?` (daemon claim, R11), `workspaceId String? @unique` → `Workspace` (set by accept), `stepLog Json` (R10), `failureReason String?`, `userId String?` → `User` (`onDelete: SetNull`, as `ExecutionEvent.userId`), `createdAt`, `updatedAt`. Index on `(status, updatedAt)`.

**R2 — `IntakeMessage`.** `id`, `intakeId` (cascade), `seq Int` (`@@unique([intakeId, seq])`), `role` (`IntakeRole` enum: `human` · `assistant` · `fact`), `text String` (what is shown), `facts Json?` (R6's structured findings, only on `fact` rows), `createdAt`. A conversation is these rows in `seq` order — no JSON transcript column, so a 40-message intake never rewrites a growing blob.

**R3 — `InstallationSettings`.** New single-row table (`id String @id @default("installation")`), `reposRoot String?`, `updatedAt`. First installation-level setting in the product; until now the only installation-level fact was `SLAVEOFAI_SUPERVISOR_MODEL`, an env var (`apps/orchestrator/src/cli.ts:1451`). Resolution order for the root, one function `resolveReposRoot()` in `packages/control/src/installation.ts`: the row's `reposRoot` → `SLAVEOFAI_REPOS` → `join(homedir(), 'projects')`. Read by R7 and shown on `/settings` (R17). No other setting moves in; this table exists for this field.

**R4 — No new `ExecutionEvent` type before the workspace exists.** `ExecutionEvent.workspaceId` is required (`schema.prisma:1872`) and the event log is per project by design (ADR 0003). An intake is recorded in its own two tables. The link back is one payload field: `workspace.created`'s payload (written at `workspace.ts:181-190`) gains optional `intakeId`, and `workspace.goal_set` written by accept (R10) carries `request: <transcript summary>` exactly as `requestChange` does (`packages/control/src/goal.ts:194-213`), so the project's Supervisor conversation (M57 R9 groups `workspace.goal_set` into threads) opens with what the person said. The `executionEventSchema` member for `workspace.created` gains `intakeId: z.string().optional()`; no `EventType` enum change, no lane change (`LANE_BY_TYPE` already maps `workspace.created` to `null`).

## 4. Control (R5–R12)

All in `packages/control/src/intake.ts` and `packages/control/src/detect.ts`, `ok()`/`err()` results, refusal kinds worded in `packages/control/src/refusal.ts`, `Principal` optional and recorded on the row.

**R5 — `openIntake(principal?)`** creates a row in `open` with no messages and returns `{ id }`. Nothing is spent. **`abandonIntake(id)`** moves `open`/`awaiting_reply`/`drafted`/`failed` → `abandoned`; refuses `creating` and `created` (`intake_not_abandonable`). An abandoned intake keeps its rows; the Projects page never lists intakes, so there is nothing to tidy.

**R6 — `sendIntakeMessage(id, text, principal?)`.** Refuses blank (`invalid_message`), a status other than `open`/`drafted` (`intake_not_open`), and a call budget already spent (`intake_budget_exhausted`, R12). Appends the `human` row, then **runs detection synchronously and appends a `fact` row when it finds anything**, then sets `awaiting_reply`. Detection is deterministic and lives in `detect.ts`:

- `findPaths(text)` — every absolute path and every `~/…` in the message, plus the draft's `repoPath` if one stands.
- For each path: `probe.isRepository` and `listBranches` (a new `GitProbe` method beside the two at `packages/control/src/git-probe.ts`: `git for-each-ref --format=%(refname:short) refs/heads`), `defaultBranch` (`git symbolic-ref --short HEAD`, falling back to `main` ∈ branches, else the first), and whether the directory is empty.
- `detectVerify(path)` — `package.json` scripts named `test`, `typecheck`, `lint`, `build` → `npm run <name>` (or `pnpm`/`yarn`/`bun` when the matching lockfile exists); a `Makefile` with a `test`/`check` target → `make <target>`; `pyproject.toml` or `pytest.ini` → `pytest`; `Cargo.toml` → `cargo test`; `go.mod` → `go test ./...`. Each finding is `{ command, source }` where `source` names the file and key it came from. Nothing is executed. Order is the order above, so `npm test` precedes `npm run build`.
- The `fact` row's `text` is the human-readable summary the conversation shows ("`/home/x/api` is a git repository on `main` (also `develop`); found `npm test`, `npm run typecheck` in package.json") and its `facts` is the structured `IntakeFacts` (Zod in `packages/domain/src/intake/facts.ts`): `paths: [{ path, exists, isRepository, isEmptyDir, branches, defaultBranch, verify: [{command, source}] }]`, `reposRoot`, `existingCompanies: [{id, name}]`, `catalogue: [{templateId, name, division, runtimeRoles}]` (the catalogue summary is capped at 300 entries and never carries a profile body — 279 × 48k characters is not a prompt).

**R7 — `initRepository({ path, name, goal })`** — a new verb, also a CLI verb `init-repository --path --name`. Refuses a relative path (`repo_path_not_absolute`), a parent that does not exist (`parent_not_found`), a path that exists and is not an empty directory (`path_not_empty`), and a path already inside another git repository (`inside_repository`; `git rev-parse --is-inside-work-tree` on the parent). Otherwise: `mkdir -p`, `git init -b main`, writes `README.md` with `# <name>` and the goal text under a `## Goal` heading, `git add README.md`, `git commit -m "chore: begin <name>"` with `user.name`/`user.email` taken from the environment or, when git has none, the fixed identity `Slave of AI <noreply@slaveofai.local>` for this one commit (`-c user.name=… -c user.email=…`, never written to config). Returns `{ path, baseBranch: 'main' }`. Runs in the web process the way `GitProbe` already does — a probe of the operator's own filesystem under the operator's principal, the same trust `createWorkspace` extends when it `stat`s any path the operator names (`workspace.ts:148`).

**R8 — `IntakeDraft`** (Zod, `packages/domain/src/intake/draft.ts`) is what the model produces and what the person edits:

```
{ name: string (1–80),
  goal: string (1–8000),
  repo: { mode: 'existing', path } | { mode: 'new', path },
  baseBranch: string,
  verifyCommands: { command: string, source: 'detected' | 'draft' | 'operator' }[] (≥1),
  setupCommands: string[],
  budgetUsd: number | null,
  provider: ProviderKind | null,
  team: { templateId: string, runtimeRoles: string[] }[] }
```

`acceptIntake` (R10) re-validates the edited draft against this schema **and** against the facts: `repo.path` for `existing` must be a path a `fact` row reported as a repository; every verify command must carry a source it is entitled to: `detected` only if a `fact` row's `verify` list has that exact command; `draft` only when `repo.mode === 'new'` (there is nothing to detect in a repository that does not exist yet, so the model proposes for the stack it was told about and the card marks it as a proposal); `operator` only when the person typed it in the card — the model's answer may never carry `operator` (R9). `repo.mode: 'new'` with no explicit path resolves to `<reposRoot>/<slug(name)>` at accept time, and the resolved path is what the card shows before the button is pressed.

**R9 — The model's answer** is one JSON object, parsed with the same first-object rule as `parseDecisionAnswer` (`packages/domain/src/supervisor/prompt.ts:125`), against `intakeAnswerSchema` = `{ kind: 'ask', text }` | `{ kind: 'draft', text, draft: IntakeDraft }` where every `draft.verifyCommands[i]` with `source: 'detected'` must be in the latest `fact` row's detected commands, `source: 'draft'` is accepted only with `repo.mode === 'new'`, and `source: 'operator'` is never accepted from the model (all checked after parse in `packages/domain/src/intake/answer.ts`; a violation is recorded on the intake and the answer is downgraded to `ask` with the model's `text`, so a hallucinated command never reaches the card). `text` is what the conversation shows; the model is told to write it in the language the person wrote in. A `draft` answer sets `status: drafted` and stores the draft; an `ask` answer sets `open`.

**R10 — `acceptIntake(id, draft, principal?)`** runs the steps in order and records each in `stepLog` as `{ step, status: 'done'|'failed', at, detail }` before moving to the next, so a half-created project is visible as exactly that:

1. `init_repository` — only for `repo.mode: 'new'` (R7).
2. `create_workspace` — `createWorkspace({ name, repoPath, baseBranch, verifyCommands, setupCommands, budgetUsd, provider }, principal, { intakeId })` (`packages/control/src/workspace.ts:141`, gaining the optional third argument that lands in the event payload, R4). `createWorkspace`'s `verify_commands_empty` refusal stays: a new repository needs at least one command too, and the card carries what the model proposed for the stack it was told about (e.g. `npm test` when the person said "a Node service"), marked `source: 'draft'` and editable; R7's README says under `## Goal` which command the project verifies with. A `npm test` that runs nothing yet is an honest starting line; a workspace whose definition of done is empty is not.
3. `staff` — R13 (the M58-bound step). Before M58 is on `main` this step is **not implemented** and `stepLog` records `{ step: 'staff', status: 'skipped', detail: 'M58 not merged' }`; the plan orders it last.
4. `set_goal` — `setGoal(workspaceId, draft.goal, principal, { request: transcriptSummary })` (`goal.ts:40-51`); `transcriptSummary` is the human rows joined, capped at 4000 characters.
5. `mark_created` — `status: created`, `workspaceId`.

A failed step sets `status: failed`, `failureReason`, and stops; the card shows the log and, for a failure after `create_workspace`, links to the project that now exists. A second `acceptIntake` on a `failed` intake **resumes at the first step not `done`** — accept is idempotent per step because every step it re-runs is either a refusal it can read (`duplicate_name`, `path_not_empty`) or a verb that is safe to repeat. Refuses `creating` (`intake_busy`) and `created` (`intake_already_created`).

**R11 — The daemon's claim.** `claimIntakes({ by, limit })` in `packages/control/src/intake.ts` moves up to `limit` rows `awaiting_reply` → `replying` with `claimedAt`/`claimedBy` in one `UPDATE … WHERE status = 'awaiting_reply' … RETURNING`, so two daemons (D5 makes that normal) never answer the same message — the same "due under the row lock" property `tickSimulations` relies on (`daemon.ts:186`, M30 §5). A `replying` row older than `INTAKE_CLAIM_TTL_MS` (5 min) is reclaimable: the process that held it is gone. `recordIntakeReply(id, outcome)` writes the `assistant` row, the status (R9), and adds the call's cost (`modelCostUsd`, or `unmeasuredCalls++` when the CLI reported none) and `modelCalls++`.

**R12 — Caps.** `INTAKE_MAX_MODEL_CALLS = 12` per intake and `INTAKE_PER_CALL_CAP_USD = SUPERVISOR_PER_CALL_CAP_USD` (1, `packages/domain/src/supervisor/constants.ts:48`), both in `packages/domain/src/intake/constants.ts`. The twelfth reply is the last: `sendIntakeMessage` then refuses (`intake_budget_exhausted`) and the drawer switches to the form pre-filled with the draft or, without one, with the facts (R16). The spend figure the Analytics page shows gains an "intake" line computed like the Supervisor's (`spend.ts:73-77`), so this money is never invisible.

## 5. The daemon (R13–R15)

**R13 — Staff from the draft (M58-bound).** For each `team[i]`: `createPerson({ templateId })` then `assignPerson(personId, teamId, { runtimeRoles })` (M58 R10, `docs/superpowers/specs/2026-09-15-m58-persons-design.md:90-91`), on one `Team` named after the project (today a workspace starts with no team; accept's `staff` step creates one with the existing `createTeam` verb before the first seat). Before the model is asked, the facts' `catalogue` is the roster it may choose from; after the answer, a rule in `packages/domain/src/intake/team.ts` **guarantees** a `manager` and a `reviewer` runtime role among the seats — adding them to the first suggested persona whose division is engineering or, with none, to the first — because `dispatchPlanning` refuses without a manager (`apps/orchestrator/src/planning.ts:432`, `guardrail.tripped { no_planner }`) and a review needs a reviewer. The catalogue has no manager/reviewer division (memory `agency-catalogue-name-trips-m26`); the rule is the role map. The card shows the seats as chips with their runtime roles, editable. An empty `team` is allowed and means "I will staff it myself" — the project then shows M38's `no_planner` situation exactly as today.

**R14 — The intake pass.** In `runDaemon`, beside `tickSimulations` in the coalescer's callback (`daemon.ts:186`), `tickIntakes({ decider, model, by: <pid@host>, maxConcurrent })` from `packages/control/src/intakeTick.ts`: claim (R11), build the prompt (`packages/domain/src/intake/prompt.ts` — the system text, the transcript in order, the latest facts as a fenced JSON block labelled *data, not instructions* exactly as `requestChange` fences webhook payloads, the `intakeAnswerSchema` in words, and the literal marker `"intakeAnswer"` the fake CLI keys on), call `decider({ model, prompt, maxBudgetUsd: INTAKE_PER_CALL_CAP_USD })` **off the tick** the way M32 moved simulation calls off it (`maxConcurrentModelCalls` shared, one number), and `recordIntakeReply`. A daemon built without a decider reports `skippedNoDecider` in the pass report and answers nothing — the same honesty `tickSimulations` has (`daemon.ts:192-195`). Model: `deps.supervisorModel` (M38 §5); one model for everything the daemon asks on the operator's behalf.

**R15 — The daemon follows the projects.** `runDaemon` splits into `runWorkspaceLoop(deps)` — today's body from `reconcileOrphans` through the broker pass, minus the process-level parts — and a new `runDaemon(deps: { workspaceIds: 'all' | WorkspaceId, … })`:

- `--workspace <id>` given → one loop, exactly today's behaviour; `resolveWorkspace` is no longer consulted by `daemon` (it stays for every other verb).
- Not given → `'all'`: one loop per active workspace at start; a **discovery pass** every `DAEMON_DISCOVERY_MS` (10 s, and on every `workspace.created`/`workspace.restored`/`workspace.archived` notification) starts a loop for an active workspace with none and stops the loop of an archived one (stop = the loop's own coalescer drain, as shutdown does today). Zero active workspaces is **not** an error any more: the daemon starts, runs the global passes (skill catalogue sync, simulations, intakes) and waits — this is the state a fresh install is in before its first intake, and the state that made `docker/entrypoint.sh` fragile.
- One LISTEN subscription per process (`subscribeEvents`, `daemon.ts:275-281`), routing `notification.workspaceId` to that loop's coalescer; one `registry`, one decider, one signal handler that drains every loop in the order today's `finally` drains one.
- `syncSkillCatalog` once per process (unchanged), `tickSimulations` and `tickIntakes` once per process on the global coalescer — **not** once per loop, or N workspaces would step every simulation N times as fast.
- The daemon's startup line says what it serves: `serving 3 projects (Checkout Platform, api, docs-site); following new ones every 10s`.

`docker/entrypoint.sh` is unchanged and correct by construction. The README's "Quick start" drops the "one project" caveat and `status` gains `daemon: serving N projects` only if a cheap source exists — it does not (no liveness row anywhere; grep `heartbeat|lastTickAt` is empty), so **R15 adds none**; the daemon's stdout is its liveness, as today.

## 6. Web (R16–R19)

**R16 — The drawer.** `NewProjectDrawer`'s body becomes `IntakeConversation` (`apps/web/src/components/projects/IntakeConversation.tsx`): opening the drawer calls `POST /api/intakes` (→ `openIntake`) once and keeps the id in the drawer's state; the transcript lists `human`/`assistant` rows as bubbles and `fact` rows as a compact card of chips ("repository · main, develop", "npm test", "npm run typecheck" — each chip's `title` carries the `source`); the composer posts `POST /api/intakes/:id/messages` (→ `sendIntakeMessage`); while `awaiting_reply`/`replying` the drawer polls `GET /api/intakes/:id` every 1500 ms and shows "thinking…" (polling, not SSE: the event stream is per workspace, R4, and a second stream for a two-minute conversation is not worth a subscription). In `drafted`, a **draft card** renders the `IntakeDraft` as editable fields — name, repository (a segmented *existing path* / *new under `<root>/<slug>`* / *new at path* control), base branch (a select over the facts' branches), verify commands (checkboxes over detected ones + an "add" line that marks `source: 'operator'`), budget, provider, team chips — and one button **Create project** → `POST /api/intakes/:id/accept` → on `created`, `router.push('/w/<id>')` exactly as `ProjectsPanel` does. A **fill in by hand** link is always visible and swaps the body for today's `ProjectsPanel` pre-filled from the draft or facts (ia.md rule 2: nothing is removed; `ProjectsPanel` and `POST /api/org/workspaces` stay). `failed` shows the step log (R10) and a **Retry** button (accept again). The drawer's `?new=1` opener, Escape, scrim and focus trap are untouched (M44 R3).

**R17 — Settings.** `/settings` gains a **Repositories** section under Appearance (`apps/web/src/components/SettingsClient.tsx:44-70` is the pattern): one field, *Repositories folder*, with the resolved value and where it came from ("from Settings" / "from SLAVEOFAI_REPOS" / "default"), saved through `POST /api/installation` → `setInstallationSettings({ reposRoot })` (refuses a relative path). The intake's facts carry the resolved root so the model can say where a new repository will go.

**R18 — Routes.** `apps/web/src/app/api/intakes/route.ts` (POST open), `api/intakes/[intakeId]/route.ts` (GET: intake + messages + draft; DELETE: abandon), `api/intakes/[intakeId]/messages/route.ts` (POST), `api/intakes/[intakeId]/accept/route.ts` (POST, body = edited draft), `api/installation/route.ts` (GET/POST). All behind the same principal gate every mutation route uses; refusals map to HTTP the way `POST /api/org/workspaces` maps `createWorkspace`'s. **The web process runs detection and `initRepository`** (both filesystem + `git` probes under the operator's principal, the precedent being `GitProbe` and `createWorkspace`'s `stat`); it never calls the model and never imports `@slave-of-ai/providers` — `gate:m15-boundary` keeps proving that.

**R19 — CLI.** `intake open`, `intake say --intake <id> --text …`, `intake show --intake <id>`, `intake accept --intake <id> [--draft <file.json>]`, `intake abandon --intake <id>`, `init-repository --path --name [--goal]`, `settings repos-root [--set <path>]` — the same verbs the UI uses, so a gate can drive the whole flow without a browser and an operator over SSH is not second-class (ia.md rule 2).

## 7. Tests and the 33rd gate

**Unit (vitest, `packages/domain`)**: `intakeAnswerSchema` accepts both kinds and rejects a `draft` whose verify command is not in the facts (downgrade to `ask`); `IntakeDraft` bounds; the team rule adds `manager`/`reviewer` and leaves a complete team alone; the prompt carries the marker and fences the facts.

**Unit (`packages/control`, integration project, real Postgres)**: `openIntake`/`sendIntakeMessage`/`claimIntakes` status machine including the claim race (two concurrent claims, one wins); `detectVerify` against fixture directories under `packages/control/test/fixtures/detect/` (node-npm, node-pnpm, make, python, cargo, go, empty); `initRepository` refusals and the commit it makes (`git log` reads one commit, README has the goal); `acceptIntake` step order, `stepLog`, resume-after-failure (a `duplicate_name` on step 2, then a rename, then accept again reaches `created`); `resolveReposRoot` order; the `workspace.created` payload carries `intakeId`.

**Unit (`apps/orchestrator`)**: `runDaemon` with `'all'` starts one loop per active workspace, discovers a workspace created after start within the discovery period, stops the loop of an archived one, and drains all on SIGTERM; `tickIntakes` with a stub decider answers a claimed intake and reports `skippedNoDecider` without one; the global passes run once per process with three loops.

**Unit (`apps/web`)**: `IntakeConversation` renders rows, polls while awaiting, shows the draft card with detected commands checked, marks an added command `operator`, disables Create on an empty verify list for an existing repository, shows the step log on `failed`; the Settings section shows the source of the root.

**Gate — `gate:m59-intake`**, the 33rd in `.github/workflows/ci.yml`'s `gates` job and `package.json`, after `gate:m57-ui-redesign` (M58's gate, when it lands, goes before it; the plan's last task renumbers). Playwright against the daemon started with **no** `--workspace`, the fakes, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`. `scripts/gate-fakes/fake-claude.sh` gains one arm: a prompt containing `"intakeAnswer"` is answered from a counter file under the state dir — first call `{"kind":"ask","text":"Where is the repository?"}`, second `{"kind":"draft", …}` whose draft names the fixture repository and its two detected commands. Stages:

1. Seed; start the daemon with no `--workspace`; the log says `serving 1 project`.
2. Open `/`, click **New project**; the drawer shows an empty conversation (`intake-conversation`); type "Rate limiting for our public API" and send; within 5 s an assistant bubble asks for the repository.
3. Send the fixture repository's absolute path (a `git init`-ed directory with a `package.json` carrying `test` and `typecheck`); a fact card shows `main` and both commands; within 5 s the draft card appears with both commands checked and `team` chips including one carrying `manager`.
4. Uncheck `npm run typecheck`, rename the project to `Public API`, click **Create project**; the browser lands on `/w/<id>`; the Goal panel shows v1 with the words typed in stage 2 under USER REQUEST; Settings shows one verify command.
5. Within two discovery periods the daemon log says `serving 2 projects`; within 10 s more a planning run for the new project exists (`SlaveRun.kind = planning`, from the fake) — **only when M58 has landed and R13 is implemented**; before that, the gate asserts `stepLog.staff.status === 'skipped'` and `guardrail.tripped { no_planner }` on the new project, and the plan's last task flips this assertion.
6. Second intake, `repo.mode: 'new'`, with the Settings root pointed at a temp dir: the created path exists, has one commit, and the README carries the goal.
7. CLI parity: `intake open` → `say` → `show` prints the draft → `accept` creates the same shape without a browser.
8. `gate:m26-vocabulary`, `gate:m15-boundary` stay green.

**Ladder**: never below M57's 381 test files / 6604 tests; every task adds to both.

## 8. Out of scope, said so

- File uploads and images in the conversation (M24 named them with the intake; still later).
- Voice.
- Changing a project's goal from the intake after creation — that is the Supervisor composer (`requestChange`), and the intake row is closed at `created`.
- A daemon liveness row or a "no daemon is serving this project" badge — R15 removes the common cause; the indicator is a later question.
- Multi-user intakes (two people in one conversation); `userId` records who opened it, nothing more.
- Detecting verify commands for stacks beyond the seven in R6; `source: 'operator'` covers the rest.

Each line becomes a "Later" entry in `docs/ia.md`.

## 9. Constraints carried from earlier milestones

Never a real model call in a test or a gate (`SLAVEOFAI_REQUIRE_FAKE_CLI=1`; the fake answers the marker). One vitest run at a time — and this branch runs against **its own** database `slaveofai_test_m59` (worktree `.env`) so M58's runs and this branch's never TRUNCATE each other; `web:build` is never run while a `next dev` is up. Read a gate's own exit code (`cmd > log; rc=$?`), never `| tail`'s. No prettier. The vocabulary word is "slave"; "agent" is forbidden in tracked files, so the persona catalogue is "the Agency persona catalogue" in every comment and doc. Labels are never keys (ia.md rule 3): `IntakeStatus` and `IntakeRole` get their label tables beside the thing they name, and the raw member stays in `title`/`data-`. Real is not simulated. A refusal after a write inside a transaction throws. Every task ends with its focused tests, `gate:m26-vocabulary`, `tsc --build`, `npm run typecheck`, `npm run web:build`, and a commit with the session trailer.

## 10. Errata — where execution corrects this spec

*(appended during execution; each entry `**Ei (amends Rn)**`)*
