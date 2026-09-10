# M41 End-to-End Scenario Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One gate, `gate:m41-scenario`, drives one realistic software-team story — plan, work, ask, Supervisor answer, resume, verify, review, integrate, goal change, delta re-plan, human approval — through the WHOLE system against a real daemon lineage and the fake `claude` CLI, and then asserts the truth of every operator surface at once.

**Architecture:** Nothing new in the product except the fake CLI's story mode. `packages/providers/test/fake-claude.mjs` gains one prompt-and-argv-sniffing mode `m41-flow` and one fixture `plan-graph-scenario.ndjson`; `scripts/gate-m41-scenario.mjs` seeds one workspace on a temp git repo, drives four daemons in sequence, stops each one at a measured point, and asserts the board, the goal history, the Supervisor, the mailbox, the spend and the event log through the same control/domain verbs the web builders compose. Three M40 doc residuals ride along as the first task.

> **Superseded in part by the spec's §5 errata (E1–E17).** As shipped: two real daemons plus two operator `tick`s (E16), five slaves (E1), `--ask-on-task` carries a one-word token (E2/B5), the parity test lives at `apps/web/test/integration/gate-surface-parity.test.ts` (E9), and the story found and fixed a product defect in the review dispatch (E17, Task 3b) — the spec is the binding authority where this plan disagrees.

**Tech Stack:** TypeScript monorepo, Prisma 7 + Postgres (:5433), zod, vitest, Next.js, plain-`node` `.mjs` gates, the fake provider `packages/providers/test/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-10-m41-scenario-gate-design.md` (rulings R1–R6; §5 errata). Plan-time errata, every one of them read out of the code and baked into the tasks below:

- **E1 — a question to a role NOBODY holds can never be asked.** `apps/orchestrator/src/ask.ts`'s `recipientCanAnswer` refuses an ask whose `recipientRole` has no holder other than the sender (`no other slave in this workspace holds the role "<role>"`), the run concludes ordinarily, and no question row is ever written. Spec R2's premise ("the question is addressed to the `qa` ROLE, which no slave in the scenario holds") therefore produces no pause and no situation. **Correction:** the scenario seeds a fifth slave `Quinn` with `runtimeRoles: ['qa']`, lets the ask land, and then the operator takes the role away with `set-runtime-roles --slave <quinn> --roles ''` — the exact idiom `gate-m39-supervisor-mailbox.mjs` uses and documents. `unanswerable_question` then fires on the next Supervisor pass with no staleness wait, which is what R2 actually wanted.
- **E2 — a work run's prompt does not contain its task's id.** `apps/orchestrator/src/runContext.ts` renders the `task` section as `` `Task: ${task.title}\n\n${task.description}` `` (its `sha256` is over `title + '\n' + description`); ids appear only in a PLANNING/re-plan run's board lines. **Correction:** `--ask-on-task` carries a **one-word token** off the task's title (a value with spaces would arrive as separate argv entries), and the fake CLI's asking leg fires on the token matched inside the `Task: <title>` line — the one line the `task` section always renders.
- **E3 — a paused run's asking leg records NO cost.** `apps/orchestrator/src/pump.ts` returns at `if (asked.kind === 'waiting') return null` *before* the `slaveRun.updateMany({ ..., costUsd: outcome.costUsd })` that concludes a run, and `costUsd` is written in exactly one place, once, at the terminal conclusion, as a REPLACE (never an accumulation). Spec §2 item 7's parenthetical guess ("the cost is recorded for BOTH legs") is wrong. **Correction:** the asking leg contributes `$0`; the ONE `SlaveRun` row for the asking task carries exactly the RESUMED leg's `complete` cost. The spend table says so in its own line.
- **E4 — `task.integrated` is written only by `confirmIntegration`.** `apps/orchestrator/src/merge.ts`'s real-merge path stamps `Task.integratedAt` and emits `task.done { branch }`; the `task.integrated` event exists only in `packages/control/src/integration.ts`. Under `autoMerge: true` the truth table's `task.integrated 2` would be 0. **Correction (and it buys the story three other things):** the workspace runs with **`autoMerge: false`** — the `gate-m36-messaging.mjs` setting. A reviewed task lands `done` with `integratedAt: null`, the OPERATOR merges the branch into `main` by hand and runs `confirm-integration`, and `task.integrated` is real (2, actor `human`). This also makes M35's integration honesty a measured act ("`api.dependenciesDone` is false while core is done-but-unmerged"), proves the commits really reach `main`, and — decisively — is the only thing that makes acts 4 and 5 deterministic instead of racy: a dependent of a done-but-unintegrated task cannot be dispatched, so `polish` is provably unstartable while the re-plan runs. Under `autoMerge: true` daemon-4's very first tick would dispatch `polish` before `dispatchPlanning` is even reached (`tick.ts` dispatches work FIRST), the delta's cancellation would be DROPPED as `running`, and act 6 would be dead.
- **E5 — the Supervisor event names.** They are `supervisor.decided`, `supervisor.proposed`, `supervisor.applied`, `supervisor.resolved`, `supervisor.failed` (`packages/domain/src/events/schema.ts`; DB values `supervisor_decided`, …). There is no `supervisor.decision_*`.
- **E6 — an approved proposal is `approved`, not `applied`.** `approveDecision` claims the row to `status: 'approved'` and then applies the action. So `report.supervisor.applied` is **1** (the answer), not "≥ 2"; the second row reads `approved`. Spec §2 item 7's "`applied` count ≥ 2" is corrected to an exact table.
- **E7 — `workspaceStats` carries no task counts.** `WorkspaceStats` is `{ activeRuns, globalActiveRuns, spentUsd, consecutiveFailures, emergencyStopped }`. Task counts live on `buildOverviewSnapshot().tasks`. The truth table asserts `workspaceStats().stats.spentUsd === workspaceSpend().spentUsd`, `emergencyStopped false`, `activeRuns 0`, `consecutiveFailures 0`, and takes its task counts from the board.
- **E8 — there is no "stale marker" on the tasks snapshot.** `TasksSnapshot` exposes `workspace.goalVersion` and `TaskBoardItem.goalVersion`; the badge is the client-side comparison, and the COUNT an operator reads is `summarise(world).next.stale`. The truth table asserts that count (0) plus the two raw versions.
- **E9 — R6 is resolved by neither importing `apps/web` nor adding a control helper.** `apps/web` compiles with `"noEmit": true` and `"moduleResolution": "bundler"`, has no `dist`, and no gate imports `apps/web/src/server/*`. But every field of the three builders is already a control/domain verb: `buildSupervisorView` *is* `supervisorSettings` + `loadSupervisorWorld` + `summarise` + `listDecisions`; `buildGoalHistory` *is* `listGoalVersions`; `buildTasksSnapshot`/`buildOverviewSnapshot`'s load-bearing fields are `Task.goalVersion`/`Task.integratedAt`/`Task.status`/`Workspace.goalVersion` plus `workspaceSpend`. So the gate reads the verbs, a comment block in the gate maps each web field to the verb it reads it through, and one new vitest (`apps/web/test/gate-surface-parity.test.ts`) pins the mapping so the substitution cannot silently stop being true. No new product surface; the web builders are left exactly as they are.
- **E10 — R3(d) is already covered, and misnames its surface.** `GET .../goal/history` is a read with no body and no version parameter; the only body validator in the goal routes is `POST .../goal`'s `z.object({ goal: z.string() })`, and `apps/web/test/integration/control-routes.test.ts` `goal` case **(b)** already asserts `400` for `{ goal: 5 }` and for an unparseable body. Task 1 records this in the ledger and writes no test.
- **E11 — the re-plan's board is the NON-terminal board.** `renderRunContext`'s replan section shows "every task that is not done, failed or cancelled", so at act 5 `replan.boardTaskIds` is `[polish]` alone — core and api are `done`. (`applyDelta` resolves ids against EVERY task, deliberately; only the PROMPT is narrowed.) The gate asserts `[polishId]`.
- **E12 — the "same exported helper" for the task hash is `goalSha256`.** `packages/domain`'s `goalSha256(text)` is a general SHA-256 of a UTF-8 string, cross-checked against `node:crypto` by its own test; `runContext.ts`'s private `sha256` is the `node:crypto` one-liner it has to agree with. The gate computes `goalSha256(\`${title}\n${description}\`)` — the product's own exported hash, not a re-implementation.

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_CLAUDE_BIN=node`, `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m41-flow …"` and `SLAVEOFAI_REQUIRE_FAKE_CLI=1` (M32 item 7: lose the first two and the daemon refuses to start rather than falling back to the real binary).
- **One story, one script, one daemon lineage.** The gate runs real `daemon` subprocesses with the fake CLI throughout, restarts only where a fixture/argv switch demands it, and proves every restart the way `gate-m36-messaging.mjs` does (the old pid answers no signal, `/proc/<pid>/cmdline` no longer reads as a daemon, `findRealDaemonPids()` is empty between the two, the new pid differs). **No one-shot `tick` for anything the daemon can drive.**
- **The gate asserts, it never fixes.** Every stage prints every measured value before asserting it; a failed assertion dumps rows (`dumpGateRows`, m39/m40 style) and exits 1; teardown in FK order runs on every exit path; every daemon is stopped on every exit path (`finally`).
- **No hard-coded prices.** Every cost is read at runtime off the fixture's terminal `result` line.
- **No migration** — nothing in this milestone changes the schema.
- One vitest process at a time (the shared test DB truncates); `npm run typecheck`; the vocabulary gate (`npm run gate:m26-vocabulary`) after every task — the word is **slave**, and `docs/scenarios/` is NOT on the gate's exclude list, so the narrative must never write "agent".
- `npm run web:build` LAST, and never while `next dev` is running.
- The implementer never dispatches subagents.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```

---

## File structure

```
apps/orchestrator/src/cli.ts                       R3(a): the replan-status help sentence
apps/orchestrator/src/replan.ts                    R3(c): concludeReplan + failRun docblocks
scripts/gate-m40-requirement-versioning.mjs        R3(b): the stage-3 comment's claim
apps/orchestrator/test/integration/cli.test.ts     the help-text test for R3(a)

packages/providers/test/fake-claude.mjs            + mode `m41-flow`, `--ask-on-task`, header doc
packages/providers/test/fixtures/plan-graph-scenario.ndjson   the story's own plan (new)
packages/providers/test/fixtures/README.md         + one table row and its recipe
packages/providers/test/fake-claude.test.ts        + describe('m41-flow')

scripts/gate-m41-scenario.mjs                      the gate (new)
apps/web/test/integration/gate-surface-parity.test.ts   R6/E9: the web builders and the gate read the same verbs (new)

docs/scenarios/e2e-software-team.md                the narrative, one section per act (new)
README.md                                          + `## The whole story`; Tests and CI roster 16 -> 17
package.json                                       + gate:m41-scenario
.github/workflows/ci.yml                           + gate:m41-scenario after gate:m40-requirement-versioning
```

---

### Task 1: The M40 residuals (spec R3)

**Files:**
- Modify: `apps/orchestrator/src/cli.ts` (the `replan-status` USAGE block, lines 157–164)
- Modify: `apps/orchestrator/src/replan.ts` (`concludeReplan`'s docblock, `failRun`'s docblock)
- Modify: `scripts/gate-m40-requirement-versioning.mjs` (the stage-3 comment above `planningRunsAfterTicks`)
- Test: `apps/orchestrator/test/integration/cli.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on. This task is self-contained and can be reviewed alone.

- [ ] **Step 1: Write the failing test**

Append to `apps/orchestrator/test/integration/cli.test.ts`, inside the same top-level `describe` the other `runCli` cases live in (put it next to the existing "exits non-zero and prints usage for an unknown command" case at line ~231):

```ts
  it('the replan-status help says the board version is taken over EVERY task (erratum E8)', async (): Promise<void> => {
    const result = await runCli(['help'])

    const printed = `${result.stdout}${result.stderr}`
    // The bug this asserts against: the help promised "the highest version stamped on an
    // unfinished task", which is what `boardVersionOf` did BEFORE erratum E8 -- and a board whose
    // tasks had all finished then had no task to take a max over, its version fell to 0, and every
    // finished project re-planned itself on its next tick. The code counts terminal tasks now; the
    // sentence an operator reads has to say so, or `replan-status`'s own output is unreadable.
    expect(printed).not.toMatch(/unfinished task/)
    expect(printed).toMatch(/the highest version stamped on any task, terminal ones included/)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t 'replan-status help'`
Expected: FAIL — `printed` still matches `/unfinished task/`.

- [ ] **Step 3: Fix the help text**

In `apps/orchestrator/src/cli.ts`, replace the `replan-status` USAGE lines (currently 157–164):

```
  replan-status --workspace <id> [--prompt]
                                       why the next tick will, or will not, start a delta re-plan:
                                       the goal version, the highest version stamped on an
                                       unfinished task, whether this version was already re-planned,
```

with:

```
  replan-status --workspace <id> [--prompt]
                                       why the next tick will, or will not, start a delta re-plan:
                                       the goal version, the highest version stamped on any task,
                                       terminal ones included, whether this version was already
                                       re-planned,
```

leaving the remaining four lines of that block (`whether a planning run is live, …`) exactly as they are.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t 'replan-status help'`
Expected: PASS.

- [ ] **Step 5: Correct `concludeReplan`'s and `failRun`'s docblocks**

In `apps/orchestrator/src/replan.ts`, replace the sentence that opens the containment paragraph of `concludeReplan` (currently line 299) —

```
 * **Nothing here may throw past this function** (fix round 1, widened by the final review to the
 * three reads that used to sit outside the containment). A re-plan is deduped on
```

— with:

```
 * **Nothing here may throw past this function, with one honest exception** (fix round 1, widened
 * by the final review to the three reads that used to sit outside the containment): {@link failRun}
 * itself writes to the database, so a database that is not there when a pre-commit failure is being
 * RECORDED still throws past this function. That is the one failure this containment cannot absorb,
 * because absorbing it would mean losing the record of the failure as well as the failure. A
 * re-plan is deduped on
```

and append to `failRun`'s docblock (after its existing `updateMany` paragraph, before the closing `*/`):

```
 *
 * This is the one thing {@link concludeReplan} calls that can still throw past it: both writes here
 * are the database, and a database outage during a pre-commit failure takes the recording of that
 * failure down with it. There is no third place to route it to -- the alternative is a swallowed
 * throw and a run left `succeeded` with no delta and nothing saying why -- so it propagates to the
 * pump's `console.error`, which is where an operator will at least find it.
```

- [ ] **Step 6: Correct the M40 gate's stage-3 comment**

In `scripts/gate-m40-requirement-versioning.mjs`, replace the comment block at lines 828–833 (`// Erratum E8's regression guard, taken at the point the board is at its most terminal: …`) with:

```js
  // The dedup, measured: the goal has not moved since v2, so no tick may start a planning run of
  // any kind.
  //
  // NOT erratum E8's regression guard, though it was described as one when it was written. E8 is
  // about a board whose tasks have ALL finished, and this board has not: the addition `docs` is
  // `ready` and carries goal version 2, so `max(Task.goalVersion)` is 2 under the old rule and the
  // new one alike, and this assertion passes either way. The RED proof for E8 is
  // `apps/orchestrator/test/integration/planning.test.ts`'s "starts nothing on a board whose tasks
  // have ALL finished, while the goal stands still", which sets every task `done` first and is the
  // only test in the tree that fails when the max is taken over the non-terminal tasks.
```

- [ ] **Step 7: Record the R3(d) ledger note**

R3(d) asks for a "non-numeric-version test" on "the goal-history route's body validator". There is none to write, and the plan's erratum **E10** says why: `GET /api/w/[workspaceId]/goal/history` takes no body and no version parameter, and the only body validator in the goal routes — `POST .../goal`'s `z.object({ goal: z.string() })` — is already covered by `apps/web/test/integration/control-routes.test.ts` → `describe('goal')` → case **(b) 400s on a non-string goal and on an unparseable body**, which passes `{ goal: 5 }`. Write no test. Put this paragraph in the Task 1 report verbatim, and cite E10 in the commit body.

- [ ] **Step 8: Run the touched suites and the vocabulary gate**

