# M18 Skill Chain & Teeth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The permission matrix enforces at the gates (denials visible end to end), the `deniedToolUseIds` field gets its reader, the Activity chip measures, three M17 leftovers close, and the Graph's Skill-chain tab unlocks with aggregate + per-run-focus views.

**Architecture:** Series A "teeth": a resolved deny-list file written per run beside the pause flag; both gate scripts grow one node-call verdict; a matrix-reasoned deny is discriminated from a pause deny by a shared reason prefix and flows to a new non-terminal `run.tool_denied` event (run continues). Series B: a sibling `buildSkillGraph` DTO reads ordered Skill calls from the event log (new `(runId, seq)` index) and a `SkillMode` canvas renders aggregate and focus views on the house graph kit. Zero-spend gate.

**Tech Stack:** TypeScript monorepo, Vitest 3.2.7, Prisma + Postgres (two additive migrations), Next.js + React Flow + elkjs, bash gate scripts + node one-liners, playwright-core gate.

**Spec:** `docs/superpowers/specs/2026-08-31-m18-skill-and-teeth-design.md` (as amended by `6d074b0` — §2's measured mapping/discrimination/resume facts and §6's verified data shapes are binding; read it before any task).

## Global Constraints

- Branch: `feature/m18-skill-and-teeth`, cut from `main` (at `6d074b0` or later). Every task commits there.
- One vitest run at a time; no orchestrator daemon during tests (`pgrep -f 'cli.js daemon'` SELF-MATCHES its wrapper shell — confirm any hit via `ps -p <pid>` / `/proc/<pid>/cmdline` before believing it).
- `npm test` = `tsc --build && vitest run`. Root `tsc --build` does NOT cover apps/web tests — use `npx tsc -p apps/web/tsconfig.test.json --noEmit` for web fails-first/type evidence.
- Any task touching `apps/web` gates on `npm run web:build` before commit; never while a `next dev` runs.
- Migrations: additive only, exactly the two the spec names; migration dirs follow `<YYYYMMDDHHMMSS>_m18_<snake_desc>` with round synthetic timestamps (M13 precedent); after schema edits run the repo's migrate flow for the TEST db (`node scripts/migrate-test.mjs` — read it first) and note that the DEV db migration happens at gate/merge time.
- `bash scripts/census-runtime.sh` must exit 0 at every task's commit (Task 2 adds a row to it).
- Characterization/flake bar carries over from M17: a retry that goes green is never evidence; timing margins get measured, not guessed.
- The M17 lesson is binding: every new field/file/env var/event type must be traced to its CONSUMER within its own task (or the task that the plan explicitly pairs it with).
- Commit messages: lower-case conventional prefix + a sentence stating what is true after the commit, ending with exactly:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Nn4QJFeQ5fpCPy9tB4NSv7
```

---

### Task 1: Foundations — two migrations, the deny-reason prefix, and the capability→tool map

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (EventType member + ExecutionEvent index), `packages/domain/src/events/schema.ts`, `packages/db/src/enums.ts`, `packages/providers/src/gate.ts` (prefix constant), `packages/control/src/permission.ts` (mapping + resolver)
- Create: `packages/db/prisma/migrations/20260831190000_m18_tool_denied_event/migration.sql`, `packages/db/prisma/migrations/20260831190100_m18_execution_event_run_seq_index/migration.sql`
- Create: `packages/control/test/permission-mapping.test.ts`
- Modify: `apps/web/src/components/activity/cards.tsx` (card registry ~:520), `apps/web/src/lib/activityFilters.ts` (~:46-53)

**Interfaces:**
- Produces: EventType `run_tool_denied @map("run.tool_denied")`; domain zod member with payload `{ tool: string, capability: string }`; `PERMISSION_DENY_REASON_PREFIX = 'permission matrix denies'` exported from `packages/providers/src/gate.ts`; `resolveDenyList(rows: readonly {tool: string, mode: 'allow'|'deny'}[], provider: 'claude_code'|'cursor'): readonly { tool: string, capability: string }[]` exported from `packages/control/src/permission.ts`. Tasks 2–6 consume all of these.

- [ ] **Step 1: The enum + index migrations.** In schema.prisma add to `EventType` (after `run_failed`):

```prisma
  run_tool_denied @map("run.tool_denied")
```

and to `model ExecutionEvent` an index `@@index([runId, seq])` (place beside its existing `@@index` lines; read the model first). Two migration files, following the M13 template (`20260829120000_m13_settings_changed_event/migration.sql`):

```sql
-- 20260831190000_m18_tool_denied_event/migration.sql
-- Additive enum value; safe on PG12+ as long as the new value is not used in the same transaction.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'run.tool_denied';
```

```sql
-- 20260831190100_m18_execution_event_run_seq_index/migration.sql
-- The (runId, seq) read path overview.ts:277-285 named as the deferred fix; M18's skill-chain DTO is its third consumer.
CREATE INDEX IF NOT EXISTS "ExecutionEvent_runId_seq_idx" ON "ExecutionEvent"("runId", "seq");
```

(Verify the exact index-name convention against an existing migration and mirror it.) Run the repo's test-db migrate flow and `npx prisma generate` per the repo's build (read package.json scripts).

- [ ] **Step 2: Domain event member.** In `packages/domain/src/events/schema.ts`, beside `run.tool_call` (:25-29):

```ts
  z.object({ ...envelope, type: z.literal('run.tool_denied'), payload: z.object({ tool: z.string(), capability: z.string() }) }),
