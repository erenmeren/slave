# M19 Measure and Harden Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M18's two unmeasured assumptions with real vendor measurements (a genuine matrix-deny capture, a Cursor write≠edit re-probe), harden the enforcement chain on what the measurements say, and pay seven hygiene debts each carrying an M18 ruling.

**Architecture:** Series A measures first because A1's capture can falsify the hand-authored fixture's shape and A2's verdict decides whether Task 7 exists. Series B fixes the proven resume-echo re-fail risk by making `run.tool_denied` carry its `toolUseId` and seeding the resumed pump's exclusion set from the event log, hardens the id association with the tool-name cross-check the deny reason already carries, and writes the self-policing threat note. Series C: a partial SQL index for the skill queries, cable thickness from `edges[].count`, eight inline fetch blocks onto `sendControl`, `listWorkers` grouped in SQL behind an equivalence test, a CompanyManager file split, and the TASK_STATUS derivation off the one tone table. The gate stays zero-spend by verifying recorded evidence.

**Tech Stack:** TypeScript monorepo, Vitest 3.2.7, Prisma + Postgres (one SQL-only migration), Next.js + React Flow, bash gate hooks + node one-liners, playwright-core gate.

**Spec:** `docs/superpowers/specs/2026-09-01-m19-measure-and-harden-design.md` — read it before any task. Approach A (measurements first) and the ≤$2 budget are operator decisions of 2026-09-01.

## Global Constraints

- Branch: `feature/m19-measure-and-harden`, cut from `main` at `ce48adc`. Every task commits there.
- One vitest run at a time; no orchestrator daemon during tests (`pgrep -f 'cli.js daemon'` SELF-MATCHES its wrapper shell — confirm any hit via `/proc/<pid>/cmdline` before believing it).
- `npm test` = `tsc --build && vitest run`. Root `tsc --build` does NOT cover apps/web tests — use `npx tsc -p apps/web/tsconfig.test.json --noEmit` for web fails-first/type evidence.
- Any task touching `apps/web` gates on `npm run web:build` before commit; never while a `next dev` runs.
- Migrations: additive only; migration dirs follow `<YYYYMMDDHHMMSS>_m19_<snake_desc>` with round synthetic timestamps; after adding one run the TEST db migrate flow (`node scripts/migrate-test.mjs` — read it first); the DEV db migration happens at gate/merge time.
- `bash scripts/census-runtime.sh` must exit 0 at every task's commit.
- Trace every new field/element/event payload key to its CONSUMER within its own task or a task this plan explicitly pairs it with.
- `git add` with explicit paths only.
- Fixture redaction rules (`packages/providers/test/fixtures/README.md`, four rules) bind Tasks 1–2: byte-for-byte except named mechanical substitutions; every substitution recorded as a runnable command; scrub home dirs including the mangled `-home-<user>-` form; never add/remove/reorder a line to fit a test.
- Spend: Task 1 ≤ $1.00, Task 2 ~$1.00, milestone total ≤ $2.00. Actuals recorded in the spec's spend ledger the same day.

---

### Task 1: A1 — capture the real matrix-deny run and retire the hand-authored fixture

**Files:**
- Create: `scripts/capture-matrix-deny.mjs` (throwaway-quality is NOT acceptable — it is committed as the runnable provenance)
- Modify: `packages/providers/test/fixtures/permission-matrix-deny.ndjson` (replace content)
- Modify: `packages/providers/test/fixtures/README.md` (retire the "hand-authored exception" section, add provenance)
- Modify: `docs/superpowers/specs/2026-09-01-m19-measure-and-harden-design.md` (spend ledger row + findings)
- Possibly modify: tests that pin the fixture's ids/shape (find with `grep -rn "toolu_pmd\|permission-matrix-deny" packages/ apps/`)

**Interfaces:**
- Consumes: `scripts/gate-m12-providers.mjs` helpers as the crib — `makeRepo` (:134), `resolveOnPath` (:154), `preflightCleanup` (:182), `waitUntil` (:283); `versionOf(bin)` from `scripts/gate-m13-runtime.mjs:228-234` (copy it — it is a gate-local function); `scripts/gate-m18-skill-and-teeth.mjs:504`'s matrix seed (`prisma.agentPermission.create({ data: { agentId, tool: 'run tests', mode: 'deny' } })`).
- Produces: the genuine `permission-matrix-deny.ndjson` whose terminal `result` line carries `permission_denials` with real ids; a findings list (shape divergences vs the hand-authored file) that Tasks 3–4 read.

