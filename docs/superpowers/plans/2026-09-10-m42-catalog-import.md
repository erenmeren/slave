# M42 External Catalog Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator points the product at a directory of worker personas on disk and imports them into the `SlaveTemplate` catalog — idempotently, re-runnably, never overwriting an operator's own edits — with an honest per-row report of what was created, updated, skipped and why; the imported persona then reaches a real run's prompt.

**Architecture:** One pure domain module parses and maps a persona (`packages/domain/src/catalog/persona.ts`, no disk, no Prisma); one control verb does the rows, one transaction per row, and writes one `CatalogImport` record (`packages/control/src/catalog.ts`); the CLI does the directory walk (`apps/orchestrator/src/catalog.ts`) and prints the report; the web shows provenance and the last ten import runs. The M41 residuals (spec R6 a–d) ride along as the first task.

**Tech Stack:** TypeScript monorepo, Prisma 7 + Postgres (:5433), zod, vitest, Next.js, plain-`node` `.mjs` gates, the fake provider `packages/providers/test/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-10-m42-catalog-import-design.md` (rulings R1–R6; §4 errata). Plan-time errata, every one read out of the code and baked into the tasks below:

- **E1 — the template catalog is not on Settings.** `apps/web/src/app/settings/page.tsx` renders `SettingsClient` (provider adapters, posture, reseed) and its own docstring says the org catalog "live[s] elsewhere now". `TemplateCatalog` is rendered by `apps/web/src/components/ProjectsClient.tsx:271`, inside the `data-testid="team-catalog"` section of the **projects home page** (`apps/web/src/app/page.tsx`, which is what calls `listTemplates()`). The `source` chip and the "Catalog imports" panel go there.
- **E2 — `locally_edited` needs a second column, `SlaveTemplate.profileSha256`.** `setProfile({ templateId })` (`packages/control/src/profile.ts`) writes the `profile` column and **nothing else** — no event, no hash, no timestamp — and its docblock says so deliberately. Re-derivation is impossible: the profile the import wrote is `"<prefix line carrying importedAt's date>\n\n<the OLD file's body>"`, and when `locally_edited` has to be decided the old body no longer exists anywhere. So: `profileSha256 String?`, the `goalSha256` of the exact text the import stored, and `locallyEdited = (t.profile === null ? null : goalSha256(t.profile)) !== t.profileSha256` — which also catches an operator who *cleared* the profile.
- **E3 — `PROFILE_MAX_CHARS` is measured on the COMPOSED profile, not on the body.** `apps/orchestrator/src/runContext.ts:558` throws `profile_too_long` when `effectiveProfile(slave).text.length > PROFILE_MAX_CHARS` — the STORED text, prefix line included. A 15 990-character body would import cleanly and make every worker materialised from that template undispatchable. The cap is measured on `(prefix + '\n\n' + body).trim()` and the skip reports that composed length.
- **E4 — `CatalogImport.principal` is the wrong column.** A `Principal` here is `{ userId: string }` (`packages/control/src/principal.ts`) and the CLI never has one — `cli.ts` says so at three call sites. The column is `by String?`, the operator's NAME from `--by`, exactly `setProfile(target, profile, actor)`'s idiom; the verb's trailing parameter is `by?: string`.
- **E5 — naming the source catalog in a checked-in file fails `gate:m26-vocabulary`.** The gate greps the tracked tree for `(^|[^a-z])agent`; the reference catalog's directory name contains `-agents`, which matches. `docs/superpowers/` is excluded, so the spec and this plan may name it — no product string may: not a comment, not the README, not the gate, not a test, not a default flag value. `--catalog` therefore has **no literal default in the source**; it defaults to `basename(dir)` at runtime, so the real catalog's name only ever exists in the database.
- **E6 — R6(a) is a NEW arm.** `reconcileOrphans` and `concludeDeadRun` already release per kind (M41 Task 3b), but only when THIS pass concludes the run. A task whose `activeRunId` names an **already terminal** run — what a process killed between the pump's terminal write and its chained `verifyConcludedRun` leaves behind — is reached by nothing. `reconcileStrandedClaims` is guarded three ways: `livePumpRunIds` (`activePumpRunIds.delete` runs in the pump chain's `.finally()`, i.e. AFTER `verifyConcludedRun`, so a run still in the set still owns its task — `tick.ts:755`, `review.ts:532`, `planning.ts:432`), a `STRANDED_CLAIM_GRACE_MS = 30_000` floor on `terminalAt` (another process's one-shot `tick` has an in-flight window this set cannot see), and a `status`-guarded write. Terminal run statuses are `stopped | succeeded | failed`.
- **E7 — R6(b) needs a discriminator AND the review budget.** All four parks null `activeRunId` in the same write, so the blocking run is found as the task's most recent `SlaveRun` by `startedAt desc`. But `dispatchReview` counts review runs since the latest implementation run and re-parks the task the moment that count reaches `REVIEW_RETRY_CAP` — so unblocking a cap-parked task to `reviewing` is an unblock that undoes itself on the next tick, the exact failure `unblockTask`'s docblock argues against for `ready`. `reviewing` is chosen only when `reviewAttempts < REVIEW_RETRY_CAP`; otherwise `rework`, because a fresh implementation run is the only thing that resets that count. `REVIEW_RETRY_CAP` moves to `packages/domain/src/review/cap.ts` (control may not import an app). The attempt ceiling is not checked on the `reviewing` path — no implementation attempt is spent.
- **E8 — R6(c) is a test, not a code change.** `cancelTask` (`packages/control/src/task.ts:113-128`) already checks `activeRunId` BEFORE `status`, so a `reviewing` task holding M41's claim already refuses `task_run_active`. The residual is the test that pins the ORDER.
- **E9 — R6(d) is a schema declaration only.** `answerQuestion` already writes `answeredBy` into the `slave.message_sent` payload (`messaging.ts:480`); the zod object is non-strict, so the field is silently stripped on read.
- **E10 — `--role-map` cannot change an existing row's role.** `SlaveTemplate` is append-only apart from `profile` (Decision 9) and `role` is copied into `Slave.runtimeRoles` at materialisation (`org.ts:466`), so a rewrite would not reach any worker already materialised. An `updated` row writes `profile`, `description`, `sourceSha256`, `profileSha256`, `importedAt` and never `name` or `role`; a mapped role that differs is reported as `roleDrift` and printed, not written.
- **E11 — the CLI's boolean flags go LAST.** `parseArgs` (`cli.ts:363-394`) takes whatever follows as a flag's value, even another `--flag`: `--dry-run --by me` sets `dry-run='--by'` and DROPS `--by`. `'dry-run' in flags` (the repo's `'yes' in flags` idiom) still reads correctly, so `parseArgs` is untouched — but every USAGE line, test and gate invocation writes `--dry-run` last.
- **E12 — the roster CLI verbs are `add-team` / `add-slave`**, not `add-company-team`/`add-company-slave` (`cli.ts:1010`, `:1019`).
- **E13 — the parser may not import `node:crypto` or `node:fs`.** `packages/domain` reaches `apps/web`'s CLIENT bundle, which is why `goalSha256` is hand-rolled (its docblock records that a `node:crypto` import anywhere in that graph fails `npm run web:build`).
- **E14 — the seed's TRUNCATE list must gain `"CatalogImport"`** (`packages/db/src/seed.ts:43`), or a re-seed leaves import rows pointing at templates that no longer exist.
- **E15 — where the tests live.** `vitest.config.ts` has two projects: `unit` (`**/test/**` minus `test/integration`) and `integration` (`**/test/integration/**`, single-threaded, `require-database.ts`). Anything touching the database goes under `test/integration/`.
- **E16 — a new refusal kind has THREE homes:** the `ControlRefusal` union and `refusalText`'s switch (`packages/control/src/refusal.ts`), and `apps/web/test/refusal-status.test.ts`'s `ALL_KINDS`, which is a `Record<ControlRefusal['kind'], true>` — a missing kind is a typecheck failure.
- **E17 — what the gate can assert about the prompt.** The manifest's profile source is `{ kind: 'profile', origin, sha256 }` and carries no text; the persona's words are only in `RunContext.prompt`. Stage 5 asserts all three.
- **E18 — `divisions.json`'s shape** is `{ "_note": ..., "divisions": { "<dir>": { label, icon, color } } }`; the division set is `Object.keys(json.divisions)`.
- **E19 — `importCatalog` writes rows directly**, not through `createTemplate`, which has no provenance parameter. `parsePersona` covers the name validation and the role is non-empty by construction.
- **E20 — `personaToTemplate`'s options bag is under-specified.** `{ catalog, division, roleMap }` cannot produce `sourceId` (needs the slug), `sourceSha256` (needs the raw text) or the prefix line (needs the date). The bag is `{ catalog, division, slug, text, importedAt, roleMap? }` and the function returns a `Result`, because the cap check (E3) belongs in the pure function where the composed profile first exists.
- **E21 — the template table's grid must not gain a column.** `TemplateCatalog`'s `COLUMNS` is a fixed six-track grid and `gate:m14-fidelity` screenshots this surface; the `source` chip renders INSIDE the existing Name cell.

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`.
- One vitest process at a time (the shared test database truncates), and never a gate beside vitest.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```
- The vocabulary word is **slave**. `npm run gate:m26-vocabulary` after every task.
- `npm run web:build` never while `next dev` is running.
- Refusals are `ok()/err()`; **a refusal after a write inside `$transaction` must throw**, or the transaction commits the write anyway (ADR; `AssignmentRefused` in `packages/control/src/org.ts` is the idiom).
- The implementer never dispatches subagents.
- Migrations are applied to **both** databases — `npm run db:migrate` (dev) and `npm run db:migrate:test` (`scripts/migrate-test.mjs`, which deploys against `TEST_DATABASE_URL`) — and `npx prisma migrate diff --from-schema-datasource packages/db/prisma/schema.prisma --to-schema-datamodel packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` prints "No difference detected".

---

## File structure

```
packages/domain/src/review/cap.ts                     R6(b)/E7: REVIEW_RETRY_CAP, moved out of the app (new)
packages/domain/src/catalog/{persona,index}.ts        R1/§2: parsePersona, personaToTemplate (new, pure)
packages/domain/src/events/schema.ts                  R6(d): slave.message_sent.answeredBy; task.unblocked.status
packages/domain/src/index.ts                          + ./catalog/index.js, ./review/cap.js
packages/domain/test/catalog/persona.test.ts          the parser/mapper unit tests (new)
packages/domain/test/events/schema.test.ts            + the two payload cases

apps/orchestrator/src/sweep.ts                        R6(a)/E6: reconcileStrandedClaims + SweepReport.strandedClaims
apps/orchestrator/src/daemon.ts                       the sweep log line
apps/orchestrator/src/review.ts                       imports REVIEW_RETRY_CAP from the domain
apps/orchestrator/test/integration/sweep.test.ts      a stranded claim per kind, and the three guards

packages/control/src/unblock.ts                       R6(b)/E7: reviewing vs rework
packages/control/test/integration/unblock.test.ts     the two destinations and the cap
packages/control/test/integration/task.test.ts        R6(c)/E8: the check ORDER

packages/db/prisma/schema.prisma + migrations/20260910140000_m42_catalog_import
                                                      R1/R5/E2: four provenance columns + profileSha256; CatalogImport
packages/db/src/seed.ts                               E14: "CatalogImport" in the TRUNCATE list

packages/control/src/catalog.ts                       importCatalog, listCatalogImports (new)
packages/control/src/{refusal,index}.ts               catalog_empty, invalid_role_map
packages/control/test/integration/catalog.test.ts     every policy branch (new)
apps/web/test/refusal-status.test.ts                  E16: the two new kinds

apps/orchestrator/src/catalog.ts                      readCatalogDirectory (new)
apps/orchestrator/src/cli.ts                          import-catalog, list-imports, USAGE
apps/orchestrator/test/catalog.test.ts                the walk, on a temp directory (new)
apps/orchestrator/test/integration/cli.test.ts        the two verbs end to end

apps/web/src/server/org.ts                            listTemplates provenance; listCatalogImports
apps/web/src/app/api/org/catalog-imports/route.ts     GET (new)
apps/web/src/components/CatalogImports.tsx            the read-only list (new)
apps/web/src/components/TemplateCatalog.tsx           TemplateRow provenance + the source chip
apps/web/src/components/ProjectsClient.tsx            the second panel in team-catalog
apps/web/src/app/page.tsx                             loads the imports
apps/web/test/{projects-page.test.tsx,integration/{org-routes,server-org}.test.ts}

scripts/fixtures/catalog-m42/**                       the checked-in fixture catalog (new)
scripts/gate-m42-catalog-import.mjs                   the gate, six stages (new)
package.json, .github/workflows/ci.yml, README.md     gate:m42-catalog-import; roster 17 -> 18
```

---

### Task 1: The M41 residuals (spec R6 a–d)

**Files:**
- Create: `packages/domain/src/review/cap.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/events/schema.ts`
- Modify: `apps/orchestrator/src/sweep.ts`, `apps/orchestrator/src/daemon.ts:197-200`, `apps/orchestrator/src/review.ts:26`
- Modify: `packages/control/src/unblock.ts`
- Test: `apps/orchestrator/test/integration/sweep.test.ts`, `packages/control/test/integration/unblock.test.ts`, `packages/control/test/integration/task.test.ts`, `packages/domain/test/events/schema.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (later tasks rely on none of it; this task is reviewable alone):
```ts
// packages/domain/src/review/cap.ts
export const REVIEW_RETRY_CAP = 2
// apps/orchestrator/src/sweep.ts
export const STRANDED_CLAIM_GRACE_MS = 30_000
export interface SweepReport { readonly timedOut: readonly RunId[]; readonly overToolCap: readonly RunId[]; readonly deadPids: readonly RunId[]; readonly strandedClaims: readonly string[] }
export async function reconcileStrandedClaims(deps: SweepDeps): Promise<readonly string[]>  // released task ids
// packages/control/src/unblock.ts
export async function unblockTask(taskId: string, input?: UnblockTaskInput, principal?: Principal): Promise<Result<{ readonly status: 'rework' | 'reviewing' }, ControlRefusal>>
```

- [ ] **Step 1: Write the failing sweep tests**

Append to `apps/orchestrator/test/integration/sweep.test.ts`, inside the existing
`describe('sweep and reconcileOrphans')` block (its `givenRun`, `seed`, `deps` and `fixture`
helpers are already in scope). Two edits to the existing helpers first: widen `givenRun`'s `status`
union with `| 'failed'` (it lists every other status already and these cases need a failed review
run), and reuse the module-level `hoursAgo` helper that is already in the file. `givenRun` defaults
`pid` to `DEAD_PID`; `sweep()` skips a null pid before anything else and concludes a dead one, which
is why every run below carries a live-looking `process.pid` — this arm is about the RUN's status,
not its process.

```ts
  it('releases a task whose activeRunId names a terminal implementation run: rework, no attempt charged', async (): Promise<void> => {
    // The strand this arm exists for: `pumpRun` wrote the run terminal and the process died before
    // its chained `verifyConcludedRun` could release the task. Nothing else in the milestone looks
    // at a task whose claim points at a run that is already over.
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id, attempt: 1 } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([fixture.taskId])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('rework')
    expect(task.activeRunId).toBeNull()
    // A daemon that died is not the slave failing -- `reconcileOrphans`' own rule.
    expect(task.attempt).toBe(1)
    expect(await eventTypesFor(fixture.workspaceId)).toEqual(['task.rework'])
  })

  it('releases only the CLAIM of a task whose activeRunId names a terminal review run, leaving it reviewing', async (): Promise<void> => {
    const run = await givenRun({ status: 'failed', pid: process.pid, kind: 'review' })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'reviewing', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([fixture.taskId])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.activeRunId).toBeNull()
    // `rework` would be a lie about where the task went AND an implementation attempt spent on work
    // nobody judged wrong, so no `task.rework` is announced for this kind (sweep.ts's own rule).
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })

  it('leaves a stranded claim alone while a pump in this process still owns the run', async (): Promise<void> => {
    // `activePumpRunIds.delete(runId)` runs in the pump chain's `.finally()`, AFTER
    // `verifyConcludedRun` -- so a run still in the set has not finished releasing its task.
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id } })

    const report = await sweep({ ...deps, livePumpRunIds: new Set([run.id]) })

    expect(report.strandedClaims).toEqual([])
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).activeRunId).toBe(run.id)
  })

  it('leaves a claim alone until the run has been terminal for the grace period', async (): Promise<void> => {
    // A one-shot `tick` in ANOTHER process has an in-flight window this process's set cannot see.
    const run = await givenRun({ status: 'succeeded', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: new Date(), endedAt: new Date() } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'running', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([])
    expect((await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).activeRunId).toBe(run.id)
  })

  it('unclaims but does not rework a task that has already moved off running', async (): Promise<void> => {
    const run = await givenRun({ status: 'failed', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { terminalAt: hoursAgo(1), endedAt: hoursAgo(1) } })
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'blocked', activeRunId: run.id } })

    const report = await sweep(deps)

    expect(report.strandedClaims).toEqual([fixture.taskId])
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    expect(task.status).toBe('blocked')
    expect(task.activeRunId).toBeNull()
    expect(await eventTypesFor(fixture.workspaceId)).toEqual([])
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/orchestrator/test/integration/sweep.test.ts -t 'stranded'`
Expected: FAIL — `report.strandedClaims` is `undefined` (the field does not exist yet).

- [ ] **Step 3: Add the arm to `sweep.ts`**

In `apps/orchestrator/src/sweep.ts`, extend the report interface:

```ts
export interface SweepReport {
  readonly timedOut: readonly RunId[]
  readonly overToolCap: readonly RunId[]
  readonly deadPids: readonly RunId[]
  /** Task ids whose `activeRunId` pointed at a run that was already over (M42 t1, spec R6a). */
  readonly strandedClaims: readonly string[]
}
```

Add the terminal-status list and the grace constant next to `SWEEPABLE`:

```ts
/** The mirror of {@link NON_TERMINAL_RUN_STATUSES}: a run in one of these will never be concluded
 *  again, so a task still pointing at one is pointing at nothing. */