```

And in `packages/db/src/enums.ts` `EVENT_TYPE_BY_DOMAIN_TYPE`: `'run.tool_denied': 'run_tool_denied',` — the `satisfies` there is load-bearing and fails the build if either side is missed.

- [ ] **Step 3: The prefix constant.** In `packages/providers/src/gate.ts`, above `classifyGateEvent`:

```ts
/**
 * Every deny the PERMISSION MATRIX issues begins with this exact string — it is how the stream
 * parsers tell a matrix refusal (the run continues) from a pause deny (the run stops). The
 * shell twin lives in scripts/lib/permissions.sh; packages/control's mapping test pins the two
 * spellings byte-equal, so neither can drift alone.
 */
export const PERMISSION_DENY_REASON_PREFIX = 'permission matrix denies'
```

- [ ] **Step 4: The mapping + resolver** in `packages/control/src/permission.ts`, beneath `PERMISSION_TOOLS` (read its docstring first — this task retires its "Not yet enforced at runtime" sentence):

```ts
/**
 * v1 capability→vendor-tool resolution (spec §2, measured 2026-08-31). Coarse by design:
 * the three shell-backed capabilities all deny the shell tool outright (command-string
 * inspection is out of scope), and 'read secrets' maps to nothing — it is a path predicate
 * no tool carries, stated as unenforced in the matrix UI. Unmapped tools always pass.
 */
const CAPABILITY_TOOLS: Record<string, { readonly claude_code: readonly string[]; readonly cursor: readonly string[] }> = {
  'repo read': { claude_code: ['Read'], cursor: ['read'] },
  'source write': { claude_code: ['Write', 'Edit', 'NotebookEdit'], cursor: ['edit'] },
  'run tests': { claude_code: ['Bash'], cursor: ['shell'] },
  'create branch': { claude_code: ['Bash'], cursor: ['shell'] },
  'deploy prod': { claude_code: ['Bash'], cursor: ['shell'] },
  'read secrets': { claude_code: [], cursor: [] },
}

/** The resolved deny list `permissions.json` carries: one entry per denied vendor tool, naming
 *  the (first) denied capability that put it there. Deny rows only — unset and allow pass. */
export function resolveDenyList(
  rows: readonly { readonly tool: string; readonly mode: 'allow' | 'deny' }[],
  provider: 'claude_code' | 'cursor',
): readonly { readonly tool: string; readonly capability: string }[] {
  const byTool = new Map<string, string>()
  for (const row of rows) {
    if (row.mode !== 'deny') continue
    for (const tool of CAPABILITY_TOOLS[row.tool]?.[provider] ?? []) {
      if (!byTool.has(tool)) byTool.set(tool, row.tool)
    }
  }
  return [...byTool.entries()].map(([tool, capability]) => ({ tool, capability }))
}
```

- [ ] **Step 5: Tests** (`packages/control/test/permission-mapping.test.ts`): every capability × both providers; overlap case (deny `run tests` + `deploy prod` → ONE Bash entry, first capability wins); allow/unset rows ignored; `read secrets` deny resolves empty; unknown capability string resolves empty (defensive); and the cross-language prefix pin:

```ts
import { readFileSync } from 'node:fs'
import { PERMISSION_DENY_REASON_PREFIX } from '@ai-team-os/providers'
it('the shell helper spells the deny prefix exactly as the TS constant', () => {
  const lib = readFileSync('scripts/lib/permissions.sh', 'utf8')
  expect(lib).toContain(PERMISSION_DENY_REASON_PREFIX)
})
```

Mark that last test `it.todo` UNTIL Task 2 lands the file, then Task 2's steps un-todo it (note this in both tasks' reports). Confirm `PERMISSION_DENY_REASON_PREFIX` is exported through the providers barrel (check `packages/providers/src/index.ts`).

- [ ] **Step 6: Activity card + filter for `run.tool_denied`** (the M17 trace-to-consumer rule — the event type ships with its renderer): add a card entry at `cards.tsx`'s registry (follow the adjacent `run.*` cards' shape; text like `` `${payload.tool} denied — ${payload.capability}` ``) and put the type in the run-ish filter bucket in `activityFilters.ts`. Extend the existing card/filter test files with one case each (find them by grepping the registry's test).

- [ ] **Step 7: Prove & commit**

```bash
npx tsc --build && npx vitest run packages/control/test/permission-mapping.test.ts && npx vitest run packages/domain/test packages/db 2>/dev/null; npx vitest run apps/web/test/feedSummary.test.ts; npm run web:build
git add -A && git commit -m "feat(m18): the denial event exists, the index exists, and six capability columns resolve to real tool names"
```

(Adjust the vitest paths to what exists; the suite-wide run happens at each task's end regardless: `npm test` green before commit.)

---

### Task 2: `scripts/lib/permissions.sh` — one node call answers allow-or-deny

**Files:**
- Create: `scripts/lib/permissions.sh`
- Modify: `scripts/census-runtime.sh` (one new shell row), `packages/control/test/permission-mapping.test.ts` (un-todo the prefix pin)
- Create: `packages/providers/test/permissions-lib.test.ts`

**Interfaces:**
- Consumes: `AITEAMOS_PERMISSIONS_FILE` env (set by Task 5's plumbing; absent = allow), the hook payload on stdin.
- Produces: sourced function `read_permission_verdict` — input: the captured payload string as `$1`; output contract mirroring `pause-flag.sh`'s (report-don't-print): `return 0` = DENY with out-params `PERMISSION_DENY_TOOL` and `PERMISSION_DENY_CAPABILITY` set; `return 1` = allow; `exit 2` = fail closed (unparseable payload while a permissions file is present, or present-but-unreadable/invalid file). Missing file / env unset → `return 1` (allow) — pre-M18 runs keep working. Tasks 3–4 consume it.

- [ ] **Step 1: Write the helper.** Mirror `pause-flag.sh`'s conventions exactly (caller sets `PAUSE_GATE_NAME`; stderr prefixed; node fed via STDIN never argv). One node invocation reads BOTH the payload and the file:

```bash
# scripts/lib/permissions.sh — sourced by both gates, never executed. The permission matrix's
# resolved deny list lives in the file AITEAMOS_PERMISSIONS_FILE points at
# ({"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}); this library answers
# "does this hook payload's tool appear on it". The library reports, the gate spells the deny
# (the two gates' output shapes differ) — pause-flag.sh's rule.
# Deny reasons the gates build from these out-params MUST begin with the exact prefix
# 'permission matrix denies' — packages/control/test/permission-mapping.test.ts pins this
# spelling against the TS constant PERMISSION_DENY_REASON_PREFIX.

