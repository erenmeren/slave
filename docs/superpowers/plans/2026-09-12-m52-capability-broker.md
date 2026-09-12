# M52 Default-Deny Capability Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker may do exactly what someone decided it may do, and nothing else. The gate stops asking "is this forbidden" and starts asking "is this allowed": a matrix that is armed but stale, unreadable, malformed or written for another run DENIES, and a tool no kind governs denies with it. A worker never holds a credential — it asks the orchestrator, by name, for one of a closed list of operations with typed parameters, and the orchestrator runs it in its own process with a secret the worker's environment does not contain, recording what was asked and how it ended. Identity stops being a path: every run carries a token issued at spawn, hashed onto its row and into the file the gate reads, so a worker that points at a sibling's verdict is refused by arithmetic rather than by convention. The Supervisor may point at a wall; only a person moves it.

**Architecture:** One pure vocabulary in `packages/domain/src/permission/{kinds,resolve}.ts` — six OPERATIONS, their labels, the full governed toolbox per provider, the baseline per `RunKind`, and the two total functions (`resolveGrants`, `grantsFor`) that every surface reads. One static manifest in `packages/domain/src/broker/operations.ts` — the ops, their zod parameter schemas, the seven refusal reasons and the two timeouts. The DATABASE gains a closed `PermissionKind` column where a free string was, two workspace-scoped tables (`Credential`, `BrokerBinding`) and one `@unique` hash on `SlaveRun`. The ENFORCEMENT path is two halves of one contract: `packages/control`'s `writePermissionsFile` writes `permissions.json` v2 (`allow`, `vocabulary`, `enforce`, `runId`, `tokenHash`) and `scripts/lib/permissions.sh` reads it back in the one `node -e` it has always spawned, now answering three questions instead of one. The BROKER splits the way the M51 ladder does: `packages/control/src/broker.ts` AUTHORISES (token → run → slave → grants → binding) and refuses; `apps/orchestrator/src/broker.ts` EXECUTES, in the daemon's own process, through the `runShellCommand` verify already uses, with the credential added to that one child's environment and to nothing else. `decide()` is untouched, `evaluateGuardrails` is untouched, and no Supervisor action writes a permission.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), zod, vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`, bash 5 hook scripts fed on stdin.

**Spec:** `docs/superpowers/specs/2026-09-12-m52-capability-broker-design.md` (rulings R1–R8; §2 surfaces; §3 out of scope; §4 errata; §5 carried backlog). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` (row M52 at line 44, and line 28: "**Circuit breaker and capability broker are extensions** of existing guardrails and `SlavePermission`, named as such"), `docs/decisions/0001-pause-semantics.md` (the measured exit contract the gate may not break), `docs/superpowers/specs/2026-08-31-m18-skill-and-teeth-design.md` (the matrix, the two gates and the one `node -e`) and `docs/ia.md` (rule 2, nothing is removed only moved; rule 3, labels never keys; rule 5, Advanced is a promise). **M53 owns evidence-based ranking and is the first consumer of `broker.executed`; nothing in this plan ranks anything.**

Plan-time errata, every one read out of the code and baked into the tasks below. The long form, with file and line evidence, is in the session notes (`m52-plan-notes.md`); each is also to be appended to the spec's §4 during execution.

- **E1 (amends R2) — `SLAVEOFAI_PERMISSIONS_FILE` UNSET must still ALLOW, or every spawn fails.** R2 inverts "an absent file allows" into "an absent file denies". Taken literally that breaks the pre-flight every run already depends on: `preflightGate` (`packages/providers/src/runtime/gate-preflight.ts:98-141`) spawns the real `pause-gate.sh` twice per spawn and REQUIRES the second, disarmed, invocation to ALLOW, and `runGateScript` passes `{ ...process.env, SLAVEOFAI_PAUSE_FLAG }` (`:33`) — the orchestrator's own environment, which names no permissions file. A rule that denied on "unset" would fail that assertion on every start and every resume, on both providers, and no run would ever spawn again. The split is therefore between the VARIABLE and the FILE: **unset** = "this process is not a governed run" (a pre-flight, an operator running the script by hand) = ALLOW, unchanged; **set, but the file is absent, unreadable, malformed, not version 2, or carries no `allow` array** = DENY, fail closed. Belt and braces: `runGateScript` additionally DELETES `SLAVEOFAI_PERMISSIONS_FILE` from the child's environment, so the pre-flight measures the pause gate and never the matrix, whatever the operator's shell holds. A worker cannot reach this arm — the hook is spawned by the vendor CLI with the CLI's own environment, and a `Bash` call's subprocess environment is not the next `PreToolUse` hook's.
- **E2 (amends R2) — the deny reason keeps the KIND in its quoted slot; the LABEL goes on the card.** `PERMISSION_DENY_REASON_PATTERN` (`packages/providers/src/gate.ts:62-64`) parses the quoted group into `GateOutcome.tool_denied.capability` (`:82-88`), and `apps/orchestrator/src/pump.ts` writes that string verbatim into `run.tool_denied.payload.capability`. R2 freezes that field's vocabulary at `run_commands` and R8 stage 2 asserts `capability: 'network_fetch'` — both of which a `'<label>'` in the reason would break, because the payload would then read `Run commands`. The message is `permission matrix denies 'run_commands' (Bash) for this slave`; the ia.md rule-3 half R2 wanted lands on the CARD, where `RunToolDeniedCard` prints `TOOL_DENIED_LABEL[payload.capability] ?? payload.capability`. Nothing prints the reason string itself: for a parsed matrix deny it is consumed and discarded.
- **E3 (amends R2) — default-deny would refuse every tool call on CURSOR, so the file carries the vocabulary and an `enforce` word.** `scripts/lib/permissions.sh:30-36` records the measurement: Cursor's `preToolUse` sends Claude-shaped casing (`"tool_name":"Read"/"Shell"/"Write"`) which never matches `permissions.json`'s lowercase Cursor vocabulary. Under a denylist that mismatch is inert; under an allowlist it denies EVERY Cursor tool call, so the milestone would brick the provider it claims only to limit. `ProviderCapabilities.gate` cannot be the discriminator — Cursor's is `'all-tools'` (`packages/providers/src/capabilities.ts:90`), proven for the PAUSE path, which does not read a tool name at all. v2 therefore carries `"enforce": "all-tools" | "known-tools"` and `"vocabulary": { "<tool>": "<kind>" }`, the provider's whole `TOOLS_BY_KIND` inversion. The rule: on `allow` → ALLOW; in `vocabulary` but not on `allow` → DENY naming that kind; in neither → DENY as `ungoverned_tool` under `all-tools`, ALLOW under `known-tools`. `enforce` is `known-tools` for `cursor` and `all-tools` for `claude_code`, and the matrix copy says so in words.
- **E4 (amends R4 and R8 stage 11) — `.slaveofai/` does not stop being written into a repository; only `runs/` moves.** `apps/orchestrator/src/worktree.ts:24` puts every worktree under `<repo>/.slaveofai/worktrees`, `verify.ts:460` and `merge.ts:208` put every artifact under `<repo>/.slaveofai/artifacts`, and `apps/web/src/app/api/w/[workspaceId]/tasks/[taskId]/artifacts/[artifactId]/route.ts:20` resolves a download under that same root. Stage 11 therefore asserts that `<repo>/.slaveofai/runs` does NOT exist and that `runFilePaths(...).runDir` is outside `repoPath` — not that `.slaveofai` is absent, which would be false on any repository that has ever run a task.
- **E5 (amends R3 and §2) — one refusal kind carrying SEVEN reasons, not six refusal kinds.** The reasons are already a closed vocabulary in the `broker.refused` payload; spelling the same list again as `ControlRefusal` members would be two lists, and two of the names (`permission_denied`, `simulation`) are ambiguous beside the union's existing `invalid_provider` / `unsupported_simulation` / `simulation_not_found`. `BROKER_REFUSAL_REASONS` lives in `packages/domain/src/broker/operations.ts` with a label table; `ControlRefusal` gains exactly two kinds — `broker_refused { op, reason }` (409) and `credential_not_found { name }` (404 by `refusalStatus`'s `_not_found` suffix rule, `apps/web/src/server/refusalStatus.ts:11`). The seventh reason is `credential_unset`: a binding naming a credential whose `envVar` is absent from the daemon's own environment, which is the first thing an operator meets on a fresh install and which `not_brokered` would describe falsely.
- **E6 (amends R3) — there is no `orchestrator` binary; the worker runs `node "$SLAVEOFAI_BROKER_CLI" broker run …`.** `package.json:23` is `"orchestrator": "tsc --build && node --env-file=.env apps/orchestrator/dist/cli.js"` — an npm script, not something on a worker's `PATH` — and every gate invokes the CLI by absolute path (`scripts/gate-m51-breaker.mjs:84`). The path reaches the child as `SLAVEOFAI_BROKER_CLI`, carried the way `hookPath` and `tapPath` are: an ADAPTER OPTION filled once in `buildAdapterRegistry` (`apps/orchestrator/src/cli.ts:721-746`) from `fileURLToPath(import.meta.url)` — which IS `dist/cli.js` — and overridable by the same-named environment variable, exactly as `hookPath()` (`:580-585`) and `tapPath()` (`:597-623`) already are. Never a per-run input, never threaded through `StartRunInput`.
- **E7 (amends R4) — the run token cannot ride on `Checkpoint`, and it must not be written to a file.** `packages/providers`' `Checkpoint` may not gain a field with no matching Prisma column (its own docstring, `packages/providers/src/claude/checkpoint.ts:24-`), and a token file inside `runDir` would be readable by every sibling run under the same uid — reopening the sibling-forgery hole R4 exists to close. So: `StartRunInput.runToken?: string` and a FOURTH parameter on `resume(runId, checkpoint, queuedInstruction, runToken?)`. Both OPTIONAL, and that cannot widen anything: an absent token means the key is absent from the child's environment, and the child then meets a `tokenHash` it cannot match — every tool call denied. The ~20 existing `adapter.resume(...)` call sites in `adapter-resume.test.ts` and `cursor-adapter.test.ts` compile unchanged.
- **E8 (amends R2) — a payload that names no tool DENIES at exit 0, never at exit 2.** Three arms allow today (`scripts/lib/permissions.sh:68-81`): no `tool_name`, a payload that parses to a non-object (`null`, `[1]`, `7` — a real security-review finding), and an empty list. Under `all-tools` the first two now deny, reported as tool `unknown` with kind `ungoverned_tool`, at exit 0 in a deny BODY. Not exit 2: exit 2 fails closed by STOPPING THE RUN (`scripts/pause-gate.sh:13-20`), and a `PreToolUse` payload this gate cannot read is a refused CALL, not a broken gate. Under `known-tools` they still allow, which is the measured Cursor behaviour E3 preserves.
- **E9 (amends R5) — `permission_blocked` needs a world the loader does not build.** `SupervisorWorld` holds no events and no per-slave denial counts (`packages/domain/src/supervisor/world.ts:300-340` lists eleven collections plus M51's `runs`). It gains `denials: readonly SupervisorDenial[]` — `{ slaveId, kind, count, latestRunId }` — from ONE `$queryRaw` grouping `run.tool_denied` by `slaveId` and `payload->>'capability'` over `PERMISSION_DENIAL_WINDOW_MS`, modelled line for line on `loadLatestGuardrails` / `loadLatestBreakerTrips` (`packages/control/src/supervisorWorld.ts:271-325`) and SKIPPED entirely when the workspace has no run at all in the window — the loader pays for nothing a quiet project does not need.
- **E10 (amends R8) — `gate:m18`'s fixture is a genuine capture, so its vocabulary moves by a documented REDACTION row, not by a rewrite.** `packages/providers/test/fixtures/permission-matrix-deny.ndjson` is a real `claude` recording (`fixtures/README.md:6-8` and its own provenance section at `:191-`), and the deny reason inside it is OUR gate's own sentence echoed back by the CLI. `README.md:311-390` already carries a substitution table with a count per substitution and a runnable `sed` recipe; M52 adds one row — `'run tests'` → `'run_commands'`, **4 occurrences** — so `scripts/capture-matrix-deny.mjs` stays complete provenance for the next capture. The alternative, a second synthetic fixture, would put two recordings of one event in a namespace whose README says there is no hand-authored JSON in it.
- **E11 (amends R1) — `invalid_tool` keeps its name; only its sentence moves.** Renaming a refusal kind costs three homes — the union and `refusalText` (`packages/control/src/refusal.ts:214,502`), the CLI, and `apps/web/test/refusal-status.test.ts`'s `Record<ControlRefusal['kind'], true>` at `:66` — to rename a word no surface prints. Its payload field stays `tool` and now carries the offered kind string; its text becomes `a permission must name one of the six operations`.
- **E12 (amends R2 and §2) — `resolveGrants` is pure and belongs in the DOMAIN, beside `grantsFor`.** R2 puts it in `packages/control/src/permission.ts` while R7 puts `grantsFor` in `packages/domain/src/permission/resolve.ts` — two homes for one computation, which is the exact shape this repository refuses. It is also the M51/E1 situation again: `apps/web/src/components/PermissionMatrix.tsx:40-43` records that a `'use client'` component may not import `@slave-of-ai/control`, because that barrel re-exports `@slave-of-ai/providers`, which imports `node:child_process` at module scope. Both functions live in the domain; `packages/control/src/permission.ts` keeps only the WRITERS — `writePermissionsFile`, `setSlavePermission`, `clearSlavePermission`.
- **E13 (amends R1/R3/R5) — the counts are one out.** `packages/domain/src/events/schema.ts` carries 55 `z.literal` arms today (M51's `run.tool_result` and `run.breaker` were the 54th and 55th), so M52's three are the **56th, 57th and 58th** and `packages/domain/test/supervisor/timeline.test.ts:19` moves 55 → 58. `SITUATION_KINDS` has sixteen members since M51's `run_looping`, so `permission_blocked` is the **seventeenth** and `situations.ts:141-142`'s "a SEVENTEENTH kind fails the build" becomes eighteenth. The action union has sixteen members since `steer_run` (`packages/domain/src/supervisor/actions.ts:11-84`), so `request_permission` is the **seventeenth**.
- **E14 (amends R7) — the matrix already carries two captions that contradict each other, and a third contradiction in its server module.** `PermissionMatrix.tsx:84` says denials ARE enforced at dispatch snapshot; `:178-180` says `not yet enforced at runtime`; `apps/web/src/server/settings.ts:116-118` says an unset cell "shows `✕`" while the component shows `–` (`:141-145`). All three are fixed in Task 5 as part of the copy that has to change anyway. The `perm-caption` TESTID stays exactly where it is: it is a structural marker in three gates (`scripts/gate-m14-fidelity.mjs:808,992`, `gate-m16-chrome.mjs:274`, `gate-m44-ux-foundation.mjs:774`) and only its text may move.

- **E15 (amends R3/R4) — the token alone does not bind a request to a CHANNEL, and without the second check a stolen one is worth more than the spec assumes.** R3 puts the run token in the request line ("R4's token is what makes a forged line useless") and `runBrokeredOperation` resolves the run from that token alone. But the line is written into `<runDir>/broker.ndjson`, and a run directory is `0700` under the same uid as every other run on the host — so a worker that lists `<state>/slaveofai/runs/` can read a sibling's channel and lift its token, once that sibling has made one request. With the token as the only check, the thief replays it **on its own channel**, and the daemon writes the reply — the brokered operation's bounded OUTPUT — into the thief's own directory, where it can read it. The fix is one comparison and it is not optional: the line carries `runId` as well, the daemon refuses any line whose `runId` is not the directory it was found in (`identity_mismatch`), and a reply is only ever written into the directory the request came from. The residual is then "a stolen token is usable only on the victim's own channel, where its reply lands in the victim's directory", and it is STATED in `apps/orchestrator/src/broker.ts`'s docstring the way `permissions.sh:57-59` used to state its own — beside the two things that reduce it: the directories are named by uuid and outside every worktree, and a served request cannot be replayed because its reply file is its idempotency key.
- **E16 (amends R1 and R2) — the table has to govern the WHOLE toolbox, and one rule of it cannot be enumerated.** Recorded in Task 1's fix round and referenced from `packages/domain/src/permission/kinds.ts`, `packages/control/src/permission.ts` and `scripts/lib/permissions.sh`; written into the plan here so those references resolve. The first `TOOLS_BY_KIND` held fifteen Claude names while this repository's own recording (`packages/providers/test/fixtures/complete.ndjson`'s `system`/`init` line) advertises SIXTY-EIGHT and `claudeFlags` passes no `--allowedTools`, so default-deny would have refused fifty-three live tools — `TaskOutput` included, without which a `Task` call cannot be read back. Three rules settle every name: a tool that only INSPECTS is `read_repo`; a tool that can DO work, or spawn work that can, is `run_commands` (which moved `Task` and `Skill` out of `read_repo`); and every `mcp__*` name is `network_fetch`, by PREFIX rather than by forty-one literals. The prefix is the half that lands in Task 2: a prefix is not enumerable, so `resolveGrants` puts no MCP name on the allow list and `permissions.json` v2 must carry the granted KIND set (`grants`) and a `prefixes` table beside `allow`, with the gate deciding by kind — otherwise one `network_fetch` grant opens two tools instead of forty-three.
- **E17 (amends R4) — moving the run directory and minting a run token do NOT stop a worker from rewriting its own verdict; they stop an accident and a sibling.** The brief has `scripts/lib/permissions.sh` and `packages/control/src/paths.ts` say a worker "can no longer reach its own verdict", and that is not what the tree delivers: `buildChildEnv` hands the child the absolute path (`SLAVEOFAI_PERMISSIONS_FILE`) and the plaintext token (`SLAVEOFAI_RUN_TOKEN`), and the child runs under the uid that owns the 0700 directory, so an implementation run — which has `run_commands` in its baseline — can write a fresh v2 body granting itself all six kinds with a `tokenHash` it computes from its own token, and the gate will read that as a valid verdict about itself. What R4 actually buys, and it is worth having: no run file inside the tree a verify runs in, so no repo-scoped delete, `git clean` or branch switch can disarm a run by accident; and a SIBLING run cannot borrow another's verdict, because the hash on that file will not match the token this child holds. Closing the rest needs a boundary the child does not hold — a separate uid or a sandbox — which this milestone does not build. **What this makes load-bearing for Task 4:** the broker authorises against `SlaveRun.runTokenHash` in the DATABASE, never against the file, and a worker holds no `DATABASE_URL` (R3) to reach that row with. The residual is stated in full in `scripts/lib/permissions.sh`'s exit-2 arm, which is the threat model of record.

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the browser gates need `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh"`. Nothing in this milestone calls a model to decide anything, and `request_permission`'s `why` is a constant sentence from `permissionWhyFor(kind, count)`, never a model's words — which is what lets an action about permissions exist at all beside `critical.ts:33-34`'s lexicon.
- **The gate is the only thing between a worker and the disk.** `packages/providers/src/claude/flags.ts:35-40` hardcodes `--permission-mode bypassPermissions` and this milestone does not touch it. Every failure path in `scripts/pause-gate.sh` and `scripts/lib/permissions.sh` exits exactly **2**, the one measured fail-CLOSED status; 1, 126 and 127 all fail OPEN (`pause-gate.sh:13-20`, `docs/decisions/0001-pause-semantics.md`). **A hook must fail closed** — that is the M51 lesson this milestone inherits, and E8 is where it is spent carefully rather than reflexively.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first. Only Task 5 and Task 6 run `web:build`.
- **No prettier.** There is no prettier config in this repository; `prettier --write` would reformat against the house style. Match the surrounding file by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/settings`, not `../server/settings.js`); `packages/*` keep the `.js` suffix.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- After `npm run db:generate`, run `npx tsc --build` **before** any integration test: the generated client's types are what the test files compile against.
- The vocabulary word is **slave**, fixtures included. `npm run gate:m26-vocabulary` after every task.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**, or Prisma commits that write. `runBrokeredOperation` is the one verb in this milestone that refuses AFTER a write is possible: its authorisation happens entirely BEFORE the transaction that records the attempt, so every one of its seven refusals is a returned value. `clearSlavePermission`'s refusal is returned before its delete. Task 3 Step 11 asserts this by construction.
- **A refusal kind reaches three homes:** the union + `refusalText` (`packages/control/src/refusal.ts`), the CLI (`throw new Error(refusalText(result.error))`), and the web (`apps/web/test/refusal-status.test.ts`'s `ALL_KINDS`, which is `Record<ControlRefusal['kind'], true>` and fails the BUILD when a kind is missing). Two kinds land in this milestone (E5), both in Task 3.
- **`decide()` is unchanged.** `packages/domain/src/scheduler/decide.ts` and its test are in no task's file list. A worker with no grants is not undispatchable — it is a dispatchable worker whose tool calls are refused, and the scheduler has never read a permission.
- **`evaluateGuardrails`, `workspaceSpend` and `stats.spentUsd` do not move.** `packages/domain/src/guardrails/evaluate.ts`, `packages/control/src/spend.ts` and `packages/control/src/stats.ts` appear in NO task's file list. A permission denial is not a guardrail: `pump.ts:850` already routes a matrix-prefixed reason away from `guardrail.tripped`, and `gate:m18` stage 1 asserts zero guardrails on a denied run — an assertion Task 6 re-runs unchanged.
- **A new event type touches NINE sites, and all three new events pay it:** the Zod union (`packages/domain/src/events/schema.ts`); `EventType` in `packages/db/prisma/schema.prisma` **plus the migration's `ALTER TYPE … ADD VALUE IF NOT EXISTS`**; `EVENT_TYPE_BY_DOMAIN_TYPE` (`packages/db/src/enums.ts`); `LANE_BY_TYPE` (`packages/domain/src/supervisor/timeline.ts:52`); the card component + the `ACTIVITY_CARDS` registry (`apps/web/src/components/activity/cards.tsx`); `TYPES_BY_KIND` (`apps/web/src/lib/activityFilters.ts`, RUNTIME-checked for exhaustiveness); the sentence in `apps/web/src/server/timeline.ts`; `PAYLOAD_BY_TYPE` in `apps/web/test/activity-cards.test.tsx`; and the count in `packages/domain/test/supervisor/timeline.test.ts:19` (55 → 58).
- **Migrations are additive where they can be and deterministic where they cannot, applied to both databases** (`npm run db:migrate` and `npm run db:migrate:test`) with the Prisma 7 diff proof: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` → "No difference detected". The directory is **`packages/db/prisma/migrations/20260912180000_m52_broker`** and it carries exactly one data statement — the deterministic `tool` → `kind` mapping, the deny-wins collision, the delete of everything unmapped with a `RAISE NOTICE`, and the column swap — which is the one destructive act this milestone owns and the reason every clause of it is spelled out in Task 1 Step 13.
- **Labels never keys.** `docs/ia.md` rule 3: no surface prints `read_repo`, `deploy_release`, `identity_mismatch` or `ungoverned_tool` as visible text. `PERMISSION_LABEL`, `TOOL_DENIED_LABEL`, `BROKER_OP_LABEL`, `BROKER_REFUSAL_LABEL` and `CREDENTIAL_KIND_LABEL` supply the words; the raw value stays in `title`, in `data-kind`, or in the expanded view.
- **A secret is never a value this system stores, logs or prints.** `Credential` holds a NAME and an `envVar` and never a value; no event payload carries one; `fake-deploy.sh` records `token-present:yes|no` and never the token; `CHILD_ENV_ALLOW` is an explicit name list and never a prefix rule and never a denylist.
- **Test baseline: ≥ 316 test files / ≥ 4930 tests** (the whole suite at the M51 final ladder). Every task's ladder ends at or above that, never below. If the M51 ladder's own numbers differ when this plan is executed, take THEM as the baseline and say so in the first task report.
- **26 CI gates become 27.** `gate:m51-breaker` is the 26th (`.github/workflows/ci.yml:79`); the new `gate:m52-broker` step goes immediately after it, and README's roster sentence (`README.md:828-836`) and its count (`README.md:908`) say 27.
- **Every gate script pin a task moves is named in that task**, not deferred to Task 6: Task 1 moves `gate-m18-skill-and-teeth.mjs:505`'s seed (the `tool` column it writes is dropped by Task 1's own migration), Task 2 moves `apps/orchestrator/test/integration/tick.test.ts:360-371`'s `.slaveofai/runs` path pin and `packages/control/test/paths.test.ts`, Task 5 moves nothing in a gate but regenerates nothing either, and Task 6 moves `gate-m18`'s payload and card assertions together with the fixture redaction that earns them.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web tasks also run `npm run web:build` (subject to the `next dev` rule above) and `npm run gate:m44-ux-foundation` as the browser check.
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with a `// @vitest-environment jsdom` first line.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/permission/kinds.ts        R1: PERMISSION_KINDS, PermissionKind, PERMISSION_LABEL,
                                               TOOLS_BY_KIND, TOOL_VOCABULARY, BASELINE_GRANTS,
                                               ENFORCE_BY_PROVIDER, TOOL_DENIED_LABEL (new)
packages/domain/src/permission/resolve.ts      R2/R7/E12: resolveGrants, grantsFor, GrantSource (new)
packages/domain/src/permission/index.ts        (new) -- ./kinds.js, ./resolve.js
packages/domain/src/broker/operations.ts       R3: BROKERED_OPERATIONS, BrokerOp, BROKER_OP_LABEL,
                                               BROKER_REFUSAL_REASONS, BROKER_REFUSAL_LABEL,
                                               BROKER_TIMEOUT_MS, BROKER_CLIENT_TIMEOUT_MS,
                                               PERMISSION_TRIP_COUNT, PERMISSION_DENIAL_WINDOW_MS (new)
packages/domain/src/broker/index.ts            (new) -- ./operations.js
packages/domain/src/index.ts                   + ./permission/index.js, + ./broker/index.js
packages/domain/src/events/schema.ts           R3/R5/E13: broker.executed (56th), broker.refused (57th),
                                               permission.changed (58th)
packages/domain/src/supervisor/situations.ts   R5/E13: permission_blocked (17th) + its SITUATION_LABEL
packages/domain/src/supervisor/actions.ts      R5/E13: request_permission (17th) + its schema arm
packages/domain/src/supervisor/policy.ts       R5: tierOf(request_permission) = proposed, and WHY
packages/domain/src/supervisor/observe.ts      R5/E9: the permission_blocked predicate
packages/domain/src/supervisor/candidates.ts   R5: the permission_blocked arm, permissionWhyFor
packages/domain/src/supervisor/world.ts        R5/E9: SupervisorDenial, SupervisorWorld.denials
packages/domain/src/supervisor/timeline.ts     R3/R5: LANE_BY_TYPE gains three
packages/domain/test/permission/{kinds,resolve}.test.ts                 (new)
packages/domain/test/broker/operations.test.ts                          (new)
packages/domain/test/events/schema.test.ts                              extended
packages/domain/test/supervisor/{fixtures,observe,candidates,policy,labels,timeline}.test.ts  extended

packages/db/prisma/schema.prisma               R1/R3/R4: enum PermissionKind, enum CredentialKind,
                                               model Credential, model BrokerBinding,
                                               SlavePermission.{kind,grantedBy,grantedAt},
                                               SlaveRun.runTokenHash, three EventType members,
                                               one SupervisorSituationKind member
packages/db/prisma/migrations/20260912180000_m52_broker/migration.sql   (new)
packages/db/src/enums.ts                       R3: EVENT_TYPE_BY_DOMAIN_TYPE gains three
packages/db/test/integration/enum-parity.test.ts                        + two assertions

packages/control/src/permission.ts             R1/R2: writePermissionsFile v2, setSlavePermission(kind),
                                               clearSlavePermission; resolveDenyList/CAPABILITY_TOOLS/
                                               PERMISSION_TOOLS deleted (E12 moves the rule to domain)
packages/control/src/paths.ts                  R4: runFilePaths' state directory, 0700
packages/control/src/credential.ts             R3 (new): addCredential, listCredentials, bindBrokerOp,
                                               listBrokerBindings
packages/control/src/broker.ts                 R3/R6 (new): runBrokeredOperation, the seven refusals
packages/control/src/refusal.ts                E5: broker_refused, credential_not_found
packages/control/src/supervisor.ts             R5: carryOut's request_permission arm
packages/control/src/supervisorWorld.ts        R5/E9: the denials read
packages/control/src/index.ts                  + ./credential.js, + ./broker.js
packages/control/test/permission-mapping.test.ts       MOVED: TOOLS_BY_KIND + resolveGrants per provider
packages/control/test/paths.test.ts                    MOVED: the state dir
packages/control/test/simulation-boundary.test.ts      R6: the third assertion
packages/control/test/integration/{permission,credential,broker,supervisor,supervisorWorld}.test.ts
apps/web/test/refusal-status.test.ts                   the two kinds

packages/providers/src/runtime/process.ts      R3/R4: CHILD_ENV_ALLOW, buildChildEnv's five
                                               SLAVEOFAI_* channels, brokerChannelPathFor,
                                               brokerReplyPathFor, runTokenHash
packages/providers/src/runtime/gate-preflight.ts  E1: runGateScript deletes the permissions variable
packages/providers/src/claude/adapter.ts       R4/E6/E7: StartRunInput.runToken, resume's 4th argument,
                                               ClaudeCodeAdapterOptions.brokerCliPath
packages/providers/src/cursor/adapter.ts       R4/E6/E7: the same three
packages/providers/src/gate.ts                 R2: the reason grammar's docstring (no code change)
packages/providers/src/index.ts                + the new runtime exports
scripts/lib/permissions.sh                     R2/R4/E1/E3/E8: default-deny, the vocabulary, enforce,
                                               the identity check
scripts/pause-gate.sh                          R2: the deny message's kind slot
packages/providers/test/{permissions-lib,pause-gate,cursor-shell-gate,runtime-process,adapter-start,
                         adapter-resume,run-preparation}.test.ts

apps/orchestrator/src/{tick,planning,review}.ts   R2/R4: resolveGrants, the token, runTokenHash
apps/orchestrator/src/resume.ts                   R2/R4: the same, and the ROTATION
apps/orchestrator/src/broker.ts                   R3 (new): serveBrokerRequests, the reply file
apps/orchestrator/src/sweep.ts                    R3: the per-tick broker pass
apps/orchestrator/src/cli.ts                      R3/R5/E6: brokerCliPath(), the registry, and the
                                                  verbs `permission`, `credential`, `broker`
apps/orchestrator/test/integration/{tick,broker,cli}.test.ts

apps/web/src/server/settings.ts                R7: buildPermissionMatrix on kinds
apps/web/src/server/overview.ts                R7: SlaveCardData.permissions
apps/web/src/server/timeline.ts                R3/R5: three sentences
apps/web/src/lib/activityFilters.ts            R3/R5: three types
apps/web/src/components/PermissionMatrix.tsx   R7/E14: the kinds vocabulary and the honest copy
apps/web/src/components/SlavePanel.tsx         R7: the permissions group and its Advanced
apps/web/src/components/ui/DetailsGroup.tsx    R7: DetailsGroupName gains 'permissions'
apps/web/src/components/activity/cards.tsx     R3/R5/E2: three cards, and the tool-denied LABEL
apps/web/src/components/SupervisorPanel.tsx    R5: actionText's request_permission arm
apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/permissions/[kind]/route.ts  (new: PUT + DELETE)
apps/web/src/app/api/slaves/[slaveId]/permission/route.ts                          (deleted, moved)
apps/web/test/{permission-matrix,slave-panel,activity-cards,activityFilters,supervisor-panel}.test.tsx
apps/web/test/integration/slave-routes.test.ts
docs/ia.md                                     R7: three Later cells

scripts/gate-fakes/fake-deploy.sh              R8 (new)
packages/providers/test/fake-claude.mjs        R8: --broker-op
packages/providers/test/fixtures/permission-matrix-deny.ndjson   R8/E10: one redaction row
packages/providers/test/fixtures/README.md     R8/E10: the row, and the count
scripts/gate-m52-broker.mjs                    R8 (new)
scripts/gate-m18-skill-and-teeth.mjs           R1 (the seed, Task 1) / R8 (the payload + card, Task 6)
package.json, .github/workflows/ci.yml, README.md               R8
docs/superpowers/fidelity/m14/{overview,project-settings}.png   regenerated in their own commit
docs/superpowers/specs/2026-09-12-m52-capability-broker-design.md   the spec, committed verbatim + §4
docs/superpowers/plans/2026-09-12-m52-capability-broker.md          this plan
```

---

### Task 1: The six operations, the brokered manifest, the three events, the seventeenth situation and action, and the column swap (R1, R3, R5, R6, E5, E9, E11, E12, E13, D1–D7)

`packages/domain` and `packages/db`, plus the two edits the column swap FORCES on the code that reads the old column — nothing else. This task changes no behaviour: after it, a denied `run_commands` row denies `Bash` exactly as a denied `run tests` row did the day before, through a new table, read off a new column, spelled in the new vocabulary. The INVERSION is Task 2's, deliberately: a migration that rewrites a permission table and a gate that reverses its answer are two things a reviewer should be able to read one at a time.

**Files:**
- Create: `packages/domain/src/permission/kinds.ts`, `packages/domain/src/permission/resolve.ts`, `packages/domain/src/permission/index.ts`, `packages/domain/src/broker/operations.ts`, `packages/domain/src/broker/index.ts`, `packages/domain/test/permission/kinds.test.ts`, `packages/domain/test/permission/resolve.test.ts`, `packages/domain/test/broker/operations.test.ts`, `packages/db/prisma/migrations/20260912180000_m52_broker/migration.sql`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/events/schema.ts`, `packages/domain/src/supervisor/{situations,actions,policy,observe,candidates,world,timeline}.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/enums.ts`, `packages/control/src/permission.ts`, `apps/orchestrator/src/{tick,planning,review,resume}.ts`, `scripts/gate-m18-skill-and-teeth.mjs`
- Test: the three new domain test files, plus `packages/domain/test/events/schema.test.ts`, `packages/domain/test/supervisor/{fixtures,observe,candidates,policy,labels,timeline}.test.ts`, `packages/db/test/integration/enum-parity.test.ts`, `packages/control/test/permission-mapping.test.ts`, `packages/control/test/integration/permission.test.ts`

**Interfaces:**
- Consumes: `ProviderKind` (`packages/domain/src/ids.js` — verify with `grep -rn "export type ProviderKind" packages/domain/src`; if it lives only in `packages/providers`, see Step 3's note, which gives the exact fallback), `RunKind` (the Prisma enum's three members, spelled as a domain union), `SituationKind`, `Action`, `Tier`, `SupervisorWorld`, `zod`. No Prisma, no `node:`, no I/O anywhere in `packages/domain`.
- Produces, for Tasks 2–6:
  - `PERMISSION_KINDS = ['read_repo','write_repo','run_commands','network_fetch','read_secret','deploy_release'] as const`, `type PermissionKind`, `PERMISSION_LABEL: Record<PermissionKind, string>`
  - `TOOLS_BY_KIND: Record<PermissionKind, Record<ProviderKind, readonly string[]>>`, `TOOL_VOCABULARY: Record<ProviderKind, Readonly<Record<string, PermissionKind>>>`
  - `BASELINE_GRANTS: Record<RunKind, readonly PermissionKind[]>`, `ENFORCE_BY_PROVIDER: Record<ProviderKind, 'all-tools' | 'known-tools'>`
  - `TOOL_DENIED_LABEL: Record<PermissionKind | 'ungoverned_tool', string>`
  - `resolveGrants(rows, provider, runKind): readonly { tool: string; kind: PermissionKind }[]`
  - `grantsFor(rows, runKind): readonly { kind: PermissionKind; mode: 'allow'|'deny'|null; source: GrantSource; by: string|null; at: string|null }[]`, `type GrantSource = 'baseline' | 'granted' | 'refused' | 'never'`
  - `BROKERED_OPERATIONS`, `type BrokerOp`, `BROKER_OP_LABEL`, `BROKER_REFUSAL_REASONS` (7), `BROKER_REFUSAL_LABEL`, `BROKER_TIMEOUT_MS = 120_000`, `BROKER_CLIENT_TIMEOUT_MS = 150_000`, `PERMISSION_TRIP_COUNT = 3`, `PERMISSION_DENIAL_WINDOW_MS = 30 * 60_000`
  - three `ExecutionEvent` arms: `broker.executed`, `broker.refused`, `permission.changed`
  - situation `permission_blocked`, action `request_permission`, `permissionWhyFor(kind, count)`, `SupervisorDenial`, `SupervisorWorld.denials`
  - Prisma: `PermissionKind`, `CredentialKind`, `Credential`, `BrokerBinding`, `SlavePermission.{kind,grantedBy,grantedAt}`, `SlaveRun.runTokenHash`

- [ ] **Step 1: Write the failing test for the permission vocabulary**

`packages/domain/test/permission/kinds.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  BASELINE_GRANTS,
  ENFORCE_BY_PROVIDER,
  PERMISSION_KINDS,
  PERMISSION_LABEL,
  TOOLS_BY_KIND,
  TOOL_DENIED_LABEL,
  TOOL_VOCABULARY,
  type PermissionKind,
} from '../../src/permission/kinds.js'

describe('PERMISSION_KINDS', () => {
  it('is the closed list of OPERATIONS a worker may be granted, in the order a person grants them', () => {
    expect(PERMISSION_KINDS).toEqual([
      'read_repo',
      'write_repo',
      'run_commands',
      'network_fetch',
      'read_secret',
      'deploy_release',
    ])
  })

  it('has no duplicates -- the list is the union, so a repeat would type-check and lie', () => {
    expect(new Set(PERMISSION_KINDS).size).toBe(PERMISSION_KINDS.length)
  })

  it('gives every kind a word, so no surface ever prints the key (docs/ia.md rule 3)', () => {
    for (const kind of PERMISSION_KINDS) {
      expect(PERMISSION_LABEL[kind], kind).toMatch(/^[A-Z]/u)
      expect(PERMISSION_LABEL[kind], kind).not.toContain('_')
    }
  })

  it('says what each operation IS, not what its key spells', () => {
    expect(PERMISSION_LABEL).toEqual({
      read_repo: 'Read the repository',
      write_repo: 'Write source',
      run_commands: 'Run commands',
      network_fetch: 'Fetch over the network',
      read_secret: 'Read a secret',
      deploy_release: 'Deploy a release',
    })
  })
})

describe('TOOLS_BY_KIND', () => {
  it('names the FULL governed toolbox per kind per provider -- an allowlist, not the old denylist', () => {
    expect(TOOLS_BY_KIND).toEqual({
      read_repo: {
        claude_code: ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'Task', 'Skill'],
        cursor: ['read'],
      },
      write_repo: { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
      run_commands: { claude_code: ['Bash', 'BashOutput', 'KillShell'], cursor: ['shell'] },
      network_fetch: { claude_code: ['WebFetch', 'WebSearch'], cursor: [] },
      read_secret: { claude_code: [], cursor: [] },
      deploy_release: { claude_code: [], cursor: [] },
    })
  })

  it('gives the two BROKER-ONLY kinds no vendor tool on either provider, which is why `deploy prod` could never be a tool deny', () => {
    for (const provider of ['claude_code', 'cursor'] as const) {
      expect(TOOLS_BY_KIND.read_secret[provider]).toEqual([])
      expect(TOOLS_BY_KIND.deploy_release[provider]).toEqual([])
    }
  })

  it('never maps one tool to two kinds -- a tool with two governors has no single verdict', () => {
    for (const provider of ['claude_code', 'cursor'] as const) {
      const all = PERMISSION_KINDS.flatMap((kind) => TOOLS_BY_KIND[kind][provider])
      expect(new Set(all).size, provider).toBe(all.length)
    }
  })
})

describe('TOOL_VOCABULARY', () => {
  it('is DERIVED from TOOLS_BY_KIND, never a second list -- tool name to the kind that governs it', () => {
    for (const provider of ['claude_code', 'cursor'] as const) {
      for (const kind of PERMISSION_KINDS) {
        for (const tool of TOOLS_BY_KIND[kind][provider]) {
          expect(TOOL_VOCABULARY[provider][tool], `${provider} ${tool}`).toBe(kind)
        }
      }
    }
  })

  it('holds exactly the tool names the fixtures actually observe for Claude, so a vendor tool nobody mapped is a RED TEST and not a silent hole', () => {
    // MEASURED, not assumed: these are the `tool_use` names present in the checked-in recordings
    // under `packages/providers/test/fixtures/` (`complete.ndjson`'s Write and Bash,
    // `permission-matrix-deny.ndjson`'s Read and Bash, `claude/skill-tool-use.ndjson`'s Skill).
    // A recording that one day carries a seventh name fails HERE, at a list a person can extend,
    // rather than silently denying a working run once Task 2 inverts the gate.
    for (const observed of ['Read', 'Write', 'Edit', 'Bash', 'Skill']) {
      expect(Object.keys(TOOL_VOCABULARY.claude_code), observed).toContain(observed)
    }
  })

  it('holds the three lowercase Cursor names its own recordings carry', () => {
    expect(Object.keys(TOOL_VOCABULARY.cursor).sort()).toEqual(['edit', 'read', 'shell'])
  })
})

describe('BASELINE_GRANTS', () => {
  it('is what a run of each kind may do before anybody has decided anything', () => {
    expect(BASELINE_GRANTS).toEqual({
      implementation: ['read_repo', 'write_repo', 'run_commands'],
      review: ['read_repo', 'run_commands'],
      planning: ['read_repo'],
    })
  })

  it('never contains a broker-only kind -- a baseline is about TOOLS, and a credential is never a default', () => {
    for (const kinds of Object.values(BASELINE_GRANTS)) {
      expect(kinds).not.toContain('read_secret')
      expect(kinds).not.toContain('deploy_release')
    }
  })

  it('is ordered as PERMISSION_KINDS is, so a resolved allow list is byte-equal run to run', () => {
    for (const [runKind, kinds] of Object.entries(BASELINE_GRANTS)) {
      const indexes = kinds.map((kind) => PERMISSION_KINDS.indexOf(kind as PermissionKind))
      expect([...indexes].sort((a, b) => a - b), runKind).toEqual(indexes)
    }
  })
})

describe('ENFORCE_BY_PROVIDER', () => {
  it('enforces every tool on Claude and only the ones it can NAME on Cursor (plan erratum E3)', () => {
    expect(ENFORCE_BY_PROVIDER).toEqual({ claude_code: 'all-tools', cursor: 'known-tools' })
  })
})

describe('TOOL_DENIED_LABEL', () => {
  it('gives every kind AND the ungoverned-tool reason a word -- the card prints this, never the key', () => {
    for (const kind of PERMISSION_KINDS) expect(TOOL_DENIED_LABEL[kind]).toBe(PERMISSION_LABEL[kind])
    expect(TOOL_DENIED_LABEL.ungoverned_tool).toBe('A tool nobody governs')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/permission/kinds.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/permission/kinds.js"`.

- [ ] **Step 3: Write the vocabulary**

First, settle where `ProviderKind` comes from. Run `grep -rn "ProviderKind" packages/domain/src | head`. If the domain already exports it, import it. If it does NOT (the likely case — `packages/providers/src/types.ts` owns it and the domain may not depend on providers), declare it locally in `kinds.ts` as `export const PERMISSION_PROVIDERS = ['claude_code', 'cursor'] as const` with `type PermissionProvider = (typeof PERMISSION_PROVIDERS)[number]`, and say in the docstring that it is the same two members `packages/db`'s `ProviderKind` enum carries, pinned by Step 24's enum-parity assertion. Use whichever name that decision produces consistently for the rest of the milestone and record it in the task report — every later task types a parameter with it.

`packages/domain/src/permission/kinds.ts`:

```ts
/**
 * What a worker may DO, as data (M52 R1).
 *
 * A PERMISSION is an OPERATION and never a capability. M47's `Capability` says what a worker is
 * FOR -- the taxonomy key a task requires and a worker provides; this list says what ANY worker may
 * do, whatever it is for. The UI prints "Permissions" and "Capabilities" as two words for two
 * things and never one for both, and nothing here reads `Slave.capabilities`.
 *
 * Until this milestone the list was six PROSE ROWS -- `repo read`, `source write`, `run tests`,
 * `create branch`, `deploy prod`, `read secrets` (`packages/control/src/permission.ts:18-26`) --
 * of which three collapsed onto `Bash` (so denying `deploy prod` denied the whole shell) and one
 * (`read secrets`) mapped to no tool at all and enforced nothing. The six below are the same six
 * ideas with the collisions removed: one operation per row, and the two that name no vendor tool
 * name none because they are BROKER grants (R3) rather than tool grants -- which is exactly why
 * `deploy prod` could never be expressed as a tool deny in the first place.
 *
 * The order is the order a person grants them in: read, then write, then run, then reach the
 * network, and last the two that hand over something the worker never holds itself.
 */
