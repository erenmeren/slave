# M23 — Real Repo, Real Team, Real User: the design spec's remaining product gaps, closed in one milestone

**Status:** Approved (decomposition, accounts scope and the seven design sections approved in conversation 2026-09-03)
**Approach:** one milestone, seven series, ordered so that every series merges on its own and the cross-cutting one (accounts) lands last. Small hygiene rides inside the series it touches — no broom milestone (process lesson recorded 2026-09-02).
**Scope rule:** the nine items the 2026-09-03 gap audit found against `docs/superpowers/specs/2026-08-17-ai-team-os-design.md`, and nothing else. Rulings on record stay rulings (Cursor non-shell enforcement inert; parallel same-named hook binding; read-secrets path predicate; task `summary` null).

## 1. Why this milestone

M22 left the tracked backlog empty. What remains is the distance between the original design
spec and the tree: an operator cannot attach a real repository without a Prisma call; worktrees
are preserved forever because the sweep that was to collect them never did (worktree.ts:186,
sweep.ts:84); `Artifact` rows are written by verify and read by nothing; the fifth graph mode
was deferred and stayed deferred; the roster can be built but never edited; the door has one
shared key and every event says `actor: human` with no one behind it; README's status list ends
at M7; nothing runs on push but a local hook.

Each series below names the files it touches, the refusals it adds, the events it emits and the
tests that license it. Where the tree and the design spec disagree, this document says which wins.