PERMISSION_DENY_TOOL=''
PERMISSION_DENY_CAPABILITY=''

# read_permission_verdict "$payload"
#   return 0 -> deny (out-params set) ; return 1 -> allow ; exit 2 -> fail closed
read_permission_verdict() {
  PERMISSION_DENY_TOOL=''
  PERMISSION_DENY_CAPABILITY=''
  if [[ -z "${AITEAMOS_PERMISSIONS_FILE:-}" || ! -e "${AITEAMOS_PERMISSIONS_FILE:-/nonexistent}" ]]; then
    return 1  # no matrix in play (pre-M18 runs, rehearsals): allow
  fi
  local verdict
  verdict=$(printf '%s' "$1" | AITEAMOS_PERMISSIONS_FILE="$AITEAMOS_PERMISSIONS_FILE" node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      let payload, file;
      try { payload = JSON.parse(raw); } catch { process.stdout.write("BADPAYLOAD"); return; }
      try { file = JSON.parse(require("node:fs").readFileSync(process.env.AITEAMOS_PERMISSIONS_FILE, "utf8")); } catch { process.stdout.write("BADFILE"); return; }
      const tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
      const deny = Array.isArray(file.deny) ? file.deny : null;
      if (deny === null) { process.stdout.write("BADFILE"); return; }
      if (tool === null) { process.stdout.write("ALLOW"); return; }
      const hit = deny.find((d) => d && d.tool === tool && typeof d.capability === "string");
      process.stdout.write(hit ? "DENY\t" + hit.tool + "\t" + hit.capability : "ALLOW");
    });
  ')
  local status=$?
  if [[ $status -ne 0 ]]; then
    printf '%s: permission verdict helper failed (node exit %s)\n' "$PAUSE_GATE_NAME" "$status" >&2
    exit 2
  fi
  case "$verdict" in
    ALLOW) return 1 ;;
    DENY$'\t'*)
      PERMISSION_DENY_TOOL=$(printf '%s' "$verdict" | cut -f2)
      PERMISSION_DENY_CAPABILITY=$(printf '%s' "$verdict" | cut -f3)
      return 0 ;;
    BADPAYLOAD)
      printf '%s: hook payload did not parse as JSON while a permissions file is armed\n' "$PAUSE_GATE_NAME" >&2
      exit 2 ;;
    BADFILE)
      printf '%s: permissions file unreadable or malformed: %s\n' "$PAUSE_GATE_NAME" "$AITEAMOS_PERMISSIONS_FILE" >&2
      exit 2 ;;
    *)
      printf '%s: permission verdict helper produced an unrecognized answer\n' "$PAUSE_GATE_NAME" >&2
      exit 2 ;;
  esac
}
```

Design notes to preserve in comments: a payload with NO `tool_name` (Claude `Stop`/`SessionStart` hooks, odd shapes) allows — only a payload that is not JSON at all fails closed. Verify the payload key against real fixture payloads before landing (Claude hook stdin carries `tool_name`; Cursor's differs — Task 4 handles the Cursor payload key, extend the node one-liner there if Cursor spells it differently, keeping ONE helper).

- [ ] **Step 2: Census row** after the `json_string` block in `census-runtime.sh`, same shape:

```bash
perm_defs=$(grep -rln '^read_permission_verdict()' scripts | sort | tr '\n' ' ' | sed 's/ $//')
if [[ "$perm_defs" != "scripts/lib/permissions.sh" ]]; then
  echo "CENSUS FAIL: read_permission_verdict() defined in: ${perm_defs:-<nowhere>} (expected only scripts/lib/permissions.sh)" >&2
  fail=1