const TERMINAL: readonly RunStatus[] = ['stopped', 'succeeded', 'failed']

/**
 * How long a run must have been terminal before its task's claim is treated as stranded (M42 t1).
 *
 * `livePumpRunIds` closes the window inside THIS process exactly -- `activePumpRunIds.delete` runs
 * in the pump chain's `.finally()`, after `verifyConcludedRun`, so a run in the set still owns its
 * task. It says nothing about another process: the CLI's one-shot `tick` can run against a live
 * daemon (`startRun`'s own reasoning for claiming in the database rather than in memory), and its
 * conclusion has the same millisecond-wide gap between the run's terminal write and the task's
 * release. Thirty seconds is far past that gap and far short of anything an operator would notice,
 * and it makes this arm unable to race a conclusion rather than merely unlikely to.
 */
export const STRANDED_CLAIM_GRACE_MS = 30_000
```

Add the function, just above `sweep`:

```ts
/**
 * Releases a task whose `activeRunId` names a run that is ALREADY terminal (spec R6a).
 *
 * The gap this closes is not the one `reconcileOrphans` and `concludeDeadRun` close. Both of those
 * release the task in the same pass that concludes the run; neither can reach a task whose run was
 * concluded by somebody else and whose release never happened -- a process killed between
 * `pumpRun`'s terminal write and its chained `verifyConcludedRun`, or a `verifyConcludedRun` that
 * threw. A task like that is busy forever: `decide()` never schedules it, `dispatchReview` will not
 * claim it, and `unblockTask`/`cancelTask`/`failTask` all refuse it with `task_run_active`.
 *
 * What "released" means is the kind's, exactly as the other two arms have it: an `implementation`
 * run's task goes back to `rework` and a `review` run's task gets only its claim back and stays in
 * `reviewing` -- a review nobody concluded is not the reviewer rejecting the work, and `rework`
 * would spend an implementation attempt re-doing work nobody judged wrong. No attempt is counted
 * either way.
 *
 * Three guards, and each one is load-bearing:
 *   1. `livePumpRunIds` -- a conclusion in flight in THIS process still owns its task.
 *   2. {@link STRANDED_CLAIM_GRACE_MS} -- a conclusion in flight in ANOTHER process does too, and
 *      this process cannot see its pump set.
 *   3. the `status` in the `updateMany` `where` -- a task that has legitimately moved on since the
 *      read (a cancel, an operator's park) loses only the stale claim, never its status.
 *
 * No `guardrail.tripped` (spec R6a): nothing was cancelled and no ceiling was crossed. A `task.rework`
 * is announced for the implementation kind alone, mirroring `reconcileOrphans`, because §13 says no
 * failure is silent -- and announcing one for a review would be a lie about where the task went.
 */
export async function reconcileStrandedClaims(deps: SweepDeps): Promise<readonly string[]> {
  const claimed = await db.task.findMany({
    where: { workspaceId: deps.workspaceId, activeRunId: { not: null } },
    select: { id: true, status: true, activeRunId: true, attempt: true },
  })
  if (claimed.length === 0) return []

  const runs = await db.slaveRun.findMany({
    where: {
      id: { in: claimed.map((task) => task.activeRunId as string) },
      status: { in: [...TERMINAL] },
      terminalAt: { lt: new Date(Date.now() - STRANDED_CLAIM_GRACE_MS) },
    },
    select: { id: true, kind: true, status: true, terminalAt: true },
  })
  const strandedBy = new Map(runs.map((run) => [run.id, run] as const))

  const released: string[] = []
  for (const task of claimed) {
    const run = strandedBy.get(task.activeRunId as string)
    if (run === undefined) continue
    if (deps.livePumpRunIds?.has(run.id) === true) continue

    const toRework = run.kind !== 'review' && task.status === 'running'
    const write = await db.task.updateMany({
      where: { id: task.id, activeRunId: run.id, ...(toRework ? { status: 'running' as const } : {}) },
      data: toRework ? { status: 'rework', activeRunId: null } : { activeRunId: null },
    })
    if (write.count === 0) continue
    released.push(task.id)
    console.warn(
      `[sweep] released task ${task.id}: its claim named run ${run.id} (${run.kind}), which has been ` +
        `${run.status} since ${run.terminalAt?.toISOString() ?? 'an unrecorded time'} -- ` +
        `${toRework ? 'back to rework, no attempt charged' : 'the claim only'}`,
    )
    if (!toRework) continue
    await appendEvent({
      type: 'task.rework',
      workspaceId: deps.workspaceId,
      taskId: task.id,
      actor: 'system',
      payload: {
        reason: 'the run holding this task was already over and never released it',
        // The number of the attempt that was interrupted: the counter records COMPLETED attempts
        // and this pass deliberately does not increment it, but the run that stranded it had started.
        attempt: task.attempt + 1,
      },
    })
  }
  return released
}
```

And call it from `sweep()`. Replace the final `return { timedOut, overToolCap, deadPids }` with:

```ts
  // After the dead-pid arm, deliberately: that arm concludes runs and releases their tasks itself,
  // and running this first would look at claims it is about to make current.
  const strandedClaims = await reconcileStrandedClaims(deps)

  return { timedOut, overToolCap, deadPids, strandedClaims }
}
```

- [ ] **Step 4: Widen the daemon's sweep log line**

In `apps/orchestrator/src/daemon.ts:198`, replace

```ts
      if (swept.timedOut.length > 0 || swept.overToolCap.length > 0 || swept.deadPids.length > 0) {
```

with

```ts
      if (
        swept.timedOut.length > 0 ||
        swept.overToolCap.length > 0 ||
        swept.deadPids.length > 0 ||
        swept.strandedClaims.length > 0
      ) {
```

- [ ] **Step 5: Run the sweep tests**

Run: `npx vitest run apps/orchestrator/test/integration/sweep.test.ts`
Expected: PASS, the pre-existing cases included.

- [ ] **Step 6: Move `REVIEW_RETRY_CAP` into the domain**

Create `packages/domain/src/review/cap.ts`:

```ts
/**
 * How many review runs one implementation may spend before the task is parked for a human (M35).
 *
 * In the domain rather than beside its enforcement point, because since M42 t1 there are two and
 * they are in different packages: `apps/orchestrator`'s `dispatchReview` parks the task when this
 * many review runs since the latest implementation run have produced no usable verdict, and
 * `packages/control`'s `unblockTask` reads it to decide whether returning that task to `reviewing`
 * would accomplish anything -- a control package may not import an application, and two copies of
 * the number would make an unblock that undoes itself possible again.
 */
export const REVIEW_RETRY_CAP = 2
```

In `packages/domain/src/index.ts`, beside the other `export *` lines:

```ts
export * from './review/cap.js'
```

In `apps/orchestrator/src/review.ts`, delete line 26 (`const REVIEW_RETRY_CAP = 2`) and add
`REVIEW_RETRY_CAP` to the existing `@slave-of-ai/domain` import list at the top of the file.

- [ ] **Step 7: Write the failing unblock and cancel tests**

Append to `packages/control/test/integration/unblock.test.ts` (its own `seed`/`beforeEach` helpers
are already there; create the runs with `prisma` directly as the file's existing cases do):

```ts
  it('returns a task blocked under review to reviewing, not rework, and charges no attempt', async (): Promise<void> => {
    // `rework` would spend an implementation attempt re-doing work nobody has judged wrong -- the
    // same argument `sweep.ts` makes for a review run's own release (M41 t3b).
    const { workspaceId, taskId, slaveId } = await seed()
    await prisma.slaveRun.create({ data: { taskId, slaveId, kind: 'implementation', status: 'succeeded', startedAt: new Date(Date.now() - 60_000) } })
    await prisma.slaveRun.create({ data: { taskId, slaveId, kind: 'review', status: 'failed', startedAt: new Date() } })
    await prisma.task.update({ where: { id: taskId }, data: { status: 'blocked', activeRunId: null, attempt: 1 } })

    const result = await unblockTask(taskId)

    expect(result).toEqual({ ok: true, value: { status: 'reviewing' } })
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.status).toBe('reviewing')
    expect(task.attempt).toBe(1)
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId, taskId }, orderBy: { seq: 'desc' } })
    expect((event.payload as { status?: string }).status).toBe('reviewing')
  })

  it('sends a task whose review budget is spent to rework instead: reviewing would re-park it on the next tick', async (): Promise<void> => {
    // `dispatchReview` counts review runs since the LATEST implementation run and parks the task
    // again the moment that count reaches REVIEW_RETRY_CAP. A fresh implementation run is the only
    // thing that resets it, so `rework` is the only unblock that actually moves.
    const { taskId, slaveId } = await seed()
    const impl = new Date(Date.now() - 60_000)
    await prisma.slaveRun.create({ data: { taskId, slaveId, kind: 'implementation', status: 'succeeded', startedAt: impl } })
    for (let i = 0; i < REVIEW_RETRY_CAP; i += 1) {
      await prisma.slaveRun.create({ data: { taskId, slaveId, kind: 'review', status: 'failed', startedAt: new Date(impl.getTime() + 1_000 * (i + 1)) } })
    }
    await prisma.task.update({ where: { id: taskId }, data: { status: 'blocked', activeRunId: null } })

    const result = await unblockTask(taskId)

    expect(result).toEqual({ ok: true, value: { status: 'rework' } })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')
  })

  it('still sends a task blocked under an implementation run to rework', async (): Promise<void> => {
    const { taskId, slaveId } = await seed()
    await prisma.slaveRun.create({ data: { taskId, slaveId, kind: 'implementation', status: 'failed', startedAt: new Date() } })
    await prisma.task.update({ where: { id: taskId }, data: { status: 'blocked', activeRunId: null } })

    const result = await unblockTask(taskId)

    expect(result).toEqual({ ok: true, value: { status: 'rework' } })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('rework')
  })

  it('does not check the attempt ceiling on the reviewing path: no implementation attempt is spent', async (): Promise<void> => {
    const { taskId, slaveId } = await seed()
    await prisma.slaveRun.create({ data: { taskId, slaveId, kind: 'implementation', status: 'succeeded', startedAt: new Date(Date.now() - 60_000) } })
    await prisma.slaveRun.create({ data: { taskId, slaveId, kind: 'review', status: 'failed', startedAt: new Date() } })
    await prisma.task.update({ where: { id: taskId }, data: { status: 'blocked', activeRunId: null, attempt: 5, maxAttempts: 5 } })

    const result = await unblockTask(taskId)

    expect(result).toEqual({ ok: true, value: { status: 'reviewing' } })
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    expect(task.maxAttempts).toBe(5)
    expect(task.attempt).toBe(5)
  })
```

Add `REVIEW_RETRY_CAP` to the file's `@slave-of-ai/domain` import.

Append to `packages/control/test/integration/task.test.ts`, in the `cancelTask` describe:

```ts
  it('refuses a reviewing task holding a review claim with task_run_active, not task_not_cancellable', async (): Promise<void> => {
    // The ORDER is the assertion (M41 t3b + M42 R6c). A review run holds `Task.activeRunId` from
    // dispatch now, so both checks match this row -- and the honest answer is the one that names
    // the run still in flight, not the one that talks about the status.
    const { taskId, slaveId } = await seed()
    const run = await prisma.slaveRun.create({ data: { taskId, slaveId, kind: 'review', status: 'working' } })
    await prisma.task.update({ where: { id: taskId }, data: { status: 'reviewing', activeRunId: run.id } })

    const result = await cancelTask(taskId, 'no longer wanted')

    expect(result).toEqual({ ok: false, error: { kind: 'task_run_active', taskId, runId: run.id } })
    expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('reviewing')
  })
