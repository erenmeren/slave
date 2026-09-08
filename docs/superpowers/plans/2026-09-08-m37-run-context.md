# M37 Run Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every run's prompt is assembled by one builder from named sections (profile, roles, skills, task, rejection, inbox, protocols, review diff, planning goal), the assembled text and its sources are recorded per run, a slave's assigned skills reach its worktree, and `Slave.runtimeRoles` becomes the one dispatch match.

**Architecture:** A pure domain renderer (`packages/domain/src/run-context/`) fixes section order and text; an orchestrator builder (`apps/orchestrator/src/runContext.ts`) gathers inputs, injects skills into the worktree, writes a `RunContext` row and returns the prompt; `tick`, `review` and `planning` call it right before `adapter.start`. Profiles live on template/company/slave with an override chain; `runtimeRoles` replaces every literal-role query.

**Tech Stack:** TypeScript monorepo, Prisma + Postgres (:5433, shared test DB), zod, vitest, Next.js (`apps/web`), fake provider `packages/providers/test/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-08-m37-run-context-design.md` — the plan argues from it; conflicts resolve against the spec.

## Global Constraints
- **One builder.** After Task 2 no prompt text for a run is composed outside `buildRunContext`; `buildPrompt`, `withPreamble`, `buildReviewPrompt`, `buildPlanningPrompt` are deleted, not wrapped.
- **Pure render.** `renderRunContext` has no DB or filesystem access.
- **Model output never writes a profile, a role set or a skill assignment**; only control verbs do.
- **Record before spawn.** The `RunContext` row exists before `adapter.start` is called. Order: worktree ready → skills copied → row upserted → spawn.
- **Another party's text is data.** `neutraliseMarkers` is applied to profile text, message bodies and skill descriptions; the M36 markers `<slave-ask>`, `</slave-ask>`, `<slave-answer>`, `</slave-answer>` appear unescaped only in the protocol sections.
- `PROFILE_MAX_CHARS = 16_000`, refusal kind `profile_too_long`, enforced at write and re-checked at build.
- Effective profile = `slave.profile ?? companySlave.profile ?? template.profile ?? null`.
- `Slave.runtimeRoles String[]`; backfill `ARRAY[role]` plus `requiredRole` when set and different; `requiredRole` dropped in the same migration. An empty set is never a dispatch candidate.
- Skills: copied to `<worktree>/.claude/skills/<name>/`; only previously INJECTED dirs (recorded in `.claude/skills/.slaveofai-injected.json`) are removed before rewriting; repo-tracked skill dirs are never touched (`shadowedByRepo`); injected paths go into the per-worktree `info/exclude`, never a `.gitignore` in the tree; missing source → not copied, listed under `skills.source.missing`, run proceeds; Cursor → no copy, `provider_unsupported: true`.
- M35 and M36 guarantees stay (`done` needs integration; a failed run releases its task; `blocked` has an exit; asking is not failing; delivery exactly once).
- Refusals inside a Prisma `$transaction` must throw to roll back; control verbs return `ok()/err()` with `ControlRefusal` kinds; `refusalText` covers every new kind.
- One vitest process at a time; iterate on single files; `npm run --silent typecheck` (checks every tsconfig.test.json and apps/web); `npm run --silent gate:m26-vocabulary` (the word is `slave`); `npm run web:build` last and only when `ps -eo args | grep -v grep | grep -c "next dev"` is 0.
- Migrations: real directories under `packages/db/prisma/migrations/` (newest naming as precedent), `npm run db:migrate` and `npm run db:migrate:test`, `npx prisma migrate diff` empty.
- Never a real model call. Commit trailers:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_016k82sjPrfBFgqQsdp1hKU6
  ```

---
## File structure
```
packages/db/prisma/schema.prisma + migrations 20260908190000_m37_profiles_roles, 20260908191000_m37_run_context
packages/domain/src/run-context/sections.ts     (Section union, Manifest, runContextManifestSchema)
packages/domain/src/run-context/render.ts       (renderRunContext, neutraliseMarkers)
packages/domain/src/run-context/names.ts        (displayName, rosterLine)
packages/domain/src/run-context/index.ts
packages/control/src/profile.ts                 (setProfile, setRuntimeRoles, effectiveProfile, PROFILE_MAX_CHARS)
packages/control/src/skills.ts                  (+ skillSourceDir; roots extracted so orchestrator can reuse them)
apps/orchestrator/src/runContext.ts             (buildRunContext; skill injection)
apps/orchestrator/src/inbox.ts                  (section producers only; withPreamble removed)
apps/orchestrator/src/tick.ts, review.ts, planning.ts (call buildRunContext; old prompt builders removed; staffing on runtimeRoles)
packages/domain/src/scheduler/decide.ts, apps/orchestrator/src/world.ts (runtimeRoles match)
packages/control/src/messaging.ts, apps/orchestrator/src/ask.ts, answer.ts, deliver.ts (role addressing on runtimeRoles; rosterLine)
packages/control/src/org.ts, simulation/adopt.ts (adoption writes runtimeRoles)
apps/orchestrator/src/cli.ts                    (set-profile, set-runtime-roles, show-context)
apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/{profile,runtime-roles}/route.ts, runs/[runId]/context/route.ts
apps/web/src/server/slaveControlRoute.ts, overview.ts, components/SlavePanel.tsx, SlaveCard.tsx, TaskDetailPanel.tsx
scripts/gate-m37-run-context.mjs, package.json, .github/workflows/ci.yml, README.md
```

---

### Task 1: Data model, pure renderer, names

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`Slave` 142-169, `SlaveTemplate` 180-191, `CompanySlave` 222-238, `SlaveRun.suppliedMessageIds` at 430; new `RunContext`)
- Create: `packages/db/prisma/migrations/20260908190000_m37_profiles_roles/migration.sql`, `packages/db/prisma/migrations/20260908191000_m37_run_context/migration.sql`
- Create: `packages/domain/src/run-context/{sections,render,names,index}.ts`; export from `packages/domain/src/index.ts`
- Test: `packages/domain/test/run-context/render.test.ts`, `names.test.ts`, `sections.test.ts`. The backfill cannot be a vitest (the test DB is already migrated, so `requiredRole` no longer exists to seed): BEFORE running `npm run db:migrate` on the dev DB, insert one slave row with `role='lead'`, `requiredRole='manager'` and one with `role='qa'`, `requiredRole=NULL` via `psql`/Prisma; after migrating, read both back (`runtimeRoles` = `{lead,manager}` and `{qa}`), paste both readings into the report, then delete the two rows.

**Interfaces (Produces):**
```ts
// packages/domain/src/run-context/sections.ts
export type SectionKind = 'profile' | 'roster' | 'skills' | 'inbox' | 'ask_protocol' | 'answer_protocol'
  | 'task' | 'rejection' | 'review_diff' | 'planning_goal'
