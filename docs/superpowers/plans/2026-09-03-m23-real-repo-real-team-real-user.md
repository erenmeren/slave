# M23 Real Repo, Real Team, Real User — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the nine gaps between the original design spec and the tree in one milestone: attach a real repository from the CLI and Settings, collect aged worktrees, read verify artifacts in the task panel, draw the communication graph, edit the roster, replace the shared password with local accounts that sign every event, run CI on push, bring README's status list up to date, and close the `/tmp/does-not-matter` trap.

**Architecture:** Seven series, eighteen tasks, ordered A → B → C → G3 → D → E → F → G. Every control verb is a `Result<_, ControlRefusal>` in `packages/control`, every event goes through `appendEvent`, every web mutation dials `sendControl`, every new field is traced to its consumer inside the task that adds it. Series F (accounts) rewrites the auth surface and lands after everything else so A–E merge without touching it; the trailing optional `principal` parameter exists from Task 1 so F only has to fill it.

**Tech Stack:** TypeScript monorepo, Vitest 3, Next.js 15 (`apps/web`, edge middleware + Node routes), zod (`packages/domain`), Prisma 7 + Postgres 17 (`packages/db`), node `.mjs` gate scripts, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-03-m23-real-repo-real-team-real-user-design.md` — read it before any task; section numbers below (§2 A1, §7 F4 …) refer to it.

## Global Constraints

- Branch: `feature/m23-real-repo`, cut from `main` at the plan commit. Every task commits there.
- Zero spend: every gate and test drives `scripts/gate-fakes/` or `packages/providers/test/fake-claude.mjs`; nothing touches a vendor account.
- No new runtime dependencies. Migrations, one per task that needs one, additive only, `IF NOT EXISTS` where the DDL allows it: `m23_workspace_name_unique` (Task 1), `m23_workspace_created_event` (Task 1), `m23_worktree_collected_event` (Task 4), `m23_org_changed_event` (Task 9), `m23_accounts` (Task 13), `m23_event_user` (Task 15). (The spec §11 names three; the plan splits them so each task's migration ships with the code that uses it — a plan ruling, recorded in the spec's Errata at the end.)
- ADR 0003: `appendEvent` is the only event writer. A new event type is FOUR coordinated edits — `EventType` enum member + migration, Zod union member in `packages/domain/src/events/schema.ts`, `EVENT_TYPE_BY_DOMAIN_TYPE` in `packages/db/src/enums.ts`, and an entry in `ACTIVITY_CARDS` (`apps/web/src/components/activity/cards.tsx`) — the `satisfies` clauses fail the build if one is missing.
- One environment variable for the boundary, read in one file (`apps/web/src/lib/authEnv.ts`). Loopback mode is M15 byte for byte: `gate:m15-boundary` passes unmodified at the end of every task that touches `apps/web/src/lib/boundary.ts`, `middleware.ts` or `session.ts`.
- Error body `{ error: string }` everywhere; 403 refused, 401 unauthenticated or revoked, 302 pages, 404 not found, 409 control refusal, 400 malformed body.
- Web Crypto only in `apps/web/src` (no `node:crypto`); the shared PBKDF2 lives in `packages/control/src/password.ts` on `globalThis.crypto`.
- Standing rules: one vitest run at a time; no orchestrator daemon during tests (`pgrep -f 'cli.js daemon'` self-matches its wrapper shell — confirm via `/proc/<pid>/cmdline`); `npm test` = `tsc --build && vitest run`; root `tsc --build` does NOT cover `apps/web` tests — run `npx tsc -p apps/web/tsconfig.test.json --noEmit`; every task touching `apps/web` gates on `npm run web:build` before commit, NEVER while a `next dev` runs, and runs `rm -rf apps/web/.next` after the build so a gate's dev server never starts on a production build.
- Integration tests run against `TEST_DATABASE_URL` through `test-setup/require-database.ts`; run `npm run db:migrate:test` after adding a migration and `npm run db:migrate` for the dev database the gates use.
- `git add` explicit paths only. Comments change in the same commit as the behaviour they describe. Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01X6xU9uoue56mVjnKHWntBF`.
- Trace every new field to its consumer inside the task: `worktreePath` on the DTO → the Collect button (Task 6); `artifacts` on the DTO → the panel (Task 7); `count` → `CableEdge.weight` (Task 12); `userId` on the envelope → the Activity header (Task 15).

---

### Task 1: A1 — `createWorkspace`, the git probe, `workspace.created`

**Files:**
- Create: `packages/control/src/git-probe.ts`, `packages/control/src/principal.ts`
- Modify: `packages/control/src/workspace.ts`, `packages/control/src/refusal.ts`, `packages/control/src/index.ts`
- Modify: `packages/db/prisma/schema.prisma` (Workspace.name `@unique`; `EventType` member `workspace_created @map("workspace.created")`), `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts`
- Create: `packages/db/prisma/migrations/20260903100000_m23_workspace_name_unique/migration.sql`, `packages/db/prisma/migrations/20260903100100_m23_workspace_created_event/migration.sql`
- Modify: `apps/web/src/components/activity/cards.tsx` (`WorkspaceCreatedCard` + registry entry), `apps/web/src/lib/feedSummary.ts` if it is a `satisfies Record<DomainEventType, …>` table (check with `grep -n satisfies apps/web/src/lib/feedSummary.ts`; if it is, add the `workspace.created` line: `` `workspace ${payload.name} created` ``)
- Test: `packages/control/test/integration/create-workspace.test.ts` (new), `packages/control/test/git-probe.test.ts` (new, unit), `apps/web/test/activity-cards.test.tsx` (one new case)

**Interfaces:**
- Produces: `export interface Principal { readonly userId: string }` in `principal.ts` (Task 15 fills it; until then every caller passes `undefined`).
- Produces: `createWorkspace(input: CreateWorkspaceInput, principal?: Principal): Promise<Result<{ id: string }, ControlRefusal>>` (spec §2 A1 signature verbatim), consumed by Tasks 2, 3 and 17.
- Produces: `export interface GitProbe { isRepository(path: string): Promise<boolean>; branchExists(path: string, branch: string): Promise<boolean> }` and `export const realGitProbe: GitProbe`; `createWorkspace` takes the probe through a module-level `let probe: GitProbe = realGitProbe` with `export function useGitProbe(next: GitProbe): void` for unit tests (the `AITEAMOS_NEXT_BIN`-style test seam, never an operator knob).
- Produces: new refusal kinds `repo_path_not_absolute`, `repo_not_found`, `not_a_git_repository`, `base_branch_not_found`, `verify_commands_empty` (each `{ kind, … }` carrying the offending value: `path`, `path`, `path`, `branch`, none).

- [ ] **Step 1: Migrations.** `m23_workspace_name_unique/migration.sql`:

```sql
-- M23 A1: a workspace is addressed by name from the CLI and the Settings form; two rows with
-- one name would make `--workspace` ambiguity a permanent condition. Additive: an index only.
CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_name_key" ON "Workspace"("name");
```

`m23_workspace_created_event/migration.sql`:

```sql
-- M23 A1: the first event a workspace ever logs. One enum member, nothing else touched.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.created';
```

In `schema.prisma`: `name String @unique` on `Workspace`; `workspace_created @map("workspace.created")` at the end of `enum EventType`. Run `npm run db:generate && npm run db:migrate && npm run db:migrate:test`. If the dev database refuses the unique index because the seed has duplicate names, it does not (one workspace) — but check with `SELECT name, count(*) FROM "Workspace" GROUP BY 1 HAVING count(*) > 1` before migrating.

- [ ] **Step 2: Zod + enum map.** In `packages/domain/src/events/schema.ts` add, beside `workspace.settings_changed`:

```ts
z.object({
  ...envelope,
  type: z.literal('workspace.created'),
  payload: z.object({
    name: z.string().min(1),
    repoPath: z.string().min(1),
    baseBranch: z.string().min(1),
    verifyCommands: z.array(z.string().min(1)).min(1),
    provider: z.string().nullable(),
  }),
}),
```

In `packages/db/src/enums.ts`: `'workspace.created': 'workspace_created',`. Build (`npx tsc --build`) — it must FAIL on `cards.tsx`'s `satisfies` (and `feedSummary.ts` if it is a table). That failure is the RED for step 6.

- [ ] **Step 3: Failing unit test for the probe** — `packages/control/test/git-probe.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { realGitProbe } from '../src/git-probe.js'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-git-probe-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
  return dir
}

describe('realGitProbe', () => {
  it('sees a repository and its branch', async () => {
    const dir = repo()
    expect(await realGitProbe.isRepository(dir)).toBe(true)
    expect(await realGitProbe.branchExists(dir, 'main')).toBe(true)
    expect(await realGitProbe.branchExists(dir, 'develop')).toBe(false)
  })
  it('a plain directory is not a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiteamos-git-probe-plain-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'x'), '')
    expect(await realGitProbe.isRepository(dir)).toBe(false)
  })
})
```

Run `npx vitest run packages/control/test/git-probe.test.ts` → FAIL (module missing).

- [ ] **Step 4: The probe** — `packages/control/src/git-probe.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
/** A probe that hangs (a network-mounted repo, a stuck lock) must fail the verb, not the CLI. */
const PROBE_TIMEOUT_MS = 5_000

/** The two questions `createWorkspace` asks a path (spec §2 A1). Injectable so the verb's own
 *  tests never spawn git; `realGitProbe` is what production and the integration test use. */
export interface GitProbe {
  isRepository(path: string): Promise<boolean>
  branchExists(path: string, branch: string): Promise<boolean>
}

async function git(cwd: string, ...args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: PROBE_TIMEOUT_MS })
    return stdout.trim()
  } catch {
    return null
  }
}

export const realGitProbe: GitProbe = {
  async isRepository(path) {
    // `rev-parse --is-inside-work-tree` prints `true` only from inside a work tree; a bare repo
    // prints `false`, a non-repo exits 128. Both non-`true` answers refuse: the orchestrator
    // provisions worktrees off a checked-out base branch, which a bare repo does not have.
    return (await git(path, 'rev-parse', '--is-inside-work-tree')) === 'true'
  },
  async branchExists(path, branch) {
    return (await git(path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) !== null
  },
}
```

Run the unit test → PASS.

- [ ] **Step 5: Failing integration test** — `packages/control/test/integration/create-workspace.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@ai-team-os/db/client'
import { createWorkspace } from '../../src/workspace.js'
import { refusalText } from '../../src/refusal.js'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-create-ws-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
  return dir
}

const valid = (repoPath: string) => ({ name: 'Billing', repoPath, verifyCommands: ['npm test'] })

describe('createWorkspace', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  it('creates the row, the provider row and the event in one go', async () => {
    const dir = repo()
    const result = await createWorkspace({ ...valid(dir), provider: 'claude_code', setupCommands: [' npm ci '], budgetUsd: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row).toMatchObject({ name: 'Billing', repoPath: dir, baseBranch: 'main', verifyCommands: ['npm test'], setupCommands: ['npm ci'], budgetUsd: 5 })
    expect(await prisma.providerConfiguration.findMany({ where: { workspaceId: row.id } })).toMatchObject([{ kind: 'claude_code' }])
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: row.id, type: 'workspace_created' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ name: 'Billing', repoPath: dir, baseBranch: 'main', verifyCommands: ['npm test'], provider: 'claude_code' })
    expect(events[0]?.actor).toBe('human')
  })

  it('no provider means no ProviderConfiguration row and a null in the payload', async () => {
    const result = await createWorkspace(valid(repo()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await prisma.providerConfiguration.count({ where: { workspaceId: result.value.id } })).toBe(0)
  })

  it.each([
    ['relative path', (d: string) => ({ ...valid(d), repoPath: 'repo' }), 'repo_path_not_absolute'],
    ['missing dir', (d: string) => ({ ...valid(d), repoPath: join(d, 'nope') }), 'repo_not_found'],
    ['not a repo', (d: string) => ({ ...valid(mkdtempSync(join(tmpdir(), 'aiteamos-plain-'))) }), 'not_a_git_repository'],
    ['no base branch', (d: string) => ({ ...valid(d), baseBranch: 'develop' }), 'base_branch_not_found'],
    ['blank verify', (d: string) => ({ ...valid(d), verifyCommands: [' ', ''] }), 'verify_commands_empty'],
    ['blank name', (d: string) => ({ ...valid(d), name: '  ' }), 'invalid_name'],
    ['negative budget', (d: string) => ({ ...valid(d), budgetUsd: -1 }), 'invalid_budget'],
    ['bogus provider', (d: string) => ({ ...valid(d), provider: 'gpt' as never }), 'invalid_provider'],
  ])('refuses %s, writing nothing', async (_label, make, kind) => {
    const result = await createWorkspace(make(repo()))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe(kind)
      expect(refusalText(result.error).length).toBeGreaterThan(0)
    }
    expect(await prisma.workspace.count()).toBe(0)
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses a second workspace with the same name', async () => {
    expect((await createWorkspace(valid(repo()))).ok).toBe(true)
    const again = await createWorkspace(valid(repo()))
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toEqual({ kind: 'duplicate_name', name: 'Billing' })
  })
})
```

Run it → FAIL (`createWorkspace` is not exported).

- [ ] **Step 6: The verb.** In `refusal.ts` add the five kinds to the union and to `refusalText`:

```ts
  | { readonly kind: 'repo_path_not_absolute'; readonly path: string }
  | { readonly kind: 'repo_not_found'; readonly path: string }
  | { readonly kind: 'not_a_git_repository'; readonly path: string }
  | { readonly kind: 'base_branch_not_found'; readonly path: string; readonly branch: string }
  /** Spec §10: a workspace with no verify command can never reach `done` on its own. */
  | { readonly kind: 'verify_commands_empty' }
```

```ts
    case 'repo_path_not_absolute':
      return `the repository path must be absolute: ${refusal.path}`
    case 'repo_not_found':
      return `no directory at ${refusal.path}`
    case 'not_a_git_repository':
      return `${refusal.path} is not a git work tree`
    case 'base_branch_not_found':
      return `branch ${refusal.branch} does not exist in ${refusal.path}`
    case 'verify_commands_empty':
      return 'at least one verify command is required: a workspace with none can never reach done'
```

`principal.ts`:

```ts
/** Who is acting, when someone is (M23 Series F). Every control verb that appends an event or
 *  creates a task takes this as its trailing optional parameter; the web fills it from the
 *  session, the CLI passes nothing. Until Series F lands the type exists and is never populated. */
export interface Principal {
  readonly userId: string
}
```

In `workspace.ts`, after the imports (`import { isAbsolute } from 'node:path'`, `import { stat } from 'node:fs/promises'`, `import { realGitProbe, type GitProbe } from './git-probe.js'`, `import type { Principal } from './principal.js'`, `isProviderKind` from `./org.js` — check its export; if it is module-private there, export it):

```ts
export interface CreateWorkspaceInput {
  readonly name: string
  readonly repoPath: string
  readonly baseBranch?: string
  readonly verifyCommands: readonly string[]
  readonly setupCommands?: readonly string[]
  readonly budgetUsd?: number | null
  readonly provider?: ProviderKind | null
}

let probe: GitProbe = realGitProbe
/** Test seam only: swap the git probe. Not an operator knob. */
export function useGitProbe(next: GitProbe): void {
  probe = next
}

function cleanCommands(commands: readonly string[] | undefined): string[] {
  return (commands ?? []).map((command) => command.trim()).filter((command) => command.length > 0)
}

/** Spec §2 A1. Refusals in the spec's table order; nothing is written until every check passed. */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  _principal?: Principal,
): Promise<Result<{ id: string }, ControlRefusal>> {
  const name = input.name.trim()
  if (name.length === 0) return err({ kind: 'invalid_name' })
  if (!isAbsolute(input.repoPath)) return err({ kind: 'repo_path_not_absolute', path: input.repoPath })
  const info = await stat(input.repoPath).catch(() => null)
  if (info === null || !info.isDirectory()) return err({ kind: 'repo_not_found', path: input.repoPath })
  if (!(await probe.isRepository(input.repoPath))) return err({ kind: 'not_a_git_repository', path: input.repoPath })
  const baseBranch = (input.baseBranch ?? 'main').trim() || 'main'
  if (!(await probe.branchExists(input.repoPath, baseBranch))) {
    return err({ kind: 'base_branch_not_found', path: input.repoPath, branch: baseBranch })
  }
  const verifyCommands = cleanCommands(input.verifyCommands)
  if (verifyCommands.length === 0) return err({ kind: 'verify_commands_empty' })
  const budgetUsd = input.budgetUsd
  if (budgetUsd !== undefined && budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
    return err({ kind: 'invalid_budget' })
  }
  const provider = input.provider ?? null
  if (provider !== null && !isProviderKind(provider)) return err({ kind: 'invalid_provider', provider })

  let id: string
  try {
    id = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name,
          repoPath: input.repoPath,
          baseBranch,
          verifyCommands,
          setupCommands: cleanCommands(input.setupCommands),
          ...(budgetUsd === undefined ? {} : { budgetUsd }),
        },
      })
      if (provider !== null) {
        await tx.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: provider, settings: {} } })
      }
      return workspace.id
    })
  } catch (cause) {
    if (isUniqueConstraintViolation(cause)) return err({ kind: 'duplicate_name', name })
    throw cause
  }
  await appendEvent({
    type: 'workspace.created',
    workspaceId: id,
    actor: 'human',
    payload: { name, repoPath: input.repoPath, baseBranch, verifyCommands, provider },
  })
  return ok({ id })
}
```

`isUniqueConstraintViolation` lives in `org.ts` today — move it to a new `packages/control/src/prisma-errors.ts` and import it from both files (one definition site; the M17 census rule). Export `createWorkspace`, `useGitProbe`, `CreateWorkspaceInput` through `workspace.ts` (already `export *` from the index); add `export * from './principal.js'` and `export * from './git-probe.js'` to `index.ts`.

- [ ] **Step 7: The card.** In `cards.tsx`, next to `WorkspaceSettingsChangedCard`:

```tsx
function WorkspaceCreatedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { name: string; repoPath: string; verifyCommands: string[] }
  return (
    <ActivityCard {...props}>
      <Transition tone="starting" label="workspace created">
        <span data-testid="workspace-created-name">{payload.name}</span> · <span className="font-mono">{payload.repoPath}</span> ·{' '}
        {payload.verifyCommands.length} verify command{payload.verifyCommands.length === 1 ? '' : 's'}
      </Transition>
    </ActivityCard>
  )
}
```

Registry: `'workspace.created': WorkspaceCreatedCard,`. In `apps/web/test/activity-cards.test.tsx` add one case in the style of the `workspace.settings_changed` one asserting the name testid and the "2 verify commands" text. If `feedSummary.ts` is a `satisfies` table, add its line and a row to `apps/web/test/feedSummary.test.ts`.

- [ ] **Step 8: Verify.** `npx tsc --build` clean; `npx vitest run packages/control/test/git-probe.test.ts packages/control/test/integration/create-workspace.test.ts apps/web/test/activity-cards.test.tsx` → PASS; `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npm run web:build` then `rm -rf apps/web/.next`.

- [ ] **Step 9: Commit.**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260903100000_m23_workspace_name_unique packages/db/prisma/migrations/20260903100100_m23_workspace_created_event packages/db/src/enums.ts packages/domain/src/events/schema.ts packages/control/src/git-probe.ts packages/control/src/principal.ts packages/control/src/prisma-errors.ts packages/control/src/workspace.ts packages/control/src/org.ts packages/control/src/refusal.ts packages/control/src/index.ts packages/control/test/git-probe.test.ts packages/control/test/integration/create-workspace.test.ts apps/web/src/components/activity/cards.tsx apps/web/test/activity-cards.test.tsx
git commit -m "feat(control): m23 a1 — createWorkspace: a real repo, a real branch, at least one verify command, one event"
```

(Add `apps/web/src/lib/feedSummary.ts` and its test to the `git add` if touched.)

---

### Task 2: A2 — CLI `create-workspace`, repeatable flags

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (`parseArgs`, `Flags`, `USAGE`, new case)
- Test: `apps/orchestrator/test/integration/cli.test.ts` (three new cases)

**Interfaces:**
- Consumes: `createWorkspace` (Task 1).
- Produces: `parseArgs` returns `flags: Readonly<Record<string, string | readonly string[] | undefined>>` — ONLY `verify` and `setup` ever hold arrays (`REPEATABLE = new Set(['verify', 'setup'])`); every other key keeps last-wins. `requireFlag` and every existing `flags['x']` read stay string-typed through a `flagText(flags, name): string | undefined` helper that throws `--<name> was given more than once` for a repeated non-repeatable flag — which cannot happen by construction, so the throw is the type guard's honest fallback.

- [ ] **Step 1: Failing tests** in `cli.test.ts` (uses the file's `runCli` + `makeRepo` helpers):

```ts
describe('create-workspace', () => {
  it('creates a workspace from a real repo and prints its id', async () => {
    const dir = makeRepo()
    const result = await runCli(['create-workspace', '--name', 'Billing', '--repo', dir, '--verify', 'npm test', '--verify', 'npm run lint', '--setup', 'npm ci', '--budget', '7', '--provider', 'claude_code'])
    expect(result.code).toBe(0)
    const id = /^workspace (\S+) created$/m.exec(result.stdout)?.[1]
    expect(id).toBeDefined()
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ name: 'Billing', repoPath: dir, verifyCommands: ['npm test', 'npm run lint'], setupCommands: ['npm ci'], budgetUsd: 7 })
  })
  it('refuses a relative path with the refusal text and exit 1', async () => {
    const result = await runCli(['create-workspace', '--name', 'Billing', '--repo', 'repo', '--verify', 'npm test'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('the repository path must be absolute')
  })
  it('requires --verify', async () => {
    const result = await runCli(['create-workspace', '--name', 'Billing', '--repo', makeRepo()])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('at least one verify command is required')
  })
  it('--no-budget stores null', async () => {
    const result = await runCli(['create-workspace', '--name', 'Free', '--repo', makeRepo(), '--verify', 'true', '--no-budget'])
    expect(result.code).toBe(0)
    expect((await prisma.workspace.findFirstOrThrow({ where: { name: 'Free' } })).budgetUsd).toBeNull()
  })
})
```

Run → FAIL (`unknown command`).

- [ ] **Step 2: `parseArgs`.** Change the flags type and the collection: when `REPEATABLE.has(key)`, `flags[key] = [...(flags[key] as string[] | undefined ?? []), value]`; a bare repeatable flag with no value is ignored (a blank command is dropped by the verb anyway). Add:

```ts
const REPEATABLE: ReadonlySet<string> = new Set(['verify', 'setup'])

function flagText(flags: Flags, name: string): string | undefined {
  const value = flags[name]
  if (Array.isArray(value)) throw new Error(`--${name} was given more than once`)
  return value as string | undefined
}
function flagList(flags: Flags, name: string): readonly string[] {
  const value = flags[name]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value as string]
}
```

Replace every `flags['x']` read in the file with `flagText(flags, 'x')` (`requireFlag` uses it too). `'clear' in flags` style presence checks stay.

- [ ] **Step 3: The case**, beside `assign-company`:

```ts
    case 'create-workspace': {
      const name = requireFlag(flags, 'name')
      const repoPath = requireFlag(flags, 'repo')
      const budgetText = flagText(flags, 'budget')
      const noBudget = 'no-budget' in flags
      if (budgetText !== undefined && noBudget) throw new Error('--budget and --no-budget are exclusive')
      const budgetUsd = noBudget ? null : budgetText === undefined ? undefined : Number(budgetText)
      const result = await createWorkspace({
        name,
        repoPath,
        ...(flagText(flags, 'base') !== undefined ? { baseBranch: flagText(flags, 'base') as string } : {}),
        verifyCommands: flagList(flags, 'verify'),
        setupCommands: flagList(flags, 'setup'),
        ...(budgetUsd === undefined ? {} : { budgetUsd }),
        ...(flagText(flags, 'provider') !== undefined ? { provider: flagText(flags, 'provider') as ProviderKind } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`workspace ${result.value.id} created\n`)
      return 0
    }
```

USAGE, after `set-goal`:

```
  create-workspace --name <n> --repo <abs path> [--base main] --verify "<cmd>" [--verify "<cmd>" ...]
                   [--setup "<cmd>" ...] [--budget <usd> | --no-budget] [--provider claude_code|cursor]
                                       attach an existing local clone as a workspace. The path
                                       must be absolute and a git work tree, the base branch must
                                       exist, and at least one verify command is required -- a
                                       workspace with none can never reach done. --verify and
                                       --setup repeat, one command each, run in the order given.
```

- [ ] **Step 4: Verify.** `npx tsc --build`; `npx vitest run apps/orchestrator/test/integration/cli.test.ts` → all PASS (the existing cases prove `flagText` kept every old read intact).

- [ ] **Step 5: Commit.**

```bash
git add apps/orchestrator/src/cli.ts apps/orchestrator/test/integration/cli.test.ts
git commit -m "feat(cli): m23 a2 — create-workspace, and --verify/--setup repeat"
```

---

### Task 3: A3 + A4 — `POST /api/org/workspaces`, the Projects panel, README

**Files:**
- Create: `apps/web/src/app/api/org/workspaces/route.ts`, `apps/web/src/components/ProjectsPanel.tsx`
- Modify: `apps/web/src/components/SettingsClient.tsx` (mount above `TemplateCatalog`), `README.md` (§2 A4 subsection)
- Test: `apps/web/test/projects-panel.test.tsx` (new), `apps/web/test/settings-page.test.tsx` (one assertion that the panel renders)

**Interfaces:**
- Consumes: `createWorkspace`, `orgControlResponse`.
- Produces: `POST /api/org/workspaces` body `{ name, repoPath, baseBranch?, verifyCommands: string[], setupCommands?: string[], budgetUsd?: number | null, provider?: 'claude_code' | 'cursor' | null }` → 201 `{ ok: true, id }`, 400 on a malformed body, 409 `{ error }` on refusal. Task 17 stage 2 does not use it (CLI), but Task 14's principal wiring touches it.

- [ ] **Step 1: Failing component test** — `apps/web/test/projects-panel.test.tsx` (jsdom, the `tasks-components.test.tsx` preamble; mock `next/navigation`'s `useRouter` with `{ refresh: vi.fn(), push: vi.fn() }` and `fetch` with `vi.fn()`):

```tsx
it('posts the form as arrays and navigates to the new workspace', async () => {
  const push = vi.fn()
  vi.mocked(useRouter).mockReturnValue({ refresh: vi.fn(), push } as never)
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: 'ws-9' }), { status: 201 }))
  vi.stubGlobal('fetch', fetchMock)
  render(<ProjectsPanel />)
  fireEvent.change(screen.getByTestId('create-workspace-name'), { target: { value: 'Billing' } })
  fireEvent.change(screen.getByTestId('create-workspace-repo'), { target: { value: '/srv/billing' } })
  fireEvent.change(screen.getByTestId('create-workspace-verify'), { target: { value: 'npm test\n\nnpm run lint\n' } })
  fireEvent.submit(screen.getByTestId('create-workspace-form'))
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
  expect(body).toEqual({ name: 'Billing', repoPath: '/srv/billing', baseBranch: 'main', verifyCommands: ['npm test', 'npm run lint'], setupCommands: [], budgetUsd: 20, provider: null })
  await waitFor(() => expect(push).toHaveBeenCalledWith('/w/ws-9'))
})
it('shows a refusal in the alert band', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'no directory at /nope' }), { status: 409 })))
  render(<ProjectsPanel />)
  fireEvent.change(screen.getByTestId('create-workspace-name'), { target: { value: 'X' } })
  fireEvent.change(screen.getByTestId('create-workspace-repo'), { target: { value: '/nope' } })
  fireEvent.change(screen.getByTestId('create-workspace-verify'), { target: { value: 'true' } })
  fireEvent.submit(screen.getByTestId('create-workspace-form'))
  expect(await screen.findByTestId('create-workspace-error')).toHaveTextContent('no directory at /nope')
})
```

- [ ] **Step 2: The route** — `apps/web/src/app/api/org/workspaces/route.ts`:

```ts
import { createWorkspace, type ProviderKind } from '@ai-team-os/control'
import { refusalText } from '@ai-team-os/control'

