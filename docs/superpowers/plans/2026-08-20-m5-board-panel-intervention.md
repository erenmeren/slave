# M5: Task Board, Agent Detail, and Intervention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator intervenes from the browser — pause a live run, queue an instruction,
resume, stop — plus the Tasks board and the agent detail side panel.

**Architecture:** A new `packages/control` package holds the intervention claim semantics the M3
CLI proved; the CLI and new web POST routes both call it. The web records intents; the daemon
executes anything that owns a process (resume's spawn). Two new UI surfaces (Tasks board, agent
side panel) ride M4's hybrid liveness rule via a hook extraction.

**Tech Stack:** TypeScript, Prisma/Postgres, Next.js 15 App Router, Tailwind v4, vitest +
testing-library, zod.

**Spec:** `docs/superpowers/specs/2026-08-20-m5-board-panel-intervention-design.md`

## Global Constraints

- `apps/web` never writes through Prisma directly; every mutation goes through `packages/control`
  (spec §1). Reads stay unrestricted.
- `packages/control` never imports `packages/providers` and never spawns an agent process (§2).
- The web never claims `paused → resuming` — resume is an intent; the daemon claims and spawns in
  the same process (§3.3, sweep-orphan reasoning).
- Messages: one overwritable slot (`queuedMessage`), writable only while `paused`, consumed on
  resume (§3.3, §10).
- Every control claim is an `updateMany` conditioned on the status it requires (§9).
- Control refusals map to HTTP 409 with the refusal text as body; route-level workspace mismatch
  is 404 (§4).
- No optimistic UI: after any POST the event-driven refetch is the source of truth (§4, §7).
- All M4 `useOverview` behaviours survive the hook extraction unchanged — the existing test file
  stays green without edits (§7, §11).
- All new motion respects `prefers-reduced-motion` (§8).
- Tests: TDD; unit tests under `<pkg>/test/`, integration (real Postgres) under
  `<pkg>/test/integration/` (vitest picks both up by glob). Run a focused file with
  `npx vitest run <path>`; the full gate is `npm test && npm run typecheck`.
- Commits: conventional prefixes as in the log (`feat(control): …`, `fix(web): …`).

---

### Task 1: `packages/control` scaffold with the moved mechanics (`runFilePaths`, kill helpers)

**Files:**
- Create: `packages/control/package.json`, `packages/control/tsconfig.json`,
  `packages/control/tsconfig.test.json`
- Create: `packages/control/src/index.ts`, `packages/control/src/paths.ts`,
  `packages/control/src/kill.ts`
- Create: `packages/control/test/paths.test.ts`, `packages/control/test/integration/kill.test.ts`
- Modify: `tsconfig.json` (root — add the reference), `package.json` (root — typecheck script),
  `apps/orchestrator/src/tick.ts` (import `runFilePaths` from control, delete the local copy),
  `apps/orchestrator/src/cli.ts` (import kill helpers, delete local copies),
  `apps/orchestrator/package.json` (dependency)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks import these from `@ai-team-os/control`):
  - `runFilePaths(repoPath: string, runId: RunId): { settingsPath: string; pauseFlagPath: string }`
  - `isAlive(pid: number | null): boolean`
  - `signalRun(pid: number | null, signal: NodeJS.Signals): boolean`
  - `killWithEscalation(pid: number | null, graceMs?: number): Promise<boolean>` — SIGTERM,
    wait `graceMs` (default 2000), SIGKILL if still alive; returns whether anything was signalled.

- [ ] **Step 1: Scaffold the package**

`packages/control/package.json` (the `events` package is the template):

```json
{
  "name": "@ai-team-os/control",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@ai-team-os/db": "*",
    "@ai-team-os/domain": "*",
    "@ai-team-os/events": "*"
  }
}
```

`packages/control/tsconfig.json` — copy `packages/events/tsconfig.json` verbatim and fix the
references to `../domain`, `../db`, `../events`. `tsconfig.test.json` — copy the events one, same
edit. Root `tsconfig.json`: add `{ "path": "packages/control" }` after `packages/events`. Root
`package.json` `typecheck` script: add `tsc -p packages/control/tsconfig.test.json` after the
events entry. Run `npm install` to link the workspace.

- [ ] **Step 2: Write the failing unit test for the moved path derivation**

`packages/control/test/paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { runId } from '@ai-team-os/domain'
import { runFilePaths } from '../src/paths.js'

describe('runFilePaths', () => {
  it('derives both control-file paths from the repo path and run id', (): void => {
    const paths = runFilePaths('/repo', runId('11111111-1111-4111-8111-111111111111'))
    expect(paths.pauseFlagPath).toContain('11111111-1111-4111-8111-111111111111')
    expect(paths.settingsPath).toContain('11111111-1111-4111-8111-111111111111')
    expect(paths.pauseFlagPath).not.toBe(paths.settingsPath)
  })
})
```

Run: `npx vitest run packages/control/test/paths.test.ts` — FAIL (module not found).

- [ ] **Step 3: Move `runFilePaths`**

Cut the function (with its doc comment) from `apps/orchestrator/src/tick.ts:119` into
`packages/control/src/paths.ts` unchanged; export it from `src/index.ts`. In `tick.ts` add
`import { runFilePaths } from '@ai-team-os/control'` and delete the local definition — but keep
`tick.ts`'s re-export if other modules import it from there (`cli.ts` does:
`import { drainPumps, runFilePaths, tick } from './tick.js'`). Change `cli.ts` to import
`runFilePaths` from `@ai-team-os/control` instead, and remove it from the `tick.js` import list.
Add `"@ai-team-os/control": "*"` to `apps/orchestrator/package.json` dependencies and the
project reference to `apps/orchestrator/tsconfig.json`.

- [ ] **Step 4: Move the kill helpers**

`packages/control/src/kill.ts` — move `isAlive`, `signalRun`, and the grace constant from
`apps/orchestrator/src/cli.ts:148-168` verbatim, then add:

```ts
export const KILL_GRACE_MS = 2_000

/** SIGTERM, a grace period, then SIGKILL if the process survived. Returns whether anything was signalled. */
export async function killWithEscalation(pid: number | null, graceMs: number = KILL_GRACE_MS): Promise<boolean> {
  const signalled = signalRun(pid, 'SIGTERM')
  if (signalled) {
    await new Promise((res) => setTimeout(res, graceMs))
    if (isAlive(pid)) signalRun(pid, 'SIGKILL')
  }
  return signalled
}
```