export interface Section { readonly kind: SectionKind; readonly text: string; readonly source: SectionSource }
export type SectionSource =
  | { kind: 'profile'; origin: 'slave' | 'company' | 'template'; sha256: string }
  | { kind: 'roster'; slaveIds: readonly string[] }
  | { kind: 'skills'; copied: readonly string[]; missing: readonly string[]; shadowedByRepo: readonly string[]; provider_unsupported: boolean; no_worktree: boolean }
  | { kind: 'inbox'; messageIds: readonly string[] }
  | { kind: 'ask_protocol' } | { kind: 'answer_protocol' }
  | { kind: 'task'; taskId: string } | { kind: 'rejection'; taskId: string }
  | { kind: 'review_diff'; base: string; head: string; capped: boolean }
  | { kind: 'planning_goal'; sha256: string }
export interface Manifest { readonly kind: 'implementation' | 'review' | 'planning'; readonly sections: readonly SectionSource[] }
export const runContextManifestSchema: z.ZodType<Manifest>   // validates a stored Json at read
// packages/domain/src/run-context/render.ts
export const SECTION_ORDER: Readonly<Record<Manifest['kind'], readonly SectionKind[]>> = {
  implementation: ['profile','roster','skills','inbox','ask_protocol','task','rejection'],
  review:         ['profile','skills','task','review_diff'],
  planning:       ['profile','planning_goal'],
}
export const MARKERS = ['<slave-ask>','</slave-ask>','<slave-answer>','</slave-answer>'] as const
export function neutraliseMarkers(text: string): string   // replaces each marker's '<' with '‹' (U+2039) — reversible for a reader, inert for parseSlaveAsk/parseSlaveAnswers
export function renderRunContext(kind: Manifest['kind'], sections: readonly Section[]): { prompt: string; manifest: Manifest }
// packages/domain/src/run-context/names.ts
export function displayName(slave: { name: string; role: string }): string          // "Maya (Senior Engineer)"
export function rosterLine(slave: { id: string; name: string; role: string; runtimeRoles: readonly string[] }): string // "Maya (Senior Engineer; roles: backend, reviewer) — id abc"
```
Rules for `renderRunContext`: sections are sorted by `SECTION_ORDER[kind]`; a kind not in the order for that run kind throws (`unknown section for kind`); sections with empty `text` are dropped; `prompt` = sections joined by `\n\n`; the review kind appends the verdict instructions text moved verbatim from `review.ts` `buildReviewPrompt` (lines 40-59 — copy the exact strings; the `task` section carries title+description, `review_diff` the fenced diff), the planning kind appends the graph instructions moved verbatim from `planning.ts` `buildPlanningPrompt` (32-43). `neutraliseMarkers` is NOT applied inside `renderRunContext` (the builder applies it to profile, inbox bodies and skill descriptions before constructing sections; protocol sections must keep raw markers) — test that a section text containing `<slave-ask>` survives render unchanged, and that `neutraliseMarkers` makes `parseSlaveAsk` (`@slave-of-ai/domain`) return no block.

**Schema changes:**
```prisma
model SlaveTemplate { … profile String? … }
model CompanySlave  { … profile String? … }
model Slave { … role String  /// the profile's title — display and persona only
              runtimeRoles String[]  /// the roles this slave may be dispatched as (scheduler, review, planning, message addressing)
              profile String? … }     // requiredRole REMOVED