export const dynamic = 'force-dynamic'
const BODY_ERROR = 'the body must be { name, repoPath, verifyCommands: string[], baseBranch?, setupCommands?, budgetUsd?, provider? }'

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const b = body as Record<string, unknown>
  const verifyCommands = strings(b['verifyCommands'])
  const setupCommands = b['setupCommands'] === undefined ? [] : strings(b['setupCommands'])
  if (typeof b['name'] !== 'string' || typeof b['repoPath'] !== 'string' || verifyCommands === null || setupCommands === null) {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  if (b['budgetUsd'] !== undefined && b['budgetUsd'] !== null && typeof b['budgetUsd'] !== 'number') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  // Not `orgControlResponse`: this is the one org route whose success body carries an id (spec §2 A3).
  const result = await createWorkspace({
    name: b['name'],
    repoPath: b['repoPath'],
    ...(typeof b['baseBranch'] === 'string' ? { baseBranch: b['baseBranch'] } : {}),
    verifyCommands,
    setupCommands,
    ...(b['budgetUsd'] === undefined ? {} : { budgetUsd: b['budgetUsd'] as number | null }),
    ...(b['provider'] === undefined ? {} : { provider: b['provider'] as ProviderKind | null }),
  })
  return result.ok
    ? Response.json({ ok: true, id: result.value.id }, { status: 201 })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
```

- [ ] **Step 3: The panel** — `ProjectsPanel.tsx`, the `CompanyManager` idiom, FormControls only. Fields and testids: `create-workspace-form`, `-name` (TextField), `-repo` (TextField, `font-mono`, placeholder `/absolute/path/to/clone`), `-base` (TextField, default `main`), `-verify` (a `<textarea>` styled with `INPUT_SHELL`, `rows={3}`, one command per line), `-setup` (same), `-budget` (number input) + `-no-budget` checkbox (the `RuntimeCard` pattern: checked → budget field disabled and `budgetUsd: null`), `-provider` (`SelectField` with `none`, `claude_code`, `cursor`), `-submit` (`PrimaryButton`, disabled while pending or name/repo/verify blank), `-error` (`role="alert"`). Submit: `sendControl` returns only the error text, and this route's success carries an id, so use `fetch` directly here with the same `errorMessage` helper from `lib/postControl.ts`; on 201 `router.push(`/w/${id}`)`. Split lines with `text.split('\n').map(trim).filter(Boolean)`. Mount in `SettingsClient` as `<Panel title="Projects"><ProjectsPanel /></Panel>` above the template catalog.

- [ ] **Step 4: README §2 A4.** Under "## Running the orchestrator", before the command block, add "### Attaching a repository": the `create-workspace` line, the four validations, `<repo>/.aiteamos/` (worktrees, artifacts; gitignored by `ensureIgnored`), and the note that the seeded Checkout Platform's `/tmp/checkout-platform` does not survive a reboot and is inert by design (no `requiredRole` on its tasks).

- [ ] **Step 5: Verify.** `npx vitest run apps/web/test/projects-panel.test.tsx apps/web/test/settings-page.test.tsx`; `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/app/api/org/workspaces/route.ts apps/web/src/components/ProjectsPanel.tsx apps/web/src/components/SettingsClient.tsx apps/web/test/projects-panel.test.tsx apps/web/test/settings-page.test.tsx README.md
git commit -m "feat(web): m23 a3 — a Projects panel attaches a repository from Settings"
```

---

### Task 4: B1 + B2 — `collectTaskWorktree`, `TERMINAL` exported, `gitIn` shared

**Files:**
- Modify: `packages/domain/src/task/state.ts` (`export const TERMINAL`), `packages/control/src/refusal.ts`, `packages/control/src/index.ts`
- Create: `packages/control/src/git.ts` (`gitIn` + `ORCHESTRATOR_GIT_IDENTITY` move here), `packages/control/src/collect.ts`
- Modify: `apps/orchestrator/src/worktree.ts` (`export { gitIn, ORCHESTRATOR_GIT_IDENTITY } from '@ai-team-os/control'` replaces the definitions; the six importers do not move)
- Modify: `packages/db/prisma/schema.prisma` (`task_worktree_collected @map("task.worktree_collected")`), `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts`, `apps/web/src/components/activity/cards.tsx`
- Create: `packages/db/prisma/migrations/20260903110000_m23_worktree_collected_event/migration.sql`
- Test: `packages/control/test/integration/collect.test.ts` (new), `apps/web/test/activity-cards.test.tsx` (one case)

**Interfaces:**
- Produces: `collectTaskWorktree(taskId: string, reason: 'aged' | 'operator', principal?: Principal): Promise<Result<{ path: string }, ControlRefusal>>` and `export const WORKTREE_TTL_MS = 7 * 24 * 60 * 60 * 1000`, plus `export async function terminalTimestamp(taskId: string): Promise<Date | null>` (the latest `task.done|task.failed|task.cancelled` event's `ts`). Consumed by Task 5 (the pass) and Task 6 (the route).
- Produces: refusal kinds `task_not_terminal { taskId, status }`, `run_still_alive { taskId, runId }`, `nothing_to_collect { taskId }`.
- Event `task.worktree_collected` payload `{ path: string, reason: 'aged' | 'operator', branch: string | null }`.

- [ ] **Step 1: Migration + enum + Zod + map + card.** `migration.sql`: `ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'task.worktree_collected';` with the M18-style comment. Zod:

```ts
z.object({
  ...envelope,
  type: z.literal('task.worktree_collected'),
  payload: z.object({ path: z.string().min(1), reason: z.enum(['aged', 'operator']), branch: z.string().nullable() }),
}),
```

Card `TaskWorktreeCollectedCard`: tone `idle`, label `worktree collected`, body `<span className="font-mono">{path}</span> · {reason}`; registry entry; one test case. `feedSummary` line if applicable: `` `worktree collected (${payload.reason})` ``. Migrate dev + test databases.

- [ ] **Step 2: `TERMINAL` export.** In `state.ts`: `export const TERMINAL: readonly TaskStatus[] = ['done', 'failed', 'cancelled']` (drop the `const` inside the file if it shadows). Build.

- [ ] **Step 3: `gitIn` move.** Create `packages/control/src/git.ts` with `ORCHESTRATOR_GIT_IDENTITY` and `gitIn` exactly as they are in `worktree.ts:140-155` (find the identity constant above it; move both). In `worktree.ts` replace the definitions with `export { gitIn, ORCHESTRATOR_GIT_IDENTITY } from '@ai-team-os/control'` and keep the local uses. `export * from './git.js'` in the control index. Build; run `npx vitest run apps/orchestrator/test/integration/worktree.test.ts apps/orchestrator/test/integration/merge.test.ts` → PASS unchanged.

- [ ] **Step 4: Failing integration test** — `collect.test.ts`. Seed: a temp git repo (`makeRepo` shape from Task 1), a workspace pointing at it, one agent, one task `status: 'done'`, one run `status: 'succeeded'` with `worktreePath` = a real `git worktree add` under `<repo>/.aiteamos/worktrees/T-abc` on branch `aiteamos/T-abc-x`, and a `task_done` event appended through `appendEvent`. Cases:

```ts
it('removes the tree, keeps the branch, nulls the path, records the event', async () => {
  const result = await collectTaskWorktree(task.id, 'operator')
  expect(result.ok).toBe(true)
  expect(existsSync(worktreePath)).toBe(false)
  expect(execFileSync('git', ['branch', '--list', 'aiteamos/T-abc-x'], { cwd: repo }).toString()).toContain('aiteamos/T-abc-x')
  expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).worktreePath).toBeNull()
  const events = await prisma.executionEvent.findMany({ where: { taskId: task.id, type: 'task_worktree_collected' } })
  expect(events[0]?.payload).toEqual({ path: worktreePath, reason: 'operator', branch: 'aiteamos/T-abc-x' })
  expect(events[0]?.actor).toBe('human')
})
it('aged collection is attributed to the system', …)   // actor 'system'
it('a tree already gone on disk still collects (prune path)', …)  // rmSync the dir first; expect ok, worktreePath null, `git worktree list` no longer names it
it('refuses a running task', …)        // task status 'running' → task_not_terminal
it('refuses while a run is alive', …)  // run status 'working', pid = process.pid → run_still_alive
it('refuses when no run carries a path', …)  // nothing_to_collect
it('terminalTimestamp is the latest terminal event', …)
```

- [ ] **Step 5: The verb** — `packages/control/src/collect.ts`:

```ts
import { existsSync } from 'node:fs'
import { prisma } from '@ai-team-os/db/client'
import { NON_TERMINAL_RUN_STATUSES, TERMINAL, err, ok, type Result } from '@ai-team-os/domain'
import { appendEvent } from '@ai-team-os/events'
import { gitIn } from './git.js'
import { isAlive } from './kill.js'
import type { ControlRefusal } from './refusal.js'
import type { Principal } from './principal.js'

export const WORKTREE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The clock for ageing: the latest terminal event's `ts` (spec §3 B1). No column — the log is
 *  the source of truth. `null` for a terminal task with no such event (pre-M8 seed rows). */
export async function terminalTimestamp(taskId: string): Promise<Date | null> {
  const row = await prisma.executionEvent.findFirst({
    where: { taskId, type: { in: ['task_done', 'task_failed', 'task_cancelled'] } },
    orderBy: { seq: 'desc' },
    select: { ts: true },
  })
  return row?.ts ?? null
}