Export all from `src/index.ts`. In `cli.ts`, replace the local definitions and the inline
SIGTERM/grace/SIGKILL sequence in `case 'cancel'` with `const signalled = await
killWithEscalation(run.pid)`.

- [ ] **Step 5: Write the failing integration test for escalation**

`packages/control/test/integration/kill.test.ts`:

```ts
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { isAlive, killWithEscalation } from '../../src/kill.js'

describe('killWithEscalation', () => {
  it('SIGKILLs a child that ignores SIGTERM', async (): Promise<void> => {
    const child = spawn('node', ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'])
    await new Promise((res) => child.once('spawn', res))
    const signalled = await killWithEscalation(child.pid ?? null, 300)
    expect(signalled).toBe(true)
    await new Promise((res) => setTimeout(res, 200))
    expect(isAlive(child.pid ?? null)).toBe(false)
  })

  it('reports false for a pid that is already gone', async (): Promise<void> => {
    expect(await killWithEscalation(null)).toBe(false)
  })
})
```

- [ ] **Step 6: Build and verify**

Run: `npm test` (the CLI integration suite is the equivalence bar — `cancel` and `pause` tests
must pass unchanged) and `npm run typecheck`. Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(control): extract runFilePaths and the kill escalation into packages/control"
```

---

### Task 2: The resume intent — schema columns, `run.resume_requested` event, migration

**Files:**
- Modify: `packages/domain/src/events/schema.ts`, `packages/db/src/enums.ts`,
  `packages/db/prisma/schema.prisma`
- Create: migration via `npx prisma migrate dev --name m5_resume_intent` (run from the repo root
  with the schema flag the other migrations used — check `packages/db/package.json` scripts for
  the exact invocation, e.g. `npm run db:migrate:dev -- --name m5_resume_intent` if it exists)
- Test: `packages/domain/test/events/schema.test.ts` (extend),
  `packages/db/test/integration/enum-parity.test.ts` (passes untouched — it derives)

**Interfaces:**
- Produces: event type `run.resume_requested` with payload
  `{ requestedBy: string; message: string | null }`; `AgentRun.resumeRequestedAt: DateTime?` and
  `AgentRun.queuedMessage: String?` columns.

- [ ] **Step 1: Write the failing domain test**

Add to `packages/domain/test/events/schema.test.ts` (match the file's existing envelope fixture —
reuse its helper for the envelope fields):

```ts
it('accepts run.resume_requested with an optional message', () => {
  const parsed = executionEventSchema.parse({
    ...envelopeFixture, // the file's existing valid-envelope object
    type: 'run.resume_requested',
    payload: { requestedBy: 'operator', message: 'also create EXTRA.md' },
  })
  expect(parsed.type).toBe('run.resume_requested')
})

it('accepts run.resume_requested with a null message', () => {
  const parsed = executionEventSchema.parse({
    ...envelopeFixture,
    type: 'run.resume_requested',
    payload: { requestedBy: 'operator', message: null },
  })
  expect(parsed.payload).toEqual({ requestedBy: 'operator', message: null })
})
```

Run: `npx vitest run packages/domain/test/events/schema.test.ts` — FAIL (invalid discriminator).

- [ ] **Step 2: Add the union member**

In `packages/domain/src/events/schema.ts`, next to `run.pause_requested` (line ~54):

```ts
z.object({
  ...envelope,
  type: z.literal('run.resume_requested'),
  payload: z.object({ requestedBy: z.string(), message: z.string().nullable() }),
}),
```

- [ ] **Step 3: Map it in the DB enum layer**

`packages/db/src/enums.ts` — add `'run.resume_requested': 'run_resume_requested',` to
`EVENT_TYPE_BY_DOMAIN_TYPE` (the `satisfies` clause forces this; the build fails until it's
there). If the file has a reverse map, extend it the same way.

- [ ] **Step 4: Schema + migration**

`packages/db/prisma/schema.prisma`:
- `EventType` enum: add `run_resume_requested @map("run.resume_requested")` next to
  `run_resumed`.
- `model AgentRun`: after `pauseReason`, add:

```prisma
  /// Resume intent (spec M5 §3.3): set by the web/control layer while the run stays `paused`;
  /// the daemon's tick claims paused→resuming and clears both in the same update. The run must
  /// never sit in `resuming` without a process — the orphan sweep would destroy it.
  resumeRequestedAt DateTime?
  queuedMessage     String?
```

Generate the migration, then `npm run db:generate`.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck`. The enum-parity integration test proves the DB enum and the
domain union still match; everything else proves nothing broke.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(domain,db): add the resume intent columns and run.resume_requested event"
```

---

### Task 3: Control operations — `requestPause`, `requestStop`, refusal taxonomy

**Files:**
- Create: `packages/control/src/refusal.ts`, `packages/control/src/pause.ts`,
  `packages/control/src/stop.ts`
- Modify: `packages/control/src/index.ts`, `apps/orchestrator/src/cli.ts` (pause and cancel cases
  become callers)
- Test: `packages/control/test/integration/pause.test.ts`,
  `packages/control/test/integration/stop.test.ts`

**Interfaces:**
- Consumes: Task 1's `runFilePaths`, `killWithEscalation`; `Result`/`ok`/`err` from
  `@ai-team-os/domain`; `appendEvent` from `@ai-team-os/events`; `prisma` from
  `@ai-team-os/db/client`.
- Produces:

```ts
// refusal.ts
export type ControlRefusal =
  | { readonly kind: 'run_not_found'; readonly runId: string }
  | { readonly kind: 'wrong_status'; readonly runId: string; readonly status: string; readonly needed: readonly string[] }
  | { readonly kind: 'workspace_halted'; readonly workspaceId: string; readonly reason: string }
  | { readonly kind: 'no_checkpoint'; readonly runId: string }
export function refusalText(refusal: ControlRefusal): string
// pause.ts
export async function requestPause(runId: string, requestedBy: string): Promise<Result<void, ControlRefusal>>
// stop.ts
export async function requestStop(runId: string, requestedBy: string): Promise<Result<void, ControlRefusal>>
```

- [ ] **Step 1: Write the failing pause integration tests**

`packages/control/test/integration/pause.test.ts` — follow the DB fixture conventions of
`packages/db/test/integration/work.test.ts` (its helpers seed workspace/team/agent/task/run rows;
copy its beforeEach truncation pattern):

```ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { runFilePaths } from '../../src/paths.js'
import { requestPause } from '../../src/pause.js'
// + the repo's existing integration seeding helpers