Run, one at a time:
```bash
npx vitest run apps/orchestrator/test/integration/cli.test.ts
npm run --silent typecheck
npm run gate:m26-vocabulary
```
Expected: all pass. (`cli.test.ts`'s llm-decision row-count case is a known flake under load — re-run the file alone before believing a failure there.)

- [ ] **Step 9: Commit**

```bash
git add apps/orchestrator/src/cli.ts apps/orchestrator/src/replan.ts \
        scripts/gate-m40-requirement-versioning.mjs apps/orchestrator/test/integration/cli.test.ts
git commit -m "$(cat <<'EOF'
docs(orchestrator,gates): m41 t1 — the M40 residuals: the board version covers every task, a failed re-plan's own recording can still throw, and the m40 gate stops claiming a guard it never had

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 2: The fake CLI's story mode — `m41-flow`, `--ask-on-task`, and the scenario plan fixture

**Files:**
- Create: `packages/providers/test/fixtures/plan-graph-scenario.ndjson`
- Modify: `packages/providers/test/fake-claude.mjs` (header doc; `askOnTaskTitle()`; `isAskingLeg()`; the `m41-flow` mode body)
- Modify: `packages/providers/test/fixtures/README.md` (one table row + the recipe)
- Test: `packages/providers/test/fake-claude.test.ts` (new `describe('m41-flow')`; three existing "armed in every prompt-sniffing mode" loops gain `'m41-flow'`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, for Task 3 (the gate) to rely on **by these exact names**:
  - fixture mode name: `m41-flow`
  - argv flag: `--ask-on-task <token>` — the value is ONE WORD (spec E2/B5: `SLAVEOFAI_CLAUDE_ARGS` is split on single spaces), matched inside the prompt's `Task: <title>` line; the gate passes `core`, the last word of `Write the feature core`
  - environment variable read on the asking leg only: `FAKE_CLAUDE_ASK_JSON` (the `<slave-ask>` envelope JSON, e.g. `{"role":"qa","question":"…"}`)
  - plan fixture name: `plan-graph-scenario` (`fixtures/plan-graph-scenario.ndjson`)
  - the three task titles it plans, unchanged from `plan-graph`: `Write the feature core`, `Expose the API`, `Document and polish`
  - the sentence `plan-graph-scenario`'s **core** description carries verbatim: `PostgreSQL on port 5433`
  - the file a work run writes and commits: `m41-work.txt`, committed as `Fake Claude <fake@slaveofai.local>` with the message `fake work`
  - every arm's replay fixture, unchanged from the other flow modes: `supervisor-decision`, `supervisor-answer` (or `--answer-fixture <name>`), `replan-delta`, `review-approve`, `complete`

- [ ] **Step 1: Build the plan fixture from `plan-graph.ndjson`, mechanically**

Rule 4 of `fixtures/README.md` — "never add, remove or reorder a line to make a fixture fit a test" — binds this file: it is an EDIT of `plan-graph.ndjson` (itself an edit of `complete.ndjson`), the same latitude `replan-delta.ndjson` took, and the edit is three description strings and nothing else. Each description appears exactly **twice** in the file (once in the final assistant text block, once in the terminal `result.result`, which are the same JSON string), and the script below refuses to run if that is not what it finds. Run it from the repository root:

```bash
node -e '
const fs = require("node:fs")
const src = fs.readFileSync("packages/providers/test/fixtures/plan-graph.ndjson", "utf8")
const swaps = [
  ["Implement the core module the goal asks for.",
   "Implement the core module the goal asks for. The service talks to PostgreSQL on port 5433 in every environment, including the gate's own."],
  ["Wire the core into the public surface.",
   "Wire the core into the public surface, over the same database the core module uses."],
  ["README and cleanup on top of the API.",
   "README and cleanup on top of the API, once the endpoint is real."],
]
let out = src
for (const [from, to] of swaps) {
  const found = out.split(from).length - 1
  if (found !== 2) throw new Error("expected 2 occurrences of " + JSON.stringify(from) + ", found " + found)
  out = out.split(from).join(to)
}
fs.writeFileSync("packages/providers/test/fixtures/plan-graph-scenario.ndjson", out)
console.log("wrote packages/providers/test/fixtures/plan-graph-scenario.ndjson")
'
```

Then check the three facts the gate depends on:

```bash
node -e '
const fs = require("node:fs")
const lines = fs.readFileSync("packages/providers/test/fixtures/plan-graph-scenario.ndjson", "utf8").split("\n").filter((l) => l.length > 0)
const result = lines.map((l) => JSON.parse(l)).find((l) => l.type === "result")
console.log("total_cost_usd:", result.total_cost_usd)
console.log("carries the quote:", result.result.includes("PostgreSQL on port 5433"))
console.log("titles:", JSON.parse(result.result.slice(result.result.indexOf("{"))).tasks.map((t) => t.title))
const last = JSON.parse(lines[lines.length - 1])
console.log("ends with the Stop hook line:", last.type === "system" && last.subtype === "hook_response" && last.hook_event === "Stop")
'
```

Expected output:
```
total_cost_usd: 0.20933900000000003
carries the quote: true
titles: [ 'Write the feature core', 'Expose the API', 'Document and polish' ]
ends with the Stop hook line: true
```

The titles are deliberately **unchanged** from `plan-graph`: the three-task shape, the `backend` roles and the `core → api → polish` dependency chain are already what R4 asks for, and a title change would be an edit the story does not need. The cost is unchanged for the same reason spec R4 gives — the spend table stays one lookup.

- [ ] **Step 2: Write the failing tests**

Add to `packages/providers/test/fake-claude.test.ts`, after the existing `describe('the re-plan arm (M40)', …)` block:

```ts
  describe('m41-flow (M41: the whole story in one mode)', () => {
    /** The one line `runContext.ts`'s `task` section always renders (erratum E2): a work run's
     *  prompt carries `Task: <title>`, and its task's ID appears nowhere in it. */
    const CORE_TITLE = 'Write the feature core'
    const CORE_PROMPT = `You are a slave.\n\nTask: ${CORE_TITLE}\n\nImplement the core module the goal asks for.`
    const API_PROMPT = 'You are a slave.\n\nTask: Expose the API\n\nWire the core into the public surface.'
    const ASK_JSON = JSON.stringify({ role: 'qa', question: 'Which database should this service connect to?' })

    let repoDir: string

    beforeEach(() => {
      repoDir = mkdtempSync(path.join(tmpdir(), 'fake-claude-m41-flow-'))
      execFileSync('git', ['init', '-q'], { cwd: repoDir })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial commit'], {
        cwd: repoDir,
      })
    })

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true })
    })

    const commitCount = (): number =>
      execFileSync('git', ['log', '--oneline'], { cwd: repoDir }).toString().trim().split('\n').length

    it('replays the story plan fixture as a static mode, quote and cost intact', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'plan-graph-scenario'])
      const result = parseLines(stdout).find((l) => l.type === 'result') as
        | { result?: string; total_cost_usd?: number }
        | undefined
      // The sentence `supervisor-answer.ndjson` cites. Without it in the asking task's own
      // description the Supervisor's answer could never be `sourced`, which is the whole of act 3.
      expect(result?.result).toContain('PostgreSQL on port 5433')
      expect(result?.result).toContain('"key":"core"')
      // Same cost as `plan-graph`, so the gate's spend table stays one lookup (ruling R4).
      expect(result?.total_cost_usd).toBe(0.20933900000000003)
    })

    it('a planning run replays plan-graph-scenario, NOT the stock plan-graph, and makes no commit', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'm41-flow', '-p', 'produce the "task graph" now'], {
        cwd: repoDir,
      })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('PostgreSQL on port 5433')
      expect(commitCount()).toBe(1)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()).toBe('')
    })

    it('a review run replays the approval fixture and makes no commit', async (): Promise<void> => {
      const { stdout } = await run('node', [FAKE, '--fixture', 'm41-flow', '-p', 'respond with "verdict" json'], {
        cwd: repoDir,
      })
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"verdict":"approve"')
      expect(commitCount()).toBe(1)
    })

    it('a re-plan run replays the delta with --replan-cancel substituted, and makes no commit', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--replan-cancel', 'task-to-drop', '--fixture', 'm41-flow', '-p', 'this is a "replan"'],
        { cwd: repoDir },
      )
      const result = parseLines(stdout).find((l) => l.type === 'result') as { result?: string } | undefined
      expect(result?.result).toContain('"cancel":["task-to-drop"]')
      expect(result?.result).toContain('"key":"docs"')
      expect(commitCount()).toBe(1)
    })

    it('the asking leg fires only for the named task: ask block in, no commit', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--ask-on-task', 'core', '--fixture', 'm41-flow', '-p', CORE_PROMPT],
        { cwd: repoDir, env: { ...process.env, FAKE_CLAUDE_ASK_JSON: ASK_JSON } },
      )
      // The envelope is appended to the LAST assistant text block, not emitted as a line of its
      // own, so the pump reads it through the exact stream shape a real run produces.
      expect(stdout).toContain('<slave-ask>')
      expect(stdout).toContain('"recipientRole"'.replace('recipientRole', 'role'))
      // An ask is not work: the run stopped to ask, so it left nothing behind.
      expect(commitCount()).toBe(1)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString().trim()).toBe('')
    })

    it('a work run for ANOTHER task commits instead of asking, even with --ask-on-task set', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--ask-on-task', 'core', '--fixture', 'm41-flow', '-p', API_PROMPT],
        { cwd: repoDir, env: { ...process.env, FAKE_CLAUDE_ASK_JSON: ASK_JSON } },
      )
      expect(stdout).not.toContain('<slave-ask>')
      expect(commitCount()).toBe(2)
      expect(readFileSync(path.join(repoDir, 'm41-work.txt'), 'utf8')).toContain('You are a slave.')
    })

    it('the RESUMED leg of the very same task commits instead of asking again', async (): Promise<void> => {
      const { stdout } = await run(
        'node',
        [FAKE, '--ask-on-task', 'core', '--fixture', 'm41-flow', '-p', CORE_PROMPT, '--resume', 'fake-session-complete'],
        { cwd: repoDir, env: { ...process.env, FAKE_CLAUDE_ASK_JSON: ASK_JSON } },
      )
      // `--resume` is the ONE thing the runtime itself puts on a resumed argv
      // (`ClaudeCodeAdapter.resume`), so a second ask on the same session is impossible by
      // construction rather than by wording.
      expect(stdout).not.toContain('<slave-ask>')
      expect(commitCount()).toBe(2)
    })

    it('a work run with no --ask-on-task at all commits', async (): Promise<void> => {
      await run('node', [FAKE, '--fixture', 'm41-flow', '-p', CORE_PROMPT], { cwd: repoDir })
      expect(commitCount()).toBe(2)
    })

    it('ignores an --ask-on-task whose value is another flag', async (): Promise<void> => {
      await run('node', [FAKE, '--ask-on-task', '--fixture', 'm41-flow', '-p', CORE_PROMPT], { cwd: repoDir })
      expect(commitCount()).toBe(2)
    })

    it('refuses the asking leg with no envelope in the environment, rather than asking nothing', async (): Promise<void> => {
      const env = { ...process.env }
      delete env.FAKE_CLAUDE_ASK_JSON
      await expect(
        run('node', [FAKE, '--ask-on-task', 'core', '--fixture', 'm41-flow', '-p', CORE_PROMPT], {
          cwd: repoDir,
          env,
        }),
      ).rejects.toMatchObject({ code: 2 })
    })
  })
```

Add `readFileSync` to the `node:fs` import at the top of the file:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
```

And add `'m41-flow'` to the three existing mode loops so the decision arms are proven armed in it too:

- `describe('the supervisor arm (M38)')` → `for (const mode of ['m8-flow', 'm8a-flow', 'm36-flow', 'm41-flow'])`
- `describe('the answer arm (M39)')` → `for (const mode of ['m8-flow', 'm8a-flow', 'm36-flow', 'm41-flow'])`

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/providers/test/fake-claude.test.ts`
Expected: FAIL — the `m41-flow` cases fall through to the default branch and die with `ENOENT … fixtures/m41-flow.ndjson`; the two mode loops fail the same way.

- [ ] **Step 4: Extend the fake CLI's header doc**

In `packages/providers/test/fake-claude.mjs`, insert this block immediately after the `M40 adds the RE-PLAN arm …` paragraph and before the `//   anything else  replays fixtures/<name>.ndjson verbatim` line:

```
//   m41-flow       synthetic, M41's whole-story mode: every arm one gate
//                  needs, in one file, so a single daemon lineage can plan,
//                  work, ask, be answered, resume, be reviewed and be
//                  re-planned without ever changing modes. Precedence,
//                  first match wins: the two decision arms
//                  (`"candidateIndex"`, then `"sources"`), the re-plan arm
//                  (`"replan"`), planning (`"task graph"`), review
//                  (`"verdict"`), and finally work.
//                  Its planning arm replays `plan-graph-scenario`, NOT the
//                  stock `plan-graph`: the story needs a `core` task whose
//                  description carries the sentence `supervisor-answer`
//                  cites (`PostgreSQL on port 5433`), and editing the stock
//                  fixture would silently change what m8 and m40 measure.
//                  A work run is the ASKING leg -- the m36-flow body,
//                  `complete` with the `FAKE_CLAUDE_ASK_JSON` envelope
//                  appended to its last assistant text block -- only when
//                  ALL THREE hold: `--ask-on-task <token>` (one word) is in ARGV,
//                  the prompt carries the literal `Task: <that title>`, and
//                  argv has NO `--resume`. Every other work run, the resumed
//                  leg included, writes `m41-work.txt`, commits it as `Fake
//                  Claude`, and replays `complete`.
//                  ARGV is the channel because a run's spawn args are the
//                  only deterministic per-daemon knob a gate has (M39 E6);
//                  `SLAVEOFAI_CLAUDE_ARGS` rides through as `extraArgs` on
//                  every run and every decision call. The TITLE is the
//                  discriminator, not the task id, because a work run's
//                  prompt does not contain its task's id at all (M41 E2):
//                  `apps/orchestrator/src/runContext.ts` renders the `task`
//                  section as `Task: <title>\n\n<description>`, and ids
//                  appear only in a planning or re-plan run's board lines.
//                  Two workers share the `backend` role in that story and
//                  exactly one of them may stop to ask, which is what the
//                  discriminator is for.
```

- [ ] **Step 5: Add the argv helpers**

In `packages/providers/test/fake-claude.mjs`, immediately after `replanCancelId()` (and before `substituteCancelId`), add:

```js
/** M41: the one-word TOKEN naming the task a work run must stop and ask about -- `--ask-on-task <token>` from
 *  ARGV, or `null` when the flag is absent, or present with another flag where its value should be
 *  (an omitted value is not a title). Same shape as {@link replanCancelId}, and argv for the same
 *  reason: it is the one per-daemon knob that reaches a run's child. */
function askOnTaskTitle() {
  const index = args.indexOf('--ask-on-task')
  const named = index === -1 ? undefined : args[index + 1]
  return named === undefined || named.startsWith('-') ? null : named
}

/**
 * M41: is THIS work run the asking leg?
 *
 * Three facts, all of them the runtime's rather than this file's. The FLAG says which task the
 * gate wants a question from. `Task: <title>` is the one line the run-context `task` section
 * always renders (`apps/orchestrator/src/runContext.ts`), and it is what identifies the task a
 * prompt is about -- erratum E2: the task's ID is not in a work run's prompt anywhere, so keying
 * on an id would silently never match and the story would run with no question in it. And
 * `--resume` is what `ClaudeCodeAdapter.resume` appends and nothing else does, so the resumed leg
 * of the very session that asked can never ask again (the m36-flow discriminator, unchanged).
 */
function isAskingLeg(prompt) {
  const token = askOnTaskTitle()
  if (token === null) return false
  if (args.includes('--resume')) return false
  // The `task` section's own first line, and the token that identifies WHICH task inside it. A
  // whole title cannot be the flag's value: `SLAVEOFAI_CLAUDE_ARGS` is split on a single space, so
  // a flag value must be one word. The line is matched, not the bare token, so a token that also
  // occurs in a description or an inbox message cannot turn some other run into an asking leg.
  const line = prompt.split('\n').find((one) => one.startsWith('Task: '))
  return line !== undefined && line.includes(token)
}
```

- [ ] **Step 6: Add the `m41-flow` mode body**

In `packages/providers/test/fake-claude.mjs`, inside `main()`, add this block immediately after the `m8-flow` block and before the `m8a-flow` block:

```js
  if (fixtureName === 'm41-flow') {
    const prompt = await promptText()
    if (await supervisorArm(prompt)) return
    if (await answerArm(prompt)) return
    if (await replanArm(prompt)) return
    if (prompt.includes('"task graph"')) {
      // The story's OWN plan (ruling R4): three `backend` tasks core -> api -> polish, whose
      // `core` description carries the sentence `supervisor-answer.ndjson` cites verbatim.
      await replayFixture('plan-graph-scenario')
      return
    }
    if (prompt.includes('"verdict"')) {
      await replayFixture('review-approve')
      return
    }
    if (isAskingLeg(prompt)) {
      // The asking leg, verbatim from m36-flow. The envelope comes from the environment, not from
      // this file: the recipient is a role (or a slave id) that only the caller seeding the
      // workspace knows. A RUN inherits the daemon's environment, which is why this one channel is
      // an env var while `--ask-on-task` has to be argv.
      const askJson = process.env.FAKE_CLAUDE_ASK_JSON
      if (askJson === undefined || askJson.trim() === '') {
        process.stderr.write('fake-claude: m41-flow was told to ask on this task but has no FAKE_CLAUDE_ASK_JSON (the <slave-ask> envelope) in the environment\n')
        process.exit(2)
      }
      // Appended to the LAST assistant text block of the real `complete` capture rather than
      // emitted as a synthetic line of its own: the block then reaches the pump through the exact
      // stream shape a real run produces, and the fixture's own `system:init` line still supplies
      // the session id the checkpoint is written from.
      const lines = readFixtureLines('complete')
      let patched = false
      for (let i = lines.length - 1; i >= 0 && !patched; i -= 1) {
        const parsed = JSON.parse(lines[i])
        if (parsed.type !== 'assistant') continue
        const block = parsed.message?.content?.find?.((part) => part.type === 'text')
        if (block === undefined) continue
        block.text = `${block.text}\n\n<slave-ask>\n${askJson}\n</slave-ask>`
        lines[i] = JSON.stringify(parsed)
        patched = true
      }
      if (!patched) {
        process.stderr.write('fake-claude: m41-flow could not find an assistant text block in the complete fixture\n')
        process.exit(2)
      }
      await writeLines(lines)
      process.exit(0)
    }
    // Any other work run, the RESUMED leg included: the m8a-flow work body verbatim -- a real
    // commit in the worktree (cwd) -- and then `complete` UNmodified, so this leg carries no ask
    // block and concludes for real.
    writeFileSync(path.join(process.cwd(), 'm41-work.txt'), `${prompt.slice(0, 80)}\n`)
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'add', '-A'], { cwd: process.cwd() })
    execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'commit', '-q', '-m', 'fake work'], { cwd: process.cwd() })
    await replayFixture('complete')
    return
  }
```

The ask body and the work body are duplicated from `m36-flow`/`m8a-flow` verbatim rather than factored out. That is this file's house style — `m8-flow` and `m8a-flow` already carry the same work body twice — and it is deliberate here: each mode is a self-contained account of one milestone's story, and a shared helper would make a change made for M41 silently change what m8 and m36 replay.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/providers/test/fake-claude.test.ts`
Expected: PASS, including the directory-wide "every fixture file ends with the routine Stop hook line" case, which now enumerates `plan-graph-scenario.ndjson` too.

- [ ] **Step 8: Document the fixture in `fixtures/README.md`**

Add this row to the replay-modes table, immediately after the `replan-delta.ndjson` row:

```
| `plan-graph-scenario.ndjson` | M41 Task 2 | `plan-graph`'s transcript with its three task DESCRIPTIONS rewritten and nothing else — same three titles, same `backend` roles, same `core → api → polish` chain, same `total_cost_usd` (0.209). The `core` description carries the sentence `supervisor-answer.ndjson` cites (`PostgreSQL on port 5433`) verbatim, which is what lets the M41 scenario's Supervisor answer a question from the asking task's own text; the stock `plan-graph` descriptions carry no such sentence, and editing that file instead would have silently changed what `gate-m8-plan` and `gate-m40-requirement-versioning` measure. Drives `m41-flow`'s planning arm. |
```

Update the sentence just below the table:

```
The three review fixtures, `plan-graph`, `plan-graph-scenario` and `replan-delta` share `complete`'s
`session_id` (`fake-session-complete`) because they are edits of it, not separate captures.
```

