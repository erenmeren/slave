# M37 — Run context: one builder puts a slave in front of the model, and records what it saw

Third milestone of the Supervisor sequence (M35 pipeline honesty, M36 messaging and waiting). Design approved in chat 2026-09-08; this file is the record. "Slave" is this project's word for an AI worker.

**Goal.** Every run's prompt is assembled in one place from named sections — who the slave is (its profile), what it may do (its runtime roles and skills), what it is asked to do (task, rejection, review diff, planning goal), and what others said to it (M36 inbox and protocols) — and the assembled text plus its sources are recorded per run so a debugger or a Supervisor can read exactly what the model saw. Skills a slave is assigned actually reach its run.

**Why now.** Today `Slave.role` is one overloaded string (profile title, scheduler match, reviewer/manager staffing by literal name, message addressing); `SlaveTemplate.description` reaches no prompt; `SlaveSkill` is written by the web and read by nothing; the prompt is built in three unrelated places (`tick.ts` `buildPrompt`+`withPreamble`, `review.ts` `buildReviewPrompt`, `planning.ts` `buildPlanningPrompt`); the only durable record of a run's inputs is `SlaveRun.suppliedMessageIds`. The Supervisor (M38) must be able to say what a worker was told.

## 1. Principles (M35 and M36 Global Constraints stay binding; added here)
- **One builder.** No prompt text for a run is composed outside `buildRunContext`. `buildPrompt`, `withPreamble`, `buildReviewPrompt`, `buildPlanningPrompt` are removed, not wrapped.
- **Pure render.** Section ordering and text live in a pure domain function with no DB or filesystem access; the orchestrator only gathers inputs and performs side effects (skill copy, row insert).
- **Model output never writes a profile, a role set, or a skill assignment.** Those change only through control verbs (CLI/web).
- **Record before spawn.** The `RunContext` row exists before the child process starts; a run without a row never spawned.
- **Another party's text is data.** Profile, message bodies and skill descriptions rendered into a prompt have the M36 markers (`<slave-ask>`, `<slave-answer>` and their closers) neutralised so a quoted marker cannot park or answer on the quoter's behalf.
- One vitest at a time; `npm run --silent typecheck`; `web:build` last and never while `next dev` runs; vocabulary gate; commit trailers as in M36; never a real model call.

## 2. Data model (migration `m37_run_context`, plus `m37_runtime_roles`)
- `SlaveTemplate.profile String?`, `CompanySlave.profile String?`, `Slave.profile String?` — Markdown, the persona: who the slave is, its expertise, its working rules. **Effective profile** = `slave.profile ?? companySlave.profile ?? template.profile ?? null`, the same override chain `model`/`provider` already follow. `description` stays the short catalog blurb. Length cap `PROFILE_MAX_CHARS = 16_000`, enforced at write (refusal `profile_too_long`) and re-checked at build.
- `Slave.runtimeRoles String[]` — the roles this slave may be dispatched as. Backfill in the migration: `ARRAY[role]` plus `requiredRole` when set and different. `Slave.role` becomes the profile's title (display and persona only). `Slave.requiredRole` is dropped in the same migration once its last reader (M33 adoption, #27980's dispatch gap) is moved to `runtimeRoles`. An empty set means "cannot be dispatched"; the web shows a warning.
- `RunContext { id, runId @unique, prompt String (Text), sections Json, createdAt }`. `sections` is the manifest: an ordered array of `{ kind, source }` where `kind ∈ profile | roster | skills | inbox | ask_protocol | answer_protocol | task | rejection | review_diff | planning_goal` and `source` names what produced it (profile origin `slave|company|template` + sha256 of the text; task id; rejection present; message ids; skill names copied and `missing` names; review `base..head` and whether the diff was capped; planning goal hash). `SlaveRun.suppliedMessageIds` moves into the `inbox` section's source and the column is dropped; its readers (M36 `deliver`/web) read the manifest.