model RunContext {
  id        String   @id @default(uuid())
  runId     String   @unique
  prompt    String
  sections  Json
  createdAt DateTime @default(now())
  run SlaveRun @relation(fields: [runId], references: [id], onDelete: Cascade)
}
model SlaveRun { … context RunContext? … }   // suppliedMessageIds REMOVED
```
Migration 1 SQL (hand-written, in this order): add the three `profile` columns; `ALTER TABLE "Slave" ADD COLUMN "runtimeRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`; backfill `UPDATE "Slave" SET "runtimeRoles" = CASE WHEN "requiredRole" IS NOT NULL AND "requiredRole" <> "role" THEN ARRAY["role","requiredRole"] ELSE ARRAY["role"] END`; `ALTER TABLE "Slave" DROP COLUMN "requiredRole"`. Migration 2: create `RunContext`; `ALTER TABLE "SlaveRun" DROP COLUMN "suppliedMessageIds"` (M36's only readers are `tick.ts:615` and the tick test — Task 2 rewrites them; until then typecheck will fail on `suppliedMessageIds`, so in THIS task delete the write at `tick.ts:615` and the assertion in `tick.test.ts` that reads it, leaving the inbox ids unrecorded for the one commit between Task 1 and Task 2; say so in the commit body).

- [ ] Tests first: `render.test.ts` (order per kind; empty sections dropped; unknown kind throws; review/planning instruction suffixes present; raw markers survive), `names.test.ts`, `sections.test.ts` (schema accepts a valid manifest, rejects a malformed one) → run each file alone → migrations (`npm run db:migrate`, `npm run db:migrate:test`, `npx prisma migrate diff` empty) → implement → typecheck (fix every `requiredRole` reader: `packages/control/src/org.ts` `assignCompanyTx` ~450-457 writes `role: override ?? template.role` — add `runtimeRoles: [override ?? template.role]` for now; Task 3 refines) → vocabulary gate.
- [ ] Commit `feat(db,domain): m37 t1 — profiles, runtimeRoles, RunContext table; the pure run-context renderer`.

---

### Task 2: The builder, skill injection, one call site per run kind