export const PERMISSION_KINDS = [
  'read_repo',
  'write_repo',
  'run_commands',
  'network_fetch',
  /** A BROKER grant, not a tool grant: it names no vendor tool on either provider, and what it
   *  permits is `runBrokeredOperation` reading `process.env[Credential.envVar]` on the worker's
   *  behalf -- in the orchestrator's process, never in the worker's. */
  'read_secret',
  /** The second broker grant, and the one this milestone proves end to end. */
  'deploy_release',
] as const

export type PermissionKind = (typeof PERMISSION_KINDS)[number]

/** The two providers a permission resolves against. The same two members `packages/db`'s
 *  `ProviderKind` enum carries, spelled here because `packages/domain` may not depend on
 *  `@slave-of-ai/providers` (which imports `node:child_process` at module scope). */
export const PERMISSION_PROVIDERS = ['claude_code', 'cursor'] as const
export type PermissionProvider = (typeof PERMISSION_PROVIDERS)[number]

/**
 * What each operation is CALLED when a person reads it (`docs/ia.md` rule 3).
 *
 * `Record<PermissionKind, string>` is load-bearing: a seventh kind fails the build here rather than
 * turning up on the Settings matrix as an identifier. Every label is what the operation IS, in the
 * words the matrix column header uses -- the raw key stays in `title` and on `data-kind`.
 */
export const PERMISSION_LABEL: Record<PermissionKind, string> = {
  read_repo: 'Read the repository',
  write_repo: 'Write source',
  run_commands: 'Run commands',
  network_fetch: 'Fetch over the network',
  read_secret: 'Read a secret',
  deploy_release: 'Deploy a release',
}

/**
 * The FULL governed toolbox per operation per provider -- the inverted `CAPABILITY_TOOLS`.
 *
 * The old table listed only what a deny should BLOCK, which is a denylist: it closed instances.
 * This one lists everything an operation covers, which is an allowlist: it closes the class. A tool
 * that appears in no row here is governed by nothing, and from Task 2 a tool governed by nothing is
 * DENIED on `claude_code` -- so this table is the thing that decides whether a working run keeps
 * working, and {@link TOOL_VOCABULARY}'s tripwire is what keeps a vendor's seventh tool from
 * becoming a silent wall.
 *
 * `read_secret` and `deploy_release` name NOTHING on purpose (see their members above).
 */
export const TOOLS_BY_KIND: Record<PermissionKind, Record<PermissionProvider, readonly string[]>> = {
  read_repo: {
    // `Task` and `Skill` are reads in the sense that matters here: neither writes the worktree, and
    // a run that may not use them cannot follow a runbook or a skill it was given (M14, M48).
    claude_code: ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'Task', 'Skill'],
    cursor: ['read'],
  },
  write_repo: { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
  // `BashOutput` and `KillShell` go with `Bash` and not with a fourth kind: they operate on a shell
  // this worker already started, so a grant that covered one and not the others would leave a run
  // able to start a command and unable to read it.
  run_commands: { claude_code: ['Bash', 'BashOutput', 'KillShell'], cursor: ['shell'] },
  network_fetch: { claude_code: ['WebFetch', 'WebSearch'], cursor: [] },
  read_secret: { claude_code: [], cursor: [] },
  deploy_release: { claude_code: [], cursor: [] },
}

/**
 * Every governed tool name to the kind that governs it, DERIVED from {@link TOOLS_BY_KIND} rather
 * than written twice.
 *
 * Two jobs, both needed by the gate: it is the membership test that tells a governed-but-ungranted
 * tool (deny, naming its kind) from an ungoverned one (deny as `ungoverned_tool` on `claude_code`,
 * allow on `cursor` -- plan erratum E3), and it is what lets the shell NAME the kind of a tool that
 * is not on the allow list, which an allow list alone cannot do.
 *
 * Built once at module load. A duplicate tool name across two kinds would silently lose one of them
 * here; `kinds.test.ts` asserts there is none.
 */
export const TOOL_VOCABULARY: Record<PermissionProvider, Readonly<Record<string, PermissionKind>>> =
  Object.fromEntries(
    PERMISSION_PROVIDERS.map((provider) => [
      provider,
      Object.fromEntries(
        PERMISSION_KINDS.flatMap((kind) => TOOLS_BY_KIND[kind][provider].map((tool) => [tool, kind] as const)),
      ),
    ]),
  ) as Record<PermissionProvider, Readonly<Record<string, PermissionKind>>>

/**
 * What a run of each kind may do before anybody has decided anything (M52 R2).
 *
 * COMPUTED, never stored. The direction was to seed these as rows in the migration, keyed on the
 * worker's runtime role; two facts refuse that. `Slave.runtimeRoles` is free text capped at twenty
 * entries (`packages/control/src/profile.ts:31`) and cannot key a constant, while `RunKind` is a
 * closed enum the four resolution sites already differ on. And six seeded rows per worker is a new
 * unique index colliding with fixtures in five web integration test files. Computing it gives
 * "nothing that works today stops working" by construction, keeps the migration to one data
 * statement, and makes a permission's SOURCE a projection ({@link grantsFor}) rather than a column.
 *
 * A planning run reads and nothing else: it writes a task graph, not source. A review run reads and
 * runs commands: it has to be able to run the tests it is judging. An implementation run gets all
 * three, which is what every implementation run has always had.
 */
export const BASELINE_GRANTS: Record<'implementation' | 'review' | 'planning', readonly PermissionKind[]> = {
  implementation: ['read_repo', 'write_repo', 'run_commands'],
  review: ['read_repo', 'run_commands'],
  planning: ['read_repo'],
}

/**
 * How much of the matrix each provider's gate can actually ENFORCE (plan erratum E3).
 *
 * Not `ProviderCapabilities.gate`, which answers a different question: Cursor's is `'all-tools'`
 * and PROVEN so for the PAUSE path (`packages/providers/src/capabilities.ts:87-98`), because a
 * pause denies without reading a tool name at all. The permission path does read one, and Cursor's
 * `preToolUse` sends Claude-shaped casing (`"Read"`/`"Shell"`/`"Write"`) that never matches this
 * file's lowercase Cursor vocabulary (measured, `scripts/lib/permissions.sh:30-36`). Under the old
 * denylist that mismatch was inert. Under an allow list it would deny EVERY Cursor tool call, so
 * the gate is told, in the file it reads, to enforce only the names it can trust: `shell`, which
 * arrives through `beforeShellExecution`'s `default_tool` accommodation and is the one Cursor path
 * that has ever been enforceable. Stated in the matrix copy, not left implicit.
 */
export const ENFORCE_BY_PROVIDER: Record<PermissionProvider, 'all-tools' | 'known-tools'> = {
  claude_code: 'all-tools',
  cursor: 'known-tools',
}

/**
 * What a `run.tool_denied` card prints (`docs/ia.md` rule 3, plan erratum E2).
 *
 * The payload's `capability` field carries a `PermissionKind` -- or the literal `ungoverned_tool`,
 * which is a REASON and not a kind: no row can grant it, the matrix has no column for it, and a
 * seventh `PERMISSION_KINDS` member would be a grant nobody asked for. It gets a word here because
 * a person meets it on the activity feed exactly as they meet the six.
 */