fi
```

- [ ] **Step 3: Direct tests** (`packages/providers/test/permissions-lib.test.ts`, unit project): a bash driver that sources the lib with `PAUSE_GATE_NAME=test-gate` and echoes the verdict/out-params (crib the spawn pattern from `pause-gate.test.ts`). Cases: deny hit (tool+capability come back); allow (tool not listed); no `tool_name` key → allow; env unset → allow; file missing → allow; file present but garbage → exit 2; payload garbage with file armed → exit 2; empty deny list → allow.

- [ ] **Step 4: Un-todo Task 1's prefix pin** (the file now exists and contains the literal).

- [ ] **Step 5: Prove & commit** — `npx vitest run packages/providers/test/permissions-lib.test.ts packages/control/test/permission-mapping.test.ts && bash scripts/census-runtime.sh && npm test`, then:

```bash
git add scripts/lib/permissions.sh scripts/census-runtime.sh packages/providers/test/permissions-lib.test.ts packages/control/test/permission-mapping.test.ts
git commit -m "feat(gate): one shared verdict — the deny list is read in a single node call, and the census knows its name"
```

---

### Task 3: The Claude gate learns to refuse a tool

**Files:**
- Modify: `scripts/pause-gate.sh` (:81 stdin drain → capture; new branch between the pause `esac` and the final allow), `packages/providers/test/pause-gate.test.ts`

**Interfaces:**
- Consumes: `read_permission_verdict` (Task 2), `AITEAMOS_PERMISSIONS_FILE`.
- Produces: on a matrix hit, the existing `deny()` emits the existing Claude JSON shape with reason `permission matrix denies '<capability>' (<tool>) for this agent`. Pause deny (any pause status) takes precedence and is byte-identical to today.

- [ ] **Step 1:** Source `lib/permissions.sh` beside the existing `lib/pause-flag.sh` line (same bootstrap dir; same `|| fail` posture). Replace :81's `cat > /dev/null` with `hook_payload=$(cat)` (keep a comment: the payload is only parsed when a permissions file is armed — Task 2's helper returns allow instantly otherwise). After the pause `esac` (status-1 fall-through) and before `exit 0`:

```bash
if read_permission_verdict "$hook_payload"; then
  deny "permission matrix denies '${PERMISSION_DENY_CAPABILITY}' (${PERMISSION_DENY_TOOL}) for this agent"