**Files:**
- Create: `apps/orchestrator/src/runContext.ts`; Test: `apps/orchestrator/test/integration/runContext.test.ts`
- Modify: `packages/control/src/skills.ts` (export `skillRoots()` = today's private `defaultRoots()` with an env/DI seam already used by tests, and add `export function skillSourceDir(roots: SkillRoots, providerName: string, skillName: string): string | null` — `personal` → `roots.personal/<name>`, `project` → `roots.project/<name>`, `plugin:<p>` → highest-version dir under `roots.pluginCache` for plugin `<p>` (reuse `compareVersions` at 156-164 and the loop shape in `scanPluginCache` 168-206, extracted into `highestPluginVersionDir(roots, plugin)`), else `null`); Test: `packages/control/test/integration/skills.test.ts`
- Modify: `apps/orchestrator/src/inbox.ts` (delete `withPreamble` 137+; `pendingInbox` returns `Section | null` via a new `inboxSection(slaveId)`; `askProtocol` returns the protocol `Section` and the roster `Section` separately: `askProtocolSection()`, `rosterSection(slaveId, workspaceId)` — roster built with `rosterLine` from `@slave-of-ai/domain` and `runtimeRoles`), `apps/orchestrator/src/tick.ts` (delete `buildPrompt` 149-158; replace 575-596 and the 601-617 update), `apps/orchestrator/src/review.ts` (delete `buildReviewPrompt` 40-59; the diff computation stays and becomes the `review_diff` section input; `start` at 407-418), `apps/orchestrator/src/planning.ts` (delete `buildPlanningPrompt` 32-43; `start` at 338-349)
- Tests to update: `apps/orchestrator/test/integration/tick.test.ts` (the prompt assertions at ~220-233 and the M36 inbox/protocol cases), `review.test.ts`, `planning.test.ts`, `answer.test.ts` (M36's protocol tests moved to the builder), `worktree.test.ts` (+ injected skills dir + exclude case)

**Interfaces:**
```ts
// apps/orchestrator/src/runContext.ts
export interface BuildRunContextInput {
  readonly runId: string
  readonly kind: 'implementation' | 'review' | 'planning'
  readonly slaveId: string
  readonly workspaceId: string
  readonly taskId: string | null            // null for planning
  readonly worktreePath: string | null      // the run's worktree; null for planning (it runs in the primary checkout, where skills are never injected → skills source `no_worktree: true`)
  readonly provider: 'claude' | 'cursor'
  readonly reviewDiff?: { readonly text: string; readonly base: string; readonly head: string; readonly capped: boolean }
  readonly skillRoots?: SkillRoots          // test seam; defaults to skillRoots()
}
export interface BuiltRunContext { readonly prompt: string; readonly manifest: Manifest }
export async function buildRunContext(input: BuildRunContextInput): Promise<BuiltRunContext>
export function effectiveProfile(slave: { profile: string | null; companySlave: { profile: string | null; template: { profile: string | null } } | null }): { text: string; origin: 'slave' | 'company' | 'template' } | null
export const SKILLS_DIR = '.claude/skills'
```
Behaviour (in this order): load slave (`include: { companySlave: { include: { template: true } }, skills: { include: { skill: { include: { provider: true } } } } }`), task (title, description, lastRejectionReason) when `taskId` set, workspace goal for planning → profile section (`effectiveProfile`, `neutraliseMarkers`, sha256 hex of the raw text; refuse with `throw new RunContextRefused('profile_too_long')` when `text.length > PROFILE_MAX_CHARS` — `tick.startRun` maps it to `failToStart`; `dispatchReview` treats it exactly as 'the diff itself cannot be produced' (its bounded-retry path); `dispatchPlanning` as its existing dispatch failure) → implementation only: `rosterSection`, `inboxSection` (bodies through `neutraliseMarkers`), `askProtocolSection` → skills: when `provider === 'cursor'` → `provider_unsupported: true`; when `worktreePath === null` → `no_worktree: true`; else: read `<worktree>/.claude/skills/.slaveofai-injected.json` (the names injected by the previous dispatch; absent → `[]`) and remove exactly those directories (never `rm -rf` the whole `.claude/skills` — the repo may track its own skills there); then for each assigned skill: `git -C <worktree> ls-files --error-unmatch .claude/skills/<name>` succeeds → the repo ships that skill itself → `shadowedByRepo.push(name)`, not copied; `skill.missingSince !== null` or `skillSourceDir(...) === null` or dir absent → `missing.push(name)`; else `fs.cpSync(src, dest, { recursive: true })` → `copied.push(name)`; write the marker file with `copied`; append to the PER-WORKTREE exclude file (`git -C <worktree> rev-parse --git-path info/exclude`, which resolves to `<common>/worktrees/<id>/info/exclude` for a linked worktree) the lines `/.claude/skills/.slaveofai-injected.json` and `/.claude/skills/<name>/` for every copied name, each only if not already present — so `git status --porcelain` stays empty and `Checkpoint.dirtyFiles`/merge never see them; skills section text lists `copied` ∪ `shadowedByRepo` (both are discoverable by the CLI) with each skill's `description` (neutralised) → task/rejection sections → review_diff → planning_goal → `renderRunContext` → `prisma.runContext.upsert({ where: { runId }, create: {…}, update: { prompt, sections } })` → return.
Call sites: `tick.startRun` replaces 575-596 with `const built = await buildRunContext({ runId, kind: 'implementation', slaveId: slave.id, workspaceId: workspace.id, taskId: task.id, worktreePath: worktree.path, provider: resolved.provider })` and passes `prompt: built.prompt`; the `slaveRun.update` at 601-617 drops `suppliedMessageIds`. `review.dispatchReview`: compute the diff exactly as today, then `buildRunContext({ …, kind: 'review', taskId, worktreePath: <the same worktreePath review.ts already passes to start — the task's worktree>, reviewDiff })`. `planning.dispatchPlanning`: `buildRunContext({ …, kind: 'planning', taskId: null, worktreePath: null })`. `deliver.ts` and the web's M36 readers of `suppliedMessageIds` (grep `suppliedMessageIds` — `apps/web/src/server/*.ts`) read `manifest.sections` (`kind: 'inbox'`).`messageIds` via `runContextManifestSchema.parse(row.sections)`.

- [ ] Tests first (`runContext.test.ts`, real DB + real git worktree from `worktree.test.ts`'s helpers): profile chain slave > company > template > none; roster uses `rosterLine` and excludes self; inbox bodies neutralised, protocol raw; skills copied + marker + per-worktree exclude + `git -C <wt> status --porcelain` empty; missing skill listed and run still built; a repo-tracked `.claude/skills/<name>` is left untouched and listed under `shadowedByRepo`; second build after changing the assignment removes the stale injected dir and nothing else; cursor → `provider_unsupported`; planning → `no_worktree`; review carries profile + diff and no inbox; `RunContext` row upserted (two builds, one row); profile over cap throws `RunContextRefused`. Then `tick.test.ts`: the row exists BEFORE the fake adapter's `start` is called (assert inside the recording adapter's `start`), and the prompt passed to `start` equals `RunContext.prompt`. → covering files one at a time → typecheck → vocabulary.
- [ ] Commit `feat(orchestrator,control): m37 t2 — one builder puts the slave in front of the model, injects its skills, and records what it saw`.

---

### Task 3: runtimeRoles everywhere, profile verbs, CLI

**Files:**
- Modify: `packages/domain/src/scheduler/decide.ts` (`SchedulableSlave.role` → `runtimeRoles: readonly string[]`; line 63 → `.find((a) => a.runtimeRoles.includes(candidate.requiredRole))`), `apps/orchestrator/src/world.ts` (`loadSlaveRows` select `runtimeRoles`, mapping at 326-330), `apps/orchestrator/src/review.ts:277-281` (`where: { runtimeRoles: { has: 'reviewer' }, team: { workspaceId } }`), `apps/orchestrator/src/planning.ts:225-229` (`runtimeRoles: { has: 'manager' }`), `packages/control/src/messaging.ts` (role addressing: `recipientRole` matches `runtimeRoles: { has: role }` in `listMessagesForSlave`, `markMessageRead`, `listPendingQuestions`; `sendMessage`'s "role held by someone" check), `apps/orchestrator/src/ask.ts` (`recipientCanAnswer`), `answer.ts`, `deliver.ts` (`rosterLine`/`displayName`), `packages/control/src/org.ts:450-457` (`runtimeRoles: dedupe([override ?? template.role, template.role])`), `packages/control/src/simulation/adopt.ts` (unchanged shape; assert the write through `assignCompanyTx`)
- Create: `packages/control/src/profile.ts`; Modify: `packages/control/src/refusal.ts` (+ `profile_too_long { limit: number; length: number }`, `invalid_runtime_roles { reason: string }`), `packages/domain/src/events/schema.ts` (+ `slave.profile_changed { target: 'slave'|'template'|'company_slave'; targetId; sha256: string | null }`, `slave.runtime_roles_changed { slaveId; roles: string[] }`), `packages/control/src/index.ts`
- Modify: `apps/orchestrator/src/cli.ts` (+ `set-profile`, `set-runtime-roles`, `show-context`)
- Tests: `packages/domain/test/scheduler/decide.test.ts`, `apps/orchestrator/test/integration/{review,planning,tick,ask,answer}.test.ts`, `packages/control/test/integration/{messaging,answer,adopt,profile}.test.ts` (new `profile.test.ts`), `apps/orchestrator/test/integration/cli.test.ts`, `packages/events` schema test, `apps/web/test/refusal-status.test.ts` (completeness list)

**Interfaces:**
```ts
// packages/control/src/profile.ts
export const PROFILE_MAX_CHARS = 16_000
export type ProfileTarget = { slaveId: string } | { templateId: string } | { companySlaveId: string }
export async function setProfile(target: ProfileTarget, profile: string | null, actor: string): Promise<Result<void, ControlRefusal>>
  // refusals: slave_not_found | template_not_found | company_slave_not_found | profile_too_long; trims; '' → null; emits slave.profile_changed only for a slave target (workspaceId from slave.team); template and company-slave targets have no workspace and emit nothing — the org layer has no event stream today
export async function setRuntimeRoles(slaveId: string, roles: readonly string[], actor: string): Promise<Result<void, ControlRefusal>>
  // refusals: slave_not_found | invalid_runtime_roles (blank entry, duplicate, > 20 entries); trims; emits slave.runtime_roles_changed
// cli.ts
//   set-profile --slave <id> | --template <id> | --company-slave <id>  (--file <path> | --clear)
//   set-runtime-roles --slave <id> --roles a,b,c
//   show-context --run <id> [--prompt]   → prints the manifest as JSON; with --prompt prints RunContext.prompt after a line of dashes
```
`setSlaveRole` (existing, `cli.ts:921-928`) keeps setting `role` only — it now changes the title, not dispatch; its help text/comment must say so.

- [ ] Tests first: scheduler picks a slave whose `role` ≠ `requiredRole` but whose `runtimeRoles` has it, and skips an empty set; review/planning staffing on `runtimeRoles` (a `role: 'Senior Engineer'` slave with `runtimeRoles: ['reviewer']` is staffed; a `role: 'reviewer'` slave with `runtimeRoles: []` is not); role-addressed message reaches every holder by `runtimeRoles`; ask roster lists runtime roles; adoption writes `runtimeRoles` `[runtime, catalog]`; `setProfile` chain + refusals + event; `setRuntimeRoles` refusals + event; CLI verbs end to end (`cli.test.ts` style, real subprocess) → covering files one at a time → typecheck → vocabulary.
- [ ] Commit `feat(control,orchestrator,domain,cli): m37 t3 — runtimeRoles is the one dispatch match; profiles and roles are set by verbs`.

---

### Task 4: Web — profile block, role chips, what a run saw

**Files:**
- Create: `apps/web/src/server/slaveControlRoute.ts` (`slaveControlResponse(workspaceId, slaveId, operate)` — 404 unless `Slave.team.workspaceId === workspaceId`, mirroring `messageControlRoute.ts`), `apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/profile/route.ts` (PATCH `{ profile: string | null }` → `setProfile({ slaveId }, profile, principal)`), `.../slaves/[slaveId]/runtime-roles/route.ts` (PATCH `{ roles: string[] }`), `.../runs/[runId]/context/route.ts` (GET → `{ prompt, manifest }` or 404; scope via `runControlResponse`'s workspace check or a read-only sibling)
- Modify: `apps/web/src/server/overview.ts` (`SlaveCardData` 28-133: + `profile: { text: string; origin: 'slave'|'company'|'template' } | null`, `runtimeRoles: string[]`), `apps/web/src/components/SlavePanel.tsx` (Profile block: origin label, textarea, save → PATCH; runtime-role chips with an edit field → PATCH), `SlaveCard.tsx` (chips instead of the bare role badge where the badge is a dispatch signal; the title stays), `TaskDetailPanel.tsx` (run section "What this run saw": fetch `/context`, list manifest sections, `missing` skills highlighted, collapsed `<details>` with the prompt), `apps/web/src/server/tasks.ts` if it renders run inputs
- Tests: `apps/web/test/integration/control-routes.test.ts` (+ `describe('profile')`, `describe('runtime-roles')`, `describe('run context')`: happy path, cross-workspace 404, malformed body 400, refusal 409 via `refusalStatus`), `apps/web/test/slave-panel.test.tsx` (posted URL/body for both PATCHes; origin label), `apps/web/test/integration/overview.test.ts` (new fields), a `TaskDetailPanel` test for the context section; `npm run web:build` last (check `next dev` first)

- [ ] Tests first → implement → covering files one at a time → typecheck → vocabulary → `web:build`.
- [ ] Commit `feat(web): m37 t4 — profile and runtime roles on the slave panel; a run shows what it saw`.

---

### Task 5: Gate, CI, README, full verification

**Files:** `scripts/gate-m37-run-context.mjs`, `package.json` (`"gate:m37-run-context": "tsc --build && node --env-file=.env scripts/gate-m37-run-context.mjs"`), `.github/workflows/ci.yml` (after `gate:m36-messaging`), `README.md` (section "What a slave is told": profile chain, runtime roles vs title, skills injection and the per-worktree exclude, `set-profile` / `set-runtime-roles` / `show-context`, the run's "what it saw" panel; gate listed under "Tests and CI").

Gate (borrow `gate-m36-messaging.mjs`'s setup/teardown/daemon helpers via `scripts/lib/daemon-process.mjs`; fake CLI only): temp git repo + workspace; a temp skills root (`personal`) holding `alpha/SKILL.md` (frontmatter `name: alpha`) — point the gate's `skillRoots` seam at it via the same env the control layer's tests use (add `SLAVEOFAI_SKILL_ROOTS_JSON` or reuse an existing seam — check `skills.test.ts`); sync the catalog; a template with `profile: 'You are Atlas…'`, a slave `role: 'Senior Engineer'`, `runtimeRoles: ['backend','reviewer']`, `profile` overridden on the slave, assigned skills `alpha` and a catalog row `ghost` whose source dir does not exist; one `backend` task. Stage 1: tick → run starts; print and assert: `RunContext.prompt` contains the slave's override text (not the template's), contains `alpha` and not `ghost`; manifest `skills.copied = ['alpha']`, `missing = ['ghost']`, profile origin `slave`; `<worktree>/.claude/skills/alpha/SKILL.md` exists; `git -C <worktree> status --porcelain` is empty; `git -C <worktree> rev-parse --git-path info/exclude` names `/.claude/skills/alpha/`. Stage 2: drive the task to `verifying`→review dispatch (as `gate-m35` builds preconditions honestly) → the review run is staffed onto the same slave (its literal `role` is not `reviewer`) and its `RunContext` has the reviewer's profile, the diff, and no inbox section. Stage 3: `show-context --run <id>` CLI subprocess prints a manifest that parses with `runContextManifestSchema`. Teardown in FK order (RunContext cascades from SlaveRun).

- [ ] Full verification in this order, one at a time: `npm run --silent typecheck`; `npm run gate:m26-vocabulary`; `npx vitest run` (full; no daemon running; the daemon CLI llm-decision row-count case is a known flake — re-run that file alone before believing it); `npm run web:build` (only if no `next dev`); gates m37, m36, m35, m33, m11.
- [ ] Commit `test(gates),docs: m37 t5 — gate:m37-run-context; README`.