**Non-goals:** cloning a repository (only an existing local clone is attached); deleting a
workspace; roles or per-workspace authorization for accounts; session listing or revocation on
password change (deleting the user is the revocation); TLS; browser-driven gates in CI;
agent-to-agent messaging as a feature (the communication graph derives edges from the log as it
is today); a `Task.terminalAt` column (the terminal event's `ts` is the source of truth).

## 2. Series A — workspace onboarding

### A1 `createWorkspace` (`packages/control/src/workspace.ts`)

```ts
export interface CreateWorkspaceInput {
  readonly name: string
  readonly repoPath: string            // absolute
  readonly baseBranch?: string         // default 'main'
  readonly verifyCommands: readonly string[]   // non-empty
  readonly setupCommands?: readonly string[]   // default []
  readonly budgetUsd?: number | null   // default schema default (20); null = not budgeted
  readonly provider?: ProviderKind | null      // default null = no ProviderConfiguration row
}
export async function createWorkspace(input: CreateWorkspaceInput, principal?: Principal):
  Promise<Result<{ id: string }, ControlRefusal>>
```

`Principal` is Series F's `{ userId }` (§7 F6); until F lands the parameter exists and is always
undefined, so A–E merge without touching authentication.

Refusals, in check order, all new kinds in `refusal.ts`:

| kind | when |
|---|---|
| `invalid_name` | trimmed name empty (existing kind) |
| `repo_path_not_absolute` | `!isAbsolute(repoPath)` |
| `repo_not_found` | `stat` fails or is not a directory |
| `not_a_git_repository` | `git -C <path> rev-parse --is-inside-work-tree` ≠ `true` |
| `base_branch_not_found` | `git -C <path> rev-parse --verify --quiet refs/heads/<base>` fails |
| `verify_commands_empty` | after trimming and dropping blanks, zero commands (design spec §10) |
| `invalid_budget` | existing rule (`Number.isFinite && >= 0`) |
| `invalid_provider` | existing kind |
| `duplicate_name` | `Workspace.name` — a new `@unique` on the column (migration) |

The git probes run through a new `packages/control/src/git-probe.ts` (`execFile('git', …)`, no
shell, 5 s timeout) so that `workspace.ts` stays free of process spawning in its tests — the probe
is injectable for unit tests and real for the integration test, which `git init`s a temp repo.

Write: one transaction — `workspace.create` (verify/setup commands stored trimmed), then, when
`provider` is given, `providerConfiguration.create({ kind, settings: {} })` — then `appendEvent`
`workspace.created` (new type, `actor: 'human'`, payload
`{ name, repoPath, baseBranch, verifyCommands, provider }`). Four coordinated edits per ADR 0003:
enum member + migration, Zod union member, `EVENT_TYPE_BY_DOMAIN_TYPE`, Activity card.

### A2 CLI `create-workspace` (`apps/orchestrator/src/cli.ts`)

```
create-workspace --name <n> --repo <abs path> [--base main] --verify "<cmd>" [--verify "<cmd>" …]
                 [--setup "<cmd>" …] [--budget <usd>|--no-budget] [--provider claude_code|cursor]
```

`parseArgs` gains repeatable flags: a flag given twice collects into an array (today the second
value overwrites the first). `--verify` and `--setup` are the only repeatable flags; every other
flag keeps last-wins. Success prints `workspace <id> created\n`; refusal prints `refusalText`
and exits 1, as every org command does. USAGE gains the line and a sentence: "the repository must
already exist locally; the base branch must exist; at least one verify command is required".

### A3 Settings → Projects panel (`apps/web`)

- `POST /api/org/workspaces` → `orgControlResponse(() => createWorkspace(body, principal))`, body
  is `CreateWorkspaceInput` with `verifyCommands`/`setupCommands` as arrays. 201 `{ ok: true, id }`
  on success (the only route that returns an id — the client navigates to `/w/<id>`).
- `apps/web/src/components/ProjectsPanel.tsx` (new, mounted in `SettingsClient` above
  `TemplateCatalog`): the form idiom of `CompanyManager` (local state, `pending`, `errorText`,
  `role="alert"` error span, `data-testid="create-workspace-*"`), FormControls kit only. Verify and
  setup commands are one textarea each, one command per line, split and trimmed client-side.
  Budget: number field plus the existing "not budgeted" checkbox pattern from `RuntimeCard`.
  Provider: `SelectField` with the two kinds and "none".
- Sidebar's Projects list is `listProjects()` — unfiltered, so the new workspace appears on refresh.
- Activity card `WorkspaceCreatedCard`: tone `starting`, label "workspace created", detail
  `<name> · <repoPath> · <n> verify commands`.

### A4 README

The "Running the orchestrator" section gets a "Attaching a repository" subsection before the
command list: the CLI line, what is validated, that the worktrees and artifacts live under
`<repo>/.aiteamos/` (already gitignored by `ensureIgnored`), and that the seeded Checkout Platform
points at `/tmp/checkout-platform`, which does not exist after a reboot and is therefore inert.

## 3. Series B — worktree garbage collection

### B1 The rule

A task's worktree is collectable when all of: task status ∈ `TERMINAL` (`done | failed |
cancelled` — `TERMINAL` becomes an export of `packages/domain/src/task/state.ts`); the task has at
least one run with `worktreePath !== null`; no run of the task is alive (`AgentRun.status` not in
the live set the sweep already uses, and `isAlive(pid)` false — same helper); and the terminal
timestamp is older than `WORKTREE_TTL_MS = 7 × 24 × 3600 × 1000`. The terminal timestamp is the
`ts` of the task's latest `task.done | task.failed | task.cancelled` event — no new column; the
event log is the clock. A terminal task with no such event (pre-M8 seed rows) is never aged out;
it can still be collected on demand.

### B2 `collectWorktrees` (`apps/orchestrator/src/collect.ts`, new)

```ts
export interface CollectDeps { readonly workspaceId: string; readonly now: () => Date; readonly ttlMs: number }
export interface CollectReport { readonly collected: readonly { taskId: string; path: string }[]; readonly skipped: number }
export async function collectWorktrees(deps: CollectDeps): Promise<CollectReport>
export async function collectTaskWorktree(taskId: string, reason: 'aged' | 'operator', principal?: Principal):
  Promise<Result<{ path: string }, ControlRefusal>>
```

`collectTaskWorktree` is the single implementation; the pass calls it with `'aged'`, the route
with `'operator'`. Steps: re-check B1 inside a `SELECT … FOR UPDATE` on the task; run
`git -C <repoPath> worktree remove --force <path>` via `gitIn`; if the directory is already gone,
run `git worktree prune` instead and continue (the row said there was a tree; the disk disagrees;
the outcome the operator wants is the same); set `worktreePath = null` on every run of the task
that pointed at it; `appendEvent` `task.worktree_collected` (new type, `actor: 'system'` for
`aged`, `'human'` for `operator`, payload `{ path, reason, branch }`). The branch is not deleted —
`Task.branch` keeps naming it and the work stays reachable. Refusals: `task_not_found`,
`task_not_terminal`, `run_still_alive`, `nothing_to_collect` (no run carries a path).

`collectTaskWorktree` lives in `packages/control/src/collect.ts` so the web route can call it
without importing the orchestrator; the orchestrator's `collect.ts` is the pass over candidates
and imports the verb. `gitIn` moves from `apps/orchestrator/src/worktree.ts` to
`packages/control/src/git.ts` (re-exported from its old name so the six existing importers do not
move in this milestone).

### B3 Daemon timer (`apps/orchestrator/src/daemon.ts`)

A second `setInterval` at `COLLECT_PERIOD_MS = 10 × 60 × 1000`, plus one pass at startup after
`reconcileOrphans`. It is not folded into the 1 Hz sweep. The report logs one line per collected
tree: `[collect] task <id> worktree <path> collected (aged)`. Errors from one task are logged and
do not stop the pass (same posture as the review warn).

### B4 Operator button (`apps/web`)

- `DELETE /api/w/[workspaceId]/tasks/[taskId]/worktree` → `workspaceControlResponse(…,
  () => collectTaskWorktree(taskId, 'operator', principal))`.
- `TaskDetailPanel` shows a `GhostButton` "Collect worktree" (`data-testid="collect-worktree"`)
  only when the task is terminal and some run still carries a `worktreePath`; the DTO gains
  `worktreePath: string | null` on `TaskRunSummary`. Two-step confirm per `DangerZone`. Success
  → `router.refresh()`; the button disappears because the path is null.
- Activity card `TaskWorktreeCollectedCard`: tone `idle`, label "worktree collected", detail
  `<path> · <reason>`.

## 4. Series C — artifacts in the task detail panel

### C1 DTO (`apps/web/src/server/tasks.ts`)

`TaskBoardItem.artifacts: readonly { id: string; kind: string; label: string; createdAt: string }[]`,
from `include: { artifacts: { orderBy: { createdAt: 'desc' } } }`. `label` is derived server-side
from the path: `attempt-NN/MM-<slug>.log` → `attempt N · <slug>`; a `merge/` prefix → `merge ·
<slug>`; anything else → the basename. One pure function `artifactLabel(path)` in
`apps/web/src/lib/artifactLabel.ts` with a unit table.

### C2 Reader route

`GET /api/w/[workspaceId]/tasks/[taskId]/artifacts/[artifactId]` returns `text/plain; charset=utf-8`
with the file's content, capped at `ARTIFACT_READ_LIMIT = 256 KiB` (tail-bounded, one header
`X-Artifact-Truncated: 1` when cut). Refusals: 404 when the row is not found or belongs to another
task/workspace; 403 `{ error: 'artifact path outside the artifact root' }` when
`resolve(path)` does not start with `resolve(workspace.repoPath, '.aiteamos', 'artifacts') + sep`
— the row is data, the disk is the authority; 404 when the file is gone (collected or deleted by
hand). Same-origin and session rules apply as to every `/api/` path.

### C3 Panel

`TaskDetailPanel` gains an "Artifacts" `SectionLabel` after Runs: one row per artifact
(`data-testid="artifact-row"`, label + time), clicking loads the text into an inline `<pre>`
(`data-testid="artifact-body"`, monospace, `max-h-64 overflow-auto`) with a "truncated" note when
the header says so. Empty state: `no artifacts yet`. Fetch through `fetch` with credentials, not
`sendControl` (it is a read; a 401 still redirects through the same helper as `sendControl` — the
redirect-on-401 branch moves into a shared `lib/onUnauthorized.ts` both use).

## 5. Series D — org management

### D1 Verbs (`packages/control/src/org.ts`)

```ts
renameAgent(agentId, name, principal?)   // invalid_name, agent_not_found, duplicate_name (within team)
setAgentRole(agentId, role, principal?)  // invalid_role (empty), agent_not_found, agent_run_active
deleteAgent(agentId, principal?)         // agent_not_found, agent_has_runs
renameTeam(teamId, name, principal?)     // invalid_name, team_not_found, duplicate_name (within workspace)
deleteTeam(teamId, principal?)           // team_not_found, team_not_empty
```

`agent_has_runs` is the standing ruling (schema comment on `Agent.companyAgentId`): a worker with
run history survives. `agent_run_active`: the role is a scheduling key (`decide()` matches
`requiredRole` to `Agent.role` by string equality), so it does not change under a live run —
`AgentRun.status` in the live set. Each verb is one conditioned `updateMany`/`deleteMany` inside a
transaction with the row locked, and emits `org.changed` (new type, payload
`{ entity: 'agent' | 'team', id, field: 'name' | 'role' | 'deleted', from: string, to: string | null }`,
`workspaceId` of the team). `setAgentModel` also starts emitting `org.changed` with
`field: 'model'` — the catalog was event-free and this series ends that for the roster.

### D2 CLI

`rename-agent --agent <id> --name`, `set-role --agent <id> --role`, `delete-agent --agent <id>`,
`rename-team --team <id> --name`, `delete-team --team <id>`. Delete commands require `--yes`;
without it they print what would be deleted and exit 1.

### D3 UI (`apps/web/src/components/company/TeamBlock.tsx` and a new `AgentRowActions.tsx`)

Each agent row: an inline rename (click name → `TextField`, Enter saves via
`PUT /api/agents/[agentId]/name`), a role `TextField` next to the existing model editor
(`PUT /api/agents/[agentId]/role`), and a delete `PrimaryButton tone="blocked"` with the
two-step confirm (`DELETE /api/agents/[agentId]`). Team header: rename (`PUT /api/teams/[teamId]/name`)
and delete (`DELETE /api/teams/[teamId]`, disabled with a title "team has agents" when non-empty).
Refusal text lands in the row's `role="alert"` span. Activity card `OrgChangedCard`: tone `idle`,
label from `field` ("renamed", "role changed", "model changed", "deleted").

## 6. Series E — communication graph

### E1 What an edge is

No event carries a target agent and `AgentMessage` is never written (both measured 2026-09-03).
Edges are therefore derived from task co-participation in the log, per workspace, newest
`COMMUNICATION_EVENT_LIMIT = 500` events:

| from → to | derivation |
|---|---|
| planner → implementer | `workspace.plan_created` (agentId = planner) lists task ids; the first `run.started` on each of those tasks names the implementer |
| implementer → reviewer | `task.review_started` (agentId = reviewer) on a task whose latest earlier `run.started` names the implementer |
| reviewer → implementer | `task.review_rejected` (agentId = reviewer) followed by the next `run.started` on the same task |
| operator → agent | `agent.message_sent` with `actor: 'human'` on a task whose live run names the agent — rendered from a single `operator` node |

Weight = occurrence count. Self-edges dropped. Agents with no edge still appear as nodes so the
mode reads as "who has not talked to anyone".

### E2 Server (`apps/web/src/server/communicationGraph.ts`, new)

```ts
export interface CommunicationGraph {
  readonly agents: readonly { id: string; name: string; role: string }[]
  readonly edges: readonly { from: string; to: string; count: number; kind: 'plan' | 'review' | 'rework' | 'message' }[]
}
export async function buildCommunicationGraph(workspaceId: string): Promise<CommunicationGraph | null>
```

One `executionEvent.findMany` (types in the four families, `orderBy: { seq: 'asc' }`, `take`
bounded from the tail) folded with a `Map<string, edge>` keyed `from→to→kind` — the
`skillGraph.ts` shape. Route `GET /api/w/[workspaceId]/graph/communication`. Pure fold in
`apps/web/src/lib/communicationFold.ts` with unit tables per row of E1.

### E3 Client (`apps/web/src/components/graph/`)

`GraphMode` gains `'comm'`; `isGraphMode`, `MODE_TABS` (label "Communication") and the render
switch follow. `CommunicationMode.tsx` copies `SkillMode.tsx`'s fetch + 2 s debounce, keyed on
`run.started`, `task.review_started`, `task.review_rejected`, `agent.message_sent` and
`workspace.plan_created` frames. `buildCommunicationGraph(graph)` in `CommunicationNodes.tsx`
emits `OrgNodes`-style agent nodes plus one `operator` node, edges through `CableEdge` with
`data.weight = count` and a tone per kind (`plan` → `planning`, `review` → `working`, `rework` →
`warn`, `message` → `idle`). Layout `'layered'`. Empty state `data-testid="comm-empty"`: "no
hand-offs yet — edges appear as tasks move between agents".

## 7. Series F — accounts

### F1 The switch, and what happens to `AITEAMOS_PASSWORD`

`AITEAMOS_PASSWORD` is retired. `apps/web/src/lib/authEnv.ts` reads exactly one variable,
`AITEAMOS_SESSION_SECRET`: trimmed non-empty → `BoundaryMode = 'accounts'`; otherwise
`'loopback-only'`, M15 byte for byte (the M20 invariant carries over, and `gate:m15-boundary`
keeps proving it). README says to mint it with `openssl rand -hex 32`. `scripts/web-exposed.mjs`
refuses (exit 2) when the secret is shorter than 32 characters or when the database holds zero
users (it asks through `packages/db/dist/client.js`, the way gates do). `scripts/lib/child-env.mjs`'s
`loopbackChildEnv` blanks `AITEAMOS_SESSION_SECRET` (and keeps blanking `AITEAMOS_PASSWORD` so a
stale `.env` cannot resurrect password mode through some other reader — there is none, but the
census in `gate:m21` keeps proving the spawners strip both). `.env.example` swaps the commented
line.

### F2 Schema (one migration, `m23_accounts`)

```
model User { id String @id @default(uuid()); username String @unique; passwordHash String; createdAt DateTime @default(now()) }
ExecutionEvent.userId String? (FK → User, onDelete: SetNull, @@index)
Task.createdByUserId String? (FK → User, onDelete: SetNull)
```

`passwordHash` format: `pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>`, 600 000 iterations,
16-byte salt, 32-byte output — Web Crypto `subtle.deriveBits`, so `apps/web/src/lib/password.ts`
runs on the edge and in Node alike and `packages/control` can use the same code through
`globalThis.crypto` (Node ≥ 20). One implementation, `packages/control/src/password.ts`, re-exported
into the web through the package boundary; `apps/web/src/lib/session.ts` keeps `digestEqual`.

### F3 Verbs (`packages/control/src/users.ts`, new)

```ts
createUser(username, password)   // invalid_username (^[a-z0-9][a-z0-9._-]{1,31}$), weak_password (< 12 chars), duplicate_name
setPassword(username, password)  // user_not_found, weak_password
deleteUser(username)             // user_not_found
listUsers()                      // { id, username, createdAt }[]
verifyCredentials(username, password): Promise<{ id: string; username: string } | null>
```

`verifyCredentials` always runs the PBKDF2 derivation, against a fixed dummy hash when the user
is missing, so timing does not reveal existence. None of these take a principal; user management
is the operator's, from the CLI, and emits no event (users are not workspace history).

CLI: `create-user --name <u>` reads the password from stdin (one line, trailing newline stripped;
argv never carries it), `set-password --name <u>` likewise, `delete-user --name <u> --yes`,
`list-users`. Non-TTY stdin is the documented way to script it: `printf '%s\n' "$PW" | npm run
orchestrator -- create-user --name ada`.

### F4 Session (`apps/web/src/lib/session.ts`)

Cookie `aiteamos_session` keeps its name, flags and 30-day TTL. Value becomes
`<userId>.<expiresAt>.<hex hmac>`; HMAC-SHA256 over `"<userId>.<expiresAt>"` with the secret's
UTF-8 bytes as the raw key (no derivation step — the secret is already random). `mintSession(secret,
userId, now)`, `verifySession(secret, value, now): { userId } | null`. `verifyBearer` is retired
with password mode; the API accepts the cookie only. The middleware stays stateless: it checks the
signature and expiry and nothing else. Every request that reaches a page or an `/api/` handler in
accounts mode then resolves the principal:

```ts
// apps/web/src/server/principal.ts
export interface Principal { readonly userId: string; readonly username: string }
export async function currentPrincipal(): Promise<Principal | null>   // cookies() → verifySession → prisma.user.findUnique
```

`null` in accounts mode → API 401 `{ error: 'session revoked' }`, page 302 `/login`. The root
layout calls it once for pages; `workspaceControlResponse`/`orgControlResponse` gain a
`principal` argument the routes pass through. Loopback mode returns `null` and the writes carry no
user, as today.

### F5 Login surfaces

`POST /api/auth/login` body `{ username, password }`; `verifyCredentials`; the serialised 300 ms
failure gate stays (M21 B3) and now also covers unknown usernames; 404 in loopback mode; 204 +
cookie on success. `/login` page: username + password fields (`data-testid="login-username"`,
`login-password`). Settings posture text via `postureFor`: `'accounts · signed in as <username> ·
cross-site requests refused'` (the username is a parameter, the format is the single source).
Logout unchanged.

### F6 Attribution

`Principal` (`packages/control/src/principal.ts`: `{ userId: string }`) becomes the trailing optional
parameter of every control verb that appends an event or creates a task: `setGoal`, `requestPause`,
`requestResume`, `requestStop`, `emergencyStop`/`clearHalt`, `addDependency`/`removeDependency`,
`setWorkspaceProvider`/`setWorkspaceBudget`, `assignCompany`, `setAgentModel`, and every verb this
milestone adds. The domain envelope gains `userId: z.string().nullable().optional()`; `appendEvent`
writes it; `parseExecutionEvent` round-trips it. `actor` stays `'human'` — `Actor` is a kind, the
user is the principal. The web fills it from `currentPrincipal()`; the CLI passes nothing.
`Task.createdByUserId` is set by the goal→plan path only when the goal was set from the web:
`setGoal` stores the principal's id on `Workspace.goalSetByUserId` (new nullable column, same
migration) and `planning.ts` copies it onto the tasks it creates.