```

- [ ] **Step 8: Run them to verify they fail**

Run: `npx vitest run packages/control/test/integration/unblock.test.ts packages/control/test/integration/task.test.ts`
Expected: the four unblock cases FAIL (`unblockTask` returns `{ ok: true, value: undefined }` and
writes `rework`); the `cancelTask` case PASSES already — that one pins existing behaviour (E8) and
must be green from the start.

- [ ] **Step 9: Teach `unblockTask` the two destinations**

In `packages/control/src/unblock.ts`, add to the imports:

```ts
import { REVIEW_RETRY_CAP, type Result, err, ok } from '@slave-of-ai/domain'
```

Replace the body from the `atCeiling` line down to the `appendEvent` call with:

```ts
  // Which run parked this task, and therefore where it belongs. All four parks null `activeRunId`
  // in the same write that sets `blocked`, so the blocking run is not on the row any more -- the
  // task's most recent run is. A `review` kind means the task was in `reviewing` when it was
  // parked (the review retry cap, or an operator cancelling a review run through `stop.ts`).
  const latestRun = await prisma.slaveRun.findFirst({
    where: { taskId },
    orderBy: { startedAt: 'desc' },
    select: { kind: true, startedAt: true },
  })

  // ... and whether sending it back there would accomplish anything. `dispatchReview` counts review
  // runs since the latest IMPLEMENTATION run and parks the task `blocked` again the moment that
  // count reaches REVIEW_RETRY_CAP -- so unblocking a cap-spent task to `reviewing` is an unblock
  // that undoes itself on the very next tick, which is exactly the invert-in-one-tick failure this
  // function's own doc comment refuses for `ready`. A fresh implementation run is the only thing
  // that resets that count, and `rework` is how one is started.
  const reviewBudgetSpent = async (): Promise<boolean> => {
    const latestImpl = await prisma.slaveRun.findFirst({
      where: { taskId, kind: 'implementation' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (latestImpl === null) return true
    const attempts = await prisma.slaveRun.count({
      where: { taskId, kind: 'review', startedAt: { gt: latestImpl.startedAt } },
    })
    return attempts >= REVIEW_RETRY_CAP
  }

  const status: 'rework' | 'reviewing' =
    latestRun?.kind === 'review' && !(await reviewBudgetSpent()) ? 'reviewing' : 'rework'

  // The ceiling governs IMPLEMENTATION attempts, and the `reviewing` path spends none: the next run
  // this task gets is a review run, bounded by REVIEW_RETRY_CAP rather than by `maxAttempts`.
  // Checking it there would refuse an unblock that could not have burnt the attempt it is refusing
  // to allow.
  const atCeiling = status === 'rework' && task.attempt >= task.maxAttempts
  if (atCeiling && input.allowAnotherAttempt !== true) {
    return err({ kind: 'attempt_ceiling_reached', taskId, attempt: task.attempt, maxAttempts: task.maxAttempts })
  }
  const maxAttempts = atCeiling ? task.attempt + 1 : task.maxAttempts

  const claimed = await prisma.task.updateMany({
    where: { id: taskId, status: 'blocked', activeRunId: null },
    data: { status, maxAttempts },
  })
  if (claimed.count === 0) {
    const now = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    if (now.activeRunId !== null) return err({ kind: 'task_run_active', taskId, runId: now.activeRunId })
    return err({ kind: 'task_not_blocked', taskId, status: now.status })
  }

  await appendEvent({
    type: 'task.unblocked',
    workspaceId: task.workspaceId,
    taskId,
    actor: input.origin ?? 'human',
    payload: { attempt: task.attempt, maxAttempts, status },
    userId: principal?.userId ?? null,
  })
  return ok({ status })
}
```

and change the signature's return type to
`Promise<Result<{ readonly status: 'rework' | 'reviewing' }, ControlRefusal>>`.

Add one paragraph to the function's doc comment, immediately after the "Moves the task to `rework`,
never `ready`" paragraph:

```
 * Since M42 t1 (spec R6b) there is a second destination, and only one. A task parked while it was
 * being REVIEWED goes back to `reviewing`: a review run holds no implementation attempt, and
 * `rework` would spend one re-doing work nobody has judged wrong -- the same argument `sweep.ts`
 * makes for a review run's own release. It goes back to `reviewing` only while a review can still
 * run, though: `dispatchReview`'s `REVIEW_RETRY_CAP` counts review runs since the latest
 * implementation run, so a task whose review budget is spent would be re-parked `blocked` on the
 * next tick, and for that task `rework` -- a fresh implementation run, which is what resets that
 * count -- is the only unblock that moves anything.
```

- [ ] **Step 10: Declare the two event payload fields**

In `packages/domain/src/events/schema.ts`, inside `slave.message_sent`'s payload object, after
`expectsReply`:

```ts
      /** M42 t1 (spec R6d): WHO answered, by name -- the CLI's operator, or `supervisor`, which the
       *  envelope's closed three-way `Actor` has no member for. `answerQuestion`
       *  (`packages/control/src/messaging.ts`) has written this since M36 t3; the payload object is
       *  not strict, so an undeclared field was silently dropped on every read instead of failing
       *  anything. Optional, because a worker-authored message never carries one. */
      answeredBy: z.string().min(1).optional(),
```

In `task.unblocked`'s payload object, add:

```ts
      /** M42 t1 (spec R6b): where the task actually went -- `rework`, or `reviewing` for a task that
       *  was parked while it was under review. Optional on read: every row written before M42
       *  records the two counters and nothing else. */
      status: z.enum(['rework', 'reviewing']).optional(),
```

Append two cases to `packages/domain/test/events/schema.test.ts`, beside the existing round-trips:

```ts
  it('keeps answeredBy on a slave.message_sent payload', () => {
    const parsed = eventSchema.parse({
      type: 'slave.message_sent',
      workspaceId: 'w1',
      actor: 'human',
      payload: { body: 'the retry queue', messageId: 'm1', kind: 'answer', answeredBy: 'supervisor' },
    })
    expect((parsed.payload as { answeredBy?: string }).answeredBy).toBe('supervisor')
  })

  it('keeps status on a task.unblocked payload and still parses one without it', () => {
    const withStatus = eventSchema.parse({
      type: 'task.unblocked',
      workspaceId: 'w1',
      actor: 'human',
      payload: { attempt: 1, maxAttempts: 3, status: 'reviewing' },
    })
    expect((withStatus.payload as { status?: string }).status).toBe('reviewing')
    expect(() =>
      eventSchema.parse({ type: 'task.unblocked', workspaceId: 'w1', actor: 'human', payload: { attempt: 1, maxAttempts: 3 } }),
    ).not.toThrow()
  })
```

Use whatever the file's existing cases name the exported schema and the envelope fields; copy the
shape of the case directly above rather than the field list here if they differ.

- [ ] **Step 11: Run every touched test file**

Run, one at a time:
```bash
npx vitest run packages/domain/test/events/schema.test.ts
npx vitest run packages/control/test/integration/unblock.test.ts packages/control/test/integration/task.test.ts
npx vitest run apps/orchestrator/test/integration/sweep.test.ts
```
Expected: all PASS. Then `npx tsc --build` — `unblockTask`'s widened return type has callers in
`apps/orchestrator/src/cli.ts`, `packages/control/src/supervisor.ts`'s `carryOut` and the web's
unblock route; every one of them ignores the value, so this is a compile check, not a rewrite. If
the CLI's `unblock` case prints a fixed sentence, change it to name the destination:
`process.stdout.write(\`task ${taskId} unblocked to ${result.value.status}\n\`)`.

- [ ] **Step 12: The gate and the commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
git add packages/domain/src packages/domain/test packages/control/src/unblock.ts packages/control/test apps/orchestrator/src apps/orchestrator/test
git commit -m "$(cat <<'EOF'
fix(orchestrator,control,domain): m42 t1 — the M41 residuals: a stranded claim is released, an unblock under review goes back to reviewing, answeredBy is declared

A task whose activeRunId names a run that is ALREADY terminal was reached by nothing: both existing
release arms only release the task in the pass that concludes its run, so a process killed between
the pump's terminal write and its chained verify left the task busy forever. reconcileStrandedClaims
releases it per kind, guarded by the live pump set, a thirty-second grace on terminalAt and a
status-guarded write, so it cannot race a conclusion in this process or in another one.

unblockTask sends a task parked while it was under review back to reviewing rather than rework --
but only while a review can still run, because the review retry cap would otherwise re-park it on
the next tick. cancelTask's check order (task_run_active before task_not_cancellable) is pinned by a
test. slave.message_sent declares the answeredBy that answerQuestion has always written.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 2: The data model (R1 + R5) and the pure parser/mapper

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`SlaveTemplate` + five columns; new `CatalogImport`), `packages/db/src/seed.ts:43`
- Create: `packages/db/prisma/migrations/20260910140000_m42_catalog_import/migration.sql`
- Create: `packages/domain/src/catalog/persona.ts`, `packages/domain/src/catalog/index.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/catalog/persona.test.ts`

**Interfaces:**
- Consumes from Task 1: nothing.
- Produces, for Tasks 3–5:
```ts
export interface PersonaDraft {
  readonly name: string
  readonly description: string | null
  readonly body: string
  readonly meta: Readonly<Record<string, string>>
}
export type PersonaError =
  | { readonly kind: 'no_front_matter' }
  | { readonly kind: 'unterminated_front_matter' }
  | { readonly kind: 'no_name' }
  | { readonly kind: 'empty_body' }
export function personaErrorText(error: PersonaError): string
export function parsePersona(source: { readonly path: string; readonly text: string }): Result<PersonaDraft, PersonaError>

export interface TemplateDraft {
  readonly sourceId: string
  readonly name: string
  readonly role: string
  readonly description: string
  readonly profile: string
  readonly profileSha256: string
  readonly sourceSha256: string
  readonly sourceDivision: string
}
export interface TemplateMapping {
  readonly catalog: string
  readonly division: string
  readonly slug: string
  readonly text: string
  readonly importedAt: Date
  readonly roleMap?: Readonly<Record<string, string>>
}
export function personaToTemplate(
  draft: PersonaDraft,
  mapping: TemplateMapping,
): Result<TemplateDraft, { readonly kind: 'profile_too_long'; readonly limit: number; readonly length: number }>
export function importedProfilePrefix(sourceId: string, importedAt: Date): string
```
Prisma rows: `SlaveTemplate.{sourceId,sourceSha256,sourceDivision,profileSha256,importedAt}`;
`CatalogImport { id, catalog, directory, by, startedAt, finishedAt, created, updated, unchanged, skipped, report }`.

- [ ] **Step 1: Write the failing parser tests**

Create `packages/domain/test/catalog/persona.test.ts`. Three fixture texts live in the file itself
— the parser is pure and takes text, so a fixture on disk would only add a read the test does not
need. Every word here is the project's own vocabulary (`gate:m26-vocabulary` scans this file).

```ts
import { describe, expect, it } from 'vitest'
import { PROFILE_MAX_CHARS, goalSha256, importedProfilePrefix, parsePersona, personaErrorText, personaToTemplate } from '../../src/index.js'

const GOOD = `---
name: Core Builder
description: Builds the core module and the tests that hold it up.
color: blue
emoji: brick
vibe: Puts the load-bearing parts in first.
tools: Read, Write, Edit
---

# Core Builder

You are **Core Builder**. You write the module everything else stands on, and you write its tests
first.

## How you work
- Small commits, each one green.
`

const MALFORMED = `# Core Builder

There is no front matter here at all, so this file is not a persona.
`

const NO_NAME = `---
description: A persona with no name is not a persona.
---

Body.
`

const IMPORTED_AT = new Date('2026-09-10T08:30:00.000Z')

describe('parsePersona', () => {
  it('reads the name, the description and the body, and keeps every other key in meta', () => {
    const result = parsePersona({ path: 'engineering/core-builder.md', text: GOOD })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.name).toBe('Core Builder')
    expect(result.value.description).toBe('Builds the core module and the tests that hold it up.')
    expect(result.value.meta).toEqual({
      name: 'Core Builder',
      description: 'Builds the core module and the tests that hold it up.',
      color: 'blue',
      emoji: 'brick',
      vibe: 'Puts the load-bearing parts in first.',
      tools: 'Read, Write, Edit',
    })
    // The body is everything after the closing delimiter, trimmed -- and the front matter is NOT
    // part of it: what reaches a prompt is the persona, not its catalog metadata.
    expect(result.value.body.startsWith('# Core Builder')).toBe(true)
    expect(result.value.body).not.toContain('vibe:')
  })

  it('refuses a file with no front matter', () => {
    const result = parsePersona({ path: 'x.md', text: MALFORMED })
    expect(result).toEqual({ ok: false, error: { kind: 'no_front_matter' } })
    expect(personaErrorText({ kind: 'no_front_matter' })).toContain('front matter')
  })

  it('refuses front matter that is never closed', () => {
    const result = parsePersona({ path: 'x.md', text: '---\nname: Half\n' })
    expect(result).toEqual({ ok: false, error: { kind: 'unterminated_front_matter' } })
  })

  it('refuses front matter with no name', () => {
    expect(parsePersona({ path: 'x.md', text: NO_NAME })).toEqual({ ok: false, error: { kind: 'no_name' } })
  })

  it('refuses a persona with front matter and nothing under it', () => {
    expect(parsePersona({ path: 'x.md', text: '---\nname: Empty\n---\n\n   \n' })).toEqual({
      ok: false,
      error: { kind: 'empty_body' },
    })
  })

  it('tolerates a byte-order mark, CRLF line endings and quoted values', () => {
    const result = parsePersona({ path: 'x.md', text: `﻿---\r\nname: "Core Builder"\r\n---\r\n\r\nBody.\r\n` })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.name).toBe('Core Builder')
  })
})

describe('personaToTemplate', () => {
  const mapping = { catalog: 'catalog-m42', division: 'engineering', slug: 'core-builder', text: GOOD, importedAt: IMPORTED_AT }

  it("maps a persona onto a template draft, labelling the text as the persona's own", () => {
    const parsed = parsePersona({ path: 'engineering/core-builder.md', text: GOOD })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const result = personaToTemplate(parsed.value, mapping)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sourceId).toBe('catalog-m42/engineering/core-builder')
    expect(result.value.name).toBe('Core Builder')
    // The role is the division: only `manager` and `reviewer` are load-bearing at dispatch, and
    // nothing is inferred from a persona's name (R3).
    expect(result.value.role).toBe('engineering')
    expect(result.value.sourceDivision).toBe('engineering')
    expect(result.value.description).toBe('Builds the core module and the tests that hold it up.')
    expect(result.value.profile.startsWith(importedProfilePrefix('catalog-m42/engineering/core-builder', IMPORTED_AT))).toBe(true)
    expect(result.value.profile).toContain('You write the module everything else stands on')
    expect(result.value.sourceSha256).toBe(goalSha256(GOOD))
    expect(result.value.profileSha256).toBe(goalSha256(result.value.profile))
  })

  it('translates the role through a role map', () => {
    const parsed = parsePersona({ path: 'x.md', text: GOOD })
    if (!parsed.ok) throw new Error('fixture')
    const result = personaToTemplate(parsed.value, { ...mapping, roleMap: { engineering: 'backend' } })
    expect(result.ok && result.value.role).toBe('backend')
  })

  it('falls back to vibe when there is no description', () => {
    const text = GOOD.replace('description: Builds the core module and the tests that hold it up.\n', '')
    const parsed = parsePersona({ path: 'x.md', text })
    if (!parsed.ok) throw new Error('fixture')
    const result = personaToTemplate(parsed.value, { ...mapping, text })
    expect(result.ok && result.value.description).toBe('Puts the load-bearing parts in first.')
  })

  it('refuses a persona whose COMPOSED profile is over the cap, and measures the composed length', () => {
    // The cap is the one `buildRunContext` re-checks at dispatch against the STORED text, prefix
    // line included -- a body that only just fits under 16k would otherwise import cleanly and make
    // every worker materialised from it undispatchable (erratum E3).
    const filler = 'The core module holds the rest of the system up. '
    const body = filler.repeat(Math.ceil(PROFILE_MAX_CHARS / filler.length))
    const text = `---\nname: Long One\n---\n\n${body}`
    const parsed = parsePersona({ path: 'x.md', text })
    if (!parsed.ok) throw new Error('fixture')

    const result = personaToTemplate(parsed.value, { ...mapping, slug: 'long-one', text })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('profile_too_long')
    expect(result.error.limit).toBe(PROFILE_MAX_CHARS)
    expect(result.error.length).toBeGreaterThan(PROFILE_MAX_CHARS)
    expect(result.error.length).toBeGreaterThan(parsed.value.body.length)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/domain/test/catalog/persona.test.ts`
Expected: FAIL — `parsePersona` is not exported from `../../src/index.js`.

- [ ] **Step 3: Write the pure parser and mapper**

Create `packages/domain/src/catalog/persona.ts`:

```ts
import { goalSha256 } from '../goal/version.js'
import { err, ok, type Result } from '../result.js'
import { PROFILE_MAX_CHARS } from '../run-context/profile.js'

/**
 * A persona file, read (M42 §2). PURE: nothing in this package touches disk or Prisma -- the
 * directory walk is the CLI's (`apps/orchestrator/src/catalog.ts`) and the rows are the control
 * verb's (`packages/control/src/catalog.ts`). Deliberately NOT a YAML parser, the same judgment
 * `packages/control/src/skills.ts` records about a skill's front matter: an external catalog's
 * five scalar keys are a line format, and a real YAML dependency here would buy nothing and pull a
 * parser into a package that `apps/web`'s CLIENT bundle imports.
 */
export interface PersonaDraft {
  readonly name: string
  /** The catalog blurb, or `null` -- the mapper falls back to `meta.vibe` and then to nothing. */
  readonly description: string | null
  /** Everything after the closing delimiter, trimmed. The front matter is NOT part of it: what
   *  reaches a prompt is the persona, not its catalog metadata. */
  readonly body: string
  /** Every front-matter key, verbatim, including the ones this milestone does not act on --
   *  colour, emoji, a tool allowlist (§3, out of scope). Kept because throwing away what the source
   *  said is not something a re-import can undo. */
  readonly meta: Readonly<Record<string, string>>
}

export type PersonaError =
  | { readonly kind: 'no_front_matter' }
  | { readonly kind: 'unterminated_front_matter' }
  | { readonly kind: 'no_name' }
  | { readonly kind: 'empty_body' }

/** The reason an operator reads on a skipped row. */
export function personaErrorText(error: PersonaError): string {
  switch (error.kind) {
    case 'no_front_matter':
      return 'the file does not open with a --- front matter block'
    case 'unterminated_front_matter':
      return 'the front matter block is never closed with a second ---'
    case 'no_name':
      return 'the front matter has no name'
    case 'empty_body':
      return 'there is no persona text under the front matter'
  }
}

const DELIMITER = '---'
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/

/** Strips ONE matching pair of surrounding quotes; anything else is left exactly as written. */
function unquote(value: string): string {
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}

export function parsePersona(source: { readonly path: string; readonly text: string }): Result<PersonaDraft, PersonaError> {
  // A byte-order mark and CRLF are both ordinary in a catalog written on another machine, and
  // neither is a reason to refuse a persona.
  const lines = source.text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')
  if ((lines[0] ?? '').trim() !== DELIMITER) return err({ kind: 'no_front_matter' })

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER)
  if (closing === -1) return err({ kind: 'unterminated_front_matter' })

  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, closing)) {
    const match = KEY_LINE.exec(line)
    // A continuation line, a comment, a blank: not a key, and not a reason to refuse the file.
    if (match === null) continue
    meta[match[1] as string] = unquote((match[2] ?? '').trim())
  }

  const name = (meta['name'] ?? '').trim()
  if (name === '') return err({ kind: 'no_name' })

  const body = lines.slice(closing + 1).join('\n').trim()
  if (body === '') return err({ kind: 'empty_body' })

  const description = (meta['description'] ?? '').trim()
  return ok({ name, description: description === '' ? null : description, body, meta })
}

/**
 * The ONE line the product owns in an imported profile (R4).
 *
 * The persona's words are kept verbatim; this says whose they are and when they arrived, so a
 * reader of a prompt can tell an imported brief from one an operator wrote. The date, not the
 * timestamp: the hour a file was read is not a fact about the persona.
 */
export function importedProfilePrefix(sourceId: string, importedAt: Date): string {
  return `Imported from ${sourceId} on ${importedAt.toISOString().slice(0, 10)}; this text is the persona's own.`
}

export interface TemplateDraft {
  readonly sourceId: string
  readonly name: string
  readonly role: string
  readonly description: string
  readonly profile: string
  readonly profileSha256: string
  readonly sourceSha256: string
  readonly sourceDivision: string
}

export interface TemplateMapping {
  readonly catalog: string
  readonly division: string
  /** The file's path inside its division, without `.md` -- the third segment of `sourceId`. */
  readonly slug: string
  /** The file's text exactly as it was read, which is what `sourceSha256` is over. */
  readonly text: string
  readonly importedAt: Date
  /** `division -> role`, from `--role-map`. Nothing is inferred from a persona's name (R3). */
  readonly roleMap?: Readonly<Record<string, string>>
}

/**
 * A parsed persona as a catalog row would have it (R3, R4).
 *
 * `defaultModel`/`provider` are not here at all and never will be: a model choice is an operator
 * decision, which is the seed's own rule and the reason it ships every template with a null model.
 *
 * The cap is measured on the COMPOSED profile -- prefix line included -- because that is the text
 * that gets stored, and `buildRunContext` re-checks THAT length at dispatch and refuses the run.
 * Measuring the body alone would let a persona import cleanly and make every worker materialised
 * from it undispatchable.
 */
export function personaToTemplate(
  draft: PersonaDraft,
  mapping: TemplateMapping,
): Result<TemplateDraft, { readonly kind: 'profile_too_long'; readonly limit: number; readonly length: number }> {
  const sourceId = `${mapping.catalog}/${mapping.division}/${mapping.slug}`
  const profile = `${importedProfilePrefix(sourceId, mapping.importedAt)}\n\n${draft.body}`.trim()
  if (profile.length > PROFILE_MAX_CHARS) {
    return err({ kind: 'profile_too_long', limit: PROFILE_MAX_CHARS, length: profile.length })
  }
  return ok({
    sourceId,
    name: draft.name,
    role: mapping.roleMap?.[mapping.division] ?? mapping.division,
    description: draft.description ?? (draft.meta['vibe'] ?? '').trim(),
    profile,
    profileSha256: goalSha256(profile),
    sourceSha256: goalSha256(mapping.text),
    sourceDivision: mapping.division,
  })
}
```

Create `packages/domain/src/catalog/index.ts`:

```ts
export * from './persona.js'
```

and add `export * from './catalog/index.js'` to `packages/domain/src/index.ts` beside the other
`export *` lines.

- [ ] **Step 4: Run the parser tests**

Run: `npx vitest run packages/domain/test/catalog/persona.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the schema**

In `packages/db/prisma/schema.prisma`, in `model SlaveTemplate` (line 240), after `profile`:

```prisma
  /// M42 §R1: where this template came from, when it is not hand-made. `<catalog>/<division>/<slug>`
  /// -- unique, so a re-import finds the row it wrote last time no matter what the operator has
  /// since renamed. NULL for every hand-made template, which is what "imported" means here.
  sourceId       String?       @unique
  /// The SHA-256 of the persona FILE as it was imported. The change detector: an unchanged file is
  /// an unchanged row, and nothing is read or written for it.
  sourceSha256   String?
  /// The source directory this persona lived in -- the division. `role` is derived from it (R3) and
  /// may have been translated by `--role-map`, so the untranslated fact is kept separately.
  sourceDivision String?
  /// M42 erratum E2: the SHA-256 of the profile text the IMPORT wrote, which is the only way to
  /// tell an operator's edit from the import's own words. `setProfile({ templateId })` records
  /// nothing at all -- no event, no hash, deliberately, because a catalog row has no workspace to
  /// append an event to -- and `sourceSha256` cannot stand in: it hashes the FILE, and by the time
  /// this question is asked the file has changed and the body that was written is gone. A stored
  /// profile whose hash is not this one was edited (or cleared) by a person, and the import leaves
  /// it alone.
  profileSha256  String?
  importedAt     DateTime?
```

At the end of the file, add the record:

```prisma
/// M42 §R5: one run of `import-catalog`, and the whole of its auditable record.
///
/// NOT an `ExecutionEvent`: that table's `workspaceId` is NOT NULL and every reader of the log is
/// workspace-scoped, while the template catalog belongs to no project at all -- the same gap
/// `setProfile`'s doc comment names for a template-level profile write. So the import writes a row
/// of its own instead of inventing a workspace for an event, and `list-imports` and the web read
/// this table.
///
/// `report` is the full per-row `ImportReport` (`packages/control/src/catalog.ts`) as JSONB: the
/// counters beside it are the summary an operator scans, and the report is what they open when one
/// of the counters is not what they expected. A dry run writes NO row (it changed nothing).
model CatalogImport {
  id         String   @id @default(uuid())
  /// The catalog's name, which is the first segment of every `sourceId` this run wrote.
  catalog    String
  /// The absolute directory it was read from, on the daemon host's disk.
  directory  String
  /// WHO ran it, by NAME (`--by`), not a `Principal`: the CLI is this verb's only caller and has no
  /// session -- `setProfile(target, profile, actor)`'s idiom.
  by         String?
  startedAt  DateTime
  finishedAt DateTime
  created    Int
  updated    Int
  unchanged  Int
  skipped    Int
  report     Json

  @@index([startedAt])
}
```

- [ ] **Step 6: Write the migration by hand**

Create `packages/db/prisma/migrations/20260910140000_m42_catalog_import/migration.sql`:

```sql
-- M42 t2: provenance on a template (spec R1, erratum E2) and the record of an import run (R5).
-- Additive, no backfill: every existing template is hand-made, which is exactly what a NULL
-- `sourceId` means.

ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceId" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceSha256" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "sourceDivision" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "profileSha256" TEXT;
ALTER TABLE "SlaveTemplate" ADD COLUMN "importedAt" TIMESTAMP(3);

-- Postgres does not count NULLs as equal, so this constrains imported rows and leaves every
-- hand-made one alone. It is what makes a re-import find the row it wrote last time.
CREATE UNIQUE INDEX "SlaveTemplate_sourceId_key" ON "SlaveTemplate"("sourceId");

CREATE TABLE "CatalogImport" (
    "id" TEXT NOT NULL,
    "catalog" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "by" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "created" INTEGER NOT NULL,
    "updated" INTEGER NOT NULL,
    "unchanged" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "report" JSONB NOT NULL,

    CONSTRAINT "CatalogImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogImport_startedAt_idx" ON "CatalogImport"("startedAt");
```

- [ ] **Step 7: Add the table to the seed's truncation**

In `packages/db/src/seed.ts:43`, add `"CatalogImport"` to the `TRUNCATE TABLE` list — put it first,
before `"SimulationModelUsage"`. Without it a re-seed leaves import rows behind describing templates
that no longer exist, and the seed's "idempotent by construction" claim stops being true.

- [ ] **Step 8: Apply the migration to both databases and prove it is complete**

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:test
npx prisma migrate diff \
  --from-schema-datasource packages/db/prisma/schema.prisma \
  --to-schema-datamodel packages/db/prisma/schema.prisma \
  --config packages/db/prisma.config.ts
```
Expected: both deploys apply `20260910140000_m42_catalog_import`; the diff prints
**"No difference detected."** Paste all four outputs into the task report.

- [ ] **Step 9: Prove the new columns read back**

```bash
node --env-file=.env -e "
const { prisma } = await import('./packages/db/dist/client.js')
const t = await prisma.slaveTemplate.findFirst({ select: { name: true, sourceId: true, sourceSha256: true, sourceDivision: true, profileSha256: true, importedAt: true } })
console.log(JSON.stringify(t))
console.log('CatalogImport rows:', await prisma.catalogImport.count())
await prisma.\$disconnect()
"
```
Expected: an existing template with all five provenance fields `null`, and `CatalogImport rows: 0`.
Paste it into the report — it is the evidence that the migration is additive and backfills nothing.

- [ ] **Step 10: Gate, typecheck, commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npx vitest run packages/domain/test/catalog/persona.test.ts
git add packages/db packages/domain/src/catalog packages/domain/src/index.ts packages/domain/test/catalog
git commit -m "$(cat <<'EOF'
feat(db,domain): m42 t2 — provenance on a template, the record of an import, and the pure persona parser

Five nullable columns on SlaveTemplate and one CatalogImport table, additive with no backfill: a
hand-made template is one with no sourceId. profileSha256 is the column erratum E2 found missing --
setProfile on a template records nothing at all, so the hash of the text the import WROTE is the
only way to tell an operator's edit from the import's own words, and sourceSha256 (the file's hash)
cannot stand in because by the time the question is asked the file has changed.

parsePersona/personaToTemplate are pure: no disk, no Prisma, no node:crypto -- this package reaches
the web's client bundle. The profile cap is measured on the COMPOSED text, prefix line included,
because that is the length buildRunContext re-checks at dispatch.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 3: The control verb — `importCatalog`, `listCatalogImports`, and provenance on `listTemplates`

**Files:**
- Create: `packages/control/src/catalog.ts`
- Modify: `packages/control/src/refusal.ts` (two kinds + two `refusalText` cases), `packages/control/src/index.ts` (`export * from './catalog.js'`)
- Modify: `apps/web/src/server/org.ts` (`listTemplates`), `apps/web/test/refusal-status.test.ts` (`ALL_KINDS`)
- Test: `packages/control/test/integration/catalog.test.ts`, `apps/web/test/integration/server-org.test.ts`

**Interfaces:**
- Consumes from Task 2: `parsePersona`, `personaErrorText`, `personaToTemplate`, `importedProfilePrefix`, `goalSha256`, and the five `SlaveTemplate` columns + `CatalogImport`.
- Produces, for Tasks 4–5:
```ts
export interface CatalogEntry {
  readonly sourceId: string      // informational; the row's own id is rebuilt from catalog/division/slug
  readonly division: string
  readonly slug: string
  readonly path: string
  readonly text: string
}
export interface ImportCatalogInput {
  readonly catalog: string
  readonly directory: string
  readonly entries: readonly CatalogEntry[]
  readonly roleMap?: Readonly<Record<string, string>>
  /** Runs the parser AND the policy (which reads the database) and writes nothing at all. */
  readonly dryRun?: boolean
}
export type SkipReason = 'name_taken' | 'locally_edited' | 'profile_too_long' | 'invalid_persona'
export interface RowOutcome {
  readonly sourceId: string
  readonly name: string
  readonly role: string
  readonly templateId: string | null   // null on a dry run's `created`
  readonly roleDrift?: { readonly stored: string; readonly mapped: string }
}
export interface SkippedRow {
  readonly sourceId: string
  readonly name: string | null
  readonly reason: SkipReason
  readonly detail: string
}
export interface ImportReport {
  readonly importId: string | null     // null for a dry run
  readonly dryRun: boolean
  readonly catalog: string
  readonly directory: string
  readonly created: readonly RowOutcome[]
  readonly updated: readonly RowOutcome[]
  readonly unchanged: readonly RowOutcome[]
  readonly skipped: readonly SkippedRow[]
}
export async function importCatalog(input: ImportCatalogInput, by?: string): Promise<Result<ImportReport, ControlRefusal>>
export interface CatalogImportView {
  readonly id: string
  readonly catalog: string
  readonly directory: string
  readonly by: string | null
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: number
}
export async function listCatalogImports(limit?: number): Promise<readonly CatalogImportView[]>
```
`listTemplates()`'s row gains `sourceId: string | null`, `sourceDivision: string | null`,
`importedAt: string | null` (an ISO string — `GoalVersionView.createdAt`'s idiom, because this row
crosses into a `'use client'` component).

- [ ] **Step 1: Write the failing control tests**

Create `packages/control/test/integration/catalog.test.ts`. One `describe` with one case per policy
branch, in R2's own order.

```ts
import { prisma } from '@slave-of-ai/db/client'
import { goalSha256, importedProfilePrefix } from '@slave-of-ai/domain'
import { beforeEach, describe, expect, it } from 'vitest'
import { importCatalog, listCatalogImports } from '../../src/catalog.js'
import { setProfile } from '../../src/profile.js'

const CATALOG = 'catalog-m42'
const DIRECTORY = '/tmp/catalog-m42'

const persona = (name: string, body = 'You build the core module and its tests.'): string =>
  `---\nname: ${name}\ndescription: ${name} does one thing well.\nvibe: One thing, well.\n---\n\n# ${name}\n\n${body}\n`

const entry = (slug: string, name: string, body?: string): {
  sourceId: string
  division: string
  slug: string
  path: string
  text: string
} => ({
  sourceId: `${CATALOG}/engineering/${slug}`,
  division: 'engineering',
  slug,
  path: `${DIRECTORY}/engineering/${slug}.md`,
  text: persona(name, body),
})

const importOne = async (entries: readonly ReturnType<typeof entry>[], options: { roleMap?: Record<string, string>; dryRun?: boolean } = {}) =>
  importCatalog({ catalog: CATALOG, directory: DIRECTORY, entries, ...options }, 'operator')

describe('importCatalog', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "CatalogImport", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
    )
  })

  it('(a) creates a template for a persona nobody has imported and whose name is free', async (): Promise<void> => {
    const result = await importOne([entry('core-builder', 'Core Builder')])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toHaveLength(1)
    expect(result.value.skipped).toEqual([])
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })
    expect(row.name).toBe('Core Builder')
    expect(row.role).toBe('engineering')
    expect(row.description).toBe('Core Builder does one thing well.')
    expect(row.sourceDivision).toBe('engineering')
    expect(row.importedAt).not.toBeNull()
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
    expect((row.profile as string).startsWith(importedProfilePrefix(row.sourceId as string, row.importedAt as Date))).toBe(true)
    // A model choice is an operator decision, never an import's opinion (R3).
    expect(row.defaultModel).toBeNull()
    expect(row.provider).toBeNull()
  })

  it('(b) skips name_taken when a hand-made template already holds the name, and creates nothing', async (): Promise<void> => {
    await prisma.slaveTemplate.create({ data: { name: 'Core Builder', role: 'backend' } })

    const result = await importOne([entry('core-builder', 'Core Builder')])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toEqual([])
    expect(result.value.skipped).toEqual([
      {
        sourceId: `${CATALOG}/engineering/core-builder`,
        name: 'Core Builder',
        reason: 'name_taken',
        detail: 'a template named "Core Builder" already exists and was not imported from this catalog',
      },
    ])
    expect(await prisma.slaveTemplate.count()).toBe(1)
    expect((await prisma.slaveTemplate.findFirstOrThrow()).role).toBe('backend')
  })

  it('(c) reports unchanged and writes nothing when the file has not changed', async (): Promise<void> => {
    const entries = [entry('core-builder', 'Core Builder')]
    await importOne(entries)
    const first = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })

    const result = await importOne(entries)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.unchanged.map((row) => row.sourceId)).toEqual([`${CATALOG}/engineering/core-builder`])
    expect(result.value.created).toEqual([])
    const second = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })
    expect(second.importedAt).toEqual(first.importedAt)
    expect(second.profile).toBe(first.profile)
  })

  it('(d) updates the profile, the description and both hashes when the file changed and nobody edited the profile', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')])
    const changed = entry('core-builder', 'Core Builder', 'You build the core module, its tests AND its documentation.')

    const result = await importOne([changed])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.updated.map((row) => row.sourceId)).toEqual([`${CATALOG}/engineering/core-builder`])
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { sourceId: `${CATALOG}/engineering/core-builder` } })
    expect(row.profile).toContain('AND its documentation')
    expect(row.sourceSha256).toBe(goalSha256(changed.text))
    expect(row.profileSha256).toBe(goalSha256(row.profile as string))
  })

  it('(e) skips locally_edited when an operator wrote the profile since the last import', async (): Promise<void> => {
    const created = await importOne([entry('core-builder', 'Core Builder')])
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const templateId = created.value.created[0]?.templateId as string
    await setProfile({ templateId }, 'This is what I want this worker to be, in my own words.', 'operator')

    const result = await importOne([entry('core-builder', 'Core Builder', 'A different body entirely.')])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('locally_edited')
    expect(result.value.updated).toEqual([])
    // The operator's words win, and the file's hash is NOT advanced -- the next import must still
    // see the same disagreement rather than silently accepting the file.
    const row = await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })
    expect(row.profile).toBe('This is what I want this worker to be, in my own words.')
    expect(row.sourceSha256).not.toBe(goalSha256(persona('Core Builder', 'A different body entirely.')))
  })

  it('(e2) treats a CLEARED profile as locally edited too', async (): Promise<void> => {
    const created = await importOne([entry('core-builder', 'Core Builder')])
    if (!created.ok) return
    const templateId = created.value.created[0]?.templateId as string
    await setProfile({ templateId }, null, 'operator')

    const result = await importOne([entry('core-builder', 'Core Builder', 'A different body entirely.')])

    expect(result.ok && result.value.skipped[0]?.reason).toBe('locally_edited')
    expect((await prisma.slaveTemplate.findUniqueOrThrow({ where: { id: templateId } })).profile).toBeNull()
  })

  it('(f) skips profile_too_long with the COMPOSED length, and never truncates', async (): Promise<void> => {
    const filler = 'The core module holds the rest of the system up. '
    const long = filler.repeat(400)

    const result = await importOne([entry('long-one', 'Long One', long)])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped[0]?.reason).toBe('profile_too_long')
    expect(result.value.skipped[0]?.detail).toMatch(/\d+ characters, over the 16000/)
    expect(await prisma.slaveTemplate.count()).toBe(0)
  })

  it('(g) skips invalid_persona with the parser reason', async (): Promise<void> => {
    const result = await importOne([
      { sourceId: `${CATALOG}/engineering/broken`, division: 'engineering', slug: 'broken', path: `${DIRECTORY}/engineering/broken.md`, text: '# no front matter here\n' },
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped).toEqual([
      {
        sourceId: `${CATALOG}/engineering/broken`,
        name: null,
        reason: 'invalid_persona',
        detail: 'the file does not open with a --- front matter block',
      },
    ])
  })

  it('never deletes: a template whose persona has left the directory survives untouched', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder'), entry('helper', 'Helper')])

    await importOne([entry('core-builder', 'Core Builder')])

    expect(await prisma.slaveTemplate.count()).toBe(2)
  })

  it('one bad row does not stop the rest: every row is its own transaction', async (): Promise<void> => {
    const result = await importOne([
      { sourceId: `${CATALOG}/engineering/broken`, division: 'engineering', slug: 'broken', path: 'x', text: 'not a persona' },
      entry('core-builder', 'Core Builder'),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toHaveLength(1)
    expect(result.value.skipped).toHaveLength(1)
  })

  it('translates the role through --role-map at CREATION, and only reports a drift afterwards', async (): Promise<void> => {
    await importOne([entry('core-builder', 'Core Builder')], { roleMap: { engineering: 'backend' } })
    expect((await prisma.slaveTemplate.findFirstOrThrow()).role).toBe('backend')

    // A template's role is set once (Decision 9), and a worker already materialised copied it into
    // its runtimeRoles -- so a later map is REPORTED, never written.
    const again = await importOne([entry('core-builder', 'Core Builder')], { roleMap: { engineering: 'frontend' } })

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.unchanged[0]?.roleDrift).toEqual({ stored: 'backend', mapped: 'frontend' })
    expect((await prisma.slaveTemplate.findFirstOrThrow()).role).toBe('backend')
  })

  it('records one CatalogImport row with the counters and the report', async (): Promise<void> => {
    const result = await importOne([entry('core-builder', 'Core Builder'), { sourceId: 'x', division: 'engineering', slug: 'broken', path: 'x', text: 'no' }])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.catalogImport.findUniqueOrThrow({ where: { id: result.value.importId as string } })
    expect(row).toMatchObject({ catalog: CATALOG, directory: DIRECTORY, by: 'operator', created: 1, updated: 0, unchanged: 0, skipped: 1 })
    expect(row.finishedAt.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime())
    expect((row.report as { skipped: { reason: string }[] }).skipped[0]?.reason).toBe('invalid_persona')
  })

  it('a dry run reads the database, decides everything and writes nothing', async (): Promise<void> => {
    const result = await importOne([entry('core-builder', 'Core Builder')], { dryRun: true })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.dryRun).toBe(true)
    expect(result.value.importId).toBeNull()
    expect(result.value.created.map((row) => row.name)).toEqual(['Core Builder'])
    expect(result.value.created[0]?.templateId).toBeNull()
    expect(await prisma.slaveTemplate.count()).toBe(0)
    expect(await prisma.catalogImport.count()).toBe(0)
  })

  it('refuses an empty catalog and an unusable role map, writing nothing', async (): Promise<void> => {
    expect(await importOne([])).toEqual({ ok: false, error: { kind: 'catalog_empty', directory: DIRECTORY } })
    const bad = await importOne([entry('core-builder', 'Core Builder')], { roleMap: { engineering: '  ' } })
    expect(bad).toEqual({ ok: false, error: { kind: 'invalid_role_map', detail: 'the role for "engineering" is empty' } })
    expect(await prisma.catalogImport.count()).toBe(0)
  })
})