- [ ] **Step 1: Inventory the fixture's current consumers.** Run `grep -rn "permission-matrix-deny\|toolu_pmd" packages/ apps/ scripts/ --include="*.ts" --include="*.mjs"` and list every test/gate that pins ids or line shapes from the fixture. Record the list in the task notes — these are the files Step 7 may touch.
- [ ] **Step 2: Write `scripts/capture-matrix-deny.mjs`.** Structure (crib `gate-m12-providers.mjs`; keep its `let exitCode = 1` / single `try` / `process.exit(exitCode)` shape):
  - Preflight: real `claude` resolved on PATH via `resolveOnPath` (REFUSE if the resolved path contains `gate-fakes` — this script is the one place that must NOT run the fake); `.env` + `DATABASE_URL` present; no real daemon running.
  - Record `versionOf(claudeBin)` FIRST, before the run.
  - Seed: temp git repo via `makeRepo`; workspace with `maxAttempts: 1`, default budget; one agent; `agentPermission` row `{ tool: 'run tests', mode: 'deny' }`; one tiny task whose description makes a test run certain, mirroring the hand-authored transcript's scenario: "Read `target.txt`, then run the test suite with `npm test`, then report what target.txt contains." Create `target.txt` with one known line in the repo.
  - Pin the cheap model: `CLAUDE_MODEL = 'sonnet'` (gate-m12:85 precedent).
  - Drive the daemon exactly as `gate-m12-providers.mjs:493` does (`node apps/orchestrator/dist/cli.js daemon --workspace <id> --period 500`), with `AITEAMOS_CLAUDE_ARGS` untouched.
  - Capture: the run's raw stdout NDJSON. The pump already persists nothing raw, so tee it at the source: run with `AITEAMOS_CLAUDE_BIN` pointed at a 3-line wrapper script the capture script writes to its temp dir — `#!/usr/bin/env bash\nexec > >(tee "$CAPTURE_OUT") \nexec claude "$@"` is NOT correct (it redirects the wrapper's stdout before exec); use instead: `#!/usr/bin/env bash\nclaude "$@" | tee "$CAPTURE_OUT"` with `CAPTURE_OUT` env baked in by the generator. The wrapper must preserve exit code: end with `exit ${PIPESTATUS[0]}`.
  - Wait via `waitUntil` for the run to conclude; assert in-script: ≥1 `run.tool_denied` event exists, run status is `succeeded` (if the real CLI behaves differently, DO NOT massage — print the divergence and still save the capture; a divergence is a finding, not a failure of the capture).
  - Print: version, `total_cost_usd` from the terminal line, capture path.
- [ ] **Step 3: Run the capture** (`node --env-file=.env scripts/capture-matrix-deny.mjs`). Cost cap $1 — the pinned sonnet model and `maxAttempts: 1` structurally keep it near the M12-measured $0.09–0.42 range. If the first run does not trigger the deny (agent never attempts Bash), adjust the task description once and re-run; two attempts maximum, then stop and report.
- [ ] **Step 4: Scrub.** Apply the M17 recipe to the raw capture: `sed -e 's#/home/<operator>#/home/fixture-user#g'` plus the mangled form `-home-<operator>-` → `-home-fixture-user-`, plus any `/run/user/<uid>/...` socket paths → `UID`/`PID` placeholders. Record every substitution as a runnable command for the README.
- [ ] **Step 5: Replace the fixture.** Overwrite `packages/providers/test/fixtures/permission-matrix-deny.ndjson` with the scrubbed capture, byte-for-byte otherwise.
- [ ] **Step 6: Rewrite the README section.** In `packages/providers/test/fixtures/README.md`: delete the "one hand-authored exception" framing everywhere it appears (opening paragraph, table row, dedicated section); write the provenance section in the `fixtures/claude/README.md` shape — binary version (from Step 2's `versionOf`), date, the runnable command (`node --env-file=.env scripts/capture-matrix-deny.mjs`), cost, the matrix row and task that produced it, and the named scrub substitutions.
- [ ] **Step 7: Re-run the fixture's consumers** (Step 1's list) — e.g. `npx vitest run apps/orchestrator/test/integration/pump.test.ts packages/providers/test/` plus `fake-claude.test.ts`. Update pinned ids/shapes to the real capture's values where a test pinned the hand-authored ones. Any SEMANTIC divergence (a different event ordering, a different `permission_denials` shape, hook_name form, denial landing differently) goes into the task notes as a numbered finding for Tasks 3–4 — do not silently adapt product code in this task.
- [ ] **Step 8: Full check** — `npm test`, `bash scripts/census-runtime.sh`. Record actual cost + version in the spec's spend ledger (edit the table in place).
- [ ] **Step 9: Commit** — `git add` the script, fixture, README, spec, and each touched test by explicit path.

### Task 2: A2 — Cursor write≠edit re-measure, version-first

**Files:**
- Modify: `packages/providers/test/fixtures/cursor/gate/README.md` (new dated section)
- Create (only if a run happens): raw evidence files beside it (`run-3-*.log/ndjson` naming, following the existing files)
- Modify: `docs/superpowers/specs/2026-09-01-m19-measure-and-harden-design.md` (spend ledger + A2 verdict)