/** Spec §3 B2. One implementation for both the aged pass and the operator's button. */
export async function collectTaskWorktree(
  taskId: string,
  reason: 'aged' | 'operator',
  _principal?: Principal,
): Promise<Result<{ path: string }, ControlRefusal>> {
  const plan = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`
    if (locked.length === 0) return { refusal: { kind: 'task_not_found', taskId } as const }
    const task = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { workspace: { select: { id: true, repoPath: true } }, runs: { select: { id: true, status: true, pid: true, worktreePath: true } } },
    })
    if (!TERMINAL.includes(task.status)) return { refusal: { kind: 'task_not_terminal', taskId, status: task.status } as const }
    for (const run of task.runs) {
      const live = (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status) || (run.pid !== null && isAlive(run.pid))
      if (live) return { refusal: { kind: 'run_still_alive', taskId, runId: run.id } as const }
    }
    const path = task.runs.map((run) => run.worktreePath).find((candidate): candidate is string => candidate !== null)
    if (path === undefined) return { refusal: { kind: 'nothing_to_collect', taskId } as const }
    return { task, path }
  })
  if ('refusal' in plan) return err(plan.refusal)
  const { task, path } = plan

  // The row said there was a tree; the disk decides what to run. A directory that is already gone
  // leaves a stale registration `worktree prune` clears; a present one is removed with --force
  // because a terminal task's dirty files are not worth keeping (the branch keeps the commits).
  if (existsSync(path)) await gitIn(task.workspace.repoPath, 'worktree', 'remove', '--force', path)
  else await gitIn(task.workspace.repoPath, 'worktree', 'prune')

  await prisma.agentRun.updateMany({ where: { taskId, worktreePath: path }, data: { worktreePath: null } })
  await appendEvent({
    type: 'task.worktree_collected',
    workspaceId: task.workspace.id,
    taskId,
    actor: reason === 'aged' ? 'system' : 'human',
    payload: { path, reason, branch: task.branch },
  })
  return ok({ path })
}
```

Check `AgentRun.pid` exists and its type (`Int?`) in the schema; check `isAlive`'s signature in `kill.ts`. If `task_cancelled` is not an `EventType` member (the enum above lists no `task.cancelled`), the `in` list is `['task_done', 'task_failed']` and the spec's B1 wording is corrected in the Errata: cancellation reaches the log as `run.stopped` + `task.failed` or not at all — check `packages/control/src/stop.ts` and say which in the commit message. Refusal texts: `task ${taskId} is ${status}; only a done, failed or cancelled task's worktree can be collected`, `run ${runId} of task ${taskId} is still alive`, `task ${taskId} has no worktree to collect`. `export * from './collect.js'` in the index.

- [ ] **Step 6: Verify.** `npx tsc --build`; `npx vitest run packages/control/test/integration/collect.test.ts apps/web/test/activity-cards.test.tsx apps/orchestrator/test/integration/worktree.test.ts` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/domain/src/task/state.ts packages/domain/src/events/schema.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260903110000_m23_worktree_collected_event packages/db/src/enums.ts packages/control/src/git.ts packages/control/src/collect.ts packages/control/src/refusal.ts packages/control/src/index.ts packages/control/test/integration/collect.test.ts apps/orchestrator/src/worktree.ts apps/web/src/components/activity/cards.tsx apps/web/test/activity-cards.test.tsx
git commit -m "feat(control): m23 b2 — collectTaskWorktree: the tree goes, the branch stays, the log says so"
```

---

### Task 5: B2 + B3 — the aged pass and the daemon's second timer

**Files:**
- Create: `apps/orchestrator/src/collect.ts`
- Modify: `apps/orchestrator/src/daemon.ts` (startup pass + `COLLECT_PERIOD_MS` interval, cleared in the same `finally` as `timer`)
- Test: `apps/orchestrator/test/integration/collect.test.ts` (new), `apps/orchestrator/test/coalescer.test.ts` untouched

**Interfaces:**
- Consumes: `collectTaskWorktree`, `terminalTimestamp`, `WORKTREE_TTL_MS`, `TERMINAL`.
- Produces: `collectWorktrees(deps: CollectDeps): Promise<CollectReport>` with `CollectDeps = { workspaceId: string; now: () => Date; ttlMs: number }`, `CollectReport = { collected: { taskId; path }[]; skipped: number }`. Consumed by Task 17 stage 5 (in-process).

- [ ] **Step 1: Failing test.** Seed as in Task 4 (real repo + worktree), two done tasks: one whose `task_done` event is 8 days old (write the event through `appendEvent`, then `UPDATE "ExecutionEvent" SET ts = now() - interval '8 days' WHERE seq = …`), one 1 day old. `collectWorktrees({ workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })` → `collected` has exactly the old task, `skipped` is 1, the young tree still exists. Second call → nothing collected (path is null now). A done task with NO terminal event → skipped forever.

- [ ] **Step 2: The pass** — `apps/orchestrator/src/collect.ts`:

```ts
import { prisma } from '@ai-team-os/db/client'
import { TERMINAL } from '@ai-team-os/domain'
import { collectTaskWorktree, terminalTimestamp } from '@ai-team-os/control'

export interface CollectDeps { readonly workspaceId: string; readonly now: () => Date; readonly ttlMs: number }
export interface CollectReport { readonly collected: readonly { readonly taskId: string; readonly path: string }[]; readonly skipped: number }

/** Spec §3 B2/B3: every terminal task that still owns a tree, aged past the TTL, collected one
 *  by one. A refusal or a git failure on one task is logged and skipped; the pass never throws. */
export async function collectWorktrees(deps: CollectDeps): Promise<CollectReport> {
  const candidates = await prisma.task.findMany({
    where: { workspaceId: deps.workspaceId, status: { in: [...TERMINAL] }, runs: { some: { worktreePath: { not: null } } } },
    select: { id: true },
  })
  const collected: { taskId: string; path: string }[] = []
  let skipped = 0
  for (const { id } of candidates) {
    const at = await terminalTimestamp(id)
    if (at === null || deps.now().getTime() - at.getTime() < deps.ttlMs) { skipped += 1; continue }
    try {
      const result = await collectTaskWorktree(id, 'aged')
      if (result.ok) collected.push({ taskId: id, path: result.value.path })
      else skipped += 1
    } catch (error) {
      skipped += 1
      process.stderr.write(`[collect] task ${id}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  return { collected, skipped }
}
```

- [ ] **Step 3: Daemon.** In `runDaemon`, after the skill sync: `const COLLECT_PERIOD_MS = 10 * 60 * 1000` (module const, exported for the test), a `runCollect` closure that calls `collectWorktrees({ workspaceId: deps.workspaceId, now: () => new Date(), ttlMs: WORKTREE_TTL_MS })` and writes `[collect] task <id> worktree <path> collected (aged)\n` per entry, catching and logging errors; call it once before the coalescer starts (after `reconcileOrphans`), and `collectTimer = setInterval(() => void runCollect(), COLLECT_PERIOD_MS)` beside `timer`; clear it in the same `finally`. Comment: why it is not inside the 1 Hz sweep (spec §3 B3).

- [ ] **Step 4: Verify.** `npx tsc --build`; `npx vitest run apps/orchestrator/test/integration/collect.test.ts apps/orchestrator/test/integration/cli.test.ts` (the daemon boots in the CLI test — it must still start and stop cleanly).

- [ ] **Step 5: Commit.**

```bash
git add apps/orchestrator/src/collect.ts apps/orchestrator/src/daemon.ts apps/orchestrator/test/integration/collect.test.ts
git commit -m "feat(orchestrator): m23 b3 — a ten-minute pass collects worktrees seven days after the task ended"
```

---

### Task 6: B4 — the Collect button and its route

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/tasks/[taskId]/worktree/route.ts`
- Modify: `apps/web/src/server/tasks.ts` (`TaskRunSummary.worktreePath: string | null`), `apps/web/src/components/TaskDetailPanel.tsx`
- Test: `apps/web/test/tasks-components.test.tsx` (three cases), `apps/web/test/integration/…` if a route test pattern exists for workspace routes (check `ls apps/web/test/integration`; if a `*-route.test.ts` pattern exists, add `worktree-route.test.ts` asserting 404 / 409 / 200 against the test DB)

**Interfaces:**
- Consumes: `collectTaskWorktree`, `workspaceControlResponse`, `sendControl`.
- Produces: `DELETE /api/w/:id/tasks/:taskId/worktree` → `{ ok: true }` / 409 / 404.

- [ ] **Step 1: DTO.** In `buildTasksSnapshot`'s run mapping add `worktreePath: run.worktreePath`; in the interface, with the comment "M23 B4: the Collect button's own condition — null once collected".

- [ ] **Step 2: Failing panel tests.** In `tasks-components.test.tsx`, extend the `task()` factory's run shape (add `worktreePath: null` to whatever run fixture exists). Cases: (a) a `done` task with a run carrying `worktreePath: '/r/.aiteamos/worktrees/T-1'` renders `collect-worktree`; (b) a `running` task does not; (c) a done task whose runs all have `null` does not; (d) clicking once shows `collect-worktree-confirm`, clicking that calls `fetch` with `DELETE /api/w/w1/tasks/t1/worktree` and then `router.refresh()`.

- [ ] **Step 3: Panel.** Import `useRouter`, `useState`, `sendControl`, `GhostButton`, `PrimaryButton`, `TERMINAL` from `@ai-team-os/domain` (value import is fine in a client component — it is a plain array). Add above the Runs section:

```tsx
const collectable = TERMINAL.includes(task.status) && task.runs.some((run) => run.worktreePath !== null)
…
{collectable && (
  <div className="flex items-center gap-2">
    {!confirming ? (
      <GhostButton data-testid="collect-worktree" onClick={() => setConfirming(true)}>Collect worktree</GhostButton>
    ) : (
      <>
        <PrimaryButton tone="blocked" data-testid="collect-worktree-confirm" disabled={pending} onClick={() => void collect()}>
          remove the tree, keep the branch
        </PrimaryButton>
        <GhostButton onClick={() => setConfirming(false)}>cancel</GhostButton>
      </>
    )}
    {collectError !== null && <span role="alert" data-testid="collect-worktree-error" className="text-xs text-tone-blocked">{collectError}</span>}
  </div>
)}
```

with `collect = async () => { setPending(true); const error = await sendControl(`/api/w/${workspaceId}/tasks/${task.id}/worktree`, { method: 'DELETE' }); setPending(false); setConfirming(false); if (error === null) router.refresh(); else setCollectError(error) }`. The panel needs `workspaceId` — add it as a prop (`TasksClient` has it) and update the existing test fixtures.

- [ ] **Step 4: Route:**

```ts
import { collectTaskWorktree } from '@ai-team-os/control'
import { workspaceControlResponse } from '../../../../../../../server/workspaceControlRoute'

export const dynamic = 'force-dynamic'

export async function DELETE(_request: Request, context: { params: Promise<{ workspaceId: string; taskId: string }> }): Promise<Response> {
  const { workspaceId, taskId } = await context.params
  return workspaceControlResponse(workspaceId, () => collectTaskWorktree(taskId, 'operator'))
}
```

(Count the `../` — the file is seven levels below `src`.)

- [ ] **Step 5: Verify.** `npx vitest run apps/web/test/tasks-components.test.tsx`; `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/server/tasks.ts apps/web/src/components/TaskDetailPanel.tsx apps/web/src/components/TasksClient.tsx "apps/web/src/app/api/w/[workspaceId]/tasks/[taskId]/worktree/route.ts" apps/web/test/tasks-components.test.tsx
git commit -m "feat(web): m23 b4 — the task panel collects a terminal task's worktree on request"
```

---

### Task 7: C1–C3 — artifacts in the task panel

**Files:**
- Create: `apps/web/src/lib/artifactLabel.ts`, `apps/web/src/lib/onUnauthorized.ts`, `apps/web/src/app/api/w/[workspaceId]/tasks/[taskId]/artifacts/[artifactId]/route.ts`
- Modify: `apps/web/src/server/tasks.ts` (`TaskBoardItem.artifacts`), `apps/web/src/components/TaskDetailPanel.tsx`, `apps/web/src/lib/postControl.ts` (the 401 branch calls `onUnauthorized()`)
- Test: `apps/web/test/artifactLabel.test.ts` (new), `apps/web/test/tasks-components.test.tsx` (three cases), `apps/web/test/artifact-route.test.ts` (new; unit-level with a temp dir and a stubbed `prisma` via `vi.mock('@ai-team-os/db/client')`, or integration if the folder pattern prefers — match what `ls apps/web/test/integration` shows)

**Interfaces:**
- Produces: `artifactLabel(path: string): string`; `TaskBoardItem.artifacts: readonly { id: string; kind: string; label: string; createdAt: string }[]`; `GET …/artifacts/:artifactId` → `text/plain`, header `X-Artifact-Truncated: 1` when cut at `ARTIFACT_READ_LIMIT = 256 * 1024` bytes (tail-bounded); 403 `{ error: 'artifact path outside the artifact root' }`; 404 for a missing row, a row of another task/workspace, or a missing file.
- Produces: `onUnauthorized(): void` — the `window.location.assign('/login?next=…')` branch of `sendControl`, shared with the artifact fetch.

- [ ] **Step 1: `artifactLabel` unit table** (RED then GREEN):

```ts
it.each([
  ['/r/.aiteamos/artifacts/t/attempt-01/00-npm-test.log', 'attempt 1 · npm-test'],
  ['/r/.aiteamos/artifacts/t/attempt-12/03-npm-run-lint.log', 'attempt 12 · npm-run-lint'],
  ['/r/.aiteamos/artifacts/t/merge/attempt-02/00-npm-test.log', 'merge · npm-test'],
  ['/r/.aiteamos/artifacts/t/whatever.txt', 'whatever.txt'],
])('%s → %s', (path, label) => expect(artifactLabel(path)).toBe(label))
```

Implementation: split on `/`; find the `attempt-NN` segment and the `MM-<slug>.log` basename with one regex each (`/^attempt-(\d+)$/`, `/^\d+-(.+)\.log$/`); `merge` wins when any segment equals `merge`; else basename.

- [ ] **Step 2: DTO.** `include: { artifacts: { orderBy: { createdAt: 'desc' } } }` beside `runs`; map to `{ id, kind, label: artifactLabel(path), createdAt: createdAt.toISOString() }`. Update the test fixture factory (`artifacts: []`).

- [ ] **Step 3: Route** (the traversal check is the whole point — test it with a temp dir):

```ts
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { prisma } from '@ai-team-os/db/client'

export const dynamic = 'force-dynamic'
export const ARTIFACT_READ_LIMIT = 256 * 1024

export async function GET(_request: Request, context: { params: Promise<{ workspaceId: string; taskId: string; artifactId: string }> }): Promise<Response> {
  const { workspaceId, taskId, artifactId } = await context.params
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, taskId, task: { workspaceId } },
    include: { task: { select: { workspace: { select: { repoPath: true } } } } },
  })
  if (artifact === null) return Response.json({ error: 'no such artifact' }, { status: 404 })
  // The row is data, the disk is the authority (spec §4 C2): a path outside the artifact root is
  // refused before it is opened, whatever wrote the row.
  const root = resolve(artifact.task.workspace.repoPath, '.aiteamos', 'artifacts') + sep
  const path = resolve(artifact.path)
  if (!path.startsWith(root)) return Response.json({ error: 'artifact path outside the artifact root' }, { status: 403 })
  const info = await stat(path).catch(() => null)
  if (info === null || !info.isFile()) return Response.json({ error: 'artifact file is gone' }, { status: 404 })
  const buffer = await readFile(path)
  const truncated = buffer.length > ARTIFACT_READ_LIMIT
  const body = truncated ? buffer.subarray(buffer.length - ARTIFACT_READ_LIMIT) : buffer
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...(truncated ? { 'x-artifact-truncated': '1' } : {}) },
  })
}
```

Route test: mock `@ai-team-os/db/client`'s `prisma.artifact.findFirst` to return a row pointing at (a) a file under `<tmp>/.aiteamos/artifacts/x.log` → 200 with the text; (b) `/etc/hostname` → 403; (c) a missing file under the root → 404; (d) a 300 KiB file → 200, header set, body is the last 256 KiB.

- [ ] **Step 4: Panel section** after Runs: `<SectionLabel>Artifacts</SectionLabel>`, `no artifacts yet` when empty, else a list of `<button data-testid="artifact-row">` rows (`label` + `createdAt.slice(11, 19)`); clicking fetches `/api/w/${workspaceId}/tasks/${task.id}/artifacts/${id}` with `fetch`, on 401 calls `onUnauthorized()`, on other non-2xx shows `errorMessage`, on 200 sets `{ id, text, truncated: response.headers.get('x-artifact-truncated') === '1' }` and renders `<pre data-testid="artifact-body" className="max-h-64 overflow-auto rounded border border-line bg-bg-2 p-2 font-mono text-[10px] text-text-2">` plus `<span data-testid="artifact-truncated">truncated to the last 256 KiB</span>` when flagged. Tests: empty state text; rows render labels; clicking calls fetch with the right URL and shows the body.

- [ ] **Step 5: `onUnauthorized`.** Move the four-line 401 branch out of `sendControl` into `lib/onUnauthorized.ts`; `sendControl` calls it; `postControl.test.ts` still passes.

- [ ] **Step 6: Verify.** `npx vitest run apps/web/test/artifactLabel.test.ts apps/web/test/artifact-route.test.ts apps/web/test/tasks-components.test.tsx apps/web/test/postControl.test.ts`; web tsc; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/lib/artifactLabel.ts apps/web/src/lib/onUnauthorized.ts apps/web/src/lib/postControl.ts "apps/web/src/app/api/w/[workspaceId]/tasks/[taskId]/artifacts/[artifactId]/route.ts" apps/web/src/server/tasks.ts apps/web/src/components/TaskDetailPanel.tsx apps/web/test/artifactLabel.test.ts apps/web/test/artifact-route.test.ts apps/web/test/tasks-components.test.tsx
git commit -m "feat(web): m23 c — verify logs readable from the task panel, never from outside the artifact root"
```