describe('listCatalogImports', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "CatalogImport", "SlaveTemplate" RESTART IDENTITY CASCADE')
  })

  it('returns the most recent runs first, and no more than the limit', async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) {
      await prisma.catalogImport.create({
        data: {
          catalog: CATALOG,
          directory: DIRECTORY,
          by: 'operator',
          startedAt: new Date(2026, 0, i + 1),
          finishedAt: new Date(2026, 0, i + 1),
          created: i,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          report: { created: [], updated: [], unchanged: [], skipped: [] },
        },
      })
    }

    const rows = await listCatalogImports(2)

    expect(rows.map((row) => row.created)).toEqual([2, 1])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/control/test/integration/catalog.test.ts`
Expected: FAIL — `../../src/catalog.js` does not exist.

- [ ] **Step 3: Add the two refusal kinds**

In `packages/control/src/refusal.ts`, in the `ControlRefusal` union beside the other catalog kinds:

```ts
  /** `importCatalog` with no entries at all (M42 §2): the directory has no persona in it, which is
   *  a mistyped path far more often than an empty catalog, and writing a `CatalogImport` row saying
   *  "nothing happened" would hide that. */
  | { readonly kind: 'catalog_empty'; readonly directory: string }
  /** A `--role-map` entry with an empty half. Refused rather than dropped: silently discarding part
   *  of what an operator typed is how a template ends up dispatchable as something nobody meant --
   *  `normaliseRoles`' own reasoning. */
  | { readonly kind: 'invalid_role_map'; readonly detail: string }