describe('requestPause', () => {
  // beforeEach: truncate + seed a workspace whose repoPath is a fresh mkdtemp dir,
  // one agent, one task, one run with status 'working'.

  it('claims the run, writes the flag file where the gate reads, and appends the event', async () => {
    const result = await requestPause(run.id, 'meren')
    expect(result.ok).toBe(true)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('human')
    const { pauseFlagPath } = runFilePaths(workspace.repoPath, run.id)
    expect(readFileSync(pauseFlagPath, 'utf8')).toBe('meren\n')
    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_pause_requested' }, orderBy: { seq: 'desc' },
    })
    expect(event?.payload).toEqual({ requestedBy: 'meren' })
    expect(event?.actor).toBe('human')
  })

  it('refuses a run that already concluded, and writes nothing', async () => {
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'succeeded' } })
    const result = await requestPause(run.id, 'meren')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('wrong_status')
    const { pauseFlagPath } = runFilePaths(workspace.repoPath, run.id)
    expect(existsSync(pauseFlagPath)).toBe(false)
  })

  it('refuses an unknown run id', async () => {
    const result = await requestPause('00000000-0000-4000-8000-000000000000', 'meren')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('run_not_found')
  })
})
```

Run — FAIL (module not found).

- [ ] **Step 2: Implement `refusal.ts` and `pause.ts`**

`requestPause` is the CLI `case 'pause'` body (cli.ts:246-285) verbatim, reshaped: `findUnique`
(with task) → `run_not_found`; `updateMany` claim on `{starting, working, resuming}` →
`wrong_status` carrying the live status and the needed list; then the workspace lookup, the flag
file write (`writeFileSync(pauseFlagPath, `${requestedBy}\n`)`), and the `appendEvent` — all
copied, comments included. `refusalText`:

```ts
export function refusalText(refusal: ControlRefusal): string {
  switch (refusal.kind) {
    case 'run_not_found': return `no run with id ${refusal.runId}`
    case 'wrong_status': return `run ${refusal.runId} is ${refusal.status}; this needs one of: ${refusal.needed.join(', ')}`
    case 'workspace_halted': return `this workspace is halted (${refusal.reason}). Nothing will run until an operator retracts it with: clear-halt --workspace ${refusal.workspaceId}`
    case 'no_checkpoint': return `run ${refusal.runId} has no checkpoint: there is nothing to resume it from`
  }
}
```

- [ ] **Step 3: Write the failing stop integration tests**

`packages/control/test/integration/stop.test.ts` — same fixtures, plus a real child process:

```ts
it('kills the process, concludes the run, blocks the task, appends run.stopped', async () => {
  const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'])
  await new Promise((res) => child.once('spawn', res))
  await prisma.agentRun.update({ where: { id: run.id }, data: { pid: child.pid } })
  await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: run.id } })

  const result = await requestStop(run.id, 'meren')
  expect(result.ok).toBe(true)
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.status).toBe('stopped')
  expect(after.endedAt).not.toBeNull()
  const taskAfter = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
  expect(taskAfter.status).toBe('blocked')
  expect(taskAfter.activeRunId).toBeNull()
  await new Promise((res) => setTimeout(res, 100))
  expect(isAlive(child.pid ?? null)).toBe(false)
})

it('still concludes a run whose process is already gone', async () => {
  await prisma.agentRun.update({ where: { id: run.id }, data: { pid: 999_999_999 } })
  const result = await requestStop(run.id, 'meren')
  expect(result.ok).toBe(true)
  const event = await prisma.executionEvent.findFirst({ where: { runId: run.id, type: 'run_stopped' } })
  expect((event?.payload as { reason: string }).reason).toContain('no live process')
})
```

- [ ] **Step 4: Implement `stop.ts`**

The CLI `case 'cancel'` body (cli.ts:398-437), reshaped: `run_not_found` on missing run;
`killWithEscalation(run.pid)`; the `updateMany` on `endedAt: null` (keep — it is the idempotence
guard); the task `updateMany` to `blocked` conditioned on `activeRunId: run.id`; the
`run.stopped` event with the same two reason strings, `requestedBy` folded into them
(`cancelled by ${requestedBy}`). Note: `requestStop` does not refuse a concluded run — the CLI
never did; the `endedAt: null` guard makes the second call a no-op that still reports ok. Keep
that contract and say so in a comment.

- [ ] **Step 5: Rewire the CLI**

`case 'pause'`: body becomes

```ts
const result = await requestPause(requireFlag(flags, 'run'), flags['by'] ?? 'operator')
if (!result.ok) throw new Error(refusalText(result.error))
process.stdout.write(`pause_requested: the gate will deny ${requireFlag(flags, 'run')}'s next tool call\n`)
return 0
```

`case 'cancel'` likewise over `requestStop` (keep the CLI's closing
`stopped …; its worktree is preserved` line). Delete the now-dead local code.

- [ ] **Step 6: Verify equivalence**

Run: `npm test && npm run typecheck`. The CLI integration tests (`cli.test.ts` pause/cancel
cases) are the bar: same observable transcript, zero test edits.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(control): extract pause and stop into shared control operations"
```

---

### Task 4: Resume as an intent — `requestResume`, `updateQueuedMessage`, daemon execution

**Files:**
- Create: `packages/control/src/resume.ts`, `apps/orchestrator/src/resume.ts`
- Modify: `packages/control/src/index.ts`, `apps/orchestrator/src/tick.ts` (resume pass),
  `apps/orchestrator/src/cli.ts` (resume case reuses both pieces)
- Test: `packages/control/test/integration/resume-intent.test.ts`,
  `apps/orchestrator/test/integration/resume-execution.test.ts`

**Interfaces:**
- Consumes: Task 2's columns/event; Task 3's refusal type; the CLI resume body (cli.ts:289-397)
  as the extraction source; `pumpRun`, `verifyConcludedRun`, `pumps` set from the orchestrator.
- Produces:

```ts
// packages/control/src/resume.ts
export async function requestResume(runId: string, message: string | null, requestedBy: string): Promise<Result<void, ControlRefusal>>
export async function updateQueuedMessage(runId: string, message: string): Promise<Result<void, ControlRefusal>>
/** Daemon/CLI side: atomically claim paused→resuming, clearing and returning the intent. */
export async function claimResume(runId: string): Promise<{ claimed: boolean; queuedMessage: string | null }>
// apps/orchestrator/src/resume.ts
export async function executeResume(options: { runId: string; adapter: AgentRuntimeAdapter; message: string | null }): Promise<void>
```

- [ ] **Step 1: Write the failing intent tests**

`packages/control/test/integration/resume-intent.test.ts` (fixtures as in Task 3, run seeded
`paused` with a full checkpoint row — copy the checkpoint fixture from
`packages/db/test/integration/checkpoint.test.ts`):

```ts
it('records the intent and the event; the run stays paused', async () => {
  const result = await requestResume(run.id, 'also create EXTRA.md', 'meren')
  expect(result.ok).toBe(true)
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.status).toBe('paused')            // NEVER resuming from here (sweep safety)
  expect(after.resumeRequestedAt).not.toBeNull()
  expect(after.queuedMessage).toBe('also create EXTRA.md')
  const event = await prisma.executionEvent.findFirst({ where: { runId: run.id, type: 'run_resume_requested' } })
  expect(event?.payload).toEqual({ requestedBy: 'meren', message: 'also create EXTRA.md' })
})

it('keeps an already-queued message when resume is requested without one', async () => {
  await updateQueuedMessage(run.id, 'first instruction')
  await requestResume(run.id, null, 'meren')
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.queuedMessage).toBe('first instruction')
})

it('refuses when the workspace is halted', async () => {
  await prisma.workspace.update({ where: { id: workspace.id }, data: { haltedReason: 'gate failure', haltedAt: new Date() } })
  const result = await requestResume(run.id, null, 'meren')
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.kind).toBe('workspace_halted')
})

it('refuses a run that is not paused / has no checkpoint', async () => {
  await prisma.checkpoint.delete({ where: { runId: run.id } })
  expect((await requestResume(run.id, null, 'meren')).ok).toBe(false)
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'working' } })
  const result = await requestResume(run.id, null, 'meren')
  if (!result.ok) expect(result.error.kind).toBe('wrong_status')
})

it('claimResume flips paused→resuming and hands back the message exactly once', async () => {
  await requestResume(run.id, 'do the thing', 'meren')
  const first = await claimResume(run.id)
  expect(first).toEqual({ claimed: true, queuedMessage: 'do the thing' })
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.status).toBe('resuming')
  expect(after.resumeRequestedAt).toBeNull()
  expect(after.queuedMessage).toBeNull()
  expect((await claimResume(run.id)).claimed).toBe(false)
})

it('updateQueuedMessage refuses when the run is not paused', async () => {
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'working' } })
  expect((await updateQueuedMessage(run.id, 'x')).ok).toBe(false)
})
```

- [ ] **Step 2: Implement `packages/control/src/resume.ts`**

`requestResume`: `findUnique` run (include task) → `run_not_found`; workspace halted →
`workspace_halted` (same lookup the CLI does); `checkpoint.findUnique` → `no_checkpoint`;
`updateMany` where `{ id, status: 'paused' }` setting `resumeRequestedAt: new Date()` and, only
when `message !== null`, `queuedMessage: message` → zero rows is `wrong_status`; then
`appendEvent({ type: 'run.resume_requested', actor: 'human', payload: { requestedBy, message } })`
with the envelope ids from the loaded run. `updateQueuedMessage`: `updateMany` where
`{ id, status: 'paused' }` set `queuedMessage` → zero rows is `wrong_status` (or
`run_not_found` when the run does not exist — check with a read first). `claimResume`:

```ts
export async function claimResume(runId: string): Promise<{ claimed: boolean; queuedMessage: string | null }> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId }, select: { queuedMessage: true } })
    const claimed = await tx.agentRun.updateMany({
      where: { id: runId, status: 'paused', resumeRequestedAt: { not: null } },
      data: { status: 'resuming', resumeRequestedAt: null, queuedMessage: null },
    })
    return claimed.count === 1
      ? { claimed: true, queuedMessage: run?.queuedMessage ?? null }
      : { claimed: false, queuedMessage: null }
  })
}
```

(The CLI's direct `resume --run` also claims through `claimResume` — but a CLI resume with no
prior intent must still work, so the CLI path first calls
`prisma.agentRun.updateMany({ where: { id, status: 'paused' }, data: { status: 'resuming' } })`
exactly as today when `claimResume` reports unclaimed. Keep both paths in the CLI case; see
Step 4.)

- [ ] **Step 3: Extract `executeResume`**

`apps/orchestrator/src/resume.ts`: the CLI resume body from `const checkpoint = …` **after** the
claim (cli.ts:302 onward) moves here verbatim — checkpoint load (throw if missing: by the time
this runs the claim held, so a missing checkpoint is a bug worth crashing the caller on),
`adapter.resume(...)` with the full checkpoint mapping, the `agentRun.update` (pid, clear
pauseReason/pausedAtStep), the `run.resumed` event, `pumpRun({ …, resumed: true, spawn: … })`,
`await pumped`, `verifyConcludedRun`. Signature as in Interfaces; the CLI case and the tick both
call it.

- [ ] **Step 4: Rewire the CLI resume case**

Order: halt check (now via the loaded workspace, same wording — or just call `requestResume`?
No: the CLI is synchronous and should not leave an intent behind on the failure paths), then
checkpoint presence check, then claim — `claimResume` first (an operator resuming a run the web
queued picks up the queued message), fall back to the plain paused→resuming `updateMany` when
unclaimed, error if that claims zero. Message precedence: an explicit `--message` beats the
queued one. Then `executeResume({ runId, adapter: buildAdapter(), message })` and the existing
stdout lines.

- [ ] **Step 5: Write the failing daemon-execution tests**

`apps/orchestrator/test/integration/resume-execution.test.ts` — model on the existing
`cli.test.ts`/`tick.test.ts` fixtures (fake adapter via `AITEAMOS_CLAUDE_BIN`; those tests show
the exact env and seeding):