---

### Task 8: G3 — the placeholder repo path becomes a real directory

**Files:**
- Modify: `packages/control/test/integration/goal.test.ts`, `packages/control/test/integration/org.test.ts` (three sites: lines ~324, ~608, ~720 at `c073259`), `packages/control/test/integration/workspace-settings.test.ts`

- [ ] **Step 1:** In each file add `import { mkdtempSync, rmSync } from 'node:fs'`, `import { tmpdir } from 'node:os'`, `import { join } from 'node:path'`; a module-level `const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-control-<file>-'))` and `afterAll(() => rmSync(repoPath, { recursive: true, force: true }))`; replace every `'/tmp/does-not-matter'` with `repoPath`. Comment at the const, once per file: `// A real directory, not a placeholder (M23 G3): runFilePaths' statSync preflight refuses a repo path that does not exist, and a reboot clears /tmp -- the trap emergency.test.ts fell into at ce48adc.`

- [ ] **Step 2:** `grep -rn "does-not-matter" packages apps` → only `packages/providers/test/pause-signal.test.ts` remains (it is a providers test with its own reason — leave it, note it in the report). `npx vitest run packages/control/test/integration/goal.test.ts packages/control/test/integration/org.test.ts packages/control/test/integration/workspace-settings.test.ts` → PASS.

- [ ] **Step 3: Commit.**

```bash
git add packages/control/test/integration/goal.test.ts packages/control/test/integration/org.test.ts packages/control/test/integration/workspace-settings.test.ts
git commit -m "test(control): m23 g3 — three fixtures point at a directory that exists"
```

---

### Task 9: D1 — five roster verbs and `org.changed`

**Files:**
- Modify: `packages/control/src/org.ts` (five verbs; `setAgentModel` emits `org.changed`), `packages/control/src/refusal.ts`
- Modify: `packages/db/prisma/schema.prisma` (`org_changed @map("org.changed")`), `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts`, `apps/web/src/components/activity/cards.tsx`
- Create: `packages/db/prisma/migrations/20260903120000_m23_org_changed_event/migration.sql`
- Test: `packages/control/test/integration/org-edit.test.ts` (new), `packages/control/test/integration/org.test.ts` (setAgentModel now emits — one assertion added), `apps/web/test/activity-cards.test.tsx`

**Interfaces:**
- Produces (spec §5 D1 signatures, each with trailing `principal?: Principal`): `renameAgent(agentId, name)`, `setAgentRole(agentId, role)`, `deleteAgent(agentId)`, `renameTeam(teamId, name)`, `deleteTeam(teamId)` → `Result<void, ControlRefusal>`.
- Refusal kinds: `invalid_role`, `agent_run_active { agentId, runId }`, `agent_has_runs { agentId, runs: number }`, `team_not_found { teamId }`, `team_not_empty { teamId, agents: number }`; `duplicate_name` reused.
- Event `org.changed` payload `{ entity: 'agent' | 'team', id, field: 'name' | 'role' | 'model' | 'deleted', from: string, to: string | null }`, `workspaceId` = the team's workspace, `agentId` set for agent entities.

- [ ] **Step 1: Migration + enum + Zod + map + card.** As in Task 4. Zod payload: `z.object({ entity: z.enum(['agent', 'team']), id: z.string().min(1), field: z.enum(['name', 'role', 'model', 'deleted']), from: z.string(), to: z.string().nullable() })`. Card `OrgChangedCard`: label by field (`renamed` / `role changed` / `model changed` / `deleted`), body `{from} → {to ?? '—'}` with testids `org-from`/`org-to`, tone `idle`.

- [ ] **Step 2: Failing tests** in `org-edit.test.ts`: seed a workspace (real temp dir — Task 8's shape), a team, two agents (one with a `succeeded` run, one without), a task. Cases: rename ok + event; rename to a sibling's name → `duplicate_name` (within the team: enforce with a `findFirst({ where: { teamId, name, NOT: { id } } })` inside the tx — there is no unique index on `(teamId, name)`); blank → `invalid_name`; `setAgentRole` ok + event; blank → `invalid_role`; with a `working` run → `agent_run_active`; `deleteAgent` on the run-less agent → ok, row gone, event `{ field: 'deleted', from: name, to: null }`; on the agent with runs → `agent_has_runs`; `renameTeam` ok/duplicate/blank; `deleteTeam` with agents → `team_not_empty`; empty team → ok + event; unknown ids → `agent_not_found` / `team_not_found`. In `org.test.ts` `setAgentModel` block: assert one `org_changed` event with `field: 'model'`.

- [ ] **Step 3: The verbs.** One private helper does the lock + lookup:

```ts
async function lockAgent(tx: Prisma.TransactionClient, agentId: string) {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${agentId} FOR UPDATE`
  return tx.agent.findUnique({ where: { id: agentId }, include: { team: { select: { id: true, workspaceId: true } }, runs: { select: { id: true, status: true } } } })
}
```

`renameAgent`: trim → `invalid_name`; tx: lock, null → `agent_not_found`; sibling check → `duplicate_name`; `update`; return `{ workspaceId, from }`; then `appendEvent('org.changed', { entity: 'agent', id, field: 'name', from, to: name }, agentId)`. `setAgentRole`: same with `invalid_role` and the live-run check (`NON_TERMINAL_RUN_STATUSES.includes(run.status)` → `agent_run_active`). `deleteAgent`: `runs.length > 0` → `agent_has_runs`; `delete`; event with `to: null`. `renameTeam` / `deleteTeam`: lock `"Team"`, `agents.length > 0` → `team_not_empty`; duplicate within workspace. `setAgentModel`: after the `updateMany` succeeds, fetch `from`/`to` as `${model ?? '—'}@${provider ?? '—'}` strings and emit `field: 'model'` — it needs the workspaceId, so widen its existing `select` to include `team.workspaceId`. Refusal texts: `a role must be a non-empty text`, `agent ${agentId} has a live run (${runId}); change its role when the run has ended`, `agent ${agentId} has ${runs} run(s) in history and stays (rename it or leave it idle)`, `no team with id ${teamId}`, `team ${teamId} still has ${agents} agent(s)`.

- [ ] **Step 4: Verify.** `npx tsc --build`; `npx vitest run packages/control/test/integration/org-edit.test.ts packages/control/test/integration/org.test.ts apps/web/test/activity-cards.test.tsx`.

- [ ] **Step 5: Commit.**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260903120000_m23_org_changed_event packages/db/src/enums.ts packages/domain/src/events/schema.ts packages/control/src/org.ts packages/control/src/refusal.ts packages/control/test/integration/org-edit.test.ts packages/control/test/integration/org.test.ts apps/web/src/components/activity/cards.tsx apps/web/test/activity-cards.test.tsx
git commit -m "feat(control): m23 d1 — rename, re-role, delete: the roster is editable and every edit is an event"
```

---

### Task 10: D2 + D3 — CLI and Settings surfaces for the roster

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (five cases + USAGE)
- Create: `apps/web/src/app/api/agents/[agentId]/name/route.ts`, `…/[agentId]/role/route.ts`, `…/[agentId]/route.ts` (DELETE), `apps/web/src/app/api/teams/[teamId]/name/route.ts`, `…/[teamId]/route.ts` (DELETE), `apps/web/src/components/company/AgentRowActions.tsx`
- Modify: `apps/web/src/components/company/TeamBlock.tsx` (`MemberRow` gains the actions column; team header gains rename/delete), `apps/web/src/server/org.ts` (`RosterMemberRow` must carry the project `agentId` and the team id — check what it carries; the roster rows are `CompanyAgent`s, while the verbs act on project `Agent`s. If `RosterMemberRow` has no project agent id, the actions belong on the WORKERS list (`listWorkers`, the Agents page) instead — decide by reading `org.ts`, and put the actions where the project `Agent.id` is; state the choice in the commit message)
- Test: `apps/orchestrator/test/integration/cli.test.ts` (five cases), `apps/web/test/agent-row-actions.test.tsx` (new)

**Interfaces:**
- Consumes: Task 9's verbs, `orgControlResponse`, `sendControl` (PUT/DELETE).
- Produces: routes `PUT /api/agents/:id/name { name }`, `PUT /api/agents/:id/role { role }`, `DELETE /api/agents/:id`, `PUT /api/teams/:id/name { name }`, `DELETE /api/teams/:id`; CLI `rename-agent --agent --name`, `set-role --agent --role`, `delete-agent --agent --yes`, `rename-team --team --name`, `delete-team --team --yes`.

- [ ] **Step 1: CLI tests** (RED): each command's success line (`agent <id> renamed`, `role set to <r> on <id>`, `agent <id> deleted`, `team <id> renamed`, `team <id> deleted`); `delete-agent` without `--yes` → exit 1, stderr `refusing without --yes: this would delete agent <name> (<id>)`; a refusal text passthrough (`agent_has_runs`).

- [ ] **Step 2: CLI cases** in the `add-agent` style; the two deletes look the row up first (`prisma.agent.findUnique` for the name in the refusal line) and check `'yes' in flags`. USAGE lines after `set-model`.

- [ ] **Step 3: Routes** — the `model/route.ts` shape: a `BODY_ERROR`, a string check, `orgControlResponse(() => verb(...))`. DELETE routes take no body.

- [ ] **Step 4: `AgentRowActions`** (`'use client'`): props `{ agentId, name, role }`; state `editing: 'name' | 'role' | null`, `draft`, `confirmingDelete`, `pending`, `errorText`. Renders the name as a button (`data-testid="agent-name-edit"`) that swaps to a `TextField` (`agent-name-input`) saving on Enter / blur via `sendControl(`/api/agents/${agentId}/name`, { method: 'PUT', body: { name: draft } })`; same for role (`agent-role-edit` / `agent-role-input`); a `PrimaryButton tone="blocked"` `agent-delete` → `agent-delete-confirm` (DangerZone two-step) → `sendControl(…, { method: 'DELETE' })`; `router.refresh()` on success; `role="alert"` `agent-actions-error`. Tests: rename PUTs the body; role PUTs; delete needs two clicks; refusal shows. Mount it where the project `Agent.id` is available (see Files).