```

and in `refusalText`:

```ts
    case 'catalog_empty':
      return `no persona was found under ${refusal.directory}: nothing was imported`
    case 'invalid_role_map':
      return `--role-map is unusable: ${refusal.detail}`
```

In `apps/web/test/refusal-status.test.ts`, add `catalog_empty: true,` and `invalid_role_map: true,`
to `ALL_KINDS` (neither ends in `_not_found`, so `TODAYS_NOT_FOUND_KINDS` and its count of 17 are
unchanged).

- [ ] **Step 4: Write `packages/control/src/catalog.ts`**

```ts
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  goalSha256,
  parsePersona,
  personaErrorText,
  personaToTemplate,
  type Result,
  err,
  ok,
} from '@slave-of-ai/domain'
import { isUniqueConstraintViolation } from './prisma-errors.js'
import type { ControlRefusal } from './refusal.js'

export interface CatalogEntry {
  readonly sourceId: string
  readonly division: string
  readonly slug: string
  readonly path: string
  readonly text: string
}

export interface ImportCatalogInput {
  readonly catalog: string
  readonly directory: string
  readonly entries: readonly CatalogEntry[]
  readonly roleMap?: Readonly<Record<string, string>>
  readonly dryRun?: boolean
}

export type SkipReason = 'name_taken' | 'locally_edited' | 'profile_too_long' | 'invalid_persona'

export interface RowOutcome {
  readonly sourceId: string
  readonly name: string
  readonly role: string
  readonly templateId: string | null
  /** M42 erratum E10: the `--role-map` said one thing and the stored row says another. Reported,
   *  never written -- a template's role is set once. */
  readonly roleDrift?: { readonly stored: string; readonly mapped: string }
}

export interface SkippedRow {
  readonly sourceId: string
  readonly name: string | null
  readonly reason: SkipReason
  readonly detail: string
}

export interface ImportReport {
  readonly importId: string | null
  readonly dryRun: boolean
  readonly catalog: string
  readonly directory: string
  readonly created: readonly RowOutcome[]
  readonly updated: readonly RowOutcome[]
  readonly unchanged: readonly RowOutcome[]
  readonly skipped: readonly SkippedRow[]
}

/**
 * Thrown by a row's transaction for the one refusal it can only discover AFTER it has attempted a
 * write -- a unique index rejecting the `create` (M34's `AssignmentRefused` idiom, and the ADR
 * behind it). Two things make the throw necessary rather than tidy: a value returned from an
 * interactive `$transaction` callback still COMMITS everything written before it, and a statement
 * that violates a constraint poisons the Postgres transaction, so the callback could not continue
 * even if it wanted to.
 */
class CatalogRowRefused extends Error {
  constructor(readonly row: SkippedRow) {
    super(row.detail)
    this.name = 'CatalogRowRefused'
  }
}

type Outcome =
  | { readonly kind: 'created' | 'updated' | 'unchanged'; readonly row: RowOutcome }
  | { readonly kind: 'skipped'; readonly row: SkippedRow }

/**
 * Imports a directory of personas into the template catalog (M42 §2, R2).
 *
 * **One transaction per ROW, never one for the import.** A real catalog is three hundred files; one
 * transaction over all of them would hold locks on the whole catalog table for as long as the
 * parse takes, and -- worse -- would make the whole import all-or-nothing, when the entire point of
 * R2's policy is that a persona nobody can parse is a SKIPPED ROW rather than a crashed import.
 *
 * **Nothing is ever deleted.** A template whose persona has left the directory keeps existing, the
 * `syncSkillCatalog` idiom: the catalog is append-only, workers are materialised from these rows,
 * and an import is not the moment to decide that a file's absence means a team member should
 * vanish.
 *
 * **No events.** `ExecutionEvent.workspaceId` is NOT NULL and a template belongs to no project --
 * the gap `setProfile`'s doc comment names. The `CatalogImport` row IS the record (R5).
 */
export async function importCatalog(
  input: ImportCatalogInput,
  by?: string,
): Promise<Result<ImportReport, ControlRefusal>> {
  if (input.entries.length === 0) return err({ kind: 'catalog_empty', directory: input.directory })
  for (const [division, role] of Object.entries(input.roleMap ?? {})) {
    if (division.trim() === '') return err({ kind: 'invalid_role_map', detail: 'a division name is empty' })
    if (role.trim() === '') return err({ kind: 'invalid_role_map', detail: `the role for "${division}" is empty` })
  }

  const startedAt = new Date()
  const created: RowOutcome[] = []
  const updated: RowOutcome[] = []
  const unchanged: RowOutcome[] = []
  const skipped: SkippedRow[] = []

  for (const entry of input.entries) {
    const outcome = await importRow(entry, input, startedAt)
    if (outcome.kind === 'skipped') skipped.push(outcome.row)
    else if (outcome.kind === 'created') created.push(outcome.row)
    else if (outcome.kind === 'updated') updated.push(outcome.row)
    else unchanged.push(outcome.row)
  }

  const report = { created, updated, unchanged, skipped }

  // A dry run changed nothing, so it records nothing: a `CatalogImport` row is the record of an
  // import that HAPPENED, and one that says "0 created" for a run that never intended to create
  // anything would make the list unreadable.
  if (input.dryRun === true) {
    return ok({ importId: null, dryRun: true, catalog: input.catalog, directory: input.directory, ...report })
  }

  const row = await prisma.catalogImport.create({
    data: {
      catalog: input.catalog,
      directory: input.directory,
      by: by ?? null,
      startedAt,
      finishedAt: new Date(),
      created: created.length,
      updated: updated.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
      report: report as unknown as Prisma.InputJsonValue,
    },
  })

  return ok({ importId: row.id, dryRun: false, catalog: input.catalog, directory: input.directory, ...report })
}