And add this subsection immediately after the table's trailing paragraph, before `## permission-matrix-deny.ndjson`:

````
### `plan-graph-scenario.ndjson` — the substitution, as a runnable command

Three description strings, each appearing exactly twice (the final assistant text block and the
terminal `result.result` carry the same JSON string), replaced mechanically. The script refuses to
run if it does not find exactly two of each, so it cannot half-apply:

```bash
node -e '
const fs = require("node:fs")
const src = fs.readFileSync("packages/providers/test/fixtures/plan-graph.ndjson", "utf8")
const swaps = [
  ["Implement the core module the goal asks for.",
   "Implement the core module the goal asks for. The service talks to PostgreSQL on port 5433 in every environment, including the gate's own."],
  ["Wire the core into the public surface.",
   "Wire the core into the public surface, over the same database the core module uses."],
  ["README and cleanup on top of the API.",
   "README and cleanup on top of the API, once the endpoint is real."],
]
let out = src
for (const [from, to] of swaps) {
  const found = out.split(from).length - 1
  if (found !== 2) throw new Error("expected 2 occurrences of " + JSON.stringify(from) + ", found " + found)
  out = out.split(from).join(to)
}
fs.writeFileSync("packages/providers/test/fixtures/plan-graph-scenario.ndjson", out)
'
```

Nothing else was altered: line count, ordering, `session_id`, `total_cost_usd` and every other field
are `plan-graph`'s own.
````

- [ ] **Step 9: Run the suite and the vocabulary gate**

Run, one at a time:
```bash
npx vitest run packages/providers/test/fake-claude.test.ts
npm run --silent typecheck
npm run gate:m26-vocabulary
```
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/providers/test/fake-claude.mjs packages/providers/test/fake-claude.test.ts \
        packages/providers/test/fixtures/plan-graph-scenario.ndjson packages/providers/test/fixtures/README.md
git commit -m "$(cat <<'EOF'
test(providers): m41 t2 — one fake-CLI mode for the whole story, and the plan fixture the story is told from

`m41-flow` serves every arm one gate needs, and `--ask-on-task <token>` makes exactly one of two
workers stop and ask. The discriminator is the task TITLE, not its id: a work run's prompt renders
`Task: <title>` and never carries the id (erratum E2).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 3: The gate — `scripts/gate-m41-scenario.mjs`

**Files:**
- Create: `scripts/gate-m41-scenario.mjs`
- Create: `apps/web/test/gate-surface-parity.test.ts`
- Test: the gate is run by hand in Step 12; the parity test by vitest.

**Interfaces:**
- Consumes from Task 2: the mode `m41-flow`, the flag `--ask-on-task <title>`, the env var `FAKE_CLAUDE_ASK_JSON`, the fixture `plan-graph-scenario`, the titles `Write the feature core` / `Expose the API` / `Document and polish`, the quote `PostgreSQL on port 5433`, the work file `m41-work.txt`.
- Consumes from the built packages (all already published in `dist` and already imported by other gates):
  ```js
  import { prisma } from '../packages/db/dist/client.js'
  import { isAlive, listDecisions, listGoalVersions, listPendingQuestions, loadSupervisorWorld,
           supervisorSettings, workspaceSpend, workspaceStats } from '../packages/control/dist/index.js'
  import { NON_TERMINAL_RUN_STATUSES, goalSha256, runContextManifestSchema, summarise } from '../packages/domain/dist/index.js'
  import { loadWorld } from '../apps/orchestrator/dist/index.js'
  ```
- Produces for Task 4: the script path `scripts/gate-m41-scenario.mjs`, the workspace name `M41 Scenario Project`, and the act structure the narrative documents.

#### R6 / erratum E9 — how the gate reads the operator's surfaces

`apps/web` compiles with `"noEmit": true` and `"moduleResolution": "bundler"`; there is no `dist`, no gate has ever imported `apps/web/src/server/*`, and a plain `node` script cannot resolve its `@/` aliases or its `.tsx` graph. So the gate does **not** import the web builders — and it does **not** grow a control helper either, because there is nothing left to write: each builder is a composition of verbs the gate can already call. The mapping, which goes into the gate's header verbatim:

| Web field | The verb the gate reads it through |
| --- | --- |
| `buildSupervisorView().report` | `summarise((await loadSupervisorWorld(id)).world)` — the builder's own line |
| `buildSupervisorView().pending` / `.recent` | `listDecisions(id, { pending: true })` / `listDecisions(id)` |
| `buildSupervisorView().settings` | `supervisorSettings(id)` |
| `buildSupervisorView().questions` | `(await loadSupervisorWorld(id)).world.questions` |
| `buildGoalHistory()` | `listGoalVersions(id)` — the builder unwraps the `Result` and nothing else |
| `TasksSnapshot.workspace.goalVersion` | `Workspace.goalVersion` |
| `TaskBoardItem.{status,goalVersion,integratedAt}` | the `Task` columns of the same names |
| the task card's **stale** badge, as a count | `summarise(world).next.stale` |
| `OverviewSnapshot.tasks.{active,ready,blocked,done,failed}` | the board, counted by status |
| `OverviewSnapshot.workspace.spentUsd` / `supervisorSpend` | `workspaceSpend(id)` |

`apps/web/test/gate-surface-parity.test.ts` (Step 2) pins that mapping so it cannot quietly stop being true.

- [ ] **Step 1: Write the parity test (it is the failing test for R6)**

Create `apps/web/test/gate-surface-parity.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { listGoalVersions, loadSupervisorWorld, setGoal, workspaceSpend } from '@slave-of-ai/control'
import { summarise } from '@slave-of-ai/domain'
import { buildSupervisorView } from '../src/server/supervisor'
import { buildGoalHistory } from '../src/server/goal'
import { buildTasksSnapshot } from '../src/server/tasks'
import { buildOverviewSnapshot } from '../src/server/overview'

/**
 * M41 ruling R6 / erratum E9: `scripts/gate-m41-scenario.mjs` asserts the operator's surfaces
 * WITHOUT importing them. It cannot import them -- `apps/web` compiles with `noEmit: true` under
 * a bundler resolver, so there is no built output for a plain `node` script to load -- and it does
 * not need a control helper of its own either, because every field it reads is already a control
 * or domain verb the builders themselves compose.
 *
 * That claim is only true while it stays true. These cases are the pin: each one asserts that a
 * builder's field IS the verb the gate reads instead of it. A builder that starts computing
 * something of its own fails here, and whoever changes it learns in the same commit that the gate
 * has stopped measuring the surface it says it measures.
 */
describe('the gate reads the same facts the web builders publish', () => {
  let workspaceId: string

  beforeEach(async (): Promise<void> => {
    await prisma.executionEvent.deleteMany({ where: { workspace: { name: 'M41 Parity Project' } } })
    await prisma.workspace.deleteMany({ where: { name: 'M41 Parity Project' } })
    const workspace = await prisma.workspace.create({
      data: {
        name: 'M41 Parity Project',
        repoPath: '/tmp/m41-parity-does-not-need-to-exist',
        baseBranch: 'main',
        autoMerge: false,
        verifyCommands: ['true'],
        setupCommands: [],
        maxAttempts: 5,
      },
    })
    workspaceId = workspace.id
    const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
    await prisma.slave.create({
      data: { teamId: team.id, name: 'Dev', role: 'Senior Engineer', runtimeRoles: ['backend'] },
    })
    expect((await setGoal(workspaceId, 'Ship the thing')).ok).toBe(true)
    await prisma.task.create({
      data: { workspaceId, title: 'One', description: 'a task', status: 'ready', requiredRole: 'backend', maxAttempts: 5, goalVersion: 1 },
    })
  })

  it('the Supervisor view\'s report IS summarise() over loadSupervisorWorld()\'s world', async (): Promise<void> => {
    const now = new Date()
    const view = await buildSupervisorView(workspaceId, now)
    const loaded = await loadSupervisorWorld(workspaceId, now)

    expect(view).not.toBeNull()
    expect(view?.report).toEqual(summarise(loaded.world))
    expect(view?.questions.length).toBe(loaded.world.questions.length)
  })

  it('the goal history IS listGoalVersions()', async (): Promise<void> => {
    const history = await buildGoalHistory(workspaceId)
    const versions = await listGoalVersions(workspaceId)

    expect(versions.ok).toBe(true)
    expect(history).toEqual(versions.ok ? versions.value : null)
  })

  it('the tasks snapshot publishes the Task and Workspace columns unchanged', async (): Promise<void> => {
    const snapshot = await buildTasksSnapshot(workspaceId)
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    const tasks = await prisma.task.findMany({ where: { workspaceId } })

    expect(snapshot?.workspace.goalVersion).toBe(workspace.goalVersion)
    expect(snapshot?.tasks.map((one) => [one.id, one.status, one.goalVersion, one.integratedAt])).toEqual(
      tasks.map((one) => [one.id, one.status, one.goalVersion, one.integratedAt === null ? null : one.integratedAt.toISOString()]),
    )
  })

  it('the overview\'s task counts are the board counted by status, and its spend IS workspaceSpend()', async (): Promise<void> => {
    const snapshot = await buildOverviewSnapshot(workspaceId)
    const tasks = await prisma.task.findMany({ where: { workspaceId } })
    const spend = await workspaceSpend(workspaceId)

    const countOf = (statuses: readonly string[]): number => tasks.filter((one) => statuses.includes(one.status)).length
    expect(snapshot?.tasks.ready).toBe(countOf(['ready']))
    expect(snapshot?.tasks.done).toBe(countOf(['done']))
    expect(snapshot?.tasks.failed).toBe(countOf(['failed']))
    expect(snapshot?.tasks.blocked).toBe(countOf(['blocked']))
    expect(snapshot?.workspace.spentUsd).toBe(spend.spentUsd)
  })
})
```

- [ ] **Step 2: Run the parity test to verify it passes on the tree as it is**

Run: `npx vitest run apps/web/test/gate-surface-parity.test.ts`
Expected: PASS. (This one is a **characterisation** test, not a red-first test: it exists to freeze a mapping that is already true, and the value is the failure it will produce when somebody changes a builder. If it does NOT pass, R6's premise is already broken and the gate must import the builders through a different route — stop and report before writing the gate.)

- [ ] **Step 3: Write the gate's header and its scaffolding**

Create `scripts/gate-m41-scenario.mjs`. Header first, in the house voice:

```js
// M41's own gate: ONE story, told once, through the whole system.
//
// Every earlier gate proves one seam under a real daemon -- m35 integration truth, m36 ask/answer
// across a restart, m37 the recorded prompt, m38 staffing and budget, m39 the mailbox, m40
// re-planning. None of them runs the seams in SEQUENCE, and the sequence's claim -- a team that
// coordinates itself and tells the truth about its state -- is only proven when one run crosses all
// of them. This is that run: an operator sets a requirement, a manager plans it, a worker starts,
// stops to ask a question nobody can answer, the Supervisor answers it from a sentence in the
// worker's own task and wakes it up, the work is verified, reviewed, merged by hand and confirmed,
// the requirement changes, a delta re-plan adds work and PROPOSES a cancellation, a human approves
// it -- and then, with nothing running, every operator surface is asked what happened and has to
// agree.
//
// NEVER A MODEL CALL. Every daemon here is spawned with `SLAVEOFAI_CLAUDE_BIN=node`,
// `SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m41-flow [--ask-on-task <title>]
// [--replan-cancel <id>]"` and `SLAVEOFAI_REQUIRE_FAKE_CLI=1` (M32 item 7: lose the first two and
// the daemon refuses to start rather than falling back to the real binary).
//
// WHY THE WORKSPACE DOES NOT AUTO-MERGE (erratum E4, and the load-bearing decision in this file).
// `autoMerge: false` buys three things at once:
//   1. `task.integrated` becomes real. `merge.ts`'s AUTO path stamps `Task.integratedAt` and emits
//      `task.done`; the `task.integrated` event exists only in `confirmIntegration`. Under
//      auto-merge the truth table's "task.integrated 2" would be zero.
//   2. M35's integration honesty becomes a measured ACT rather than a footnote: a task that is
//      `done` with an unmerged branch does not unblock its dependent, and this gate reads that off
//      the orchestrator's OWN `loadWorld` before merging the branch by hand.
//   3. It is the only thing that makes acts 4 and 5 deterministic. `tick.ts` dispatches work FIRST
//      and only then plans, reviews and merges -- so under auto-merge, daemon-4's very first tick
//      would start `polish` before `dispatchPlanning` was ever reached, the re-plan's cancellation
//      of a RUNNING task would be dropped by `applyCancelPolicy`, and act 6 would have nothing to
//      approve. With integration in the operator's hands, `polish` is provably unstartable for as
//      long as `api` is done-but-unconfirmed.
//
// WHY THERE IS A FIFTH SLAVE NOBODY EVER DISPATCHES (erratum E1). `ask.ts`'s `recipientCanAnswer`
// refuses an ask addressed to a role no OTHER slave holds -- parking a task to wait for nobody is
// the bug that check exists to prevent -- so a question can only BECOME unanswerable after it was
// asked. `Quinn` holds `qa` while the question is asked and loses it to the operator's own
// `set-runtime-roles --roles ''` immediately afterwards, which is `gate-m39-supervisor-mailbox.mjs`'s
// idiom and the only shape in which `unanswerable_question` is reachable at all. Quinn holds no
// task-shaped role, so the scheduler never dispatches it.
//
// WHY `--ask-on-task` CARRIES A TITLE (erratum E2). Two workers share the `backend` role and
// exactly one of them may stop to ask, so the fake CLI needs to know WHICH task. A work run's
// prompt does not contain its task's id anywhere: `runContext.ts` renders the `task` section as
// `Task: <title>\n\n<description>` and ids appear only in a planning run's board lines. The title
// under that literal prefix is the discriminator, and argv is the channel because a run's spawn
// args are the only deterministic per-daemon knob a gate has (M39 E6).
//
// WHY EVERY DAEMON IS STOPPED AT A MEASURED POINT. Three acts end by stopping a daemon before
// something else could start, and each one PROVES it rather than hoping: `stopBeforeRunsFor` stops
// the process and then asserts that no `SlaveRun` row exists for the work that was not supposed to
// begin. The tick's own ordering is what bounds the window -- whatever the act waited for (a plan
// committed, a merge landed, a re-plan concluded) happened after that tick's dispatch phase, so the
// next dispatch is a whole daemon period away and this gate polls at 25 ms. If a run exists anyway
// the gate FAILS: the story's claim about what had and had not started would be false, and
// tolerating it would turn every count after it into a race.
//
// HOW THE OPERATOR'S SURFACES ARE ASSERTED WITHOUT `apps/web` (ruling R6, erratum E9). `apps/web`
// compiles with `noEmit: true` under a bundler resolver: there is no built output a plain `node`
// script can import, and no gate has ever imported one. It does not need one. Every field of the
// three builders is a control or domain verb they themselves compose, and this gate calls those:
//   buildSupervisorView().report      = summarise(loadSupervisorWorld(id).world)
//   buildSupervisorView().pending     = listDecisions(id, { pending: true })
//   buildSupervisorView().settings    = supervisorSettings(id)
//   buildGoalHistory()                = listGoalVersions(id)
//   TasksSnapshot.workspace.goalVersion / TaskBoardItem.{status,goalVersion,integratedAt}
//                                     = the Workspace and Task columns of those names
//   the task card's stale badge, counted = summarise(world).next.stale
//   OverviewSnapshot.tasks.*          = the board, counted by status
//   OverviewSnapshot.workspace.spentUsd = workspaceSpend(id).spentUsd
// `apps/web/test/gate-surface-parity.test.ts` pins that mapping, so a builder that starts computing
// something of its own fails a test in the same commit rather than silently making this gate a
// measurement of nothing.
//
// EVERY PRICE IS READ AT RUNTIME. `fixtureCostUsd(name)` opens the fixture and takes the terminal
// `result` line's `total_cost_usd`. Nothing here memorises a number: a fixture re-recorded tomorrow
// moves every figure in the spend table with it, and a gate that had memorised one would be
// asserting history.
//
// ACTS
//   1. Plan. `set-goal` v1 prints {version:1, sha256}; daemon-1's manager lands core -> api ->
//      polish, all `ready`, all goal v1; `workspace.plan_created` carries the version; the planning
//      run's manifest says `planning_goal.version 1` and has NO `replan` section. Daemon-1 is
//      stopped before any work run starts, and that is asserted.
//   2. Work, and a question. Daemon-2 carries `--ask-on-task "<core title>"` and the envelope. Core
//      dispatches to one of the two backend workers (recorded), the run parks `waiting_for_answer`,
//      the task parks `waiting`, one `question` row exists, no attempt is charged, nothing else on
//      the board moves. The run's manifest hashes the exact task text the renderer hashed. Then the
//      operator takes `qa` away from Quinn.
//   3. The answer. The Supervisor's next pass sees `unanswerable_question`, chooses
//      `answer_question`, drafts one, verifies its quote against core's own description, and the
//      row is `applied`/`applied` with `draft.confidence 'sourced'` and both calls' cost on it. One
//      `answer` message, actor `system`, `answeredBy: 'supervisor'`. A later tick's `deliverAnswers`
//      resumes the SAME session, and the resumed leg commits.
//   4. Verify, review, integrate -- and the dependency that stays shut until a human says so. Core
//      verifies, Rae reviews it, the merge pass marks it `done` with `integratedAt` NULL, and `api`
//      reports `dependenciesDone: false` through the orchestrator's own `loadWorld`. The operator
//      merges the branch into `main` for real and runs `confirm-integration`; `api` becomes
//      schedulable; daemon-3 takes it through the same pipeline with no question in it.
//   5. The requirement changes. `set-goal` v2; `goal-history` prints v2 before v1 with the diff;
//      `replan-status` says a re-plan is due with nothing in the way. Daemon-4 carries
//      `--replan-cancel <polish>`; the re-plan run's manifest has a `replan` section (v1 -> v2) over
//      the NON-terminal board alone, its prompt carries `THE GOAL CHANGED` and both goal texts; on
//      conclusion one new task `docs` at goal v2, one PENDING `stale_task` proposal naming polish,
//      and `workspace.replanned` accounting for all four lists.
//   6. A human approves. `approve-decision` cancels polish with `task.cancelled { goalVersion: 1 }`
//      and actor `human`; then the operator merges api's branch and confirms its integration.
//   7. The truth table. With no daemon anywhere, every surface is asked and has to agree: the
//      board, the goal history, the Supervisor's report and decisions, the mailbox, the printed
//      spend table against `workspaceSpend`, and a per-type event census.
//
// Shape borrowed from `gate-m40-requirement-versioning.mjs` (temp git repo + `prisma.workspace.
// create` setup, `preflightCleanup()`/`dumpGateRows()`/`fail()`/`waitUntil()`, the daemon lifecycle
// and its `findRealDaemonPids()` refusal, "print every measured value before asserting it", real CLI
// subprocesses through `execFileSync('node', [cliPath, ...])` with `loopbackChildEnv()`, `exitCode`
// starting at 1 and set to 0 only at the very end, teardown in FK order), from
// `gate-m39-supervisor-mailbox.mjs` (`askedQuestion`, `decisionFor`, `answersTo`,
// `resumedAndConcluded`, `sameMoney`), and from `gate-m36-messaging.mjs` (the restart proof).
```

Then the imports, constants and helpers:

```js
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loopbackChildEnv } from './lib/child-env.mjs'
import { findRealDaemonPids, isRealDaemonProcess } from './lib/daemon-process.mjs'
import { prisma } from '../packages/db/dist/client.js'
import {
  isAlive,
  listDecisions,
  listGoalVersions,
  listPendingQuestions,
  loadSupervisorWorld,
  supervisorSettings,
  workspaceSpend,
  workspaceStats,
} from '../packages/control/dist/index.js'
import { NON_TERMINAL_RUN_STATUSES, goalSha256, runContextManifestSchema, summarise } from '../packages/domain/dist/index.js'
import { loadWorld } from '../apps/orchestrator/dist/index.js'