- [ ] **Step 5: Team header:** in `TeamBlock` (or the workers list's team grouping) a `team-rename` inline editor and `team-delete` two-step button, `disabled` with `title="team has agents"` when `members.length > 0`.

- [ ] **Step 6: Verify.** `npx vitest run apps/orchestrator/test/integration/cli.test.ts apps/web/test/agent-row-actions.test.tsx apps/web/test/settings-page.test.tsx apps/web/test/agents-page.test.tsx`; web tsc; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 7: Commit.**

```bash
git add apps/orchestrator/src/cli.ts apps/orchestrator/test/integration/cli.test.ts "apps/web/src/app/api/agents/[agentId]/name/route.ts" "apps/web/src/app/api/agents/[agentId]/role/route.ts" "apps/web/src/app/api/agents/[agentId]/route.ts" "apps/web/src/app/api/teams/[teamId]/name/route.ts" "apps/web/src/app/api/teams/[teamId]/route.ts" apps/web/src/components/company/AgentRowActions.tsx apps/web/src/components/company/TeamBlock.tsx apps/web/src/server/org.ts apps/web/test/agent-row-actions.test.tsx
git commit -m "feat(web,cli): m23 d2/d3 — the roster is edited from the CLI and from Settings"
```

---

### Task 11: E1 + E2 — the communication fold and its route

**Files:**
- Create: `apps/web/src/lib/communicationFold.ts`, `apps/web/src/server/communicationGraph.ts`, `apps/web/src/app/api/w/[workspaceId]/graph/communication/route.ts`
- Test: `apps/web/test/communicationFold.test.ts` (new, unit), `apps/web/test/integration/communication-graph.test.ts` if the integration folder has a `skill-graph` precedent (`ls apps/web/test/integration`), else one more unit case over a stubbed `prisma`

**Interfaces:**
- Produces: `foldCommunication(events: readonly FoldEvent[]): { edges: CommunicationEdge[] }` where `FoldEvent = { type: DomainEventType; agentId: string | null; taskId: string | null; actor: string; payload: unknown; seq: number }` and `CommunicationEdge = { from: string; to: string; count: number; kind: 'plan' | 'review' | 'rework' | 'message' }`; `from`/`to` are agent ids, or the literal `'operator'`.
- Produces: `buildCommunicationGraph(workspaceId): Promise<CommunicationGraph | null>` (spec §6 E2 shape) and `GET /api/w/:id/graph/communication`, `COMMUNICATION_EVENT_LIMIT = 500`.

- [ ] **Step 1: Unit table** (RED). Events as arrays of `FoldEvent` in `seq` order; one `it` per spec §6 E1 row plus "self-edges dropped" and "unknown implementer (no run.started) yields no edge":
  - plan: `workspace.plan_created` by `mgr` with `payload.tasks = [{ id: 't1' }]`, then `run.started` on `t1` by `alex` → `{ from: 'mgr', to: 'alex', kind: 'plan', count: 1 }`.
  - review: `run.started` t1 by `alex`, `task.review_started` t1 by `maya` → `alex → maya review`.
  - rework: `task.review_rejected` t1 by `maya`, then `run.started` t1 by `alex` → `maya → alex rework`.
  - message: `agent.message_sent` with `actor: 'human'`, `taskId: 't1'`, `agentId: 'alex'` → `operator → alex message`.
  - counts accumulate across repeats; edges sorted by `(from, to, kind)`.

- [ ] **Step 2: The fold.** Keep per-task state: `implementerByTask: Map<taskId, agentId>` (latest `run.started`'s agentId), `plannedBy: Map<taskId, plannerId>` (from `plan_created`), `pendingRework: Map<taskId, reviewerId>` (set by `review_rejected`, consumed by the next `run.started`). On `run.started`: if `plannedBy.has(task)` and planner ≠ agent, bump `plan`, delete the plan entry (one edge per planned task's first run); if `pendingRework.has(task)`, bump `rework`, delete; set implementer. On `review_started`: implementer known and ≠ reviewer → bump `review`. On `message_sent` with `actor === 'human'` and an `agentId` → bump `operator → agentId message`. Bump = `Map<`${from}|${to}|${kind}`, edge>`.

- [ ] **Step 3: Server.** `buildCommunicationGraph`: workspace lookup (404 path), `prisma.agent.findMany({ where: { team: { workspaceId } }, select: { id, name, role } })`, `prisma.executionEvent.findMany({ where: { workspaceId, type: { in: ['workspace_plan_created', 'run_started', 'task_review_started', 'task_review_rejected', 'agent_message_sent'] } }, orderBy: { seq: 'desc' }, take: COMMUNICATION_EVENT_LIMIT, select: { type, agentId, taskId, actor, payload, seq } })`, reverse to ascending, map `type` through `DOMAIN_EVENT_TYPE_BY_DB_VALUE`, fold, return `{ agents, edges }`. Route: the `skill-graph/route.ts` shape.

- [ ] **Step 4: Verify + commit.**

```bash
git add apps/web/src/lib/communicationFold.ts apps/web/src/server/communicationGraph.ts "apps/web/src/app/api/w/[workspaceId]/graph/communication/route.ts" apps/web/test/communicationFold.test.ts
git commit -m "feat(web): m23 e2 — who handed what to whom, folded from the log"
```

---

### Task 12: E3 — the Communication tab

**Files:**
- Create: `apps/web/src/components/graph/CommunicationMode.tsx`, `apps/web/src/components/graph/CommunicationNodes.tsx`
- Modify: `apps/web/src/components/graph/GraphClient.tsx` (`GraphMode` gains `'comm'`; `isGraphMode`; `MODE_TABS` `{ mode: 'comm', label: 'Communication' }`; `commFrameTick` bumped on the five frame types; render branch)
- Test: `apps/web/test/graph-comm.test.tsx` (new, the `graph-skill.test.tsx` shape), `apps/web/test/graph-page.test.tsx` (the tab list assertion gains the fifth label)

**Interfaces:**
- Consumes: `CommunicationGraph`, `CableEdge` (`data.weight`), `useLayoutedGraph(nodes, edges, 'layered')`, `OrgNodes`' `AgentNode` type if reusable (check `ORG_NODE_TYPES`; else a minimal `CommAgentNode` with name + role in `CommunicationNodes.tsx`).
- Produces: `buildCommunicationGraph(graph: CommunicationGraph): { nodes: Node[]; edges: Edge[] }` — node ids `agent:<id>` and one `operator` node (`id: 'operator'`, label `operator`); edge id `${from}->${to}:${kind}`, `type: 'cable'`, `data: { tone, active: false, weight: count }` with tone by kind (`plan` → `planning`, `review` → `working`, `rework` → `warn`, `message` → `idle` — confirm these are `StatusTone`/CableEdge tone members; if `warn` is not, use `waiting`).

- [ ] **Step 1: Tests** (RED): the tab renders and switches `?mode=comm`; `CommunicationMode` fetches `/api/w/w1/graph/communication` on mount (stub `fetch`), renders `comm-empty` for `{ agents: [], edges: [] }`, and renders N agent nodes + edges for a two-edge graph; a `commFrameTick` change refetches after 2 s (fake timers, the `graph-skill.test.tsx` pattern).

- [ ] **Step 2: `CommunicationMode`** = `SkillMode` minus the run strip: `EMPTY`, `COMM_REFETCH_DEBOUNCE_MS = 2_000`, `fetchCommunicationGraph`, the mount fetch, the `tickRef` debounce, `useMemo(buildCommunicationGraph)`, `useLayoutedGraph(…, 'layered')`, `GraphCanvas` with `nodeTypes`, the empty band `<p data-testid="comm-empty">no hand-offs yet — edges appear as tasks move between agents</p>`.

- [ ] **Step 3: `GraphClient`.** Bump `commFrameTick` in `onGraphEvent` when `event.type` is one of `run.started | task.review_started | task.review_rejected | agent.message_sent | workspace.plan_created`; render `{mode === 'comm' && <CommunicationMode workspaceId={workspaceId} frameTick={commFrameTick} />}`.

- [ ] **Step 4: Verify.** `npx vitest run apps/web/test/graph-comm.test.tsx apps/web/test/graph-page.test.tsx apps/web/test/graph-skill.test.tsx`; web tsc; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/graph/CommunicationMode.tsx apps/web/src/components/graph/CommunicationNodes.tsx apps/web/src/components/graph/GraphClient.tsx apps/web/test/graph-comm.test.tsx apps/web/test/graph-page.test.tsx
git commit -m "feat(web): m23 e3 — the fifth graph mode: communication, cables as thick as the traffic"
```

---

### Task 13: F2 + F3 — `User`, PBKDF2, the user verbs, the user CLI

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`model User`), create `packages/db/prisma/migrations/20260903130000_m23_accounts/migration.sql`
- Create: `packages/control/src/password.ts`, `packages/control/src/users.ts`
- Modify: `packages/control/src/refusal.ts` (`invalid_username`, `weak_password`, `user_not_found`), `packages/control/src/index.ts`, `apps/orchestrator/src/cli.ts` (four commands, stdin password)
- Test: `packages/control/test/password.test.ts` (unit), `packages/control/test/integration/users.test.ts`, `apps/orchestrator/test/integration/cli.test.ts` (stdin cases via `spawn` with `input`)

**Interfaces:**
- Produces: `hashPassword(password: string): Promise<string>` (`pbkdf2-sha256$600000$<salt hex>$<hash hex>`), `verifyPassword(password: string, stored: string): Promise<boolean>`, `DUMMY_HASH` (a valid hash of a random string, computed once at module load, for the missing-user path).
- Produces (spec §7 F3): `createUser(username, password)` → `Result<{ id }, ControlRefusal>`, `setPassword(username, password)`, `deleteUser(username)`, `listUsers()`, `verifyCredentials(username, password): Promise<{ id; username } | null>`. `USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/`, `MIN_PASSWORD_LENGTH = 12`.
- CLI: `create-user --name <u>` (password = first line of stdin), `set-password --name <u>` (same), `delete-user --name <u> --yes`, `list-users`.

- [ ] **Step 1: Migration.**

```sql
-- M23 F2: local accounts. The table only; the event and task columns that point at it come with
-- the attribution task (m23_event_user), so this migration is safe on its own.
CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
```

Schema: `model User { id String @id @default(uuid()); username String @unique; passwordHash String; createdAt DateTime @default(now()) }`. Generate + migrate both DBs. Add `"User"` to every integration test's TRUNCATE list that will create users (only `users.test.ts` and, later, Task 15's).

- [ ] **Step 2: `password.ts`** (RED: a known-answer test — hash a fixed password with a fixed salt via an exported `hashWithSalt(password, salt: Uint8Array)` and compare to a vector you compute ONCE with `node -e` using `crypto.pbkdf2Sync(pw, salt, 600000, 32, 'sha256')` and paste as the expected hex; round trip; wrong password false; malformed stored string false; `verifyPassword` against `DUMMY_HASH` takes about as long as a real one — assert both ≥ 50 ms rather than equality):

```ts
const ITERATIONS = 600_000
const KEY_BYTES = 32
const encoder = new TextEncoder()
const subtle = globalThis.crypto.subtle

function hex(bytes: ArrayBuffer | Uint8Array): string { … }
function fromHex(text: string): Uint8Array { … }

export async function hashWithSalt(password: string, salt: Uint8Array, iterations = ITERATIONS): Promise<string> {
  const key = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BYTES * 8)
  return `pbkdf2-sha256$${iterations}$${hex(salt)}$${hex(bits)}`
}
export async function hashPassword(password: string): Promise<string> {
  return hashWithSalt(password, globalThis.crypto.getRandomValues(new Uint8Array(16)))
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsText, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'pbkdf2-sha256' || iterationsText === undefined || saltHex === undefined || hashHex === undefined) return false
  const iterations = Number(iterationsText)
  if (!Number.isInteger(iterations) || iterations < 1) return false
  const candidate = await hashWithSalt(password, fromHex(saltHex), iterations)
  return constantTimeEqual(candidate, stored)
}
/** A real hash of a random secret, so a missing user costs the same derivation as a wrong password. */
export const DUMMY_HASH: Promise<string> = hashPassword(hex(globalThis.crypto.getRandomValues(new Uint8Array(16))))
```

`constantTimeEqual` = XOR loop over equal-length strings (lengths always match for well-formed input; a length mismatch returns false after the loop over the shorter, which is fine — the derivation is the timing-relevant part).

- [ ] **Step 3: `users.ts`** (RED via `users.test.ts`: create/duplicate/invalid/weak, set-password changes verification, delete removes, `verifyCredentials` right/wrong/missing, `listUsers` order by username):

```ts
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/
export const MIN_PASSWORD_LENGTH = 12

export async function createUser(username: string, password: string): Promise<Result<{ id: string }, ControlRefusal>> {
  if (!USERNAME_RE.test(username)) return err({ kind: 'invalid_username', username })
  if (password.length < MIN_PASSWORD_LENGTH) return err({ kind: 'weak_password', minimum: MIN_PASSWORD_LENGTH })
  try {
    const user = await prisma.user.create({ data: { username, passwordHash: await hashPassword(password) } })
    return ok({ id: user.id })
  } catch (cause) {
    if (isUniqueConstraintViolation(cause)) return err({ kind: 'duplicate_name', name: username })
    throw cause
  }
}
export async function verifyCredentials(username: string, password: string): Promise<{ id: string; username: string } | null> {
  const user = await prisma.user.findUnique({ where: { username } })
  // The derivation runs either way (spec §7 F3): a missing user must not answer faster.
  const stored = user?.passwordHash ?? (await DUMMY_HASH)
  const valid = await verifyPassword(password, stored)
  return valid && user !== null ? { id: user.id, username: user.username } : null
}
```

`setPassword`, `deleteUser` (`updateMany`/`deleteMany` count 0 → `user_not_found`), `listUsers`. Refusal texts: `a username is 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit`, `a password must be at least ${minimum} characters`, `no user named ${username}`. Note: `users.ts` imports `prisma` from `@ai-team-os/db/client` like the other verbs.

- [ ] **Step 4: CLI.** A helper `readSecretLine(): Promise<string>` reads stdin to the first `\n` (or EOF) and strips `\r`; cases `create-user`, `set-password` (`if (password.length === 0) throw new Error('the password is read from stdin: printf "%s\\n" "$PW" | … create-user --name ada')`), `delete-user` (`--yes` guard), `list-users` (one `username  createdAt` line each). USAGE block under a `users` heading with the stdin sentence. Tests use `spawn` with `input` piped: `execFileAsync('node', [CLI, 'create-user', '--name', 'ada'], { env, input? })` — `execFile` has no `input`; use `spawn` and write to `child.stdin` in a small `runCliWithStdin` helper beside `runCli`.

- [ ] **Step 5: Verify + commit.**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260903130000_m23_accounts packages/control/src/password.ts packages/control/src/users.ts packages/control/src/refusal.ts packages/control/src/index.ts packages/control/test/password.test.ts packages/control/test/integration/users.test.ts apps/orchestrator/src/cli.ts apps/orchestrator/test/integration/cli.test.ts
git commit -m "feat(control,cli): m23 f2/f3 — local users, PBKDF2 on Web Crypto, passwords from stdin"
```