/** One persona, decided and written (or not) on its own. */
async function importRow(entry: CatalogEntry, input: ImportCatalogInput, importedAt: Date): Promise<Outcome> {
  const parsed = parsePersona({ path: entry.path, text: entry.text })
  if (!parsed.ok) {
    return { kind: 'skipped', row: { sourceId: entry.sourceId, name: null, reason: 'invalid_persona', detail: personaErrorText(parsed.error) } }
  }

  const drafted = personaToTemplate(parsed.value, {
    catalog: input.catalog,
    division: entry.division,
    slug: entry.slug,
    text: entry.text,
    importedAt,
    ...(input.roleMap === undefined ? {} : { roleMap: input.roleMap }),
  })
  if (!drafted.ok) {
    return {
      kind: 'skipped',
      row: {
        sourceId: entry.sourceId,
        name: parsed.value.name,
        reason: 'profile_too_long',
        // No truncation and no summarising (R2f): the operator shortens the file and runs it again.
        detail: `${String(drafted.error.length)} characters, over the ${String(drafted.error.limit)} a profile may hold`,
      },
    }
  }
  const draft = drafted.value

  try {
    return await prisma.$transaction(async (tx): Promise<Outcome> => {
      // The catalog's own locking discipline (M27 §5): every verb locks the row it writes. A
      // `sourceId` nobody has imported locks nothing here -- there is no row -- and that race is
      // caught by the unique index below instead.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "SlaveTemplate" WHERE "sourceId" = ${draft.sourceId} FOR UPDATE
      `
      const existingId = locked[0]?.id ?? null

      if (existingId === null) {
        // (b) A hand-made template -- or one from another catalog -- already holds the name. The
        // operator's row wins; nothing is renamed and nothing is overwritten. Returned rather than
        // thrown: nothing has been written to this transaction yet.
        const taken = await tx.slaveTemplate.findUnique({ where: { name: draft.name }, select: { id: true } })
        if (taken !== null) {
          return {
            kind: 'skipped',
            row: {
              sourceId: draft.sourceId,
              name: draft.name,
              reason: 'name_taken',
              detail: `a template named "${draft.name}" already exists and was not imported from this catalog`,
            },
          }
        }

        if (input.dryRun === true) {
          return { kind: 'created', row: { sourceId: draft.sourceId, name: draft.name, role: draft.role, templateId: null } }
        }

        try {
          const row = await tx.slaveTemplate.create({
            data: {
              name: draft.name,
              role: draft.role,
              description: draft.description,
              profile: draft.profile,
              profileSha256: draft.profileSha256,
              sourceId: draft.sourceId,
              sourceSha256: draft.sourceSha256,
              sourceDivision: draft.sourceDivision,
              importedAt,
            },
          })
          return { kind: 'created', row: { sourceId: draft.sourceId, name: draft.name, role: draft.role, templateId: row.id } }
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            throw new CatalogRowRefused({
              sourceId: draft.sourceId,
              name: draft.name,
              reason: 'name_taken',
              detail: 'a unique index rejected the row: the name or the source id was taken between the check and the write',
            })
          }
          throw error
        }
      }

      const existing = await tx.slaveTemplate.findUniqueOrThrow({ where: { id: existingId } })
      const drift =
        existing.role === draft.role ? {} : { roleDrift: { stored: existing.role, mapped: draft.role } }
      const outcomeRow: RowOutcome = { sourceId: draft.sourceId, name: existing.name, role: existing.role, templateId: existing.id, ...drift }

      // (c) The file has not changed. Nothing is read further and nothing is written -- including
      // for a row whose profile an operator HAS edited: the import has nothing to say about a
      // profile it is not being asked to replace.
      if (existing.sourceSha256 === draft.sourceSha256) return { kind: 'unchanged', row: outcomeRow }

      // (e) The stored profile is not the one the last import wrote, so a person wrote it (or
      // cleared it). Their words win, and `sourceSha256` is deliberately NOT advanced: the next
      // import must see the same disagreement rather than quietly accepting the file.
      const storedSha = existing.profile === null ? null : goalSha256(existing.profile)
      if (storedSha !== existing.profileSha256) {
        return {
          kind: 'skipped',
          row: {
            sourceId: draft.sourceId,
            name: existing.name,
            reason: 'locally_edited',
            detail: 'the profile on this template was written by a person since the last import, and an import never overwrites that',
          },
        }
      }

      if (input.dryRun === true) return { kind: 'updated', row: outcomeRow }

      // (d) `name` and `role` are NOT in this write (erratum E10): a template is append-only apart
      // from its profile, and `role` was copied into the runtime roles of every worker already
      // materialised from it, which an update here could never reach.
      await tx.slaveTemplate.update({
        where: { id: existing.id },
        data: {
          profile: draft.profile,
          profileSha256: draft.profileSha256,
          description: draft.description,
          sourceSha256: draft.sourceSha256,
          sourceDivision: draft.sourceDivision,
          importedAt,
        },
      })
      return { kind: 'updated', row: outcomeRow }
    })
  } catch (error) {
    if (error instanceof CatalogRowRefused) return { kind: 'skipped', row: error.row }
    throw error
  }
}

export interface CatalogImportView {
  readonly id: string
  readonly catalog: string
  readonly directory: string
  readonly by: string | null
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: number
}

/** The last few import runs, newest first (R5) -- `list-imports` and the web's panel. */
export async function listCatalogImports(limit = 10): Promise<readonly CatalogImportView[]> {
  return prisma.catalogImport.findMany({
    orderBy: { startedAt: 'desc' },
    take: Math.max(1, Math.min(limit, 100)),
    select: {
      id: true,
      catalog: true,
      directory: true,
      by: true,
      startedAt: true,
      finishedAt: true,
      created: true,
      updated: true,
      unchanged: true,
      skipped: true,
    },
  })
}
```

Add `export * from './catalog.js'` to `packages/control/src/index.ts`, after `export * from './org.js'`.

- [ ] **Step 5: Run the control tests**

Run: `npx vitest run packages/control/test/integration/catalog.test.ts`
Expected: PASS, every case.

- [ ] **Step 6: Widen `listTemplates`**

In `apps/web/src/server/org.ts:819`, add the three fields to the return type and the `select`, and
map `importedAt` to an ISO string:

```ts
export async function listTemplates(): Promise<
  readonly {
    id: string
    name: string
    role: string
    description: string
    defaultModel: string | null
    defaultProvider: ProviderKind | null
    catalogSlaveCount: number
    /** M42 §2: provenance. Null on a hand-made template, which is what "not imported" means.
     *  `importedAt` is an ISO string, not a `Date`: this row is a prop of a `'use client'`
     *  component, `GoalVersionView.createdAt`'s idiom. */
    sourceId: string | null
    sourceDivision: string | null
    importedAt: string | null
  }[]
> {
  const [templates, catalogSlaveGroups] = await Promise.all([
    prisma.slaveTemplate.findMany({
      select: {
        id: true,
        name: true,
        role: true,
        description: true,
        defaultModel: true,
        provider: true,
        sourceId: true,
        sourceDivision: true,
        importedAt: true,
      },
      orderBy: { name: 'asc' },
    }),
    prisma.companySlave.groupBy({ by: ['templateId'], _count: { _all: true } }),
  ])
  const catalogSlaveCountByTemplate = new Map(catalogSlaveGroups.map((g) => [g.templateId, g._count._all] as const))
  return templates.map(({ provider, importedAt, ...rest }) => ({
    ...rest,
    defaultProvider: provider,
    importedAt: importedAt === null ? null : importedAt.toISOString(),
    catalogSlaveCount: catalogSlaveCountByTemplate.get(rest.id) ?? 0,
  }))
}
```

Add, immediately below it:

```ts
/** M42 §2: the last ten import runs, for the catalog imports panel. Dates as ISO strings, for the
 *  same reason `listTemplates` above hands out one. */
export async function listCatalogImports(): Promise<
  readonly {
    id: string
    catalog: string
    directory: string
    by: string | null
    finishedAt: string
    created: number
    updated: number
    unchanged: number
    skipped: number
  }[]
> {
  const rows = await listCatalogImportRows(10)
  return rows.map((row) => ({
    id: row.id,
    catalog: row.catalog,
    directory: row.directory,
    by: row.by,
    finishedAt: row.finishedAt.toISOString(),
    created: row.created,
    updated: row.updated,
    unchanged: row.unchanged,
    skipped: row.skipped,
  }))
}
```

with `import { listCatalogImports as listCatalogImportRows } from '@slave-of-ai/control'` added to
the file's existing control import (aliased because this module exports a function of the same name
— the web's view builder, not the control verb).

- [ ] **Step 7: Pin the provenance on the web read**

Append to `apps/web/test/integration/server-org.test.ts`, in the `listTemplates` describe:

```ts
  it('carries the provenance of an imported template and nulls for a hand-made one', async (): Promise<void> => {
    const importedAt = new Date('2026-09-10T08:30:00.000Z')
    await prisma.slaveTemplate.create({ data: { name: 'Hand Made', role: 'backend' } })
    await prisma.slaveTemplate.create({
      data: {
        name: 'Core Builder',
        role: 'engineering',
        sourceId: 'catalog-m42/engineering/core-builder',
        sourceSha256: 'abc',
        sourceDivision: 'engineering',
        profileSha256: 'def',
        importedAt,
      },
    })

    const rows = await listTemplates()

    expect(rows.find((row) => row.name === 'Hand Made')).toMatchObject({ sourceId: null, sourceDivision: null, importedAt: null })
    expect(rows.find((row) => row.name === 'Core Builder')).toMatchObject({
      sourceId: 'catalog-m42/engineering/core-builder',
      sourceDivision: 'engineering',
      importedAt: importedAt.toISOString(),
    })
  })
```

- [ ] **Step 8: Run, gate, typecheck, commit**

```bash
npx vitest run packages/control/test/integration/catalog.test.ts apps/web/test/integration/server-org.test.ts apps/web/test/refusal-status.test.ts
npm run gate:m26-vocabulary
npx tsc --build
git add packages/control apps/web/src/server/org.ts apps/web/test
git commit -m "$(cat <<'EOF'
feat(control,web): m42 t3 — importCatalog, one transaction per row, and an honest reason for every row it did not take

Seven outcomes and no bulk crash: created, updated, unchanged, and skipped as name_taken,
locally_edited, profile_too_long or invalid_persona. A row is its own transaction because a real
catalog is three hundred files and a parse failure in one of them is a skipped row, not a rolled-back
import. Nothing is ever deleted, the syncSkillCatalog idiom. A unique index rejecting a create is
THROWN out of the transaction, never returned -- a value returned after a write still commits it,
and a constraint violation has already poisoned the transaction anyway.

An operator's edit wins: a stored profile whose hash is not the one the last import wrote is left
alone and the file's hash is deliberately not advanced, so the next import sees the same
disagreement. --role-map translates at creation and is only ever REPORTED afterwards.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 4: The CLI (`import-catalog`, `list-imports`) and the web surfaces

**Files:**
- Create: `apps/orchestrator/src/catalog.ts`, `apps/web/src/app/api/org/catalog-imports/route.ts`, `apps/web/src/components/CatalogImports.tsx`
- Modify: `apps/orchestrator/src/cli.ts` (USAGE + two cases), `apps/web/src/components/TemplateCatalog.tsx`, `apps/web/src/components/ProjectsClient.tsx`, `apps/web/src/app/page.tsx`
- Test: `apps/orchestrator/test/catalog.test.ts`, `apps/orchestrator/test/integration/cli.test.ts`, `apps/web/test/projects-page.test.tsx`, `apps/web/test/integration/org-routes.test.ts`

**Interfaces:**
- Consumes from Task 3: `importCatalog(input, by?)`, `listCatalogImports(limit?)`, `ImportReport`, `RowOutcome`, `SkippedRow`, `listTemplates()`'s three new fields.
- Produces, for Task 5:
```ts
// apps/orchestrator/src/catalog.ts
export interface CatalogWalk { readonly catalog: string; readonly entries: readonly CatalogEntry[] }
export function readCatalogDirectory(
  dir: string,
  options?: { readonly catalog?: string; readonly divisions?: readonly string[] },
): CatalogWalk
```
CLI verbs, exactly as the gate calls them:
```
import-catalog --dir <path> [--catalog <n>] [--division <d>[,<d>]] [--role-map a=b,c=d] [--by <name>] [--dry-run]
list-imports [--limit <n>]
```
Web: `GET /api/org/catalog-imports` → `{ imports: [...] }`; `TemplateRow` gains
`sourceId?: string | null`, `sourceDivision?: string | null`, `importedAt?: string | null`.

- [ ] **Step 1: Write the failing directory-walk test**

Create `apps/orchestrator/test/catalog.test.ts` (the `unit` project — this touches real files in a
temp directory but never the database, so it must NOT be under `test/integration/`):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readCatalogDirectory } from '../src/catalog.js'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeCatalog(files: Readonly<Record<string, string>>, divisions?: Readonly<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'catalog-m42-'))
  dirs.push(root)
  if (divisions !== undefined) writeFileSync(join(root, 'divisions.json'), JSON.stringify({ _note: 'x', divisions }))
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  return root
}

const PERSONA = '---\nname: Core Builder\n---\n\nBody.\n'

describe('readCatalogDirectory', () => {
  it('names the catalog after the directory and builds a sourceId per persona', () => {
    const root = makeCatalog({ 'engineering/core-builder.md': PERSONA })

    const walk = readCatalogDirectory(root)

    expect(walk.catalog).toBe(root.split('/').at(-1))
    expect(walk.entries).toHaveLength(1)
    expect(walk.entries[0]).toMatchObject({
      division: 'engineering',
      slug: 'core-builder',
      sourceId: `${walk.catalog}/engineering/core-builder`,
      text: PERSONA,
    })
  })

  it('reads divisions.json to learn which top-level directories are divisions', () => {
    const root = makeCatalog(
      { 'engineering/one.md': PERSONA, 'outputs/two.md': PERSONA },
      { engineering: { label: 'Engineering' } },
    )

    const walk = readCatalogDirectory(root)

    // Not every top-level directory is a division: a catalog that says so is believed.
    expect(walk.entries.map((entry) => entry.division)).toEqual(['engineering'])
  })

  it('treats every subdirectory as a division when there is no divisions.json', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA, 'testing/two.md': PERSONA })

    expect(readCatalogDirectory(root).entries.map((entry) => entry.division).sort()).toEqual(['engineering', 'testing'])
  })

  it('honours an explicit division filter over both', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA, 'testing/two.md': PERSONA })

    expect(readCatalogDirectory(root, { divisions: ['testing'] }).entries.map((entry) => entry.slug)).toEqual(['two'])
  })

  it('recurses one level for a tool subfolder and keeps it in the slug', () => {
    const root = makeCatalog({ 'engineering/tooling/builder.md': PERSONA })

    expect(readCatalogDirectory(root).entries[0]).toMatchObject({ division: 'engineering', slug: 'tooling/builder' })
  })

  it('skips the catalog documentation and anything that is not Markdown', () => {
    const root = makeCatalog({
      'engineering/README.md': '# not a persona\n',
      'engineering/CONTRIBUTING.md': '# not a persona\n',
      'engineering/notes.txt': 'x',
      'engineering/one.md': PERSONA,
    })

    expect(readCatalogDirectory(root).entries.map((entry) => entry.slug)).toEqual(['one'])
  })

  it('takes an explicit catalog name over the directory basename', () => {
    const root = makeCatalog({ 'engineering/one.md': PERSONA })

    expect(readCatalogDirectory(root, { catalog: 'named' }).entries[0]?.sourceId).toBe('named/engineering/one')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/orchestrator/test/catalog.test.ts`
Expected: FAIL — `../src/catalog.js` does not exist.

- [ ] **Step 3: Write the directory walk**

Create `apps/orchestrator/src/catalog.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { CatalogEntry } from '@slave-of-ai/control'

export interface CatalogWalk {
  readonly catalog: string
  readonly entries: readonly CatalogEntry[]
}

/** The two files a catalog keeps for its own readers, in every catalog that has them. */
const NOT_PERSONAS = new Set(['readme.md', 'contributing.md', 'security.md'])

/**
 * Which top-level directories hold personas.
 *
 * A catalog that ships a `divisions.json` is believed, because not every top-level directory is a
 * division -- rendered output, playbooks, scripts and examples all live beside them in the shape
 * this milestone was designed against. Its structure is `{ divisions: { "<dir>": {...} } }`, so the
 * set is that object's KEYS. A missing, unreadable or malformed file is not a failure: the walk
 * falls back to "every subdirectory", which is what a catalog with no manifest means.
 */
function divisionsOf(dir: string): readonly string[] {
  const subdirectories = readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith('.'))
    .map((item) => item.name)
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'divisions.json'), 'utf8'))
    const declared =
      typeof parsed === 'object' && parsed !== null && 'divisions' in parsed && typeof parsed.divisions === 'object' && parsed.divisions !== null
        ? Object.keys(parsed.divisions)
        : []
    const usable = declared.filter((name) => subdirectories.includes(name))
    return usable.length > 0 ? usable : subdirectories
  } catch {
    return subdirectories
  }
}

/** Every `.md` persona under one division, one level of subfolder included -- some catalogs group a
 *  division's personas by the tool they are written for. */
function personasUnder(divisionDir: string): readonly { readonly slug: string; readonly path: string }[] {
  const found: { slug: string; path: string }[] = []
  for (const item of readdirSync(divisionDir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue
    if (item.isFile()) {
      if (!item.name.endsWith('.md') || NOT_PERSONAS.has(item.name.toLowerCase())) continue
      found.push({ slug: item.name.slice(0, -3), path: join(divisionDir, item.name) })
      continue
    }
    if (!item.isDirectory()) continue
    for (const nested of readdirSync(join(divisionDir, item.name), { withFileTypes: true })) {
      if (!nested.isFile() || !nested.name.endsWith('.md') || NOT_PERSONAS.has(nested.name.toLowerCase())) continue
      found.push({ slug: `${item.name}/${nested.name.slice(0, -3)}`, path: join(divisionDir, item.name, nested.name) })
    }
  }
  return found.sort((left, right) => left.slug.localeCompare(right.slug))
}

/**
 * Reads a catalog directory into the entries `importCatalog` takes (M42 §2).
 *
 * The walk lives HERE, not in `packages/control` and certainly not in `packages/domain`: the domain
 * touches no disk at all (it is imported by the web's client bundle) and the control package's
 * verbs take data, so the one place that knows what a catalog looks like on a filesystem is the
 * application an operator runs.
 *
 * The catalog's NAME defaults to the directory's basename, resolved at runtime and never written
 * down anywhere: the first segment of every `sourceId` is a fact about the operator's disk, not a
 * constant this repository gets to choose.
 */
export function readCatalogDirectory(
  dir: string,
  options?: { readonly catalog?: string; readonly divisions?: readonly string[] },
): CatalogWalk {
  const root = resolve(dir)
  const catalog = options?.catalog ?? basename(root)
  const divisions = options?.divisions ?? divisionsOf(root)

  const entries: CatalogEntry[] = []
  for (const division of divisions) {
    for (const persona of personasUnder(join(root, division))) {
      entries.push({
        sourceId: `${catalog}/${division}/${persona.slug}`,
        division,
        slug: persona.slug,
        path: persona.path,
        text: readFileSync(persona.path, 'utf8'),
      })
    }
  }
  return { catalog, entries }
}
```

- [ ] **Step 4: Run the walk test**

Run: `npx vitest run apps/orchestrator/test/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI tests**

Append to `apps/orchestrator/test/integration/cli.test.ts`. `--dry-run` is written LAST in every
invocation: `parseArgs` takes whatever follows a flag as its value, so `--dry-run --by me` would set
`dry-run` to `'--by'` and drop `--by` entirely (erratum E11).

```ts
  describe('import-catalog', () => {
    const catalogDir = (): string => {
      const root = mkdtempSync(join(tmpdir(), 'cli-catalog-m42-'))
      mkdirSync(join(root, 'engineering'), { recursive: true })
      writeFileSync(
        join(root, 'divisions.json'),
        JSON.stringify({ divisions: { engineering: { label: 'Engineering' } } }),
      )
      writeFileSync(
        join(root, 'engineering', 'core-builder.md'),
        '---\nname: CLI Core Builder\ndescription: Builds the core.\n---\n\nYou build the core module.\n',
      )
      writeFileSync(join(root, 'engineering', 'broken.md'), '# no front matter\n')
      return root
    }

    beforeEach(async (): Promise<void> => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "CatalogImport", "SlaveTemplate" RESTART IDENTITY CASCADE')
    })

    it('imports a directory, prints a line per row, and records the run', async (): Promise<void> => {
      const dir = catalogDir()

      const result = await runCli(['import-catalog', '--dir', dir, '--by', 'operator'])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('created 1, updated 0, unchanged 0, skipped 1')
      expect(result.stdout).toContain('created  CLI Core Builder')
      expect(result.stdout).toContain('skipped  invalid_persona')
      const row = await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'CLI Core Builder' } })
      expect(row.sourceDivision).toBe('engineering')
      expect(await prisma.catalogImport.count()).toBe(1)
    })

    it('a dry run prints what would happen and writes nothing at all', async (): Promise<void> => {
      const dir = catalogDir()

      const result = await runCli(['import-catalog', '--dir', dir, '--dry-run'])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('DRY RUN')
      expect(result.stdout).toContain('nothing was written')
      expect(await prisma.slaveTemplate.count()).toBe(0)
      expect(await prisma.catalogImport.count()).toBe(0)
    })

    it('translates roles through --role-map', async (): Promise<void> => {
      const dir = catalogDir()

      await runCli(['import-catalog', '--dir', dir, '--role-map', 'engineering=backend'])

      expect((await prisma.slaveTemplate.findFirstOrThrow({ where: { name: 'CLI Core Builder' } })).role).toBe('backend')
    })

    it('exits non-zero when the directory holds no persona at all', async (): Promise<void> => {
      const empty = mkdtempSync(join(tmpdir(), 'cli-catalog-m42-empty-'))

      const result = await runCli(['import-catalog', '--dir', empty])

      expect(result.code).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('no persona was found')
    })

    it('list-imports prints the runs newest first', async (): Promise<void> => {
      const dir = catalogDir()
      await runCli(['import-catalog', '--dir', dir, '--by', 'operator'])

      const result = await runCli(['list-imports'])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('created 1')
      expect(result.stdout).toContain('operator')
    })

    it('help documents both verbs and says the boolean flag goes last', async (): Promise<void> => {
      const printed = await runCli(['help'])

      expect(`${printed.stdout}${printed.stderr}`).toContain('import-catalog --dir <path>')
      expect(`${printed.stdout}${printed.stderr}`).toContain('list-imports')
    })
  })
```

`mkdirSync` joins the file's existing `node:fs` import.

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t 'import-catalog'`
Expected: FAIL — `unknown command: import-catalog`.

- [ ] **Step 7: Add the two CLI verbs**

In `apps/orchestrator/src/cli.ts`, add to the USAGE block immediately after the `skills sync` entry
(before `create-template`):

```
  import-catalog --dir <path> [--catalog <n>] [--division <d>[,<d>]]
                 [--role-map <division>=<role>,...] [--by <name>] [--dry-run]
                                       import a directory of persona files into the template
                                       catalog. Re-runnable: an unchanged file is left alone, a
                                       changed one updates the template it created, and a profile a
                                       person has edited since is never overwritten. --catalog
                                       defaults to the directory's own name; --role-map translates a
                                       division into the role the template is created with, and only
                                       matters the first time a persona is imported. --dry-run
                                       decides everything and writes nothing -- write it LAST, a
                                       flag after it would be swallowed as its value.
  list-imports [--limit <n>]           the last catalog imports, newest first, with their counts
```

Add the two cases beside `create-template`:

```ts
    case 'import-catalog': {
      const dir = requireFlag(flags, 'dir')
      // `'dry-run' in flags`, not `!== undefined`: a bare flag's recorded value is `undefined`, the
      // repo's own `--yes`/`--clear` idiom.
      const dryRun = 'dry-run' in flags
      const divisionText = flagText(flags, 'division')
      const divisions = divisionText === undefined ? undefined : divisionText.split(',').map((d) => d.trim()).filter((d) => d !== '')
      const roleMapText = flagText(flags, 'role-map')
      const roleMap: Record<string, string> = {}
      for (const pair of roleMapText === undefined ? [] : roleMapText.split(',')) {
        const [division, role] = pair.split('=')
        if (division === undefined || role === undefined) throw new Error(`--role-map entries look like division=role; got ${JSON.stringify(pair)}`)
        roleMap[division.trim()] = role.trim()
      }

      const walk = readCatalogDirectory(dir, {
        ...(flagText(flags, 'catalog') !== undefined ? { catalog: requireFlag(flags, 'catalog') } : {}),
        ...(divisions !== undefined ? { divisions } : {}),
      })
      const result = await importCatalog(
        {
          catalog: walk.catalog,
          directory: resolve(dir),
          entries: walk.entries,
          ...(Object.keys(roleMap).length > 0 ? { roleMap } : {}),
          ...(dryRun ? { dryRun: true } : {}),
        },
        flagText(flags, 'by') ?? 'operator',
      )
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(describeImport(result.value))
      return 0
    }

    case 'list-imports': {
      const limitText = flagText(flags, 'limit')
      const limit = limitText === undefined ? 10 : Number.parseInt(limitText, 10)
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer')
      const rows = await listCatalogImports(limit)
      if (rows.length === 0) {
        process.stdout.write('no catalog has been imported yet\n')
        return 0
      }
      for (const row of rows) {
        process.stdout.write(
          `${row.finishedAt.toISOString()}  ${row.catalog}  by ${row.by ?? 'nobody named'}  ` +
            `created ${String(row.created)}, updated ${String(row.updated)}, unchanged ${String(row.unchanged)}, ` +
            `skipped ${String(row.skipped)}  (${row.directory})\n`,
        )
      }
      return 0
    }
```