// 25 ms rather than m39/m40's 50: three acts end by stopping a daemon inside one tick period, and
// the poll interval is half of what bounds that window.
const POLL_INTERVAL_MS = 25
// 750 ms rather than m39/m40's 500, for the same reason from the other side: the window between
// "the thing this act waited for landed" and "the next tick dispatches" IS one period, and this
// gate would rather spend a few seconds of wall clock than measure a race.
const DAEMON_PERIOD_MS = 750
// Generous, and every one of them bounds real work: a `git worktree add`, a fake CLI replay, a
// verify pass, a supervised tick, a resume, a merge. Tuned to "a slow machine still passes".
const DISPATCH_TIMEOUT_MS = 120_000
const PLAN_TIMEOUT_MS = 180_000
const WAITING_TIMEOUT_MS = 180_000
const SUPERVISOR_TIMEOUT_MS = 180_000
const RESUME_TIMEOUT_MS = 180_000
const PIPELINE_TIMEOUT_MS = 240_000
const REPLAN_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const FAKE_CLAUDE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const FIXTURES_DIR = join(repoRoot, 'packages/providers/test/fixtures')

// An exact literal, never suffixed -- `preflightCleanup` removes whatever a prior crashed run left
// on this exact name, in the same FK order the `finally` block uses.
const WORKSPACE_NAME = 'M41 Scenario Project'

/** The two requirements this story sets, in order. Each is ONE line, which is what makes the
 *  `goal-history` diff assertion exact: `goalDiff` is a set difference over trimmed non-blank
 *  lines, so a one-line edit is one addition and one removal and nothing else. */
const GOAL_V1 = 'Ship the scenario service: a core module, an API on top of it, and the polish around it.'
const GOAL_V2 = 'Ship the scenario service and document the new endpoint for the people who will call it.'

/** What `fixtures/plan-graph-scenario.ndjson` returns, and therefore what the first plan must
 *  produce. `CORE_TITLE` is also the `--ask-on-task` discriminator (erratum E2). */
const PLAN_TITLES = ['Write the feature core', 'Expose the API', 'Document and polish']
const CORE_TITLE = 'Write the feature core'
const API_TITLE = 'Expose the API'
const POLISH_TITLE = 'Document and polish'
/** What `fixtures/replan-delta.ndjson` adds. */
const ADDED_TITLE = 'Document the new endpoint'

/** The sentence `supervisor-answer.ndjson` cites, verbatim, and which `plan-graph-scenario`'s core
 *  description carries (ruling R4). It is what makes act 3 a MEASUREMENT: `verifySources` looks the
 *  quote up in the asking task's own text, so the answer is sent because the evidence is there. */
const SOURCED_QUOTE = 'PostgreSQL on port 5433'

/** The role the question is addressed to, and the one Quinn loses right after asking (erratum E1).
 *  Deliberately not `reviewer`: taking that away would strand act 4's review. */
const ASKED_ROLE = 'qa'
const ASK_QUESTION = 'Which database should this service connect to?'

/** What one replay of a fixture reports as `total_cost_usd`, read off the file at runtime. */
function fixtureCostUsd(name) {
  for (const line of readFileSync(join(FIXTURES_DIR, `${name}.ndjson`), 'utf8').split('\n')) {
    if (line.length === 0) continue
    const parsed = JSON.parse(line)
    if (parsed.type === 'result') return parsed.total_cost_usd
  }
  throw new Error(`fixture ${name}.ndjson has no terminal result line to read a cost from`)
}

/** Two dollar amounts are equal when they are equal as money, not as floats. */
const sameMoney = (actual, expected) => actual !== null && Math.abs(actual - expected) < 1e-9

/** A real repository, because every dispatch provisions a real worktree in it and the fake CLI
 *  commits into that worktree -- and because this gate merges two branches into `main` by hand. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-gate-m41-repo-'))
  const git = (args) => execFileSync('git', args, { cwd: dir })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Gate'])
  git(['config', 'user.email', 'gate@example.com'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}
```

`preflightCleanup`, `dumpGateRows`, `fail`, `describeTask`, `describeDecision`, `describeEvent` are copied from `scripts/gate-m40-requirement-versioning.mjs` (lines 133–222) with three changes: the log line names this gate, `dumpGateRows` also includes `messages` (copy the `slaveMessage.findMany` line from `gate-m39-supervisor-mailbox.mjs` line 190), and `describeMessage` is copied from `gate-m39` (lines 234–248). Copy them verbatim — they are the gates' shared diagnostic vocabulary and a rewritten one is a worse failure report.

- [ ] **Step 4: Write the setup, the daemon lifecycle and the shared waits**

Inside the `try` block, in this order:

```js
try {
  if (!existsSync(ORCHESTRATOR_CLI)) throw new Error(`orchestrator CLI not built at ${ORCHESTRATOR_CLI} -- run tsc --build first`)
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`the fake claude CLI is missing at ${FAKE_CLAUDE}`)

  // Refused rather than tolerated (`gate-m36`/`gate-m38`/`gate-m39`/`gate-m40`'s own refusal): this
  // gate starts and stops four daemons of its own, asserts that NO daemon is alive in the windows
  // between them, and counts exactly what one story wrote. A daemon somebody else left running
  // would be ticking other workspaces and holding the global concurrency budget this one needs.
  const strayDaemons = findRealDaemonPids()
  if (strayDaemons.length > 0) {
    throw new Error(
      `gate:m41-scenario REFUSED -- an orchestrator daemon is already running (pid ${strayDaemons.join(', ')}); ` +
        'this gate starts and stops daemons of its own and measures exactly what one story wrote',
    )
  }

  await preflightCleanup()

  // ---- Setup ------------------------------------------------------------------------------------
  repoPath = makeRepo()

  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      baseBranch: 'main',
      // Erratum E4, and the header's own paragraph: integration is the operator's act here, which
      // is what makes `task.integrated` real, M35's dependency gate measurable, and acts 4 and 5
      // deterministic instead of racing the scheduler.
      autoMerge: false,
      verifyCommands: ['true'],
      setupCommands: [],
      maxAttempts: 5,
      budgetUsd: 20,
    },
  })
  workspaceId = workspace.id
  console.log(
    `workspace ${workspaceId} (${WORKSPACE_NAME}), repo ${repoPath}, autoMerge ${String(workspace.autoMerge)}, ` +
      `budgetUsd ${String(workspace.budgetUsd)}, supervisorEnabled ${String(workspace.supervisorEnabled)}, ` +
      `goalVersion ${String(workspace.goalVersion)}`,
  )
  if (!workspace.supervisorEnabled) await fail('a new workspace starts with its Supervisor switched off')
  if (workspace.goalVersion !== 0) await fail(`a new workspace starts at goalVersion ${String(workspace.goalVersion)}, expected 0`)

  // Without this row every dispatch refuses with `invalid_provider` (M12 Task 8) and nothing runs.
  await prisma.providerConfiguration.create({ data: { workspaceId, kind: 'claude_code', settings: {} } })

  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  // The whole company. Atlas plans; Dev and Ops both hold `backend`, which is what makes
  // `--ask-on-task` necessary (exactly one of them may stop to ask); Rae reviews and does nothing
  // else, so it can never be dispatched a `backend` task mid-review nor be the author of the work
  // it reviews -- `dispatchReview` excludes nobody, so a reviewer that also coded COULD review its
  // own diff, and a fourth slave removes the ambiguity at zero product cost (ruling R5). Quinn
  // holds `qa` only until the question has been asked (erratum E1).
  const atlas = await prisma.slave.create({ data: { teamId: team.id, name: 'Atlas', role: 'Engineering Manager', runtimeRoles: ['manager'] } })
  const dev = await prisma.slave.create({ data: { teamId: team.id, name: 'Dev', role: 'Senior Engineer', runtimeRoles: ['backend'] } })
  const ops = await prisma.slave.create({ data: { teamId: team.id, name: 'Ops', role: 'Platform Engineer', runtimeRoles: ['backend'] } })
  const rae = await prisma.slave.create({ data: { teamId: team.id, name: 'Rae', role: 'Staff Reviewer', runtimeRoles: ['reviewer'] } })
  const quinn = await prisma.slave.create({ data: { teamId: team.id, name: 'Quinn', role: 'QA Engineer', runtimeRoles: [ASKED_ROLE] } })
  for (const slave of [atlas, dev, ops, rae, quinn]) {
    console.log(`slave ${slave.name} ${slave.id} runtimeRoles ${JSON.stringify(slave.runtimeRoles)}`)
  }

  /** The environment a child of this gate gets. `--ask-on-task` and `--replan-cancel` ride on
   *  `SLAVEOFAI_CLAUDE_ARGS`, i.e. on ARGV -- `claudeCommandFrom` splits it into `extraArgs`, which
   *  `ClaudeCodeAdapter.spawnRun`/`resume` put FIRST on every run's argv and `decisionArgs` puts
   *  first on every decision call's. `FAKE_CLAUDE_ASK_JSON` is an env var because a RUN inherits the
   *  daemon's environment (a DECISION child does not -- `buildDecisionEnv()` gives it PATH, HOME,
   *  LANG and TERM and nothing else, M31a §4 R1 -- which is exactly why the two flags are argv). */
  const childEnv = ({ askOnTask, askJson, replanCancelTaskId } = {}) =>
    loopbackChildEnv({
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS:
        `${FAKE_CLAUDE} --fixture m41-flow` +
        (askOnTask === undefined ? '' : ` --ask-on-task ${askOnTask}`) +
        (replanCancelTaskId === undefined ? '' : ` --replan-cancel ${replanCancelTaskId}`),
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      ...(askJson === undefined ? {} : { FAKE_CLAUDE_ASK_JSON: askJson }),
    })
```

**A trap to close before writing the next line:** `SLAVEOFAI_CLAUDE_ARGS` is split on a single space (`claude-command.ts`: `extra.split(' ')`), and `CORE_TITLE` contains spaces. Passing the title raw would produce four argv entries and `--ask-on-task` would read `Write` as its value. So the gate passes a **space-free token** and the fake CLI matches on it. Two ways out; take the second, and write the comment:

```js
  /** The `--ask-on-task` token. `SLAVEOFAI_CLAUDE_ARGS` is split on a single space
   *  (`apps/orchestrator/src/claude-command.ts`), so a value with spaces in it would arrive as four
   *  separate argv entries and the flag would read `Write` as its whole value. The token is the
   *  LAST WORD of the task's title -- `core`, which appears in `Task: Write the feature core` and in
   *  no other task's title, description or roster line in this workspace -- so the substring the
   *  fake CLI looks for is `Task: ...core`'s own tail. Asserted below rather than assumed: the gate
   *  checks that exactly one of the three planned titles ends with it. */
  const ASK_ON_TASK_TOKEN = CORE_TITLE.split(' ').at(-1)
```

and Task 2's `isAskingLeg` therefore matches the token inside the `Task:` line rather than the whole title. **Pre-flight ruling: this body is ALREADY what Task 2 Step 5 specifies (folded in before execution); Task 3 changes nothing in the fake CLI.** For reference, that body is:

```js
function isAskingLeg(prompt) {
  const token = askOnTaskTitle()
  if (token === null) return false
  if (args.includes('--resume')) return false
  // The `task` section's own first line, and the token that identifies WHICH task inside it. A
  // whole title cannot be the flag's value: `SLAVEOFAI_CLAUDE_ARGS` is split on a single space, so
  // a flag value must be one word. The line is matched, not the bare token, so a token that also
  // occurs in a description or an inbox message cannot turn some other run into an asking leg.
  const line = prompt.split('\n').find((one) => one.startsWith('Task: '))
  return line !== undefined && line.includes(token)
}
```

(Task 2's tests already pass `'core'` as the `--ask-on-task` value; `CORE_PROMPT`'s `Task: Write the feature core` line contains it and `API_PROMPT`'s `Task: Expose the API` line does not.)

Continue the setup:

```js
  if (PLAN_TITLES.filter((title) => title.split(' ').includes(ASK_ON_TASK_TOKEN)).length !== 1) {
    await fail(`the ask token ${JSON.stringify(ASK_ON_TASK_TOKEN)} does not identify exactly one planned title among ${JSON.stringify(PLAN_TITLES)}`)
  }

  /** Runs the real orchestrator CLI as a subprocess, exactly as an operator's shell would, and
   *  throws on a non-zero exit. */
  const runCli = (args) =>
    execFileSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  /** The same, for a command whose REFUSAL is the measurement. */
  const runCliRaw = (args) =>
    spawnSync('node', [ORCHESTRATOR_CLI, ...args], {
      cwd: repoRoot,
      env: childEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  /** Git, in the operator's own repository -- act 4's and act 6's hand merges. */
  const git = (args) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })

  let activeDaemon = null
```

`waitUntil`, `spawnDaemon`, `stopDaemon` are copied verbatim from `gate-m40-requirement-versioning.mjs` (lines 315–384). Then the story's own helpers:

```js
  /** Every task on the board, oldest first -- the order the plans created them in. */
  const board = () => prisma.task.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } })
  const taskByTitle = async (title) => (await board()).find((task) => task.title === title)
  /** Every event of one type, oldest first. */
  const eventsOfType = (type) => prisma.executionEvent.findMany({ where: { workspaceId, type }, orderBy: { seq: 'asc' } })
  /** One section of a recorded manifest, by kind (`gate-m37`'s own helper). */
  const sourceOfKind = (manifest, kind) => manifest.sections.find((section) => section.kind === kind)
  /** Every answer written in reply to one question (`gate-m39`'s own helper). */
  const answersTo = (questionId) =>
    prisma.slaveMessage.findMany({ where: { workspaceId, kind: 'answer', replyToId: questionId }, orderBy: { seq: 'asc' } })
  /** Waits until no planning run is in flight (`gate-m40`'s own helper, and its reasoning). */
  const quiescePlanning = () =>
    waitUntil('every planning run to finish', PLAN_TIMEOUT_MS, async (note) => {
      const live = await prisma.slaveRun.count({
        where: { kind: 'planning', status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId } } },
      })
      note(`${String(live)} planning run(s) still in flight`)
      return live === 0 ? true : null
    })

  /**
   * Stops a daemon and then PROVES the work this act was stopped before has still not begun.
   *
   * The window is bounded by the tick's own ordering (`apps/orchestrator/src/tick.ts`): work is
   * dispatched FIRST, and only then does the tick plan, review and merge. So whatever this act
   * waited for happened after its tick's dispatch phase, and the next dispatch is a whole daemon
   * period (750 ms) away while this gate polls at 25 ms. A run that exists anyway is a FAILURE, not
   * a tolerance: the story's claim about what had and had not started would be false, and every
   * count after it would be a race rather than a measurement.
   *
   * Also the restart proof `gate-m36-messaging.mjs` established: the stopped pid answers no signal,
   * `/proc/<pid>/cmdline` no longer reads as a daemon, and no orchestrator daemon is alive on this
   * host at all in the window this gate is about to take its readings in.
   */
  async function stopBeforeRunsFor(label, daemon, tasks) {
    const stoppedPid = daemon.proc.pid
    await stopDaemon(daemon)

    let stillAlive = true
    try {
      process.kill(stoppedPid, 0)
    } catch (error) {
      stillAlive = false
      console.log(`${label}: process.kill(${String(stoppedPid)}, 0) raised ${String(error.code)} -- ${daemon.label} is gone`)
    }
    if (stillAlive) await fail(`${label}: pid ${String(stoppedPid)} still answers signal 0 -- ${daemon.label} is not dead`)
    if (isRealDaemonProcess(stoppedPid)) await fail(`${label}: /proc/${String(stoppedPid)}/cmdline still names an orchestrator daemon`)
    const alive = findRealDaemonPids()
    console.log(`${label}: orchestrator daemons running on this host now: ${JSON.stringify(alive)}`)
    if (alive.length > 0) await fail(`${label}: an orchestrator daemon is still running after ${daemon.label} was stopped: ${JSON.stringify(alive)}`)

    const ids = tasks.map((task) => task.id)
    const runs = await prisma.slaveRun.findMany({ where: { taskId: { in: ids } } })
    console.log(
      `${label}: runs for ${JSON.stringify(tasks.map((task) => task.title))} at the moment ${daemon.label} stopped: ${String(runs.length)}`,
    )
    if (runs.length > 0) {
      await fail(
        `${label}: ${daemon.label} started ${String(runs.length)} run(s) for work this act was stopped before -- ` +
          runs.map((run) => `${run.id} (task ${String(run.taskId)}, ${run.status})`).join(', '),
      )
    }
  }

  /** The operator merges a finished task's branch into the base branch, for real, and then says so.
   *  This is the `!autoMerge` half of M35 t2: `merge.ts` left the branch alone on purpose, and
   *  `confirmIntegration` is the ONLY other writer of `Task.integratedAt`. */
  async function mergeAndConfirm(label, task) {
    const before = git(['log', '--oneline', 'main']).trim().split('\n').length
    console.log(`${label}: merging ${String(task.branch)} into main by hand (main has ${String(before)} commit(s))`)
    if (task.branch === null) await fail(`${label}: task ${task.id} finished with no branch to merge`)
    git(['merge', '--no-ff', task.branch, '-m', `merge: ${task.title}`])
    const log = git(['log', '--oneline', 'main'])
    console.log(`${label}: main after the merge:\n${log}`)
    if (!log.includes('fake work')) await fail(`${label}: the merged branch left no work on main:\n${log}`)

    const printed = runCli(['confirm-integration', '--task', task.id])
    console.log(`${label}: confirm-integration printed ${JSON.stringify(printed.trim())}`)
    const confirmed = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    console.log(`${label}: ${describeTask(confirmed)} integratedAt ${JSON.stringify(confirmed.integratedAt)}`)
    if (confirmed.integratedAt === null) await fail(`${label}: confirm-integration left integratedAt null`)
    return confirmed
  }

  /** What the orchestrator's OWN scheduler snapshot says about one task -- not a hand-written
   *  re-implementation of its dependency rule (`gate-m40` stage 3's idiom). */
  async function worldTask(label, taskId) {
    const loaded = await loadWorld(workspaceId)
    const found = loaded.world.tasks.find((task) => task.id === taskId)
    console.log(`${label}: the scheduler's world holds ${JSON.stringify(found)}`)
    if (found === undefined) await fail(`${label}: the scheduler's world does not hold task ${taskId}`)
    return found
  }