---

### Task 14: F1 + F4 + F5 — the switch, the session, the door

**Files:**
- Modify: `apps/web/src/lib/authEnv.ts`, `apps/web/src/lib/session.ts`, `apps/web/src/lib/boundary.ts`, `apps/web/src/middleware.ts`, `apps/web/src/app/api/auth/login/route.ts`, `apps/web/src/app/api/auth/logout/route.ts` (unchanged unless it reads the password), `apps/web/src/components/LoginForm.tsx`, `apps/web/src/app/login/page.tsx`, `apps/web/src/app/settings/page.tsx`, `apps/web/src/components/SettingsClient.tsx`, `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/server/principal.ts`, `apps/web/src/app/api/auth/me/route.ts` (optional but cheap: `{ username }` for the gate; skip if unneeded)
- Modify: `scripts/web-exposed.mjs`, `scripts/lib/child-env.mjs`, `.env.example`
- Test: `apps/web/test/authEnv.test.ts`, `session.test.ts`, `boundary.test.ts`, `auth-routes.test.ts`, `login-form.test.tsx`, `login-page.test.tsx`, `settings-page.test.tsx`, `web-exposed.test.ts` (rewritten for the new refusals), `apps/web/test/principal.test.ts` (new)

**Interfaces:**
- `authEnv.ts`: `BoundaryMode = 'loopback-only' | 'accounts'`; `sessionSecret(): string | null` (trimmed `AITEAMOS_SESSION_SECRET`); `boundaryMode()`.
- `session.ts`: `mintSession(secret, userId, now): Promise<string>` → `<userId>.<expiresAt>.<hex>`; `verifySession(secret, value, now): Promise<{ userId: string } | null>`; `verifyBearer` deleted; `digestEqual`, `sessionCookieHeader`, `requestIsHttps`, `SESSION_COOKIE`, `SESSION_TTL_SECONDS` unchanged.
- `boundary.ts`: `BoundaryRequest` loses `bearerValid`; `mode: 'accounts'` takes password mode's rows (rule 4: a session opens every path; no bearer). `postureFor(mode, username?: string | null)`: `'accounts · signed in as <u> · cross-site requests refused'` (or `'accounts · not signed in · …'` when null) / the loopback string byte for byte.
- `server/principal.ts`: `currentPrincipal(): Promise<Principal | null>` (`cookies()` → `verifySession` → `prisma.user.findUnique`), `Principal = { userId; username }`.
- Login body `{ username, password }`; 401 text `wrong username or password`.
- `web-exposed.mjs`: refuses (exit 2) when the secret is blank, shorter than 32 characters, or `SELECT count(*) FROM "User"` is 0 (through `packages/db/dist/client.js`, `--env-file=.env` already loads `DATABASE_URL`); stderr lines name which.
- `loopbackChildEnv`: blanks BOTH `AITEAMOS_SESSION_SECRET` and `AITEAMOS_PASSWORD`.

