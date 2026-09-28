# Conductor, Plan 3 of 5: a package worker touches only its own files

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec R4 (ownership is enforced twice: the permission gate denies a write tool on a file the run does not own, and the run's diff is audited against the owned globs before verify) and R11's `foreign_file` situation (after a second violation the conductor is told).

**Architecture:** One pure domain rule, `OwnershipRule`, says which repo-relative paths a package owns (its own globs; for the integration package, everything no other package of the goal version owns; `single` owns everything and is not governed). The orchestrator derives the rule for a package task and (a) writes it into the run's `permissions.json` as regex sources plus the worktree root, which the gate's inline node script checks for write tools before its allow list, denying with capability `foreign_file`; and (b) after the run's leftover work is committed, lists the files the task branch changed since its merge-base with the base branch and rejects the run back to rework, naming every foreign file. Each audit rejection writes `task.ownership_violated`; two on one task raise the Supervisor situation `foreign_file`.

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes), bash + inline node (`scripts/lib/permissions.sh`), Prisma/Postgres, vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-conductor-supervisor-design.md` (R4; R11's `foreign_file`). Plans 1–2 shipped R0–R3, R5–R7. Plan 4 = R8/R9 (verification run, gate, goal-version integration branch, intake staffing, `conducted` default). Plan 5 = R10/R11 remainder.

## Decisions this plan makes

- **D1. One rule, two enforcers, no second glob implementation.** The domain turns globs into `RegExp` (`globToRegExp`, Plan 2). The gate cannot import TypeScript, so the permissions file carries the rule as regex SOURCES (`RegExp.prototype.source`), and the node script does `new RegExp(source, 'u')`. The diff audit uses the same `OwnershipRule` in TypeScript.
- **D2. The integration package's rule is "not owned by anyone else".** `owned: null` (everything) with `excluded` = every non-integration package's globs of the same goal version — exactly `ownerOf`'s fallback. A conductor-named integration package's own globs add nothing (they are inside "not owned by anyone else" by validation).
- **D3. `single` is not governed.** A package whose globs include `**` owns every path; the rule is `null` and neither enforcer runs — spec R4: "`single` mode owns `**`, so both checks pass trivially."
- **D4. Paths outside the worktree are not governed by ownership.** A write to `/tmp/x` or `$SLAVEOFAI_VERIFY_DIR` is not a repository file another worker owns. The gate only judges a path whose worktree-relative form does not start with `..`.
- **D5. The gate judges only tools the vocabulary maps to `write_repo`, by `tool_input.file_path` or `tool_input.notebook_path`.** Claude: `Write`, `Edit`, `NotebookEdit` (`MultiEdit` is already `ungoverned_tool`). Cursor's hook payload names are unmeasured against its vocabulary; the diff audit is the enforcement that holds on every runtime, including `Bash` writes.
- **D6. The deny reason keeps its parsed shape.** `permission matrix denies 'foreign_file' (Write) for this slave` — `parsePermissionDenyReason` and the pump already handle it, so a denial is a `run.tool_denied` event and the run continues. The worker knows which file from its own tool call.
- **D7. The audit runs before the report is filed.** A run that wrote a foreign file is rejected for that, not for its report; `fileRunReport` is not reached. The rejection shares Plan 2's owned-task rejection (guarded on `activeRunId`).
- **D8. `foreign_file` is raised after the SECOND audit violation of a task (spec R11), counted from `task.ownership_violated` events since the task's goal version was conducted.** Gate denials do not count: a denied call changed nothing. Its remedy is a person (`escalate_to_human`); `permission_blocked` never fires for `foreign_file` because a grant is not the remedy.

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (`node scripts/gate-m26-vocabulary.mjs`). Never write "agency-agents" in tracked files.
- Never run prettier. Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes, `Result`/`ok`/`err`.
- Tests: ONE vitest process at a time (shared test DB). Iterate per file; `npm run typecheck` before committing (checks test tsconfigs and apps/web); whole suite once at the end, in the background (~15 min).
- Never touch the dev DB (`DATABASE_URL`); tests use `TEST_DATABASE_URL`. Never `db:seed`. Gates run only on `GATE_DATABASE_URL` with the fake-CLI env from `.github/workflows/ci.yml`.
- Migrations: hand-written, purely additive, WHY header; `npm run db:generate && npm run db:migrate:test`.
- Inside a Prisma interactive transaction a refusal must THROW to roll back.
- Never `TRUNCATE "SlaveTemplate" CASCADE` in a test (it empties Person, RunbookTemplate → Workspace); delete your own rows.
- Spec R4 verbatim: "*At the tool call:* the permission gate denies `Write`/`Edit`/`MultiEdit`/`NotebookEdit` on a path outside the run's owned globs (a new matrix input `ownedPaths` in the run's permissions file; deny reason prefixed `permission matrix denies 'foreign_file'`). *At the end of the run:* a shell can write anywhere, so the run's diff is checked against the owned globs before verify; a file outside them fails the run with the list (the worker's attempt, back to rework with "revert changes to files you do not own: …"). `single` mode owns `**`, so both checks pass trivially."
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A write tool whose `file_path` is relative (`src/x.ts`) or contains `..` segments that land back inside the worktree (`src/../lib/y.ts`) is judged by its resolved repo-relative path, not its spelling (Task 2 tests).
- A write outside the worktree (`/tmp/scratch.txt`) is allowed for a package run, and a write inside it that no glob covers is denied (Task 2 tests).
- A package that deletes or renames a foreign file is caught by the audit (a rename lists both paths with `--no-renames`) (Task 4 tests).
- A rework attempt that reverts the foreign change passes the audit (the three-dot diff shows the net change) (Task 4 tests).
- A malformed `ownership` field in the permissions file fails closed (`BADFILE`), never open (Task 2 tests).

---

### Task 1: The ownership rule (domain)

**Files:**
- Create: `packages/domain/src/conduct/ownership.ts`
- Modify: `packages/domain/src/conduct/index.ts`
- Modify: `packages/domain/src/permission/kinds.ts` (`TOOL_DENIED_LABEL`)
- Test: `packages/domain/test/conduct/ownership.test.ts`

**Interfaces:**
- Consumes: `globToRegExp(glob: string): RegExp` (`conduct/glob.ts`), `PackageSpec` (`conduct/packages.ts`).
- Produces:
  - `export interface OwnershipRule { readonly owned: readonly string[] | null; readonly excluded: readonly string[] }` — globs; `owned: null` means every path.
  - `export function ownershipRuleFor(pkg: Pick<PackageSpec, 'key' | 'ownedPaths' | 'isIntegration'>, all: readonly Pick<PackageSpec, 'key' | 'ownedPaths' | 'isIntegration'>[]): OwnershipRule | null` — `null` = not governed (D3).
  - `export function isOwned(rule: OwnershipRule, path: string): boolean`
  - `export interface OwnershipPatterns { readonly owned: readonly string[] | null; readonly excluded: readonly string[] }` — regex sources
  - `export function ownershipPatterns(rule: OwnershipRule): OwnershipPatterns`
  - `export const FOREIGN_FILE_DENIAL = 'foreign_file'`
  - `TOOL_DENIED_LABEL` key type widened to `PermissionKind | 'ungoverned_tool' | 'foreign_file'`, label `'Wrote a file another worker owns'`.

- [ ] **Step 1: Failing tests**

`packages/domain/test/conduct/ownership.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isOwned, ownershipPatterns, ownershipRuleFor } from '../../src/conduct/ownership.js'