```

- [ ] **Step 5: Act 1 — the plan**

```js
  // ================= Act 1: an operator sets a requirement, and a manager plans it ================

  const setV1 = runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V1])
  console.log(`act 1 set-goal printed: ${JSON.stringify(setV1.trim())}`)
  const v1Printed = JSON.parse(setV1)
  if (v1Printed.version !== 1) await fail(`act 1's set-goal printed version ${String(v1Printed.version)}, expected 1`)
  if (v1Printed.sha256 !== goalSha256(GOAL_V1)) {
    await fail(`act 1's set-goal printed sha256 ${String(v1Printed.sha256)}, expected ${goalSha256(GOAL_V1)}`)
  }

  const daemon1 = spawnDaemon('daemon-1')

  // Waited on the EVENT rather than on the board: `concludePlanning` creates the whole graph in one
  // transaction and appends `workspace.plan_created` after it commits, so a gate that polled the
  // board would routinely catch a complete board and a log that has not caught up.
  const planCreated = await waitUntil('the first plan to land', PLAN_TIMEOUT_MS, async (note) => {
    const rows = await eventsOfType('workspace_plan_created')
    note(`${String(rows.length)} workspace.plan_created event(s) so far`)
    return rows.length === 0 ? null : rows
  })
  const planned = await board()
  console.log(`act 1 board (${String(planned.length)}):\n  ${planned.map(describeTask).join('\n  ')}`)
  if (planned.length !== PLAN_TITLES.length) await fail(`act 1's plan produced ${String(planned.length)} tasks, expected ${String(PLAN_TITLES.length)}`)
  for (const title of PLAN_TITLES) {
    if (!planned.some((task) => task.title === title)) await fail(`act 1's plan has no task titled ${JSON.stringify(title)}`)
  }
  for (const task of planned) {
    if (task.goalVersion !== 1) await fail(`act 1's ${JSON.stringify(task.title)} is stamped goalVersion ${String(task.goalVersion)}, expected 1`)
    if (task.status !== 'ready') await fail(`act 1's ${JSON.stringify(task.title)} is ${task.status}, expected ready`)
  }
  const coreTask = planned.find((task) => task.title === CORE_TITLE)
  const apiTask = planned.find((task) => task.title === API_TITLE)
  const polishTask = planned.find((task) => task.title === POLISH_TITLE)
  // Ruling R4's own claim, on the row this story will quote from in act 3.
  if (!coreTask.description.includes(SOURCED_QUOTE)) {
    await fail(`act 1's core task does not carry ${JSON.stringify(SOURCED_QUOTE)}: ${JSON.stringify(coreTask.description)}`)
  }

  console.log(`act 1 workspace.plan_created: ${planCreated.map(describeEvent).join('\n  ')}`)
  if (planCreated.length !== 1) await fail(`act 1 appended ${String(planCreated.length)} workspace.plan_created events, expected one`)
  if (planCreated[0].payload.goalVersion !== 1) {
    await fail(`act 1's workspace.plan_created says goalVersion ${String(planCreated[0].payload.goalVersion)}, expected 1`)
  }
  for (const event of await eventsOfType('task_created')) {
    if (event.payload.goalVersion !== 1) {
      await fail(`act 1's task.created for ${String(event.taskId)} says goalVersion ${String(event.payload.goalVersion)}, expected 1`)
    }
  }

  // The run the EVENT names, not "the oldest planning run".
  const planningRun = await prisma.slaveRun.findUniqueOrThrow({ where: { id: planCreated[0].runId }, include: { context: true } })
  if (planningRun.context === null) await fail(`act 1: planning run ${planningRun.id} recorded no context at all`)
  const planManifest = runContextManifestSchema.parse(planningRun.context.sections)
  console.log(`act 1 planning run ${planningRun.id} (${planningRun.status}) manifest: ${JSON.stringify(planManifest)}`)
  if (planManifest.kind !== 'planning') await fail(`act 1's planning manifest says kind ${planManifest.kind}, expected planning`)
  const planGoalSource = sourceOfKind(planManifest, 'planning_goal')
  if (planGoalSource === undefined || planGoalSource.version !== 1 || planGoalSource.sha256 !== goalSha256(GOAL_V1)) {
    await fail(`act 1's planning_goal section is ${JSON.stringify(planGoalSource)}, expected version 1 with the v1 goal's hash`)
  }
  // A FIRST plan, not a delta: its absence here is what makes act 5's presence mean something.
  if (sourceOfKind(planManifest, 'replan') !== undefined) await fail('act 1: the FIRST planning run recorded a replan section')
  if (!planningRun.context.prompt.includes(GOAL_V1)) await fail('act 1: the planning prompt does not carry the goal it was derived from')

  // Quiesced while the daemon is still alive to conclude what it started, and only then stopped --
  // before ANY work run exists. This is the story's first timing claim, and it is measured.
  await quiescePlanning()
  await stopBeforeRunsFor('act 1', daemon1, [coreTask, apiTask, polishTask])

  const replanBefore = JSON.parse(runCli(['replan-status', '--workspace', workspaceId]))
  console.log(`act 1 replan-status: ${JSON.stringify(replanBefore)}`)
  if (replanBefore.willReplan !== false || replanBefore.blockedBy !== null) {
    await fail(`act 1's replan-status reads ${JSON.stringify(replanBefore)}, expected willReplan false with nothing in the way`)
  }
  if (replanBefore.goalVersion !== 1 || replanBefore.boardVersion !== 1) {
    await fail(`act 1's replan-status reads goal ${String(replanBefore.goalVersion)} / board ${String(replanBefore.boardVersion)}, expected 1 / 1`)
  }
  console.log('act 1 complete: a requirement became version 1, a manager turned it into three tasks, and every one of them carries the version that produced it -- and not one of them has started')
```

- [ ] **Step 6: Act 2 — work, and a question**

```js
  // ================= Act 2: a worker starts, and stops to ask =====================================

  const daemon2 = spawnDaemon('daemon-2', {
    askOnTask: ASK_ON_TASK_TOKEN,
    askJson: JSON.stringify({ role: ASKED_ROLE, question: ASK_QUESTION }),
  })

  const coreRunStarted = await waitUntil('a run for the core task', DISPATCH_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findFirst({ where: { taskId: coreTask.id }, include: { slave: true } })
    note(run === null ? 'no SlaveRun row yet' : `run ${run.id} is ${run.status}`)
    return run
  })
  // WHICH of the two backend workers took it is recorded, not asserted: `decide()` picks the first
  // non-busy holder in the world's own slave order, and the story is true whichever it is.
  console.log(`act 2: core was dispatched to ${coreRunStarted.slave.name} (${coreRunStarted.slaveId}) as run ${coreRunStarted.id}`)

  const parkedRun = await waitUntil('the run to park waiting for an answer', WAITING_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUnique({ where: { id: coreRunStarted.id } })
    note(run === null ? 'the run row vanished' : `run is ${run.status}, pauseReason ${JSON.stringify(run.pauseReason)}`)
    return run !== null && run.status === 'paused' && run.pauseReason === 'waiting_for_answer' ? run : null
  })
  const question = await waitUntil('the question row the run asked', WAITING_TIMEOUT_MS, async (note) => {
    const row = await prisma.slaveMessage.findFirst({ where: { workspaceId, kind: 'question', senderRunId: parkedRun.id } })
    note(row === null ? 'no question row yet' : `question ${row.id}`)
    return row
  })
  console.log(`act 2 question: ${describeMessage(question)}`)
  if (question.recipientRole !== ASKED_ROLE) await fail(`act 2's question is addressed to ${JSON.stringify(question.recipientRole)}, expected the ${ASKED_ROLE} role`)
  if (!question.body.includes(ASK_QUESTION)) await fail(`act 2's question body is ${JSON.stringify(question.body)}, expected the envelope's own question`)

  // Waited for rather than read once: `concludeWithQuestion` writes checkpoint -> message -> claim
  // the run -> park the task, and the first three are already done when the waits above return.
  const parkedTask = await waitUntil("the core task to park waiting", WAITING_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: coreTask.id } })
    note(`task is ${row.status}`)
    return row.status === 'waiting' ? row : null
  })
  console.log(`act 2 core task: ${describeTask(parkedTask)}`)
  // Asking is not failing: no attempt is charged, and nothing announced a failure.
  if (parkedTask.attempt !== 0) await fail(`act 2 charged the core task attempt ${String(parkedTask.attempt)} for stopping to ask, expected 0`)
  if (parkedTask.activeRunId !== parkedRun.id) await fail(`act 2's parked task points at run ${String(parkedTask.activeRunId)}, expected ${parkedRun.id}`)
  const runFailed = await eventsOfType('run_failed')
  console.log(`act 2 run.failed events: ${String(runFailed.length)}`)
  if (runFailed.length !== 0) await fail(`act 2 recorded ${String(runFailed.length)} run.failed event(s): ${runFailed.map(describeEvent).join('; ')}`)
  const questions = await prisma.slaveMessage.findMany({ where: { workspaceId, kind: 'question' } })
  if (questions.length !== 1) await fail(`act 2 wrote ${String(questions.length)} question rows, expected exactly one`)

  // Nothing else moved: api depends on core, polish on api, and neither may start.
  for (const task of [apiTask, polishTask]) {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    const runs = await prisma.slaveRun.count({ where: { taskId: task.id } })
    console.log(`act 2 ${JSON.stringify(task.title)}: ${row.status}, ${String(runs)} run(s)`)
    if (row.status !== 'ready' || runs !== 0) await fail(`act 2 moved ${JSON.stringify(task.title)}: ${row.status} with ${String(runs)} run(s)`)
  }

  // The manifest hashed the task text the renderer hashed -- computed with the product's OWN
  // exported hash (`goalSha256` is a general SHA-256 of a UTF-8 string, cross-checked against
  // `node:crypto` by its own test), never re-implemented here (erratum E12).
  const coreContext = await prisma.runContext.findUniqueOrThrow({ where: { runId: parkedRun.id } })
  const coreManifest = runContextManifestSchema.parse(coreContext.sections)
  const taskSource = sourceOfKind(coreManifest, 'task')
  const expectedTaskSha = goalSha256(`${coreTask.title}\n${coreTask.description}`)
  console.log(`act 2 task section: ${JSON.stringify(taskSource)}; expected sha256 ${expectedTaskSha}`)
  if (taskSource === undefined || taskSource.taskId !== coreTask.id) await fail(`act 2's manifest task section is ${JSON.stringify(taskSource)}`)
  if (taskSource.sha256 !== expectedTaskSha) await fail(`act 2's manifest hashed ${String(taskSource.sha256)}, expected ${expectedTaskSha}`)
  // Erratum E2, on the recorded prompt itself: the discriminator is in there and the id is not.
  if (!coreContext.prompt.includes(`Task: ${CORE_TITLE}`)) await fail("act 2: the run's prompt does not carry its task section's `Task: <title>` line")
  if (coreContext.prompt.includes(coreTask.id)) await fail('act 2: the work prompt contains the task id -- erratum E2 says it does not, and the fake CLI keys on the title because of it')

  // The roster change that makes the question unanswerable, and the whole reason act 3 has a
  // situation to decide (erratum E1): until this runs, a question to a role somebody holds is not
  // stuck, and before the ask it could not have been sent at all.
  const rolesPrinted = runCli(['set-runtime-roles', '--slave', quinn.id, '--roles', ''])
  console.log(`act 2 set-runtime-roles printed: ${JSON.stringify(rolesPrinted.trim())}`)
  console.log('act 2 complete: one worker took the only startable task, hit a wall, and asked the QA role a question -- no attempt charged, no failure announced, and nothing else on the board moved')