Activity: `server/activity.ts` resolves `userName` beside `agentName` (one `user.findMany` over the
distinct ids in the page); `ActivityCardProps.userName: string | null`; the card header shows
`by <username>` when present. The SSE frame is unchanged — a refetch resolves the name.

### F7 Gates

`gate:m20-auth` run B boots with a random secret and, before the login stages, creates a user
through the control verb (random username, random 16-char password) and deletes it in `finally`;
the stage list gains `wrong username → 401 (slow)`, `deleted user's cookie → 401 session revoked`.
Its PASS line changes to name accounts. `gate:m21-loose-ends`' census asserts both variables are
blanked. `gate:m15-boundary` is untouched and still passes unmodified.

## 8. Series G — CI, README, hygiene

### G1 `.github/workflows/ci.yml`

One workflow, two jobs, `on: [push, pull_request]`:

- `test`: `ubuntu-latest`, `actions/setup-node@v4` with `node-version: 26`, service
  `postgres:17-alpine` on host port 5433 with the compose user/password/db, plus a step that
  creates `aiteamos_test` (the compose init script does not run in a service container); `npm ci`;
  write `.env` from `.env.example`; `db:generate`, `db:migrate`, `db:migrate:test`, `db:seed`;
  `npm run typecheck`; `npm test`; `npm run web:build`; then `rm -rf apps/web/.next` (the build
  must not sit under the dev servers that follow — memory rule).