and, beside the other printing helpers near `describeSync`:

```ts
/**
 * The import report an operator reads (M42 §2).
 *
 * Counts first, then a line per row that CHANGED or was skipped -- with the reason on the skip,
 * because "3 skipped" without them is a number nobody can act on. `unchanged` rows are summarised
 * rather than listed: on a real catalog they are almost all of it, and an operator scanning for
 * what moved should not have to read three hundred lines saying nothing did. A drifting role is
 * printed on its own line: the template keeps the role it was created with, and an operator who
 * expected --role-map to change it needs to be told it did not.
 */
function describeImport(report: ImportReport): string {
  const lines: string[] = []
  if (report.dryRun) lines.push('DRY RUN: nothing was written.')
  lines.push(
    `${report.catalog} (${report.directory}): created ${String(report.created.length)}, ` +
      `updated ${String(report.updated.length)}, unchanged ${String(report.unchanged.length)}, ` +
      `skipped ${String(report.skipped.length)}`,
  )
  for (const row of report.created) lines.push(`  created  ${row.name}  [${row.role}]  ${row.sourceId}`)
  for (const row of report.updated) lines.push(`  updated  ${row.name}  [${row.role}]  ${row.sourceId}`)
  for (const row of report.skipped) lines.push(`  skipped  ${row.reason}  ${row.name ?? row.sourceId}: ${row.detail}`)
  for (const row of [...report.created, ...report.updated, ...report.unchanged]) {
    if (row.roleDrift === undefined) continue
    lines.push(
      `  role     ${row.name} stays "${row.roleDrift.stored}" (the map said "${row.roleDrift.mapped}"): ` +
        "a template's role is set when it is created -- delete it and import it again to change one",
    )
  }
  if (report.importId !== null) lines.push(`recorded as import ${report.importId}`)
  return `${lines.join('\n')}\n`
}
```

Add `importCatalog`, `listCatalogImports` and `type ImportReport` to the `@slave-of-ai/control`
import, `readCatalogDirectory` from `./catalog.js`, and `resolve` from `node:path`.

- [ ] **Step 8: Run the CLI tests**

Run: `npx tsc --build && npx vitest run apps/orchestrator/test/integration/cli.test.ts -t 'import-catalog'`
Expected: PASS. (`tsc --build` first: `runCli` runs the BUILT `dist/cli.js`.) If the whole file is
run and the llm-decision row-count case fails, re-run that file alone before believing it — it
doubles when anything else touches the database.

- [ ] **Step 9: Write the failing web tests**

Append to `apps/web/test/projects-page.test.tsx` (its `next/navigation` mock and `project()` helper
are already in scope; `ProjectsClient` gains a required `catalogImports` prop, so every existing
`render(<ProjectsClient ... />)` in this file needs `catalogImports={[]}` added — do that in the same
edit):

```tsx
  const imported = {
    id: 't2',
    name: 'Core Builder',
    role: 'engineering',
    description: 'Builds the core.',
    defaultModel: null,
    defaultProvider: null,
    catalogSlaveCount: 0,
    sourceId: 'catalog-m42/engineering/core-builder',
    sourceDivision: 'engineering',
    importedAt: '2026-09-10T08:30:00.000Z',
  }

  it('marks an imported template with its division and the date it arrived', () => {
    render(<ProjectsClient projects={[project({})]} companies={companies} templates={[imported]} roster={[]} catalogImports={[]} />)

    const chip = screen.getByTestId('template-source-t2')
    expect(chip.textContent).toContain('engineering')
    expect(chip.textContent).toContain('2026-09-10')
  })

  it('shows no source chip on a hand-made template', () => {
    const handMade = { ...imported, id: 't1', name: 'Hand Made', sourceId: null, sourceDivision: null, importedAt: null }
    render(<ProjectsClient projects={[project({})]} companies={companies} templates={[handMade]} roster={[]} catalogImports={[]} />)

    expect(screen.queryByTestId('template-source-t1')).toBeNull()
  })

  it('lists the catalog imports with their counts', () => {
    render(
      <ProjectsClient
        projects={[project({})]}
        companies={companies}
        templates={[imported]}
        roster={[]}
        catalogImports={[
          { id: 'i1', catalog: 'catalog-m42', directory: '/srv/catalog-m42', by: 'operator', finishedAt: '2026-09-10T08:30:00.000Z', created: 2, updated: 1, unchanged: 3, skipped: 4 },
        ]}
      />,
    )

    const row = screen.getByTestId('catalog-import-i1')
    expect(row.textContent).toContain('catalog-m42')
    expect(row.textContent).toContain('operator')
    expect(row.textContent).toContain('2')
    expect(row.textContent).toContain('4')
  })

  it('says so when nothing has been imported', () => {
    render(<ProjectsClient projects={[project({})]} companies={companies} templates={[]} roster={[]} catalogImports={[]} />)

    expect(screen.getByTestId('catalog-imports').textContent).toContain('no catalog has been imported yet')
  })
```

Append to `apps/web/test/integration/org-routes.test.ts`:

```ts
  describe('GET /api/org/catalog-imports', () => {
    it('returns the recorded runs, newest first', async (): Promise<void> => {
      await prisma.catalogImport.create({
        data: {
          catalog: 'catalog-m42',
          directory: '/srv/catalog-m42',
          by: 'operator',
          startedAt: new Date('2026-09-10T08:00:00.000Z'),
          finishedAt: new Date('2026-09-10T08:00:01.000Z'),
          created: 2,
          updated: 0,
          unchanged: 0,
          skipped: 3,
          report: { created: [], updated: [], unchanged: [], skipped: [] },
        },
      })

      const response = await catalogImportsGET()

      expect(response.status).toBe(200)
      const body = (await response.json()) as { imports: readonly { catalog: string; skipped: number }[] }
      expect(body.imports).toHaveLength(1)
      expect(body.imports[0]).toMatchObject({ catalog: 'catalog-m42', skipped: 3 })
    })
  })
```

with `import { GET as catalogImportsGET } from '../../src/app/api/org/catalog-imports/route.js'`
added to the file's import block, and `"CatalogImport"` added to whatever this file truncates in its
`beforeEach`.

- [ ] **Step 10: Build the web surfaces**

Create `apps/web/src/app/api/org/catalog-imports/route.ts`:

```ts
import { listCatalogImports } from '../../../../server/org'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const imports = await listCatalogImports()
  return Response.json({ imports })
}
```

Create `apps/web/src/components/CatalogImports.tsx`:

```tsx
'use client'

import { DataTable, Row } from './ui/DataTable'

/** One `CatalogImport` row, as `server/org.ts`'s `listCatalogImports` hands it over. */
export interface CatalogImportRow {
  readonly id: string
  readonly catalog: string
  readonly directory: string
  readonly by: string | null
  readonly finishedAt: string
  readonly created: number
  readonly updated: number
  readonly unchanged: number
  readonly skipped: number
}

const COLUMNS = '150px 1fr 110px 90px 90px 90px 90px'
const HEADER = ['When', 'Catalog', 'By', 'Created', 'Updated', 'Unchanged', 'Skipped'] as const

/**
 * The last ten catalog imports (M42 §2), read only.
 *
 * There is no import FORM here on purpose: a catalog is a path on the daemon host's disk, exactly
 * as the skill catalog is, and a browser cannot see it. The operator runs `import-catalog` and this
 * panel is where the result is legible afterwards.
 */
export function CatalogImports({ imports }: { readonly imports: readonly CatalogImportRow[] }): React.JSX.Element {
  if (imports.length === 0) {
    return (
      <p data-testid="catalog-imports" className="text-xs text-text-3">
        no catalog has been imported yet. Run{' '}
        <code className="font-mono">npm run orchestrator -- import-catalog --dir &lt;path&gt;</code> on the host.
      </p>
    )
  }
  return (
    <div data-testid="catalog-imports">
      <DataTable columns={COLUMNS} header={[...HEADER]}>
        {imports.map((row) => (
          <Row key={row.id} columns={COLUMNS} data-testid={`catalog-import-${row.id}`}>
            <span className="font-mono text-xs text-text-2">{row.finishedAt.slice(0, 19).replace('T', ' ')}</span>
            <span className="truncate text-sm text-text-1" title={row.directory}>
              {row.catalog}
            </span>
            <span className="truncate text-text-2">{row.by ?? '—'}</span>
            <span className="text-text-2">{row.created}</span>
            <span className="text-text-2">{row.updated}</span>
            <span className="text-text-2">{row.unchanged}</span>
            <span className="text-text-2">{row.skipped}</span>
          </Row>
        ))}
      </DataTable>
    </div>
  )
}
```

If `Row` does not forward `data-testid`, wrap each row's first cell in a
`<span data-testid={...}>` instead — read `apps/web/src/components/ui/DataTable.tsx` before writing
this and follow whatever it actually supports; the test looks up `catalog-import-<id>` and needs the
whole row's text under it.

In `apps/web/src/components/TemplateCatalog.tsx`, extend `TemplateRow`:

```ts
  /** M42 §2: provenance, present only on an imported template. Optional for the same reason
   *  `defaultProvider` is -- the M11 fixtures that build a `TemplateRow` by hand predate it. */
  readonly sourceId?: string | null
  readonly sourceDivision?: string | null
  readonly importedAt?: string | null
```

and replace the name cell (leaving `COLUMNS` and `HEADER` exactly as they are — the grid is
screenshotted by `gate:m14-fidelity`):

```tsx
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-text-1">{template.name}</span>
                {template.sourceId == null ? null : (
                  <span data-testid={`template-source-${template.id}`} className="truncate font-mono text-[10px] text-text-3">
                    {template.sourceDivision ?? 'imported'} · {template.importedAt?.slice(0, 10) ?? 'imported'}
                  </span>
                )}
              </span>
```

In `apps/web/src/components/ProjectsClient.tsx`, add `catalogImports` to the props (type and
destructuring) as `readonly catalogImports: readonly CatalogImportRow[]`, import
`{ CatalogImports, type CatalogImportRow }`, and add a third panel inside the existing
`team-catalog` section, after the Companies panel:

```tsx
        <Panel title="Catalog imports">
          <CatalogImports imports={catalogImports} />
        </Panel>
```

In `apps/web/src/app/page.tsx`, add `listCatalogImports` to the `../server/org` import, to the
`Promise.all`, and to the JSX:

```tsx
  const [projects, companies, templates, roster, catalogImports] = await Promise.all([
    listProjects({ includeArchived: archived === '1' }),
    listCompanies(),
    listTemplates(),
    listRoster(),
    listCatalogImports(),
  ])
  return (
    <ProjectsClient
      projects={projects}
      companies={companies}
      templates={templates}
      roster={roster}
      catalogImports={catalogImports}
    />
  )
```

- [ ] **Step 11: Run the web tests and the bundler**

```bash
npx vitest run apps/web/test/projects-page.test.tsx apps/web/test/integration/org-routes.test.ts
npm run web:build
```
Expected: PASS, then a green build. `web:build` is what catches bundler-only breakage that `tsc` and
vitest both miss — and it must never run while `next dev` is up; if a dev server was running, stop
it, `rm -rf apps/web/.next`, and restart it afterwards.

- [ ] **Step 12: Gate, typecheck, commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
git add apps/orchestrator apps/web
git commit -m "$(cat <<'EOF'
feat(cli,web): m42 t4 — import-catalog and list-imports, and where an operator reads what an import did

The directory walk lives in the orchestrator, which is the only layer that knows what a catalog looks
like on a filesystem: divisions.json when the catalog ships one, every subdirectory when it does not,
one level of recursion for a tool subfolder, the catalog's documentation skipped. --catalog defaults
to the directory's basename at runtime, so the source catalog's name is a fact about the operator's
disk rather than a constant in this repository.

The report prints counts, then a line per row that changed or was skipped WITH its reason, then a
line for every template whose role the map wanted to change and could not. A dry run says so twice
and writes nothing. On the web an imported template carries its division and arrival date under its
name -- inside the existing cell, because the table's grid is screenshotted -- and a read-only panel
lists the last ten runs. No import form: a catalog is a path on the daemon host's disk.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 5: The fixture catalog, the gate, CI, the README — and the full verification ladder

**Files:**
- Create: `scripts/fixtures/catalog-m42/divisions.json`, `scripts/fixtures/catalog-m42/engineering/{core-builder,collision,oversize}.md`, `scripts/fixtures/catalog-m42/testing/{verifier,broken}.md`
- Create: `scripts/gate-m42-catalog-import.mjs`
- Modify: `package.json` (`gate:m42-catalog-import`), `.github/workflows/ci.yml` (after `gate:m41-scenario`), `README.md` (`## Importing a catalog`; "Tests and CI" roster 17 → 18)

**Interfaces:**
- Consumes from Tasks 2–4: `parsePersona`/`personaToTemplate` through the CLI, `importCatalog`'s
  outcomes and reasons, `listCatalogImports`, the CLI verbs `import-catalog` / `list-imports` /
  `set-profile` / `create-template` / `create-company` / `add-team` / `add-slave` /
  `assign-company` / `daemon`, and `SlaveTemplate`'s five provenance columns.
- Produces: the npm script name `gate:m42-catalog-import`.

- [ ] **Step 1: Write the fixture catalog**

Every file here is committed and therefore scanned by `gate:m26-vocabulary`: the word is **slave**,
and the catalog's own name must never appear. Five personas, exactly the five §4 asks for.

`scripts/fixtures/catalog-m42/divisions.json`:

```json
{
  "_note": "The gate's own catalog. Two divisions, five personas, written in this project's vocabulary so nothing checked in trips gate:m26-vocabulary.",
  "divisions": {
    "engineering": { "label": "Engineering" },
    "testing": { "label": "Testing" }
  }
}
```

`scripts/fixtures/catalog-m42/engineering/core-builder.md` — the ordinary one, and the one the gate
edits by hand in stage 3:

```markdown
---
name: Gate Core Builder
description: Builds the core module and the tests that hold it up.
color: blue
emoji: brick
vibe: Puts the load-bearing parts in first.
tools: Read, Write, Edit
---

# Gate Core Builder

You are **Gate Core Builder**. You write the module everything else stands on, and you write its
tests before you write it.

## How you work
- One small commit at a time, each one green.
- A function nobody calls is a function you delete.
- When two designs are equally good, you take the one that is easier to delete later.
```

`scripts/fixtures/catalog-m42/engineering/collision.md` — its name is the one the gate creates by
hand first, so this row can only ever be `name_taken`:

```markdown
---
name: Gate Collision Persona
description: Shares a name with a template an operator made by hand.
vibe: The operator's row wins.
---

# Gate Collision Persona

You are **Gate Collision Persona**. This file exists so an import has something whose name is
already taken, and so the gate can prove the operator's own row is never overwritten.
```

`scripts/fixtures/catalog-m42/engineering/oversize.md` — write the front matter by hand and generate
the body, so the file is a real one and nobody types sixteen thousand characters:

```bash
node -e "
const { writeFileSync } = require('node:fs')
const head = '---\nname: Gate Oversize Persona\ndescription: Longer than a profile may be.\nvibe: Too much of a good thing.\n---\n\n# Gate Oversize Persona\n\n'
const line = 'You keep the core module standing, and you say so at length. '
writeFileSync('scripts/fixtures/catalog-m42/engineering/oversize.md', head + line.repeat(300) + '\n')
"
wc -c scripts/fixtures/catalog-m42/engineering/oversize.md
```
Expected: comfortably over 16 000 bytes. If it is not, raise the repeat count until it is —
`PROFILE_MAX_CHARS` is 16 000 and this file's whole job is to be over it.

`scripts/fixtures/catalog-m42/testing/verifier.md` — the second ordinary one, and the one the gate
rewrites in stage 3 so it becomes an `updated`:

```markdown
---
name: Gate Verifier
description: Reads the work back and says whether it does what it claims.
color: amber
emoji: check
vibe: Trusts nothing that has not run.
---

# Gate Verifier

You are **Gate Verifier**. You read work back and you run it. A claim you have not seen run is a
claim you have not checked.
```

`scripts/fixtures/catalog-m42/testing/broken.md` — the malformed one:

```markdown
# Gate Broken Persona

There is no front matter here at all, so this file is not a persona and an import has to say so
rather than guess.
```

- [ ] **Step 2: Prove the fixture catalog is vocabulary-clean before anything else**