## 3. Domain (`packages/domain/src/run-context/`)
- Section types (zod-free plain types; the manifest's shape is validated at read by a zod schema `runContextManifestSchema` so a hand-edited row cannot crash the web).
- `renderRunContext(kind: RunKind, sections: readonly Section[]): { prompt: string; manifest: Manifest }` — fixed order per kind: implementation = profile, roster, skills, inbox, ask_protocol, task, rejection; review = profile, skills, task, review_diff, verdict instructions (moved verbatim from `review.ts`); planning = profile, planning_goal, graph instructions (moved verbatim from `planning.ts`). Empty sections are omitted and absent from the manifest. `neutraliseMarkers(text)` is applied to profile, message bodies and skill descriptions; the protocol sections are the only place the markers appear unescaped.
- `displayName(slave)` and `rosterLine(slave)` — the one formatting of `name (title; roles)` used by inbox, ask roster, delivery, CLI.

## 4. Orchestrator (`apps/orchestrator/src/runContext.ts`)
- `buildRunContext(input: { runId, kind, slaveId, workspaceId, taskId | null, worktreePath | null, provider })`:
  1. loads the slave with template/company chain, the task (+ `lastRejectionReason`), the workspace goal, the assigned skills (`SlaveSkill` → `Skill` → `SkillProvider`);
  2. implementation only: `pendingInbox` and the ask roster (moved from `inbox.ts`, now built on `runtimeRoles` and `rosterLine`); review: the diff exactly as `review.ts` computes it today (`DIFF_CHAR_LIMIT` kept); planning: the goal;
  3. **skills**: for each assigned skill resolves its source directory from `SkillProvider.name` (`personal` → `~/.claude/skills/<name>`, `project` → `<repo>/.claude/skills/<name>`, `plugin:<p>` → the highest-version plugin cache dir, reusing `skills.ts`'s root resolution — extracted into a shared `skillSourceDir(provider, name)` rather than duplicated), removes `<worktree>/.claude/skills/` and rewrites it (rework reuses the worktree; a changed assignment must not leave stale skills), copies each dir, writes `<worktree>/.claude/skills/.gitignore` = `*` so the tree stays clean (`Checkpoint.dirtyFiles`, merge). A skill whose source is missing (`Skill.missingSince` set or dir absent) is not copied, is listed under `skills.source.missing`, and is left out of the prompt; the run proceeds. Cursor runs: no copy, manifest `skills.source.provider_unsupported = true`;
  4. renders, upserts `RunContext` (idempotent on `runId`; a redispatch after `failToStart` writes the row again, never a second one), returns `{ prompt, manifest }`.
- `tick.startRun`, `review.dispatchReview`, `planning.dispatchPlanning` call it immediately before `adapter.start` and pass `prompt`. Order: worktree ready → skills copied → row written → spawn. A spawn failure leaves the row (a diagnostic record) and follows `failToStart` unchanged.
- Resume (M36 answer) does not build a new context; the queued message is the resumed prompt and is already a `SlaveMessage` row.
- `inbox.ts` keeps `pendingInbox`/`askProtocol`/`answerProtocol` as section producers; `withPreamble` goes.

## 5. Runtime roles everywhere
- `packages/domain/src/scheduler/decide.ts`: a slave is a candidate when `task.requiredRole ∈ slave.runtimeRoles`.
- `review.ts` reviewer staffing: `'reviewer' ∈ runtimeRoles`; `planning.ts` manager staffing: `'manager' ∈ runtimeRoles`. The literal `role: 'reviewer'` / `'manager'` queries are removed.
- `packages/control/src/messaging.ts` role addressing (`recipientRole`), `ask.ts`'s `recipientCanAnswer`, `answer.ts`, `inbox.ts` roster: all on `runtimeRoles`.
- M33 adoption (`packages/control/src/simulation/adopt.ts`): `RUNTIME_ROLE` translation writes `runtimeRoles` (`[translated, catalogRole]` deduplicated) and `role` keeps the catalog title; `roleOverrides` and the preview are unchanged in shape.
- Web: `runtimeRoles` chips wherever `role` is shown as a badge (`SlavePanel`, `SlaveCard`, org page); `role` stays as the title.

## 6. Control verbs, CLI, web
- Control: `setProfile({ slaveId | templateId | companySlaveId, profile | null })` (refusals `slave_not_found`/`template_not_found`, `profile_too_long`), `setRuntimeRoles(slaveId, roles: string[])` (`invalid_role` on blank/duplicate entries), both emitting an event (`slave.profile_changed`, `slave.runtime_roles_changed` — new `EventType`s, payload carries actor and the new value's hash/list), same `ok()/err()` idiom.
- CLI (`apps/orchestrator/src/cli.ts`): `set-profile --slave <id> | --template <id> | --company-slave <id> --file <path>` (`--clear` to null), `set-runtime-roles --slave <id> --roles a,b`, `show-context --run <id>` (prints the manifest, `--prompt` prints the text). Refusal → exit-code mapping as `unblock-task`.
- Web routes (`requirePrincipal`, `refusalStatus`): `PATCH /api/w/[id]/slaves/[slaveId]/profile`, `PATCH .../runtime-roles`; `GET /api/w/[id]/runs/[runId]/context`. Slave panel: a Profile block (effective text with origin label, editable textarea, save), runtime-role chips (editable). Run detail: "What this run saw" — manifest list (missing skills highlighted) and a collapsed prompt. No redesign.

## 7. Errors and edges
- No effective profile → section omitted, manifest `profile: null`. Profile over the cap at build (possible only if the constant was lowered after the text was written) → dispatch refused with a `guardrail.tripped`-style event `run.context_refused` and the task released as `failToStart` does today.
- Empty `runtimeRoles` → never a scheduler candidate; the web warns; `set-runtime-roles` is the exit.
- Skill directory name collides with an existing `.claude/skills` entry committed in the repo → the injected copy wins inside the worktree only (the dir is rewritten per dispatch and ignored by git); the manifest records `overrode_repo_skill: true`.
- A skill's `SKILL.md` `name:` differs from the catalog `Skill.name` → `skillCalls` tallies under the frontmatter name; the manifest records both so analytics can join them. Not "fixed" here.
- Two dispatches of the same run id (redispatch after `failToStart`) → upsert; one row.

## 8. Tests and gate
- Domain: `renderRunContext` order and omission per kind; marker neutralisation; `displayName`/`rosterLine`; manifest schema round-trip.
- Orchestrator (real DB, real git worktree): effective-profile chain (slave > company > template > none); skills copied + `.gitignore` + `git status --porcelain` empty; missing skill → manifest `missing`, run still starts; rework rewrites the skills dir; Cursor → `provider_unsupported`; review and planning runs get the reviewer's/manager's profile and no inbox; `RunContext` row written before spawn (assert order via the fake adapter's start hook); redispatch upserts.
- Roles: scheduler picks a slave whose `role` differs from `requiredRole` but whose `runtimeRoles` contain it; review/planning staffing likewise; role-addressed message and ask roster on `runtimeRoles`; migration backfill test on seeded rows (`role` + `requiredRole` → set).
- Control/CLI/web: `setProfile`/`setRuntimeRoles` refusals and events; CLI verbs end to end (`cli.test.ts` style); routes + panel tests; `web:build`.
- `scripts/gate-m37-run-context.mjs` (fake CLI, real daemon, temp skills root): a slave with `role = 'Senior Engineer'`, `runtimeRoles = ['backend','reviewer']`, a template profile overridden on the slave, one assigned skill in a temp `personal` root and one assigned skill whose source is missing → the implementation run starts: `RunContext.prompt` contains the slave's profile text and the present skill's name and not the missing one; `<worktree>/.claude/skills/<name>/SKILL.md` exists and `git status --porcelain` in the worktree is empty; the manifest lists `missing`; then a review run for the task is staffed onto the same slave (literal `role` is not `reviewer`), and its `RunContext` carries the reviewer profile and the diff. `gate:m37-run-context` in `package.json` and CI after `gate:m36-messaging`; README section "What a slave is told" (profile, roles, skills, `show-context`).
- Full verification: typecheck, vocabulary, full `vitest run`, `web:build`, gates m37, m36, m35, m33, m11.

## 9. Non-goals
- Unifying the spawn block shared by tick/review/planning (a separate cleanup).
- A skills mechanism for Cursor.
- Importing external persona catalogs (agency-agents) — M41.
- Profile versioning/history — M39 (requirement versioning); the manifest's profile hash is the hook.
- Rebuilding a context on resume.

## 10. Order of work
1. Data model + domain render + `displayName` (migrations, pure render, tests).
2. Orchestrator builder + skills injection + three call sites + `RunContext` row (removes the four old prompt builders).
3. Runtime roles everywhere (scheduler, staffing, messaging, adoption, backfill) + control verbs + CLI.
4. Web (profile block, role chips, run context view) + routes.
5. Gate, CI, README, full verification.

## 11. Errata — where execution corrected the plan
### Pre-execution (plan writing, 2026-09-08)
- **E1 — ignore mechanism.** §4 said `<worktree>/.claude/skills/.gitignore` = `*`. A repository may TRACK its own `.claude/skills/`; deleting or ignoring that directory would show deletions in `git status` and a `.gitignore` cannot hide tracked files. Corrected: only previously injected directories (recorded in `.claude/skills/.slaveofai-injected.json`) are removed; a skill the repo already ships is not copied and is recorded as `shadowedByRepo` (the CLI discovers the repo's copy anyway); injected paths are added to the per-worktree `info/exclude` (`git rev-parse --git-path info/exclude`), which never touches the tree. §7's `overrode_repo_skill` flag becomes `shadowedByRepo: string[]`.
- **E2 — backfill test.** §8 asked for a vitest of the `runtimeRoles` backfill. The test database is already migrated when tests run, so `requiredRole` cannot be seeded. Corrected: the implementer seeds two rows on the dev DB before `db:migrate`, reads them back after, and pastes both readings into the task report.
- **E3 — profile-change events.** §6 said both verbs emit an event. Templates and company slaves belong to no workspace and the org layer has no event stream; `slave.profile_changed` is emitted only for slave targets.
- **E4 — planning skills.** Planning runs execute in the primary checkout; skills are never injected there. `no_worktree: true` is observable on `injectSkills`' result, NOT in a planning manifest: §3's planning order has no `skills` section and the renderer refuses out-of-order kinds, so a planning `RunContext` says nothing about skills (Task 2 review, controller ruling).
### Task 2 (2026-09-08)
- **E1 corrected — the exclude is repository-wide.** Git has no per-worktree `info/exclude`: `git rev-parse --git-path info/exclude` from a linked worktree resolves to the common `.git/info/exclude` (verified in a scratch repo by the implementer and again by the reviewer). Kept, by controller ruling, because it never touches tracked files and never dirties a tree. Accepted consequences: (a) an untracked `.claude/skills/<name>/` in the operator's primary checkout is also hidden from `git status`; (b) the file accumulates one line per skill name ever injected, never removed; (c) it is a file operators hand-maintain (this repo's carries `.superpowers/` and `/.claude/RESUME.md`). The plan's phrase "which never touches the tree" stands; "per-worktree" does not.
- **§1 clarified — resume prompts.** `deliver.ts`'s resume prompt renders the question and answer bodies raw; §4/§9 exempt the resume path from the builder, and this errata makes the exemption explicit. Neutralising there is a follow-up, not an M37 requirement.
- **§1 clarified — task title/description** reach the prompt raw by design (they are the work); §1's neutralisation list is exhaustive: profile, message bodies, skill descriptions.