- `gates`: `needs: test`, same services and setup, then `gate:m15-boundary`, `gate:m20-auth`,
  `gate:m21-loose-ends`, `gate:m23-onboarding` in sequence, `AITEAMOS_CLAUDE_BIN` pointing at
  `scripts/gate-fakes/fake-claude.sh`. Browser gates (m14, m16, m18, m19) and the five-suite m17
  stay operator-run; README's gate table gets a "CI" column saying which is which.

`engines.node >= 26` is already declared; a `.nvmrc` with `26` is added so the workflow and the
operator pin the same major.

### G2 README

- Status list: `- **M8** … **M23**` in the existing one-line format, each pointing at its spec.
- `gate:m12-providers` row: "spends real money … not CI-runnable" (the m13 row's wording).
- "Reaching it from another device" rewritten for accounts: the secret, `create-user`, the
  refusal conditions of `web:exposed`.
- Gate table "CI" column (G1).

### G3 Hygiene

`packages/control/test/integration/goal.test.ts`, `org.test.ts`, `workspace-settings.test.ts`:
the `/tmp/does-not-matter` placeholder becomes `mkdtempSync(join(tmpdir(), 'aiteamos-test-'))` in
`beforeAll` with `rmSync` in `afterAll`, the shape `emergency.test.ts` took at ce48adc. No
behaviour change; the trap is closed before anything in those files can pause a run.

## 9. Gate — `npm run gate:m23-onboarding`

`scripts/gate-m23-onboarding.mjs`, zero spend, the m8a gate's skeleton (dist imports, one `try`,
`finally` cleanup, `PASS_LINE`, `exitCode` flipped at the end). Stages:

1. `mkdtemp` a repository: `git init`, one commit on `main`, `package.json` with a `test` script
   that exits 0.
2. `create-workspace` through the CLI (`--verify "npm test"`, `--provider claude_code`); assert
   stdout `workspace <id> created`, a `workspace.created` event, the `ProviderConfiguration` row.
   Negative controls through the CLI: a relative `--repo` (exit 1, `repo_path_not_absolute` text),
   no `--verify` (exit 1, `verify_commands_empty` text).
3. Seed one `backend` agent and one task with `requiredRole: 'backend'` (Prisma, as m8a does),
   boot the daemon with `AITEAMOS_CLAUDE_BIN` = the fake `m8a-flow` fixture, wait for `task.done`.
4. Artifacts: the tasks snapshot route lists ≥ 1 artifact on the task; the reader route returns
   the log text; a forged row whose path is `/etc/hostname` returns 403.
5. GC: assert the worktree directory exists; `UPDATE "ExecutionEvent" SET ts = ts - interval '8 days'`
   on the task's `task.done` row; run one `collectWorktrees` pass in-process; assert the directory
   is gone, `git branch --list aiteamos/*` still names the branch, `worktreePath` is null on the
   run, one `task.worktree_collected { reason: 'aged' }` event. Then a second task, driven to
   done the same way, collected through `DELETE …/worktree` (reason `operator`), and the same
   route on an untouched running task → 409 `task_not_terminal`.