**Interfaces:**
- Consumes: the M13 Task 9 method recorded in `fixtures/cursor/gate/README.md` (hooks file in a real `git worktree` root; the known id-sharing fact: an `editToolCall`'s first gated step arrives as `preToolUse` `tool_name: "Read"` with the same id); `versionOf` (copy from `gate-m13-runtime.mjs:228`).
- Produces: a verdict — `fixed` or `not fixed` — that decides whether Task 7 runs. Recorded in the README section AND in the spec.

- [ ] **Step 1: Version check first.** `cursor-agent --version`. If it still reports `2026.08.25-3e8eec8` (the M13-measured version), the standing measurement is CURRENT: write a dated one-paragraph README section saying re-measure was a no-op at the same version, verdict `not fixed` carries over, spend $0. Skip to Step 4.
- [ ] **Step 2 (only on version drift): re-run the M13 probe.** Real `git worktree` root; `.cursor/hooks.json` registering matcher-less `preToolUse` + `beforeShellExecution` pointed at a logging hook script (crib the M13 method from the README — it names the exact setup); prompt the agent to (a) read a file, (b) write/edit a file, (c) run one shell command; pin the cheap model from `cursor-agent --list-models` (M12 rule: read the list, don't trust docs). Capture the hook log and the stream NDJSON. Record the version the hook payloads themselves report in `cursor_version` (the checkable-from-artifact rule).
- [ ] **Step 3 (with Step 2): judge and file the evidence.** The single question: does the write/edit arrive at `preToolUse` with a truthful `tool_name` (an `edit`/`write` identity, its own id), or still as `tool_name: "Read"` sharing the edit call's id? Scrub per the four rules; add `run-3-*` files and the dated README section with method, version, verdict, cost.
- [ ] **Step 4: Record the verdict in the spec** (A2 row of the spend ledger + one sentence under Series A). If verdict is `not fixed`, add: "Task 7 dropped per spec (B5 conditional)."
- [ ] **Step 5: Commit** — explicit paths.

### Task 3: B1 — the resume echo can no longer re-fail a survived run

**Files:**
- Modify: `apps/orchestrator/src/pump.ts` (emit payload at :640 and :802; seed logic near :514)
- Test: `apps/orchestrator/test/integration/pump.test.ts` (the M18 Task 6 describe block at :1429)

**Interfaces:**
- Consumes: `matrixDeniedToolUseIds` (`pump.ts:514`), the two collection sites (`:637` Cursor with `event.toolUseId` in hand; `:816` Claude via `lastToolUseId`), the exclusion at `:970-971`, `PumpRunInput.resumed`.
- Produces: `run.tool_denied` payload gains `toolUseId: string | null`; on `resumed: true`, `pumpRun` seeds `matrixDeniedToolUseIds` from the run's own prior `run.tool_denied` events. Consumer of the new payload key: the seed query itself (same task) — the trace-to-consumer rule is satisfied in-task.

- [ ] **Step 1: Write the failing test** in the M18 Task 6 describe block. Shape: a RESUMED pump (`resumed: true`) whose event stream contains NO fresh denial but whose terminal outcome echoes an old matrix-denied id (`deniedToolUseIds: ['toolu_old_matrix']`); seed the DB first with a prior `run.tool_denied` event for this run carrying `payload: { tool: 'Bash', capability: 'run tests', toolUseId: 'toolu_old_matrix' }` (use the test file's existing seed/append helpers). Assert: run concludes `succeeded`, no new `run.failed`, no `guardrail.tripped`.
- [ ] **Step 2: Run it** — expect FAIL (run concludes `failed` because the fresh set is empty).
- [ ] **Step 3: Implement.** (a) Add `toolUseId` to both emit sites: `:640` → `await emit('run.tool_denied', 'agent', { tool: parsed.tool, capability: parsed.capability, toolUseId: event.toolUseId })`; `:802` → same with `toolUseId: lastToolUseId` (the add at `:816` already guards null — emit `toolUseId: lastToolUseId` which may be `null`, and only `.add()` when non-null, unchanged). (b) After the set's declaration, seed on resume:
  ```ts
  if (input.resumed) {
    // A prior pump on this run confirmed these ids as matrix denies (it emitted run.tool_denied
    // for each). The resumed CLI's terminal permission_denials can echo them (the session
    // accumulates), and a fresh empty set would count an already-survived denial as a failure.
    const prior = await prisma.executionEvent.findMany({
      where: { runId, type: 'run_tool_denied' },
      select: { payload: true },
    })
    for (const row of prior) {
      const id = (row.payload as { toolUseId?: unknown }).toolUseId
      if (typeof id === 'string') matrixDeniedToolUseIds.add(id)
    }
  }
  ```
  (Verify the Prisma enum member name for `run.tool_denied` — schema maps dots to underscores, expect `run_tool_denied`; read `schema.prisma` before writing.)
- [ ] **Step 4: Run the new test (PASS) and the whole file** — `npx vitest run apps/orchestrator/test/integration/pump.test.ts`. Existing tests asserting the old 2-key payload may need the third key added to their expectations — update them; the payload grows, nothing else changes.
- [ ] **Step 5: Apply Task 1's findings.** If A1's capture showed the terminal echo does or doesn't accumulate across resume, say so in the seed's comment (cite the fixture). If A1 contradicted the association assumption entirely, STOP and re-plan this task with the operator.
- [ ] **Step 6: `npm test`, census, commit.**

### Task 4: B2 — the id association checks the tool name it already knows

**Files:**
- Modify: `apps/orchestrator/src/pump.ts` (`:589` area and the `tool_denied` case `:800-818`)
- Test: `apps/orchestrator/test/integration/pump.test.ts`

**Interfaces:**
- Consumes: `lastToolUseId` (assigned at `:589` in `case 'tool_call'`), `GateOutcome.tool_denied.tool` (the vendor tool name parsed from the deny reason — `gate.ts:70`).
- Produces: `lastToolUse: { id: string; name: string } | null` replacing the bare id; the add at `:816` becomes conditional on `lastToolUse.name === gateOutcome.tool`.

- [ ] **Step 1: Write the failing test.** Stream: `tool_call` for tool `Read` (id `toolu_r1`), then a `hook_denied` whose reason parses to tool `Bash` (an adjacency mismatch — the deny belongs to some other call the pump never saw as the last one); terminal outcome echoes `deniedToolUseIds: ['toolu_r1']`. Assert: `run.tool_denied` is still emitted (the deny is real), but `toolu_r1` is NOT excluded — the run concludes `failed` (fail-safe direction: a mismatched association must not launder an id out of the failure check). Also assert the emitted `run.tool_denied` payload carries `toolUseId: null` on mismatch.
- [ ] **Step 2: Run — expect FAIL** (today the bare `lastToolUseId` is added regardless).
- [ ] **Step 3: Implement.** Track `let lastToolUse: { readonly id: string; readonly name: string } | null = null`, assigned in `case 'tool_call'` from the event's id and tool name; in the `tool_denied` case: `const associated = lastToolUse !== null && lastToolUse.name === gateOutcome.tool ? lastToolUse.id : null`, emit `toolUseId: associated`, add to the set only when non-null. Update the `:809-815` comment: the association now requires the name match the deny reason itself carries.
- [ ] **Step 4: Run the file; the Task 3 test and M18 tests must still pass** (the fixture's happy path has matching names, so nothing else moves).
- [ ] **Step 5: `npm test`, census, commit.**

### Task 5: B3 — the Cursor malformed-reason test that was never written

**Files:**
- Test: `apps/orchestrator/test/integration/pump.test.ts` (test-only task)

**Interfaces:**
- Consumes: the Claude-side sibling at `:1569` (`'pauses, does not tool_deny, on a hook_denied reason that only starts with the matrix prefix but fails to parse …'`) as the template; the Cursor happy-path at `:1515`; `PERMISSION_DENY_REASON_PREFIX` from `@ai-team-os/providers`.

- [ ] **Step 1: Write the test.** Cursor-shaped event `{ kind: 'permission_denied', toolName: 'shell', toolUseId: 'c9', reason: "permission matrix denies but this does not parse" }` (starts with the prefix, fails `parsePermissionDenyReason` — check `pump.ts:630-647`: prefix check passes, parse returns null, falls through to the ordinary path). Assert: NO `run.tool_denied`; `c9` lands in `denied`; one `guardrail.tripped` with `guardrail: 'permission_mode'`; and with a terminal echo of `c9` the run concludes per the ordinary pause/denial path — mirror the assertions of the `:1569` sibling adapted to Cursor's routing.
- [ ] **Step 2: Run — this should PASS immediately** (the fall-through already exists at `:638-646`). This test is a pin, not a fix: if it FAILS, the fall-through is broken — stop and investigate before any change.
- [ ] **Step 3: `npm test`, commit.**

### Task 6: B4 — the self-policing threat note

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-m13-runtime-hardening-design.md` (§7.1, beside the gate-inside-worktree note at :256-260)
- Modify: `scripts/lib/permissions.sh` (header comment)

- [ ] **Step 1: Write the spec note** in §7.1's limitation list:
  ```
  - **New limitation, stated (M19):** `permissions.json` lives in the run's own runDir
    (`<repo>/.aiteamos/runs/<runId>/`), which the child process can write. A run that edits or
    deletes its own permissions file disarms the matrix for its remaining tool calls — the same
    self-policing boundary as Cursor's in-worktree `.cursor/hooks.json` above, on both providers.
    The gates fail closed only on a MALFORMED file (exit 2); an absent file is allow-by-design
    (`scripts/lib/permissions.sh:87`), so deletion is the quiet path. Enforcement v1 is a
    guardrail against an honest agent's overreach, not a sandbox against an adversarial one.
  ```
- [ ] **Step 2: Add two sentences to `permissions.sh`'s header** pointing at that spec section by path+section, stating the same fact where the implementer will read it.
- [ ] **Step 3: Commit** (docs-only; no test cycle).

### Task 7: B5 (CONDITIONAL — runs only if Task 2's verdict is `fixed`)

**Files:**
- Modify: `packages/control/src/permission.ts` (`CAPABILITY_TOOLS` cursor columns, :33-46)
- Modify: `scripts/lib/permissions.sh` (:30-36 caveat block)
- Modify: `docs/superpowers/specs/2026-08-31-m18-skill-and-teeth-design.md` (:79-82 caveat — mark superseded with the A2 date/version)
- Test: `packages/control/test/integration/permission.test.ts`

If Task 2 says `not fixed`: mark this task dropped in the plan checklist and move on — the spec says dropped, not deferred.

- [ ] **Step 1: Failing test** — `resolveDenyList` maps the measured-truthful Cursor vocabulary (whatever A2 recorded — write the test from the A2 README section's measured names, not from guesses).
- [ ] **Step 2–4: Implement the vocabulary change, update the two caveat blocks to cite A2's evidence, run `npm test`, commit.**

### Task 8: C1 — the partial index the skill queries were promised

**Files:**
- Create: `packages/db/prisma/migrations/20260901120000_m19_skill_calls_partial_index/migration.sql`
- Modify: `docs/superpowers/specs/2026-09-01-m19-measure-and-harden-design.md` (EXPLAIN evidence note)

**Interfaces:**
- Consumes: the two queries in `apps/web/src/server/skillGraph.ts:59-65` (groupBy) and `:80-84` (findMany), both filtering `workspaceId + type + payload->name='Skill'` (+ `runId`).
- Produces: a partial index those queries' plans actually use — proven, not assumed.

- [ ] **Step 1: Capture the SQL Prisma actually emits.** Run the two queries once with Prisma query logging (`new PrismaClient({ log: ['query'] })` in a scratch script, or `DEBUG="prisma:query"`) against the dev DB and copy the emitted WHERE clauses verbatim into the task notes. The index predicate must match the emitted operator form (`payload->>'name'` vs `payload#>>'{name}'` are different expressions to the planner — matching the wrong one produces a dead index).
- [ ] **Step 2: `EXPLAIN ANALYZE` before.** Run the emitted SQL (with a real workspaceId) through `psql` `EXPLAIN ANALYZE`; save the plan text.
- [ ] **Step 3: Write the migration** (house style: prose header + `IF NOT EXISTS`; enum literal is the DB value `'run.tool_call'`):
  ```sql
  -- M19 C1: skillGraph.ts's two queries (groupBy at :59, findMany at :80) filter every
  -- ExecutionEvent row of a workspace on an un-indexed JSON path. This partial index carries
  -- exactly those rows. SQL-only: Prisma's schema language cannot express a partial/expression
  -- index, so schema.prisma has no counterpart (known drift, stated here).
  -- The predicate's expression form matches Prisma's emitted SQL verbatim (Task 8 Step 1) —
  -- a cosmetically different expression is invisible to the planner.
  CREATE INDEX IF NOT EXISTS "ExecutionEvent_skill_calls_idx"
  ON "ExecutionEvent" ("workspaceId", "runId", "seq")
  WHERE "type" = 'run.tool_call' AND <the verbatim emitted expression> = 'Skill';
  ```
- [ ] **Step 4: Migrate the TEST db** (`node scripts/migrate-test.mjs`) and the dev db (`npm run db:migrate` — this task's index is additive and safe; the gate re-checks it exists).
- [ ] **Step 5: `EXPLAIN ANALYZE` after** — the plan must show the index. If the planner ignores it (small-table seqscan), force with `SET enable_seqscan = off` once to prove usability, note both plans. Paste before/after into the spec under a short "C1 evidence" line.
- [ ] **Step 6: `npm test` (the migration must not break enum parity tests), commit.**

### Task 9: C3 — cables as thick as their traffic

**Files:**
- Modify: `apps/web/src/components/graph/CableEdge.tsx` (`CableEdgeData` :8-12, width logic :92-111)
- Modify: `apps/web/src/components/graph/SkillNodes.tsx` (aggregate builder :173-183)
- Modify: `apps/web/src/server/skillGraph.ts` (delete the :24 "computed but not yet rendered" comment — the ruling closes)
- Test: `apps/web/test/graph-skill.test.tsx`

**Interfaces:**
- Consumes: `SkillGraph.edges[].count`; `CableEdgeData { tone, active }`; the constraint that `coreWidth` must be written to BOTH the `strokeWidth` attribute and the inline `style` (React Flow's own `.react-flow__edge-path { stroke-width: 1 }` outranks the attribute — documented at CableEdge :102-111).
- Produces: `CableEdgeData` gains `readonly weight?: number` (the raw count; absent = today's widths). Width map: `coreWidth = selected ? '2.5' : widthFor(weight, active)` where `widthFor` clamps `1.4 + 0.6 * (weight - 1)` to `[1.4, 3.8]` for active, and `3 + 0.5 * (weight - 1)` clamped to `[3, 4.5]` for inactive; a missing weight keeps the literals.

- [ ] **Step 1: Failing test** in `graph-skill.test.tsx`: render the aggregate skill graph with two edges, counts 1 and 4; select the two rendered cable core paths and assert their `stroke-width` inline styles differ, and that the count-4 edge is the wider one. (Follow the file's existing render/query patterns.)
- [ ] **Step 2: Run — FAIL** (all cables identical today).
- [ ] **Step 3: Implement.** SkillNodes aggregate builder passes `data: { tone: 'planning', active: false, weight: edge.count }` (chain/focus builder at :225-236 stays weightless — a chain edge is traversed once by construction). CableEdge: add the optional field + `widthFor`, apply to `coreStyle` AND the attribute; halo and dash overlay widths stay untouched (the signature look is the core's).
- [ ] **Step 4: Run test (PASS), then the graph test files** — `npx vitest run apps/web/test/graph-skill.test.tsx apps/web/test/tasks-components.test.tsx`.
- [ ] **Step 5: Delete the skillGraph.ts:24 ruling comment**, replacing with one line: "Rendered as cable thickness since M19 (C3)."
- [ ] **Step 6: `npm run web:build`, `npm test`, commit.**

### Task 10: C4 — eight inline fetch blocks onto sendControl

**Files:**
- Modify: `apps/web/src/components/SkillsClient.tsx` (:50-76), `CompanyManager.tsx` (:59-91, :200-221, :289-310), `ModelOverrideEditor.tsx` (:46-66), `TemplateCatalog.tsx` (:47-80), `AssignCompanyDialog.tsx` (:60-82), `PermissionMatrix.tsx` (:66 area)
- Modify: `apps/web/src/lib/postControl.ts` (doc comment only — the backlog paragraph naming these components comes out)
- Test: existing — `apps/web/test/settings-page.test.tsx`, `agents-page.test.tsx`, `skills-page.test.tsx` (no new tests; the contract is "behavior unchanged")

**Interfaces:**
- Consumes: `sendControl(url, { method, body? }): Promise<string | null>`; `postControl(url, body?)`.
- Produces: nothing new — every block becomes:
  ```ts
  setPending(true)
  setErrorText(null)
  const error = await sendControl(url, { method: 'POST', body })
  if (error === null) { router.refresh(); /* per-site resets */ } else { setErrorText(error) }
  setPending(false)
  ```

Per-site notes (each site keeps its exact resets and `data-testid`s):
- SkillsClient: `sendControl('/api/skills/assign', { method, body: { agentId, skillId } })`; DELETE the stale doc comment at :50-55 ("postControl only speaks POST" predates M18 Task 9) and say sendControl carries both verbs now.
- ModelOverrideEditor: the typed body needs widening at the call: `body: body as unknown as Record<string, unknown>` is BANNED — instead spread: `body: { ...body }` (a fresh object literal satisfies `Record<string, unknown>`).
- CompanyManager ×3: conditional-spread bodies pass through unchanged.
- PermissionMatrix: same treatment; it was outside the spec's named five — note in the commit message that it was found in recon and included (the spec's "record, don't chase" applied to unknowns; this one is known).

- [ ] **Step 1: Migrate all eight blocks** (mechanical; one pattern above).
- [ ] **Step 2: Run the three test files** — they stub `global.fetch`, and `sendControl` still calls `fetch` with the same method/headers/body, so they must pass UNCHANGED. A failing assertion here means the migration changed an observable (headers on body-less requests, error text) — fix the migration, not the test.
- [ ] **Step 3: Update `postControl.ts`'s doc comment** — the "still carry their own inline copies" paragraph now lists nobody; say the repo-wide guarantee holds as of M19.
- [ ] **Step 4: `npm run web:build`, `npm test`, census, commit.**

### Task 11: C6 — CompanyManager becomes three files

**Files:**
- Create: `apps/web/src/components/company/TeamBlock.tsx` (from :40-182 + `MemberRow` :25-36 + the two table constants)
- Create: `apps/web/src/components/company/CompanyDetail.tsx` (from :186-264)
- Modify: `apps/web/src/components/CompanyManager.tsx` (keeps `CompanyRow` interface, the top-level component :273-375; imports the two new files)
- Test: `apps/web/test/settings-page.test.tsx` (must pass UNCHANGED — it selects by data-testid)

**Interfaces:**
- Produces: `TeamBlock` and `CompanyDetail` as named exports with their current prop shapes (read them off the current function signatures when extracting — copy verbatim, export, fix imports). `CompanyRow` stays exported from `CompanyManager.tsx` (it is imported elsewhere — check with grep before moving anything).

- [ ] **Step 1: Extract** the two components file-by-file, imports adjusted, zero body edits. Run after EACH extraction: `npx vitest run apps/web/test/settings-page.test.tsx` — green after each move.
- [ ] **Step 2: Grep for external importers** of anything that moved (`grep -rn "from './CompanyManager" apps/web/src` and `from '../components/CompanyManager`) — `settings-page.test.tsx` imports `CompanyManager` itself, which stays; nothing else should break.
- [ ] **Step 3: `npm run web:build`, `npm test`, commit.** (Do this task AFTER Task 10 so the extracted files carry the migrated submit blocks, not the inline ones.)

### Task 12: C5 — listWorkers grouped in SQL, behind the equivalence test

**Files:**
- Modify: `apps/web/src/server/org.ts` (`listWorkers` :414-462)
- Create: `apps/web/test/integration/org-workers-groups.test.ts` (pattern: `org-spend-groups.test.ts`)

**Interfaces:**
- Consumes: `prisma.agentRun.groupBy` with `by: ['agentId', 'provider', 'status']`, `_sum: { costUsd, tokensIn, tokensOut }`, `_count: { _all: true, costUsd: true, tokensIn: true, tokensOut: true }`; `spendOfGroups` (org.ts:53, module-private — reuse it); `NON_TERMINAL_RUN_STATUSES`.
- Produces: same `WorkerRow[]`. Three derived facts preserved exactly:
  - `costUsd`/`unmeasuredRuns`: per-agent groups through `spendOfGroups` (same `SpendGroup` construction as listProjects :100-148).
  - `tokens`: `null` iff every group of the agent has `_count.tokensIn === 0 && _count.tokensOut === 0`; else `Σ(_sum.tokensIn ?? 0) + Σ(_sum.tokensOut ?? 0)` (equal to today's filtered sum — unreporting rows contribute zero).
  - `provider` (live): a SEPARATE bounded query — `prisma.agentRun.findMany({ where: { agentId: { in: ids }, status: { in: NON_TERMINAL_RUN_STATUSES } }, select: { agentId, provider, startedAt }, orderBy: { startedAt: 'desc' } })`, first row per agent (in-flight runs are few by construction; this preserves today's newest-first pick).

- [ ] **Step 1: Write the equivalence test** (the `org-spend-groups.test.ts` method verbatim — its header comment states it): seed per rule branch — an agent with (a) an unmeasured terminal run, (b) an in-flight run (provider set), (c) a pre-M12 row (cost, null provider), (d) a measured-zero run, (e) an ordinary measured run with tokens, (f) an agent with ONLY token-less runs (tokens must be `null`), (g) an agent with TWO non-terminal runs at different `startedAt` (liveProvider must be the newer). Expected values computed BY HAND in the test.
- [ ] **Step 2: Run it against the CURRENT implementation — must PASS** (this is the equivalence claim; a fail means the hand-computation is wrong, fix the test).
- [ ] **Step 3: Rewrite `listWorkers`** per the Interfaces block; delete the whole-history `findMany` at :428-432.
- [ ] **Step 4: Run the test again — must pass UNCHANGED. Run `server-org.test.ts` too.**
- [ ] **Step 5: `npm run web:build`, `npm test`, census, commit.**

### Task 13: C7 — the four TASK_STATUS tables become one derivation

**Files:**
- Modify: `apps/web/src/components/ui/StatusPill.tsx` (add `TONE_FLASH_COLOR`)
- Modify: `apps/web/src/lib/tones.ts` (add `toneForTaskStatus`)
- Modify: `apps/web/src/components/TaskCard.tsx` (:8-85 — tables become derivations)
- Test: `apps/web/test/tones.test.ts` + whichever component tests pin the old colours (find by running them)

**Interfaces:**
- Produces:
  - `StatusPill.tsx`: `export const TONE_FLASH_COLOR: Record<StatusTone, string>` — `working: 'var(--color-tone-working)'`, … all eight, mirroring `TONE_DOT`'s shape.
  - `tones.ts`: `export function toneForTaskStatus(status: TaskStatus): StatusTone { return CARD_STATE_TONE[cardStateForTask(status)].tone }`.
  - `TaskCard.tsx`: the four exports keep their names and `Record<TaskStatus, string>` types (consumers untouched), but each is built by one loop over the twelve statuses through `toneForTaskStatus` into `TONE_DOT` / `TONE_BORDER` / `TONE_FLASH_COLOR` / `TONE_TEXT`. All referenced class strings stay literal inside StatusPill's tables — the Tailwind literal-scan constraint (TaskCard :36-41's own warning) is satisfied because no class string is assembled.

**KNOWN BEHAVIOR CHANGE (deliberate, spec C7):** the derivation is not colour-preserving. `cardStateForTask` routes through board columns: `done` moves `tone-working`→`tone-done` (toward the handoff's green `#4ade80`), `merging` moves `paused`→its column state, `TASK_STATUS_TEXT.reviewing` loses its `paused` drift (the half M16 missed). Snapshot/class assertions that pinned old colours get updated to the derived values — each updated assertion cites this task in a one-line comment.

- [ ] **Step 1: Write the failing test** in `tones.test.ts`: `toneForTaskStatus('done')` is `'done'`; and in a new small block, assert `TASK_STATUS_DOT.done === TONE_DOT[toneForTaskStatus('done')]` for all twelve statuses across all four tables (totality check — this is the single-source guarantee).
- [ ] **Step 2: Run — FAIL** (`toneForTaskStatus` does not exist).
- [ ] **Step 3: Implement** the three files per Interfaces. Delete TaskCard's :8-41 comment block about the parked follow-up; replace with three lines saying the tables are now derived and where from.
- [ ] **Step 4: Run the full web test dir** — `npx vitest run apps/web/test/` — update colour-pinning assertions per the KNOWN CHANGE note.
- [ ] **Step 5: Visual sanity**: `npm run web:build` must pass; note in the commit message which colours moved.
- [ ] **Step 6: `npm test`, commit.**

### Task 14: the gate, the typecheck step, and the milestone record

**Files:**
- Create: `scripts/gate-m19-measure-and-harden.mjs`
- Modify: `package.json` (register `gate:m19-measure-and-harden` after :36, `tsc --build && node --env-file=.env …` form)
- Modify: `docs/superpowers/specs/2026-09-01-m19-measure-and-harden-design.md` (Errata section + final ledger)
- Modify: memory file `m12-backlog-from-m11.md` is NOT in-repo — the project-memory update happens at merge time, not in this task.

**Interfaces:**
- Consumes: the `gate-m18-skill-and-teeth.mjs` shape (single try, no catch, `exitCode`, `fail()` diagnostics, preflight refusals, zero-spend outer discipline).

Gate checks (all zero-spend; spec's five):
1. **Typecheck step (C2):** run `npm run --silent typecheck` inside the gate; then PROVE the step bites — write a deliberately broken `.ts` into a temp-copied tsconfig target? NO — never plant a red in the working tree. Instead: run `npx tsc -p apps/web/tsconfig.test.json --noEmit` on a temp COPY of one test file with an injected type error, in a scratch dir with its own minimal tsconfig extending the repo's — the probe proves the command form catches reds without touching the tree. Print both results.
2. **Fixture provenance (A1):** assert `packages/providers/test/fixtures/README.md` no longer contains "hand-authored" for `permission-matrix-deny`, and DOES contain a version string and a `total_cost_usd`-derived cost for it; assert the fixture's terminal line parses and carries a non-empty `permission_denials`.
3. **Thickness responds (C3):** in the real browser (m18's stage-2 machinery — seed two runs whose aggregate produces counts 1 and ≥3), read the two cable core paths' computed `stroke-width` and assert they differ in the right direction.
4. **Equivalence tests present and green (C5):** run `npx vitest run apps/web/test/integration/org-workers-groups.test.ts` as a child and require exit 0.
5. **Index exists (C1):** one SELECT against `pg_indexes` for `ExecutionEvent_skill_calls_idx`; REFUSE with the named migrate command if absent (m18's refusal pattern).
6. **Ledger:** parse the spec's spend table; refuse if an "Actual" cell is still the placeholder or the sum exceeds $2.00.

- [ ] **Step 1: Write the gate** per the checks above, m18's helper set cribbed (`makeRepo`, `findFreePort`, `waitUntil`, `gotoReliably`, `fail`, preflight, FK-ordered cleanup in `finally`).
- [ ] **Step 2: Register it in package.json.**
- [ ] **Step 3: Run it 3× consecutively** — all green, no manual settling (the M18 lesson: a gate that settles a page by hand hides the defect it settles).
- [ ] **Step 4: Write the spec's Errata section** — A1/A2 outcomes, findings routed, anything dropped (Task 7?), the C7 colour movements, final ledger.
- [ ] **Step 5: `npm test` (full), census, commit.**

---

## Self-review notes (written at planning time)

- Spec coverage: A1→T1, A2→T2, B1→T3, B2→T4, B3→T5, B4→T6, B5→T7 (conditional), C1→T8, C2→T14 (folded into the gate per spec's gate section), C3→T9, C4→T10 (+PermissionMatrix, found in recon), C5→T12, C6→T11, C7→T13, gate→T14. No gaps.
- Task 10 before Task 11 (the split extracts migrated code). Task 1 before Tasks 3–5 (findings flow). Task 2 before Task 7 (verdict). Tasks 8, 9, 12, 13 independent.
- The B1 seed's enum name (`run_tool_denied`) is flagged for verification in-task rather than asserted here — the recon did not read that schema line.