```bash
git add scripts/fixtures/catalog-m42
npm run gate:m26-vocabulary
```
Expected: PASS. `scripts/fixtures/` is NOT on the gate's exclude list, and it deliberately stays off
it (R4): the fixture is the proof that a catalog written in this project's words imports cleanly.
Fix the words, never the exclude list.

- [ ] **Step 3: Write the gate**

Create `scripts/gate-m42-catalog-import.mjs`. Borrow the shape from
`scripts/gate-m41-scenario.mjs` — `preflightCleanup()` / `dumpGateRows()` / `fail()` /
`waitUntil()` / `makeRepo()` / `spawnDaemon()` / `stopDaemon()` / `runCli()` through
`execFileSync('node', [ORCHESTRATOR_CLI, ...])` with `loopbackChildEnv()`, `exitCode` starting at 1
and set to 0 only at the very end, teardown in FK order in a `finally` — and the `m8a-flow` wiring
and manifest reads from `scripts/gate-m37-run-context.mjs`.

```js
// M42's own gate: a catalog on disk becomes templates, and the persona reaches the model.
//
// Six stages, and each one measures a rule the import claims to follow:
//   1. A first import of the checked-in fixture catalog creates two templates and skips three, with
//      the three reasons R2 names -- name_taken, profile_too_long, invalid_persona -- and writes ONE
//      CatalogImport row whose counters and report say exactly that.
//   2. The same import again: two unchanged, nothing created, nothing written to either template.
//   3. The operator edits one imported template's profile through `set-profile` and BOTH persona
//      files are rewritten. The edited one is skipped `locally_edited` and keeps the operator's own
//      words; the other is `updated` and carries the new body.
//   4. `--role-map engineering=backend,testing=reviewer --dry-run` prints the translation it WOULD
//      have made and writes nothing: no template row moves and no CatalogImport row is added.
//   5. A company is built from the two imported templates through the real CLI and assigned to a
//      workspace; a real daemon dispatches one task with the fake CLI, and the run's recorded
//      RunContext carries the imported persona -- the product's own prefix line and a sentence of
//      the persona's body -- with a `profile` source whose origin is `template` and whose sha256 is
//      the hash of the stored profile. That is what "the persona is in front of the model" means.
//   6. Teardown, in FK order, on every exit path.
//
// NEVER A MODEL CALL. The daemon is spawned with SLAVEOFAI_CLAUDE_BIN=node,
// SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8a-flow" and SLAVEOFAI_REQUIRE_FAKE_CLI=1
// (M32 item 7: lose the first two and the daemon refuses to start rather than falling back to the
// real binary).
//
// THE FIXTURE CATALOG IS COPIED TO A TEMP DIRECTORY FIRST, and stages 3 and 4 rewrite the COPY.
// The gate must never modify a file in this repository: a gate that leaves the working tree dirty
// is a gate that cannot be run twice, and `git status` after a green run has to be empty.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it; a
// failed assertion dumps every row this gate could have written and exits 1.
```

Body, in order:

1. **Constants and setup.** `FIXTURE_CATALOG = join(repoRoot, 'scripts/fixtures/catalog-m42')`,
   `CATALOG_NAME = 'catalog-m42'`, `WORKSPACE_NAME = 'M42 Catalog Project'`,
   `COMPANY_NAME = 'M42 Catalog Company'`, `COLLISION_NAME = 'Gate Collision Persona'`, and the two
   persona names `'Gate Core Builder'` / `'Gate Verifier'`. `preflightCleanup()` deletes a leftover
   workspace by name, the company by name, and every `SlaveTemplate` whose `sourceId` starts with
   `` `${CATALOG_NAME}/` `` plus the hand-made `COLLISION_NAME` row, and every `CatalogImport` whose
   `catalog` is `CATALOG_NAME`.
2. **The copy.** `cpSync(FIXTURE_CATALOG, catalogDir, { recursive: true })` into a
   `mkdtempSync(join(tmpdir(), 'slaveofai-gate-m42-catalog-'))`, and `catalogDir` is what every
   `import-catalog` call points at. Print the file list and the byte count of each.
3. **The hand-made collision.** `runCli(['create-template', '--name', COLLISION_NAME, '--role', 'backend', '--description', 'made by a person'])`, then read the row back and print it. This is the
   template stage 1's `name_taken` has to protect.
4. **Stage 1.** `runCli(['import-catalog', '--dir', catalogDir, '--by', 'gate'])`; print the whole
   stdout. Then assert, off the database rather than off the text:
   - exactly two rows with `sourceId` under this catalog, named `Gate Core Builder` and
     `Gate Verifier`, `role` `engineering` and `testing`, `sourceDivision` matching, `importedAt`
     not null, `defaultModel`/`provider` null, and for each `profileSha256 === goalSha256(profile)`
     and `profile.startsWith(importedProfilePrefix(sourceId, importedAt))`;
   - the hand-made `COLLISION_NAME` row is byte-identical to what stage 3 created (same `id`,
     `role` still `backend`, `profile` still null, `sourceId` still null);
   - exactly one `CatalogImport` row for this catalog, `by: 'gate'`, `{ created: 2, updated: 0, unchanged: 0, skipped: 3 }`, `finishedAt >= startedAt`, and its `report.skipped` reasons sorted
     equal to `['invalid_persona', 'name_taken', 'profile_too_long']`;
   - the `profile_too_long` skip's `detail` names a length greater than 16000.
5. **Stage 2.** Run the same command again. Assert `{ created: 0, updated: 0, unchanged: 2, skipped: 3 }` on the new `CatalogImport` row, and that both templates' `importedAt`, `profile` and
   `sourceSha256` are **identical** to the values read at the end of stage 1 (read them into
   variables there and compare here — an `updated` that claimed to be `unchanged` is exactly the bug
   this stage exists for).
6. **Stage 3.** Write an operator profile through the real CLI:
   `writeFileSync(editedPath, OPERATOR_PROFILE)` then
   `runCli(['set-profile', '--template', coreBuilderId, '--file', editedPath, '--by', 'gate'])`.
   Rewrite BOTH persona files in the copy (append a new sentence to each body, keeping the front
   matter). Import again. Assert:
   - `Gate Core Builder`'s `profile` is still exactly `OPERATOR_PROFILE`, its `sourceSha256` is
     still the stage-1 value (deliberately not advanced), and the report skips it `locally_edited`;
   - `Gate Verifier` is `updated`: its `profile` contains the new sentence, its `sourceSha256` is
     `goalSha256(readFileSync(verifierPath, 'utf8'))`, and `profileSha256 === goalSha256(profile)`;
   - the `CatalogImport` row reads `{ created: 0, updated: 1, unchanged: 0, skipped: 4 }`.
7. **Stage 4.** Record `await prisma.catalogImport.count()` and both templates' `updatedAt`-equivalent
   fields (`profile`, `sourceSha256`, `role`, `importedAt`) first. Then
   `runCli(['import-catalog', '--dir', catalogDir, '--role-map', 'engineering=backend,testing=reviewer', '--dry-run'])`
   — `--dry-run` LAST (erratum E11). Assert: the stdout contains `DRY RUN`, contains the drift line
   naming both `"testing"`'s stored role and `reviewer`; the `CatalogImport` count is unchanged; and
   every recorded template field is unchanged.
8. **Stage 5.** Through the real CLI: `create-company --name`, `add-team --company <id> --name Engineering`, `add-slave --team <id> --template <coreBuilderId> --name Core`, a second
   `add-team`/`add-slave` for the verifier, `create-workspace --name … --repo <makeRepo()> --verify true`, `assign-company --workspace <id> --company <id>`. Read the materialised `Slave` rows and
   print `role` and `runtimeRoles` — `runtimeRoles` must contain the template's role
   (`assignCompanyTx` copies it), which is what makes `--role-map` load-bearing at import time.
   Create one task with `prisma.task.create` (`status: 'ready'`, `requiredRole: 'engineering'`,
   `maxAttempts: 5`), spawn the daemon with the `m8a-flow` env, and `waitUntil` a `SlaveRun` for that
   task has a `RunContext` row. Then assert:
   - `runContextManifestSchema.parse(context.sections)` has a `profile` source with
     `origin === 'template'` and `sha256 === goalSha256(template.profile)`;
   - `context.prompt` contains `importedProfilePrefix(template.sourceId, template.importedAt)`;
   - `context.prompt` contains `'You write the module everything else stands on'` — a sentence of
     the persona's own body, which is the whole claim of this stage;
   - print the prompt in full before asserting any of it.
   Stop the daemon and prove it is gone the way `gate-m36-messaging.mjs` does (`findRealDaemonPids()`
   empty).
9. **Stage 6 / `finally`.** Stop every daemon, delete the workspace's events then the workspace, the
   company, every template with this catalog's `sourceId` and the hand-made collision row, every
   `CatalogImport` for this catalog, and `rmSync` both temp directories. Then
   `console.log('PASS: …')` and `exitCode = 0` at the end of the try, never earlier.

Import `goalSha256`, `importedProfilePrefix` and `runContextManifestSchema` from
`../packages/domain/dist/index.js`, and `prisma` from `../packages/db/dist/client.js`.

- [ ] **Step 4: Add the npm script**

In `package.json`, after the `gate:m41-scenario` line (the comma moves onto it):

```json
    "gate:m41-scenario": "tsc --build && node --env-file=.env scripts/gate-m41-scenario.mjs",
    "gate:m42-catalog-import": "tsc --build && node --env-file=.env scripts/gate-m42-catalog-import.mjs"
```

- [ ] **Step 5: Add it to CI**

In `.github/workflows/ci.yml`, immediately after line 70 (`- run: npm run gate:m41-scenario`):

```yaml
      - run: npm run gate:m42-catalog-import
```

- [ ] **Step 6: Run the gate until it is green**

```bash
npm run gate:m42-catalog-import
git status --short
```
Expected: `PASS:` and exit 0, and a **clean** `git status` — the gate rewrites its temp copy, never
`scripts/fixtures/catalog-m42`. Paste the gate's full output into the task report; the six stages'
printed values are the milestone's evidence.

- [ ] **Step 7: Write the README section**

In `README.md`, insert a new section immediately before `## The whole story`:

````markdown
## Importing a catalog

A team you already have written down does not have to be typed in again. Point the daemon at a
directory of persona files and they become templates:

```bash
npm run orchestrator -- import-catalog --dir /srv/personas --by you
npm run orchestrator -- import-catalog --dir /srv/personas --role-map engineering=backend --dry-run
npm run orchestrator -- list-imports
```

A persona is a Markdown file with a small front matter block — `name` is the only field that is
required — under a directory named for its division. The division becomes the template's role, and
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
````

- [ ] **Step 8: Update the "Tests and CI" roster**

In `README.md`'s "Tests and CI" section, replace

```
`gate:m39-supervisor-mailbox`, `gate:m40-requirement-versioning` and `gate:m41-scenario` on every
push
```

with

```
`gate:m39-supervisor-mailbox`, `gate:m40-requirement-versioning`, `gate:m41-scenario` and
`gate:m42-catalog-import` on every push
```

and replace

```
(`docs/scenarios/e2e-software-team.md`). That is 17 gates. Tests and gates share one Postgres — run
```

with

```
(`docs/scenarios/e2e-software-team.md`), and `m42` imports a directory of persona files into the
template catalog twice over — creating what is new, skipping what an operator has edited, updating
what changed on disk, and staffing a project from the result until the imported persona itself turns
up in a real run's recorded prompt. That is 18 gates. Tests and gates share one Postgres — run
```

- [ ] **Step 9: Full verification ladder**

Run these **in this order**, one at a time, with no `next dev` running anywhere and no other vitest
process alive (the shared test database truncates, and a running daemon breaks `subscribe.test.ts`):

```bash
npm run --silent typecheck
npm run gate:m26-vocabulary
npx vitest run
npm run web:build
npm run gate:m42-catalog-import
npm run gate:m41-scenario
npm run gate:m40-requirement-versioning
npm run gate:m39-supervisor-mailbox
npm run gate:m38-supervisor
npm run gate:m37-run-context
npm run gate:m36-messaging
npm run gate:m35-pipeline-honesty
npm run gate:m33-adopt
npm run gate:m11-shell
```

Expected: every one green. Known flakes, and what to do about them rather than around them:
`apps/orchestrator/test/integration/cli.test.ts`'s llm-decision row-count case doubles when anything
else touches the database — re-run that file alone before believing a failure. `web:build` must
never run while `next dev` is up; if the dev server was running, stop it, `rm -rf apps/web/.next`,
and restart it afterwards. Two of these gates now exercise a schema this milestone changed
(`m33-adopt` and `m41-scenario` both create templates), so a failure there is a real regression, not
a flake.

Paste the full output of `gate:m42-catalog-import` — the six stages and the recorded prompt included
— into the task report.

- [ ] **Step 10: Commit**

```bash
git add scripts/fixtures/catalog-m42 scripts/gate-m42-catalog-import.mjs package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
test(gates),docs: m42 t5 — gate:m42-catalog-import, and how to import a catalog

Six stages against a checked-in fixture catalog copied to a temp directory: a first import creates
two and skips three with the three reasons R2 names; the same import again changes nothing; an
operator's own profile edit survives a rewritten source file while the file beside it updates; a
--role-map dry run prints the translation it would have made and writes nothing; and a company built
from the two imported templates is assigned to a workspace until a real daemon's run records a
prompt carrying the imported persona's own words. The fixture catalog is written in this project's
vocabulary and is deliberately NOT on gate:m26-vocabulary's exclude list -- it is the proof that a
clean catalog is writable.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

## Self-review

**Spec coverage.** §1's seven bullets: the pure-domain boundary → Task 2 (`packages/domain/src/catalog/persona.ts`, no `node:fs`, no `node:crypto`, erratum E13) with the walk in Task 4 and the rows in Task 3; **R1** provenance → Task 2's schema and migration, plus `profileSha256` (erratum E2); **R2** the per-row policy → Task 3, one case per branch (a)–(g) plus the cleared-profile case, the never-deletes case and the one-bad-row case; **R3** role-is-the-division and null model/provider → Task 2's `personaToTemplate` and Task 3's assertion that `defaultModel`/`provider` stay null, with `--role-map` at creation only (erratum E10); **R4** the labelled persona text → `importedProfilePrefix`, asserted in Tasks 2, 3 and 5, and the vocabulary-clean fixture catalog in Task 5 Step 2; **R5** the recorded import → Task 2's `CatalogImport` (column `by`, erratum E4) and Task 3's counters/report, read by Task 4's `list-imports` and web panel; **R6** the M41 residuals (a)–(d) → Task 1, each with its own test, (c) as a pinning test only (erratum E8); the closing bullet (no real model call, one vitest, `web:build` last, vocabulary, two migrations only, `ok()/err()`, a refusal after a write throws) → Global Constraints, and the throw is `CatalogRowRefused` in Task 3. §2's four surfaces → Tasks 2 (domain), 3 (control), 4 (CLI and web, corrected to the projects page by erratum E1) and the gate → Task 5. §3's out-of-scope list is respected: `tools:` is kept in `meta` and acted on nowhere; colour and emoji are kept in `meta` and rendered nowhere; nothing is summarised or truncated; there is no web upload form and Task 4's component says why; no company is created by an import; the source catalog is not vendored and is never named in a tracked file (erratum E5).

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Every code step carries its code. Task 5's gate is the one step written as a numbered specification rather than 600 lines of JavaScript: it names the file it borrows each helper from, the exact assertions per stage, the exact CLI invocations and the exact rows to compare — retyping `dumpGateRows`/`waitUntil`/`spawnDaemon` here would risk a silent divergence from the shape every other gate's failure report uses, which is the same judgment the M41 plan recorded for the same helpers. Two steps say "read the file first and follow what it actually supports" (`DataTable`'s `Row` props in Task 4, the events test's existing case shape in Task 1); both name the file, the reason and the fallback.

**Type consistency.** `sourceId`, `sourceSha256`, `sourceDivision`, `profileSha256`, `importedAt` are spelled identically in the schema (Task 2), the control verb (Task 3), `listTemplates` and `TemplateRow` (Task 4) and the gate (Task 5). `ImportReport`'s four arrays are `created`/`updated`/`unchanged`/`skipped` everywhere, and `SkipReason`'s four members — `name_taken`, `locally_edited`, `profile_too_long`, `invalid_persona` — are the same four in the control tests, the CLI's printer, the gate's sorted assertion and the README. `personaToTemplate`'s bag is `{ catalog, division, slug, text, importedAt, roleMap? }` in Task 2's interface block, Task 2's implementation, and Task 3's call site. `importedProfilePrefix(sourceId, importedAt)` takes the same two arguments in all four places it appears. `readCatalogDirectory(dir, { catalog?, divisions? })` returns `{ catalog, entries }` in Task 4's interface block, its implementation, its test and the CLI case. `unblockTask` returns `Result<{ status }, ControlRefusal>` in Task 1's interface block, its implementation, its four tests and the CLI's print line. `REVIEW_RETRY_CAP` is imported from `@slave-of-ai/domain` in `review.ts`, `unblock.ts` and `unblock.test.ts`, and defined once. `SweepReport.strandedClaims` is named identically in the interface, `sweep()`'s return, `daemon.ts`'s log condition and the five sweep tests.