```ts
it('a paused run with an intent resumes on tick, with the queued message injected', async () => {
  // seed: paused run + checkpoint (fixture 'complete'), requestResume(run.id, 'MARKER-42', 'web')
  await tick({ workspaceId, adapter, hookPath })
  await drainPumps()
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(['working', 'succeeded']).toContain(after.status) // the fake concludes fast
  const resumed = await prisma.executionEvent.findFirst({ where: { runId: run.id, type: 'run_resumed' } })
  expect(resumed).not.toBeNull()
  // the fake adapter script records its argv/stdin; assert MARKER-42 reached it the same way
  // adapter-resume.test.ts asserts message injection — reuse that fixture's mechanism.
})

it('does not pick up an intent in a halted workspace', async () => {
  // seed intent, then halt the workspace
  await tick({ workspaceId, adapter, hookPath })
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.status).toBe('paused')
  expect(after.resumeRequestedAt).not.toBeNull() // still visible, still waiting
})

it('a paused run with an intent survives an orphan sweep untouched', async () => {
  // seed intent; run reconcileOrphans (import from sweep.ts) before any tick
  await reconcileOrphans(workspaceId)
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.status).toBe('paused') // the whole point of intent-not-claim
})
```

- [ ] **Step 6: Implement the tick resume pass**

In `apps/orchestrator/src/tick.ts`, after the existing start pass and inside the same
halted-workspace guard the start path honours (if `tick` bails early on a halt, the resume pass
must sit after that bail):

```ts
// Resume intents (spec M5 §3.3): the web records them; this process — the one that can own a
// child — claims and spawns. Claim and spawn in the same process closes the orphan window to
// the width the CLI's always had.
const intents = await prisma.agentRun.findMany({
  where: { status: 'paused', resumeRequestedAt: { not: null }, task: { workspaceId } },
  select: { id: true },
})
for (const intent of intents) {
  const { claimed, queuedMessage } = await claimResume(intent.id)
  if (!claimed) continue // a CLI resume or a second tick got there first
  const pumped = executeResume({ runId: intent.id, adapter, message: queuedMessage })
  pumps.add(pumped)
  void pumped.catch(() => {}).finally(() => pumps.delete(pumped))
}
```

(Match the file's real pump-tracking idiom — copy how the start pass registers into `pumps`,
including its error logging, rather than inventing a second pattern.)

- [ ] **Step 7: Verify**

Run: `npm test && npm run typecheck`. The existing CLI resume tests
(`resumes a paused run in its own worktree, session and identity`) are the equivalence bar.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(control,orchestrator): resume as a web intent the daemon executes"
```

---

### Task 5: Web POST routes — pause, resume, stop, message

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/runs/[runId]/pause/route.ts`, and siblings
  `resume/route.ts`, `stop/route.ts`, `message/route.ts`
- Create: `apps/web/src/server/controlRoute.ts` (the shared shell)
- Modify: `apps/web/package.json` (+ `"@ai-team-os/control": "*"`), `apps/web/tsconfig.json`
  (project reference)
- Test: `apps/web/test/integration/control-routes.test.ts`

**Interfaces:**
- Consumes: Task 3/4's `requestPause`, `requestStop`, `requestResume`, `updateQueuedMessage`,
  `refusalText`.
- Produces: the four POST endpoints of spec §4. Success: `{ ok: true }` (200). Refusal: 409,
  body `{ error: refusalText }`. Wrong workspace or unknown run: 404.

- [ ] **Step 1: Write the failing route tests**

`apps/web/test/integration/control-routes.test.ts` — follow
`apps/web/test/integration/routes.test.ts`'s pattern (it imports route handlers directly and
calls `POST(request, { params: Promise.resolve({...}) })`):

```ts
it('pauses a working run and returns 200', async () => {
  const response = await pausePOST(new Request('http://x', { method: 'POST' }),
    { params: Promise.resolve({ workspaceId: workspace.id, runId: run.id }) })
  expect(response.status).toBe(200)
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.status).toBe('pause_requested')
})

it('maps a control refusal to 409 with the refusal text', async () => {
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'succeeded' } })
  const response = await pausePOST(/* as above */)
  expect(response.status).toBe(409)
  expect((await response.json()).error).toContain('succeeded')
})

it('404s a run that belongs to another workspace', async () => {
  const response = await pausePOST(new Request('http://x', { method: 'POST' }),
    { params: Promise.resolve({ workspaceId: otherWorkspace.id, runId: run.id }) })
  expect(response.status).toBe(404)
})

it('resume accepts an optional message body and records the intent', async () => {
  // run seeded paused + checkpoint
  const response = await resumePOST(new Request('http://x', {
    method: 'POST', body: JSON.stringify({ message: 'EXTRA.md please' }),
    headers: { 'content-type': 'application/json' },
  }), { params: Promise.resolve({ workspaceId: workspace.id, runId: run.id }) })
  expect(response.status).toBe(200)
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.queuedMessage).toBe('EXTRA.md please')
  expect(after.status).toBe('paused')
})

it('message updates the queued instruction while paused and 409s otherwise', async () => {
  // run seeded paused
  const post = (body: unknown) => messagePOST(new Request('http://x', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }), { params: Promise.resolve({ workspaceId: workspace.id, runId: run.id }) })
  expect((await post({ message: 'queued while paused' })).status).toBe(200)
  expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).queuedMessage).toBe('queued while paused')
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'working' } })
  expect((await post({ message: 'too late' })).status).toBe(409)
})

it('message 400s when the body has no message string', async () => {
  const response = await messagePOST(new Request('http://x', { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ workspaceId: workspace.id, runId: run.id }) })
  expect(response.status).toBe(400)
})

it('stop concludes the run and blocks the task through the route', async () => {
  await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: run.id } })
  const response = await stopPOST(new Request('http://x', { method: 'POST' }),
    { params: Promise.resolve({ workspaceId: workspace.id, runId: run.id }) })
  expect(response.status).toBe(200)
  expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('stopped')
  expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('blocked')
})
```

- [ ] **Step 2: Implement the shared shell**

`apps/web/src/server/controlRoute.ts`:

```ts
import { prisma } from '@ai-team-os/db/client'
import { refusalText, type ControlRefusal } from '@ai-team-os/control'
import type { Result } from '@ai-team-os/domain'

/** Route shell: 404 unless the run exists in this workspace, 409 on a control refusal. */
export async function runControlResponse(
  workspaceId: string,
  runId: string,
  operate: () => Promise<Result<void, ControlRefusal>>,
): Promise<Response> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { task: { select: { workspaceId: true } } } })
  if (run === null || run.task.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such run in this workspace' }, { status: 404 })
  }
  const result = await operate()
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
```