```

- [ ] **Step 7: Act 3 — the Supervisor answers**

```js
  // ================= Act 3: the Supervisor answers what nobody else can ===========================

  const FIXTURE_CHOICE_COST_USD = fixtureCostUsd('supervisor-decision')
  const FIXTURE_ANSWER_COST_USD = fixtureCostUsd('supervisor-answer')

  const decision = await waitUntil('the Supervisor to decide about the question', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId, situationKind: 'unanswerable_question', subjectId: question.id } })
    note(`${String(rows.length)} unanswerable_question decision(s) so far`)
    return rows.length === 0 ? null : rows[0]
  })
  console.log(`act 3 decision: ${describeDecision(decision)}`)
  console.log(`  situation: ${JSON.stringify(decision.situation)}`)
  if (decision.action.kind !== 'answer_question') await fail(`act 3 chose ${String(decision.action.kind)}, expected answer_question`)
  if (decision.action.messageId !== question.id) await fail(`act 3 answered ${String(decision.action.messageId)}, expected ${question.id}`)
  if (decision.tier !== 'applied' || decision.status !== 'applied') await fail(`act 3's decision is ${decision.tier}/${decision.status}, expected applied/applied`)
  if (decision.failureReason !== null) await fail(`act 3's decision records a failure: ${String(decision.failureReason)}`)
  if (decision.decidedBy !== 'model' || decision.modelCalled !== true) await fail(`act 3's decision says decidedBy ${decision.decidedBy}, modelCalled ${String(decision.modelCalled)}`)
  // Both calls, added: the choice and the answer. Read off the fixtures at runtime.
  if (!sameMoney(decision.modelCostUsd, FIXTURE_CHOICE_COST_USD + FIXTURE_ANSWER_COST_USD)) {
    await fail(`act 3 recorded modelCostUsd ${String(decision.modelCostUsd)}, expected ${String(FIXTURE_CHOICE_COST_USD + FIXTURE_ANSWER_COST_USD)}`)
  }
  const draft = decision.draft
  if (draft === null) await fail('act 3: the answer decision carries no draft')
  if (draft.confidence !== 'sourced') await fail(`act 3's draft is ${String(draft.confidence)}, expected sourced`)
  if (!Array.isArray(draft.sources) || !draft.sources.some((source) => source.quote === SOURCED_QUOTE)) {
    await fail(`act 3's verified citations do not include ${JSON.stringify(SOURCED_QUOTE)}: ${JSON.stringify(draft.sources)}`)
  }
  if (!Array.isArray(draft.rejectedSources) || draft.rejectedSources.length !== 0) {
    await fail(`act 3's draft has rejected citations though it was called sourced: ${JSON.stringify(draft.rejectedSources)}`)
  }

  const answers = await waitUntil('the Supervisor answer to be written', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const rows = await answersTo(question.id)
    note(`${String(rows.length)} answer(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`act 3 answers (${String(answers.length)}):\n  ${answers.map(describeMessage).join('\n  ')}`)
  if (answers.length !== 1) await fail(`act 3 wrote ${String(answers.length)} answers, expected exactly one`)
  const answer = answers[0]
  // The envelope actor of a machine's answer. `human` here would credit a person with words nobody
  // typed.
  if (answer.actor !== 'system') await fail(`act 3's answer says actor ${answer.actor}, expected system`)
  if (answer.body !== draft.body) await fail(`act 3 sent ${JSON.stringify(answer.body)}, expected the draft's own text`)
  if (!answer.body.includes(SOURCED_QUOTE)) await fail(`act 3's answer does not carry the quote it was sourced from: ${JSON.stringify(answer.body)}`)

  const sentEvent = await waitUntil('the slave.message_sent event for the answer', SUPERVISOR_TIMEOUT_MS, async (note) => {
    const row = await prisma.executionEvent.findFirst({ where: { workspaceId, type: 'slave_message_sent' }, orderBy: { seq: 'desc' } })
    note(row === null ? 'no slave.message_sent event yet' : `newest names message ${String(row.payload.messageId)}`)
    return row !== null && row.payload.messageId === answer.id ? row : null
  })
  console.log(`act 3 slave.message_sent: actor ${sentEvent.actor}, payload ${JSON.stringify(sentEvent.payload)}`)
  if (sentEvent.actor !== 'system') await fail(`act 3's answer envelope says actor ${sentEvent.actor}, expected system`)
  if (sentEvent.payload.answeredBy !== 'supervisor') await fail(`act 3's answer says answeredBy ${String(sentEvent.payload.answeredBy)}, expected supervisor`)

  // The resume belongs to a LATER tick than the one that answered (`deliverAnswers` runs early in a
  // tick, the Supervisor at its end), which is why this is a wait and never a read.
  const resumed = await waitUntil('the parked run to resume and conclude', RESUME_TIMEOUT_MS, async (note) => {
    const run = await prisma.slaveRun.findUnique({ where: { id: parkedRun.id } })
    note(run === null ? 'the run row vanished' : `run is ${run.status}`)
    return run !== null && run.status === 'succeeded' ? run : null
  })
  console.log(`act 3 resumed run ${resumed.id}: ${resumed.status}, pauseReason ${JSON.stringify(resumed.pauseReason)}, pid ${String(resumed.pid)}, costUsd ${String(resumed.costUsd)}`)
  if (resumed.pauseReason !== null) await fail(`act 3's resumed run still carries pauseReason ${JSON.stringify(resumed.pauseReason)}`)
  // A SECOND provider process was started for this run after it parked, which is what "resumed"
  // means: `executeResume` writes the new child's pid back over the null the ask left.
  if (resumed.pid === null) await fail('act 3: the run has no pid after the resume, so nothing actually resumed it')
  const coreRuns = await prisma.slaveRun.findMany({ where: { taskId: coreTask.id } })
  if (coreRuns.length !== 1) await fail(`act 3: the core task has ${String(coreRuns.length)} runs -- the answer started a NEW run instead of continuing the waiting one`)

  // The SAME session, continued: `--resume <sessionId>` never mints a new id (ADR 0001 §3/§5), so
  // the two events have to name one session or the "same slave, woken up" claim is false.
  const startedEvents = await prisma.executionEvent.findMany({ where: { workspaceId, runId: parkedRun.id, type: 'run_started' }, orderBy: { seq: 'asc' } })
  const resumedEvents = await prisma.executionEvent.findMany({ where: { workspaceId, runId: parkedRun.id, type: 'run_resumed' }, orderBy: { seq: 'asc' } })
  console.log(`act 3 run.started: ${startedEvents.map(describeEvent).join('; ')}`)
  console.log(`act 3 run.resumed: ${resumedEvents.map(describeEvent).join('; ')}`)
  if (resumedEvents.length !== 1) await fail(`act 3 recorded ${String(resumedEvents.length)} run.resumed events, expected one`)
  if (resumedEvents[0].payload.sessionId !== startedEvents[0].payload.sessionId) {
    await fail(`act 3 resumed session ${String(resumedEvents[0].payload.sessionId)}, expected the one it started, ${String(startedEvents[0].payload.sessionId)}`)
  }

  // The operator's surface, through the verb `buildSupervisorView` composes (ruling R6).
  const mailboxWorld = await loadSupervisorWorld(workspaceId)
  const mailboxReport = summarise(mailboxWorld.world)
  console.log(`act 3 supervisor report mailbox: ${JSON.stringify(mailboxReport.mailbox)}`)
  if (mailboxReport.mailbox.answeredBySupervisor24h !== 1) {
    await fail(`act 3's report says answeredBySupervisor24h ${String(mailboxReport.mailbox.answeredBySupervisor24h)}, expected 1`)
  }
  if (mailboxReport.mailbox.draftsAwaiting !== 0) {
    await fail(`act 3's report says draftsAwaiting ${String(mailboxReport.mailbox.draftsAwaiting)}, expected 0 -- this answer needed nobody`)
  }
  console.log('act 3 complete: nobody in the company could answer the question, so the Supervisor found the answer in the asking task, checked the quote in code, sent it as the machine -- and the next tick woke the run that had been waiting for it')
```

- [ ] **Step 8: Act 4 — verify, review, and the integration a human owns**

```js
  // ================= Act 4: verified, reviewed, and integrated by a human =========================

  const coreDone = await waitUntil('the core task to finish', PIPELINE_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: coreTask.id } })
    note(`core is ${row.status}`)
    return row.status === 'done' ? row : null
  })
  console.log(`act 4 core: ${describeTask(coreDone)}, integratedAt ${JSON.stringify(coreDone.integratedAt)}, branch ${JSON.stringify(coreDone.branch)}`)
  // M35 t2 on the row: `merge.ts`'s !autoMerge path marks the task done and leaves the branch for a
  // human, EXPLICITLY leaving `integratedAt` null.
  if (coreDone.integratedAt !== null) await fail(`act 4's core task is already integrated (${String(coreDone.integratedAt)}) on a workspace that does not auto-merge`)
  for (const type of ['task_verifying', 'task_verify_passed', 'task_review_started', 'task_review_approved', 'task_done']) {
    const rows = await eventsOfType(type)
    console.log(`act 4 ${type}: ${String(rows.length)} -- ${rows.map(describeEvent).join('; ')}`)
    if (!rows.some((row) => row.taskId === coreTask.id)) await fail(`act 4: core reached done with no ${type} event`)
  }
  // Rae reviewed it, and Rae is not the author (ruling R5).
  const coreReview = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: coreTask.id, kind: 'review' }, include: { slave: true } })
  console.log(`act 4 core review run ${coreReview.id} by ${coreReview.slave.name} (${coreReview.status})`)
  if (coreReview.slaveId !== rae.id) await fail(`act 4's core review was taken by ${coreReview.slave.name}, expected Rae`)

  // M35's whole claim, measured through the snapshot the SCHEDULER decides from: work that is done
  // but not merged does not unblock anything.
  const apiBeforeIntegration = await worldTask('act 4 (before the hand merge)', apiTask.id)
  if (apiBeforeIntegration.dependenciesDone !== false) {
    await fail('act 4: api reports dependenciesDone true while the work it depends on is done but still sitting on an unmerged branch')
  }

  await stopBeforeRunsFor('act 4 (before the merge)', daemon2, [apiTask, polishTask])
  await mergeAndConfirm('act 4', coreDone)

  const integratedEvents = await eventsOfType('task_integrated')
  console.log(`act 4 task.integrated: ${integratedEvents.map(describeEvent).join('; ')}`)
  if (integratedEvents.length !== 1 || integratedEvents[0].taskId !== coreTask.id) {
    await fail(`act 4 recorded ${String(integratedEvents.length)} task.integrated events, expected one for core`)
  }
  if (integratedEvents[0].actor !== 'human') await fail(`act 4's task.integrated says actor ${integratedEvents[0].actor}, expected human -- a person merged it`)

  const apiAfterIntegration = await worldTask('act 4 (after the hand merge)', apiTask.id)
  if (apiAfterIntegration.dependenciesDone !== true) await fail('act 4: api is still not schedulable after its dependency was merged and confirmed')

  // Daemon-3 carries NO ask flag, so api's work run commits instead of asking. (It would not ask
  // anyway -- the token names core's title alone -- but the story is about a project that has
  // stopped needing to ask, and the argv says so.)
  const daemon3 = spawnDaemon('daemon-3')

  const apiDone = await waitUntil('the api task to finish', PIPELINE_TIMEOUT_MS, async (note) => {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: apiTask.id } })
    note(`api is ${row.status}`)
    return row.status === 'done' ? row : null
  })
  console.log(`act 4 api: ${describeTask(apiDone)}, integratedAt ${JSON.stringify(apiDone.integratedAt)}, branch ${JSON.stringify(apiDone.branch)}`)
  if (apiDone.integratedAt !== null) await fail('act 4: api integrated itself on a workspace that does not auto-merge')
  const apiRuns = await prisma.slaveRun.findMany({ where: { taskId: apiTask.id }, include: { slave: true } })
  console.log(`act 4 api runs: ${apiRuns.map((run) => `${run.kind} by ${run.slave.name} (${run.status})`).join(', ')}`)
  if (apiRuns.filter((run) => run.kind === 'implementation').length !== 1) await fail(`act 4 started ${String(apiRuns.length)} implementation runs for api, expected one`)
  const apiReview = apiRuns.find((run) => run.kind === 'review')
  if (apiReview === undefined || apiReview.slaveId !== rae.id) await fail('act 4: api was not reviewed by Rae')
  // Nobody asked anything this time.
  if ((await prisma.slaveMessage.count({ where: { workspaceId, kind: 'question' } })) !== 1) {
    await fail('act 4: a second question was asked -- the ask flag names core alone')
  }

  // api is `done` and unintegrated, so polish CANNOT start. That is what makes stopping here a
  // certainty rather than a race, and it is what act 5 depends on.
  const polishBeforeReplan = await worldTask('act 4 (polish before the re-plan)', polishTask.id)
  if (polishBeforeReplan.dependenciesDone !== false) await fail('act 4: polish is schedulable though api is done but unmerged')
  await stopBeforeRunsFor('act 4 (before polish)', daemon3, [polishTask])

  // The spend so far, printed as a table and asserted against the one formula every surface reads
  // (`workspaceSpend`). The asking leg's own line is erratum E3.
  const COST_PLAN = fixtureCostUsd('plan-graph-scenario')
  const COST_WORK = fixtureCostUsd('complete')
  const COST_REVIEW = fixtureCostUsd('review-approve')
  const partialTable = [
    { kind: 'planning run (the first plan)', count: 1, unitUsd: COST_PLAN },
    { kind: 'implementation run, core (asking leg $0 + resumed leg: ONE row, ONE recorded cost)', count: 1, unitUsd: COST_WORK },
    { kind: 'implementation run, api', count: 1, unitUsd: COST_WORK },
    { kind: 'review run', count: 2, unitUsd: COST_REVIEW },
    { kind: 'supervisor decision: choose an action', count: 1, unitUsd: FIXTURE_CHOICE_COST_USD },
    { kind: 'supervisor decision: draft the answer', count: 1, unitUsd: FIXTURE_ANSWER_COST_USD },
  ]
  const printTable = (label, table) => {
    let total = 0
    console.log(`${label}:`)
    for (const row of table) {
      const subtotal = row.count * row.unitUsd
      total += subtotal
      console.log(`  ${String(row.count).padStart(2)} x $${row.unitUsd.toFixed(6)} = $${subtotal.toFixed(6)}  ${row.kind}`)
    }
    console.log(`  total $${total.toFixed(6)}`)
    return total
  }
  const partialTotal = printTable('act 4 spend so far', partialTable)
  const partialSpend = await workspaceSpend(workspaceId)
  console.log(`act 4 workspaceSpend: ${JSON.stringify(partialSpend)}`)
  if (!sameMoney(partialSpend.spentUsd, partialTotal)) {
    await fail(`act 4's workspaceSpend says $${String(partialSpend.spentUsd)}, the table says $${String(partialTotal)}`)
  }
  // Erratum E3, stated on the row itself: the paused leg wrote no cost, so the one row for the
  // asking task carries exactly ONE `complete`.
  if (!sameMoney(resumed.costUsd, COST_WORK)) {
    await fail(`act 4: the run that asked and resumed records $${String(resumed.costUsd)}, expected exactly one \`complete\` ($${String(COST_WORK)}) -- a paused leg records no cost at all`)
  }
  console.log('act 4 complete: two tasks were written, verified, reviewed by a slave that wrote neither of them, and merged onto main by a person -- and the second could not start until the first really landed there')