- [ ] **Step 1: RED across the six existing test files.** Update `authEnv.test.ts` (secret instead of password; `'accounts'`), `session.test.ts` (three-part value, `{ userId }` result, tamper on each part, expiry), `boundary.test.ts` (rename the `password` mode rows to `accounts`, drop bearer rows, add "accounts + no session + /api → unauthenticated 401 reason `sign in first`"), `auth-routes.test.ts` (stub env secret; mock `@ai-team-os/control`'s `verifyCredentials`; 404 unconfigured; 204 + cookie whose `verifySession` yields the user id; 401 slow on wrong credentials AND on unknown user), `login-form.test.tsx` (two fields), `login-page.test.tsx`, `settings-page.test.tsx` (posture with a username — `page.tsx` calls `currentPrincipal()`; mock it), `web-exposed.test.ts` (three refusals; the stub path; a fake `DATABASE_URL`? — no: the script must ask the DB only AFTER the two cheap checks pass, so the two cheap refusals are unit-testable without a DB, and the zero-users case is tested by pointing `DATABASE_URL` at `TEST_DATABASE_URL` with the `User` table truncated). Run them → FAIL.

- [ ] **Step 2: `authEnv.ts`, `session.ts`, `boundary.ts`, `middleware.ts`.** Session signing: key = `importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' })`; sign `"<userId>.<expiresAt>"`; verify splits on `.` into exactly three parts, userId non-empty and `/^[A-Za-z0-9-]{1,64}$/`, expiry digits, then `digestEqual`. Middleware: `const secret = sessionSecret(); const mode = secret === null ? 'loopback-only' : 'accounts'; const session = secret === null ? null : await verifySession(secret, cookie, new Date())`; `boundaryVerdict({ mode, …, sessionValid: session !== null })`. Everything else in the middleware stays (the Location construction comment included).

- [ ] **Step 3: `server/principal.ts`:**

```ts
import { cookies } from 'next/headers'
import { prisma } from '@ai-team-os/db/client'
import { sessionSecret } from '../lib/authEnv'
import { SESSION_COOKIE, verifySession } from '../lib/session'

export interface Principal { readonly userId: string; readonly username: string }

/** The signed-in user, or null: loopback mode (no accounts), no/invalid cookie, or a cookie
 *  whose user was deleted since — the one revocation story (spec §7 F4). Stateless middleware
 *  admitted the request; this is where the database gets its say. */
export async function currentPrincipal(): Promise<Principal | null> {
  const secret = sessionSecret()
  if (secret === null) return null
  const value = (await cookies()).get(SESSION_COOKIE)?.value ?? null
  const session = await verifySession(secret, value, new Date())
  if (session === null) return null
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, username: true } })
  return user === null ? null : { userId: user.id, username: user.username }
}

/** For API routes in accounts mode: a null principal is 401 `session revoked`. */
export async function requirePrincipal(): Promise<{ principal: Principal | null } | { response: Response }> {
  if (sessionSecret() === null) return { principal: null }
  const principal = await currentPrincipal()
  return principal === null ? { response: Response.json({ error: 'session revoked' }, { status: 401 }) } : { principal }
}
```

Root layout: it is a server component — `const principal = await currentPrincipal(); if (sessionSecret() !== null && principal === null && !isPublicPage) redirect('/login')` is NOT possible in a layout without the pathname; instead do the revoked-user check in `middleware`? It cannot reach the DB. Decision: pages keep trusting the signature (the middleware), and the revoked-user check lives in `requirePrincipal` for every `/api/` mutation + the Settings page's posture (it shows `not signed in`). Record this in the spec Errata ("page reads by a deleted user's still-valid cookie succeed until expiry; every write is refused") — the gate's stage 8 asserts the API 401, not a page redirect.

- [ ] **Step 4: Login route/page/form, Settings.** Route: `usernameFrom`/`passwordFrom`, `verifyCredentials` from `@ai-team-os/control`, the same `failureGate`; `mintSession(secret, user.id, new Date())`. Form: `login-username` (autoComplete `username`) above `login-password`. Settings page: `const principal = await currentPrincipal()` → `posture={postureFor(mode, principal?.username ?? null)}`; `LogoutButton` when `mode === 'accounts'`.

- [ ] **Step 5: Scripts + env.** `web-exposed.mjs`: replace the password check with the three checks (blank → `set AITEAMOS_SESSION_SECRET in .env first (openssl rand -hex 32)`; short → `AITEAMOS_SESSION_SECRET is shorter than 32 characters`; zero users → `no users yet: create one with npm run orchestrator -- create-user --name <you>`), the DB check via `const { prisma } = await import('../packages/db/dist/client.js')` in a try that reports `could not count users: <message>` as a refusal too, `await prisma.$disconnect()` before spawning. `child-env.mjs` blanks both variables (comment says why the retired one stays blanked). `.env.example`: replace the `AITEAMOS_PASSWORD` block with the secret's, three lines of guidance.

- [ ] **Step 6: Verify.** The six + new test files GREEN; `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npm run web:build && rm -rf apps/web/.next`; `npm run gate:m15-boundary` → PASS (loopback byte for byte). `grep -rn AITEAMOS_PASSWORD apps packages scripts README.md .env.example` → only `child-env.mjs` and the gates that Task 16 rewrites.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/lib/authEnv.ts apps/web/src/lib/session.ts apps/web/src/lib/boundary.ts apps/web/src/middleware.ts apps/web/src/app/api/auth/login/route.ts apps/web/src/components/LoginForm.tsx apps/web/src/app/login/page.tsx apps/web/src/app/settings/page.tsx apps/web/src/components/SettingsClient.tsx apps/web/src/server/principal.ts scripts/web-exposed.mjs scripts/lib/child-env.mjs .env.example apps/web/test/authEnv.test.ts apps/web/test/session.test.ts apps/web/test/boundary.test.ts apps/web/test/auth-routes.test.ts apps/web/test/login-form.test.tsx apps/web/test/login-page.test.tsx apps/web/test/settings-page.test.tsx apps/web/test/web-exposed.test.ts apps/web/test/principal.test.ts
git commit -m "feat(web): m23 f1/f4/f5 — accounts mode: a secret, a user-bound cookie, a username on the door"
```

---

### Task 15: F6 — attribution: `userId` on the envelope, `principal` through every verb

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`ExecutionEvent.userId String?` + relation + `@@index([userId])`; `Task.createdByUserId String?`; `Workspace.goalSetByUserId String?`; `User` gains the back-relations), create `packages/db/prisma/migrations/20260903140000_m23_event_user/migration.sql`
- Modify: `packages/domain/src/events/schema.ts` (`envelope.userId: z.string().min(1).nullable().optional()`), `packages/db/src/mappers.ts` (`userId` into the candidate), `packages/events/src/append.ts` (`AppendableEvent.userId?: string | null`, written)
- Modify: every control verb that appends or creates: `goal.ts`, `pause.ts`, `resume.ts`, `stop.ts`, `emergency.ts`, `dependency.ts`, `workspace.ts` (3 verbs), `org.ts` (assignCompany, setAgentModel, the five D1 verbs), `collect.ts` — trailing `principal?: Principal`, `userId: principal?.userId ?? null` on the append; `setGoal` also writes `goalSetByUserId`
- Modify: `apps/orchestrator/src/planning.ts` (`createdByUserId: workspace.goalSetByUserId` on `task.create`)
- Modify: every web route that calls a verb: read `requirePrincipal()` and pass `principal ?? undefined` (routes under `apps/web/src/app/api/**` — `grep -rln "@ai-team-os/control" apps/web/src/app/api` lists them); `workspaceControlResponse`/`orgControlResponse` unchanged (the route passes the principal into the closure)
- Modify: `apps/web/src/server/activity.ts` (`ActivityEventRow.userId: string | null`; `ActivityPage.users: { id, username }[]`; `buildActivityHistory` selects `userId`), `apps/web/src/components/activity/ActivityCard.tsx` (`ActivityCardProps.userName: string | null`; header renders `by <username>` after the actor badge when present, `data-testid="event-user"`), `apps/web/src/components/activity/Timeline.tsx` (resolves `userName` from a `userNameById` map like `agentNameById`)
- Test: `packages/events/test/integration/append.test.ts` (userId round trip), `packages/control/test/integration/goal.test.ts` (principal → `userId` on the event and `goalSetByUserId`), `apps/orchestrator/test/integration/planning.test.ts` (task inherits `createdByUserId`), `apps/web/test/activity-cards.test.tsx` (`by ada`), `apps/web/test/activity-page.test.tsx`

**Interfaces:**
- Consumes: `Principal` (Task 1), `requirePrincipal` (Task 14).
- Produces: `AppendableEvent.userId`; `ExecutionEvent.userId?: string | null` in the domain; `ActivityCardProps.userName`.

- [ ] **Step 1: Migration.**

```sql
-- M23 F6: who did it. Nullable everywhere -- the CLI and the orchestrator have no user.
ALTER TABLE "ExecutionEvent" ADD COLUMN IF NOT EXISTS "userId" TEXT;
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "ExecutionEvent_userId_idx" ON "ExecutionEvent"("userId");
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "goalSetByUserId" TEXT;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_goalSetByUserId_fkey" FOREIGN KEY ("goalSetByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

(`ADD CONSTRAINT` has no `IF NOT EXISTS`; Prisma runs each migration once, so that is fine — say so in the file's comment.) Schema relations accordingly; generate; migrate both DBs. `packages/events`' `ExecutionEventRow` type comes from the client — check `packages/db/src/client.ts` re-exports pick up the new column automatically.

- [ ] **Step 2: Domain + append + mapper** (RED via `append.test.ts`: append with `userId: 'u1'` — needs a `User` row; the test's TRUNCATE gains `"User"` — read back `userId`; append without → `null`/absent). Envelope: `userId: z.string().min(1).nullable().optional()`. Mapper: `...(row.userId === null ? {} : { userId: row.userId })`. Append: `userId: input.userId ?? null`.

- [ ] **Step 3: Verbs.** Mechanical: each signature gains `principal?: Principal` last; each `appendEvent({ … })` gains `userId: principal?.userId ?? null`. `setGoal` writes `goalSetByUserId: principal?.userId ?? null` in the same `update`. `requestPause`/`requestStop` etc. keep `requestedBy` as it is. Build; existing tests pass untouched (the parameter is optional).

- [ ] **Step 4: Planning.** `createdByUserId: workspace.goalSetByUserId` in the `task.create` data (the workspace is already loaded there). Test: set `goalSetByUserId` on the fixture workspace, run the planning conclusion, assert the tasks carry it.

- [ ] **Step 5: Routes.** For each route that calls a verb: `const gate = await requirePrincipal(); if ('response' in gate) return gate.response; … verb(…, gate.principal ?? undefined)`. In loopback mode `requirePrincipal` returns `{ principal: null }` so nothing changes there — `gate:m15-boundary` must still pass.

- [ ] **Step 6: Activity.** `buildActivityHistory` selects `userId`; `buildActivityPage` adds `users: prisma.user.findMany({ select: { id, username }, orderBy: { username: 'asc' } })` (the whole table — it is small; note the bound assumption); `Timeline` builds `userNameById` and passes `userName`; `ActivityCard` renders `<span data-testid="event-user" className={ACTOR_CHIP_CLASS}>by {userName}</span>` when non-null. The SSE frame is unchanged; a refetch resolves names.

- [ ] **Step 7: Verify.** `npx tsc --build`; the five test files + `npx vitest run packages/control apps/web/test/activity-cards.test.tsx apps/web/test/activity-page.test.tsx`; web tsc; `npm run web:build && rm -rf apps/web/.next`; `npm run gate:m15-boundary` PASS.

- [ ] **Step 8: Commit.**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260903140000_m23_event_user packages/db/src/mappers.ts packages/domain/src/events/schema.ts packages/events/src/append.ts packages/events/test/integration/append.test.ts packages/control/src apps/orchestrator/src/planning.ts apps/orchestrator/test/integration/planning.test.ts packages/control/test/integration/goal.test.ts apps/web/src/app/api apps/web/src/server/activity.ts apps/web/src/components/activity/ActivityCard.tsx apps/web/src/components/activity/Timeline.tsx apps/web/test/activity-cards.test.tsx apps/web/test/activity-page.test.tsx
git commit -m "feat: m23 f6 — a name on the event: userId rides the envelope from the session to the Activity card"
```

(`packages/control/src` and `apps/web/src/app/api` as directories are acceptable here because every file under them that changed is this task's; verify with `git status --short` first that nothing unrelated is inside.)

---

### Task 16: F7 — `gate:m20-auth` for accounts, `gate:m21` census widened

**Files:**
- Modify: `scripts/gate-m20-auth.mjs` (run B: secret instead of password; creates and deletes a user through `packages/control/dist/users.js`; stages 3/4 use username+password; stage 7 (bearer) becomes "a Bearer header opens nothing"; new stage "deleted user's cookie → 401 session revoked" on a `POST …/goal`; PASS line `the door has a lock — loopback unchanged without a secret, a named login with one`), `scripts/gate-m21-loose-ends.mjs` (`M20_PASS` string; check 1 also asserts `child-env.mjs` blanks both variables by grepping its source for both names), `package.json` (no change unless the m20 script's env-file handling needs it), `README.md` gate rows for m20/m21

- [ ] **Step 1:** Rewrite run B's setup: `const SECRET = randomBytes(32).toString('hex')`; before booting `next dev`, `const { createUser, deleteUser } = await import('../packages/control/dist/users.js')` and create `gate-<8 hex>` with a random 16-char password; `finally` deletes the user (and `$disconnect`s). Boot with `env: { ...process.env, AITEAMOS_SESSION_SECRET: SECRET }` — and DELETE `AITEAMOS_PASSWORD` from it (a stale `.env` must not matter). Stage 6's cookie re-derivation mirrors the new scheme: HMAC-SHA256(secret, `"<userId>.<exp>"`) — the gate needs the user id: `createUser` returns it. Every fetch that logged in with `{ password }` now sends `{ username, password }`.

- [ ] **Step 2:** Run A is untouched: it deletes both variables from the child env (add the secret to the `delete env.…` line).

- [ ] **Step 3:** `npm run gate:m20-auth` → PASS ×2; `npm run gate:m21-loose-ends` → PASS; `npm run gate:m15-boundary` → PASS.

- [ ] **Step 4: Commit.**

```bash
git add scripts/gate-m20-auth.mjs scripts/gate-m21-loose-ends.mjs README.md
git commit -m "test(gates): m23 f7 — the M20 gate logs in as a user; the M21 census strips the secret too"
```

---

### Task 17: `gate:m23-onboarding`

**Files:**
- Create: `scripts/gate-m23-onboarding.mjs`
- Modify: `package.json` (`"gate:m23-onboarding": "tsc --build && node --env-file=.env scripts/gate-m23-onboarding.mjs"`), `README.md` (gate table row)

**Interfaces:**
- Consumes: everything above. Stages exactly as spec §9; `PASS_LINE = 'a repo attached, a tree collected, a log read, a roster edited, a hand-off drawn, a name on the event'`.

- [ ] **Step 1: Skeleton** from `scripts/gate-m8a-merge.mjs` (imports, `mkdtemp` repo with a `package.json` whose `test` script is `node -e "process.exit(0)"`, the daemon spawn with `AITEAMOS_CLAUDE_BIN: 'node'` + `AITEAMOS_CLAUDE_ARGS: '<fake-claude.mjs> --fixture m8a-flow'`, the poll-until-`task.done` loop, the `finally` teardown order events → tasks → runs → agents → teams → provider config → workspace → user, `rmSync` the repo). Preflight: refuse under a running daemon (`gate-m17`'s `/proc` check, copied) and under a running `next dev`.

- [ ] **Step 2: Stages 2–7** per spec §9, each a numbered block with `assert(...)` lines that name what failed. Stage 2 drives `apps/orchestrator/dist/cli.js` with `spawnSync` (`--env-file=.env`) and asserts stdout/stderr text; stage 5 imports `collectWorktrees` from `apps/orchestrator/dist/collect.js` and runs it in-process with `ttlMs: WORKTREE_TTL_MS` after the `UPDATE "ExecutionEvent" SET ts = ts - interval '8 days'`; the operator half uses `fetch` against the dev server booted in stage 8's harness — so order the script: stages 1–3 (repo, CLI, daemon to done) → stop the daemon → stages 4–7 need the web app: boot `next dev` ONCE in loopback mode (`loopbackChildEnv()`), run 4 (artifacts), 5b (operator collect route + 409 negative), 7 (communication route), then 6 (org CLI) → stop it → stage 8 boots `next dev` again with a secret (accounts), creates a user, logs in, posts a goal with the cookie, reads the event's `userId`, fetches `/w/<id>/activity` and asserts `by <username>` in the HTML, deletes the user, repeats the goal POST → 401 `session revoked`. Two sequential dev-server boots, never overlapping (M20's rule).

- [ ] **Step 3:** `npm run gate:m23-onboarding` → PASS ×3 consecutively; record the wall time in the report. README row: "The M23 gate: a repo attached … **Spends nothing**, CI-runnable, needs the dev database and `git`; two sequential dev-server boots."

- [ ] **Step 4: Commit.**

```bash
git add scripts/gate-m23-onboarding.mjs package.json README.md
git commit -m "test(gates): m23 — the onboarding gate: a repo attached, a tree collected, a log read, a roster edited, a hand-off drawn, a name on the event"
```

---

### Task 18: G1 + G2 — CI, `.nvmrc`, README status, spec Errata

**Files:**
- Create: `.github/workflows/ci.yml`, `.nvmrc` (`26`)
- Modify: `README.md` (Status M8–M23; `gate:m12-providers` row; "Reaching it from another device" for accounts; gate table "CI" column), `docs/superpowers/specs/2026-09-03-m23-real-repo-real-team-real-user-design.md` (Errata section: the migration split, the `task.cancelled` finding from Task 4, the page-read-by-revoked-cookie ruling from Task 14, anything else the tasks recorded)

- [ ] **Step 1: Workflow.**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env: { POSTGRES_USER: aiteamos, POSTGRES_PASSWORD: aiteamos, POSTGRES_DB: aiteamos }
        ports: ['5433:5432']
        options: >-
          --health-cmd "pg_isready -U aiteamos" --health-interval 5s --health-timeout 5s --health-retries 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: cp .env.example .env
      - run: PGPASSWORD=aiteamos psql -h localhost -p 5433 -U aiteamos -d aiteamos -c 'CREATE DATABASE aiteamos_test OWNER aiteamos;'
      - run: npm run db:generate
      - run: npm run db:migrate
      - run: npm run db:migrate:test
      - run: npm run db:seed
      - run: npm run typecheck
      - run: npm test
      - run: npm run web:build && rm -rf apps/web/.next
  gates:
    needs: test
    runs-on: ubuntu-latest
    services: { postgres: <same block> }
    env:
      AITEAMOS_CLAUDE_BIN: ${{ github.workspace }}/scripts/gate-fakes/fake-claude.sh
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: cp .env.example .env
      - run: PGPASSWORD=aiteamos psql -h localhost -p 5433 -U aiteamos -d aiteamos -c 'CREATE DATABASE aiteamos_test OWNER aiteamos;'
      - run: npm run db:generate && npm run db:migrate && npm run db:migrate:test && npm run db:seed
      - run: git config --global user.name ci && git config --global user.email ci@example.com
      - run: npm run gate:m15-boundary
      - run: npm run gate:m20-auth
      - run: npm run gate:m21-loose-ends
      - run: npm run gate:m23-onboarding
```

Replace `<same block>` with the literal service block (YAML has no include). `psql` is on `ubuntu-latest`; if it is not, `sudo apt-get install -y postgresql-client` first. Validate locally with `npx --yes @action-validator/cli .github/workflows/ci.yml` if available, else `node -e "require('js-yaml')"`-style parse is not available without a dep — a careful read plus the first push's run is the check; note the run URL in the report.

- [ ] **Step 2: README.** Status lines M8–M23, one per milestone, each pointing at its spec under `docs/superpowers/specs/`. Gate table: a third column `CI` with `yes` for m15/m20/m21/m23 and `operator` for the rest; m12's cell says `no — spends real money`. "Reaching it from another device": the secret, `create-user`, `web:exposed`'s three refusals, the note that the cookie and the password travel in clear off a tailnet.

- [ ] **Step 3: Spec Errata** (§13, new): number each ruling with the task that made it.

- [ ] **Step 4: Verify + commit.**

```bash
git add .github/workflows/ci.yml .nvmrc README.md docs/superpowers/specs/2026-09-03-m23-real-repo-real-team-real-user-design.md
git commit -m "ci,docs: m23 g — a workflow on push, a status list that reaches M23, the spec's errata"
```

---

## Closing verification (after Task 18, before the final review)

- `npm run typecheck` clean; `npm test` green (record files/tests count); `npm run web:build && rm -rf apps/web/.next`.
- Gates, in this order, none overlapping: `gate:m15-boundary`, `gate:m20-auth`, `gate:m21-loose-ends`, `gate:m23-onboarding` (×3), `gate:m17-stability` (the five-suite run — the flake ledger's standard).
- `AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m14-fidelity` and `gate:m16-chrome` (browser gates — the Settings page grew a panel and the task panel grew two sections; the nine screenshots under `docs/superpowers/fidelity/m14/` are regenerated and committed if they changed).
- The operator's `.env`: `AITEAMOS_PASSWORD` is now dead; tell the operator to replace it with `AITEAMOS_SESSION_SECRET` and to create their first user — the README says how.
- Final whole-branch review (opus), fix wave, merge fast-forward, push; update the memory file's backlog line.

## Self-review against the spec

- §2 A1–A4 → Tasks 1, 2, 3. §3 B1–B4 → Tasks 4, 5, 6. §4 C1–C3 → Task 7. §5 D1–D3 → Tasks 9, 10. §6 E1–E3 → Tasks 11, 12. §7 F1–F7 → Tasks 13, 14, 15, 16. §8 G1–G3 → Tasks 18, 8. §9 gate → Task 17. §10 tests → per task. §11 constraints → header. §12 order → task numbering.
- Placeholders: none — every step has its code or its exact instruction; the two "decide by reading" points (Task 10's roster vs workers placement, Task 4's `task.cancelled` enum) are named with the rule that decides them and where the decision is recorded.
- Types: `Principal` (Task 1) is `{ userId }` in control and `{ userId; username }` in `apps/web/src/server/principal.ts` — the web one is a superset and is passed to verbs as-is (structural typing); `collectTaskWorktree(taskId, reason, principal?)` is the same in Tasks 4, 5, 6, 15, 17; `CommunicationGraph`/`CommunicationEdge` match between Tasks 11 and 12; `worktreePath` on `TaskRunSummary` (Task 6) is the field Task 17 stage 5 reads back through Prisma, not the DTO.