Each route is then three lines, e.g. `pause/route.ts`:

```ts
import { requestPause } from '@ai-team-os/control'
import { runControlResponse } from '../../../../../../../server/controlRoute'

export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; runId: string }> },
): Promise<Response> {
  const { workspaceId, runId } = await context.params
  return runControlResponse(workspaceId, runId, () => requestPause(runId, 'web operator'))
}
```

`resume/route.ts` parses the body first (`message` is optional; a malformed body reads as no
message, not a 500 — same not-ours-to-crash-over rule); `message/route.ts` 400s on a missing
`message` string. Count the `../` segments carefully — the route sits two dynamic segments deep.

- [ ] **Step 3: Verify** — run the new test file, then `npm test && npm run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): POST routes for pause, resume, stop and message over packages/control"
```

---

### Task 6: Tasks snapshot read model and GET route

**Files:**
- Create: `apps/web/src/server/tasks.ts`,
  `apps/web/src/app/api/w/[workspaceId]/tasks/route.ts`
- Test: `apps/web/test/integration/tasks-snapshot.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TaskRunSummary {
  readonly id: string
  readonly status: RunStatus            // from '@ai-team-os/domain'
  readonly costUsd: number
  readonly toolCalls: number
  readonly startedAt: string            // ISO
  readonly endedAt: string | null
  readonly checkpoint: { readonly pausedAtStep: number | null; readonly sessionId: string; readonly dirtyFileCount: number } | null
}
export interface TaskBoardItem {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  readonly priority: number
  readonly attempt: number
  readonly maxAttempts: number
  readonly assigneeName: string | null  // the live run's agent, else null
  readonly branch: string | null
  readonly lastRejectionReason: string | null
  readonly runs: readonly TaskRunSummary[]   // newest first
}
export interface TasksSnapshot {
  readonly workspace: { readonly id: string; readonly name: string; readonly haltedReason: string | null }
  readonly tasks: readonly TaskBoardItem[]
}
export async function buildTasksSnapshot(workspaceId: string): Promise<TasksSnapshot | null>
```

- [ ] **Step 1: Write the failing integration tests** (fixtures as in
  `apps/web/test/integration/overview.test.ts`, which this file mirrors):

```ts
it('returns every task with its runs newest-first and checkpoint summaries', async () => {
  const snapshot = await buildTasksSnapshot(workspace.id)
  const task = snapshot?.tasks.find((t) => t.id === seeded.id)
  expect(task?.runs[0]?.checkpoint?.pausedAtStep).toBe(3)
  expect(task?.runs.map((r) => r.id)).toEqual([newerRun.id, olderRun.id])
})
it('names the live run agent as assignee and leaves finished tasks unassigned', async () => {
  const snapshot = await buildTasksSnapshot(workspace.id)
  expect(snapshot?.tasks.find((t) => t.id === runningTask.id)?.assigneeName).toBe('Alex')
  expect(snapshot?.tasks.find((t) => t.id === doneTask.id)?.assigneeName).toBeNull()
})

it('returns null for an unknown workspace', async () => {
  expect(await buildTasksSnapshot('00000000-0000-4000-8000-000000000000')).toBeNull()
})

it('the route serves the snapshot and 404s an unknown workspace', async () => {
  const ok = await tasksGET(new Request('http://x'),
    { params: Promise.resolve({ workspaceId: workspace.id }) })
  expect(ok.status).toBe(200)
  expect((await ok.json()).tasks.length).toBeGreaterThan(0)
  const missing = await tasksGET(new Request('http://x'),
    { params: Promise.resolve({ workspaceId: '00000000-0000-4000-8000-000000000000' }) })
  expect(missing.status).toBe(404)
})
```

- [ ] **Step 2: Implement** — one `prisma.task.findMany({ where: { workspaceId }, orderBy:
  [{ priority: 'desc' }, { createdAt: 'asc' }], include: { runs: { orderBy: { startedAt: 'desc' },
  include: { checkpoint: true, agent: true } } } })`; assignee = the agent of the run whose status
  is in `NON_TERMINAL_RUN_STATUSES`; map dates to ISO strings; `dirtyFileCount =
  checkpoint.dirtyFiles.length`. The route follows `overview/route.ts` verbatim.

- [ ] **Step 3: Verify + commit**

```bash
git add -A && git commit -m "feat(web): tasks board snapshot read model and route"
```

---

### Task 7: Extract `useWorkspaceStream`; add `useTasks`

**Files:**
- Create: `apps/web/src/hooks/useWorkspaceStream.ts`, `apps/web/src/hooks/useTasks.ts`
- Modify: `apps/web/src/hooks/useOverview.ts` (reimplemented on the core)
- Test: `apps/web/test/useWorkspaceStream.test.tsx`, `apps/web/test/useTasks.test.tsx`;
  `apps/web/test/useOverview.test.tsx` must pass **without edits**

**Interfaces:**
- Produces:

```ts
// useWorkspaceStream.ts
export interface StreamEvent {
  readonly seq?: number
  readonly type?: string
  readonly agentId?: string
  readonly runId?: string
  readonly ts?: string
  readonly payload?: Record<string, unknown>
}
export function useWorkspaceStream<S>(options: {
  readonly workspaceId: string
  readonly endpoint: string                       // '/api/w/<id>/overview' etc, caller-built
  readonly initial: S
  readonly onEvent?: (event: StreamEvent) => void // fires before the wake-up refetch scheduling
  readonly onSnapshot?: (snapshot: S) => void     // fires after a refetched snapshot lands
}): { snapshot: S | null; connection: 'connected' | 'reconnecting'; error: string | null }
// useTasks.ts
export function useTasks(workspaceId: string, initial: TasksSnapshot): {
  snapshot: TasksSnapshot | null; connection: 'connected' | 'reconnecting'; error: string | null
}
```

- [ ] **Step 1: Move the core.** `useWorkspaceStream` is today's `useOverview` effect minus the
  action-line block: EventSource, onopen → connected + `scheduleRefetch()`, onerror →
  reconnecting, 250ms trailing debounce, monotonic `refetchSeq` guard, JSON-primitive rejection,
  every-event wake-up, unmount close. `onEvent` is called with each parsed object event;
  `onSnapshot` after `setSnapshot(parsed)`. Callbacks arrive via a ref (`useRef` updated each
  render) so the effect never re-subscribes on identity churn — the effect's dependency stays
  `[workspaceId, endpoint]`.