```

- [ ] **Step 9: Act 5 — the requirement changes**

```js
  // ================= Act 5: the requirement changes, and the board catches up =====================

  const setV2 = runCli(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V2])
  console.log(`act 5 set-goal printed: ${JSON.stringify(setV2.trim())}`)
  if (JSON.parse(setV2).version !== 2) await fail(`act 5's set-goal printed ${setV2.trim()}, expected version 2`)

  const historyOutput = runCli(['goal-history', '--workspace', workspaceId])
  console.log(`act 5 goal-history printed:\n${historyOutput}`)
  const history = JSON.parse(historyOutput)
  if (history.length !== 2 || history[0].version !== 2 || history[1].version !== 1) {
    await fail(`act 5's goal-history is ${JSON.stringify(history.map((row) => row.version))}, expected [2, 1]`)
  }
  if (history[0].text !== GOAL_V2 || history[1].text !== GOAL_V1) await fail('act 5\'s goal-history does not carry both texts')
  if (history[0].sha256 !== goalSha256(GOAL_V2) || history[1].sha256 !== goalSha256(GOAL_V1)) await fail('act 5\'s goal-history hashes do not match the texts')
  if (history[0].diff === null || history[0].diff.added.length === 0 || history[0].diff.removed.length === 0) {
    await fail(`act 5's newest version carries no diff against the one it replaced: ${JSON.stringify(history[0].diff)}`)
  }
  if (history[1].diff !== null) await fail(`act 5's v1 carries a diff (${JSON.stringify(history[1].diff)}) though it replaced nothing`)
  // The CONTROL verb the web's history route reads through (ruling R6) has to agree with the CLI.
  const versionsViaControl = await listGoalVersions(workspaceId)
  if (!versionsViaControl.ok || JSON.stringify(versionsViaControl.value) !== JSON.stringify(history)) {
    await fail(`act 5: listGoalVersions and \`goal-history\` disagree:\n  ${JSON.stringify(versionsViaControl)}\n  ${historyOutput}`)
  }

  const replanDue = JSON.parse(runCli(['replan-status', '--workspace', workspaceId]))
  console.log(`act 5 replan-status: ${JSON.stringify(replanDue)}`)
  if (replanDue.willReplan !== true || replanDue.blockedBy !== null) {
    await fail(`act 5's replan-status reads ${JSON.stringify(replanDue)}, expected a re-plan due with nothing in the way`)
  }
  if (replanDue.goalVersion !== 2 || replanDue.boardVersion !== 1) {
    await fail(`act 5's replan-status reads goal ${String(replanDue.goalVersion)} / board ${String(replanDue.boardVersion)}, expected 2 / 1`)
  }

  const daemon4 = spawnDaemon('daemon-4', { replanCancelTaskId: polishTask.id })

  const replanStarted = await waitUntil('the re-plan to start', REPLAN_TIMEOUT_MS, async (note) => {
    const rows = await eventsOfType('workspace_replan_started')
    note(`${String(rows.length)} workspace.replan_started event(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`act 5 workspace.replan_started: ${replanStarted.map(describeEvent).join('; ')}`)
  if (replanStarted.length !== 1 || replanStarted[0].payload.version !== 2) {
    await fail(`act 5 started ${String(replanStarted.length)} re-plans: ${JSON.stringify(replanStarted.map((event) => event.payload))}`)
  }
  const replanRunId = replanStarted[0].payload.runId
  const replanContext = await waitUntil("the re-plan run's recorded context", REPLAN_TIMEOUT_MS, async (note) => {
    const row = await prisma.runContext.findUnique({ where: { runId: replanRunId } })
    note(row === null ? 'no RunContext row yet' : 'recorded')
    return row
  })
  const replanManifest = runContextManifestSchema.parse(replanContext.sections)
  console.log(`act 5 re-plan manifest: ${JSON.stringify(replanManifest)}`)
  const replanSource = sourceOfKind(replanManifest, 'replan')
  if (replanSource === undefined) await fail('act 5: the re-plan run recorded no replan section')
  if (replanSource.previousVersion !== 1 || replanSource.version !== 2) {
    await fail(`act 5's replan section moves ${String(replanSource.previousVersion)} -> ${String(replanSource.version)}, expected 1 -> 2`)
  }
  if (replanSource.previousSha256 !== goalSha256(GOAL_V1) || replanSource.sha256 !== goalSha256(GOAL_V2)) {
    await fail(`act 5's replan section hashes ${JSON.stringify(replanSource)}, expected both goal texts' own hashes`)
  }
  // Erratum E11: the prompt's board is the NON-terminal board -- "every task that is not done,
  // failed or cancelled" -- so the only thing the manager was shown is the work still outstanding.
  if (JSON.stringify([...replanSource.boardTaskIds].sort()) !== JSON.stringify([polishTask.id])) {
    await fail(`act 5's manager was shown ${JSON.stringify(replanSource.boardTaskIds)}, expected only the unfinished ${polishTask.id}`)
  }
  if (!replanContext.prompt.includes('"replan"')) await fail('act 5: the re-plan prompt does not contain the literal "replan" -- it was given the FIRST-plan instructions')
  if (!replanContext.prompt.includes('THE GOAL CHANGED')) await fail('act 5: the re-plan prompt does not say the goal changed')
  if (!replanContext.prompt.includes(GOAL_V1) || !replanContext.prompt.includes(GOAL_V2)) {
    await fail('act 5: the re-plan prompt does not carry BOTH goal texts, so the manager cannot see what changed')
  }

  const replanned = await waitUntil('the re-plan to conclude', REPLAN_TIMEOUT_MS, async (note) => {
    const rows = await eventsOfType('workspace_replanned')
    note(`${String(rows.length)} workspace.replanned event(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`act 5 workspace.replanned: ${replanned.map(describeEvent).join('; ')}`)
  if (replanned.length !== 1) await fail(`act 5 concluded ${String(replanned.length)} re-plans, expected one`)
  const replannedPayload = replanned[0].payload

  const afterReplan = await board()
  const docsTask = afterReplan.find((task) => !planned.some((old) => old.id === task.id))
  console.log(`act 5 board (${String(afterReplan.length)}):\n  ${afterReplan.map(describeTask).join('\n  ')}`)
  if (afterReplan.length !== 4 || docsTask === undefined) await fail(`act 5's delta produced ${String(afterReplan.length - 3)} additions, expected exactly one`)
  if (docsTask.title !== ADDED_TITLE) await fail(`act 5 added ${JSON.stringify(docsTask.title)}, expected ${JSON.stringify(ADDED_TITLE)}`)
  if (docsTask.status !== 'ready' || docsTask.goalVersion !== 2) {
    await fail(`act 5's addition is ${docsTask.status} at goal v${String(docsTask.goalVersion)}, expected ready at v2`)
  }
  // The tasks the delta did not mention are untouched, and still carry the version that made them.
  for (const task of [coreTask, apiTask, polishTask]) {
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    if (row.goalVersion !== 1) await fail(`act 5 restamped ${JSON.stringify(task.title)} to goal v${String(row.goalVersion)}`)
  }
  if (JSON.stringify(replannedPayload.added) !== JSON.stringify([docsTask.id])) {
    await fail(`act 5's workspace.replanned lists added ${JSON.stringify(replannedPayload.added)}, expected ${JSON.stringify([docsTask.id])}`)
  }
  if (JSON.stringify(replannedPayload.proposedCancellations) !== JSON.stringify([polishTask.id])) {
    await fail(`act 5's workspace.replanned proposes ${JSON.stringify(replannedPayload.proposedCancellations)}, expected ${JSON.stringify([polishTask.id])}`)
  }
  // The three lists together account for every id the model asked to cancel.
  if (replannedPayload.droppedCancellations.length !== 0 || replannedPayload.failedProposals.length !== 0) {
    await fail(`act 5 dropped ${JSON.stringify(replannedPayload.droppedCancellations)} and failed ${JSON.stringify(replannedPayload.failedProposals)}, expected neither`)
  }

  const proposal = await waitUntil('the cancellation proposal', REPLAN_TIMEOUT_MS, async (note) => {
    const rows = await prisma.supervisorDecision.findMany({ where: { workspaceId, situationKind: 'stale_task' } })
    note(`${String(rows.length)} stale_task decision(s) so far`)
    return rows.length === 0 ? null : rows
  })
  console.log(`act 5 stale_task decisions (${String(proposal.length)}):\n  ${proposal.map(describeDecision).join('\n  ')}`)
  if (proposal.length !== 1) await fail(`act 5 recorded ${String(proposal.length)} stale_task decisions, expected one`)
  const cancelProposal = proposal[0]
  if (cancelProposal.subjectId !== polishTask.id) await fail(`act 5's proposal is about ${String(cancelProposal.subjectId)}, expected polish`)
  if (cancelProposal.action.kind !== 'cancel_task' || cancelProposal.action.taskId !== polishTask.id) {
    await fail(`act 5's proposal chose ${JSON.stringify(cancelProposal.action)}, expected cancel_task on polish`)
  }
  // Ruling R1 of M40, on the row: a cancellation is NEVER applied by the machine.
  if (cancelProposal.tier !== 'proposed' || cancelProposal.status !== 'pending') {
    await fail(`act 5's proposal is ${cancelProposal.tier}/${cancelProposal.status}, expected proposed/pending`)
  }
  // The re-plan run already paid for this judgement; the Supervisor's spend must not gain a call
  // that never happened.
  if (cancelProposal.modelCalled !== false || cancelProposal.modelCostUsd !== null) {
    await fail(`act 5's proposal records modelCalled ${String(cancelProposal.modelCalled)} / modelCostUsd ${String(cancelProposal.modelCostUsd)}`)
  }
  const polishWhileProposed = await prisma.task.findUniqueOrThrow({ where: { id: polishTask.id } })
  if (polishWhileProposed.status !== 'ready') await fail(`act 5's polish task is ${polishWhileProposed.status} though nobody approved the cancellation`)

  await quiescePlanning()
  // `docs` is the only thing on this board that COULD start (polish is still blocked behind an
  // unintegrated api), and it is the last act's "what comes next", not work done.
  await stopBeforeRunsFor('act 5 (before docs)', daemon4, [docsTask, polishTask])
  console.log('act 5 complete: the requirement moved, one run was asked for the DELTA against the board it was shown, the addition is on the board stamped with the version that asked for it, and the cancellation is a proposal nobody has approved')
```

- [ ] **Step 10: Act 6 — a human approves, and integrates the rest**

```js
  // ================= Act 6: a human approves the cancellation =====================================

  const approvePrinted = runCli(['approve-decision', '--id', cancelProposal.id])
  console.log(`act 6 approve-decision printed: ${JSON.stringify(approvePrinted.trim())}`)
  const approved = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cancelProposal.id } })
  console.log(`act 6 decision after approval: ${describeDecision(approved)}`)
  // Erratum E6: an approved proposal reads `approved`, not `applied` -- `approveDecision` claims the
  // row to `approved` and then carries the action out.
  if (approved.status !== 'approved') await fail(`act 6's decision is ${approved.status} after approval, expected approved`)
  if (approved.failureReason !== null) await fail(`act 6's approval refused: ${String(approved.failureReason)}`)

  const polishCancelled = await prisma.task.findUniqueOrThrow({ where: { id: polishTask.id } })
  console.log(`act 6 polish: ${describeTask(polishCancelled)}`)
  if (polishCancelled.status !== 'cancelled') await fail(`act 6's polish task is ${polishCancelled.status}, expected cancelled`)
  if (polishCancelled.lastRejectionReason === null) await fail('act 6: the cancelled task keeps no reason for why it was dropped')

  const cancelledEvents = await eventsOfType('task_cancelled')
  console.log(`act 6 task.cancelled: ${cancelledEvents.map(describeEvent).join('; ')}`)
  if (cancelledEvents.length !== 1 || cancelledEvents[0].taskId !== polishTask.id) {
    await fail(`act 6 appended ${String(cancelledEvents.length)} task.cancelled events, expected one for polish`)
  }
  // The TASK's own stamp -- the requirement whose work was dropped -- not the version that dropped it.
  if (cancelledEvents[0].payload.goalVersion !== 1) {
    await fail(`act 6's task.cancelled says goalVersion ${String(cancelledEvents[0].payload.goalVersion)}, expected the task's own 1`)
  }
  if (cancelledEvents[0].actor !== 'human') await fail(`act 6's task.cancelled says actor ${cancelledEvents[0].actor}, expected human`)
  const appliedEvents = await eventsOfType('supervisor_applied')
  if (!appliedEvents.some((event) => event.payload.decisionId === cancelProposal.id)) {
    await fail(`act 6 cancelled the task without recording which decision did it: ${appliedEvents.map(describeEvent).join('; ')}`)
  }

  // ...and the operator finishes the job on the work that DID survive. Safe with no daemon running,
  // and safe from unblocking anything: the only dependent of api is the task just cancelled.
  await mergeAndConfirm('act 6', apiDone)
  console.log('act 6 complete: a person approved the cancellation, the dropped work went off the board carrying the requirement it came from, and the work that survived is on main')
```

- [ ] **Step 11: Act 7 — the truth table, and the teardown**

```js
  // ================= Act 7: with nothing running, every surface has to agree ======================

  const stillRunning = findRealDaemonPids()
  console.log(`act 7 orchestrator daemons on this host: ${JSON.stringify(stillRunning)}`)
  if (stillRunning.length > 0) await fail(`act 7 is taking its readings while a daemon is alive: ${JSON.stringify(stillRunning)}`)

  // ---- the board --------------------------------------------------------------------------------
  const finalBoard = await board()
  console.log(`act 7 board (${String(finalBoard.length)}):\n  ${finalBoard.map(describeTask).join('\n  ')}`)
  const expectedBoard = [
    { title: CORE_TITLE, status: 'done', goalVersion: 1, integrated: true },
    { title: API_TITLE, status: 'done', goalVersion: 1, integrated: true },
    { title: POLISH_TITLE, status: 'cancelled', goalVersion: 1, integrated: false },
    { title: ADDED_TITLE, status: 'ready', goalVersion: 2, integrated: false },
  ]
  if (finalBoard.length !== expectedBoard.length) await fail(`act 7's board holds ${String(finalBoard.length)} tasks, expected ${String(expectedBoard.length)}`)
  for (const expected of expectedBoard) {
    const row = finalBoard.find((task) => task.title === expected.title)
    if (row === undefined) await fail(`act 7's board has no task titled ${JSON.stringify(expected.title)}`)
    if (row.status !== expected.status || row.goalVersion !== expected.goalVersion || (row.integratedAt !== null) !== expected.integrated) {
      await fail(`act 7's ${JSON.stringify(expected.title)} reads ${describeTask(row)} integratedAt ${JSON.stringify(row.integratedAt)}, expected ${JSON.stringify(expected)}`)
    }
  }

  // ---- the stale badge, as a COUNT (erratum E8) --------------------------------------------------
  const finalWorld = await loadSupervisorWorld(workspaceId)
  const finalReport = summarise(finalWorld.world)
  const finalWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  console.log(`act 7 report.next: ${JSON.stringify(finalReport.next)}; workspace.goalVersion ${String(finalWorkspace.goalVersion)}`)
  if (finalWorkspace.goalVersion !== 2) await fail(`act 7's workspace is on goal v${String(finalWorkspace.goalVersion)}, expected 2`)
  // Nothing is stale: the two v1 tasks that survived are `done` and the third is `cancelled`, and a
  // terminal task is never behind its requirement.
  if (finalReport.next.stale !== 0) await fail(`act 7's stale count is ${String(finalReport.next.stale)}, expected 0`)
  if (finalReport.next.ready !== 1 || finalReport.next.running !== 0 || finalReport.next.waiting !== 0 || finalReport.next.blocked !== 0) {
    await fail(`act 7's report.next is ${JSON.stringify(finalReport.next)}, expected exactly one ready task and nothing else moving`)
  }
  if (finalReport.done.integrated !== 2 || finalReport.done.awaitingIntegration !== 0) {
    await fail(`act 7's report.done is ${JSON.stringify(finalReport.done)}, expected two integrated and none waiting`)
  }
  if (finalReport.stuck.length !== 0) await fail(`act 7 leaves ${String(finalReport.stuck.length)} situation(s) stuck: ${JSON.stringify(finalReport.stuck)}`)

  // ---- the Supervisor ---------------------------------------------------------------------------
  const decisionsOutput = runCli(['supervisor-decisions', '--workspace', workspaceId])
  console.log(`act 7 supervisor-decisions printed:\n${decisionsOutput}`)
  const decisions = JSON.parse(decisionsOutput)
  if (decisions.length !== 2) await fail(`act 7's decision history has ${String(decisions.length)} rows, expected exactly two`)
  const byKind = Object.fromEntries(decisions.map((row) => [row.situationKind, row]))
  if (byKind.unanswerable_question?.status !== 'applied') await fail(`act 7's answer decision is ${String(byKind.unanswerable_question?.status)}, expected applied`)
  if (byKind.stale_task?.status !== 'approved') await fail(`act 7's cancellation decision is ${String(byKind.stale_task?.status)}, expected approved`)
  const pendingOutput = JSON.parse(runCli(['supervisor-decisions', '--workspace', workspaceId, '--pending']))
  console.log(`act 7 pending decisions: ${JSON.stringify(pendingOutput)}`)
  if (pendingOutput.length !== 0) await fail(`act 7 leaves ${String(pendingOutput.length)} decision(s) waiting on a human`)
  // Erratum E6: `applied` counts the ONE the Supervisor carried out itself; the approved one is
  // `approved`, and neither is an escalation or a failure.
  console.log(`act 7 report.supervisor: ${JSON.stringify(finalReport.supervisor)}`)
  if (finalReport.supervisor.applied !== 1 || finalReport.supervisor.pending !== 0 || finalReport.supervisor.escalated !== 0 || finalReport.supervisor.failed !== 0) {
    await fail(`act 7's report.supervisor is ${JSON.stringify(finalReport.supervisor)}, expected one applied and nothing pending, escalated or failed`)
  }
  // The other half of `buildSupervisorView` (ruling R6): the CLI and the panel read one list.
  const viaControl = await listDecisions(workspaceId)
  if (JSON.stringify(viaControl) !== JSON.stringify(decisions)) {
    await fail(`act 7: listDecisions and \`supervisor-decisions\` disagree:\n  ${JSON.stringify(viaControl)}\n  ${decisionsOutput}`)
  }
  const settings = await supervisorSettings(workspaceId)
  console.log(`act 7 supervisor settings: ${JSON.stringify(settings)}`)
  if (settings === null || settings.enabled !== true) await fail(`act 7's Supervisor settings read ${JSON.stringify(settings)}, expected it enabled`)

  // ---- the mailbox ------------------------------------------------------------------------------
  const messagesOutput = runCli(['messages', '--workspace', workspaceId])
  console.log(`act 7 messages printed:\n${messagesOutput}`)
  // `messages` lists PENDING questions -- the ones a slave is still waiting on. This one was
  // answered, so the honest end state is that nobody is waiting.
  if (!messagesOutput.includes('no slave is waiting on an answer')) {
    await fail(`act 7's \`messages\` still shows somebody waiting:\n${messagesOutput}`)
  }
  const pendingQuestions = await listPendingQuestions(workspaceId)
  if (!pendingQuestions.ok || pendingQuestions.value.length !== 0) await fail(`act 7's pending questions: ${JSON.stringify(pendingQuestions)}`)
  const thread = await prisma.slaveMessage.findMany({ where: { workspaceId, threadId: question.threadId }, orderBy: { seq: 'asc' } })
  console.log(`act 7 the whole thread (${String(thread.length)}):\n  ${thread.map(describeMessage).join('\n  ')}`)
  if (thread.length !== 2) await fail(`act 7's thread is ${String(thread.length)} messages long, expected the question and its answer`)
  if (thread[0].kind !== 'question' || thread[1].kind !== 'answer') await fail(`act 7's thread reads ${JSON.stringify(thread.map((row) => row.kind))}, expected question then answer`)
  console.log(`act 7 report.mailbox: ${JSON.stringify(finalReport.mailbox)}`)
  if (finalReport.mailbox.pendingQuestions !== 0 || finalReport.mailbox.draftsAwaiting !== 0 || finalReport.mailbox.answeredBySupervisor24h !== 1) {
    await fail(`act 7's report.mailbox is ${JSON.stringify(finalReport.mailbox)}, expected nothing waiting and one answer sent`)
  }

  // ---- the spend --------------------------------------------------------------------------------
  const fullTable = [
    ...partialTable,
    { kind: 'planning run (the re-plan)', count: 1, unitUsd: fixtureCostUsd('replan-delta') },
    { kind: 'supervisor decision: the cancellation proposal (the re-plan run already paid; no model here)', count: 1, unitUsd: 0 },
  ]
  const fullTotal = printTable('act 7 the whole story\'s spend', fullTable)
  const runsByKind = await prisma.slaveRun.groupBy({ by: ['kind'], where: { slave: { team: { workspaceId } } }, _count: { _all: true } })
  console.log(`act 7 runs by kind: ${JSON.stringify(runsByKind)}`)
  const countOfKind = (kind) => runsByKind.find((row) => row.kind === kind)?._count._all ?? 0
  // Asserted BEFORE the total, so a duplicate first-plan run (the narrow race `quiescePlanning`'s
  // own comment describes) fails here with a diagnosis rather than as an unexplained dollar figure.
  if (countOfKind('planning') !== 2 || countOfKind('implementation') !== 2 || countOfKind('review') !== 2) {
    await fail(`act 7 counted ${JSON.stringify(runsByKind)}, expected 2 planning (a plan and a re-plan), 2 implementation and 2 review runs`)
  }
  const finalSpend = await workspaceSpend(workspaceId)
  const finalStats = await workspaceStats(workspaceId)
  console.log(`act 7 workspaceSpend: ${JSON.stringify(finalSpend)}`)
  console.log(`act 7 workspaceStats.stats: ${JSON.stringify(finalStats.stats)}`)
  if (!sameMoney(finalSpend.spentUsd, fullTotal)) await fail(`act 7's workspaceSpend says $${String(finalSpend.spentUsd)}, the table says $${String(fullTotal)}`)
  if (finalSpend.supervisorUnmeasuredCalls !== 0) await fail(`act 7 charged ${String(finalSpend.supervisorUnmeasuredCalls)} Supervisor call(s) at the cap`)
  // Erratum E7: `workspaceStats` carries no task counts. What it does carry is the ONE spend
  // formula every guardrail evaluates, and it has to be the same number.
  if (!sameMoney(finalStats.stats.spentUsd, finalSpend.spentUsd)) await fail('act 7: workspaceStats and workspaceSpend disagree about what this project spent')
  if (finalStats.stats.activeRuns !== 0 || finalStats.stats.consecutiveFailures !== 0 || finalStats.stats.emergencyStopped !== false) {
    await fail(`act 7's stats read ${JSON.stringify(finalStats.stats)}, expected an idle, unbroken, unhalted project`)
  }

  // ---- the event log ----------------------------------------------------------------------------
  const allEvents = await prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'asc' } })
  const census = new Map()
  for (const event of allEvents) census.set(event.type, (census.get(event.type) ?? 0) + 1)
  console.log(`act 7 event census (${String(allEvents.length)} events):`)
  for (const [type, count] of [...census].sort()) console.log(`  ${String(count).padStart(3)}  ${type}`)
  // Only the load-bearing ones are asserted. The rest are printed so a change in them is READABLE
  // in the log of a passing run rather than invisible until something else breaks.
  const expectedCounts = {
    workspace_goal_set: 2,
    workspace_plan_created: 1,
    workspace_replan_started: 1,
    workspace_replanned: 1,
    task_created: 4,
    task_cancelled: 1,
    task_integrated: 2,
    task_done: 2,
    slave_message_sent: 2,
    run_paused: 1,
    run_resumed: 1,
    run_failed: 0,
    // Erratum E5: the Supervisor's events are `supervisor.decided`/`proposed`/`applied`/`resolved`/
    // `failed`. Two decisions were recorded; one of them was a proposal; one was applied by the
    // machine and one by a person's approval; one was resolved by that person.
    supervisor_decided: 2,
    supervisor_proposed: 1,
    supervisor_applied: 2,
    supervisor_resolved: 1,
    supervisor_failed: 0,
    slave_runtime_roles_changed: 1,
    // The whole story ran inside its guardrails: nothing tripped, and the budget was never warned
    // about.
    guardrail_tripped: 0,
  }
  for (const [type, expected] of Object.entries(expectedCounts)) {
    const actual = census.get(type) ?? 0
    if (actual !== expected) await fail(`act 7 counted ${String(actual)} ${type} event(s), expected ${String(expected)}`)
  }

  // ---- the CLI's own last word ------------------------------------------------------------------
  const statusOutput = runCli(['status', '--workspace', workspaceId])
  console.log(`act 7 status printed:\n${statusOutput}`)
  const status = JSON.parse(statusOutput)
  if (status.halt !== null) await fail(`act 7's status reports a halt: ${JSON.stringify(status.halt)}`)
  if (status.archived !== null) await fail(`act 7's status reports the project archived: ${String(status.archived)}`)
  if (status.runs.length !== 0) await fail(`act 7's status still lists ${String(status.runs.length)} live run(s): ${JSON.stringify(status.runs)}`)

  const contextOutput = runCli(['show-context', '--run', replanRunId, '--prompt'])
  console.log(`act 7 show-context on the re-plan run printed:\n${contextOutput}`)
  if (!contextOutput.includes('"kind": "replan"')) await fail("act 7: show-context does not render the re-plan run's replan section")
  if (!contextOutput.includes('THE GOAL CHANGED')) await fail('act 7: show-context does not print the prompt the re-plan was given')

  const finalReplanStatus = JSON.parse(runCli(['replan-status', '--workspace', workspaceId]))
  console.log(`act 7 replan-status: ${JSON.stringify(finalReplanStatus)}`)
  if (finalReplanStatus.willReplan !== false || finalReplanStatus.boardVersion !== 2) {
    await fail(`act 7's replan-status reads ${JSON.stringify(finalReplanStatus)}, expected a board that has caught up to v2 with no further re-plan due`)
  }
  // Re-typing the requirement it already has is not an edit -- the last thing an operator is likely
  // to do by accident, and the last thing this story proves.
  const unchanged = runCliRaw(['set-goal', '--workspace', workspaceId, '--goal', GOAL_V2])
  console.log(`act 7 set-goal (same text) exit ${String(unchanged.status)}, stderr ${JSON.stringify(unchanged.stderr)}`)
  if (unchanged.status === 0) await fail('act 7: setting the goal to the text it already reads exited 0')
  if ((await prisma.goalVersion.count({ where: { workspaceId } })) !== 2) await fail('act 7: the refused set-goal wrote a third version')

  console.log(
    'PASS: one requirement became a plan, a worker took the first task and stopped to ask a question nobody in the company could ' +
      'answer, the Supervisor answered it from a sentence in the worker\'s own task and woke it up, two tasks were verified, ' +
      'reviewed by a slave that wrote neither of them and merged onto main by a person, a changed requirement produced a delta ' +
      're-plan that added work and only PROPOSED a cancellation, a human approved it -- and with nothing running, the board, the ' +
      'goal history, the Supervisor, the mailbox, the spend and the event log all tell the same story',
  )
  exitCode = 0