fi
```

- [ ] **Step 2: Tests** — extend `pause-gate.test.ts` (it already spawns the gate with env + stdin): matrix deny (payload `{"tool_name":"Bash",...}` + file denying Bash for 'run tests' → stdout is the Claude deny JSON whose `permissionDecisionReason` starts with the prefix and names both capability and tool); allow (tool absent from list → silent exit 0); pause WINS (flag armed + matrix file armed → the pause reason, not the matrix reason); no permissions env → today's behaviour byte-identical (run the file's existing tests unchanged); garbage payload with file armed → exit 2 stderr names the gate.

- [ ] **Step 3: Prove & commit** — `npx vitest run packages/providers/test/pause-gate.test.ts && npm test`, commit `feat(gate): the claude gate reads the matrix — a denied tool is refused by name, and pause still speaks first`.

---

### Task 4: The Cursor gate too

**Files:**
- Modify: `scripts/cursor-shell-gate.sh` (:165 drain → capture; branch between pause `esac` and the final `allow`), `scripts/lib/permissions.sh` (only if Cursor's payload spells the tool key differently — keep ONE helper), `packages/providers/test/cursor-shell-gate.test.ts`

**Interfaces:**
- Same as Task 3 but the deny goes out as Cursor's `{"permission":"deny","user_message":<reason>}` and the fall-through remains an EXPLICIT `allow` (silence is a Cursor hook failure).

- [ ] **Step 1:** Read the measured Cursor payload shapes first (the gate's own header :11-14 and `fixtures/cursor/gate/run-1-hook.log`) — determine the tool-identity key for both `beforeShellExecution` and `preToolUse` payloads. If it isn't `tool_name`, extend the helper's node one-liner to try the measured key(s) in order, with a comment citing the fixture. Then capture stdin and add the branch mirroring Task 3, denying via the Cursor `deny()`.
- [ ] **Step 2:** The known caveat goes in a comment at the branch: Cursor's `preToolUse` tool identity is measured-untrustworthy for write/read discrimination (:11-14) — shell enforcement via `beforeShellExecution` is the reliable half; this is spec §2's stated v1 limitation, not a bug to fix here.
- [ ] **Step 3: Tests** — mirror Task 3's matrix in `cursor-shell-gate.test.ts` (deny JSON has `user_message` starting with the prefix; allow is the explicit `{"permission":"allow"}`; pause wins; no-env unchanged; garbage → exit 2).
- [ ] **Step 4: Prove & commit** — targeted file + `npm test`; commit `feat(gate): the cursor gate reads the same matrix through the same helper`.

---

### Task 5: The orchestrator writes the file; the child knows its path

**Files:**
- Modify: `packages/control/src/paths.ts` (or sibling — a `permissionsFilePathFor(runDir)` helper) and a new `writePermissionsFile` in `packages/control/src/permission.ts`; `apps/orchestrator/src/tick.ts` (~:459 include, ~:581 write+pass), `planning.ts` (~:222, ~:322), `review.ts` (~:240, ~:357), `apps/orchestrator/src/resume.ts` (re-derive + rewrite before `adapter.resume`), `packages/providers/src/runtime/process.ts` (`buildChildEnv`), both adapters' `StartInput`/resume paths (claude/adapter.ts:49/282/535-537, cursor/adapter.ts:171/237-239), `packages/providers/src/types.ts` if `StartRunInput` lives there
- Test: extend `packages/providers/test/adapter-start.test.ts` + `cursor-adapter.test.ts` (env assertion via the `env-echo` fake fixture), `apps/orchestrator/test/integration/` dispatch test (file exists with resolved content after a dispatch), resume test (file rewritten)

**Interfaces:**
- Consumes: `resolveDenyList` (Task 1).
- Produces: `permissions.json` in `runDir` at every start AND resume (`{"version":1,"deny":[...]}`; empty deny written when nothing denied); `buildChildEnv` gains required `permissionsFilePath` → `AITEAMOS_PERMISSIONS_FILE`; `StartInput` shapes gain the field (required — all four call sites must pass it).

- [ ] **Step 1:** `writePermissionsFile(runDir: string, denyList: readonly {tool, capability}[]): string` — writes the JSON (pretty, version 1), returns the path (`join(runDir, 'permissions.json')`). Doc comment: written at start and REWRITTEN at resume (fresh snapshot; matrix edits do not reach runs in flight between those points — spec §2 limitation).
- [ ] **Step 2:** Dispatch sites: add `permissions: true` to each existing agent `include`; after `runFilePaths`, `const permissionsFilePath = writePermissionsFile(runDir, resolveDenyList(agent.permissions, providerKindForThisRun))` (each site already knows the provider it dispatches — read how it picks the adapter); pass `permissionsFilePath` into `adapter.start` input.
- [ ] **Step 3:** Resume: in `executeResume`, `const runDir = dirname(checkpoint.pauseFlagPath)`; refetch the agent's permissions (the agent row is in hand at :49-52 — extend its include), rewrite the file, pass the path into `adapter.resume`'s input (both adapters' resume paths feed `buildChildEnv`).
- [ ] **Step 4:** `buildChildEnv`: add `readonly permissionsFilePath: string` to the input and `AITEAMOS_PERMISSIONS_FILE: input.permissionsFilePath` to the env; update all four call sites and the `StartInput` type(s); update Task 9(M17)'s characterization test `runtime-process.test.ts`'s buildChildEnv case (this is the ONE sanctioned characterization edit — the contract genuinely grew; say so in the test's comment and the report).
- [ ] **Step 5: Tests.** Adapter level: `env-echo` fixture run asserts `AITEAMOS_PERMISSIONS_FILE` reaches the child (both providers). Orchestrator level: an integration dispatch test asserting the file exists in the run's dir with the resolved deny for a seeded `AgentPermission` row; a resume test asserting the file's content refreshes after a permission edit between pause and resume.
- [ ] **Step 6: Prove & commit** — targeted files, then `npm test` (expect the buildChildEnv characterization update to be the only test edit); commit `feat(orchestrator): every run starts and resumes with the matrix resolved beside its pause flag`.

---

### Task 6: The streams and the pump tell a matrix deny from a pause — and the run keeps going

**Files:**
- Modify: `packages/providers/src/gate.ts` (third `GateOutcome` kind), `packages/providers/src/claude/stream.ts` (no change expected — verify `hook_denied.reason` passthrough suffices), `packages/providers/src/cursor/stream.ts` (:309-333 — read `rejected.reason` into the event), `packages/providers/src/types.ts` (if `permission_denied` gains an optional `reason`), `apps/orchestrator/src/pump.ts` (:585-595 and :598-617 routing)
- Create: `packages/providers/test/fixtures/permission-matrix-deny.ndjson` (clone `hook-deny.ndjson`, reason = `permission matrix denies 'run tests' (Bash) for this agent`, tool Bash)
- Test: `packages/providers/test/stream.test.ts` + `cursor-stream.test.ts` + `gate.test.ts`-equivalent (find where classifyGateEvent is tested), `apps/orchestrator/test/integration/pump.test.ts`

**Interfaces:**
- Consumes: `PERMISSION_DENY_REASON_PREFIX`, the `run.tool_denied` event (Task 1), the fixture conventions.
- Produces: `GateOutcome` kind `'tool_denied'` `{ tool, capability }`; pump emits `run.tool_denied` exactly once per refusal, does NOT push into `denied`, does NOT pause/kill; non-matrix denials behave byte-identically to today.

- [ ] **Step 1: Read `gate.ts:20-40` in full** — its doctrine (new kind sanctioned; widening the two existing kinds forbidden; `permission_denied` stays out of `classifyGateEvent`) governs every edit here.
- [ ] **Step 2: `classifyGateEvent`**: `hook_denied` whose `reason.startsWith(PERMISSION_DENY_REASON_PREFIX)` → `{ kind: 'tool_denied', reason }`; parse tool+capability from the reason's fixed grammar (`'<capability>' (<tool>)`) — one small exported parser with its own unit test, returning nulls (and a fallback event payload `{tool:'unknown',capability:'unknown'}`) on a malformed reason rather than throwing.
- [ ] **Step 3: Cursor stream**: read the measured `rejected.reason` (currently discarded, :309-333) into the `permission_denied` event as optional `reason`. In the pump's `permission_denied` case: if `reason` starts with the prefix → route to the same tool_denied handling (emit `run.tool_denied`, skip the `denied.push` and the `guardrail.tripped`); else today's behaviour untouched (push + guardrail event). The comment must name the poisoning this avoids (pump.ts:397's was-this-pause-real heuristic).
- [ ] **Step 4: Pump `tool_denied` case** (new, beside `stopped_by_gate`): `await emit('run.tool_denied', 'agent', { tool, capability })` and nothing else — no `paused`, no kill, no checkpoint.
- [ ] **Step 5: The fixture + the proof.** `permission-matrix-deny.ndjson`: allow on the first tool, matrix-deny on the second (reason with the prefix), agent adapts, clean `result`. Integration test in pump.test.ts: run it end to end — assert the run reaches `succeeded`, `paused` never set, NO `killWithEscalation` fired (the process exits on its own), exactly one `run.tool_denied` with `{tool:'Bash', capability:'run tests'}`, zero `guardrail.tripped`, checkpoint absent or `deniedToolUseIds` EMPTY. Also one regression run of `hook-deny.ndjson` proving the pause path is byte-identical (existing assertions untouched).
- [ ] **Step 6: Prove & commit** — targeted stream/pump/gate tests, `npm test`; commit `feat(runtime): a matrix refusal is a fact the run survives — one event, no pause, no poisoned heuristic`.

---

### Task 7: The deniedToolUseIds reader

**Files:**
- Modify: `apps/web/src/server/tasks.ts` (:13 DTO + :48 include + :80-87 mapping), `apps/web/src/components/TaskDetailPanel.tsx` (:70-75 region)
- Test: the existing tasks-server/TaskDetailPanel test files (grep for them)

**Interfaces:**
- Produces: `TaskRunSummary.checkpoint` gains `deniedDuringPause: readonly { id: string, summary: string | null }[]` — joined server-side: the checkpoint's `deniedToolUseIds` against the run's `run.tool_call` events (payload summaries) so the panel shows human lines; unmatched ids fall back to the truncated id. Empty array → the line does not render.

- [ ] **Step 1:** Server: widen the checkpoint select; for runs whose checkpoint has non-empty `deniedToolUseIds`, ONE additional bounded query per page build (events for those runIds, `type: run_tool_call`, using the new `(runId,seq)` index) — join in JS. NOTE the join is best-effort: tool_use ids are not in `run.tool_call` payloads (they carry name/summary only) — verify against a fixture whether any event payload carries the id; if (as measured) it does not, the summaries cannot be matched per-id and the DTO carries `{ id, summary: null }` with the panel showing `N tool calls denied during pause · <id-prefixes>`. State what you found in the report; do NOT invent a join key.
- [ ] **Step 2:** Panel: beneath the paused line, mono small text (`SECTION_LABEL_CLASS`-adjacent styles used nearby): `denied during pause: <summary || id…>, …` — renders only when the list is non-empty.
- [ ] **Step 3:** Tests: server mapping (empty → absent; ids → fallback rendering), panel render both states. `npx tsc -p apps/web/tsconfig.test.json --noEmit`, targeted vitest, `npm run web:build`, `npm test`.
- [ ] **Step 4: Commit** — `feat(web): what the gate refused during a pause is finally readable where the pause is shown`.

---

### Task 8: The sse·ms chip measures, and the matrix says what it now does

**Files:**
- Modify: `apps/web/src/hooks/useActivityStream.ts` (state + `ActivityStreamState.latencyMs`), `apps/web/src/components/activity/ActivityClient.tsx` (:178-188), `apps/web/src/components/PermissionMatrix.tsx` (copy line only)
- Test: the hook's/ActivityClient's existing test files + settings test if it asserts matrix copy

**Interfaces:**
- Produces: `latencyMs: number | null` computed exactly as `useWorkspaceStream.ts:113-118` (copy the block + its docstring rationale); `ActivityClient` passes it through; the stale `latencyMs={null}` comment dies. Matrix: one descriptive line under the section heading stating enforcement-at-dispatch-snapshot, shell-capability coarseness, and `read secrets` unenforced (spec §2 wording).

- [ ] Steps: TDD the hook (test with a fake EventSource message carrying `ts` → latency computed, clamped ≥0; no message → null), wire ActivityClient, add the matrix copy (plain text, no DOM/testid changes to cells), run targeted + `web:build` + `npm test`, commit `fix(web): the activity chip measures like every other page, and the matrix names its own reach`.

---

### Task 9: Mini debts — the honest 6.0s, the ownerless loop, one control sender

**Files:**
- Modify: `packages/events/src/subscribe.ts` (doc block + initial-open fix), `docs/event-model.md` (teardown budget), `apps/web/src/lib/postControl.ts` (widen), `AgentPanel.tsx`, `EmergencyStopButton.tsx`, `GoalCard.tsx`, `RuntimeCard.tsx`, `graph/DepsMode.tsx`
- Test: `packages/events/test/integration/subscribe.test.ts` (one regression test), affected web component tests

- [ ] **Step 1: close() budget.** Correct both docs to the M17-re-review-verified arithmetic: worst case ≈ **6.0s** (close() during `open()`: up to 2s connect + 2s LISTEN, then the 2s failed-attempt discard; the top-of-pass branch tops out separately at ~2.25s because the post-delay `if (closed) break` cuts the chain). Show the phase math in the `OPEN_TIMEOUT_MS` block; fix `event-model.md`'s budget guidance to 6s.
- [ ] **Step 2: Ownerless loop** (`subscribe.ts:234` initial open; defect precisely: `attachHandlers` at :170 runs before `connect()`, so an `error` emitted during a FAILING initial connect arms `scheduleReconnect` while the caller gets a rejection and no handle — the loop retries forever unowned). Fix: in `open()`'s catch, when this is the INITIAL open (pass a flag or hoist: `attachHandlers` moves to after `LISTEN` succeeds for the initial call only — read both options in the file and pick the one that keeps the in-loop `open()` retry semantics identical; the smaller diff wins). Regression test: use the file's proxy harness (:432 pattern) to fail the initial connect after emitting an error; assert `subscribeEvents` rejects AND no client keeps LISTENing afterwards (countListenBackends-style probe == 0 after settle).
- [ ] **Step 3: `sendControl`.** In `postControl.ts`: `export async function sendControl(url: string, options: { method: 'POST'|'PUT'|'DELETE', body?: Record<string, unknown> }): Promise<string | null>` (same contract: null on ok, message on refusal); `postControl(url, body?)` becomes a one-line delegate. Re-point: delete `AgentPanel`'s byte-identical copy (call `postControl`); `EmergencyStopButton`/`GoalCard` → `postControl`; `RuntimeCard` → `sendControl(url, {method:'PUT', body})`; `DepsMode.postDependency` → `sendControl`. The lib docstring's "single canonical copy" sentence becomes true; the six inline copies stay (backlog note in the report).
- [ ] **Step 4: Prove & commit** — subscribe file 10× via `scripts/repeat-test.sh` (timing neighbours must hold), web targeted + `web:build`, `npm test`; commit `fix(events+web): the teardown budget tells the truth, a failed first open owns its loop, and one sender serves every verb`.

---

### Task 10: `buildSkillGraph` — the ordered chain, served

**Files:**
- Create: `apps/web/src/server/skillGraph.ts`, `apps/web/src/app/api/w/[workspaceId]/skill-graph/route.ts`
- Create: `apps/web/test/integration/skill-graph.test.ts`

**Interfaces:**
- Produces:

```ts
export const SKILL_GRAPH_RUN_LIMIT = 50
export interface SkillGraphRun { readonly runId: string; readonly taskTitle: string | null; readonly agentName: string; readonly live: boolean; readonly startedAt: string; readonly chain: readonly { readonly name: string; readonly count: number }[] }
export interface SkillGraph {
  readonly skills: readonly { readonly name: string; readonly calls: number }[]
  readonly edges: readonly { readonly from: string; readonly to: string; readonly count: number }[]
  readonly runs: readonly SkillGraphRun[]
}
export async function buildSkillGraph(workspaceId: string): Promise<SkillGraph | null>
```

- [ ] **Step 1:** Query shape: the workspace's Skill events — `executionEvent.findMany({ where: { workspaceId, type: 'run_tool_call', runId: { not: null }, payload: { path: ['name'], equals: 'Skill' } }, orderBy: [{ runId: 'asc' }, { seq: 'asc' }], select: { runId, seq, payload } })` bounded by first selecting the newest `SKILL_GRAPH_RUN_LIMIT` distinct runIds having such events (two-step: a grouped/distinct id query newest-first, then the event fetch for those ids — the `(runId,seq)` index carries it). Run metadata (task title via run→task, agent name, live from NON_TERMINAL status, startedAt) from one `agentRun.findMany({ where: { id: { in: runIds } }, include: { task: true, agent: true } })`.
- [ ] **Step 2:** Chain building: per run, events in seq order → names via the `skillNameOf` convention (REUSE/lift `overview.ts:225-229`'s regex into a shared spot — one convention, spec §6); consecutive repeats collapse into `{name, count}`; aggregate `skills` sums counts per name; `edges` counts adjacent DISTINCT pairs (after collapse) across all runs. Empty workspace → `{skills:[],edges:[],runs:[]}` (page still renders — Task 11's empty state).
- [ ] **Step 3:** Route: mirror `graph/route.ts` (force-dynamic, 404 on null).
- [ ] **Step 4:** Tests: seed events for two runs (interleaved seq, repeats, an unparsable `Skill` summary → the null-name convention documented in the test), assert ordering/collapse/edge counts/bounds (seed 51+ runs cheaply? no — assert the LIMIT constant is applied via a query-shape check or a 3-run fixture with limit mocked low; keep honest), empty case, route 404.
- [ ] **Step 5:** `npx tsc -p apps/web/tsconfig.test.json --noEmit`, targeted, `web:build`, `npm test`; commit `feat(web): the skill chain exists server-side — ordered, collapsed, bounded, and indexed`.

---

### Task 11: `SkillMode` — the aggregate canvas, and the tab unlocks

**Files:**
- Create: `apps/web/src/components/graph/SkillMode.tsx`, `SkillNodes.tsx`
- Modify: `graph/GraphClient.tsx` (:40-42 `hasView`, :212 `disabled`, :226 label, render slot after :240), `graph/layout.ts` (`DEFAULT_SIZE` entry)
- Test: `apps/web/test/graph-skill.test.tsx` (new; crib the graph-exec test file's setup)

**Interfaces:**
- Consumes: `SkillGraph` DTO (fetched from the Task 10 route), `useLayoutedGraph`, `GraphCanvas`, `CABLE_EDGE_TYPES`.
- Produces: `buildSkillAggregateGraph(graph: SkillGraph): { nodes, edges }` (pure, `SKILL_NODE_PREFIX = 'skill:'`, exported `SKILL_NODE_TYPES`, nodes at `{x:0,y:0}`, edges `type:'cable'` with `{tone, active:false}`); `SkillMode` props `{ workspaceId, snapshot }` matching siblings; the skill node type's footprint in `DEFAULT_SIZE`.

- [ ] **Step 1:** `SkillNodes.tsx`: a chip-styled node (mono, chip radius 5, the drawer mockup's chain-pill aesthetic — reuse existing tone/token classes, no new colors) showing name + call count; prominence via a size/emphasis step keyed on call count buckets (small/medium/large — a pure function with a test), NOT free-form scaling. Builder per the house contract (docstring citing `TaskNodes.tsx:125-134`'s rules).
- [ ] **Step 2:** `SkillMode.tsx` on the `DepsMode.tsx:52-162` template: fetch the DTO on mount (`/api/w/${workspaceId}/skill-graph`), state `{graph, error}`; `useMemo(buildSkillAggregateGraph)`; `useLayoutedGraph(nodes, edges, 'layered')`; error band `role="alert"`; empty state (`graph.skills.length === 0` → the honest panel: `no skill calls recorded yet — runs record their skills as they use them`, testid `skill-empty`); `<GraphCanvas nodes edges nodeTypes={SKILL_NODE_TYPES} />`.
- [ ] **Step 3:** GraphClient: `hasView` returns true for all four; the `disabled`/`· later` code dies (the :206-211 comment names this line as the one to flip — update that comment too); render `{mode === 'skill' && <SkillMode workspaceId={workspaceId} snapshot={view} />}`.
- [ ] **Step 4:** `DEFAULT_SIZE` gains the skill node type (measure the chip's rendered footprint; a reasonable `{width: 150, height: 40}`-class entry — must match the component's actual box or ELK overlaps, note the check in the test).
- [ ] **Step 5:** Tests: builder purity/order/prefix/types; mode renders nodes from a mocked fetch; empty state; tab no longer disabled (the old `· later` assertion — find and UPDATE the existing GraphClient test that pins the disabled tab; that is a sanctioned test edit, name it in the report).
- [ ] **Step 6:** `tsc test-config`, targeted, `web:build`, `npm test`; commit `feat(graph): the fourth tab opens — skills stand as chips, sized by use`.

---

### Task 12: Focus — one run's chain, selectable

**Files:**
- Modify: `apps/web/src/components/graph/SkillMode.tsx`, `SkillNodes.tsx` (chain-order builder + ×N badge), `graph/GraphClient.tsx` (only if the stream-refetch wiring needs the raw-frame callback threaded — GraphClient already owns `onGraphEvent`)
- Test: extend `apps/web/test/graph-skill.test.tsx`

**Interfaces:**
- Produces: `buildSkillChainGraph(run: SkillGraphRun): { nodes, edges }` (left-to-right ordered chain; node ids `skillstep:<i>`; ×N badge from the collapsed `count`); a run-selector strip (mono chips: taskTitle ?? runId-prefix · agentName · live dot; `data-testid="skill-run-chip"`); selection state in `SkillMode` (select → focus canvas, deselect control → aggregate); debounced refetch (≥2s) when a `run.tool_call` frame arrives via the graph stream (thread `GraphClient`'s existing raw-frame path — read how `onGraphEvent`/`useGraph` expose frames and pass a callback prop to `SkillMode`; if the plumbing would grow GraphClient's API awkwardly, a simple 30s poll while the tab is active is the sanctioned fallback — record which landed and why).

- [ ] Steps: builder + badge rendering (TDD: chain order preserved, collapse badge shows ×N, single-skill run renders one node no edges); selector strip renders `graph.runs` (live dot from `live`); selection swaps builders (test both directions); refetch wiring (fake timers test); `tsc`, targeted, `web:build`, `npm test`; commit `feat(graph): pick a run and read its chain left to right`.

---

### Task 13: `gate:m18-skill-and-teeth`

**Files:**
- Create: `scripts/gate-m18-skill-and-teeth.mjs`
- Modify: `package.json` (script), `README.md` (gates row)

**Interfaces:**
- Consumes: the fake CLI (`AITEAMOS_CLAUDE_BIN` → `scripts/gate-fakes/` convention — read `gate-m14-fidelity.mjs`'s preconditions), the `permission-matrix-deny` fixture, playwright-core + the m14 gate's server/browser/console blocks (crib verbatim, including `gotoReliably` and the warm-up), the dev DB.

- [ ] **Step 1:** Script skeleton from `gate-m14-fidelity.mjs` (spawn next dev, warm-up, chromium, console collectors, `fail()` dump, daemon spawn with fake CLI). Three proof stages:
  1. **Enforcement:** seed a workspace + agent with `deny` on `run tests`; dispatch a task whose fake run replays `permission-matrix-deny.ndjson`; wait for the run to conclude `succeeded`; assert exactly one `run.tool_denied` event row `{tool:'Bash',capability:'run tests'}`, zero `guardrail.tripped`, run never `paused`; assert the Activity page renders the denial card.
  2. **Skill tab:** seed ordered Skill events for two runs; browse `?mode=skill` — aggregate: `skill:`-prefixed nodes visible with counts; click a run chip → chain order asserted via DOM order + a ×N badge present; empty workspace → `skill-empty` testid visible; the tab is enabled (no `· later`).
  3. **Chrome truths:** the Activity chip shows `sse · <n>ms` (regex `/sse · \d+ms/`) once the stream ticks; a seeded paused checkpoint with `deniedToolUseIds` shows the reader line in the task panel.
- [ ] **Step 2:** `package.json`: `"gate:m18-skill-and-teeth": "tsc --build && node --env-file=.env scripts/gate-m18-skill-and-teeth.mjs"` (match the m14/m16 row shape); README gates-table row (zero spend, fake CLI, needs dev DB + browser). Dev DB migration for the two m18 migrations happens before the gate run (the migrate flow the repo uses for dev — read how m13/m14 gates handled a fresh migration; do the same and record it).
- [ ] **Step 3:** Run the gate to a PASS (a red is a finding to investigate, never retry-to-green; the console dump + `gotoReliably`'s counter are the instruments). Then `npm test` once more.
- [ ] **Step 4: Commit** — `feat(gate): m18 — a refused tool, a readable chain, and two honest chips, proven without spending a cent`.

---

## Completion

After Task 13: final whole-branch review (subagent-driven-development's final review, most capable model), ONE fix wave if findings, merge to `main` fast-forward with the suite green, push (pre-push hook runs the suite), and update the project memory (`m12-backlog-from-m11.md` + `MEMORY.md` hook): mark done — permission enforcement (v1 coarse mapping, `read secrets` unenforced), deniedToolUseIds reader, sse·ms chip, Skill-chain view (both views), close() 6.0s doc, ownerless-loop fix, sendControl consolidation; still open — the six inline control-fetch copies, `listWorkers` scan, CompanyManager split, TASK_STATUS derivation, command-string-level shell permissions (v2 idea), `read secrets` enforcement design, Cursor non-shell enforcement reliability (upstream tool_name), auth story.