const report = { key: 'report', ownedPaths: ['src/report/**'], isIntegration: false }
const config = { key: 'config', ownedPaths: ['src/config.py'], isIntegration: false }
const integration = { key: 'integration', ownedPaths: [], isIntegration: true }
const all = [report, config, integration]

describe('ownershipRuleFor', () => {
  it('gives a package its own globs', () => {
    const rule = ownershipRuleFor(report, all)
    expect(rule).toEqual({ owned: ['src/report/**'], excluded: [] })
    expect(rule !== null && isOwned(rule, 'src/report/csv.py')).toBe(true)
    expect(rule !== null && isOwned(rule, 'src/config.py')).toBe(false)
  })

  it('gives integration everything no other package owns', () => {
    const rule = ownershipRuleFor(integration, all)
    expect(rule).toEqual({ owned: null, excluded: ['src/report/**', 'src/config.py'] })
    expect(rule !== null && isOwned(rule, 'src/cli.py')).toBe(true)
    expect(rule !== null && isOwned(rule, 'README.md')).toBe(true)
    expect(rule !== null && isOwned(rule, 'src/report/table.py')).toBe(false)
  })

  it('does not govern a package that owns **', () => {
    expect(ownershipRuleFor({ key: 'main', ownedPaths: ['**'], isIntegration: false }, [])).toBeNull()
  })
})