- [ ] **Step 2: Reimplement `useOverview` on it** — same exported signature and behaviour:
  `lines` state and `pruneLines` stay in `useOverview`; `onEvent` handles `run.tool_call` exactly
  as the current code (runId capture included); `onSnapshot` prunes. The derived `actionLines`
  memo stays.

- [ ] **Step 3: Run the untouched M4 tests.** `npx vitest run apps/web/test/useOverview.test.tsx`
  — all 11 green with zero edits is this task's acceptance bar.

- [ ] **Step 4: `useTasks`** — trivial composition over
  `endpoint: /api/w/${workspaceId}/tasks`. Tests: one refetch per event burst; snapshot updates
  after an event; error band on failed refetch (copy the shapes from the useOverview tests, typed
  against `TasksSnapshot`). `useWorkspaceStream.test.tsx` pins the extraction's own seams: both
  callbacks fire, and neither firing schedules a second EventSource.

- [ ] **Step 5: Full verify + commit**

```bash
git add -A && git commit -m "refactor(web): extract useWorkspaceStream and add useTasks on top"
```

---

### Task 8: Tasks page — board and task detail panel

**Files:**
- Create: `apps/web/src/app/w/[workspaceId]/tasks/page.tsx`,
  `apps/web/src/components/TasksClient.tsx`, `apps/web/src/components/TaskColumn.tsx`,
  `apps/web/src/components/TaskCard.tsx`, `apps/web/src/components/TaskDetailPanel.tsx`,
  `apps/web/src/hooks/useSelectedId.ts` (shared with Task 9's `?agent=`)
- Modify: `apps/web/src/components/Sidebar.tsx` (the Tasks item becomes a real link)
- Test: `apps/web/test/tasks-components.test.tsx`

**Interfaces:**
- Consumes: Task 6's `TasksSnapshot`/`TaskBoardItem`, Task 7's `useTasks`.
- Produces: `/w/[workspaceId]/tasks`, `?task=<id>` opens the detail panel.

- [ ] **Step 1: Failing component tests** (jsdom, as `overview-components.test.tsx`):
  all eight columns render in order
  `backlog, ready, running, verifying, reviewing, blocked, done, failed` (empty ones included);
  a card shows title, `attempt/maxAttempts`, assignee when present; clicking a card shows the
  detail panel with description, branch, rejection reason and run rows; a paused run's row shows
  `paused at step N`; the panel closes back to the board.

- [ ] **Step 2: Implement.** `page.tsx` mirrors the overview page (server snapshot via
  `buildTasksSnapshot`, 404 copy for unknown workspace, `key={workspaceId}` on the client).
  `TasksClient` composes Sidebar/TopBar (workspace name + connection from `useTasks`), maps
  `TASK_STATUSES`-ordered columns, tracks the selected task id with `useSearchParams` +
  `router.replace` shallow updates (same pattern Task 9 uses for `?agent=`; put the tiny
  `useSelectedId(param)` helper in `apps/web/src/hooks/useSelectedId.ts` and share it).
  `TaskDetailPanel` is a right-side overlay `<aside>` with the board still mounted beneath.
  Status colours reuse the existing `bg-status-*` / `text-status-*` tokens.

- [ ] **Step 3: Verify + commit**

```bash
git add -A && git commit -m "feat(web): the tasks board and task detail panel"
```

---

### Task 9: Agent detail panel — controls, message box, live feed

**Files:**
- Create: `apps/web/src/components/AgentPanel.tsx`
- Modify: `apps/web/src/server/overview.ts` (per-agent `recentEvents`),
  `apps/web/src/hooks/useOverview.ts` (per-agent rolling live feed),
  `apps/web/src/components/OverviewClient.tsx` (open/close via `?agent=`),
  `apps/web/src/components/AgentCard.tsx` (buttons open the panel; the disabled M4 chrome goes)
- Test: `apps/web/test/agent-panel.test.tsx`, extend
  `apps/web/test/integration/overview.test.ts` and `apps/web/test/useOverview.test.tsx` (additive
  tests only — the 11 M4 tests stay untouched)

**Interfaces:**
- Consumes: Task 5's POST endpoints; Task 7's `StreamEvent`.
- Produces:

```ts
// overview.ts additions
export interface AgentFeedEvent { readonly seq: number; readonly ts: string; readonly type: string; readonly summary: string }
// AgentCardData gains: readonly recentEvents: readonly AgentFeedEvent[]  // last 20, oldest first
// useOverview return gains: readonly liveEvents: Readonly<Record<string, readonly AgentFeedEvent[]>> // rolling, cap 50
```

`AgentFeedEvent.summary` is one readable line per event type: `run.tool_call` → its payload
summary; `run.output` → first 80 chars of text; anything else → the bare type. Derive it in ONE
exported function `feedSummary(type: string, payload: Record<string, unknown>): string` in
`apps/web/src/server/overview.ts`, imported by the hook too (it is pure).

- [ ] **Step 1: Failing snapshot test** — seed 25 events for an agent; `recentEvents` has the
  last 20 oldest-first, each with a non-empty summary.
- [ ] **Step 2: Implement snapshot side** — one query per workspace (not per agent):
  `prisma.executionEvent.findMany({ where: { agentId: { in: ids } }, orderBy: { seq: 'desc' }, take: 20 * ids.length })`
  then group/cap in JS. (The M4 review flagged per-run queries as the first scaling cliff — do
  not add another N+1.)
- [ ] **Step 3: Failing hook tests (additive)** — a pushed `run.tool_call` and `run.failed`
  appear in `liveEvents[agentId]` with seq and summary; the buffer caps at 50; events without an
  `agentId` are ignored.
- [ ] **Step 4: Implement hook side** — in `useOverview`'s `onEvent`, when
  `typeof event.agentId === 'string' && typeof event.type === 'string' && typeof event.seq === 'number'`,
  append `{ seq, ts, type, summary: feedSummary(...) }` to that agent's array, slicing to the
  last 50.
- [ ] **Step 5: Failing panel component tests** — the enable/disable matrix drives this file:

| status | pause | resume | stop | message box |
|---|---|---|---|---|
| working / starting / resuming | enabled | disabled | enabled | read-only hint |
| paused | disabled | enabled (disabled + halt reason when workspace halted) | enabled | writable |
| idle (no run) | disabled | disabled | disabled | hidden |

  Plus: clicking pause POSTs to `/api/w/<ws>/runs/<run>/pause` (assert with a fetch mock) and
  disables the button while in flight; a 409 body renders in the panel's error band; the feed
  renders seed + live merged by seq, deduplicated, newest at the bottom; the queued message
  renders and saving POSTs to `/message`.
- [ ] **Step 6: Implement the panel + wiring.** `AgentPanel` receives the agent's
  `AgentCardData`, `liveEvents[agent.id] ?? []`, the workspaceId, and a close callback.
  `OverviewClient` reads `?agent=` (the shared `useSelectedId` helper), renders the panel as an
  overlay `<aside>`, passes everything through. `AgentCard`'s two buttons become one "open"
  affordance (the whole card header is clickable) — the panel is where controls live (spec §6).
  POSTs are bare `fetch(url, { method: 'POST', … })`; no state is written from the response
  beyond the error band — the refetch loop owns truth.
- [ ] **Step 7: Full verify + commit**

```bash
git add -A && git commit -m "feat(web): the agent detail panel — controls, message box, live feed"
```

---

### Task 10: Motion pass — cross-fade, border decay, panel slide, reduced motion

**Files:**
- Modify: `apps/web/src/components/AgentCard.tsx`, `apps/web/src/components/AgentPanel.tsx`,
  `apps/web/src/components/TaskDetailPanel.tsx`, `apps/web/src/app/globals.css`
- Test: extend `apps/web/test/overview-components.test.tsx`

**Interfaces:** none new — this closes spec §8 and the M4 deferral record.

- [ ] **Step 1: Failing tests** — jsdom can't assert visual motion, so pin the mechanism: the
  action line's wrapper carries a key that changes with the text (remount = the CSS animation
  runs); the card carries `data-status` and a `transition-colors` class on the border; both
  panels carry the slide-in animation class; every animation class sits behind the
  `motion-safe:` Tailwind variant (assert `motion-safe:` appears in the className).