```

The `finally` block is copied verbatim from `scripts/gate-m40-requirement-versioning.mjs` (lines 985–1016) — every daemon killed, the stray-pid sweep for pids this gate spawned, vendor children before the rows they are named on, events then workspace, the temp repo removed, `prisma.$disconnect()` — followed by `process.exit(exitCode)`.

- [ ] **Step 12: Run the gate**

First make sure no vitest run and no daemon are alive (the gate refuses on the second and the shared Postgres cannot take the first), then:

```bash
npx tsc --build
node --env-file=.env scripts/gate-m41-scenario.mjs
```

Expected: the seven acts print their measurements and the run ends `PASS: …` with exit 0. Read the printed spend table and the event census in the output even on a pass — they are the milestone's evidence, and they belong in the task report.

If an act fails on a timing claim (`… started N run(s) for work this act was stopped before`), do **not** widen the tolerance: raise `DAEMON_PERIOD_MS`, which is what bounds the window, and say so in the report.

- [ ] **Step 13: Run the parity test, typecheck and the vocabulary gate**

```bash
npx vitest run apps/web/test/gate-surface-parity.test.ts
npm run --silent typecheck
npm run gate:m26-vocabulary
```
Expected: all pass.

- [ ] **Step 14: Commit**

```bash
git add scripts/gate-m41-scenario.mjs apps/web/test/gate-surface-parity.test.ts \
        packages/providers/test/fake-claude.mjs packages/providers/test/fake-claude.test.ts
git commit -m "$(cat <<'EOF'
test(gates): m41 t3 — one story through the whole system, and every operator surface asked at the end

Seven acts under four real daemons and the fake CLI: plan, ask, a Supervisor answer proved against
the asking task's own text, resume, verify, review, a human's merge and confirmation, a delta
re-plan, an approval — then the board, the goal history, the Supervisor, the mailbox, a spend table
read off the fixtures at runtime and a per-type event census, with nothing running.

The workspace does not auto-merge (erratum E4): that makes `task.integrated` real, makes M35's
dependency gate a measured act, and is the only thing that keeps `polish` unstartable while the
re-plan runs. The asking leg records no cost (erratum E3), and the ask discriminator is the task
title because a work run's prompt never carries its id (erratum E2).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 4: The narrative, the README, the script, CI — and the full verification ladder

**Files:**
- Create: `docs/scenarios/e2e-software-team.md`
- Modify: `README.md` (new `## The whole story` section after "Requirements have versions"; "Tests and CI" roster 16 → 17)
- Modify: `package.json` (`gate:m41-scenario`)
- Modify: `.github/workflows/ci.yml` (after `gate:m40-requirement-versioning`)

**Interfaces:**
- Consumes from Task 3: the script path `scripts/gate-m41-scenario.mjs`, the workspace name `M41 Scenario Project`, and the seven acts.
- Produces: the npm script name `gate:m41-scenario`.

- [ ] **Step 1: Add the npm script**

In `package.json`, after the `gate:m40-requirement-versioning` line (note the comma that has to move onto it):

```json
    "gate:m40-requirement-versioning": "tsc --build && node --env-file=.env scripts/gate-m40-requirement-versioning.mjs",
    "gate:m41-scenario": "tsc --build && node --env-file=.env scripts/gate-m41-scenario.mjs"
```

- [ ] **Step 2: Add it to CI**

In `.github/workflows/ci.yml`, immediately after line 69:

```yaml
      - run: npm run gate:m41-scenario
```

- [ ] **Step 3: Write the narrative**

Create `docs/scenarios/e2e-software-team.md`. The word is **slave** — `docs/scenarios/` is not on `gate:m26-vocabulary`'s exclude list, so "agent" anywhere in this file fails the gate.

````markdown
# One story, end to end: a software team that coordinates itself

`npm run gate:m41-scenario` (`scripts/gate-m41-scenario.mjs`) tells one story through the whole
system and then asks every operator surface what happened. Every earlier gate proves one seam —
m35 integration truth, m36 ask and answer across a restart, m37 the recorded prompt, m38 staffing
and budget, m39 the mailbox, m40 re-planning. None of them runs the seams in sequence, and the
sequence's claim — a team that coordinates itself and tells the truth about its state — is only
proven when one run crosses all of them.

Nothing here is mocked except the model. Four real `orchestrator daemon` processes run in turn
against a real git repository and the real database; every `claude` invocation is
`packages/providers/test/fake-claude.mjs --fixture m41-flow`, so the gate spends nothing and
replays the same recorded transcripts every other gate does.

## The company

| Slave | Runtime roles | What it does in the story |
| --- | --- | --- |
| Atlas | `manager` | plans, and re-plans |
| Dev | `backend` | one of the two who can take a task |
| Ops | `backend` | the other one |
| Rae | `reviewer` | reviews, and nothing else — so it never reviews its own work |
| Quinn | `qa`, then nothing | holds the role the question is addressed to, and loses it |

`Quinn` is not decoration. `ask.ts` refuses a question addressed to a role no other slave holds —
parking a task to wait for nobody is the bug that check exists to prevent — so a question can only
*become* unanswerable after it was asked. Quinn holds `qa` while the question is asked and the
operator takes it away immediately afterwards, which is the only shape in which the Supervisor's
`unanswerable_question` is reachable at all.

The project does **not** auto-merge. A reviewed task lands `done` with its branch unmerged, and a
person merges it and runs `confirm-integration`. That is the M35 rule the story is partly about, and
it is what keeps the board still between acts: a task whose dependency is done but unmerged cannot
be dispatched, so every measurement the gate takes is a measurement rather than a race.

## Act 1 — a requirement becomes a plan

`set-goal` prints `{"version":1,"sha256":"…"}`. Daemon-1 starts, Atlas is given a planning run, and
the run lands three tasks: `Write the feature core` → `Expose the API` → `Document and polish`, all
`ready`, all stamped `goal v1`.

Asserted: three tasks with those titles; every one `ready` at `goalVersion 1`; one
`workspace.plan_created` carrying version 1; every `task.created` carrying it too; the planning
run's recorded manifest saying `planning_goal.version 1` with **no** `replan` section; the prompt
carrying the goal text; `replan-status` reporting `willReplan false` with nothing in the way. Then
daemon-1 is stopped, and the gate proves no work run had started.

## Act 2 — a worker starts, and stops to ask

Daemon-2 carries `--ask-on-task core` on the fake CLI's argv and the question envelope in its
environment. The core task is dispatched to Dev or Ops — the gate records which; either is a true
story — and the run stops mid-task and asks the `qa` role which database the service talks to.

Asserted: the run is `paused` with `waiting_for_answer`; the task is `waiting` and still points at
that run; **no attempt was charged** and no `run.failed` was written, because asking is neither
failing nor finishing; exactly one `question` row exists, addressed to the role; `api` and `polish`
have not moved and have no runs at all. And the run's recorded manifest hashes exactly the task text
the renderer hashed — computed here with the product's own exported hash rather than a copy of it.

Then the operator runs `set-runtime-roles --slave <Quinn> --roles ''`, and the question has nobody
left who could answer it.

## Act 3 — the Supervisor answers what nobody else can

On its next pass the Supervisor sees `unanswerable_question` — no staleness wait, because however
fresh a question is, nobody can answer it — chooses `answer_question`, drafts one, and checks every
quote it cites against the asking task's own description. The quote is really there, so the answer
is sent by the machine itself.

Asserted: the decision row is `applied`/`applied`, `decidedBy: model`, carrying the cost of both
calls (the choice and the draft) read off the fixtures at runtime; the draft's confidence is
`sourced` with the quote among its verified citations and nothing rejected; exactly one `answer`
message exists, its envelope actor is `system` and its payload says `answeredBy: 'supervisor'`; a
later tick's `deliverAnswers` resumes the **same session** (`run.resumed` names the id `run.started`
did) and the resumed leg commits real work; there is still exactly **one** run for the task — the
answer continued the waiting run rather than starting a new one; and the Supervisor's own report
says it answered one question today and is waiting on nobody.

## Act 4 — verified, reviewed, and integrated by a person

Core's run succeeds, verify passes, Rae reviews it, and the merge pass marks it `done` with
`integratedAt` still null and its branch left alone.

Asserted: `api` reports `dependenciesDone: false` through the orchestrator's **own** `loadWorld` —
the snapshot the scheduler decides from — while core is done but unmerged. Then the operator merges
core's branch into `main` for real, checks the work is there, and runs `confirm-integration`:
`task.integrated` is written with actor `human`, and `api` becomes schedulable. Daemon-3 takes `api`
through the same pipeline with no question in it, Rae reviews that one too, and the gate stops the
daemon before `polish` — which it cannot start anyway, because `api` is not integrated yet.

The spend so far is printed as a table (kind, count, unit cost, subtotal) and asserted against
`workspaceSpend`, the one formula the guardrails and every surface read. One line of that table is
worth reading twice: **the leg that asked recorded no cost at all.** A run's cost is written once, at
its terminal conclusion, and a run that stops to ask never reaches one — so the single row for that
task carries exactly the resumed leg's price.

## Act 5 — the requirement changes

`set-goal` v2 — the goal now asks for an endpoint doc. `goal-history` prints v2 before v1 with the
line diff between them, and `replan-status` says a re-plan is due with nothing in the way.

Daemon-4 runs the re-plan. Asserted: the run's manifest has a `replan` section moving v1 → v2 with
both goal texts' hashes; the board it was shown is the **unfinished** board alone — just `polish`,
because core and api are done; the prompt carries `THE GOAL CHANGED` and both requirements. On
conclusion: one new task `Document the new endpoint`, `ready` at `goal v2`; one **pending**
`stale_task` proposal to cancel `polish`; `workspace.replanned` accounting for all four lists; and
`polish` still `ready`, because a cancellation is a proposal and not a deletion. The proposal cost
nothing — the re-plan run had already paid for that judgement, and the Supervisor's spend must not
gain a call that never happened.

## Act 6 — a human approves

`approve-decision --id <proposal>` cancels `polish`. Asserted: the decision reads `approved`; the
task is `cancelled` and keeps the reason; `task.cancelled` carries **the task's own** `goalVersion:
1` — the requirement whose work was dropped, not the one that dropped it — with actor `human`; and a
`supervisor.applied` event names the decision that did it. Then the operator merges `api`'s branch
and confirms its integration too.

## Act 7 — with nothing running, every surface has to agree

No daemon is alive on the host. Every reading below is printed before it is asserted.

- **The board.** `core` done and integrated at v1; `api` done and integrated at v1; `polish`
  cancelled at v1; `docs` ready at v2. Nothing is stale: the count behind the task card's **stale**
  badge is 0, because every task still carrying v1 is terminal.
- **The goal history.** `[v2, v1]`, each with its hash, v2 carrying a non-empty diff and v1 carrying
  none. The CLI and the control verb the web history route reads through return the same bytes.
- **The Supervisor.** Exactly two decisions: the answer, `applied`; the cancellation, `approved`.
  Nothing pending, nothing escalated, nothing failed, nothing stuck.
- **The mailbox.** `messages` says nobody is waiting on an answer, and the thread is two messages
  long — the question and its answer.
- **The spend.** The printed table's total equals `workspaceSpend.spentUsd` to a billionth of a
  dollar, no Supervisor call was charged at the unmeasured cap, and `workspaceStats` — the reading
  every guardrail evaluates — agrees. The run census is asserted first, so a duplicated run fails
  with a diagnosis instead of an unexplained figure.
- **The event log.** A count per type is printed, and the load-bearing ones are asserted: four
  `task.created`, one `task.cancelled`, two `task.integrated`, two `task.done`, one
  `workspace.plan_created`, one `workspace.replan_started`, one `workspace.replanned`, two
  `slave.message_sent`, one `run.paused`, one `run.resumed`, no `run.failed`, two
  `supervisor.decided`, one `supervisor.proposed`, two `supervisor.applied`, one
  `supervisor.resolved`, no `supervisor.failed` — and **zero** `guardrail.tripped`.
- **The CLI's last word.** `status` reports no halt and no live run; `show-context` on the re-plan
  run renders its `replan` section and the prompt it was given; `replan-status` says the board has
  caught up; and re-typing the requirement the project already has exits non-zero and writes no
  third version.

## Things this story deliberately does not do

- It never calls a real model. `SLAVEOFAI_REQUIRE_FAKE_CLI=1` makes that a refusal rather than a
  convention.
- It does not import `apps/web`. The web builders compose control and domain verbs, and the gate
  calls those verbs — `apps/web/test/gate-surface-parity.test.ts` pins the mapping so a builder that
  starts computing something of its own fails a test rather than silently making this gate a
  measurement of nothing.
- It does not run a one-shot `tick` for anything a daemon can drive.
- It fixes nothing. Every stage prints what it measured and then asserts it; a failed assertion
  dumps every row this workspace owns and exits 1.
````

- [ ] **Step 4: Add the README section**

In `README.md`, insert a new section immediately before `## The Supervisor` (i.e. after the
"Requirements have versions" section ends at the `willReplan` paragraph):

```markdown
## The whole story

Every section above describes one seam. `npm run gate:m41-scenario` runs them in sequence, once,
against a real orchestrator daemon and the fake slave CLI — one requirement, one plan, a worker that
stops to ask a question nobody in the company can answer, a Supervisor that answers it from a
sentence in the worker's own task and wakes it up, work verified, reviewed by a slave that wrote
none of it and merged onto `main` by a person, a changed requirement that produces a delta re-plan,
and a human approving the one cancellation it proposed. Then, with nothing running, it asks the
board, the goal history, the Supervisor, the mailbox, the spend and the event log what happened, and
they all have to say the same thing.

`docs/scenarios/e2e-software-team.md` tells that story act by act, with what each one asserts.
```

- [ ] **Step 5: Update the "Tests and CI" roster**

In `README.md`'s "Tests and CI" section: add `gate:m41-scenario` to the CI list, extend the
per-gate sentence, and change the count. Replace

```
`gate:m39-supervisor-mailbox` and `gate:m40-requirement-versioning` on every push
```

with

```
`gate:m39-supervisor-mailbox`, `gate:m40-requirement-versioning` and `gate:m41-scenario` on every push
```

and replace

```
the cancelled work still cannot start. That is 16 gates. Tests and gates share one Postgres — run
```

with

```
the cancelled work still cannot start, and `m41` runs all of it as ONE story — plan, ask, a
Supervisor answer, a resume, a review, a hand merge, a re-plan and an approval — and then asks every
operator surface at once whether they agree about what happened
(`docs/scenarios/e2e-software-team.md`). That is 17 gates. Tests and gates share one Postgres — run
```

- [ ] **Step 6: Full verification ladder**

Run these **in this order**, one at a time, with no `next dev` running anywhere and no other vitest
process alive (the shared test database truncates, and a running daemon breaks
`subscribe.test.ts`):

```bash
npm run --silent typecheck
npm run gate:m26-vocabulary
npx vitest run
npm run web:build
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
and restart it afterwards.

Paste the full output of `gate:m41-scenario` — the spend table and the event census included — into
the task report. They are the milestone's evidence.

- [ ] **Step 7: Commit**

```bash
git add docs/scenarios/e2e-software-team.md README.md package.json .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
docs,ci: m41 t4 — gate:m41-scenario in CI, and the story it tells written down

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

## Self-review

**Spec coverage.** §1's seven bullets: one story / one daemon lineage → Task 3 (four daemons, each
restart proved the m36 way); R1 the single fake-CLI mode → Task 2; R2 the sourced path with no new
threshold seam → Task 3 act 3 (and erratum E1, which is what makes it reachable); R3 the M40
residuals → Task 1 (a–c fixed, d closed with a ledger note per E10); R4 the story's own fixture →
Task 2 Step 1; R5 the dedicated reviewer → Task 3 setup (Rae, plus the fifth slave E1 requires); R6
the web surfaces → Task 3's mapping table, the parity test, and erratum E9; "the gate asserts, it
never fixes" → every act prints then asserts, `fail()` dumps and exits 1, `finally` tears down; "no
real model call" → Global Constraints and `childEnv`. §2's eight acts → Task 3 Steps 5–11, one act
each, with the three "stop before X dispatches, fail loudly" measurements in acts 1, 4 and 5
(`stopBeforeRunsFor`). §3's product changes → Tasks 1, 2 and 4 (§3's "possibly a control-level read
helper" is answered NO by E9, with the reason). §4's out-of-scope list is respected: no acceptance
criteria, no Cursor, no multi-workspace, no real model calls, no `waiting_stale` threshold seam, no
web UI change (the one new web file is a test).

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Every
code step carries the code. The three places that say "copy verbatim from `gate-m40…mjs` lines X–Y"
name the file, the line range and the deltas, which is more precise than retyping a diagnostic
helper and risking a silent divergence from the shape every other gate's failure report uses.

**Type consistency.** `--ask-on-task` carries a **space-free token** everywhere: Task 2's
`askOnTaskTitle()`/`isAskingLeg()` (token form, folded into Task 2 by the pre-flight ruling), Task 2's tests, and Task 3's
`ASK_ON_TASK_TOKEN`. `m41-work.txt`, `plan-graph-scenario`, `m41-flow`, `FAKE_CLAUDE_ASK_JSON`,
`PostgreSQL on port 5433` and the three plan titles are spelled identically in Task 2 and Task 3.
The control/domain imports in Task 3 are all real exports (`packages/control/src/index.ts` re-exports
`goal.js`, `supervisor.js`, `supervisorWorld.js`, `spend.js`, `stats.js`, `messaging.js`,
`kill.js`; `packages/domain/src/index.ts` re-exports `goal/`, `run-context/`, `supervisor/`). The
event names in the census are the Postgres enum members from `schema.prisma`, not the domain's
dotted spellings.