export const TOOL_DENIED_LABEL: Record<PermissionKind | 'ungoverned_tool', string> = {
  ...PERMISSION_LABEL,
  ungoverned_tool: 'A tool nobody governs',
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/permission/kinds.test.ts`
Expected: PASS — 14 cases.

- [ ] **Step 5: Write the failing test for the two resolutions**

`packages/domain/test/permission/resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { grantsFor, resolveGrants } from '../../src/permission/resolve.js'

const NOBODY: readonly { readonly kind: 'read_repo'; readonly mode: 'allow' }[] = []

describe('resolveGrants', () => {
  it('gives a fresh implementation run exactly the baseline toolbox, with nobody having decided anything', () => {
    expect(resolveGrants([], 'claude_code', 'implementation')).toEqual([
      { tool: 'Read', kind: 'read_repo' },
      { tool: 'Glob', kind: 'read_repo' },
      { tool: 'Grep', kind: 'read_repo' },
      { tool: 'NotebookRead', kind: 'read_repo' },
      { tool: 'TodoWrite', kind: 'read_repo' },
      { tool: 'Task', kind: 'read_repo' },
      { tool: 'Skill', kind: 'read_repo' },
      { tool: 'Write', kind: 'write_repo' },
      { tool: 'Edit', kind: 'write_repo' },
      { tool: 'NotebookEdit', kind: 'write_repo' },
      { tool: 'Bash', kind: 'run_commands' },
      { tool: 'BashOutput', kind: 'run_commands' },
      { tool: 'KillShell', kind: 'run_commands' },
    ])
  })

  it('gives a planning run READS only -- no Write, no Bash', () => {
    const tools = resolveGrants([], 'claude_code', 'planning').map((entry) => entry.tool)
    expect(tools).toContain('Read')
    expect(tools).not.toContain('Write')
    expect(tools).not.toContain('Bash')
  })

  it('gives a review run reads and commands, and no write', () => {
    const tools = resolveGrants([], 'claude_code', 'review').map((entry) => entry.tool)
    expect(tools).toContain('Bash')
    expect(tools).not.toContain('Write')
  })

  it('adds an allowed kind on top of the baseline', () => {
    const tools = resolveGrants([{ kind: 'network_fetch', mode: 'allow' }], 'claude_code', 'planning').map((e) => e.tool)
    expect(tools).toEqual(['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'Task', 'Skill', 'WebFetch', 'WebSearch'])
  })

  it('DENY WINS over the baseline -- a refusal is a person overruling the default, not a no-op', () => {
    const tools = resolveGrants([{ kind: 'run_commands', mode: 'deny' }], 'claude_code', 'implementation').map((e) => e.tool)
    expect(tools).not.toContain('Bash')
    expect(tools).toContain('Write')
  })

  it('deny wins over an allow row for the same kind, whatever order the rows arrive in', () => {
    const rows = [
      { kind: 'run_commands', mode: 'allow' },
      { kind: 'run_commands', mode: 'deny' },
    ] as const
    expect(resolveGrants(rows, 'claude_code', 'implementation').map((e) => e.tool)).not.toContain('Bash')
    expect(resolveGrants([...rows].reverse(), 'claude_code', 'implementation').map((e) => e.tool)).not.toContain('Bash')
  })

  it('resolves the Cursor vocabulary, lowercase, for the same rows', () => {
    expect(resolveGrants([], 'cursor', 'implementation')).toEqual([
      { tool: 'read', kind: 'read_repo' },
      { tool: 'edit', kind: 'write_repo' },
      { tool: 'shell', kind: 'run_commands' },
    ])
  })

  it('puts NO tool on the list for the two broker grants, granted or not -- they are not tool grants', () => {
    const tools = resolveGrants(
      [
        { kind: 'read_secret', mode: 'allow' },
        { kind: 'deploy_release', mode: 'allow' },
      ],
      'claude_code',
      'implementation',
    ).map((entry) => entry.tool)
    expect(tools).toHaveLength(13)
  })

  it('ignores a row whose kind is not one of the six -- the column is typed, a hand-written row is not', () => {
    expect(resolveGrants([{ kind: 'launch_nukes', mode: 'allow' } as never], 'claude_code', 'planning')).toHaveLength(7)
  })

  it('is order-stable: the same rows in any order produce a byte-equal list', () => {
    const a = resolveGrants(
      [
        { kind: 'network_fetch', mode: 'allow' },
        { kind: 'write_repo', mode: 'deny' },
      ],
      'claude_code',
      'implementation',
    )
    const b = resolveGrants(
      [
        { kind: 'write_repo', mode: 'deny' },
        { kind: 'network_fetch', mode: 'allow' },
      ],
      'claude_code',
      'implementation',
    )
    expect(a).toEqual(b)
  })

  it('takes no rows at all and still resolves -- an empty table is every fresh install', () => {
    expect(resolveGrants(NOBODY, 'claude_code', 'review').length).toBeGreaterThan(0)
  })
})

describe('grantsFor', () => {
  it('answers all six kinds, in PERMISSION_KINDS order, whatever rows exist', () => {
    const rows = grantsFor([], 'implementation')
    expect(rows.map((row) => row.kind)).toEqual([
      'read_repo',
      'write_repo',
      'run_commands',
      'network_fetch',
      'read_secret',
      'deploy_release',
    ])
  })

  it('calls a baseline kind BASELINE, with no person and no date -- nobody decided it', () => {
    const row = grantsFor([], 'implementation').find((entry) => entry.kind === 'run_commands')
    expect(row).toEqual({ kind: 'run_commands', mode: null, source: 'baseline', by: null, at: null })
  })

  it('calls a kind outside the baseline with no row NEVER -- the third glyph, and the honest one', () => {
    const row = grantsFor([], 'planning').find((entry) => entry.kind === 'run_commands')
    expect(row).toEqual({ kind: 'run_commands', mode: null, source: 'never', by: null, at: null })
  })

  it('names who granted and when', () => {
    const row = grantsFor(
      [{ kind: 'network_fetch', mode: 'allow', grantedBy: 'meren', grantedAt: '2026-09-12T10:00:00.000Z' }],
      'implementation',
    ).find((entry) => entry.kind === 'network_fetch')
    expect(row).toEqual({
      kind: 'network_fetch',
      mode: 'allow',
      source: 'granted',
      by: 'meren',
      at: '2026-09-12T10:00:00.000Z',
    })
  })

  it('names a REFUSAL as a refusal even when the baseline would have granted it -- the person overruled the default', () => {
    const row = grantsFor(
      [{ kind: 'run_commands', mode: 'deny', grantedBy: 'meren', grantedAt: '2026-09-12T10:00:00.000Z' }],
      'implementation',
    ).find((entry) => entry.kind === 'run_commands')
    expect(row?.source).toBe('refused')
    expect(row?.mode).toBe('deny')
  })

  it('agrees with resolveGrants on every kind: granted or baseline iff the kind put tools on the list', () => {
    const rows = [
      { kind: 'network_fetch', mode: 'allow' as const },
      { kind: 'write_repo', mode: 'deny' as const },
    ]
    const allowed = new Set(resolveGrants(rows, 'claude_code', 'implementation').map((entry) => entry.kind))
    for (const row of grantsFor(rows, 'implementation')) {
      const effective = row.source === 'granted' || row.source === 'baseline'
      const hasTools = allowed.has(row.kind)
      // The two broker kinds put no tool on the list however they resolve, so they are exempt from
      // this correspondence and asserted separately above.
      if (row.kind !== 'read_secret' && row.kind !== 'deploy_release') {
        expect(hasTools, row.kind).toBe(effective)
      }
    }
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/permission/resolve.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/permission/resolve.js"`.

- [ ] **Step 7: Write the two resolutions**

`packages/domain/src/permission/resolve.ts`:

```ts
import {
  BASELINE_GRANTS,
  PERMISSION_KINDS,
  TOOLS_BY_KIND,
  type PermissionKind,
  type PermissionProvider,
} from './kinds.js'

/** One `SlavePermission` row, as the two functions below read it. A flat shape rather than the
 *  Prisma row for `packages/domain`'s standing reason: the domain is pure, and a shape the caller
 *  can build from a row is what lets the web, the orchestrator and a test run one rule. */
export interface PermissionRowInput {
  readonly kind: PermissionKind
  readonly mode: 'allow' | 'deny'
  readonly grantedBy?: string | null
  readonly grantedAt?: string | null
}

/** Where a kind's effective answer CAME FROM (M52 R7) -- computed, never stored. */
export type GrantSource = 'baseline' | 'granted' | 'refused' | 'never'

/** One resolved allow-list entry: a vendor tool, and the operation that put it there. The `kind`
 *  rides along because the gate has to be able to say WHY, and because `permissions.json` is read
 *  by a shell that has no table of its own. */
export interface ResolvedGrant {
  readonly tool: string
  readonly kind: PermissionKind
}

function isPermissionKind(value: string): value is PermissionKind {
  return (PERMISSION_KINDS as readonly string[]).includes(value)
}

/**
 * The ALLOWED vendor tools for one run (M52 R2), replacing M18's `resolveDenyList`.
 *
 * `BASELINE_GRANTS[runKind] ∪ {rows with mode allow}` minus `{rows with mode deny}`, resolved
 * through {@link TOOLS_BY_KIND} for the run's own provider. Three properties the callers depend on:
 *
 * - **Deny wins, always.** A `deny` row is a person's explicit refusal and overrules both the
 *   baseline and an `allow` row for the same kind, whatever order the rows arrive in. The old
 *   resolver could not express this at all: `allow` and unset were identical to it
 *   (`permission.ts:53`), and "unset" allowed at the gate as well.
 * - **Order is the list's, not the query's.** Kinds are walked in `PERMISSION_KINDS` order and
 *   tools in `TOOLS_BY_KIND` order, so the same matrix produces a byte-equal `permissions.json`
 *   however Postgres returned the rows -- which is what makes the file diffable across a resume.
 * - **A kind nobody mapped contributes nothing.** A row whose `kind` is not one of the six (a
 *   hand-written row; a row from a database a future version wrote) is skipped rather than trusted,
 *   which under default-deny is the safe direction.
 *
 * Pure, and in `packages/domain` rather than `packages/control` (plan erratum E12): the Settings
 * matrix and the worker panel need the same rule, and a `'use client'` component may not import
 * `@slave-of-ai/control` -- that barrel re-exports `@slave-of-ai/providers`, which imports
 * `node:child_process` at module scope (`apps/web/src/components/PermissionMatrix.tsx:40-43`).
 */
export function resolveGrants(
  rows: readonly PermissionRowInput[],
  provider: PermissionProvider,
  runKind: 'implementation' | 'review' | 'planning',
): readonly ResolvedGrant[] {
  const denied = new Set<PermissionKind>()
  const allowed = new Set<PermissionKind>(BASELINE_GRANTS[runKind])
  for (const row of rows) {
    if (!isPermissionKind(row.kind)) continue
    if (row.mode === 'deny') denied.add(row.kind)
    else allowed.add(row.kind)
  }
  const out: ResolvedGrant[] = []
  for (const kind of PERMISSION_KINDS) {
    if (denied.has(kind) || !allowed.has(kind)) continue
    for (const tool of TOOLS_BY_KIND[kind][provider]) out.push({ tool, kind })
  }
  return out
}

/** One kind's effective answer, and where it came from. */
export interface KindGrant {
  readonly kind: PermissionKind
  /** The stored row's mode, or `null` when there is no row: the three states the matrix's ✓/✕/–
   *  have always drawn, unchanged. */
  readonly mode: 'allow' | 'deny' | null
  readonly source: GrantSource
  /** Who decided, and when -- `null` on both when nobody did. ISO strings, not `Date`: this
   *  projection crosses a server/client boundary. */
  readonly by: string | null
  readonly at: string | null
}

/**
 * Every kind's effective answer for one worker, for the surfaces that must explain themselves
 * (M52 R7).
 *
 * The SOURCE is the sentence the worker panel prints under Advanced: `baseline` is "nobody decided
 * and the run kind says yes", `granted`/`refused` are "a person decided, here is who and when", and
 * `never` is "nobody has ever been asked". It is computed from the same two inputs
 * {@link resolveGrants} reads and is stored nowhere, so it cannot disagree with what the gate does.
 *
 * The run kind is a parameter because the baseline is: the same worker reads as `baseline` for
 * `run_commands` on an implementation run and `never` on a planning one, and both are true.
 */
export function grantsFor(
  rows: readonly PermissionRowInput[],
  runKind: 'implementation' | 'review' | 'planning',
): readonly KindGrant[] {
  const byKind = new Map<PermissionKind, PermissionRowInput>()
  for (const row of rows) {
    if (!isPermissionKind(row.kind)) continue
    // Deny wins here too, for `resolveGrants`' reason: two rows for one kind is a state
    // `@@unique([slaveId, kind])` forbids, and if one ever appears the refusal is the safe read.
    const existing = byKind.get(row.kind)
    if (existing === undefined || row.mode === 'deny') byKind.set(row.kind, row)
  }
  const baseline = new Set<PermissionKind>(BASELINE_GRANTS[runKind])
  return PERMISSION_KINDS.map((kind): KindGrant => {
    const row = byKind.get(kind)
    if (row === undefined) {
      return {
        kind,
        mode: null,
        source: baseline.has(kind) ? 'baseline' : 'never',
        by: null,
        at: null,
      }
    }
    return {
      kind,
      mode: row.mode,
      source: row.mode === 'allow' ? 'granted' : 'refused',
      by: row.grantedBy ?? null,
      at: row.grantedAt ?? null,
    }
  })
}
```

`packages/domain/src/permission/index.ts`:

```ts
export * from './kinds.js'
export * from './resolve.js'
```

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/permission`
Expected: PASS — 14 + 17 cases.

- [ ] **Step 9: Write the failing test for the brokered manifest**

`packages/domain/test/broker/operations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  BROKERED_OPERATIONS,
  BROKER_CLIENT_TIMEOUT_MS,
  BROKER_OPS,
  BROKER_OP_LABEL,
  BROKER_REFUSAL_LABEL,
  BROKER_REFUSAL_REASONS,
  BROKER_TIMEOUT_MS,
  PERMISSION_DENIAL_WINDOW_MS,
  PERMISSION_TRIP_COUNT,
} from '../../src/broker/operations.js'
import { PERMISSION_KINDS } from '../../src/permission/kinds.js'

describe('BROKERED_OPERATIONS', () => {
  it('is a STATIC manifest of exactly the ops this system will run on a worker’s behalf', () => {
    expect(BROKER_OPS).toEqual(['deploy_release'])
    expect(Object.keys(BROKERED_OPERATIONS)).toEqual([...BROKER_OPS])
  })

  it('gives every op a grant that is one of the six permission kinds', () => {
    for (const op of BROKER_OPS) {
      expect(PERMISSION_KINDS, op).toContain(BROKERED_OPERATIONS[op].grant)
    }
  })

  it('gives every op a word, so no surface prints the key', () => {
    for (const op of BROKER_OPS) {
      expect(BROKER_OP_LABEL[op], op).toMatch(/^[A-Z]/u)
      expect(BROKER_OP_LABEL[op], op).not.toContain('_')
    }
  })

  it('accepts an environment KEY and a digest, and nothing that could name a target', () => {
    const parsed = BROKERED_OPERATIONS.deploy_release.params.safeParse({
      environment: 'staging',
      digest: 'a1b2c3d',
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a URL, a path, a host and an absolute anything in `environment`', () => {
    for (const bad of ['https://example.com', '../etc', '/etc/passwd', 'prod.example.com', 'Staging', '']) {
      expect(BROKERED_OPERATIONS.deploy_release.params.safeParse({ environment: bad, digest: 'a1b2c3d' }).success, bad)
        .toBe(false)
    }
  })

  it('refuses a digest that is not lowercase hex of a plausible length', () => {
    for (const bad of ['ZZZZZZZ', 'a1b2c3', 'A1B2C3D', `${'a'.repeat(65)}`, '']) {
      expect(BROKERED_OPERATIONS.deploy_release.params.safeParse({ environment: 'staging', digest: bad }).success, bad)
        .toBe(false)
    }
  })

  it('refuses an unknown parameter -- the schema is strict, so a smuggled key is a refusal and not a silent drop', () => {
    const parsed = BROKERED_OPERATIONS.deploy_release.params.safeParse({
      environment: 'staging',
      digest: 'a1b2c3d',
      url: 'https://example.com',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('BROKER_REFUSAL_REASONS', () => {
  it('is the closed list of ways a brokered call is refused, and every one has a word', () => {
    expect(BROKER_REFUSAL_REASONS).toEqual([
      'identity_mismatch',
      'run_not_live',
      'permission_denied',
      'not_brokered',
      'credential_unset',
      'invalid_params',
      'simulation',
    ])
    for (const reason of BROKER_REFUSAL_REASONS) {
      expect(BROKER_REFUSAL_LABEL[reason], reason).toMatch(/^[A-Z]/u)
      expect(BROKER_REFUSAL_LABEL[reason], reason).not.toContain('_')
    }
  })
})

describe('the two timeouts and the trip count', () => {
  it('gives the CLIENT longer than the SERVER, so a worker never gives up on a call still running', () => {
    expect(BROKER_TIMEOUT_MS).toBe(120_000)
    expect(BROKER_CLIENT_TIMEOUT_MS).toBe(150_000)
    expect(BROKER_CLIENT_TIMEOUT_MS).toBeGreaterThan(BROKER_TIMEOUT_MS)
  })

  it('raises a permission situation on the THIRD denial of one kind, inside half an hour', () => {
    expect(PERMISSION_TRIP_COUNT).toBe(3)
    expect(PERMISSION_DENIAL_WINDOW_MS).toBe(30 * 60_000)
  })
})
```

- [ ] **Step 10: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/broker/operations.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/broker/operations.js"`.

- [ ] **Step 11: Write the manifest**

`packages/domain/src/broker/operations.ts`:

```ts
import { z } from 'zod'
import type { PermissionKind } from '../permission/kinds.js'

/**
 * Every operation the orchestrator will perform ON A WORKER'S BEHALF, as a static manifest (M52 R3).
 *
 * The whole point is the narrowness. A worker does not ask for a command, a URL, a host or a path:
 * it names one of the operations below and hands it typed parameters, and the orchestrator resolves
 * the rest -- the command template from a `BrokerBinding`, the secret from
 * `process.env[Credential.envVar]` -- out of rows only a person can write. `deploy_release` takes
 * an environment KEY and a digest precisely so a parameter can never name a target the binding did
 * not register: the narrowest verb the operation can be expressed as, never `runCommand(string)`.
 *
 * A STATIC manifest rather than rows: this table is auditable before anything loads, and an
 * operator who adds a `BrokerBinding` for an op that is not here gets a refusal rather than an
 * execution. `git_push` is the second op this registry is shaped for and is deliberately out of
 * scope for M52 (spec §3): there is no `git push` and no remote anywhere in `apps/orchestrator` or
 * `packages/control`, so proving it would need a faked remote as well as a faked credential, and
 * `deploy_release` proves the same mechanism with one fake.
 */
export const BROKERED_OPERATIONS = {
  deploy_release: {
    grant: 'deploy_release',
    params: z
      .object({
        /** An environment KEY, never a URL and never a host. Lowercase, bounded, and shell-safe by
         *  construction -- which matters because the resolved command is executed through
         *  `runShellCommand`, and a parameter that could carry a quote or a semicolon would be an
         *  injection whatever the executor promised. The parameters never enter the command string
         *  at all (they ride in the child's environment), and this regex is the second lock. */
        environment: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/u),
        /** A content digest: lowercase hex, short-sha to full sha256. Not a tag and not a branch --
         *  a name can move, and a release that moved is a release nobody can reproduce. */
        digest: z.string().regex(/^[a-f0-9]{7,64}$/u),
      })
      .strict(),
  },
} as const satisfies Record<string, { readonly grant: PermissionKind; readonly params: z.ZodType }>

export const BROKER_OPS = Object.keys(BROKERED_OPERATIONS) as readonly (keyof typeof BROKERED_OPERATIONS)[]
export type BrokerOp = keyof typeof BROKERED_OPERATIONS

/** What each op is CALLED (`docs/ia.md` rule 3) -- the activity card and the CLI print this. */
export const BROKER_OP_LABEL: Record<BrokerOp, string> = {
  deploy_release: 'Deploy a release',
}

/**
 * Every way a brokered call is refused (M52 R3), in the order the authoriser asks them.
 *
 * ONE list, in one place, because it has two homes that must not drift: the `broker.refused`
 * payload a person reads months later, and `ControlRefusal`'s `broker_refused` (plan erratum E5 --
 * one refusal kind carrying a reason, rather than seven refusal kinds re-spelling this list).
 *
 * `credential_unset` is the seventh and the one R3 did not name: a binding that names a credential
 * whose `envVar` is absent from the DAEMON'S OWN environment. It is the first thing an operator
 * meets on a fresh install, and `not_brokered` would describe it falsely -- the op IS brokered, the
 * secret simply is not there.
 */
export const BROKER_REFUSAL_REASONS = [
  'identity_mismatch',
  'run_not_live',
  'permission_denied',
  'not_brokered',
  'credential_unset',
  'invalid_params',
  'simulation',
] as const

export type BrokerRefusalReason = (typeof BROKER_REFUSAL_REASONS)[number]

export const BROKER_REFUSAL_LABEL: Record<BrokerRefusalReason, string> = {
  identity_mismatch: 'The caller is not the run it claims to be',
  run_not_live: 'That run is over',
  permission_denied: 'This worker was not granted that',
  not_brokered: 'Nothing is bound to that operation here',
  credential_unset: 'The credential is not set on this host',
  invalid_params: 'Those parameters do not fit the operation',
  simulation: 'A simulation reaches nothing real',
}

/**
 * How long ONE brokered operation may run in the daemon's process.
 *
 * Two minutes, not the ten `DEFAULT_COMMAND_TIMEOUT_MS` gives a setup command
 * (`apps/orchestrator/src/shell.ts:33`): a setup command runs once per worktree and a broker call
 * runs inside a worker's turn, with a vendor CLI holding its tool call open the whole time.
 */
export const BROKER_TIMEOUT_MS = 120_000

/**
 * How long the WORKER'S thin client waits for a reply.
 *
 * Strictly greater than {@link BROKER_TIMEOUT_MS}, and the test pins the inequality rather than the
 * gap: a client that gave up first would report "no answer" for an operation that had in fact run,
 * which is the one failure mode an audit trail cannot recover from.
 */
export const BROKER_CLIENT_TIMEOUT_MS = 150_000

/** How many `run.tool_denied` events naming ONE kind raise `permission_blocked` (M52 R5). Three,
 *  because one is a worker trying something, two is a worker retrying, and three is a wall. */
export const PERMISSION_TRIP_COUNT = 3

/** How far back the denial count looks. Half an hour: long enough to span a run, short enough that
 *  a wall somebody moved last week does not raise a situation today. */
export const PERMISSION_DENIAL_WINDOW_MS = 30 * 60_000
```

`packages/domain/src/broker/index.ts`:

```ts
export * from './operations.js'
```

`packages/domain/src/index.ts` gains two lines beside the existing barrels:

```ts
export * from './permission/index.js'
export * from './broker/index.js'
```

- [ ] **Step 12: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/broker packages/domain/test/permission`
Expected: PASS — 10 + 14 + 17 cases.

- [ ] **Step 13: Write the failing tests for the three events and their lanes**

Append to `packages/domain/test/events/schema.test.ts`:

```ts
describe('M52: the broker and the permission change (56th, 57th, 58th)', () => {
  it('parses broker.executed with the environment verbatim and the rest hashed', () => {
    const parsed = executionEventSchema.parse({
      type: 'broker.executed',
      seq: 1,
      ts: '2026-09-12T10:00:00.000Z',
      workspaceId: 'w',
      runId: 'r',
      slaveId: 's',
      actor: 'system',
      payload: {
        op: 'deploy_release',
        environment: 'staging',
        paramsHash: 'a'.repeat(64),
        exitCode: 0,
        durationMs: 1234,
      },
    })
    expect(parsed.type).toBe('broker.executed')
  })

  it('refuses a broker.executed payload carrying anything else -- the command, the output or a secret', () => {
    expect(() =>
      executionEventSchema.parse({
        type: 'broker.executed',
        seq: 1,
        ts: '2026-09-12T10:00:00.000Z',
        workspaceId: 'w',
        actor: 'system',
        payload: {
          op: 'deploy_release',
          environment: 'staging',
          paramsHash: 'a'.repeat(64),
          exitCode: 0,
          durationMs: 1,
          output: 'Deployed! token=hunter2',
        },
      }),
    ).toThrow()
  })

  it('parses broker.refused with one of the seven reasons', () => {
    for (const reason of BROKER_REFUSAL_REASONS) {
      const parsed = executionEventSchema.parse({
        type: 'broker.refused',
        seq: 1,
        ts: '2026-09-12T10:00:00.000Z',
        workspaceId: 'w',
        actor: 'system',
        payload: { op: 'deploy_release', reason },
      })
      expect(parsed.type).toBe('broker.refused')
    }
  })

  it('parses permission.changed with the from/to/by triple, either side nullable', () => {
    const parsed = executionEventSchema.parse({
      type: 'permission.changed',
      seq: 1,
      ts: '2026-09-12T10:00:00.000Z',
      workspaceId: 'w',
      slaveId: 's',
      actor: 'human',
      payload: {
        slaveId: 's',
        name: 'Alex',
        kind: 'network_fetch',
        kindLabel: 'Fetch over the network',
        from: null,
        to: 'allow',
        by: 'meren',
      },
    })
    expect(parsed.type).toBe('permission.changed')
  })

  it('parses a REVOKE -- `to: null` is "back to never asked", which is a real change', () => {
    const parsed = executionEventSchema.parse({
      type: 'permission.changed',
      seq: 1,
      ts: '2026-09-12T10:00:00.000Z',
      workspaceId: 'w',
      slaveId: 's',
      actor: 'human',
      payload: {
        slaveId: 's',
        name: 'Alex',
        kind: 'network_fetch',
        kindLabel: 'Fetch over the network',
        from: 'allow',
        to: null,
        by: 'meren',
      },
    })
    expect(parsed.type).toBe('permission.changed')
  })
})
```

And in `packages/domain/test/supervisor/timeline.test.ts`, move the count and add the three lanes:

```ts
  it('lanes every event type -- 58 as of M52', () => {
    expect(Object.keys(LANE_BY_TYPE)).toHaveLength(58)
  })

  it('puts both broker events and the permission change on the work lane', () => {
    expect(LANE_BY_TYPE['broker.executed']).toBe('work')
    expect(LANE_BY_TYPE['broker.refused']).toBe('work')
    expect(LANE_BY_TYPE['permission.changed']).toBe('work')
  })
```

- [ ] **Step 14: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/events packages/domain/test/supervisor/timeline.test.ts`
Expected: FAIL — the five new event cases throw on an unrecognised `type`, and the lane count reads 55.

- [ ] **Step 15: Write the three event arms and their lanes**

`packages/domain/src/events/schema.ts`, three arms appended to the union in the order they were introduced:

```ts
  z.object({
    ...envelope,
    type: z.literal('broker.executed'),
    /**
     * M52 R3: an operation the orchestrator ran on a worker's behalf, and how it ended.
     *
     * `.strict()`, and that is load-bearing rather than tidy -- the things that must NEVER reach
     * this row are the credential, the resolved command and the output, and a permissive object
     * would carry one of them the first time somebody added a debug field.
     *
     * `environment` is persisted VERBATIM where M51's `run.tool_call.argsHash` persists nothing:
     * the registry's own schemas make these parameters bounded, non-secret and the whole audit
     * value -- "which environment was deployed" is the question this row exists to answer months
     * later. `paramsHash` is `sha256(canonical(params))` over the FULL object, for correlating two
     * calls that asked for the same thing.
     */
    payload: z
      .object({
        op: z.string().min(1),
        environment: z.string().min(1).max(64),
        paramsHash: z.string().regex(/^[0-9a-f]{64}$/u),
        exitCode: z.number().int().nullable(),
        durationMs: z.number().int().nonnegative(),
      })
      .strict(),
  }),
  z.object({
    ...envelope,
    type: z.literal('broker.refused'),
    /** M52 R3. The reason is a `z.string()` and not a `z.enum`, for `guardrail.tripped`'s reason
     *  (M51 R4): `packages/events/src/read.ts:23-26` THROWS on a row the domain cannot parse, so a
     *  closed enum here would make the forward read of any database holding an eighth reason
     *  unreadable. The closed list types the WRITERS (`BROKER_REFUSAL_REASONS`). */
    payload: z.object({ op: z.string().min(1), reason: z.string().min(1).max(40) }).strict(),
  }),
  z.object({
    ...envelope,
    type: z.literal('permission.changed'),
    /**
     * M52 R5: a person granted, refused or revoked one operation for one worker.
     *
     * A new type rather than `org.changed { entity: 'permission' }`: `org.changed`'s `field` union
     * is spelled in four places (M50 erratum E11) and its payload has no room for the from/to/by
     * triple the Advanced surface has to print -- and a permission change is not a roster change.
     *
     * `from` and `to` are each `'allow' | 'deny' | null`, and `null` on `to` is a REVOKE: back to
     * "never asked", the state `setSlavePermission` could never reach because it had no delete.
     */
    payload: z
      .object({
        slaveId: z.string().min(1),
        name: z.string().min(1),
        kind: z.string().min(1),
        kindLabel: z.string().min(1),
        from: z.enum(['allow', 'deny']).nullable(),
        to: z.enum(['allow', 'deny']).nullable(),
        by: z.string().min(1).nullable(),
      })
      .strict(),
  }),
```

`packages/domain/src/supervisor/timeline.ts`, three entries in `LANE_BY_TYPE`:

```ts
  // M52 R3/R5: all three are WORK -- something the system did for a worker, or something a person
  // did to what a worker may do. Not `null` (invisible) and not a lane of their own: the
  // Supervisor's timeline is what a person reads to understand a project's week, and "the deploy
  // ran" and "somebody opened the network for this worker" both belong in it.
  'broker.executed': 'work',
  'broker.refused': 'work',
  'permission.changed': 'work',
```

- [ ] **Step 16: Run them and watch them pass**

Run: `npx vitest run packages/domain/test/events packages/domain/test/supervisor/timeline.test.ts`
Expected: PASS — five new event cases, and `LANE_BY_TYPE` at 58.

- [ ] **Step 17: Write the failing tests for the seventeenth situation and action**

Append to `packages/domain/test/supervisor/observe.test.ts`:

```ts
describe('permission_blocked (M52 R5)', () => {
  it('raises one situation per (worker, kind) once three denials of that kind are in the window', () => {
    const world = makeWorld({
      denials: [{ slaveId: 'slave-1', kind: 'network_fetch', count: 3, latestRunId: 'run-1' }],
      slaves: [makeSlave({ id: 'slave-1', name: 'Alex' })],
    })
    const situations = observe(world)
    const blocked = situations.filter((situation) => situation.kind === 'permission_blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.subjectId).toBe('slave-1')
    expect(blocked[0]?.facts).toEqual({
      slaveId: 'slave-1',
      kind: 'network_fetch',
      count: 3,
      runId: 'run-1',
    })
  })

  it('says what is blocked in WORDS, never the key', () => {
    const world = makeWorld({
      denials: [{ slaveId: 'slave-1', kind: 'network_fetch', count: 4, latestRunId: 'run-1' }],
      slaves: [makeSlave({ id: 'slave-1', name: 'Alex' })],
    })
    const situation = observe(world).find((entry) => entry.kind === 'permission_blocked')
    expect(situation?.summary).toContain('Fetch over the network')
    expect(situation?.summary).not.toContain('network_fetch')
  })

  it('does NOT raise below the trip count', () => {
    const world = makeWorld({
      denials: [{ slaveId: 'slave-1', kind: 'network_fetch', count: 2, latestRunId: 'run-1' }],
      slaves: [makeSlave({ id: 'slave-1', name: 'Alex' })],
    })
    expect(observe(world).some((entry) => entry.kind === 'permission_blocked')).toBe(false)
  })

  it('does NOT raise for a worker the world does not hold -- a released or deleted worker has no wall to move', () => {
    const world = makeWorld({
      denials: [{ slaveId: 'ghost', kind: 'network_fetch', count: 9, latestRunId: 'run-1' }],
      slaves: [],
    })
    expect(observe(world).some((entry) => entry.kind === 'permission_blocked')).toBe(false)
  })

  it('does NOT raise for `ungoverned_tool`, which is not a kind and which no grant can fix', () => {
    const world = makeWorld({
      denials: [{ slaveId: 'slave-1', kind: 'ungoverned_tool', count: 9, latestRunId: 'run-1' }],
      slaves: [makeSlave({ id: 'slave-1', name: 'Alex' })],
    })
    expect(observe(world).some((entry) => entry.kind === 'permission_blocked')).toBe(false)
  })

  it('raises one per kind when a worker is hitting two walls', () => {
    const world = makeWorld({
      denials: [
        { slaveId: 'slave-1', kind: 'network_fetch', count: 3, latestRunId: 'run-1' },
        { slaveId: 'slave-1', kind: 'write_repo', count: 5, latestRunId: 'run-1' },
      ],
      slaves: [makeSlave({ id: 'slave-1', name: 'Alex' })],
    })
    expect(observe(world).filter((entry) => entry.kind === 'permission_blocked')).toHaveLength(2)
  })
})
```

Append to `packages/domain/test/supervisor/candidates.test.ts`:

```ts
describe('permission_blocked candidates (M52 R5)', () => {
  const world = makeWorld({
    denials: [{ slaveId: 'slave-1', kind: 'network_fetch', count: 3, latestRunId: 'run-1' }],
    slaves: [makeSlave({ id: 'slave-1', name: 'Alex' })],
  })
  const situation = observe(world).find((entry) => entry.kind === 'permission_blocked')!

  it('offers request_permission and escalate_to_human, in that order', () => {
    const offers = candidates(situation, world)
    expect(offers.map((offer) => offer.action.kind)).toEqual(['request_permission', 'escalate_to_human'])
  })

  it('offers it as a PROPOSAL, never applied', () => {
    expect(candidates(situation, world)[0]?.tier).toBe('proposed')
  })

  it('carries the kind, its LABEL and the worker’s name, so the panel prints words', () => {
    const action = candidates(situation, world)[0]?.action
    expect(action).toEqual({
      kind: 'request_permission',
      slaveId: 'slave-1',
      name: 'Alex',
      permissionKind: 'network_fetch',
      kindLabel: 'Fetch over the network',
      why: permissionWhyFor('network_fetch', 3),
    })
  })

  it('builds `why` from a CONSTANT and the counted integer -- never a model’s words', () => {
    expect(permissionWhyFor('network_fetch', 3)).toBe(
      'Alex was refused 3 times: this worker has been refused ‘Fetch over the network’ 3 times and cannot get past it. Only a person can grant it.',
    )
  })
})
```

> **NOTE for the implementer:** the exact `permissionWhyFor` sentence above is a placeholder in ONE respect — it must not interpolate the worker's NAME, because `permissionWhyFor(kind, count)` takes two arguments and a name is not one of them. Write the constant as the second half only: `` `This worker has been refused ‘${PERMISSION_LABEL[kind]}’ ${count} times and cannot get past it. Only a person can grant it.` ``, and assert exactly that in the test. The name is already on the action as `name` and is the panel's to print.

Append to `packages/domain/test/supervisor/policy.test.ts`:

```ts
describe('tierOf(request_permission) (M52 R5)', () => {
  const action = {
    kind: 'request_permission',
    slaveId: 'slave-1',
    name: 'Alex',
    permissionKind: 'network_fetch',
    kindLabel: 'Fetch over the network',
    why: 'because',
  } as const

  it('is PROPOSED on a healthy project -- the Supervisor may request, never grant', () => {
    expect(tierOf(action, makeWorld({}), 'permission_blocked')).toBe('proposed')
  })

  it('is PROPOSED under a halt too, which is the same answer by two routes on purpose', () => {
    expect(tierOf(action, makeWorld({ halted: { reason: 'budget' } }), 'permission_blocked')).toBe('proposed')
  })

  it('is proposed whatever situation it is asked about -- there is no situation that makes a grant routine', () => {
    expect(tierOf(action, makeWorld({}), 'task_failed')).toBe('proposed')
  })
})

describe('assign_capability is still applied, and that is not a grant (M52 R5)', () => {
  it('stays applied for an idle worker: a capability says what a worker is FOR, not what it may do', () => {
    const action = {
      kind: 'assign_capability',
      slaveId: 'slave-1',
      capability: 'security.application',
      capabilityLabel: 'Application security',
      role: 'security',
    } as const
    expect(tierOf(action, makeWorld({ slaves: [makeSlave({ id: 'slave-1', busy: false })] }), 'capability_unstaffed'))
      .toBe('applied')
  })
})
```

And in `packages/domain/test/supervisor/labels.test.ts`, extend the two exhaustiveness cases so the new situation and action carry words (`SITUATION_LABEL.permission_blocked === 'Blocked by a permission'`, and the panel's action text).

- [ ] **Step 18: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/supervisor`
Expected: FAIL — `makeWorld` rejects `denials`, `observe` produces no `permission_blocked`, `candidates` has no arm, `tierOf` does not compile against the new action.

- [ ] **Step 19: Write the situation, the action, the tier, the predicate, the arm and the world field**

`packages/domain/src/supervisor/situations.ts` — the member goes directly after `run_looping` and before `ready_unstaffed`, and the count in the `SITUATION_LABEL` docstring moves to eighteenth:

```ts
  /**
   * M52 R5: a worker keeps meeting the same WALL. `PERMISSION_TRIP_COUNT` or more `run.tool_denied`
   * events naming one kind, inside `PERMISSION_DENIAL_WINDOW_MS`. `subjectId` is the SLAVE id --
   * one situation per worker per kind, however many runs the denials came from, because what a
   * person is being asked about is this worker and this operation.
   *
   * Directly after `run_looping` (plan decision D6): both are about a run that is spending and
   * getting nowhere, and a reader meets "going in circles" and then "blocked by a wall nobody can
   * move but you" in one pass. The Supervisor may only ever REQUEST the grant (`tierOf` returns
   * `proposed` unconditionally), which is what lets an action about permissions exist at all beside
   * `critical.ts:33-34`'s refusal to let the Supervisor ANSWER about them: this action writes no
   * prose, and its `why` is a constant.
   */
  'permission_blocked',
```

`packages/domain/src/supervisor/situations.ts`'s `SITUATION_LABEL` gains `permission_blocked: 'Blocked by a permission'`.

`packages/domain/src/supervisor/actions.ts` — the seventeenth member, after `steer_run`:

```ts
  /**
   * M52 R5: ask a PERSON to grant one operation to one worker. Never grants it.
   *
   * `permissionKind` rather than `kind`, because `Action`'s own discriminator is already called
   * `kind` and a second one on the same object would read as the action's type. `kindLabel` rides
   * along for `assign_capability`'s reason: the Supervisor panel is a client component and must be
   * able to print a word without importing the domain's label table through control's barrel.
   *
   * `why` is `permissionWhyFor(permissionKind, count)` -- a fixed sentence from a constant with one
   * integer interpolated, from a source file no model has seen and no prompt can reach.
   */
  | {
      readonly kind: 'request_permission'
      readonly slaveId: string
      readonly name: string
      readonly permissionKind: string
      readonly kindLabel: string
      readonly why: string
    }
```

with the matching `actionSchema` arm:

```ts
  z.object({
    kind: z.literal('request_permission'),
    slaveId: z.string().min(1),
    name: z.string().min(1),
    permissionKind: z.string().min(1),
    kindLabel: z.string().min(1),
    why: z.string().min(1).max(1000),
  }),
```

`packages/domain/src/supervisor/policy.ts` — the arm joins the `proposed` group, with the comment that says why the halt short-circuit above it is redundant here on purpose:

```ts
    // M52 R5: ALWAYS a proposal, beside `hire_from_catalog` -- and the halt short-circuit above is
    // redundant for it deliberately, the `cancel_task` precedent (:103-106). A permission is a
    // person's decision in every weather: "the Supervisor may point at a wall; only a person moves
    // it" is the whole ruling, and a tier that could ever be `applied` would make it a wall the
    // Supervisor moves on a quiet afternoon. Nothing about `assign_capability` being `applied`
    // above contradicts this: giving a worker a capability changes what it is DISPATCHED for and
    // changes nothing about what the gate lets it do -- that worker meets the same default-deny
    // wall as every other.
    case 'request_permission':
      return 'proposed'
```

`packages/domain/src/supervisor/world.ts`:

```ts
/**
 * One wall a worker keeps meeting (M52 R5, plan erratum E9).
 *
 * Loaded by `packages/control/src/supervisorWorld.ts` from ONE grouped read of `run.tool_denied`
 * over `PERMISSION_DENIAL_WINDOW_MS`, the way `loadLatestGuardrails` reads the newest guardrail per
 * task -- the world holds no events, and a predicate that counted them itself would be the
 * Supervisor reading the log.
 *
 * `kind` is a `PermissionKind` in every row the current gate writes, but is typed `string` because
 * the payload's own field is: a database holding pre-M52 rows carries `'run tests'`, and a denial
 * of `ungoverned_tool` carries a reason no grant can fix. `observe` filters both out.
 */
export interface SupervisorDenial {
  readonly slaveId: string
  readonly kind: string
  readonly count: number
  readonly latestRunId: string | null
}
```

and on `SupervisorWorld`:

```ts
  /** M52 R5: how often each worker has been refused each operation lately. EMPTY unless some run
   *  has been denied in the window -- the loader does not pay for a grouped event scan on a project
   *  where nothing has been refused. */
  readonly denials: readonly SupervisorDenial[]
```

`packages/domain/src/supervisor/observe.ts` — the predicate, placed directly after the `run_looping` loop:

```ts
  // permission_blocked (M52 R5): a worker that keeps meeting the same wall. Four clauses, each one
  // a way of being wrong about it:
  //   - the kind is one of the six. A pre-M52 row spells `'run tests'` and a denial of an
  //     ungoverned tool spells `ungoverned_tool`; neither names something a person can grant, and
  //     proposing a grant for either would put an unactionable row in front of somebody.
  //   - the count has reached PERMISSION_TRIP_COUNT. One refusal is a worker trying something.
  //   - the worker is IN THE WORLD. A released or deleted worker has no wall to move, and
  //     `applyDecision` would refuse `slave_not_found` on the proposal a person approved.
  //   - the worker is not released. A released worker's grants are not the reason it is idle.
  for (const denial of world.denials) {
    if (!(PERMISSION_KINDS as readonly string[]).includes(denial.kind)) continue
    if (denial.count < PERMISSION_TRIP_COUNT) continue
    const slave = world.slaves.find((candidate) => candidate.id === denial.slaveId)
    if (slave === undefined || slave.released) continue
    add({
      kind: 'permission_blocked',
      subjectId: denial.slaveId,
      summary:
        `${slave.name} has been refused ‘${PERMISSION_LABEL[denial.kind as PermissionKind]}’ ` +
        `${String(denial.count)} times and cannot get past it.`,
      facts: {
        slaveId: denial.slaveId,
        kind: denial.kind,
        count: denial.count,
        runId: denial.latestRunId,
      },
    })
  }
```

> The situation KEY is `(kind, subjectId)` and `subjectId` is the slave id, so two kinds blocked on one worker produce two situations with the SAME key — which `filterFresh` would collapse and the `@@unique` on `SupervisorDecision`'s key would fight. Make `subjectId` `` `${denial.slaveId}:${denial.kind}` `` and say so in the member's docstring: the subject is "this worker's wall", the way `capability_unstaffed`'s subject is a capability key rather than a task. Adjust Step 17's first case to expect that compound id, and keep `facts.slaveId` as the bare id so `carryOut` never has to parse the subject.

`packages/domain/src/supervisor/candidates.ts` — the arm, plus the constant:

```ts
/**
 * Why a permission is being asked for, as a FIXED sentence (M52 R5).
 *
 * Never a model's words, and this is the ruling that lets the action exist at all:
 * `packages/domain/src/supervisor/critical.ts:33-34` forbids the Supervisor ANSWERING about
 * permissions and credentials in prose, and the distinction that holds is between prose and a
 * proposal. This function writes no prose -- it interpolates one label and one integer into a
 * constant, and everything else a person needs is the row itself.
 */
export function permissionWhyFor(kind: PermissionKind, count: number): string {
  return (
    `This worker has been refused ‘${PERMISSION_LABEL[kind]}’ ${String(count)} times ` +
    'and cannot get past it. Only a person can grant it.'
  )
}
```

```ts
    case 'permission_blocked': {
      const slaveId = String(situation.facts['slaveId'] ?? '')
      const kind = String(situation.facts['kind'] ?? '') as PermissionKind
      const count = Number(situation.facts['count'] ?? 0)
      const slave = world.slaves.find((candidate) => candidate.id === slaveId)
      if (slave === undefined) return [noAction(world, situation)]
      return [
        offer(
          {
            kind: 'request_permission',
            slaveId,
            name: slave.name,
            permissionKind: kind,
            kindLabel: PERMISSION_LABEL[kind],
            why: permissionWhyFor(kind, count),
          },
          world,
          situation,
          `${slave.name} cannot get past this without it.`,
        ),
        escalate(world, situation, `${slave.name} is blocked by a permission.`),
      ]
    }
```

> `offer`/`escalate`/`noAction` are this file's own helpers — read the `run_looping` arm directly above and mirror its exact call shape rather than the sketch here; the point of the sketch is the ORDER (request first, escalation second) and the fields, both of which Step 17 asserts.

- [ ] **Step 20: Run them and watch them pass**

Run: `npx vitest run packages/domain`
Expected: PASS — the whole domain package, including the six new `observe` cases, four `candidates` cases, four `policy` cases and the extended label tables.

- [ ] **Step 21: Write the failing enum-parity assertions**

Append to `packages/db/test/integration/enum-parity.test.ts`:

```ts
  // M52 R1/R3: the two new Postgres enums, held to the domain's lists for `SupervisorSituationKind`'s
  // reason -- nothing in TypeScript ties a Prisma enum to the union it mirrors, and a seventh
  // permission kind that reached the union and not the enum compiles clean and fails at the first
  // `setSlavePermission`, in production, on a worker somebody was trying to unblock.
  it('PermissionKind matches PERMISSION_KINDS, member for member', async () => {
    expect(await enumValues('PermissionKind')).toEqual([...PERMISSION_KINDS].sort())
  })

  it('CredentialKind is the three the operator can name', async () => {
    expect(await enumValues('CredentialKind')).toEqual(['api_key', 'deploy_token', 'git_token'])
  })

  it('ProviderKind matches the domain’s PERMISSION_PROVIDERS, so the permission tables key on the same two', async () => {
    expect(await enumValues('ProviderKind')).toEqual([...PERMISSION_PROVIDERS].sort())
  })
```

- [ ] **Step 22: Run them and watch them fail**

Run: `npx vitest run packages/db/test/integration/enum-parity.test.ts`
Expected: FAIL — `type "PermissionKind" does not exist`.

- [ ] **Step 23: Write the schema**

`packages/db/prisma/schema.prisma`, five edits:

```prisma
/// M52 R1: what a worker may DO, as a closed enum where a bare `String` was. The TypeScript twin is
/// `PERMISSION_KINDS` (`packages/domain/src/permission/kinds.ts`) and `enum-parity.test.ts` proves
/// the two are the same list. A permission is an OPERATION and never an M47 capability: `Capability`
/// says what a worker is FOR, this says what any worker MAY DO, and the UI prints two words.
enum PermissionKind {
  read_repo
  write_repo
  run_commands
  network_fetch
  read_secret
  deploy_release
}

/// M52 R3: what KIND of secret a `Credential` names. Never what it IS -- the value is not in this
/// database and not in any event; the orchestrator reads `process.env[envVar]` at execution time
/// and nothing else ever holds it.
enum CredentialKind {
  deploy_token
  git_token
  api_key
}
```

```prisma
model SlavePermission {
  id      String         @id @default(uuid())
  slaveId String
  /// M52 R1: the OPERATION this row decides, replacing the free-text `tool` column whose six prose
  /// values collapsed three ways onto `Bash` and one onto nothing at all.
  kind    PermissionKind
  /// `allow` is a grant, `deny` is a person's explicit refusal, and the ABSENCE of a row is "never
  /// asked" -- three states, which are exactly the ✓/✕/– the matrix has always drawn. From M52 all
  /// three DENY at the gate unless the run kind's baseline says otherwise, so `allow` finally means
  /// something `deny`'s absence did not.
  mode    PermissionMode
  /// M52 R5: WHO decided. Null for a row written before this milestone, and for one written by a
  /// path that had no principal -- the CLI and the daemon have none (`Principal` is the human).
  grantedBy String?
  grantedAt DateTime @default(now())

  slave Slave @relation(fields: [slaveId], references: [id], onDelete: Cascade)

  @@unique([slaveId, kind])
}
```

```prisma
/// M52 R3: a secret this installation can use, by NAME. The value is never here.
///
/// Workspace-scoped, which is also the simulation boundary doing its job for free: a `SimulationRun`
/// binds to the CATALOG company and never to a workspace (:1380-1381), so no simulation row can name
/// one of these.
model Credential {
  id          String         @id @default(uuid())
  workspaceId String
  name        String
  kind        CredentialKind
  /// The environment variable the ORCHESTRATOR reads at execution time. A name, checked for shape,
  /// never a value: nothing in this system stores, logs or prints a secret.
  envVar      String
  createdAt   DateTime       @default(now())

  workspace Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  bindings  BrokerBinding[]

  @@unique([workspaceId, name])
}

/// M52 R3: what one brokered operation actually RUNS here, and with which credential.
///
/// A table rather than `Workspace.brokerCommands Json`: `verifyCommands`/`setupCommands` are
/// `String[]` on the workspace and a Json blob would be the first untyped command carrier in this
/// schema, and a binding needs a real foreign key to `Credential`. `command` is ARGV, never a shell
/// string -- the parameters a worker supplies never enter it (they ride in the child's environment),
/// and argv is what makes that a property of the shape rather than of a quoting rule.
model BrokerBinding {
  id           String   @id @default(uuid())
  workspaceId  String
  /// One of `BROKERED_OPERATIONS`' keys. A `String` and not an enum: the registry is a static
  /// manifest in TypeScript, and an op this version does not know is refused `not_brokered` rather
  /// than making the row unreadable.
  op           String
  command      String[]
  credentialId String?
  createdAt    DateTime @default(now())

  workspace  Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  credential Credential? @relation(fields: [credentialId], references: [id])

  @@unique([workspaceId, op])
}
```

`Workspace` gains the two back-relations (`credentials Credential[]`, `brokerBindings BrokerBinding[]`) beside `memories`.

`SlaveRun` gains one column, beside `provider`:

```prisma
  /// M52 R4: `sha256` hex of the 32 random bytes this run was issued at spawn, ROTATED on every
  /// resume. The plaintext exists only in the child's environment (`SLAVEOFAI_RUN_TOKEN`) and is
  /// written nowhere -- not here, not in `Checkpoint`, not in a file, because a token file inside
  /// the run directory would be readable by every sibling run under the same uid, which is the hole
  /// this column exists to close. `@unique` so two runs cannot share an identity even by accident.
  /// Null for every run recorded before M52, and for any spawn that supplied none -- such a run
  /// meets a `permissions.json` whose `tokenHash` it cannot match and is refused every tool call,
  /// which is the correct failure for an unidentifiable worker.
  runTokenHash      String?       @unique
```

`EventType` gains three members at the foot, and `SupervisorSituationKind` gains `permission_blocked` beside `run_looping`.

- [ ] **Step 24: Write the migration, apply it to BOTH databases, and prove the diff**

`packages/db/prisma/migrations/20260912180000_m52_broker/migration.sql`:

```sql
-- M52: permissions become OPERATIONS, a credential becomes an object, and a run gets an identity.
--
-- This is the one milestone in this directory with a destructive data statement, and every clause of
-- it is deliberate. `SlavePermission.tool` is a bare `String` with no check constraint, so the
-- database accepts anything and the six prose values were only ever a TypeScript list. The mapping
-- below is total over those six; everything else is DELETED rather than kept under an `other` kind,
-- because the column is now a closed enum, because under default-deny a dropped row DENIES (the safe
-- direction), and because an `other` kind would invent a grant nobody can name.
--
-- `run tests` and `create branch` both map to `run_commands`, so a worker holding both collapses to
-- one row: DENY WINS, and the redundant row is deleted. That is the only lossy step, it is lossy in
-- the safe direction, and the NOTICE says how many rows it touched.

CREATE TYPE "PermissionKind" AS ENUM ('read_repo', 'write_repo', 'run_commands', 'network_fetch', 'read_secret', 'deploy_release');
CREATE TYPE "CredentialKind" AS ENUM ('deploy_token', 'git_token', 'api_key');

-- 1. The new column, nullable for the length of the data statement below.
ALTER TABLE "SlavePermission" ADD COLUMN "kind" "PermissionKind";
ALTER TABLE "SlavePermission" ADD COLUMN "grantedBy" TEXT;
ALTER TABLE "SlavePermission" ADD COLUMN "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 2. The deterministic mapping, and the NOTICE that says what it did.
DO $$
DECLARE
  mapped   INTEGER;
  collided INTEGER;
  dropped  INTEGER;
BEGIN
  UPDATE "SlavePermission" SET "kind" = CASE "tool"
    WHEN 'repo read'     THEN 'read_repo'::"PermissionKind"
    WHEN 'source write'  THEN 'write_repo'::"PermissionKind"
    WHEN 'run tests'     THEN 'run_commands'::"PermissionKind"
    WHEN 'create branch' THEN 'run_commands'::"PermissionKind"
    WHEN 'deploy prod'   THEN 'deploy_release'::"PermissionKind"
    WHEN 'read secrets'  THEN 'read_secret'::"PermissionKind"
    ELSE NULL
  END;
  GET DIAGNOSTICS mapped = ROW_COUNT;

  -- `run tests` and `create branch` collapse onto one kind. Keep the DENY where a worker holds both
  -- with different modes, and the lower id where they agree, so the result is deterministic.
  WITH ranked AS (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "slaveId", "kind"
             ORDER BY CASE WHEN "mode" = 'deny' THEN 0 ELSE 1 END, "id"
           ) AS rank
    FROM "SlavePermission"
    WHERE "kind" IS NOT NULL
  )
  DELETE FROM "SlavePermission" WHERE "id" IN (SELECT "id" FROM ranked WHERE rank > 1);
  GET DIAGNOSTICS collided = ROW_COUNT;

  DELETE FROM "SlavePermission" WHERE "kind" IS NULL;
  GET DIAGNOSTICS dropped = ROW_COUNT;

  RAISE NOTICE 'm52: mapped % permission rows, dropped % collapsed duplicates, dropped % unmapped permission rows', mapped, collided, dropped;
END $$;

-- 3. The swap.
ALTER TABLE "SlavePermission" ALTER COLUMN "kind" SET NOT NULL;
DROP INDEX IF EXISTS "SlavePermission_slaveId_tool_key";
ALTER TABLE "SlavePermission" DROP COLUMN "tool";
CREATE UNIQUE INDEX "SlavePermission_slaveId_kind_key" ON "SlavePermission"("slaveId", "kind");

-- 4. The credential and the binding.
CREATE TABLE "Credential" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "kind"        "CredentialKind" NOT NULL,
  "envVar"      TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Credential_workspaceId_name_key" ON "Credential"("workspaceId", "name");
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BrokerBinding" (
  "id"           TEXT NOT NULL,
  "workspaceId"  TEXT NOT NULL,
  "op"           TEXT NOT NULL,
  "command"      TEXT[],
  "credentialId" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrokerBinding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BrokerBinding_workspaceId_op_key" ON "BrokerBinding"("workspaceId", "op");
ALTER TABLE "BrokerBinding" ADD CONSTRAINT "BrokerBinding_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrokerBinding" ADD CONSTRAINT "BrokerBinding_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. The run's identity.
ALTER TABLE "SlaveRun" ADD COLUMN "runTokenHash" TEXT;
CREATE UNIQUE INDEX "SlaveRun_runTokenHash_key" ON "SlaveRun"("runTokenHash");

-- `IF NOT EXISTS`, and each on its own statement: Postgres refuses `ALTER TYPE ... ADD VALUE` inside
-- a transaction block that then uses the new value, and Prisma runs a migration file as one
-- transaction -- the idiom every earlier migration in this directory uses for the same reason.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'broker.executed';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'broker.refused';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'permission.changed';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'permission_blocked';
```

Then, in this order:

```bash
npm run db:migrate
npm run db:migrate:test
npm run db:generate
npx tsc --build
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```

Expected: both migrations apply (the dev database prints the `NOTICE` — paste it into the task report verbatim, including the three counts), and the diff prints **"No difference detected"**. If it does not, the schema and the SQL disagree; fix the SQL, never the schema, and never by hand-editing the database.

- [ ] **Step 25: Run the parity tests and watch them pass**

Run: `npx vitest run packages/db`
Expected: PASS — including the three new enum assertions and the unchanged `EventType` assertion, now at 58 members.

- [ ] **Step 26: Make the readers of the old column compile, without inverting anything**

Three files read `SlavePermission.tool` and must read `kind` instead. **Nothing about the gate's ANSWER changes in this task** — that is Task 2's whole content — so this is a like-for-like rename through the new table.

`packages/control/src/permission.ts`: delete `PERMISSION_TOOLS`, `PermissionTool`, `isPermissionTool` and `CAPABILITY_TOOLS`; keep `resolveDenyList` with its body re-pointed at the domain's table and a docstring saying it is Task 2's to delete:

```ts
import { PERMISSION_KINDS, TOOLS_BY_KIND, type PermissionKind, type PermissionProvider } from '@slave-of-ai/domain'

/**
 * M18's denylist, re-pointed at M52's vocabulary and NOTHING ELSE.
 *
 * TEMPORARY, and deleted by Task 2. The column swap and the inversion are two changes and this is
 * the seam between them: after this task a denied `run_commands` row denies `Bash` exactly as a
 * denied `run tests` row did, through a new column, in the new vocabulary, with the gate's answer
 * untouched. Task 2 replaces this function and the file it writes with `resolveGrants` and
 * `permissions.json` v2, and the library that reads it, in one commit.
 */
export function resolveDenyList(
  rows: readonly { readonly kind: string; readonly mode: 'allow' | 'deny' }[],
  provider: PermissionProvider,
): readonly { readonly tool: string; readonly capability: string }[] {
  const byTool = new Map<string, string>()
  for (const row of rows) {
    if (row.mode !== 'deny') continue
    if (!(PERMISSION_KINDS as readonly string[]).includes(row.kind)) continue
    for (const tool of TOOLS_BY_KIND[row.kind as PermissionKind][provider]) {
      if (!byTool.has(tool)) byTool.set(tool, row.kind)
    }
  }
  return [...byTool.entries()].map(([tool, capability]) => ({ tool, capability }))
}
```

and `setSlavePermission` validates against the kinds (E11 keeps the refusal's NAME):

```ts
export async function setSlavePermission(
  slaveId: string,
  kind: string,
  mode: 'allow' | 'deny',
): Promise<Result<void, ControlRefusal>> {
  if (!(PERMISSION_KINDS as readonly string[]).includes(kind)) return err({ kind: 'invalid_tool', tool: kind })
  if (mode !== 'allow' && mode !== 'deny') return err({ kind: 'invalid_permission_mode', mode: String(mode) })
  const slave = await prisma.slave.findUnique({ where: { id: slaveId }, select: { id: true } })
  if (slave === null) return err({ kind: 'slave_not_found', slaveId })
  await prisma.slavePermission.upsert({
    where: { slaveId_kind: { slaveId, kind: kind as PermissionKind } },
    update: { mode },
    create: { slaveId, kind: kind as PermissionKind, mode },
  })
  return ok(undefined)
}
```

`packages/control/src/refusal.ts:502`'s text for `invalid_tool` becomes `a permission must name one of the six operations`.

`apps/web/src/server/settings.ts`: `PERMISSION_TOOLS` is gone, so `buildPermissionMatrix` imports `PERMISSION_KINDS` from `@slave-of-ai/domain` and keys the map on `row.kind`. **The cells keep their `tool` FIELD NAME for exactly one task** (the component reads `cell.tool`) and carry the kind string in it; Task 5 renames the field and the column headers together with the copy. Say so in a comment.

`apps/orchestrator/src/{tick,planning,review,resume}.ts`: no change at all — they pass `slave.permissions` straight into `resolveDenyList`, and the row type changed underneath them.

- [ ] **Step 27: Move the two tests the column swap breaks, and the one gate line**

`packages/control/test/permission-mapping.test.ts` — the `EXPECTED` table becomes the kinds table and the cases keep their names. Six of its eight cases move mechanically; two say something new:

```ts
const EXPECTED: Record<PermissionKind, { claude_code: readonly string[]; cursor: readonly string[] }> = {
  read_repo: { claude_code: ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'Task', 'Skill'], cursor: ['read'] },
  write_repo: { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
  run_commands: { claude_code: ['Bash', 'BashOutput', 'KillShell'], cursor: ['shell'] },
  network_fetch: { claude_code: ['WebFetch', 'WebSearch'], cursor: [] },
  read_secret: { claude_code: [], cursor: [] },
  deploy_release: { claude_code: [], cursor: [] },
}
```

```ts
  it('a deny on run_commands denies the whole shell, and deploy_release is no longer part of it', () => {
    // M52 R1: the three shell-backed rows collapsed onto `Bash` and could not be told apart. There
    // is one shell row now, and `deploy_release` is a BROKER grant that names no tool -- which is
    // exactly why `deploy prod` could never be expressed as a tool deny.
    expect(resolveDenyList([{ kind: 'run_commands', mode: 'deny' }], 'claude_code')).toEqual([
      { tool: 'Bash', capability: 'run_commands' },
      { tool: 'BashOutput', capability: 'run_commands' },
      { tool: 'KillShell', capability: 'run_commands' },
    ])
    expect(resolveDenyList([{ kind: 'deploy_release', mode: 'deny' }], 'claude_code')).toEqual([])
  })
```

The byte-equal shell-prefix pin at `:87-90` is untouched and must stay green.

`packages/control/test/integration/permission.test.ts` — `PERMISSION_TOOLS` is gone, so the first case becomes the kinds list, the refusal case offers `'rm -rf'` and expects the new sentence, and the flip case writes `'read_repo'`.

`scripts/gate-m18-skill-and-teeth.mjs:503-517` — **the one gate line this task moves**, because this task's own migration drops the column it writes:

```js
  // M52 R1: `run tests` is `run_commands`, and it still resolves to `Bash` for claude_code
  // (`TOOLS_BY_KIND`, `packages/domain/src/permission/kinds.ts`) -- the same tool the fixture's
  // canned `hook_response` reason names. The payload assertion below still reads `'run tests'`
  // because the replayed RECORDING still says so; M52 Task 6 redacts the fixture and moves that
  // assertion in the same commit.
  await prisma.slavePermission.create({ data: { slaveId, kind: 'run_commands', mode: 'deny' } })
```

- [ ] **Step 28: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — ≥ 316 files / ≥ 4930 tests, and no test still naming `repo read`, `source write`, `run tests` as a permission. Check that last with `grep -rn "'repo read'\|'source write'\|'read secrets'\|'create branch'\|'deploy prod'" packages apps scripts --include=*.ts --include=*.tsx --include=*.mjs | grep -v node_modules | grep -v dist` and report every remaining hit with the reason it is legitimate (the m19/m21/m26 spec and plan documents under `docs/` are history and are not edited).

- [ ] **Step 29: Ladder and commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
npx vitest run
```

Then, with no vitest running and no `next dev` up:

```bash
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m18-skill-and-teeth
```

Expected: GREEN. This is the gate this task's migration could have broken and the one it moved a line in; it must pass here, with the payload still reading `{tool:'Bash', capability:'run tests'}` from the unredacted recording.

```bash
git add packages/domain packages/db packages/control apps/web/src/server/settings.ts scripts/gate-m18-skill-and-teeth.mjs
git commit -m "$(cat <<'EOF'
feat(domain,db): m52 t1 — a permission is an operation, and a run can be asked who it is

Six prose rows become six OPERATIONS with a closed enum behind them: the three that all denied
`Bash` are one row now, and the one that enforced nothing is a broker grant that names no tool on
purpose -- which is why `deploy prod` could never be written as a tool deny. `TOOLS_BY_KIND` is the
inverted `CAPABILITY_TOOLS`, naming the whole governed toolbox rather than the parts a deny should
block, and `TOOL_VOCABULARY` is derived from it so a vendor tool nobody mapped is a red test rather
than a silent wall. `BASELINE_GRANTS` is computed per run kind and stored nowhere: six seeded rows
per worker would have been a new unique index colliding with five web fixtures, and a baseline that
is a projection cannot disagree with the gate. `Credential` holds a name and an environment
variable and never a value; `BrokerBinding` holds argv and never a shell string; `SlaveRun` gains a
unique hash whose plaintext is written nowhere at all. The migration maps every one of the six old
values, lets DENY win the one collision, and deletes what it cannot name -- under default-deny a
dropped row denies, which is the safe direction, and the NOTICE says how many there were.

Nothing is inverted yet. A denied `run_commands` row denies `Bash` today exactly as a denied
`run tests` row did yesterday: a migration that rewrites a permission table and a gate that reverses
its answer are two things a reviewer should be able to read one at a time.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 2: The inversion — `permissions.json` v2, an allow list the hook reads, an identity it checks, and a child environment nobody inherits (R2, R3, R4, E1, E3, E6, E7, E8, D8–D15)

The milestone's centre, and one commit on purpose: the file's shape, the library that reads it, the token that binds them and the environment the child is given are four halves of one contract, and landing any of them alone leaves a tree whose gate and whose writer disagree. After this task an ungranted tool is refused, a forged identity is refused, a deleted verdict STOPS the run instead of freeing it, `DATABASE_URL` is not in a worker's environment, and `.slaveofai/runs/` is no longer inside the repository the worker edits.

**Files:**
- Create: nothing.
- Modify: `scripts/lib/permissions.sh`, `scripts/pause-gate.sh`, `packages/providers/src/runtime/process.ts`, `packages/providers/src/runtime/gate-preflight.ts`, `packages/providers/src/claude/adapter.ts`, `packages/providers/src/cursor/adapter.ts`, `packages/providers/src/index.ts`, `packages/control/src/permission.ts`, `packages/control/src/paths.ts`, `apps/orchestrator/src/{tick,planning,review,resume}.ts`
- Test: `packages/providers/test/{permissions-lib,pause-gate,cursor-shell-gate,runtime-process,adapter-start,adapter-resume,run-preparation}.test.ts`, `packages/control/test/paths.test.ts`, `packages/control/test/permission-mapping.test.ts`, `apps/orchestrator/test/integration/tick.test.ts`

**Interfaces:**
- Consumes: `resolveGrants`, `TOOL_VOCABULARY`, `ENFORCE_BY_PROVIDER`, `PERMISSION_LABEL` (Task 1's domain module); `permissionsFilePathFor`, `runShellCommand`'s package only as a neighbour.
- Produces, for Tasks 3–6:
  - `permissions.json` **v2**: `{ "version": 2, "runId", "tokenHash", "enforce", "allow": [{tool,kind}], "vocabulary": {tool:kind} }`, mode 0600
  - `read_permission_verdict`'s inverted contract: return 0 = DENY (`PERMISSION_DENY_TOOL`, `PERMISSION_DENY_CAPABILITY`), return 1 = ALLOW, exit 2 = FAIL CLOSED
  - `CHILD_ENV_ALLOW: readonly string[]`, `buildChildEnv`'s five `SLAVEOFAI_*` channels
  - `brokerChannelPathFor(runDir)`, `brokerReplyPathFor(runDir, requestId)`, `runTokenHash(token)`
  - `StartRunInput.runToken?`, `resume(runId, checkpoint, queuedInstruction, runToken?)`, `ClaudeCodeAdapterOptions.brokerCliPath?`, `CursorAdapterOptions.brokerCliPath?`
  - `runFilePaths`' relocated `runDir` under `SLAVEOFAI_STATE_DIR ?? XDG_STATE_HOME ?? ~/.local/state`
  - `writePermissionsFile(runDir, input): string` taking `{ rows, provider, runKind, runId, runToken }`

- [ ] **Step 1: Write the failing tests for the inverted library**

`packages/providers/test/permissions-lib.test.ts`. The driver keeps its shape; two things are added to it — a `TEST_RUN_TOKEN` passthrough and a v2 file builder — and then **every one of the eleven ALLOW-by-absence cases becomes a DENY case with the SAME NAME**, so a reviewer reading the diff sees the inversion rather than a new file.

```ts
const DRIVER_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
PAUSE_GATE_NAME='test-gate'
. "$PERMISSIONS_LIB_PATH"
payload=$(cat)
read_permission_verdict "$payload" "\${TEST_DEFAULT_TOOL:-}"
status=$?
printf 'STATUS=%s\\n' "$status"
printf 'TOOL=%s\\n' "$PERMISSION_DENY_TOOL"
printf 'CAPABILITY=%s\\n' "$PERMISSION_DENY_CAPABILITY"
`

const TOKEN = 'f'.repeat(64)
// The library hashes SLAVEOFAI_RUN_TOKEN and compares it to the file's `tokenHash`; this is the
// same sha256 the orchestrator computes, spelled here so the fixture is readable rather than
// derived from the code under test.
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

function v2(input: {
  allow?: readonly { readonly tool: string; readonly kind: string }[]
  vocabulary?: Readonly<Record<string, string>>
  enforce?: 'all-tools' | 'known-tools'
  tokenHash?: string
}): string {
  return JSON.stringify({
    version: 2,
    runId: 'run-1',
    tokenHash: input.tokenHash ?? TOKEN_HASH,
    enforce: input.enforce ?? 'all-tools',
    allow: input.allow ?? [{ tool: 'Read', kind: 'read_repo' }],
    vocabulary: input.vocabulary ?? { Read: 'read_repo', Bash: 'run_commands', WebFetch: 'network_fetch' },
  })
}
```

`runVerdict` gains a fourth parameter `runToken?: string`, defaulting to `TOKEN`, and sets or deletes `SLAVEOFAI_RUN_TOKEN` on the child exactly as it already sets or deletes `SLAVEOFAI_PERMISSIONS_FILE`.

The cases:

```ts
describe('scripts/lib/permissions.sh: read_permission_verdict (M52 R2: default-DENY)', () => {
  it('allows a tool that is ON the allow list', async () => {
    const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
    expect(result.tool).toBe('')
  })

  // MOVED, same name: this case used to assert ALLOW. A governed tool that is not granted is now
  // the ordinary denial, and it names the KIND that governs it -- which is why the file carries a
  // vocabulary and not only an allow list (an allow list alone cannot say why).
  it('denies and reports the matched tool + capability when the deny list has a hit', async () => {
    const result = await runVerdict('{"tool_name":"Bash"}', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.tool).toBe('Bash')
    expect(result.capability).toBe('run_commands')
  })

  // MOVED, same name.
  it('allows when the payload tool is present but not on the deny list', async () => {
    const result = await runVerdict('{"tool_name":"Sandbox"}', writePermissionsFile(v2({})))
    expect(result.status).toBe(0)
    expect(result.tool).toBe('Sandbox')
    expect(result.capability).toBe('ungoverned_tool')
  })

  // MOVED, same name (plan erratum E8): a PreToolUse payload this gate cannot read is a refused
  // CALL, not a broken gate, so it denies at exit 0 and the run survives.
  it('allows when the payload has no tool_name key at all', async () => {
    const result = await runVerdict('{"hook_event_name":"SessionStart"}', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.tool).toBe('unknown')
    expect(result.capability).toBe('ungoverned_tool')
  })

  // MOVED, same name. `JSON.parse("null")` succeeds and names no tool; under an allow list that is
  // a call nobody can authorise.
  it('allows a payload that parses to a bare null', async () => {
    const result = await runVerdict('null', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.capability).toBe('ungoverned_tool')
  })

  it('allows a payload that parses to a non-object', async () => {
    for (const payload of ['[1]', '7', '"x"']) {
      const result = await runVerdict(payload, writePermissionsFile(v2({})))
      expect(result.status, payload).toBe(0)
    }
  })

  // MOVED, same name: an empty allow list is a run granted nothing, which is a real state and not
  // an unarmed gate.
  it('allows when the deny list is empty', async () => {
    const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({ allow: [] })))
    expect(result.status).toBe(0)
    expect(result.capability).toBe('read_repo')
  })

  // UNCHANGED, and plan erratum E1 is why: the VARIABLE unset means "this process is not a governed
  // run" -- an operator running the script by hand, and `preflightGate`, which spawns the real hook
  // twice per spawn and requires the disarmed direction to allow.
  it('allows when SLAVEOFAI_PERMISSIONS_FILE is unset -- no matrix in play at all', async () => {
    const result = await runVerdict('{"tool_name":"Bash"}', undefined)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
  })

  // MOVED, same name, and the sharpest one: the variable is SET and the file is gone. That used to
  // be "no matrix in play: allow", which is the self-policing hole `permissions.sh:57-59` recorded
  // -- a run that deleted its own file disarmed itself. It fails CLOSED now.
  it('allows when the permissions file does not exist', async () => {
    const result = await runVerdict('{"tool_name":"Read"}', '/nonexistent/permissions.json')
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/unreadable|missing/)
  })

  it('fails closed on a malformed permissions file', async () => {
    const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile('{not valid json'))
    expect(result.code).toBe(2)
  })

  // MOVED, same name: a pre-M52 file is version 1 with a `deny` key and no allow list. It is not
  // read -- a v1 file under a v2 gate is a stale verdict, and a stale verdict denies.
  it('fails closed on a version-1 file', async () => {
    const result = await runVerdict(
      '{"tool_name":"Read"}',
      writePermissionsFile('{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}'),
    )
    expect(result.code).toBe(2)
  })

  it('fails closed when `allow` is not an array, and when `version` is not 2', async () => {
    expect((await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({ allow: 'all' as never })))).code).toBe(2)
    expect(
      (await runVerdict('{"tool_name":"Read"}', writePermissionsFile(JSON.stringify({ version: 3, allow: [] })))).code,
    ).toBe(2)
  })

  it('fails closed on a non-JSON payload while a file is armed', async () => {
    const result = await runVerdict('not json at all', writePermissionsFile(v2({})))
    expect(result.code).toBe(2)
  })

  describe('identity (M52 R4)', () => {
    it('allows when the child’s token hashes to the file’s tokenHash', async () => {
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, TOKEN)
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })

    it('FAILS CLOSED when the child’s token hashes to something else -- a sibling run’s file cannot be borrowed', async () => {
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, 'a'.repeat(64))
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/identity/)
    })

    it('FAILS CLOSED when the child carries no token at all while the file names one', async () => {
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, '')
      expect(result.code).toBe(2)
    })

    it('FAILS CLOSED when the file carries no tokenHash -- an unbound verdict is not a verdict', async () => {
      const file = writePermissionsFile(JSON.stringify({ version: 2, runId: 'r', enforce: 'all-tools', allow: [], vocabulary: {} }))
      const result = await runVerdict('{"tool_name":"Read"}', file)
      expect(result.code).toBe(2)
    })

    it('compares the two hashes at equal length, so a truncated token cannot short-circuit the check', async () => {
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, TOKEN.slice(0, 8))
      expect(result.code).toBe(2)
    })
  })

  describe('enforce: known-tools (Cursor, plan erratum E3)', () => {
    it('still enforces the ONE name Cursor can be trusted to send -- the shell, through default_tool', async () => {
      const file = writePermissionsFile(
        v2({ enforce: 'known-tools', allow: [{ tool: 'read', kind: 'read_repo' }], vocabulary: { read: 'read_repo', shell: 'run_commands' } }),
      )
      const result = await runVerdict('{"command":"npm test","cwd":"/tmp"}', file, 'shell')
      expect(result.status).toBe(0)
      expect(result.tool).toBe('shell')
      expect(result.capability).toBe('run_commands')
    })

    it('allows a Claude-shaped name Cursor’s preToolUse sends, because that identity is untrustworthy for enforcement', async () => {
      const file = writePermissionsFile(
        v2({ enforce: 'known-tools', allow: [], vocabulary: { read: 'read_repo', shell: 'run_commands' } }),
      )
      const result = await runVerdict('{"tool_name":"Read"}', file)
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })

    it('and the SAME payload denies under all-tools, which is the whole difference between the two providers', async () => {
      const file = writePermissionsFile(v2({ enforce: 'all-tools', allow: [], vocabulary: { read: 'read_repo' } }))
      const result = await runVerdict('{"tool_name":"Read"}', file)
      expect(result.status).toBe(0)
      expect(result.capability).toBe('ungoverned_tool')
    })
  })
})
```

The six existing `default_tool` cases keep their names and flip the same way: a `shell` on the allow list allows, a `shell` that is not on it denies naming `run_commands`, and the shape guard (no `command` string ⇒ the fallback is not applied) is unchanged.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/providers/test/permissions-lib.test.ts`
Expected: FAIL — roughly 20 of ~30 cases; the library still reads `file.deny` and still allows on absence. Paste the failure count into the report: it is the measure of how much of this contract was the wrong way round.

- [ ] **Step 3: Invert the library**

`scripts/lib/permissions.sh`. The header's ALLOW-by-absence paragraph and the SELF-POLICING THREAT MODEL paragraph are both DELETED — not rewritten — and replaced by what is true now; the "REPORT, DON'T PRINT", the "NODE FED ON STDIN, NEVER ARGV" and the deny-grammar paragraphs are untouched. The new contract block:

```bash
# read_permission_verdict "$payload" ["$default_tool"]
#   Contract (M52 R2 -- the INVERSE of M18's, arm for arm):
#     return 0 -> DENY. PERMISSION_DENY_TOOL and PERMISSION_DENY_CAPABILITY are set; the caller
#                 spells the deny body. Covers: a tool the file's `allow` list does not carry (the
#                 capability is the kind the file's `vocabulary` says governs it); a tool no kind
#                 governs, under `enforce: all-tools` (capability `ungoverned_tool`); and a payload
#                 that names no tool at all under the same enforcement (tool `unknown`). All three
#                 are refused CALLS on a run that keeps going -- exit 0 with a deny body -- because
#                 a PreToolUse payload this gate cannot read is not a broken gate (M52 erratum E8).
#     return 1 -> ALLOW. Covers exactly three things: the tool is on the allow list;
#                 SLAVEOFAI_PERMISSIONS_FILE is UNSET, which means this process is not a governed
#                 run at all (an operator running the gate by hand, and `preflightGate`, which
#                 spawns this script twice on every spawn and requires the disarmed direction to
#                 allow -- erratum E1); and, under `enforce: known-tools`, a tool name the file's
#                 vocabulary does not know, which is Cursor's measured limitation (:30-36) stated in
#                 data rather than left to a casing accident.
#     exit 2    -> FAIL CLOSED, i.e. the run stops. The file is armed and cannot be read as a
#                 verdict: missing, unreadable, malformed, not version 2, no `allow` array, no
#                 `tokenHash`; the payload is not JSON at all; or the identity does not match --
#                 SLAVEOFAI_RUN_TOKEN's sha256 is not the file's `tokenHash`. A run that deletes its
#                 own permissions file no longer disarms itself: it stops. (It can no longer reach
#                 the file either -- M52 R4 moved the run directory out of the worktree -- but the
#                 two locks are independent on purpose.)
```

The body: the guard becomes

```bash
  if [[ -z "${SLAVEOFAI_PERMISSIONS_FILE:-}" ]]; then
    return 1  # not a governed run at all (an operator, a pre-flight): allow
  fi
```

and the `node -e` grows three questions and keeps ONE spawn:

```js
    const crypto = require("node:crypto");
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      let payload, file;
      try { payload = JSON.parse(raw); } catch { process.stdout.write("BADPAYLOAD"); return; }
      try { file = JSON.parse(require("node:fs").readFileSync(process.env.SLAVEOFAI_PERMISSIONS_FILE, "utf8")); }
      catch { process.stdout.write("BADFILE"); return; }

      // 1. IS THIS A VERDICT AT ALL. A version-1 file is a pre-M52 snapshot, i.e. a stale verdict,
      // and a stale verdict is not believed. Everything this arm rejects used to ALLOW.
      if (file === null || typeof file !== "object") { process.stdout.write("BADFILE"); return; }
      if (file.version !== 2) { process.stdout.write("BADFILE"); return; }
      const allow = Array.isArray(file.allow) ? file.allow : null;
      if (allow === null) { process.stdout.write("BADFILE"); return; }
      const vocabulary = file.vocabulary !== null && typeof file.vocabulary === "object" ? file.vocabulary : {};
      const enforce = file.enforce === "known-tools" ? "known-tools" : "all-tools";

      // 2. IS THIS VERDICT ABOUT THIS CHILD (M52 R4). The hash is on the file and the plaintext is
      // in this process's environment, so pointing SLAVEOFAI_PERMISSIONS_FILE at a sibling run's
      // file buys nothing: the sibling's hash will not match this child's token. `timingSafeEqual`
      // over equal-length buffers, with the length guard first -- it THROWS on a length mismatch,
      // and a thrown comparison would exit nonzero with no message.
      const expected = typeof file.tokenHash === "string" ? file.tokenHash : "";
      const token = process.env.SLAVEOFAI_RUN_TOKEN || "";
      const actual = token === "" ? "" : crypto.createHash("sha256").update(token).digest("hex");
      if (expected.length !== 64 || actual.length !== 64 ||
          !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
        process.stdout.write("BADIDENTITY"); return;
      }

      // 3. WHAT IS THIS CALL. Unchanged from M18, including the non-object guard and the
      // `default_tool` shape rule -- see the paragraphs above, which still describe it exactly.
      const isObject = payload !== null && typeof payload === "object";
      let tool = isObject && typeof payload.tool_name === "string" ? payload.tool_name : null;
      const defaultTool = process.env.SLAVEOFAI_DEFAULT_TOOL || "";
      if (tool === null && defaultTool !== "" && isObject && typeof payload.command === "string") {
        tool = defaultTool;
      }

      if (tool !== null && allow.some((entry) => entry && entry.tool === tool)) {
        process.stdout.write("ALLOW"); return;
      }
      const governed = tool !== null && Object.prototype.hasOwnProperty.call(vocabulary, tool);
      if (governed) {
        process.stdout.write("DENY\t" + tool + "\t" + String(vocabulary[tool])); return;
      }
      // Ungoverned, or unnamed. On Cursor (`known-tools`) that is the measured limitation and it
      // allows; on Claude it is the class an allow list exists to close.
      if (enforce === "known-tools") { process.stdout.write("ALLOW"); return; }
      process.stdout.write("DENY\t" + (tool === null ? "unknown" : tool) + "\tungoverned_tool");
    });
```

and the `case` gains one arm:

```bash
    BADIDENTITY)
      printf '%s: this run'"'"'s identity does not match the permissions file it was given\n' "$PAUSE_GATE_NAME" >&2
      exit 2 ;;
```

with `BADFILE`'s message widened to `permissions file unreadable, malformed, or not a version-2 verdict: %s`.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run packages/providers/test/permissions-lib.test.ts`
Expected: PASS — every case, ~30.

- [ ] **Step 5: Move the deny message's quoted slot, and the two gate tests**

`scripts/pause-gate.sh:120-122` is unchanged in SHAPE and its comment gains one sentence: the quoted slot carries a `PermissionKind` (or `ungoverned_tool`) and never a label, because `parsePermissionDenyReason` (`packages/providers/src/gate.ts:82-88`) parses it straight into the `run.tool_denied` payload, and the LABEL is the card's job (plan erratum E2).

`packages/providers/test/pause-gate.test.ts`: its four permission cases write v2 files and a run token, and the deny-body assertion becomes:

```ts
    expect(decision.permissionDecisionReason).toBe("permission matrix denies 'run_commands' (Bash) for this slave")
```

plus one new case that is the point of the whole task:

```ts
  it('denies a tool nobody granted, and the reason parses back to the kind a card can label', async () => {
    const result = await runHook({ payload: '{"tool_name":"WebFetch"}', permissionsFile, runToken: TOKEN })
    expect(result.exitCode).toBe(0)
    const parsed = parsePermissionDenyReason(decisionOf(result).permissionDecisionReason)
    expect(parsed).toEqual({ tool: 'WebFetch', capability: 'network_fetch' })
  })
```

`packages/providers/test/cursor-shell-gate.test.ts`: same treatment, with the allow spoken out loud, and one case asserting that a `preToolUse` payload naming `"Read"` is ALLOWED under `known-tools` while `beforeShellExecution` on an ungranted shell is DENIED — the two halves of E3 in one file.

- [ ] **Step 6: Harden the pre-flight (erratum E1)**

`packages/providers/src/runtime/gate-preflight.ts:33` — `runGateScript` builds the child's environment. Delete the permissions variable from it:

```ts
      // M52 erratum E1: this check measures the PAUSE gate and must never measure the matrix. The
      // orchestrator's own environment normally names no permissions file, but an operator's shell
      // might -- and under default-deny a stray one would deny the disarmed direction and fail
      // every spawn on the machine. Deleting it makes the pre-flight's contract exact rather than
      // dependent on what was exported.
      env: (() => {
        const env = { ...process.env, SLAVEOFAI_PAUSE_FLAG: input.flagPath }
        delete env['SLAVEOFAI_PERMISSIONS_FILE']
        delete env['SLAVEOFAI_RUN_TOKEN']
        return env
      })(),
```

and add a case to `packages/providers/test/gate-preflight.test.ts` (or the file that covers it — find it with `grep -rln "preflightGate" packages/providers/test`) asserting the pre-flight passes with `SLAVEOFAI_PERMISSIONS_FILE` pointing at a file that would deny everything.

- [ ] **Step 7: Write the failing test for the child's environment**

`packages/providers/test/runtime-process.test.ts` — the `(characterization)` describe's second case, `inherits the current process env underneath the overrides`, is the one this milestone REVERSES, and it keeps its name with its meaning inverted:

```ts
describe('buildChildEnv (M52 R3: an allow list, never an inheritance)', () => {
  const base = {
    gitIdentity: { name: 'AI Worker', email: 'worker@example.com' },
    pauseFlagPath: '/tmp/x/pause.flag',
    permissionsFilePath: '/tmp/x/permissions.json',
    runId: 'run-1',
    runToken: 'f'.repeat(64),
    brokerChannelPath: '/tmp/x/broker.ndjson',
  }

  it('carries the git identity, the pause flag, the permissions file, the run id, the token and the broker channel', () => {
    const env = buildChildEnv(base)
    expect(env['SLAVEOFAI_PAUSE_FLAG']).toBe('/tmp/x/pause.flag')
    expect(env['SLAVEOFAI_PERMISSIONS_FILE']).toBe('/tmp/x/permissions.json')
    expect(env['SLAVEOFAI_RUN_ID']).toBe('run-1')
    expect(env['SLAVEOFAI_RUN_TOKEN']).toBe('f'.repeat(64))
    expect(env['SLAVEOFAI_BROKER_CHANNEL']).toBe('/tmp/x/broker.ndjson')
    expect(env['GIT_AUTHOR_NAME']).toBe('AI Worker')
    expect(env['GIT_COMMITTER_EMAIL']).toBe('worker@example.com')
  })

  it('does NOT inherit the current process env -- the sentence this test used to assert', () => {
    process.env['SLAVEOFAI_TEST_PROBE'] = 'inherited'
    try {
      expect('SLAVEOFAI_TEST_PROBE' in buildChildEnv(base)).toBe(false)
    } finally {
      delete process.env['SLAVEOFAI_TEST_PROBE']
    }
  })

  it('carries none of the four secrets a worker must never hold', () => {
    process.env['DATABASE_URL'] = 'postgres://u:p@localhost:5433/db'
    process.env['SLAVEOFAI_SESSION_SECRET'] = 'secret'
    process.env['SLAVEOFAI_PASSWORD'] = 'hunter2'
    process.env['FAKE_DEPLOY_TOKEN'] = 'tok'
    try {
      const env = buildChildEnv(base)
      for (const name of ['DATABASE_URL', 'SLAVEOFAI_SESSION_SECRET', 'SLAVEOFAI_PASSWORD', 'FAKE_DEPLOY_TOKEN']) {
        expect(name in env, name).toBe(false)
      }
    } finally {
      for (const name of ['DATABASE_URL', 'SLAVEOFAI_SESSION_SECRET', 'SLAVEOFAI_PASSWORD', 'FAKE_DEPLOY_TOKEN']) {
        delete process.env[name]
      }
    }
  })

  it('passes through exactly the CHILD_ENV_ALLOW names that are actually set, and invents none', () => {
    process.env['PATH'] = '/usr/bin'
    process.env['LC_ALL'] = 'C'
    const env = buildChildEnv(base)
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['LC_ALL']).toBe('C')
    // A name on the list that the parent does not have is ABSENT, never empty: an empty PATH is a
    // child that cannot find `git`, and it would look like a configuration rather than a gap.
    delete process.env['XDG_CACHE_HOME']
    expect('XDG_CACHE_HOME' in buildChildEnv(base)).toBe(false)
  })

  it('is an explicit NAME list -- never a prefix rule and never a denylist', () => {
    process.env['SLAVEOFAI_SOMETHING_NEW'] = 'x'
    try {
      expect('SLAVEOFAI_SOMETHING_NEW' in buildChildEnv(base)).toBe(false)
    } finally {
      delete process.env['SLAVEOFAI_SOMETHING_NEW']
    }
  })

  it('leaves the token, the id and the channel ABSENT when they are not supplied', () => {
    const env = buildChildEnv({
      gitIdentity: base.gitIdentity,
      pauseFlagPath: base.pauseFlagPath,
      permissionsFilePath: base.permissionsFilePath,
    })
    expect('SLAVEOFAI_RUN_TOKEN' in env).toBe(false)
    expect('SLAVEOFAI_BROKER_CLI' in env).toBe(false)
  })
})
```

- [ ] **Step 8: MEASURE what the vendor CLIs need, then write the list**

This step is a MEASUREMENT before it is an edit, and the task report must carry its output. `CHILD_ENV_ALLOW` is the one list in this milestone that can break a real run in a way no test catches, because a test's child is `node` and a real child is `claude`.

```bash
env -i PATH="$PATH" HOME="$HOME" claude --version; echo "claude: ${PIPESTATUS[0]}"
env -i PATH="$PATH" HOME="$HOME" cursor-agent --version; echo "cursor: ${PIPESTATUS[0]}"
env -i PATH="$PATH" HOME="$HOME" node packages/providers/test/fake-claude.mjs --fixture complete | head -2
```

Record each binary's version and exit code in the report. If either real binary fails under that environment, add ONE name at a time, re-run, and record which name fixed it — the list is measured, never guessed. If neither binary is installed on this machine, say so plainly in the report and note that the list stands on the fake CLI and on the four documented requirements below; do not silently widen it.

`packages/providers/src/runtime/process.ts`:

```ts
/**
 * The ONLY environment variables a worker's child inherits from this process (M52 R3).
 *
 * An explicit NAME list -- never a prefix rule, never a denylist. The denylist was tried in the
 * harness this finding comes from and leaked three times before it was replaced by a four-entry
 * allow list; a hardcoded five-name strip list there was measured SEVEN names short of a live
 * session's dump. Denylists close instances; allow lists close the class.
 *
 * What each name is here FOR, because a list with no reasons grows by accretion:
 *   - PATH, HOME, SHELL, USER      the child spawns `git` and its own subprocesses.
 *   - LANG, LC_ALL, TERM           output encoding; a missing LANG mangles non-ASCII diffs.
 *   - TMPDIR                       the CLI writes scratch files.
 *   - XDG_CONFIG_HOME, XDG_CACHE_HOME  where the vendor CLI keeps its own auth and cache. This is
 *                                  the pair that makes "the vendor CLI reads its own auth" work,
 *                                  and it is why this is an allow list rather than an empty
 *                                  environment: the credential the CLI uses is the OPERATOR's, held
 *                                  by the vendor, and this system never sees it.
 *   - NODE_EXTRA_CA_CERTS, SSL_CERT_FILE  corporate TLS. A child that cannot verify a certificate
 *                                  fails in a way nobody can read.
 *
 * What is deliberately NOT here, and asserted so by `runtime-process.test.ts` and by the gate:
 * `DATABASE_URL`, `SLAVEOFAI_SESSION_SECRET`, `SLAVEOFAI_PASSWORD`, and every API key an operator's
 * shell happens to hold. A worker that cannot reach the database cannot rewrite its own
 * permissions, and a worker that holds no key cannot spend one.
 */
export const CHILD_ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const
```

and `buildChildEnv` stops spreading:

```ts
export function buildChildEnv(input: {
  readonly gitIdentity: { readonly name: string; readonly email: string }
  readonly pauseFlagPath: string
  readonly permissionsFilePath: string
  readonly toolResultsPath?: string
  /** M52 R4: the run this child IS, and the proof of it. The id is for the broker's request lines;
   *  the token is what the hook hashes against `permissions.json`'s `tokenHash` and what the broker
   *  compares before it resolves a grant. Optional for `toolResultsPath`'s reason -- and an absent
   *  token is FAIL-CLOSED rather than permissive: the child then meets a hash it cannot match. */
  readonly runId?: string
  readonly runToken?: string
  /** M52 R3: the request/reply channel, the FOURTH file channel of this exact shape. */
  readonly brokerChannelPath?: string
  /** M52 erratum E6: the absolute path of the orchestrator CLI the thin client runs. There is no
   *  `orchestrator` binary on anybody's PATH; this is how the worker finds one. */
  readonly brokerCliPath?: string
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of CHILD_ENV_ALLOW) {
    const value = process.env[name]
    // Absent, never empty: a name the parent does not hold must not arrive as a configured blank.
    if (value !== undefined) env[name] = value
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: input.gitIdentity.name,
    GIT_AUTHOR_EMAIL: input.gitIdentity.email,
    GIT_COMMITTER_NAME: input.gitIdentity.name,
    GIT_COMMITTER_EMAIL: input.gitIdentity.email,
    SLAVEOFAI_PAUSE_FLAG: input.pauseFlagPath,
    SLAVEOFAI_PERMISSIONS_FILE: input.permissionsFilePath,
    ...(input.toolResultsPath === undefined ? {} : { SLAVEOFAI_TOOL_RESULTS: input.toolResultsPath }),
    ...(input.runId === undefined ? {} : { SLAVEOFAI_RUN_ID: input.runId }),
    ...(input.runToken === undefined ? {} : { SLAVEOFAI_RUN_TOKEN: input.runToken }),
    ...(input.brokerChannelPath === undefined ? {} : { SLAVEOFAI_BROKER_CHANNEL: input.brokerChannelPath }),
    ...(input.brokerCliPath === undefined ? {} : { SLAVEOFAI_BROKER_CLI: input.brokerCliPath }),
  }
}

/** Where a run's broker request channel lives (M52 R3) -- the ONE definition of the
 *  `'broker.ndjson'` filename, for `permissionsFilePathFor`'s reason: the adapter sets the child's
 *  `SLAVEOFAI_BROKER_CHANNEL` from it and the daemon tails the same file back, and a one-character
 *  drift would leave the daemon watching a file nothing writes -- which looks exactly like a worker
 *  that never asked for anything. */
export function brokerChannelPathFor(runDir: string): string {
  return join(runDir, 'broker.ndjson')
}

/** Where the daemon writes ONE request's reply. The request id is the filename, which is also the
 *  idempotency key: the server serves a request only if this file does not already exist, so a
 *  daemon restart that re-reads the channel from byte 0 cannot execute anything twice. */
export function brokerReplyPathFor(runDir: string, requestId: string): string {
  // `requestId` is checked by the caller against /^[a-f0-9]{32}$/ before it reaches here; this is
  // the second lock, and it is the one that runs in the process that opens the file.
  if (!/^[a-f0-9]{32}$/u.test(requestId)) throw new Error(`brokerReplyPathFor: bad request id ${JSON.stringify(requestId)}`)
  return join(runDir, `broker-${requestId}.json`)
}

/** `sha256` hex of a run token (M52 R4). One definition, used by the writer (`writePermissionsFile`
 *  and the four dispatch sites) and by the broker's authoriser -- the hook computes the same thing
 *  in its own `node -e`, in six characters of JavaScript, because it may not import anything. */
export function runTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
```

- [ ] **Step 9: Run it and watch it pass**

Run: `npx vitest run packages/providers/test/runtime-process.test.ts`
Expected: PASS — six cases, including the reversed characterization.

- [ ] **Step 10: Thread the token and the CLI path through the two adapters**

`StartRunInput` gains `runToken?: string` with the docstring E7 argues; `SlaveRuntimeAdapter.resume` gains a fourth parameter `runToken?: string`; `ClaudeCodeAdapterOptions` and `CursorAdapterOptions` each gain `brokerCliPath?: string`. Each adapter's two `buildChildEnv` calls pass:

```ts
        ...(input.runToken === undefined ? {} : { runId: String(input.runId), runToken: input.runToken }),
        brokerChannelPath: brokerChannelPathFor(input.runDir),
        ...(this.brokerCliPath === undefined ? {} : { brokerCliPath: this.brokerCliPath }),
```

and the resume path does the same with `resumedInput.runDir` (Claude) / `dirname(checkpoint.pauseFlagPath)` (Cursor) — the SAME derivations both files already make for `permissionsFilePath`, never a new one.

`adapter-start.test.ts` and `adapter-resume.test.ts` each gain one case asserting the four variables reach the child and that a spawn with no token leaves `SLAVEOFAI_RUN_TOKEN` absent. `run-preparation.test.ts` gains one asserting the broker channel path sits inside `runDir` beside `permissions.json`.

- [ ] **Step 11: Move the run directory out of the repository**

`packages/control/src/paths.ts`. The signature does NOT change — every caller has `repoPath`, `signalPause` re-derives the same two values (`pause.ts:80`), and the `statSync` preflight is still a true statement about a broken run. What changes is where the directory goes and what the docstring says:

```ts
/**
 * Where the run's own files live: **outside the repository entirely** (M52 R4).
 *
 * Until this milestone this was `<repoPath>/.slaveofai/runs/<runId>` -- inside the tree the worker
 * edits. `scripts/lib/permissions.sh` recorded the consequence in its own header: "A run that
 * deletes its own permissions file disarms the matrix for its remaining tool calls." Under
 * default-deny that stops being a hole and becomes a bypass of everything, so the directory moves
 * somewhere a worker cannot see: `$SLAVEOFAI_STATE_DIR`, else `$XDG_STATE_HOME`, else
 * `~/.local/state`, then `slaveofai/runs/<runId>`, created 0700.
 *
 * `repoPath` stays a parameter and its `statSync` preflight stays: every caller has it, `signalPause`
 * re-derives this same path from the same two values, and a run whose repository is missing or is
 * not a directory is a broken run whether or not its scratch directory lives there. The check is now
 * an assertion about the RUN rather than about where the directory goes, and its own two tests
 * (`paths.test.ts`) are unchanged.
 *
 * What did NOT move, and must not be claimed to have (plan erratum E4): `<repo>/.slaveofai/worktrees`
 * (`apps/orchestrator/src/worktree.ts:24`) and `<repo>/.slaveofai/artifacts` (`verify.ts:460`,
 * `merge.ts:208`). A worktree is the worker's workspace and an artifact is a log a person downloads
 * through `/api/w/:id/tasks/:id/artifacts/:id`; neither is a verdict about the worker.
 *
 * A run in flight across the upgrade keeps its ORIGINAL directory and needs no migration: both
 * adapters re-derive `runDir` from `dirname(checkpoint.pauseFlagPath)`, which is an absolute path
 * recorded when the run started.
 */
export function runFilePaths(repoPath: string, runId: RunId): { runDir: string; pauseFlagPath: string } {
  // ... the existing statSync preflight, unchanged ...
  const stateRoot =
    process.env['SLAVEOFAI_STATE_DIR'] ??
    (process.env['XDG_STATE_HOME'] !== undefined && process.env['XDG_STATE_HOME'] !== ''
      ? join(process.env['XDG_STATE_HOME'], 'slaveofai')
      : join(homedir(), '.local', 'state', 'slaveofai'))
  const dir = join(stateRoot, 'runs', runId)
  try {
    // 0700 on the whole chain: a run directory holds the verdict that governs a worker, and this
    // machine may have other accounts on it. It does NOT protect a run from a SIBLING run under the
    // same uid -- that is what the token on the verdict is for, and why no plaintext token is ever
    // written into this directory.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) { /* ... the existing throw, unchanged ... */ }
  return { runDir: dir, pauseFlagPath: join(dir, 'pause.flag') }
}
```

`packages/control/test/paths.test.ts` gains three cases (the dir is NOT under `repoPath`; `SLAVEOFAI_STATE_DIR` is honoured; the directory's mode is `0700`) and keeps its two throw cases verbatim. `apps/orchestrator/test/integration/tick.test.ts:360-371` — **the pin this task moves** — stops joining `fixture.repoPath` and reads `runFilePaths(fixture.repoPath, runId(run.id)).runDir` instead, with a new assertion that `join(fixture.repoPath, '.slaveofai', 'runs')` does not exist. Every gate that sets `SLAVEOFAI_STATE_DIR` to a temporary directory gets isolation for free; Task 6 uses that.

- [ ] **Step 12: Write the v2 file**

`packages/control/src/permission.ts` — `resolveDenyList` is DELETED (Task 1 left it marked for this) and `writePermissionsFile` takes the facts rather than a resolved list:

```ts
/**
 * Writes `permissions.json` v2 into the run's own scratch directory (M52 R2).
 *
 * v1 was a DENY list and an absent file allowed; v2 is an ALLOW list, and the file is the whole
 * verdict: what this run may call, which operation governs each of those tools, the vocabulary the
 * gate needs to NAME the operation behind a refusal, how much of it this provider can enforce, and
 * WHICH RUN the verdict is about. `scripts/lib/permissions.sh` refuses anything it cannot read as
 * exactly that, and refusing means stopping the run.
 *
 * Still rewritten at every START and every RESUME and never merged: a matrix edit reaches a run only
 * the next time it starts or resumes, exactly as the matrix copy has always said. Mode 0600, inside
 * a 0700 directory outside the repository.
 */
export function writePermissionsFile(
  runDir: string,
  input: {
    readonly rows: readonly { readonly kind: string; readonly mode: 'allow' | 'deny' }[]
    readonly provider: PermissionProvider
    readonly runKind: 'implementation' | 'review' | 'planning'
    readonly runId: string
    /** The PLAINTEXT token this spawn will put in the child's environment. Only its hash is written
     *  here; the plaintext is never persisted anywhere (M52 R4, plan erratum E7). */
    readonly runToken: string
  },
): string {
  const permissionsFilePath = permissionsFilePathFor(runDir)
  const body = {
    version: 2,
    runId: input.runId,
    tokenHash: runTokenHash(input.runToken),
    enforce: ENFORCE_BY_PROVIDER[input.provider],
    allow: resolveGrants(input.rows as readonly PermissionRowInput[], input.provider, input.runKind),
    vocabulary: TOOL_VOCABULARY[input.provider],
  }
  writeFileSync(permissionsFilePath, JSON.stringify(body, null, 2), { mode: 0o600 })
  return permissionsFilePath
}
```

- [ ] **Step 13: Issue the token at all four sites, and ROTATE it on resume**

`apps/orchestrator/src/tick.ts` (implementation), `planning.ts` (`'planning'`), `review.ts` (`'review'`) — each replaces one line with four:

```ts
    // M52 R4: a fresh 32-byte token per spawn. The HASH goes on the row and into the file the gate
    // reads; the PLAINTEXT goes into the child's environment and nowhere else -- not on the row, not
    // in the checkpoint, not in a file, because a token file in `runDir` would be readable by every
    // sibling run under the same uid.
    const runToken = randomBytes(32).toString('hex')
    await prisma.slaveRun.update({ where: { id: run.id }, data: { runTokenHash: runTokenHash(runToken) } })
    const permissionsFilePath = writePermissionsFile(runDir, {
      rows: slave.permissions,
      provider: resolved.provider,
      runKind: 'implementation',
      runId: run.id,
      runToken,
    })
```

and passes `runToken` on the `adapter.start({...})` call.

`apps/orchestrator/src/resume.ts` does the same and the comment says the extra thing that is true there:

```ts
  // ROTATED, not replayed (M52 R4). A token recovered from an old worktree, an old process listing
  // or a stale environment dump is dead the moment the run resumes: the row's hash and the file's
  // hash both move, and the only process holding the new plaintext is the child this call spawns.
  // `run.kind` is read off the row the claim already loaded -- the resolution differs per run kind
  // and this is the one of the four sites that does not know its kind statically.
```

with `writePermissionsFile(runDir, { rows: run.slave.permissions, provider: checkpoint.provider ?? 'claude_code', runKind: run.kind, runId: run.id, runToken })` and `adapter.resume(brandRunId(run.id), {...}, message, runToken)`.

- [ ] **Step 14: Run the whole suite**

Run: `npx vitest run`
Expected: PASS at or above the baseline. Three files are the ones to watch and their failures mean specific things:
- `apps/orchestrator/test/integration/tick.test.ts` — if its permissions assertions fail, the path move and the v2 body disagree; read the file the test wrote before changing anything.
- `packages/control/test/integration/pause.test.ts:134-141` chmods `runDir` 0555 to make `signalPause` fail. It must still work: `runFilePaths` returns the same path to both callers, wherever that path now is.
- `apps/orchestrator/test/integration/cli.test.ts:999` asserts `pause.flag` under `<repo>/.slaveofai/runs/<id>`. **Moved here**, to `runFilePaths(...).pauseFlagPath`.

- [ ] **Step 15: Ladder and commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
npx vitest run
```

then, one at a time, with no vitest running:

```bash
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m18-skill-and-teeth

npm run gate:m13-runtime
npm run gate:m37-run-context
```

Expected: all three green. `gate:m13-runtime` is the one that proves the pre-flight still passes on both providers with the inverted library (erratum E1's whole point), and `gate:m37-run-context` reads a real run's prompt and worktree back through a child spawned with the stripped environment. If `m13` fails at a spawn with "did not allow with the pause flag absent", the pre-flight is reading a permissions file it should not — go back to Step 6.

```bash
git add scripts packages/providers packages/control apps/orchestrator
git commit -m "$(cat <<'EOF'
feat(providers,control,orchestrator): m52 t2 — the gate asks what is allowed, and asks who is asking

`permissions.json` is an allow list now, and the file is the whole verdict: what this run may call,
which operation governs each tool, the vocabulary the gate needs to name the operation behind a
refusal, how much of it this provider can enforce, and which run it is about. A tool nobody granted
is refused; a tool no kind governs is refused on Claude and allowed on Cursor, because Cursor's
`preToolUse` sends a tool identity that has never been trustworthy for enforcement and an allow list
would otherwise deny every call it makes. A run that deletes its own verdict no longer disarms
itself -- it stops -- and it can no longer reach the file at all, because the run directory left the
repository the worker edits. The one arm that still allows on absence is the VARIABLE being unset,
which is not a run at all: it is the pre-flight that spawns this gate twice before every spawn, and
a rule that denied there would have failed every start on the machine.

Identity stops being a path. Every spawn mints 32 random bytes, puts the hash on the row and in the
file and the plaintext in one child's environment, and rotates on every resume; pointing
`SLAVEOFAI_PERMISSIONS_FILE` at a sibling's verdict now buys a fail-closed exit 2. And the child's
environment is an explicit list of twelve names plus its own channels: `DATABASE_URL` is not in it,
so a worker cannot reach the table that governs it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 3: The verbs — granting, revoking, naming a credential, binding an operation, and refusing seven ways (R3, R5, R6, E5, E9, D16–D20)

`packages/control` only, plus the two web test files a refusal kind reaches. Nothing here spawns anything: `runBrokeredOperation` AUTHORISES and records, and takes the execution as an injected function — the `ModelDecider` seam (`packages/control/src/simulation/llm.ts:25-26`), for the same reason it exists there.

**Files:**
- Create: `packages/control/src/credential.ts`, `packages/control/src/broker.ts`, `packages/control/test/integration/credential.test.ts`, `packages/control/test/integration/broker.test.ts`
- Modify: `packages/control/src/permission.ts`, `packages/control/src/refusal.ts`, `packages/control/src/supervisor.ts`, `packages/control/src/supervisorWorld.ts`, `packages/control/src/index.ts`, `packages/control/test/simulation-boundary.test.ts`, `apps/web/test/refusal-status.test.ts`
- Test: `packages/control/test/integration/{permission,credential,broker,supervisor,supervisorWorld}.test.ts`, `packages/control/test/simulation-boundary.test.ts`, `apps/web/test/refusal-status.test.ts`

**Interfaces:**
- Consumes: `BROKERED_OPERATIONS`, `BROKER_REFUSAL_REASONS`, `PERMISSION_KINDS`, `PERMISSION_LABEL`, `resolveGrants`, `grantsFor`, `PERMISSION_DENIAL_WINDOW_MS`, `PERMISSION_TRIP_COUNT` (domain); `runTokenHash` (providers); `appendEvent` (events); `Principal`.
- Produces, for Tasks 4–6:
  - `setSlavePermission(slaveId, kind, mode, principal?)`, `clearSlavePermission(slaveId, kind, principal?)` — both append `permission.changed`
  - `addCredential(workspaceId, { name, kind, envVar }, principal?)`, `listCredentials(workspaceId)`, `bindBrokerOp(workspaceId, { op, command, credentialName }, principal?)`, `listBrokerBindings(workspaceId)`
  - `runBrokeredOperation(input, deps)` → `Result<BrokerOutcome, ControlRefusal>`, and `BrokerExecutor`
  - `ControlRefusal` + `broker_refused`, `credential_not_found`
  - `SupervisorWorld.denials`, loaded
  - `carryOut`'s `request_permission` arm

- [ ] **Step 1: Write the failing integration test for grant, refuse and revoke**

`packages/control/test/integration/permission.test.ts` gains, beside the cases Task 1 moved:

```ts
  it('records WHO granted and WHEN, which no row could say before', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow', { userId: 'user-1' })
    const row = await prisma.slavePermission.findUniqueOrThrow({
      where: { slaveId_kind: { slaveId, kind: 'network_fetch' } },
    })
    expect(row.grantedBy).toBe('user-1')
    expect(row.grantedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('appends permission.changed with the from/to/by triple, and the LABEL beside the key', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow', { userId: 'user-1' })
    const events = await prisma.executionEvent.findMany({ where: { type: 'permission_changed' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      slaveId,
      name: 'Alex',
      kind: 'network_fetch',
      kindLabel: 'Fetch over the network',
      from: null,
      to: 'allow',
      by: 'user-1',
    })
    expect(events[0]?.actor).toBe('human')
  })

  it('records the FROM state when a grant is flipped to a refusal', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow')
    await setSlavePermission(slaveId, 'network_fetch', 'deny')
    const events = await prisma.executionEvent.findMany({ where: { type: 'permission_changed' }, orderBy: { seq: 'asc' } })
    expect(events.map((event) => [event.payload.from, event.payload.to])).toEqual([
      [null, 'allow'],
      ['allow', 'deny'],
    ])
  })

  it('writes NO event when the mode is already what was asked for -- an idempotent PUT is not a change', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow')
    await setSlavePermission(slaveId, 'network_fetch', 'allow')
    expect(await prisma.executionEvent.count({ where: { type: 'permission_changed' } })).toBe(1)
  })

  it('REVOKES back to unset -- the state setSlavePermission could never reach', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow')
    const result = await clearSlavePermission(slaveId, 'network_fetch', { userId: 'user-1' })
    expect(result.ok).toBe(true)
    expect(await prisma.slavePermission.count({ where: { slaveId } })).toBe(0)
    const events = await prisma.executionEvent.findMany({ where: { type: 'permission_changed' }, orderBy: { seq: 'asc' } })
    expect(events.at(-1)?.payload).toMatchObject({ from: 'allow', to: null })
  })

  it('a revoke of a kind nobody ever decided is a no-op, not a refusal -- the DELETE is idempotent', async (): Promise<void> => {
    const result = await clearSlavePermission(slaveId, 'network_fetch')
    expect(result.ok).toBe(true)
    expect(await prisma.executionEvent.count({ where: { type: 'permission_changed' } })).toBe(0)
  })

  it('refuses a revoke of a kind outside the six, and of an unknown slave', async (): Promise<void> => {
    expect((await clearSlavePermission(slaveId, 'launch_nukes')).ok).toBe(false)
    expect((await clearSlavePermission('00000000-0000-4000-8000-000000000000', 'read_repo')).ok).toBe(false)
  })
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/control/test/integration/permission.test.ts`
Expected: FAIL — `clearSlavePermission` is not exported; `setSlavePermission` takes three parameters and writes no event.

- [ ] **Step 3: Write the two writers**

`packages/control/src/permission.ts`. Both verbs read the prior row FIRST — the event's `from` is the whole reason the row is read at all — and both append AFTER the write, outside any transaction:

```ts
/**
 * Grant or refuse one operation for one worker (M52 R1/R5).
 *
 * `principal` is the trailing optional parameter every event-appending control verb takes: the web
 * fills it from the session, the CLI passes nothing, and `carryOut` passes the approver's. It lands
 * on the ROW (`grantedBy`) as well as in the event, because the worker panel prints "Granted by X on
 * Y" from the row and a projection that had to join the event log for it would be a second reading.
 *
 * The read-before-write is not a race guard, it is the event: `from` is what a person needs to see a
 * month later, and `upsert` alone cannot report it. A concurrent flip would produce two events whose
 * `from` values agree with what each writer saw, which is the honest record of what happened.
 *
 * No event when nothing changed. A PUT that re-sends the same body is the same state -- that is what
 * PUT promises -- and an event per click would make the timeline a log of a person's mouse.
 */
export async function setSlavePermission(
  slaveId: string,
  kind: string,
  mode: 'allow' | 'deny',
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> { /* validate kind, validate mode, load slave + team.workspaceId + name, read prior row, upsert, append when changed */ }

/**
 * Take a decision back (M52 R5): the row is DELETED, and the kind returns to "never asked".
 *
 * The verb `setSlavePermission` never had. Under M18 it did not matter -- `allow` and unset resolved
 * identically -- and under default-deny the three states finally differ, so a person who granted
 * something in error needs a way back to the state before they did rather than a `deny` that reads
 * as a considered refusal.
 *
 * Deleting nothing is SUCCESS, not a refusal: DELETE is idempotent, the route behind it is a DELETE,
 * and "there was nothing to take back" is the caller's desired end state. No row, no change, no
 * event.
 */
export async function clearSlavePermission(
  slaveId: string,
  kind: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> { /* validate kind, load slave, read prior row, deleteMany, append when a row existed */ }
```

Both resolve the worker's `name` and its `team.workspaceId` in the same `findUnique` that checks existence — the event needs a workspace to be filed against and a name to print, and a second query for either would be a second reading of one row.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/control/test/integration/permission.test.ts`
Expected: PASS — the four Task-1 cases plus seven new ones.

- [ ] **Step 5: Write the failing integration test for the credential and the binding**

`packages/control/test/integration/credential.test.ts`:

```ts
describe('addCredential', () => {
  it('stores a NAME and an environment variable, and there is no column a value could go in', async (): Promise<void> => {
    const result = await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'FAKE_DEPLOY_TOKEN' })
    expect(result.ok).toBe(true)
    const row = await prisma.credential.findFirstOrThrow({ where: { workspaceId } })
    expect(row.envVar).toBe('FAKE_DEPLOY_TOKEN')
    expect(Object.keys(row)).toEqual(['id', 'workspaceId', 'name', 'kind', 'envVar', 'createdAt'])
  })

  it('refuses an envVar that is not a plausible environment variable name', async (): Promise<void> => {
    for (const bad of ['lower case', 'HAS-DASH', '1LEADING', '', 'A'.repeat(129)]) {
      expect((await addCredential(workspaceId, { name: `c-${bad}`, kind: 'api_key', envVar: bad })).ok, bad).toBe(false)
    }
  })

  it('refuses a second credential with the same name in one project, and allows it in another', async (): Promise<void> => {
    await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'A' })
    expect((await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'B' })).ok).toBe(false)
    expect((await addCredential(otherWorkspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'B' })).ok).toBe(true)
  })

  it('never reads the variable it names -- adding a credential for an unset variable succeeds', async (): Promise<void> => {
    delete process.env['NOT_SET_ANYWHERE']
    expect((await addCredential(workspaceId, { name: 'x', kind: 'api_key', envVar: 'NOT_SET_ANYWHERE' })).ok).toBe(true)
  })
})

describe('bindBrokerOp', () => {
  it('binds an op to argv and a credential by NAME', async (): Promise<void> => {
    await addCredential(workspaceId, { name: 'deploy', kind: 'deploy_token', envVar: 'FAKE_DEPLOY_TOKEN' })
    const result = await bindBrokerOp(workspaceId, {
      op: 'deploy_release',
      command: ['/abs/fake-deploy.sh'],
      credentialName: 'deploy',
    })
    expect(result.ok).toBe(true)
    const row = await prisma.brokerBinding.findFirstOrThrow({ where: { workspaceId } })
    expect(row.command).toEqual(['/abs/fake-deploy.sh'])
    expect(row.credentialId).not.toBeNull()
  })

  it('refuses an op the static manifest does not carry -- a binding for a verb nothing can run is a trap', async (): Promise<void> => {
    const result = await bindBrokerOp(workspaceId, { op: 'rm_rf', command: ['/bin/true'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('broker_refused')
  })

  it('refuses an empty argv, and a first element that is not an absolute path', async (): Promise<void> => {
    expect((await bindBrokerOp(workspaceId, { op: 'deploy_release', command: [] })).ok).toBe(false)
    expect((await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['fake-deploy.sh'] })).ok).toBe(false)
  })

  it('refuses a credential name this project does not have, with a 404-shaped refusal', async (): Promise<void> => {
    const result = await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['/bin/true'], credentialName: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('credential_not_found')
  })

  it('rebinds in place -- one binding per op per project', async (): Promise<void> => {
    await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['/bin/true'] })
    await bindBrokerOp(workspaceId, { op: 'deploy_release', command: ['/bin/false'] })
    const rows = await prisma.brokerBinding.findMany({ where: { workspaceId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.command).toEqual(['/bin/false'])
  })
})
```

- [ ] **Step 6: Run it and watch it fail, then write `credential.ts`**

Run: `npx vitest run packages/control/test/integration/credential.test.ts` → FAIL (module not found).

`packages/control/src/credential.ts` holds the four verbs. The three rules worth stating in its docstrings:

- **The value is never read here.** `addCredential` validates the NAME's shape (`/^[A-Z][A-Z0-9_]{0,127}$/`) and stores it. Whether the variable is set is a question for execution time, and answering it here would make "the operator has not exported it yet" a refusal to write a row that is otherwise correct — and would tempt a later version to report which variables are set, which is an enumeration oracle.
- **`command` is ARGV and its first element is absolute.** Not a shell string: the parameters a worker supplies never enter it, and argv is what makes that a property of the shape rather than of a quoting rule. An absolute first element because a relative one resolves against whatever cwd the daemon happens to have.
- **`op` is checked against `BROKERED_OPERATIONS`.** A binding for an op the manifest does not carry can never be invoked, so writing one is a row that looks like configuration and is not.

- [ ] **Step 7: Write the failing integration test for the authoriser**

`packages/control/test/integration/broker.test.ts`. The executor is a spy — control never spawns:

```ts
const executed: unknown[] = []
const executor: BrokerExecutor = async (input) => {
  executed.push(input)
  return { exitCode: 0, durationMs: 12, output: 'deployed' }
}

describe('runBrokeredOperation', () => {
  it('runs the bound command with the credential’s value, and returns the bounded output', async (): Promise<void> => {
    process.env['FAKE_DEPLOY_TOKEN'] = 'tok'
    const result = await runBrokeredOperation(
      { runToken: TOKEN, op: 'deploy_release', params: { environment: 'staging', digest: 'a1b2c3d' } },
      { execute: executor },
    )
    expect(result.ok).toBe(true)
    expect(executed).toEqual([
      {
        command: ['/abs/fake-deploy.sh'],
        env: { FAKE_DEPLOY_TOKEN: 'tok', SLAVEOFAI_BROKER_PARAM_ENVIRONMENT: 'staging', SLAVEOFAI_BROKER_PARAM_DIGEST: 'a1b2c3d' },
        timeoutMs: BROKER_TIMEOUT_MS,
      },
    ])
  })

  it('appends broker.executed with the environment verbatim, the params HASHED, and no output anywhere', async (): Promise<void> => {
    process.env['FAKE_DEPLOY_TOKEN'] = 'tok'
    await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: { environment: 'staging', digest: 'a1b2c3d' } }, { execute: executor })
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'broker_executed' } })
    expect(event.payload).toEqual({
      op: 'deploy_release',
      environment: 'staging',
      paramsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      exitCode: 0,
      durationMs: 12,
    })
    expect(event.runId).toBe(runId)
    const all = JSON.stringify(await prisma.executionEvent.findMany())
    expect(all).not.toContain('tok')
    expect(all).not.toContain('deployed')
    expect(all).not.toContain('/abs/fake-deploy.sh')
  })

  it('refuses an unknown token as identity_mismatch, and runs nothing', async (): Promise<void> => {
    const result = await runBrokeredOperation({ runToken: 'a'.repeat(64), op: 'deploy_release', params: PARAMS }, { execute: executor })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'broker_refused', op: 'deploy_release', reason: 'identity_mismatch' })
    expect(executed).toHaveLength(0)
  })

  it('refuses a token whose run is CONCLUDED as run_not_live', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: runId }, data: { status: 'succeeded' } })
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'run_not_live' })
  })

  it('refuses a worker without the grant as permission_denied, and records broker.refused', async (): Promise<void> => {
    await clearSlavePermission(slaveId, 'deploy_release')
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'permission_denied' })
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'broker_refused' } })
    expect(event.payload).toEqual({ op: 'deploy_release', reason: 'permission_denied' })
  })

  it('refuses an op with no binding in THIS project as not_brokered, even when another project has one', async (): Promise<void> => {
    await prisma.brokerBinding.deleteMany({ where: { workspaceId } })
    await bindBrokerOp(otherWorkspaceId, { op: 'deploy_release', command: ['/bin/true'] })
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'not_brokered' })
  })

  it('refuses when the bound credential’s variable is unset on this host, and never invents an empty one', async (): Promise<void> => {
    delete process.env['FAKE_DEPLOY_TOKEN']
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'credential_unset' })
    expect(executed).toHaveLength(0)
  })

  it('refuses parameters the manifest does not accept, naming nothing about them', async (): Promise<void> => {
    for (const params of [{ environment: 'https://evil', digest: 'a1b2c3d' }, { environment: 'staging' }, { environment: 'staging', digest: 'a1b2c3d', url: 'x' }]) {
      const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params }, { execute: executor })
      expect(result.ok, JSON.stringify(params)).toBe(false)
      if (!result.ok) expect(result.error).toMatchObject({ reason: 'invalid_params' })
    }
    expect(executed).toHaveLength(0)
  })

  it('refuses an op the manifest does not carry, before it reads a single row', async (): Promise<void> => {
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'rm_rf', params: {} }, { execute: executor })
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'not_brokered' })
  })

  it('refuses an ARCHIVED project as simulation -- nothing crosses, belt and braces', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } })
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, { execute: executor })
    if (!result.ok) expect(result.error).toMatchObject({ reason: 'simulation' })
  })

  it('records a NON-ZERO exit as an execution, not a refusal -- the operation ran and it failed', async (): Promise<void> => {
    process.env['FAKE_DEPLOY_TOKEN'] = 'tok'
    const result = await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: PARAMS }, {
      execute: async () => ({ exitCode: 3, durationMs: 5, output: 'boom' }),
    })
    expect(result.ok).toBe(true)
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'broker_executed' } })
    expect(event.payload).toMatchObject({ exitCode: 3 })
    expect(await prisma.executionEvent.count({ where: { type: 'broker_refused' } })).toBe(0)
  })

  it('hashes the params identically for two calls that asked for the same thing, and differently otherwise', async (): Promise<void> => {
    process.env['FAKE_DEPLOY_TOKEN'] = 'tok'
    await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: { environment: 'staging', digest: 'a1b2c3d' } }, { execute: executor })
    await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: { digest: 'a1b2c3d', environment: 'staging' } }, { execute: executor })
    await runBrokeredOperation({ runToken: TOKEN, op: 'deploy_release', params: { environment: 'prod', digest: 'a1b2c3d' } }, { execute: executor })
    const hashes = (await prisma.executionEvent.findMany({ where: { type: 'broker_executed' }, orderBy: { seq: 'asc' } }))
      .map((event) => event.payload.paramsHash)
    expect(hashes[0]).toBe(hashes[1])
    expect(hashes[2]).not.toBe(hashes[0])
  })
})
```

- [ ] **Step 8: Run it and watch it fail**

Run: `npx vitest run packages/control/test/integration/broker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 9: Write the authoriser**

`packages/control/src/broker.ts`. The order of the seven questions IS the design, and the docstring says why each one is where it is:

```ts
/**
 * How one brokered operation actually runs, injected (M52 R3).
 *
 * `packages/control` does not spawn -- `apps/orchestrator/src/broker.ts` holds the real one, built
 * on `runShellCommand`, which already has the process-GROUP kill, the 16 KiB output cap and the
 * drain grace that a second implementation would meet again one review at a time. The seam is the
 * `ModelDecider` shape (`simulation/llm.ts:25-26`), for its reason: the control layer hands out an
 * argv and a bounded environment and takes an outcome.
 *
 * `env` is the WHOLE environment of that child, not an addition to one: the credential and the two
 * parameters, and nothing else this process holds.
 */
export type BrokerExecutor = (input: {
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}) => Promise<{ readonly exitCode: number | null; readonly durationMs: number; readonly output: string }>

/**
 * Run a named operation on a worker's behalf, or refuse (M52 R3).
 *
 * SEVEN questions, in this order, and the order is load-bearing:
 *   1. Is this an op at all?          -- `not_brokered`, before a single row is read. An unknown
 *                                        verb must not become a database query a caller can time.
 *   2. Who is asking?                 -- `identity_mismatch`. The token is hashed and looked up on
 *                                        `SlaveRun.runTokenHash` (`@unique`), compared with
 *                                        `timingSafeEqual` over equal-length digests. Identity comes
 *                                        from the ENVIRONMENT THE PARENT SET, never from a field in
 *                                        the request line: a request that carries a `runId` is
 *                                        making a claim, and the claim is discarded in favour of
 *                                        the token's own answer. (The failure this avoids is a
 *                                        measured one elsewhere: a hook shim that let a
 *                                        payload-supplied agent id win over the trusted env var.)
 *   3. Is that run still live?        -- `run_not_live`. A concluded run has no worker to act for,
 *                                        and a token recovered afterwards is exactly what R4's
 *                                        rotation exists to kill.
 *   4. Is this real?                  -- `simulation`. Belt and braces: a simulated role is not a
 *                                        `Slave`, holds no `SlavePermission` and can reach no
 *                                        `SlaveRun`, so this arm should be unreachable -- and an
 *                                        archived or absent workspace answers it too, which is the
 *                                        reachable half.
 *   5. May this worker?               -- `permission_denied`, from `resolveGrants` over the SAME
 *                                        rows and the SAME run kind the gate resolved, so the broker
 *                                        and the hook can never disagree about one worker.
 *   6. Is anything bound here?        -- `not_brokered`, scoped to THIS workspace.
 *   7. Do the parameters fit, and is the secret present? -- `invalid_params`, then
 *                                        `credential_unset`. Parameters are parsed by the registry's
 *                                        own zod schema (strict), so a smuggled key is a refusal and
 *                                        not a silent drop.
 *
 * Every refusal is a RETURNED value and every one of them happens before the first write, so none of
 * them is inside a transaction -- a refusal after a write inside `$transaction` commits that write
 * unless it throws, and the way this function avoids that rule is by not needing it.
 *
 * The credential's value is read from `process.env[envVar]` HERE, one line before it is handed to
 * the executor, and is never assigned to anything that outlives the call: not a row, not an event,
 * not a log line, not the returned outcome.
 */
export async function runBrokeredOperation(
  input: { readonly runToken: string; readonly op: string; readonly params: unknown },
  deps: { readonly execute: BrokerExecutor },
): Promise<Result<BrokerOutcome, ControlRefusal>>
```

Two details the tests pin and the implementation must not improvise:

- **`broker.refused` is appended for every refusal that got far enough to name a run** (questions 3–7). Questions 1 and 2 have no run to file an event against and no workspace to file it in, so they refuse silently — a forged token that produced a timeline entry would let anyone who can write a line into a channel write into a project's history.
- **`paramsHash` is `sha256` of the canonical JSON of the PARSED params** (keys sorted), never of the raw input: two calls that asked for the same thing in a different key order are the same call, which is what the correlation is for.

- [ ] **Step 10: Run it and watch it pass**

Run: `npx vitest run packages/control/test/integration/broker.test.ts packages/control/test/integration/credential.test.ts`
Expected: PASS — 12 + 10 cases.

- [ ] **Step 11: The Supervisor's arm, the world's denials, and the boundary's third case**

`packages/control/src/supervisor.ts` — one arm in `carryOut`, reachable only through `applyDecision(decisionId, 'human', principal)` because `tierOf` returns `proposed` unconditionally:

```ts
    case 'request_permission':
      // The ONLY path by which a Supervisor decision reaches `SlavePermission`, and it is the far
      // side of a human approval. `setSlavePermission` does the rest -- including the event, with
      // the APPROVER as `by`, which is the true answer to "who granted this".
      return setSlavePermission(action.slaveId, action.permissionKind, 'allow', principal)
```

`packages/control/src/supervisorWorld.ts` — one loader, modelled on `loadLatestGuardrails` (`:271-285`):

```ts
/**
 * How often each worker has been refused each operation lately (M52 R5, plan erratum E9).
 *
 * The world holds no events, and `observe` is pure, so the counting happens here. One grouped read
 * over `run.tool_denied` inside `PERMISSION_DENIAL_WINDOW_MS`, keyed on the payload's `capability`
 * -- which is a `PermissionKind` in every row M52 writes, `'run tests'` in a row written before it,
 * and `ungoverned_tool` in a row no grant can fix. All three come back and `observe` filters the
 * last two: this query's job is counting, not judging.
 *
 * NOT CALLED AT ALL when the workspace has no run in the window, which is every tick of a project
 * nobody is working on.
 */
async function loadDenials(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  since: Date,
): Promise<readonly SupervisorDenial[]> {
  const rows = await tx.$queryRaw<
    { readonly slaveId: string; readonly kind: string; readonly count: bigint; readonly latestRunId: string | null }[]
  >`
    SELECT e."slaveId" AS "slaveId",
           e.payload->>'capability' AS kind,
           COUNT(*) AS count,
           (ARRAY_AGG(e."runId" ORDER BY e.seq DESC))[1] AS "latestRunId"
    FROM "ExecutionEvent" e
    WHERE e."workspaceId" = ${workspaceId}
      AND e.type::text = 'run.tool_denied'
      AND e.ts >= ${since}
      AND e."slaveId" IS NOT NULL
      AND e.payload->>'capability' IS NOT NULL
    GROUP BY e."slaveId", e.payload->>'capability'
  `
  return rows.map((row) => ({ slaveId: row.slaveId, kind: row.kind, count: Number(row.count), latestRunId: row.latestRunId }))
}
```

`packages/control/test/simulation-boundary.test.ts` gains its third assertion, over the two file sets it already walks:

```ts
    // M52 R6: the broker module by NAME, the way the case above names `@slave-of-ai/providers`.
    // A simulation reaches no real tool and therefore no real credential; the boundary is a source
    // scan rather than a convention because a convention is what a future refactor does not read.
    expect(source, `${file} mentions the broker or a credential`).not.toMatch(/broker|Credential|SLAVEOFAI_RUN_TOKEN/)
```

VERIFIED before writing it: neither `packages/simulation/src` nor `packages/control/src/simulation*.ts` contains any of those three strings today (`grep -rniE "broker|credential" packages/simulation/src packages/control/src/simulation.ts packages/control/src/simulation/` returns nothing; `tokens` DOES appear, for model usage, which is exactly why the pattern is `SLAVEOFAI_RUN_TOKEN` and not `token`).

`packages/control/src/refusal.ts` gains the two kinds (E5) with their text, and `apps/web/test/refusal-status.test.ts`'s `ALL_KINDS` gains the two keys with the comment that `credential_not_found` is 404 by the suffix rule and `broker_refused` is 409.

- [ ] **Step 12: Run the whole suite, then the ladder and the commit**

```bash
npx vitest run
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

Expected: PASS at or above the baseline. Then `npm run gate:m38-supervisor` — unchanged but for the number of actions the panel can render, and the gate that proves a proposal still waits for a person.

```bash
git add packages/control apps/web/test/refusal-status.test.ts
git commit -m "$(cat <<'EOF'
feat(control): m52 t3 — a grant has an author, a credential has no value, and a broker refuses seven ways

`setSlavePermission` records who decided and when, and there is finally a way to take a decision
back: a revoke deletes the row and returns the operation to "never asked", which is a different
state from a refusal and now behaves like one. Every change appends `permission.changed` with the
from/to/by triple a person reads months later; re-sending the same body writes nothing, because a
PUT that changed nothing is not a change.

`Credential` holds a name and an environment variable. Nothing in this file reads a secret except
one line of `runBrokeredOperation`, one statement before it hands it to an executor this package
does not own -- and the seven refusals in front of that line are ordered so that an unknown verb
never becomes a database query and a forged token never becomes a timeline entry. Identity comes
from the token the parent put in the child's environment; a `runId` in the request line is a claim,
and the claim is discarded.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 4: The channel — a daemon that serves it, a thin client that speaks it, and four verbs a person types (R3, R5, E5, E6, E15, D21–D26)

`apps/orchestrator` only. The worker's half of the broker is one CLI verb that writes a line and waits for a file; the system's half is one per-tick pass that reads lines and writes files. No port, no server, no second process, and no database in the child.

**Files:**
- Create: `apps/orchestrator/src/broker.ts`, `apps/orchestrator/test/integration/broker.test.ts`
- Modify: `apps/orchestrator/src/sweep.ts`, `apps/orchestrator/src/cli.ts`, `apps/orchestrator/test/integration/cli.test.ts`
- Test: `apps/orchestrator/test/integration/{broker,cli,sweep}.test.ts`

**Interfaces:**
- Consumes: `runBrokeredOperation`, `BrokerExecutor`, `addCredential`, `listCredentials`, `bindBrokerOp`, `listBrokerBindings`, `setSlavePermission`, `clearSlavePermission`, `grantsFor` (control/domain); `brokerChannelPathFor`, `brokerReplyPathFor` (providers); `runShellCommand`, `COMMAND_OUTPUT_LIMIT` (`apps/orchestrator/src/shell.ts`).
- Produces, for Tasks 5–6:
  - `serveBrokerRequests(deps)` and `realBrokerExecutor`
  - CLI: `broker run <op> --environment <e> --digest <d>`, `broker bind|list`, `credential add|list`, `permission grant|deny|revoke|list`
  - `SLAVEOFAI_BROKER_CLI` wired on both adapter options from `brokerCliPath()`

- [ ] **Step 1: Write the failing integration test for the server loop**

`apps/orchestrator/test/integration/broker.test.ts`:

```ts
describe('serveBrokerRequests', () => {
  it('serves one request and writes the reply beside it', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    await serveBrokerRequests({ workspaceId, execute: fakeExecutor })
    const reply = JSON.parse(readFileSync(brokerReplyPathFor(runDir, ID), 'utf8'))
    expect(reply).toEqual({ requestId: ID, ok: true, exitCode: 0, output: 'deployed', reason: null })
  })

  it('serves a request EXACTLY ONCE, however many times the pass runs -- the reply file is the key', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    await serveBrokerRequests({ workspaceId, execute: countingExecutor })
    await serveBrokerRequests({ workspaceId, execute: countingExecutor })
    await serveBrokerRequests({ workspaceId, execute: countingExecutor })
    expect(executions).toBe(1)
  })

  it('serves nothing twice after a DAEMON RESTART, which re-reads the channel from byte zero', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    await serveBrokerRequests({ workspaceId, execute: countingExecutor })
    resetCursors() // what a restart does to this module's in-memory offsets
    await serveBrokerRequests({ workspaceId, execute: countingExecutor })
    expect(executions).toBe(1)
  })

  it('REFUSES a line whose runId is not the directory it was found in (plan erratum E15)', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId: otherRunId, op: 'deploy_release', params: PARAMS, runToken: OTHER_TOKEN })
    await serveBrokerRequests({ workspaceId, execute: fakeExecutor })
    const reply = JSON.parse(readFileSync(brokerReplyPathFor(runDir, ID), 'utf8'))
    expect(reply).toMatchObject({ ok: false, reason: 'identity_mismatch' })
    expect(executions).toBe(0)
  })

  it('REFUSES a line carrying the wrong token, and says so in the reply the worker reads', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: 'a'.repeat(64) })
    await serveBrokerRequests({ workspaceId, execute: fakeExecutor })
    expect(JSON.parse(readFileSync(brokerReplyPathFor(runDir, ID), 'utf8'))).toMatchObject({
      ok: false,
      reason: 'identity_mismatch',
    })
  })

  it('ignores a line that is not JSON, a line over the cap, and a request id that is not 32 hex', async (): Promise<void> => {
    appendFileSync(brokerChannelPathFor(runDir), 'not json\n')
    appendFileSync(brokerChannelPathFor(runDir), `${JSON.stringify({ requestId: '../escape', runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })}\n`)
    appendFileSync(brokerChannelPathFor(runDir), `${'x'.repeat(9000)}\n`)
    await serveBrokerRequests({ workspaceId, execute: fakeExecutor })
    expect(readdirSync(runDir).filter((name) => name.startsWith('broker-'))).toHaveLength(0)
    expect(executions).toBe(0)
  })

  it('does not read the channel of a run that is over', async (): Promise<void> => {
    await prisma.slaveRun.update({ where: { id: runId }, data: { status: 'succeeded' } })
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    await serveBrokerRequests({ workspaceId, execute: fakeExecutor })
    expect(existsSync(brokerReplyPathFor(runDir, ID))).toBe(false)
  })

  it('serves two runs’ channels in one pass without crossing them', async (): Promise<void> => { /* … */ })

  it('never throws out of the pass, whatever the executor does', async (): Promise<void> => {
    appendRequest(runDir, { requestId: ID, runId, op: 'deploy_release', params: PARAMS, runToken: TOKEN })
    await expect(
      serveBrokerRequests({ workspaceId, execute: async () => { throw new Error('boom') } }),
    ).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(brokerReplyPathFor(runDir, ID), 'utf8'))).toMatchObject({ ok: false })
  })
})

describe('realBrokerExecutor', () => {
  it('runs argv with ONLY the environment it was handed -- no PATH inheritance of this process’s secrets', async (): Promise<void> => {
    process.env['LEAKED'] = 'yes'
    const outcome = await realBrokerExecutor({
      command: [ENV_DUMP_SCRIPT],
      env: { MARKER: 'here' },
      timeoutMs: 5_000,
    })
    expect(outcome.output).toContain('MARKER=here')
    expect(outcome.output).not.toContain('LEAKED')
  })

  it('bounds the output at COMMAND_OUTPUT_LIMIT, from the FRONT', async (): Promise<void> => { /* … */ })

  it('kills the process GROUP on timeout and reports a null exit code', async (): Promise<void> => { /* … */ })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/orchestrator/test/integration/broker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the server**

`apps/orchestrator/src/broker.ts`. The header states the threat model the way `permissions.sh` used to state its own — plainly, with what reduces it:

```ts
/**
 * The orchestrator's half of the capability broker (M52 R3): read the requests a worker appended,
 * authorise them through `packages/control`, run what survives, and write each answer back.
 *
 * THE CHANNEL IS A FILE, and that is a choice with a reason. `SLAVEOFAI_BROKER_CHANNEL` is the
 * FOURTH channel of the shape `SLAVEOFAI_PAUSE_FLAG`, `SLAVEOFAI_PERMISSIONS_FILE` and
 * `SLAVEOFAI_TOOL_RESULTS` already are: no port, no listener, no second process, and nothing to
 * authenticate against. The alternative the direction reached for -- a CLI that authenticates
 * against the database -- cannot exist: M52's own `CHILD_ENV_ALLOW` removes `DATABASE_URL` from the
 * child, so a process spawned in the worker's shell has no database, which is the entire point.
 *
 * IDENTITY, AND WHAT IT IS WORTH. A request line carries a run token, and `runBrokeredOperation`
 * resolves the run from that token alone -- so this pass adds the second half, which the token
 * cannot supply: a line whose `runId` is not the directory it was found in is refused
 * (`identity_mismatch`), and a reply is only ever written into the directory its request came from.
 * Without that, a token lifted from a sibling's channel could be replayed on the thief's OWN
 * channel and the operation's output delivered to the thief (plan erratum E15).
 *
 * WHAT IS LEFT, stated rather than implied: a run directory is 0700 under the same uid as every
 * other run on this host, so a worker that enumerates `<state>/slaveofai/runs/` and reads a
 * sibling's channel -- after that sibling has made at least one request -- can act as that sibling
 * ON ITS OWN CHANNEL. Three things reduce it and none of them removes it: the directories are named
 * by uuid, they are outside every worktree a worker can see (M52 R4, which is what made that true),
 * and a served request cannot be replayed, because its reply file is its idempotency key.
 *
 * IDEMPOTENCY IS THE FILE. This module keeps an in-memory byte offset per channel, and that offset
 * is an optimisation, never the correctness: a daemon restart re-reads every channel from byte zero,
 * and what stops a second execution is that `broker-<requestId>.json` already exists. Two daemons
 * serving one channel would race on that existence check; the design's answer is the one this
 * repository already relies on for every run -- one daemon per workspace.
 *
 * NOTHING HERE THROWS OUT OF A TICK. This runs inside `sweep()`, which runs inside the daemon's
 * tick. Every read is `try`/`catch`, an unparseable line is skipped (never a reply -- a line that is
 * not a request has no `requestId` to answer), and an executor that throws becomes a refused reply
 * rather than a dead daemon.
 */
```

The shape:

```ts
/** One line a worker may append. Bounded before it is parsed: a peer that never sends a newline is
 *  otherwise an unbounded memory sink, so the read is capped at `CHANNEL_READ_MAX_BYTES` per pass
 *  and any single line over `REQUEST_LINE_MAX_BYTES` is DROPPED rather than truncated -- the
 *  `tool-result-tap.sh` rule (`:39-43`), for its reason: half a request is not a request. */
const REQUEST_LINE_MAX_BYTES = 8 * 1024
const CHANNEL_READ_MAX_BYTES = 256 * 1024

const requestSchema = z
  .object({
    requestId: z.string().regex(/^[a-f0-9]{32}$/u),
    runId: z.string().min(1),
    runToken: z.string().regex(/^[0-9a-f]{64}$/u),
    op: z.string().min(1).max(64),
    params: z.record(z.string(), z.unknown()),
  })
  .strict()

export async function serveBrokerRequests(deps: {
  readonly workspaceId: WorkspaceId
  readonly execute?: BrokerExecutor
}): Promise<void>
```

and `realBrokerExecutor`:

```ts
/**
 * The one place a brokered operation actually runs.
 *
 * Through `runShellCommand` (`./shell.ts`) rather than a second spawn implementation: it already
 * has the process-GROUP kill (a `setsid`'d child of a deploy script outliving its parent is exactly
 * the leak it was written for), the 16 KiB output cap bounded from the FRONT, the drain grace and
 * the stdin EOF. A second implementation would meet all four again, one review at a time.
 *
 * `command` is ARGV and is quoted into a single shell word list here -- the PARAMETERS never enter
 * the string at all. They ride in the environment as `SLAVEOFAI_BROKER_PARAM_<NAME>`, which is what
 * makes "a parameter cannot become a token in a command line" a property of the shape rather than of
 * a regex. (The registry's regexes are still there, and are the second lock: the measured failure
 * this avoids is a parent that re-serialised its selection into a flat unquoted flag string and gave
 * its child a different capability set than it intended.)
 *
 * `env` is the child's WHOLE environment. Not `{...process.env, ...env}`: the daemon's environment
 * is the one place every operator secret on this host lives, and a deploy script does not need any
 * of it except the one credential it was bound to. `PATH` is the single exception and is taken from
 * `CHILD_ENV_ALLOW`'s own reasoning -- argv[0] is absolute, but the script it names will want to
 * find `sh`.
 */
export const realBrokerExecutor: BrokerExecutor = async (input) => { /* shellQuote(argv), runShellCommand, measure durationMs */ }

/** Single-quote one argv element for `/bin/sh -c`. Three lines, its own test, and it exists because
 *  the alternative -- trusting that no bound command ever contains a space -- is the kind of
 *  assumption that holds until an operator's path has one in it. */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}
```

- [ ] **Step 4: Run it and watch it pass, then wire the pass into the tick**

Run: `npx vitest run apps/orchestrator/test/integration/broker.test.ts` → PASS (12 cases).

`apps/orchestrator/src/sweep.ts` calls it ONCE per sweep, before the per-run loop and outside it:

```ts
  // M52 R3: the broker's pass. Before the per-run loop rather than inside it -- it reads every live
  // run's channel in one go, and a worker waiting on a reply must not be made to wait for a
  // breaker beat or a worktree probe. It never throws (its own docstring), so it is not wrapped.
  await serveBrokerRequests({ workspaceId: deps.workspaceId })
```

and `SweepReport` gains `brokerServed: readonly string[]` — the request ids served this pass, empty on every tick of a project that has never used the broker, which is nearly all of them. `sweep.test.ts` gains one case asserting an untouched project's pass does no file I/O it did not have to (`brokerServed` is empty and no `broker-*.json` appears anywhere).

- [ ] **Step 5: Write the failing CLI tests**

`apps/orchestrator/test/integration/cli.test.ts`:

```ts
  it('`permission list` prints every operation, its word, and where its answer came from', async (): Promise<void> => {
    const output = await runCli(['permission', 'list', '--slave', slaveId])
    expect(output).toContain('Fetch over the network')
    expect(output).toContain('baseline')
    // The key is there too -- `docs/ia.md` rule 3 keeps the raw value available, and a CLI's
    // "expanded view" is the line itself.
    expect(output).toContain('network_fetch')
  })

  it('`permission grant` writes the row and the event, and names the operator', async (): Promise<void> => {
    await runCli(['permission', 'grant', '--slave', slaveId, '--kind', 'network_fetch', '--by', 'meren'])
    expect(await prisma.slavePermission.count({ where: { slaveId, kind: 'network_fetch', mode: 'allow' } })).toBe(1)
  })

  it('`permission revoke` takes it back to unset', async (): Promise<void> => { /* … */ })

  it('`permission grant --kind nonsense` refuses with the verb’s own sentence', async (): Promise<void> => {
    await expect(runCli(['permission', 'grant', '--slave', slaveId, '--kind', 'nonsense'])).rejects.toThrow(
      'a permission must name one of the six operations',
    )
  })

  it('`credential add` stores a name and a variable, and prints neither a value nor whether one is set', async (): Promise<void> => {
    const output = await runCli(['credential', 'add', '--name', 'deploy', '--kind', 'deploy_token', '--env-var', 'FAKE_DEPLOY_TOKEN'])
    expect(output).not.toContain(process.env['FAKE_DEPLOY_TOKEN'] ?? 'IMPOSSIBLE')
  })

  it('`credential list` prints the variable NAME and never reads it', async (): Promise<void> => { /* … */ })

  it('`broker bind` refuses an op the manifest does not carry', async (): Promise<void> => { /* … */ })

  it('`broker run` writes ONE request line carrying no secret but the token, and exits on the reply', async (): Promise<void> => {
    // The client is driven directly, with the three environment variables a real child would have
    // and NO DATABASE_URL -- which is the whole reason this verb is a file client and not a
    // database one.
    const output = await runCliWithEnv(
      ['broker', 'run', 'deploy_release', '--environment', 'staging', '--digest', 'a1b2c3d'],
      { SLAVEOFAI_BROKER_CHANNEL: channelPath, SLAVEOFAI_RUN_ID: runId, SLAVEOFAI_RUN_TOKEN: TOKEN, PATH: process.env['PATH'] },
      { replyAfterMs: 200, reply: { requestId: null, ok: true, exitCode: 0, output: 'deployed', reason: null } },
    )
    expect(output).toContain('deployed')
    const line = JSON.parse(readFileSync(channelPath, 'utf8').trim())
    expect(Object.keys(line).sort()).toEqual(['op', 'params', 'requestId', 'runId', 'runToken'])
  })

  it('`broker run` exits NON-ZERO with the refusal’s word when the reply refuses', async (): Promise<void> => { /* … */ })

  it('`broker run` refuses to start with no channel in its environment, naming the variable', async (): Promise<void> => {
    await expect(runCliWithEnv(['broker', 'run', 'deploy_release', '--environment', 'staging', '--digest', 'a1b2c3d'], {})).rejects
      .toThrow(/SLAVEOFAI_BROKER_CHANNEL/)
  })
```

- [ ] **Step 6: Write the four verbs**

`apps/orchestrator/src/cli.ts`. Three of them are ordinary control-verb cases in the shape the file has fifty of; the fourth is different and its docstring says how:

```ts
    /**
     * The WORKER'S OWN verb (M52 R3), and the only case in this file that touches no database.
     *
     * It writes one bounded line to `SLAVEOFAI_BROKER_CHANNEL` with `O_APPEND` -- atomic below
     * PIPE_BUF, which is why the line is capped -- then polls for `broker-<requestId>.json` up to
     * `BROKER_CLIENT_TIMEOUT_MS`, prints the bounded output and exits with the operation's own
     * status. It needs no secret, no port and no server, and it CANNOT reach the database: M52's
     * `CHILD_ENV_ALLOW` removes `DATABASE_URL` from every worker's environment, which is what makes
     * a database client impossible here and a file client sufficient.
     *
     * The client waits LONGER than the server runs (`BROKER_CLIENT_TIMEOUT_MS` > `BROKER_TIMEOUT_MS`,
     * pinned by a domain test): a client that gave up first would report "no answer" for an
     * operation that had in fact run, which is the one failure an audit trail cannot recover from.
     *
     * No hook rule is needed for the `Bash` call that invokes this: `run_commands` is in the
     * implementer baseline, so the call is already allowed, and command-string inspection stays out
     * of scope exactly as M18 ruled.
     */
    case 'broker': { /* `run` | `bind` | `list` */ }
```

`brokerCliPath()` joins `hookPath()` and `tapPath()` in the same block of this file, and `buildAdapterRegistry` passes it to both adapters:

```ts
/**
 * The CLI a worker's thin broker client runs (M52 erratum E6). THIS FILE: `import.meta.url` is
 * `dist/cli.js`, which is precisely the entry `node` must be given -- there is no `orchestrator`
 * binary on anybody's PATH, and `package.json`'s `orchestrator` script is an npm alias for this
 * same path. Overridable for `hookPath()`'s reason: an installed daemon's layout is not this one.
 */
function brokerCliPath(): string {
  const fromEnv = process.env['SLAVEOFAI_BROKER_CLI']
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  return fileURLToPath(import.meta.url)
}
```

- [ ] **Step 7: Run the CLI tests and watch them pass**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts`
Expected: PASS — the file's existing cases plus ten.

- [ ] **Step 8: Prove the routing did NOT move**

One grep and one assertion, because the easiest way to break M18 in this milestone is to "improve" the denial path while working next to it:

```bash
git diff --stat apps/orchestrator/src/pump.ts packages/providers/src/gate.ts
```

Expected: **empty**. Neither file is in this task's list, `run.tool_denied` is emitted from the same two sites with the same payload shape, and `classifyGateEvent`'s `permission_denied` omission stands (`gate.ts:103-111`, "Do not 'fix' this omission"). Say so in the task report.

- [ ] **Step 9: Ladder and commit**

```bash
npx vitest run
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

then, one at a time:

```bash
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m18-skill-and-teeth

npm run gate:m35-pipeline-honesty
npm run gate:m51-breaker
```

Expected: all three green. `gate:m51-breaker` is the one to watch: this task adds a pass to `sweep()`, and M51's breaker lives in the same function — a broker pass that threw, or that took a lock, would show up as a rung that did not climb.

```bash
git add apps/orchestrator
git commit -m "$(cat <<'EOF'
feat(orchestrator): m52 t4 — a worker asks by name, and the answer is a file in a directory it owns

The broker's channel is the fourth file channel of a shape this repository already has three of: a
worker appends one bounded line and waits for a reply beside it, and nothing listens on a port. That
is not a convenience, it is forced -- `CHILD_ENV_ALLOW` takes `DATABASE_URL` off the child, so the
CLI the worker runs has no database to authenticate against, which is the property the whole
milestone is built on.

The pass that serves it refuses a line whose run id is not the directory it was found in, writes
every reply into the directory its request came from, and serves each request exactly once because
the reply file is the idempotency key -- so a daemon restart, which re-reads every channel from byte
zero, executes nothing twice. What is left is written down in the module's own header rather than
implied: a worker that enumerates sibling run directories can act as a sibling on that sibling's own
channel, and the three things that reduce it are named beside it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 5: Two words for two things — a per-worker list, a matrix in the new vocabulary, one URL space and three cards (R7, E2, E14, D27–D31)

`apps/web` only. Nothing here decides anything: every glyph, sentence and source word is `grantsFor`'s answer, computed server-side by the same function the gate's resolution is built on, so a surface cannot claim a permission the hook does not honour.

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/permissions/[kind]/route.ts`, `apps/web/test/permission-matrix.test.tsx`
- Delete: `apps/web/src/app/api/slaves/[slaveId]/permission/route.ts`
- Modify: `apps/web/src/components/ui/DetailsGroup.tsx`, `apps/web/src/components/SlavePanel.tsx`, `apps/web/src/components/PermissionMatrix.tsx`, `apps/web/src/components/activity/cards.tsx`, `apps/web/src/components/SupervisorPanel.tsx`, `apps/web/src/server/{settings,overview,timeline}.ts`, `apps/web/src/lib/activityFilters.ts`, `docs/ia.md`
- Test: `apps/web/test/{permission-matrix,slave-panel,activity-cards,activityFilters,supervisor-panel}.test.tsx`, `apps/web/test/integration/slave-routes.test.ts`

**Interfaces:**
- Consumes: `PERMISSION_KINDS`, `PERMISSION_LABEL`, `TOOL_DENIED_LABEL`, `BROKER_OP_LABEL`, `BROKER_REFUSAL_LABEL`, `grantsFor` (all from `@slave-of-ai/domain`, which `apps/web` depends on directly — `@slave-of-ai/control` is a SERVER-only import here and `PermissionMatrix` is a client component).
- Produces, for Task 6: the testids `perm-cell-<slaveId>-<kind>`, `perm-column`, `perm-caption`, `panel-permission-<kind>`, `panel-permission-source-<kind>`, `broker-executed-text`, `broker-refused-text`, `permission-changed-text`; the two routes.

- [ ] **Step 1: Write the failing component test for the worker panel's permissions group**

`apps/web/test/slave-panel.test.tsx` gains a describe:

```tsx
describe('SlavePanel permissions (M52 R7)', () => {
  const slave = makeSlave({
    permissions: [
      { kind: 'read_repo', mode: null, source: 'baseline', by: null, at: null },
      { kind: 'write_repo', mode: null, source: 'baseline', by: null, at: null },
      { kind: 'run_commands', mode: 'deny', source: 'refused', by: 'meren', at: '2026-09-12T09:00:00.000Z' },
      { kind: 'network_fetch', mode: 'allow', source: 'granted', by: 'meren', at: '2026-09-12T10:00:00.000Z' },
      { kind: 'read_secret', mode: null, source: 'never', by: null, at: null },
      { kind: 'deploy_release', mode: null, source: 'never', by: null, at: null },
    ],
  })

  it('renders one line per operation, in the domain’s order, once the group is open', async () => {
    render(<SlavePanel slave={slave} {...rest} />)
    await userEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    const lines = screen.getAllByTestId(/^panel-permission-/u)
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual([...PERMISSION_KINDS])
  })

  it('prints the WORD and keeps the key on data-kind and in title (docs/ia.md rule 3)', async () => {
    render(<SlavePanel slave={slave} {...rest} />)
    await userEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    const line = screen.getByTestId('panel-permission-network_fetch')
    expect(line).toHaveTextContent('Fetch over the network')
    expect(line).not.toHaveTextContent('network_fetch')
    expect(line.getAttribute('title')).toBe('network_fetch')
  })

  it('draws the three glyphs the matrix has always drawn, and a baseline reads as granted', async () => {
    render(<SlavePanel slave={slave} {...rest} />)
    await userEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.getByTestId('panel-permission-network_fetch')).toHaveTextContent('✓')
    expect(screen.getByTestId('panel-permission-run_commands')).toHaveTextContent('✕')
    expect(screen.getByTestId('panel-permission-read_secret')).toHaveTextContent('–')
    // A baseline is a ✓: the run really may do it, and a glyph that said otherwise would be the
    // surface disagreeing with the gate.
    expect(screen.getByTestId('panel-permission-read_repo')).toHaveTextContent('✓')
  })

  it('says WHO and WHEN under Advanced, and nothing at all until it is opened', async () => {
    render(<SlavePanel slave={slave} {...rest} />)
    await userEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    expect(screen.queryByTestId('panel-permission-source-network_fetch')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByTestId('panel-permission-source-network_fetch')).toHaveTextContent('Granted by meren on 12 Sep 2026')
    expect(screen.getByTestId('panel-permission-source-run_commands')).toHaveTextContent('Refused by meren on 12 Sep 2026')
    expect(screen.getByTestId('panel-permission-source-read_repo')).toHaveTextContent('Baseline (implementation runs)')
    expect(screen.getByTestId('panel-permission-source-read_secret')).toHaveTextContent('Never granted')
  })

  it('says the two broker grants are not tools', async () => {
    render(<SlavePanel slave={slave} {...rest} />)
    await userEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByTestId('panel-permission-source-deploy_release')).toHaveTextContent('a brokered operation, not a tool')
  })

  it('sits between Skills and Messages, and arrives CLOSED like every group but Run', async () => {
    render(<SlavePanel slave={slave} {...rest} />)
    const groups = screen.getAllByTestId('details-group').map((node) => node.getAttribute('data-group'))
    expect(groups.slice(groups.indexOf('skills'), groups.indexOf('messages') + 1)).toEqual(['skills', 'permissions', 'messages'])
    expect(screen.getByTestId('details-group-permissions')).toHaveAttribute('data-open', 'false')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/web/test/slave-panel.test.tsx`
Expected: FAIL — no `Permissions` button; `SlaveCardData` has no `permissions`.

- [ ] **Step 3: Write the group, the read that feeds it, and the group name**

`apps/web/src/components/ui/DetailsGroup.tsx` — one member, with the comment the file's own history style uses:

```ts
  // M52 R7: what this worker MAY DO. The seventeenth of R6's groups, and deliberately not
  // `capabilities` (which is already a member, and which answers what a worker is FOR): two words
  // for two things, because a taxonomy key and a permission kind are different objects and the one
  // surface where a person meets both must not call them one.
  | 'permissions'
```

`apps/web/src/server/overview.ts` — `SlaveCardData` gains one field, computed by the domain:

```ts
  /**
   * What this worker may do, per operation, with where each answer CAME FROM (M52 R7).
   *
   * `grantsFor(rows, runKind)` -- the projection beside the resolver the gate's own
   * `permissions.json` is built by, so the panel cannot show a ✓ on something the hook refuses.
   *
   * The run kind is the LIVE run's when there is one and `implementation` otherwise, and that
   * choice is visible in the sentence the panel prints ("Baseline (implementation runs)"): a
   * baseline is a fact about a run, not about a worker, and a panel that showed a worker's
   * permissions with no run in sight has to say which kind of run it is answering for.
   */
  readonly permissions: readonly KindGrant[]
```

fed from the existing slave query by adding `permissions: { select: { kind: true, mode: true, grantedBy: true, grantedAt: true } }` to the `include` that is already there — **not a second query**: `workspaceStats`' one-reading discipline, and the same `include` already carries `runs`.

`apps/web/src/components/SlavePanel.tsx` — the group between `skills` and `messages`, with a nested Advanced:

```tsx
      {/* M52 R7. The list is what a person needs at a glance; WHO decided and WHEN is a raw value,
        * so it lives under Advanced -- `docs/ia.md` rule 5, and `OverviewAdvanced`'s own rule that
        * a closed disclosure must cost nothing. NESTED rather than a sibling group, because the
        * sentences are about these six lines and nothing else on this panel. */}
      <DetailsGroup group="permissions" title="Permissions">
        <ul className="flex flex-col gap-1">
          {slave.permissions.map((grant) => (
            <li
              key={grant.kind}
              data-testid={`panel-permission-${grant.kind}`}
              data-kind={grant.kind}
              data-mode={grant.mode ?? 'unset'}
              data-source={grant.source}
              title={grant.kind}
              className="flex items-baseline gap-2 text-xs"
            >
              <span className={GLYPH_CLASS[glyphFor(grant)]}>{GLYPH[glyphFor(grant)]}</span>
              <span className="text-text-2">{PERMISSION_LABEL[grant.kind]}</span>
            </li>
          ))}
        </ul>
        <DetailsGroup group="advanced" title="Advanced">
          {/* … one `panel-permission-source-<kind>` line per grant, from `sourceSentence(grant)` … */}
        </DetailsGroup>
      </DetailsGroup>
```

with the two pure helpers spelled once, at the top of the file:

```tsx
/** A BASELINE is a ✓ (the run really may do it) and `never` is a `–`. Three glyphs, the same three
 *  `PermissionMatrix` has drawn since M14 -- one vocabulary, two surfaces. */
function glyphFor(grant: KindGrant): 'allow' | 'deny' | 'unset' {
  if (grant.mode === 'deny') return 'deny'
  return grant.mode === 'allow' || grant.source === 'baseline' ? 'allow' : 'unset'
}

/** The policy sentence, and the one place this panel says anything a person did not do. The two
 *  broker grants say what they are, because a ✕ on a row that names no tool would otherwise read as
 *  a tool this worker cannot use. */
function sourceSentence(grant: KindGrant): string { /* four arms + the brokered suffix */ }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run apps/web/test/slave-panel.test.tsx`
Expected: PASS — six new cases and every case the file already had.

- [ ] **Step 5: Write the failing test for the matrix in the new vocabulary**

`apps/web/test/permission-matrix.test.tsx` (new — the component has had no test of its own; its behaviour was covered only by `gate:m16`'s glyph read):

```tsx
describe('PermissionMatrix (M52 R7)', () => {
  it('has one column per operation, printing the WORD with the key on data-kind', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    const columns = screen.getAllByTestId('perm-column')
    expect(columns.map((column) => column.textContent)).toEqual([
      'Read the repository', 'Write source', 'Run commands', 'Fetch over the network', 'Read a secret', 'Deploy a release',
    ])
    expect(columns.map((column) => column.getAttribute('data-kind'))).toEqual([...PERMISSION_KINDS])
  })

  it('keeps the three glyphs and their data-mode, which gate:m16 reads', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    expect(screen.getByTestId('perm-cell-slave-1-network_fetch')).toHaveAttribute('data-mode', 'allow')
    expect(screen.getByTestId('perm-cell-slave-1-read_secret')).toHaveAttribute('data-mode', 'unset')
  })

  it('PUTs to the scoped route, with the kind in the PATH and only the mode in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)
    render(<PermissionMatrix sections={SECTIONS} />)
    await userEvent.click(screen.getByTestId('perm-cell-slave-1-read_secret'))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/w/workspace-1/slaves/slave-1/permissions/read_secret')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ mode: 'allow' })
  })

  it('cycles unset → allow → deny → unset, so a person can take a decision back from the grid', async () => {
    /* three clicks, three requests: PUT allow, PUT deny, DELETE */
  })

  it('says what the matrix means NOW, and no longer says it is unenforced', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    const caption = screen.getByTestId('perm-caption')
    expect(caption).not.toHaveTextContent('not yet enforced')
    expect(caption).toHaveTextContent('Anything not granted is refused')
  })

  it('says the Cursor limitation and the brokered-operation fact, in the copy rather than implicitly', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    expect(screen.getByTestId('perm-note')).toHaveTextContent('On Cursor only the shell is enforced')
    expect(screen.getByTestId('perm-note')).toHaveTextContent('a brokered operation, not a tool')
  })
})
```

- [ ] **Step 6: Move the matrix, its copy and its URL**

`apps/web/src/server/settings.ts` — `PermissionRow.cells` becomes `{ kind, mode }` (Task 1 left the field named `tool` for exactly one task) and the section carries the workspace id it already has. `apps/web/src/components/PermissionMatrix.tsx`:

- the header cell prints `PERMISSION_LABEL[cell.kind]` with `data-kind={cell.kind}` and `title={cell.kind}`;
- `grid(columns)` is untouched — it already sizes from the row's own cells, which is why six columns of longer words cost nothing;
- `flip()` becomes `next()`, a three-state cycle, and its docstring records that the old two-state version "treats unset as not allowed", which disagreed with M18's enforcement and agrees with M52's — *"correct by accident until this milestone, and correct on purpose now"*;
- the write targets `` `/api/w/${section.workspaceId}/slaves/${slaveId}/permissions/${kind}` `` with `PUT { mode }` or `DELETE`;
- the two contradicting captions (E14) are replaced by one `perm-caption` (the testid three gates read) plus one `perm-note`:
  - caption: `Anything not granted is refused. A run's own kind grants the basics — reading, and for implementation runs writing and commands — and everything else is a decision.`
  - note: `Edits reach a run the next time it starts or resumes, never one already in flight. On Cursor only the shell is enforced, so a mark on any other row is advisory there. 'Read a secret' and 'Deploy a release' are brokered operations, not tools: they let the orchestrator act for this worker, and the worker never holds the credential.`

`apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/permissions/[kind]/route.ts` — new, in the `{profile,runtime-roles,lifecycle,release}` family behind `slaveControlResponse` (M50 erratum E8's ruling), with `PUT` and `DELETE`:

```ts
/**
 * One operation's answer for one worker (M52 R7).
 *
 * The kind is in the PATH and the mode is the whole body, because the path names the resource: a
 * PUT sets this cell and a DELETE takes the decision back, which is exactly the three states the
 * matrix draws. The legacy unscoped `/api/slaves/[slaveId]/permission` route is DELETED and this
 * is where it went -- `docs/ia.md` rule 2 (nothing is removed, only moved), and M50 erratum E8's
 * ruling that a verb addressed at one worker belongs in the workspace-scoped family, where
 * `slaveControlResponse` 404s a worker in another project before the verb is ever called.
 */
```

The deleted route's own test coverage moves with it: `apps/web/test/integration/slave-routes.test.ts` gains the PUT, the DELETE, the 404 for another project's worker and the 400 for a body that is not `{ mode }`.

- [ ] **Step 7: Run the two web suites and watch them pass**

Run: `npx vitest run apps/web/test/permission-matrix.test.tsx apps/web/test/slave-panel.test.tsx`
Expected: PASS — six + six cases.

Then: `grep -rn "api/slaves/" apps/web/src | grep -v node_modules` → **no hits**. One row, one URL space.

- [ ] **Step 8: The three cards, the two filters and the two sentences**

`apps/web/src/components/activity/cards.tsx`:

```tsx
// ---- broker.executed / broker.refused / permission.changed (schema.ts, M52 R3/R5) ---------------

function BrokerExecutedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { op: string; environment: string; exitCode: number | null }
  return (
    <ActivityCard {...props}>
      <Transition tone={payload.exitCode === 0 ? 'ok' : 'warn'} label="brokered">
        <span data-testid="broker-executed-text" data-op={payload.op}>
          {`${BROKER_OP_LABEL[payload.op] ?? payload.op} → ${payload.environment} · exit ${String(payload.exitCode ?? '—')}`}
        </span>
      </Transition>
    </ActivityCard>
  )
}
```

with `BrokerRefusedCard` (tone `blocked`, `` `${label} refused — ${BROKER_REFUSAL_LABEL[reason] ?? reason}` ``) and `PermissionChangedCard` (tone `ok` for a grant, `warn` for a refusal, `dim` for a revoke; text `` `${name} · ${kindLabel} · ${verb}` ``, with the key on `data-kind`).

And **the card E2 earns**: `RunToolDeniedCard` stops printing the payload's raw `capability` and prints `TOOL_DENIED_LABEL[payload.capability] ?? payload.capability` — the `?? ` fallback is not decoration, it is the asymmetry the schema chose (the payload is a `z.string()` so the log stays readable, and a pre-M52 row spelling `run tests` prints itself rather than crashing the feed). Its testid and tone do not move; `gate:m18`'s text assertion moves with the fixture in Task 6.

`apps/web/src/lib/activityFilters.ts`: both broker types join `tool_calls` (R3 — they are per-call activity, and a person filtering "what stopped work" must not receive them); `permission.changed` joins `workspace`, beside `org.changed` and `slave.runtime_roles_changed`, for their reason: it is a change to the project's configuration, it carries no taskId, and it is not a run outcome.

`apps/web/src/server/timeline.ts` gains three sentences in the shape the file already uses. `apps/web/src/components/SupervisorPanel.tsx`'s `actionText` gains the `request_permission` arm, printing `kindLabel` and the worker's `name` and never the key.

`apps/web/test/activity-cards.test.tsx`'s `PAYLOAD_BY_TYPE` gains three entries (that record is exhaustive over `DomainEventType`, so the build is red until it does), and `activityFilters.test.ts`'s runtime exhaustiveness check covers the rest.

- [ ] **Step 9: `docs/ia.md`**

Three Later cells, in the shape M47–M50 used:

- `/w/:id/settings` — `M52 turns the permission matrix into six OPERATIONS with words for column headers, a third click that takes a decision back, and copy that says what is enforced where instead of saying it is not enforced at all.`
- The `SlavePanel` paragraph under "Panels that stay where they are, deliberately" — one sentence naming the new group and that its policy sentences are under Advanced.
- `/w/:id/activity` — `M52 adds the two brokered-operation cards and the permission change, and the tool-denial card finally prints the operation's name instead of its key.`

- [ ] **Step 10: Build, browse, and commit**

```bash
pgrep -af "next dev"        # must be empty; kill what you find and SAY SO in the report
npm run web:build
npx vitest run apps/web
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" npm run gate:m44-ux-foundation
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" npm run gate:m16-chrome
```

Expected: the build clean, `apps/web` green, and both browser gates green. `gate:m16-chrome` check 2 is the one this task could have broken: it reads `[data-testid^="perm-cell-"]` and each cell's `data-mode`, then asserts the unset and deny glyphs differ. Both survive — the testid's PREFIX and the attribute are unchanged and only the suffix's vocabulary moved — and if it fails, the component dropped `data-mode`, not the gate being stale.

```bash
git add apps/web docs/ia.md
git commit -m "$(cat <<'EOF'
feat(web): m52 t5 — six operations, three glyphs, one URL space, and a card that says the word

A worker's panel finally answers "what may this one do": six lines, the three marks the matrix has
drawn since M14, and — under Advanced, where a raw value belongs — who decided each one and when,
or that nobody did and the run kind is what says yes. The Settings matrix moves to the same
vocabulary, gains a third click that takes a decision back, and stops carrying two captions that
contradicted each other and a third contradiction in its server module: it says what is enforced,
where Cursor cannot enforce it, and that two of the six are brokered operations rather than tools.

The permission route joins the family every other per-worker verb is already in, so a cross-project
id reads back as "no such slave" rather than as a permission somebody else's worker now has. And the
tool-denial card prints the operation's NAME: the payload still carries the key, because the log has
to stay readable when a spelling changes, and the label table is what a person sees.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 6: `gate:m52-broker`, the fourth fake, the fixture's one redaction, CI, the README, the screenshots — and the full verification ladder (R8, E4, E10, D32–D36)

**Files:**
- Create: `scripts/gate-fakes/fake-deploy.sh`, `scripts/gate-m52-broker.mjs`
- Modify: `packages/providers/test/fake-claude.mjs`, `packages/providers/test/fixtures/permission-matrix-deny.ndjson`, `packages/providers/test/fixtures/README.md`, `scripts/gate-m18-skill-and-teeth.mjs`, `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/superpowers/fidelity/m14/{overview,project-settings}.png`
- Test: the gate itself, plus `packages/providers/test/fake-claude.test.ts` (the fixture-shape invariant) and the whole ladder

**Interfaces:**
- Consumes: everything Tasks 1–5 produced.
- Produces: `npm run gate:m52-broker`, CI's 27th step, the README's 27.

- [ ] **Step 1: The fourth fake**

`scripts/gate-fakes/fake-deploy.sh` — the first fake in this directory that is not a CLI stand-in, and its header says what it IS:

```bash
#!/usr/bin/env bash
# A zero-spend stand-in for a real deployment, for `scripts/gate-m52-broker.mjs`.
#
# The FOURTH fake in this directory and the first that is not a vendor-CLI stand-in: the other three
# pretend to be a worker, and this pretends to be the thing a worker is not allowed to touch. It is
# what a `BrokerBinding.command` points at, so the gate can prove the whole path -- a worker naming
# an operation, the orchestrator resolving a credential the worker cannot see, and something on the
# far side receiving it -- without a remote, a cloud account or a secret that is worth anything.
#
# It records ONE line per invocation into $FAKE_DEPLOY_LOG:
#
#     <environment>|<digest>|token-present:<yes|no>
#
# and never the token's VALUE. A fake that printed the secret it was given would put that secret in
# the gate's own log, in CI, and the one thing this milestone is about is that a secret goes exactly
# one place. `token-present` is the assertion the gate actually needs: the credential reached THIS
# child, and (asserted on the other side, from the child env dump the fake CLI writes) did not reach
# the worker's.
#
# It reads its parameters from the ENVIRONMENT, never from argv: `apps/orchestrator/src/broker.ts`
# passes `SLAVEOFAI_BROKER_PARAM_ENVIRONMENT` and `SLAVEOFAI_BROKER_PARAM_DIGEST`, because a
# parameter that entered the command line would be a quoting question and this way it is not one.
set -uo pipefail
```

and eight lines of body: refuse loudly (exit 3) if `FAKE_DEPLOY_LOG` is unset, append the line, exit 0. `chmod +x`.

- [ ] **Step 2: The fake CLI's broker arm**

`packages/providers/test/fake-claude.mjs` gains `--broker-op <op>`, in the exact shape of `--work-fixture` (`:282-299`):

```js
/**
 * M52 R8: a WORK run that calls the broker for real before it replays its fixture.
 *
 * `--broker-op deploy_release` makes the work arm spawn the orchestrator's own thin client --
 * `node "$SLAVEOFAI_BROKER_CLI" broker run deploy_release --environment <FAKE_BROKER_ENVIRONMENT>
 * --digest <FAKE_BROKER_DIGEST>` -- with the child's own environment, exactly as a worker's `Bash`
 * tool call would, and records its stdout and exit code into `FAKE_BROKER_OUT` before replaying.
 *
 * REALLY spawned, not simulated: the point of the stage is that the request travels through the
 * channel the daemon is tailing, under the identity the daemon issued, with no database in the
 * child. A fake that wrote the reply file itself would prove nothing at all.
 *
 * It also dumps its OWN environment to `FAKE_ENV_OUT` when that is set, which is how the gate
 * asserts what a worker does NOT have: no `FAKE_DEPLOY_TOKEN`, no `DATABASE_URL`.
 */
```

`packages/providers/test/fake-claude.test.ts` needs no change: the arm replays an existing fixture and adds no file to the `fixtures/` namespace, so the "every fixture ends with the routine `Stop` hook line" invariant is untouched. Say so in the report rather than assuming it.

- [ ] **Step 3: The fixture's one redaction (erratum E10)**

`packages/providers/test/fixtures/permission-matrix-deny.ndjson` is a genuine `claude` recording and the deny reason inside it is this repository's own sentence, echoed back by the CLI. M52 changes that sentence's vocabulary, so the recording gets ONE substitution, applied the way every other substitution on that file has been:

```bash
sed -i "s/'run tests'/'run_commands'/g" packages/providers/test/fixtures/permission-matrix-deny.ndjson
grep -c "run_commands" packages/providers/test/fixtures/permission-matrix-deny.ndjson   # expect 4
grep -c "run tests" packages/providers/test/fixtures/permission-matrix-deny.ndjson      # expect 0
```

and `packages/providers/test/fixtures/README.md` gains a row in that file's own substitution table (`:311-390`), with the count, beside the five that are already there — so `scripts/capture-matrix-deny.mjs` stays a complete recipe for the next capture. The table row:

| 6 | `'run tests'` → `'run_commands'` | **4**. M52 R1 renamed the permission vocabulary; the quoted value in a matrix deny is the KIND (plan erratum E2), and this recording carries our own gate's sentence rather than the CLI's. |

- [ ] **Step 4: Move `gate:m18`'s two assertions, which the redaction earns**

`scripts/gate-m18-skill-and-teeth.mjs` — the seed moved in Task 1; these two move now, in the same commit as the fixture, and not before:

```js
  if (toolDeniedPayload?.tool !== 'Bash' || toolDeniedPayload?.capability !== 'run_commands') {
    await fail(`stage 1: run.tool_denied payload is ${JSON.stringify(toolDeniedPayload)}, expected {tool:'Bash', capability:'run_commands'}`)
  }
```

```js
  if (deniedCardText !== 'Bash denied — Run commands') {
    await fail(`stage 1: the denial card reads ${JSON.stringify(deniedCardText)}, expected "Bash denied — Run commands"`)
  }
```

The card's text is the LABEL now and the payload is the KEY — the two halves of erratum E2 asserted in one stage, by a gate that has been asserting the pair since M18. Every other m18 assertion (exactly one event, zero guardrails, never paused, no `Checkpoint`) is unchanged and must stay so.

- [ ] **Step 5: Write the gate**

`scripts/gate-m52-broker.mjs`. Scaffolding cribbed function for function from `scripts/gate-m51-breaker.mjs` — free port, real `next dev`, real Chromium through `playwright-core` at `CHROMIUM_PATH`, prisma + the real CLI before the browser opens, `preflightCleanup` by name prefix, a `finally` that kills every process and removes every temporary repository — plus two things of its own:

- `SLAVEOFAI_STATE_DIR` is set to a temporary directory for **every** daemon and CLI it spawns, so its run directories are isolated from the operator's own and the `finally` can remove them whole. That variable exists because of Task 2 and this is the first thing to use it.
- `FAKE_DEPLOY_LOG` and `FAKE_DEPLOY_TOKEN` are set on the DAEMON's environment and on nothing else. The token's value is a literal in this file (`'m52-fake-deploy-token'`) and is what stage 4 greps the event log and the child env dump for.

Header, in the house register:

```js
// M52's own gate (spec R8): "the wall a worker cannot move, and the secret it never holds".
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m52-broker
//
// NEVER A MODEL CALL. NEVER A REAL DEPLOYMENT. The fourth fake, `scripts/gate-fakes/fake-deploy.sh`,
// is what `BrokerBinding.command` points at, and the "credential" is a literal in this file.
//
// THE GATE ASSERTS, IT NEVER FIXES, and every stage prints every measured value before asserting it.
```

The eleven stages, each with what it measures and the assertion that would fail:

1. **The baseline is what a fresh worker gets.** Seed a project and a worker with NO `SlavePermission` rows at all, dispatch, and read the `permissions.json` the daemon wrote: `version === 2`, `allow` is an array whose `kind`s are exactly `BASELINE_GRANTS.implementation`, `tokenHash` is 64 hex, `enforce` is `all-tools`, and `vocabulary` has an entry for every tool on the list. Then assert the file is **not** under `workspace.repoPath` — the first half of stage 11, measured where the file is first written.
2. **An ungranted call is denied and the run survives.** A `WebFetch` call — outside the baseline — through the real hook. Exactly one `run.tool_denied` with `{ tool: 'WebFetch', capability: 'network_fetch' }`, **zero** `guardrail.tripped`, no `run.paused`, `pausedAtStep` null, **no `Checkpoint` row**. That is the m18 shape, asserted for the opposite reason: m18 proved a DENY does not stop a run, and this proves the same for a tool nobody ever denied.
3. **A person moves the wall.** `permission grant --kind network_fetch`, then a restart, then the same call passes; `permission.changed` is on the timeline with `{ from: null, to: 'allow', by: … }`. The restart is the point: a matrix edit does not reach a run in flight, which the copy has always said and which nothing had ever proven.
4. **The broker, end to end.** `broker run deploy_release --environment staging --digest <sha>` from inside the fake CLI; assert (a) `fake-deploy.sh`'s log line reads `staging|<sha>|token-present:yes`, (b) the child env dump contains NEITHER `FAKE_DEPLOY_TOKEN` NOR `DATABASE_URL`, (c) `broker.executed { environment: 'staging', exitCode: 0 }` is on the timeline, and (d) the literal token string appears NOWHERE in `ExecutionEvent` — one `findMany`, one `JSON.stringify`, one `includes`. Four assertions, and (b) and (d) are the milestone.
5. **No grant, no operation.** The same call from a worker without `deploy_release` → `broker.refused { reason: 'permission_denied' }`, and `fake-deploy.sh`'s log did not grow.
6. **Two forgeries, both closed.** Write a request line by hand carrying (i) another run's id and (ii) a wrong token; both reply `identity_mismatch` and neither runs anything. Written by hand rather than through the client precisely because a worker that forges does not use the client.
7. **An op with no binding.** Delete the `BrokerBinding` and call again → `not_brokered`.
8. **Nothing crosses.** Call with the workspace archived → `simulation`. (The reachable half of R6; the unreachable half is `simulation-boundary.test.ts`'s source scan, which Task 3 widened and which runs in `npm test`.)
9. **The Supervisor may point, not move.** Drive three `network_fetch` denials on a second worker, run `supervise`, and assert: a `permission_blocked` situation, a `request_permission` decision recorded `proposed`/`pending`, and — the assertion that matters — `SlavePermission` for that worker is **unchanged** until `approve-decision` is called, after which the row exists and carries the approver in `grantedBy`.
10. **The browser.** `SlavePanel`'s permissions group open: six lines, the three glyphs, the labels, no key as visible text; its Advanced open: the policy sentence naming who granted and when. Then `/w/<id>/settings`: six column headers reading words, `data-kind` carrying the keys, and a third click taking a decision back.
11. **The run directory is outside the repository (erratum E4).** `runFilePaths`' directory is under the gate's `SLAVEOFAI_STATE_DIR` and `join(repoPath, '.slaveofai', 'runs')` does not exist — **and `join(repoPath, '.slaveofai', 'worktrees')` DOES**, because a worktree is the worker's workspace and never moved. Asserting both is what keeps this stage honest: "`.slaveofai` is gone" would be false and would have to be weakened later.

- [ ] **Step 6: Run the gate until it is green, and read its log**

```bash
pgrep -af "next dev"     # must be empty
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m52-broker 2>&1 | tee /tmp/gate-m52.log; echo "exit ${PIPESTATUS[0]}"
```

Expected: exit 0 and the pass line. Then read the log for the two things a green gate can still hide:

```bash
grep -c "token-present:yes" /tmp/gate-m52.log      # at least 1
grep -i "m52-fake-deploy-token" /tmp/gate-m52.log  # ONLY on the line that seeds it, never in a payload
git status --porcelain                             # must be clean: the gate edits no file in this repo
```

- [ ] **Step 7: The roster, CI and the README**

`package.json` gains `"gate:m52-broker": "tsc --build && node --env-file=.env scripts/gate-m52-broker.mjs"` after `gate:m51-breaker`. `.github/workflows/ci.yml` gains `- run: npm run gate:m52-broker` after `gate:m51-breaker` (`:79`). `README.md`: the roster sentence (`:828-836`) names `gate:m52-broker`, the `m51` clause gains an `and m52` clause in the same register ("…and `m52` drives one until a worker is refused a tool nobody granted it and keeps working, a person grants it and the next run is not refused, and a deployment runs with a credential the worker's own environment does not contain — asserted from both sides"), and `:908` reads **27 gates**.

- [ ] **Step 8: Regenerate exactly two screenshots**

`gate:m14-fidelity` rewrites every PNG it takes; only two of them changed content in this milestone, so the rest are checked out again — the M50/M51 precedent, and the known m14 PNG nondeterminism in the carried backlog:

```bash
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m14-fidelity
git status --porcelain docs/superpowers/fidelity/m14/
git checkout -- $(git diff --name-only docs/superpowers/fidelity/m14/ | grep -v -E "(overview|project-settings)\.png$")
```

Then OPEN both PNGs and look: `project-settings.png` must show six column headers reading WORDS, and `overview.png` must show the worker panel's Permissions group in the list. A screenshot that regenerated identically means the page did not change and something in Task 5 did not land.

- [ ] **Step 9: The full verification ladder**

One vitest at a time, no gate beside vitest, nothing beside a `web:build`.

```bash
npx tsc --build
npm run --silent typecheck
npx vitest run 2>&1 | tail -20
```

Expected: ≥ 316 files / ≥ 4930 tests, zero failures. Then the migration proof once more, because this is the last chance to catch a schema that drifted from its SQL across six tasks:

```bash
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```

Expected: "No difference detected". Then the build:

```bash
pgrep -af "next dev"   # empty
npm run web:build
```

Then every gate this milestone could have moved, one at a time, each with `CHROMIUM_PATH` / `SLAVEOFAI_CLAUDE_BIN` / `SLAVEOFAI_REQUIRE_FAKE_CLI` set and `pgrep -af "next dev"` empty before each:

```bash
npm run gate:m13-runtime
npm run gate:m14-fidelity
npm run gate:m16-chrome
npm run gate:m18-skill-and-teeth
npm run gate:m20-auth
npm run gate:m26-vocabulary
npm run gate:m37-run-context
npm run gate:m38-supervisor
npm run gate:m44-ux-foundation
npm run gate:m45-project-experience
npm run gate:m47-team-formation
npm run gate:m48-runbooks
npm run gate:m49-memory
npm run gate:m50-ephemeral
npm run gate:m51-breaker
npm run gate:m52-broker
```

Expected: all sixteen green. Five to watch, and what to do rather than edit them:

- **`gate:m13-runtime`** spawns both providers for real through `preflightGate`. If it fails at a spawn with "did not allow with the pause flag absent", the pre-flight is reading a permissions file it should not — erratum E1, Task 2 Step 6.
- **`gate:m18-skill-and-teeth`** is the permission gate and the one this milestone rewrote the vocabulary of. Its stage-1 shape (one denial, zero guardrails, no pause, no checkpoint) must be untouched; only the two strings moved, and only in Step 4's commit.
- **`gate:m20-auth`** is unchanged and must be: M52 adds no role model, and the README's standing caveat stands — every account is a full operator, so "a person granted this" means an authenticated human and not a role (`README.md:811-814`).
- **`gate:m38-supervisor`** stage 3 pins `situation.facts.reason === 'budget_exhausted'` so another halt cannot pass that stage. It must pass UNCHANGED; if it does not, a new situation is being raised ahead of the halt, and the fix is `SITUATION_KINDS`' order, not the gate.
- **`gate:m16-chrome`** check 2 reads `perm-cell-*` and `data-mode`. Unaffected by the vocabulary (Task 5 Step 10), and re-run here to prove it.

Record every gate's exit code and its wall time in the task report, and re-run any single failure ALONE before believing it — the daemon CLI test's row counts double when anything else touches the database, and a gate is the heaviest anything.

- [ ] **Step 10: Commit — three of them, in this order**

The code, then the picture, then the documents, so a screenshot diff never hides a code change and a spec diff never hides either:

```bash
git add scripts packages/providers/test/fixtures packages/providers/test/fake-claude.mjs package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
feat(gate): m52 t6 — the wall a worker cannot move, and the secret it never holds

`gate:m52-broker` drives a real daemon and the fake CLI through the whole of it: a fresh worker gets
exactly the baseline its run kind allows and a tool nobody granted is refused while the run keeps
going; a person grants it and the next run is not refused, which is also the first proof that a
matrix edit reaches a run at its next start and never one in flight. Then the deployment: the
operation runs, the fake on the far side records that the credential arrived, and the worker's own
environment dump contains neither that credential nor `DATABASE_URL` -- asserted from both sides,
which is the only way to assert an absence. Two forged request lines are refused, an unbound
operation is refused, an archived project is refused, and the Supervisor raises the wall and records
a proposal that changes nothing until a person approves it.

Stage 11 is the smallest and the one that took a milestone to earn: the run directory is outside the
repository the worker edits, and `<repo>/.slaveofai/worktrees` still exists -- because a worktree is
the worker's workspace and only the verdict about it moved. CI's 27th gate.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"

git add docs/superpowers/fidelity/m14/overview.png docs/superpowers/fidelity/m14/project-settings.png
git commit -m "$(cat <<'EOF'
chore(fidelity): m52 — regenerate the two screenshots the permissions vocabulary changed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"

git add docs/superpowers/specs/2026-09-12-m52-capability-broker-design.md docs/superpowers/plans/2026-09-12-m52-capability-broker.md
git commit -m "$(cat <<'EOF'
docs(spec): m52 — the design, the plan, and fifteen errata execution wrote back into §4

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

| Spec | Where it lands |
|---|---|
| R1 five nouns five homes, a permission is an OPERATION (`PERMISSION_KINDS`, `PERMISSION_LABEL`, `TOOLS_BY_KIND`, `TOOL_VOCABULARY`, the column swap, `grantedBy`/`grantedAt`, the deterministic migration with deny-wins and the `RAISE NOTICE`, `read secrets` given teeth as `read_secret`, permissions and capabilities kept apart) | Task 1 Steps 1–4 (the vocabulary, 14 cases), 23–25 (the schema, the two enums, the parity assertions), 24 (the migration and both databases), 26–27 (the readers, and the m18 seed the swap forces). **`packages/domain/src/capability/` appears in no task's file list**, which is how the two taxonomies stay two |
| R2 default-deny everywhere the gate looks, the computed baseline, `resolveGrants`, v2, one `node -e`, exit 2 as the only fail-closed status, the frozen `capability` field name, Cursor's limitation in the copy, the MOVED pins | Task 1 Steps 5–8 (`resolveGrants`/`grantsFor`, 17 cases) and Step 27 (`permission-mapping.test.ts` moved); Task 2 Steps 1–4 (the library inverted, ~30 cases, eleven of them the same names that used to assert ALLOW), Step 5 (the deny grammar), Step 6 (erratum E1), Step 12 (the v2 body); Task 5 Step 6 (the copy); Task 6 stages 1–3 |
| R3 a credential is an object the worker never holds; a brokered op is a named verb with typed parameters (`Credential`, `BrokerBinding`, `CHILD_ENV_ALLOW`, `BROKERED_OPERATIONS`, the channel, the client, the executor, the two events at nine sites) | Task 1 Steps 9–12 (the manifest, 10 cases) and 13–16 (both events at all nine sites); Task 2 Steps 7–9 (the environment, 6 cases); Task 3 Steps 5–10 (the verbs and the authoriser, 22 cases); Task 4 Steps 1–7 (the server, the executor and the client, 22 cases); Task 5 Step 8 (the cards); Task 6 stages 4–8 |
| R4 identity from the runtime context (`runTokenHash`, the four issue sites, the rotation, `SLAVEOFAI_RUN_ID`/`RUN_TOKEN`, the hook's comparison, `runDir` out of the worktree) | Task 1 Step 23 (the column); Task 2 Steps 3 (the hook's check and `timingSafeEqual`), 10 (the threading), 11 (the state directory), 13 (issue and rotate); Task 6 stages 6 and 11 |
| R5 the Supervisor may request, never grant (situation 17, action 17, `tierOf` always `proposed`, `permissionWhyFor`, the `carryOut` arm, `permission.changed`, `assign_capability` unchanged) | Task 1 Steps 17–20 (the predicate, the arm, the tier, and the case asserting `assign_capability` is still `applied`); Task 3 Steps 1–4 (the writers and the event) and Step 11 (`carryOut`, the denials loader); Task 5 Step 8 (`actionText`); Task 6 stage 9. **`packages/domain/src/supervisor/critical.ts` is in no task's file list** — the lexicon that forbids the Supervisor ANSWERING about permissions is untouched, and the action clears it by writing no prose |
| R6 nothing crosses the simulation boundary (the `simulation` refusal, the widened source scan, broker events as `ExecutionEvent` rows, `deny-all-gate.sh` unchanged) | Task 3 Step 9 (the fourth question, and its position in the order) and Step 11 (the third assertion, with the grep that proves the pattern is clean today); Task 6 stage 8. **`scripts/deny-all-gate.sh` and `packages/simulation/` are in no task's file list** |
| R7 surfaces: two words for two things (`DetailsGroupName` +1, the panel's group and its Advanced, the matrix on kinds, the moved routes, three cards, `docs/ia.md`) | Task 5 Steps 1–9, with the gate's own browser stage at Task 6 stage 10. The Organization row is NOT in any file list — it answers "what is this worker for", and R1 keeps that separate |
| R8 the gate, the fourth fake, README 26→27, CI after m51, the moved pins, the m14 screenshots | Task 6 Steps 1–8, eleven stages enumerated with their assertions; the moved pins are named in the tasks that move them (Task 1 Step 27, Task 2 Step 11, Task 6 Step 4) |
| §2 surfaces after M52 | Every module, column, kind, verb and file listed there appears in a task's **Interfaces → Produces**: the two domain modules and the manifest in Task 1; the file, the library and the environment in Task 2; the five control verbs and the six refusals in Task 3; the channel, the executor and the four CLI verbs in Task 4; the six web surfaces in Task 5; the gate and the fake in Task 6 |
| §3 out of scope | No `git_push` (`BROKER_OPS` has one member and a test asserts it); no vault (`Credential` has six columns and a test asserts the list); no per-path or per-command permission and no command-string inspection (M18's ruling, restated in the `broker run` docstring); no Cursor hook parity (`packages/providers/src/cursor/hooks.ts` is in no file list); no rate limit, quota or approval queue on a brokered op; no role model (`gate:m20-auth` unchanged and re-run); no mid-run credential revocation; no `BrokerBinding` editing from the UI (CLI only, the `set-lifecycle` precedent); nothing ranked (M53) |

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Seven places name the exact file to copy a shape from instead of reprinting it, and each states what it must produce: Task 3 Step 6's `credential.ts` (three rules given, and the refusal each one raises), Task 3 Step 9's `runBrokeredOperation` (seven questions in order, with the two details the tests pin spelled out), Task 4 Step 3's server (`gate-m51-breaker.mjs` named for the scaffolding, the schema and both caps given), Task 4 Step 6's CLI verbs ("the shape this file has fifty of", with the one that is different given in full), Task 5 Step 3's helpers (`glyphFor` given, `sourceSentence` specified by its four arms and asserted by Step 1), Task 5 Step 8's two remaining cards (the first given as code, the other two as their tone, text and testid), and Task 6 Step 5's gate (eleven stages with their assertions, the constants given, the borrowed scaffolding named function by function, and two things the implementer may not improvise past: the state directory and the token literal). Five steps deliberately end in a CHECK rather than an edit — Task 1 Step 28's vocabulary grep, Task 2 Step 8's environment MEASUREMENT (whose output the report must carry), Task 4 Step 8's `git diff --stat` proving the denial routing did not move, Task 5 Step 7's `api/slaves/` grep, and Task 6 Step 8's "open the PNG and look" — because each is a fact about the tree that a plan should verify rather than assert. One step (Task 1 Step 3) begins with a decision the implementer must SETTLE and record, and gives the exact fallback and the exact consequence either way.

**3. Type consistency.** `PermissionKind`, `PERMISSION_KINDS`, `PermissionProvider`, `TOOLS_BY_KIND`, `TOOL_VOCABULARY`, `BASELINE_GRANTS`, `ENFORCE_BY_PROVIDER`, `KindGrant`, `GrantSource` and `resolveGrants`/`grantsFor` are spelt ONCE (Task 1 Steps 3 and 7) and consumed under those names in Task 2 (`writePermissionsFile`'s body and the file it writes), Task 3 (`setSlavePermission`, the authoriser's fifth question), Task 4 (`permission list`) and Task 5 (`SlaveCardData.permissions`, the matrix's columns) — and in the SHELL as JSON keys whose names are the same words, which is why `permissions.json`'s `allow` entries are `{tool, kind}` and not `{tool, capability}`. The ONE place the old word survives is `run.tool_denied.payload.capability` and `GateOutcome.tool_denied.capability`, which are frozen by R2 and carry a `PermissionKind` VALUE under an M18 field NAME — the asymmetry erratum E2 rules, made visible by `TOOL_DENIED_LABEL` being keyed on `PermissionKind | 'ungoverned_tool'` while the payload's schema stays `z.string()`. `BrokerOp`, `BROKER_REFUSAL_REASONS` and `BrokerRefusalReason` are the producer types in the domain and plain `string` on the wire (`broker.refused.payload.reason` is `z.string().max(40)`), for `guardrail.tripped`'s reason, and `ControlRefusal['broker_refused'].reason` is the closed union again — the same value, typed where a mistake is a build error and forgiving where a mistake would take down a read. `BrokerExecutor` has one shape at its three implementations (the spy in Task 3's test, `realBrokerExecutor` in Task 4, and the throwing one in Task 4's last case) and one call site. `runTokenHash(token)` is one function with one definition (`packages/providers/src/runtime/process.ts`) and three callers — `writePermissionsFile`, the four dispatch sites, and `runBrokeredOperation` — plus one RE-implementation, six characters of JavaScript inside the hook's `node -e`, which cannot import it and whose agreement with it is pinned by `permissions-lib.test.ts` computing the hash in TypeScript and the shell comparing it.

**4. What this plan deliberately does not do.** It does not add a permissions section to the run-context prompt (`SECTION_ORDER` is in no file list): a worker learning its limits from its prompt would be a second place the limits are written, and the gate is the one that decides. It does not make `SlavePermission` workspace-scoped (the walk is still `Slave → Team → Workspace`, and `buildPermissionMatrix`'s comment at `settings.ts:145-148` still explains why). It does not touch `--permission-mode bypassPermissions` (`flags.ts:35-40`): the alternative — stop bypassing and drive `--allowedTools`/`--disallowedTools` — is a second enforcement mechanism whose failure mode is a vendor's, and this milestone's whole claim is that one gate decides. It does not delete `run.tool_denied`'s `capability` field name, and it does not rename `invalid_tool`. And it does not fix the three web read models that divide tool calls by `maxToolCallsPerRun` where a capped run's honest denominator is `toolCallCap` (M51's carried backlog, which M52 "may fix where a task touches the file"): Task 5 touches `overview.ts` for one added field and `brief.ts`/`graph.ts`/`org.ts` not at all, so the fix would be a change nothing in this milestone tests — it stays on the list.