- [ ] **Step 2: Implement.** `globals.css` gains two keyframe blocks:

```css
@keyframes action-line-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes border-flash {
  0% { border-color: var(--flash-color, currentColor) }
  100% { border-color: var(--color-line) }
}
```

Action line: `<span key={line ?? 'idle'} className="motion-safe:animate-[action-line-in_120ms_ease-out]">`.
Border: a `useEffect` watching `agent.status` sets a transient `flashing` state (cleared by a
800ms timeout) that applies `motion-safe:animate-[border-flash_800ms_ease-out]` with
`style={{ '--flash-color': …status token… }}`. Panels:
`motion-safe:animate-[panel-in_160ms_ease-out]` with a translate keyframe. With
`prefers-reduced-motion: reduce`, `motion-safe:` disables all three — state changes render
instantly.

- [ ] **Step 3: Verify + commit**

```bash
git add -A && git commit -m "feat(web): the M5 motion pass — cross-fade, border flash, panel slide"
```

---

### Task 11: Docs, demo touch, and the milestone gate rehearsal

**Files:**
- Modify: `docs/architecture.md` (dependency rule: web writes only through `packages/control`;
  `packages/control` joins the topology diagram), `README.md` (Web UI section: the panel, the
  board, the intervention flow; the fake-vs-real demo note gains "verify fails by design under
  the fake"), `docs/superpowers/plans/2026-08-20-m5-board-panel-intervention.md` (ledger)
- Test: none new — this task's verification is the full suite plus the smoke rehearsal

**Interfaces:** none.

- [x] **Step 1: Update `docs/architecture.md`** — the M4 sentence "until M5 gives the web app
  buttons that are more than disabled chrome" is now due: replace it with the control-plane rule
  (web mutates only through `packages/control`; direct Prisma writes remain forbidden; resume is
  an intent the daemon executes) and add `packages/control` to the diagram between the packages
  and both apps.
- [x] **Step 2: Update `README.md`** — document the panel controls, the board URL, and extend
  the demo section: under the fake adapter the task ends `failed` because the fixture writes no
  real files for verify — expected, not broken (this exact confusion happened; write it down).
- [x] **Step 3: Smoke rehearsal with the fake adapter** — `npm run demo` (fake env) +
  `npm run web`; pause the run from the panel mid-fixture, confirm the 409-vs-200 behaviour,
  resume with a message, stop. Fix what the rehearsal finds before calling the task done.
- [x] **Step 4: Full verify** — `npm test && npm run typecheck && npm run web:build`.
- [x] **Step 5: Commit**

```bash
git add -A && git commit -m "docs(m5): control-plane dependency rule, README intervention guide"
```

---

## Milestone Gate (after all tasks; not a plan task)

Spec §12, by eyes, against the real `claude` CLI: pause a real run mid-work from the panel; queue
"also create a file named EXTRA.md"; resume and verify the instruction's effect and the cleared
slot; stop a second run and inspect its preserved worktree; watch the board move through the
cycle. Findings become gate-fix tasks exactly as in M3/M4.

## Self-Review Notes

**Spec coverage:** §1 scope → all tasks; §2 package layout → Task 1; §3.1/3.2 → Task 3; §3.3/3.4
→ Tasks 2, 4; §4 routes → Task 5; §5 board → Tasks 6, 8; §6 panel → Task 9; §7 hook extraction →
Task 7; §8 motion → Task 10; §9 error taxonomy → Tasks 3–5, 9 (409 band); §10 simplifications →
honoured by omission; §11 testing → distributed per task, CLI equivalence in Tasks 3–4; §12 gate
→ closing section.

**Ordering:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → (8, 9 in either order) → 10 → 11. Tasks 6–7 could run
before 5; keep the numbered order unless parallelizing.

**Known risks:** (1) The exact fixture/helper names in the orchestrator integration tests differ
from the sketches here — implementers must copy the real seeding helpers from the named
neighbouring test files, not invent new ones. (2) `useSearchParams` in the app router requires a
`<Suspense>` boundary in some Next 15 configurations — if `next build` complains, wrap the client
components at the page level. (3) The tick's halt behaviour: verify where `tick()` bails on a
halted workspace and place the resume pass after that bail, not before.