describe('ownershipPatterns', () => {
  it('carries regex sources the gate can rebuild, with the same verdicts', () => {
    const rule = ownershipRuleFor(integration, all)
    if (rule === null) throw new Error('governed')
    const patterns = ownershipPatterns(rule)
    expect(patterns.owned).toBeNull()
    const excluded = patterns.excluded.map((source) => new RegExp(source, 'u'))
    expect(excluded.some((r) => r.test('src/report/table.py'))).toBe(true)
    expect(excluded.some((r) => r.test('src/cli.py'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run packages/domain/test/conduct/ownership.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `packages/domain/src/conduct/ownership.ts`:
```ts
import { globToRegExp } from './glob.js'
import type { PackageSpec } from './packages.js'

type Owner = Pick<PackageSpec, 'key' | 'ownedPaths' | 'isIntegration'>

/** What a denial for a file another package owns is called (spec R4). Not a `PermissionKind`:
 *  no grant can open it, so it must never become a `request_permission` proposal. */
export const FOREIGN_FILE_DENIAL = 'foreign_file'

/**
 * Which repo-relative paths one package may change (spec R4), in globs. `owned: null` is "every
 * path" -- the integration package's shape, whose `excluded` is every other package's globs,
 * exactly `ownerOf`'s fallback. The two enforcers (the gate and the diff audit) read this one rule.
 */
export interface OwnershipRule {
  readonly owned: readonly string[] | null
  readonly excluded: readonly string[]
}

/** The rule for `pkg` among its goal version's packages; `null` when it owns `**` (spec R4:
 *  "`single` mode owns `**`, so both checks pass trivially"). */
export function ownershipRuleFor(pkg: Owner, all: readonly Owner[]): OwnershipRule | null {
  if (pkg.ownedPaths.includes('**')) return null
  if (pkg.isIntegration) {
    return { owned: null, excluded: all.filter((p) => !p.isIntegration && p.key !== pkg.key).flatMap((p) => p.ownedPaths) }
  }
  return { owned: [...pkg.ownedPaths], excluded: [] }
}

export function isOwned(rule: OwnershipRule, path: string): boolean {
  const inOwned = rule.owned === null || rule.owned.some((glob) => globToRegExp(glob).test(path))
  return inOwned && !rule.excluded.some((glob) => globToRegExp(glob).test(path))
}

export interface OwnershipPatterns {
  readonly owned: readonly string[] | null
  readonly excluded: readonly string[]
}

/** The rule as regex SOURCES for the gate's node script (plan decision D1): one glob
 *  implementation, rebuilt there with `new RegExp(source, 'u')`. */
export function ownershipPatterns(rule: OwnershipRule): OwnershipPatterns {
  const sources = (globs: readonly string[]): readonly string[] => globs.map((glob) => globToRegExp(glob).source)
  return { owned: rule.owned === null ? null : sources(rule.owned), excluded: sources(rule.excluded) }
}
```
Export from `conduct/index.ts`. In `permission/kinds.ts`, widen `TOOL_DENIED_LABEL`'s key type and add `foreign_file: 'Wrote a file another worker owns'`; fix any compile error the widening causes (web activity cards fall back already).

- [ ] **Step 4: Run** `npx vitest run packages/domain/test/conduct packages/domain/test/permission` and `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(conduct): one ownership rule for a package -- its globs, or for integration everything no one else owns`.

---

### Task 2: The gate denies a write to a file the run does not own

**Files:**
- Modify: `scripts/lib/permissions.sh` (the inline node script, schema comment lines 10-18)
- Modify: `packages/control/src/permission.ts` (`writePermissionsFile` input + body)
- Modify: `packages/providers/src/cursor/decision.ts` (`DecisionPermissions`: optional `ownership`, only if the type is shared with the writer — otherwise leave it)
- Test: `packages/providers/test/permissions-lib.test.ts`, `packages/providers/test/pause-gate.test.ts`, `packages/providers/test/gate.test.ts`, `packages/control/test/permission-mapping.test.ts` (or the file testing `writePermissionsFile`)

**Interfaces:**
- Consumes: `OwnershipPatterns`, `FOREIGN_FILE_DENIAL` (Task 1).
- Produces: `writePermissionsFile(runDir, input)` input gains `readonly ownership?: { readonly worktreeRoot: string; readonly owned: readonly string[] | null; readonly excluded: readonly string[] } | undefined`; the file body gains `ownership` only when given.

- [ ] **Step 1: Failing gate tests** — in `permissions-lib.test.ts`, reuse its helper that writes a permissions file and pipes a payload to `read_permission_verdict` (read the file first; mirror an existing write_repo ALLOW case). Cases, each with a file whose `ownership` is `{ worktreeRoot: W, owned: [ '^src/report/(?:.*/)?.*$' … use ownershipPatterns() from @slave-of-ai/domain to build them ], excluded: [] }`:
  1. `Write` with `tool_input.file_path = W + '/src/report/csv.py'` → ALLOW.
  2. `Write` with `W + '/src/config.py'` → DENY, tool `Write`, capability `foreign_file`.
  3. `Edit` with relative `file_path: 'src/config.py'` (resolved against `worktreeRoot`) → DENY `foreign_file`.
  4. `Write` with `W + '/src/report/../config.py'` → DENY (resolved path).
  5. `Write` with `/tmp/elsewhere.txt` → ALLOW (D4).
  6. `NotebookEdit` with `tool_input.notebook_path = W + '/nb/x.ipynb'` → DENY.
  7. `Read` of a foreign file → ALLOW (reads are not governed).
  8. integration shape `{ owned: null, excluded: [report globs] }`: `W + '/src/cli.py'` → ALLOW; `W + '/src/report/t.py'` → DENY.
  9. no `ownership` field → today's verdicts unchanged (an existing case already covers it; keep it green).
  10. `ownership` present but malformed (`owned: 'x'`, or `worktreeRoot` missing, or an invalid regex source) → BADFILE (helper exits 2).
  In `pause-gate.test.ts`: one end-to-end case through `scripts/pause-gate.sh` asserting the deny JSON's `permissionDecisionReason` is exactly `permission matrix denies 'foreign_file' (Write) for this slave`. In `gate.test.ts`: `parsePermissionDenyReason` of that string returns `{ tool: 'Write', capability: 'foreign_file' }`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement the check** in the node script. After step 2 (identity) and step 3 (`tool` known), BEFORE the `allow.some(...)` ALLOW (a write tool is on the allow list, so the check must come first):
```js
      // 3b. OWNERSHIP (conductor spec R4). A package run may change only the files its package
      // owns. Judged for tools the vocabulary maps to write_repo, by the path the call names,
      // resolved against the worktree root the orchestrator wrote -- not the payload's cwd, which
      // is the session's current directory. A path outside the worktree is not another worker's
      // file (plan D4). Malformed ownership fails closed like every other malformed field.
      if (file.ownership !== undefined) {
        const own = file.ownership;
        const okList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
        if (own === null || typeof own !== "object" || typeof own.worktreeRoot !== "string" ||
            !(own.owned === null || okList(own.owned)) || !okList(own.excluded)) {
          process.stdout.write("BADFILE"); return;
        }
        let owned, excluded;
        try {
          owned = own.owned === null ? null : own.owned.map((s) => new RegExp(s, "u"));
          excluded = own.excluded.map((s) => new RegExp(s, "u"));
        } catch { process.stdout.write("BADFILE"); return; }
        const writeKind = tool !== null && Object.prototype.hasOwnProperty.call(vocabulary, tool) &&
          String(vocabulary[tool]) === "write_repo";
        const input = isObject && payload.tool_input !== null && typeof payload.tool_input === "object" ? payload.tool_input : {};
        const target = typeof input.file_path === "string" ? input.file_path
          : typeof input.notebook_path === "string" ? input.notebook_path : null;
        if (writeKind && target !== null) {
          const path = require("node:path");
          const rel = path.relative(own.worktreeRoot, path.resolve(own.worktreeRoot, target)).split(path.sep).join("/");
          const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
          if (inside) {
            const mine = (owned === null || owned.some((r) => r.test(rel))) && !excluded.some((r) => r.test(rel));
            if (!mine) { process.stdout.write("DENY\t" + field(tool) + "\tforeign_file"); return; }
          }
        }
      }
```
Move the `const field = …` definition above this block (it is used here and later). Update the schema comment at lines 10-18 with the `ownership` field.

`writePermissionsFile`: add the optional `ownership` input and write `...(input.ownership === undefined ? {} : { ownership: input.ownership })` into the body. Add a unit test that the field is written when given and absent otherwise.

- [ ] **Step 4: Run** the four test files + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(gate): a package run is denied a write to a file another worker owns`.

---

### Task 3: Every package run is given its ownership

**Files:**
- Create: `apps/orchestrator/src/ownership.ts`
- Modify: `apps/orchestrator/src/tick.ts` (`startRun`, the `writePermissionsFile` call ~898-908)
- Modify: `apps/orchestrator/src/resume.ts` (`executeResume`, the include ~61 and the call ~98-108)
- Test: `apps/orchestrator/test/integration/ownership.test.ts`

**Interfaces:**
- Consumes: `ownershipRuleFor`, `ownershipPatterns`, `OwnershipRule` (Task 1); `writePermissionsFile(..., { ownership })` (Task 2).
- Produces:
  - `export async function ownershipRuleForTask(taskId: string): Promise<OwnershipRule | null>` — `null` for a non-package task, a missing package, or `**`.
  - `export interface PermissionOwnership { readonly worktreeRoot: string; readonly owned: readonly string[] | null; readonly excluded: readonly string[] }`
  - `export async function permissionOwnership(taskId: string, worktreeRoot: string): Promise<PermissionOwnership | undefined>` — `undefined` when not governed.

- [ ] **Step 1: Failing integration tests** (`ownership.test.ts`; seed a workspace, a goal version with packages `report` (`src/report/**`), `config` (`src/config.py`) and an integration package, and one task per package, like `apps/orchestrator/test/integration/conductor.test.ts` does — read its seed):
  - `ownershipRuleForTask(reportTask)` → `{ owned: ['src/report/**'], excluded: [] }`; for the integration task → `{ owned: null, excluded: ['src/report/**', 'src/config.py'] }` (order of packages by key or creation — assert as a set); for a plain task → `null`; for a `main` package owning `**` → `null`.
  - `permissionOwnership(reportTask, '/w')` → `{ worktreeRoot: '/w', owned: [<regex sources>], excluded: [] }`.
  - A dispatched package run's `permissions.json` carries `ownership` with its worktree path, and a plain task's does not: drive one tick with the fake CLI (copy `run-report.test.ts`'s deps with `--fixture m8-flow`), read the file under the run directory (`permissionsFilePathFor(runDir)` — find how the run dir is derived from the run id; `grep -n "runDirFor\|permissionsFilePathFor" apps/orchestrator/src/tick.ts`).
  - Resume: after pausing and resuming a package run (copy the resume setup from an existing resume integration test: `grep -rln "executeResume" apps/orchestrator/test`), the rewritten file still carries `ownership`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** `apps/orchestrator/src/ownership.ts`:
```ts
/**
 * The ownership rule of a package task (conductor spec R4): its package among its goal version's
 * packages. Read by both enforcers -- the permission gate (through the run's permissions file)
 * and the diff audit -- so the two can never judge the same path differently.
 */
export async function ownershipRuleForTask(taskId: string): Promise<OwnershipRule | null> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { workPackage: true } })
  const pkg = task?.workPackage ?? null
  if (pkg === null) return null
  const all = await prisma.workPackage.findMany({
    where: { workspaceId: pkg.workspaceId, goalVersion: pkg.goalVersion },
    orderBy: { key: 'asc' },
  })
  return ownershipRuleFor(pkg, all)
}

export interface PermissionOwnership {
  readonly worktreeRoot: string
  readonly owned: readonly string[] | null
  readonly excluded: readonly string[]
}

export async function permissionOwnership(taskId: string, worktreeRoot: string): Promise<PermissionOwnership | undefined> {
  const rule = await ownershipRuleForTask(taskId)
  return rule === null ? undefined : { worktreeRoot, ...ownershipPatterns(rule) }
}
```
Wire it: in `startRun` pass `ownership: await permissionOwnership(task.id, worktree.path)` to `writePermissionsFile`; in `executeResume` pass `ownership: run.taskId === null || run.worktreePath === null ? undefined : await permissionOwnership(run.taskId, run.worktreePath)` (select `worktreePath` if the include does not already). Review, planning and chat runs are not touched (no `write_repo`).

- [ ] **Step 4: Run** `ownership.test.ts`, `tick.test.ts`, the resume test file, `run-report.test.ts` (one at a time) + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(conductor): every package run carries its ownership into the permission gate`.

---

### Task 4: The run's diff is audited before verify

**Files:**
- Modify: `apps/orchestrator/src/ownership.ts` (`changedFiles`, `auditOwnership`)
- Modify: `apps/orchestrator/src/report.ts` (export the owned-task rejection so both use it) or move `rejectOwnedTask` to `apps/orchestrator/src/runs.ts`
- Modify: `apps/orchestrator/src/verify.ts` (`verifyConcludedRun`, between `commitUncommittedWork` and the `fileRunReport` block ~457)
- Create: `packages/db/prisma/migrations/20260928150000_ownership/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`, `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts` (event `task.ownership_violated`), any total `Record` over event types the build names (web activity cards, `LANE_BY_TYPE`, filters)
- Test: `apps/orchestrator/test/integration/ownership.test.ts` (new describe), `apps/orchestrator/test/integration/run-report.test.ts` (unchanged behaviour for owned changes)

**Interfaces:**
- Consumes: `ownershipRuleForTask` (Task 3), `isOwned` (Task 1), `gitIn(cwd, ...args)` (`@slave-of-ai/control`, `packages/control/src/git.ts:36`), Plan 2's `rejectOwnedTask(taskId, runId, reason)` and `failConcludedRun(run, workspaceId, detail)`.
- Produces:
  - `export async function changedFiles(repoPath: string, base: string, branch: string): Promise<readonly string[]>` — `git diff --name-only --no-renames -z base...branch`, split on NUL, empty entries dropped.
  - `export async function auditOwnership(run: { readonly id: string; readonly slaveId: string }, task: { readonly id: string; readonly workspaceId: string; readonly branch: string }, workspace: { readonly repoPath: string; readonly baseBranch: string }): Promise<boolean>` — true when verify may go on.
  - Event `task.ownership_violated { runId: string, files: string[] /* at most 50 */, total: int }`; DB value `task_ownership_violated`.
  - `export const FOREIGN_FILES_LISTED = 20` (in the reason) and the event cap 50, in `ownership.ts`.

- [ ] **Step 1: Migration** `20260928150000_ownership/migration.sql` (WHY header, purely additive):
```sql
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'task.ownership_violated';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'foreign_file';
```
(Check the dotted spelling against `20260928090000_conductor_core`'s EventType lines.) Schema: `task_ownership_violated @map("task.ownership_violated")` in `enum EventType`; `foreign_file` in `enum SupervisorSituationKind` with a comment (Task 5 adds it to the domain). Event zod variant + `enums.ts` mapping + whatever total records the build names. Because the Prisma enum gains `foreign_file` here, ALSO add `'foreign_file'` to `SITUATION_KINDS` and `SITUATION_LABEL` (`'Changed files another worker owns'`) in this task, so enum parity and typecheck stay green (Task 5 wires observe/candidates). `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 2: Failing tests** (in `ownership.test.ts`, describe `the diff audit`):
  - `changedFiles` on a temp repo: base `main`, branch with commits that modify `a.txt`, add `b/c.txt`, delete `d.txt`, rename `e.txt` → `f.txt` → returns (as a set) `a.txt, b/c.txt, d.txt, e.txt, f.txt`; a file changed then reverted on the branch is not listed.
  - Through a real run (fake CLI `m8-flow`, whose work arm writes and commits a fixed file — read `packages/providers/test/fake-claude.mjs` around its work arm for the file name) with a package whose `ownedPaths` do NOT match that file: the task goes `rework`; `lastRejectionReason` starts with `revert changes to files you do not own: ` and names the file; a `task.rework` and a `task.ownership_violated` event exist; the run is `failed`; no `RunReport` row.
  - Same with `ownedPaths` matching the file (and a valid `--report-json-base64`): the task proceeds to review and a `RunReport` exists (the audit passed).
  - A `main` package owning `**`: no audit, proceeds.
  - `maxAttempts: 1`: the task ends `failed` with a `task.failed` event.

- [ ] **Step 3: Implement**
```ts
export const FOREIGN_FILES_LISTED = 20
const FOREIGN_FILES_RECORDED = 50

export async function changedFiles(repoPath: string, base: string, branch: string): Promise<readonly string[]> {
  const out = await gitIn(repoPath, 'diff', '--name-only', '--no-renames', '-z', `${base}...${branch}`)
  return out.split('\0').filter((name) => name !== '')
}

/**
 * The second enforcement of spec R4: a shell can write anywhere, so the files this task's branch
 * changed since it left the base branch are checked against its package's ownership before the run
 * is verified or its report filed (plan D7). Three-dot range: the NET change, so a rework that
 * reverted a foreign edit passes. A violation goes back through the same guarded rejection a
 * missing report uses, with every foreign file named up to FOREIGN_FILES_LISTED.
 */
export async function auditOwnership(
  run: { readonly id: string; readonly slaveId: string },
  task: { readonly id: string; readonly workspaceId: string; readonly branch: string },
  workspace: { readonly repoPath: string; readonly baseBranch: string },
): Promise<boolean> {
  const rule = await ownershipRuleForTask(task.id)
  if (rule === null) return true
  const foreign = (await changedFiles(workspace.repoPath, workspace.baseBranch, task.branch)).filter((path) => !isOwned(rule, path))
  if (foreign.length === 0) return true
  const listed = foreign.slice(0, FOREIGN_FILES_LISTED).join(', ')
  const more = foreign.length > FOREIGN_FILES_LISTED ? ` and ${foreign.length - FOREIGN_FILES_LISTED} more` : ''
  const reason = `revert changes to files you do not own: ${listed}${more}`
  const applied = await rejectRunBack(run, task, reason, `ownership: ${foreign.length} foreign file(s)`)
  if (applied) {
    await appendEvent({
      type: 'task.ownership_violated',
      workspaceId: task.workspaceId,
      taskId: task.id,
      runId: run.id,
      actor: 'system',
      payload: { runId: run.id, files: foreign.slice(0, FOREIGN_FILES_RECORDED), total: foreign.length },
    })
  }
  return false
}
```
`rejectRunBack(run, task, reason, failDetail): Promise<boolean>` is the shared rejection extracted below; it returns whether the rejection applied (the run still owned the task). It always fails the run.
Share Plan 2's rejection instead of copying it: read `apps/orchestrator/src/report.ts` (`rejectOwnedTask` and the `task.rework`/`task.failed` append and `failConcludedRun` after it) and extract ONE exported function `rejectRunBack(run: { readonly id: string; readonly slaveId: string }, task: { readonly id: string; readonly workspaceId: string }, reason: string, failDetail: string): Promise<boolean>` into `apps/orchestrator/src/runs.ts`, used by both `fileRunReport` and `auditOwnership`; `fileRunReport`'s behaviour and tests stay identical.
In `verifyConcludedRun`, before the `fileRunReport` block: `if (task.workPackageId !== null && !(await auditOwnership(run, { id: task.id, workspaceId: task.workspaceId, branch: task.branch }, task.workspace))) return` (`task.branch` is non-null there — the null check above guarantees it).

- [ ] **Step 4: Run** `ownership.test.ts`, `run-report.test.ts`, `verify` integration tests (one at a time) + typecheck → PASS.

- [ ] **Step 5: Commit** — `feat(conductor): a package run's diff is audited against its ownership before verify`.

---

### Task 5: The conductor is told after a second violation (`foreign_file`)

**Files:**
- Modify: `packages/domain/src/supervisor/world.ts` (task facts: `ownershipViolations: number`)
- Modify: `packages/control/src/supervisorWorld.ts` (load the count)
- Modify: `packages/domain/src/supervisor/observe.ts`, `packages/domain/src/supervisor/candidates.ts`
- Modify: `packages/domain/test/supervisor/fixtures.ts` (default 0)
- Modify: `scripts/gate-m56a-provider-contract.mjs` (situation count 21 → 22, event lane count +1 — keep the gate's "nothing else moved" intent: bump by exactly what this branch added)
- Test: `packages/domain/test/supervisor/observe.test.ts`, `packages/domain/test/supervisor/candidates.test.ts`, `packages/control/test/integration/supervisorWorld.test.ts`

**Interfaces:**
- Consumes: event `task.ownership_violated` (Task 4); `foreign_file` in `SITUATION_KINDS` (Task 4).
- Produces: `SupervisorTask.ownershipViolations: number` (violations of this task whose event is newer than the task's creation); situation `{ kind: 'foreign_file', subjectId: taskId, facts: { taskId, violations, workPackageId? } }` when `violations >= 2` and the task is not `done`/`failed`/`cancelled`; candidates `escalate_to_human` and `no_action` only.

- [ ] **Step 1: Failing tests**
  - observe: a task with `ownershipViolations: 2` in `rework` → one `foreign_file` situation, subject the task id, summary naming the task title and the count; with 1 → none; with 2 but `status: 'failed'` → none.
  - candidates: `foreign_file` → `[escalate_to_human, no_action]` (no `request_permission`, no staffing).
  - a world where a slave has 3 `run.tool_denied` events with capability `foreign_file` → NO `permission_blocked` (pin the existing filter).
  - supervisorWorld integration: two `task.ownership_violated` events on a task → the loaded task has `ownershipViolations: 2`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** — the loader counts `task_ownership_violated` events per task id for the tasks it already loads (one `groupBy` on `ExecutionEvent` by `taskId` where `type = 'task_ownership_violated'` and `taskId in (…)`); observe raises the situation (constant `FOREIGN_FILE_TRIP_COUNT = 2` in `supervisor/constants.ts`, WHY: spec R11 "after a second violation"); candidates branch returns the escalate/no_action pair with a comment (the remedy is a person or a re-conduct, not a grant). Bump m56a's pinned counts by exactly this branch's additions (situation kinds +1, event lanes +1) and say so in its comment.

- [ ] **Step 4: Run** the domain supervisor tests, `supervisorWorld.test.ts`, `enum-parity` + typecheck → PASS.

- [ ] **Step 5: Commit** — `feat(supervisor): a package that writes foreign files twice is put in front of a person`.

---

### Task 6: Whole suite, web build, gates

- [ ] **Step 1:** stop any daemon; no `next dev`. `npm run typecheck && npx vitest run` in the background with a log (~15 min); re-run any failing file alone before believing it.
- [ ] **Step 2:** `npm run web:build`, then `rm -rf apps/web/.next` (next-dev gates must not run against a production build).
- [ ] **Step 3:** `node scripts/gate-m26-vocabulary.mjs`.
- [ ] **Step 4:** migrate the gates DB (`DATABASE_URL="$GATE_DATABASE_URL" npm run db:migrate`), then run the CI gate list with the fake-CLI env exactly as ci.yml sets it and `DATABASE_URL="$GATE_DATABASE_URL"`; `CHROMIUM_PATH` in `.env` points at an uninstalled chromium — override it with the installed one (`ls ~/.cache/ms-playwright`). Known red on main: m44, m47, m48, m49, m50, m52, m54, m55 (4a), m57 (timing), m58 (7). Any other red gate is compared against the same gate on main (`/home/meren/projects/slave-of-ai`, unmodified) before it is called pre-existing.

---

## Self-review notes

- Spec coverage: R4 gate → Tasks 1–3; R4 audit → Task 4; `single` passes trivially → Task 1 (`null` rule) + Task 4 test; R11 `foreign_file` → Tasks 4 (enum) and 5.
- Order: 1 → 2 → 3 → 4 → 5 → 6.
- The worker could edit its own `permissions.json` (erratum E17, pre-existing): the gate is a first line; the diff audit is the enforcement that cannot be edited away.