6. Org: `rename-agent`, `set-role` on the idle agent (ok), `delete-agent` on the agent with runs →
   exit 1 `agent_has_runs`, `delete-team` non-empty → `team_not_empty`; three `org.changed` events.
7. Communication: `GET …/graph/communication` returns an `implementer → reviewer` edge with
   `count ≥ 1` (the m8a flow reviews).
8. Accounts (needs a `next dev` boot with a random secret, after the daemon is down): `create-user`
   via stdin, login 204, `POST …/goal` with the cookie, the `workspace.goal_set` row carries
   `userId` = the user, Activity page HTML contains `by <username>`; `delete-user`, the same cookie
   → 401 `session revoked`.
9. `finally`: kill children, delete events → tasks → runs → workspace → user, `rmSync` the repo.

PASS line: `a repo attached, a tree collected, a log read, a roster edited, a hand-off drawn, a
name on the event`.

## 10. Testing summary

- Unit: refusal tables for every new verb (mocked Prisma per the org.test pattern where one
  exists, else integration); `parseArgs` repeatable flags; `artifactLabel`; `communicationFold`
  rows; `password.ts` (known-answer vector, round trip, dummy-hash timing path takes the derivation);
  `session.ts` mint/verify/tamper/expiry; `boundary.ts` accounts rows; `postureFor` three modes;
  `TaskDetailPanel` artifact + collect rendering; `AgentRowActions`; `CommunicationMode` empty
  state; `web-exposed` three refusals.
- Integration: `createWorkspace` against a real temp git repo (all nine refusals + success + the
  event); `collectTaskWorktree` (aged, operator, refusals, the prune fallback); org verbs (locks,
  `agent_has_runs`, `agent_run_active` with a seeded live run); `users.ts`; `appendEvent` with
  `userId`; `activity.ts` `userName` resolution; daemon collect timer fires (fake clock).
- `web:build` gates every `apps/web` task; one vitest run at a time; no daemon during tests.
- Gates: m23 (new), m20 (rewritten for accounts), m21 (census widened), m15 (unchanged, proven).

## 11. Global constraints

- No new runtime dependencies. Migrations: `m23_workspace_name_unique` (A1),
  `m23_events` (workspace.created, task.worktree_collected, org.changed), `m23_accounts` (F2).
- ADR 0003 holds: `appendEvent` is the only event writer; four coordinated edits per new type.
- One environment variable for the boundary, read in one file; loopback mode M15 byte for byte.
- Error body `{ error }`; 403 refused, 401 unauthenticated or revoked, 302 pages, 404 not found or
  login-unconfigured, 409 control refusal.
- Web Crypto only in `apps/web/src`; the shared PBKDF2 lives in `packages/control`.
- Trace every new field to its consumer: `userId` → Activity header; `worktreePath` on the DTO →
  the button; `artifacts` on the DTO → the panel; `count` → `CableEdge.weight`.
- `git add` explicit paths; comments change with behaviour; `rm -rf apps/web/.next` before any
  `next dev` that follows a `web:build`.

## 12. Order of work

A → B → C → G3 → D → E → F → G1/G2. Each series is mergeable alone: A–E and G3 change no
authentication surface; F rewrites it and is reviewed on its own; G1 comes last because its
`gates` job runs the M23 gate, whose stage 8 needs F.
