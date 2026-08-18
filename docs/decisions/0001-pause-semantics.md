# ADR 0001 — Pause Semantics

**Status:** Accepted
**Date:** 2026-08-17
**Context:** Spec §7 (provider adapter), §8 (pause/resume/checkpoints), §9.2 (guardrails and
permissions), §10 (git model); spike findings in
`docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md`, and — for Q7/Q8 and §4's third
block shape — `docs/superpowers/spikes/2026-08-18-m3-hook-failure-modes.md` ("M3 findings" below,
measured on `claude` 2.1.234)

Spec §8 called the exact hook behaviour, session-resume semantics inside a worktree, and
token/cost reporting "unverified assumptions" and the highest risk in the project. Milestone 0 was
the spike that tested them against the real `claude` CLI (version 2.1.233). This ADR records what
was measured and makes it binding on M3's `ClaudeCodeAdapter`.

Every claim below is labelled: **[Observed]** means a capture in the findings shows it,
**[Inferred]** means it follows from an observed mechanism but was not directly seen,
**[Decision]** means it is our choice rather than a measurement. Section references such as
"(findings 3.6)" point into the findings document.

---

## Decision

### 1. Pause is orchestrator-owned. The hook is one half of it.

A `PreToolUse` hook that denies a tool call **removes the agent's ability to act; it does not stop
the agent.** In the run where a pause was actually triggered, the model responded to the first
deny by trying a *different* tool to obtain the same information, was denied again, and only then
ended its turn on its own (findings 3.5). **[Observed]**

Pause is therefore defined as a two-part protocol:

1. **The hook blocks the side effect.** `pause-gate.sh`, registered as a `PreToolUse` hook with
   `matcher: "*"`, returns `permissionDecision: "deny"` for every tool call while the run's flag
   file exists (findings 3.3–3.6). **[Observed]**
2. **The orchestrator terminates the process on the first observed deny.** It must not wait for the
   model to stop. The self-stop seen in the spike is a property of that model on that prompt, not a
   contract. **[Decision, on observed evidence]**

The kill does not buy safety from side effects — while the flag exists the hook denies every call,
so nothing can land regardless. It buys a **deterministic pause point and a bounded cost**: without
it, "paused" means "still running, still burning turns, will stop whenever it decides to."

### 2. The pause trigger

`requestPause(runId)` creates the run's flag file at the path in `AITEAMOS_PAUSE_FLAG`. The path is
**unique per run**. The hook treats an unset or empty variable as a configuration error and denies
loudly rather than falling back to a shared default, because a shared default would let pausing one
agent freeze an unrelated concurrent one (findings 3.10). **[Observed]**

The hook is only consulted when a tool call is pending. If pause is requested while the model is
producing its final text, no deny will ever arrive and the run completes normally. **[Inferred]**
M3 must treat "pause requested, run finished anyway" as a normal outcome — the run is
`succeeded`/`failed`, not `paused` — clear the flag, and apply a deadline to the pause request
rather than waiting indefinitely for a deny.

### 3. Launch posture is mandatory, and it does not conflict with the hook

A headless run must be launched with an explicit non-default permission posture or its edit tools
do nothing: under the default mode with no TTY, every `Edit` was denied and the run still terminated
normally — `stop_reason: "end_turn"`, `terminal_reason: "completed"`, `is_error: false` on the
terminal `result` event — a full event stream that landed nothing (findings 1). Only a non-empty
`permission_denials` array distinguishes it from a successful run. **[Observed]**

A `PreToolUse` hook's deny is **not** overridden by `--permission-mode bypassPermissions`; the two
mechanisms are independent layers (findings 3.6). **[Observed]** This is what makes pause viable at
all, given that the permission posture above is mandatory.

Required flags for every run M3 spawns:

- `--output-format stream-json --verbose` — the NDJSON event stream (findings 1).
- `--permission-mode bypassPermissions` (or a narrower measured posture, see Q5) — findings 1.
- `--settings <absolute path>` registering the `PreToolUse` hook. The `command` must be an
  **absolute path**; the `$VAR` form in a settings file was never tested (findings 3.1).
- `--include-hook-events` — without it there are no `hook_response` lines at all and a hook deny
  has no unambiguous live signal (findings 4.2 vs. 3.4). **[Observed]**
- **Never** `--no-session-persistence` — it makes resume impossible (findings 2).
- **Never** `--fork-session` — it would mint a new session id on resume (findings 2.3).

### 4. Detecting the pause: four outcome shapes, never conflated (only three of them block)

- **Permission-mode denial:** `{"type":"system","subtype":"permission_denied","tool_name":...,
  "tool_use_id":...,"message":"Claude requested permissions to ..."}` (findings 1). **[Observed]**
- **Hook denial:** produces **no `permission_denied` event whatsoever.** The live signal is
  `{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:<Tool>","output":"<JSON
  string>"}` whose `output` parses to `hookSpecificOutput.permissionDecision == "deny"`, followed by
  a `tool_result` carrying `is_error: true` and the deny reason as its content (findings 3.5).
  **[Observed]** The `hook_response` reports `outcome: "success"`, `exit_code: 0`.
- **Hook crash, blocking** (added by M3 Task 1, findings §3.1): same `hook_response` event type, but
  `outcome: "error"`, **`exit_code: 2`**, and `output` is the hook's **plain-text stderr**, not JSON.
  The `tool_result` is `is_error: true` with content `PreToolUse:<Tool> hook error: [<path>]:
  <stderr>`. It **blocks the tool call just as a deny does** — Q7. **[Observed]**
- **Hook failure, NON-blocking** (added by M3 Task 1 Fix Round 1, findings §6): also
  `outcome: "error"`, but **any nonzero `exit_code` other than 2** — measured for `1`, `126` (hook
  not executable) and `127` (hook path does not exist). **The tool runs.** `PostToolUse` fires, the
  `tool_result` is the tool's ordinary success, and `permission_denials` stays **empty**. This is not
  a denial shape at all; it is listed here because it is trivially mistaken for one — Q9.
  **[Observed]**

**All four shapes above are scoped to `hook_event === "PreToolUse"`.** This is not a caveat, it is
part of the rule (added Fix Round 5, findings §3.4). Every one of the four captures ends with a
routine `Stop` hook reporting `exit_code: 1` — a healthy line on a healthy run. Classifying it by
`exit_code` without the scope reads it as a hook that failed open, on every run. `hook_event` is
present on every `hook_response` line in every capture and is the field that scopes the rule.
**[Observed]**

**`exit_code == 2`, exactly, is what distinguishes a blocking hook failure from a non-blocking one
— within `PreToolUse`.** `outcome: "error"` does **not** mean the tool was blocked: among the
`PreToolUse` responses measured, exit 1, 2, 126 and 127 all report it, and only exit 2 blocks
(findings §3.1, §6.3). **[Observed]**

**`outcome` has at least three values, not two.** `"success"`, `"error"`, and `"cancelled"` —
counted across the four captures: 24, 6 and 4. Every `"error"` is a `PreToolUse` response; every
`"cancelled"` is a `Stop` response (findings §3.4). **[Observed]** What `"cancelled"` would mean on
a `PreToolUse` response is **unmeasured**: it is a plausible shape for a cancelled or timed-out
hook, and none of the captures contains one. This does not reopen the timeout question — §5.5's
runtime backstop keys on whether tool calls proceeded after the flag was armed, which is answerable
whatever shape the hook's own response takes.

M3's stream parser must handle all four shapes and must not conflate them. The difference is
operational, not cosmetic: a permission-mode denial means the run is misconfigured and will
accomplish nothing (map it to `guardrail.tripped`); a hook denial means the run is pausing as
instructed (map it to `run.paused`); a blocking hook crash means the pause gate is broken and must
**fail the run loudly**, never be reported as `paused` — nothing is waiting to be resumed and the
operator's only intervention lever is dead; a non-blocking hook failure means the gate is broken
**and a side effect has already landed**, which is also a loud failure and never a pause. An
orchestrator that read the first as the second would wait forever to resume a run that was never
paused; one that read the third or fourth as the second would report `run.paused` for a run that is
still free to act. **[Decision, on observed evidence]**

Four parser requirements follow from the captures. **[Observed]**

1. `hook_response.output` is a **JSON-encoded string**, not a nested object. It needs a second parse.
2. `hook_response` carries **no `tool_use_id`**. Correlate to a specific call via the `tool_result`
   that follows it. It is not otherwise sparse — every such line in the captures carries
   `hook_name`, `hook_event`, `hook_id`, `exit_code`, `outcome`, `stdout`, `stderr`, `output`,
   `uuid` and `session_id`. `hook_event` in particular is load-bearing: it is what scopes the
   classification above to `PreToolUse`.
3. The terminal `result` event's `permission_denials` array records every kind of block that
   actually blocked — permission-mode denials, hook denies, and blocking (exit-2) hook crashes —
   with `tool_name`, `tool_use_id`, and `tool_input`, and **cannot tell them apart** (M3 findings
   §1.5). It records **nothing at all** for a non-blocking hook failure, which is the case where the
   gate was broken *and the tool ran* (M3 findings §6.1). Useful for the checkpoint; useless as a
   live pause signal, since it arrives at the end of the run; and unusable as a health signal for
   the gate.
4. `hook_response` events **can arrive after the terminal `result` event** — an `async: true` hook
   reports late, and one did, as the final line of the Q7 capture (M3 findings §3.2). The parser
   must not stop reading at `result`, and must not assume `hook_started`/`hook_response` pairs are
   ordered per tool call. A crash or deny for the *pending* call always precedes its `tool_result`;
   that ordering, not stream position, is what requirement 2's correlation relies on.

### 5. What the checkpoint stores

Spec §8's `{ sessionId, lastCompletedStep, worktreeCommit, filesTouched, ts }` survives in shape,
with `lastCompletedStep` given a concrete definition and two fields added:

| Field | Why | Evidence |
|---|---|---|
| `sessionId` | Written once at run start, from the first `system/init` line. **Never rewritten after a resume** — a plain `--resume` reports the *same* UUID. | **[Observed]** findings 2.3, 4.3 |
| `worktreePath` | Resume must be spawned with cwd set to the run's original directory. | **[Decision]**, forced by Q1 |
| `pauseFlagPath` | The run's unique `AITEAMOS_PAUSE_FLAG`. Resume must clear it and verify it absent, or the hook denies everything. | **[Observed]** findings 3.10, 4.2 |
| `lastToolUseId`, `lastToolName`, `numTurns` | The concrete form of "lastCompletedStep". The stream has no notion of a step; it has `tool_use_id` per call and `num_turns` on the terminal event. | **[Observed]** findings 1 |
| `deniedToolUseIds` | From `permission_denials`. On resume the model re-attempted exactly these calls, in order — this is the operator's view of what the agent was about to do. | **[Observed]** findings 3.5, 4.5-ii |
| `headCommit`, `dirtyFiles` | Spec's `worktreeCommit` / `filesTouched`. `HEAD` alone is insufficient: the interesting state throughout the spike was uncommitted, so record `git status --porcelain` too. Motivated by findings 4.1, where the code on disk came from an unrelated session sharing the directory. | **[Decision]** on observed evidence |
| `cumulativeCostUsd`, `cumulativeTokens` | Each run segment reports its own `total_cost_usd`. Whether a resumed run's figure is per-segment or cumulative is unresolved (Q3) — the budget guardrail's accounting depends on it. | **[Observed]** findings 1, 2.4; **open** Q3 |
| `pauseReason`, `requestedBy`, `ts` | Provenance for the UI and the audit trail. | **[Decision]** |

### 6. How resume delivers queued instructions

Clear the flag file and verify it is gone; spawn `claude -p "<queued instruction text>" --resume
<sessionId>` in the same worktree, with the same settings and permission posture. The CLI has no
notion that a resume follows a pause — it treats the resume prompt as an ordinary next turn
(findings 4.8). **[Observed]**

The *outcome* was measured end to end (for what was not, see the second limit below): the injected
instruction ("name the class MathKit instead of
Calculator") was followed exactly, verified independently in the working tree and by a passing test
suite; the session id was unchanged; and the resumed agent showed granular awareness of the
pre-pause turn — it re-read only the file it had been *denied*, edited from memory the file it had
already read, re-attempted both denied calls in their original order, and honoured a
"run npm test after each change" instruction that appeared only in the pre-pause prompt
(findings 4.4–4.5). **[Observed]**

**Two limits stated plainly:**

- The paused session had made zero `Edit` calls before the pause, so "a session resumed and
  continued its own in-flight editing work" was **not** demonstrated. What was demonstrated is that
  the session's conversational context survived the pause boundary and shaped its behaviour on
  resume (findings 4.1, 4.7). **[Observed limit]**
- **The hook's behaviour during the resume run itself is inferred, not observed.** The resume run
  omitted `--include-hook-events`, so its capture contains no `hook_response` lines at all
  (findings 4.2). That `pause-gate.sh` fired and *allowed* each call is deduced from the absence of
  denial signals — empty `permission_denials`, no `is_error: true` tool results, the flag file
  verified absent — and is equally consistent with the hook not firing on that run. The outcome
  (a completed run that obeyed its instruction) is directly observed; the mechanism behind it on
  that particular run is not. **[Inferred]** Section 3's requirement that M3 always pass
  `--include-hook-events` closes this gap for the adapter, but it does not retroactively close it
  for this evidence.

Mapping onto spec §5.2's run state machine:

- `requestPause` → write flag → `run.pause_requested`, status `pause_requested`.
- first hook deny observed in the stream → `SIGTERM` (escalating to `SIGKILL` after a grace period,
  so the CLI can flush session state — **[Decision]**, see Q2) → on process exit, write the
  checkpoint → `run.paused`.
- `resume(runId, checkpoint)` → clear flag, verify absent, spawn with queued instructions as the
  prompt → status `resuming` → `run.resumed` → `working`.

### 7. `pause-gate.sh` must gain a real JSON encoder before M3 uses dynamic reasons

The script's `deny()` interpolates its reason string into JSON with `printf` and no escaping. That
is safe for the two static call sites it has today, and **not** safe for M3, which will want
reasons containing a task key, an operator name, or the operator's own message. A character
requiring JSON escaping would produce a malformed payload — and a malformed deny is an **allow**.
**[Decision, binding]**

---

## Consequences

### `ProviderCapabilities` for the Claude Code adapter (spec §7)

```ts
{
  canPauseMidRun:            true,   // [Observed] findings 3.3-3.6 — at the *next* tool-call
                                     //   boundary, and only because the orchestrator kills
  canResumeSession:          true,   // [Observed] findings 2.3-2.4, 4.3-4.5 — PROVISIONAL:
                                     //   never exercised in a worktree (Q1) or after a kill (Q2)
  supportsHooks:             true,   // [Observed] findings 3.3 — PreToolUse, matcher "*",
                                     //   fired for Skill/Read/Edit/Bash
  streamsToolCalls:          true,   // [Observed] findings 1 — NDJSON, tool_use_id correlation
  reportsTokenUsage:         true,   // [Observed] findings 1 — per-event usage + aggregate
                                     //   usage/modelUsage/total_cost_usd on the result event
  supportsCustomSystemPrompt: false, // NOT MEASURED (Q4). false is the fail-safe direction:
                                     //   standing instructions go in the prompt instead
  enforcesToolPermissions:   true,   // [Observed] but narrower than the name implies — see below
}
```

`enforcesToolPermissions` is true for the two mechanisms actually measured — `--permission-mode`
(findings 1) and the `PreToolUse` hook (findings 3.6). `--allowedTools` / `--disallowedTools` were
**never exercised**; they appear only in the CLI's `--help` inventory (findings 0). Treat that half
as provisional until Q5 is answered.

### Permissions must be configured, never prompted (spec §9.2)

The CLI's interactive permission prompt is unusable as a control surface for an autonomous runtime:
there is no TTY to answer it, and the failure is invisible in the run's terminal event, which
reports a clean completion. §9.2's "permissions
enforced at the adapter level" therefore means explicit `--allowedTools` / `--disallowedTools`
allow-lists chosen before the process starts, plus policy denial in the hook. An agent's permission
model cannot rely on prompts. **[Observed consequence]**

**[Decision]** M3 enforces the per-agent allow/deny list in the **same `PreToolUse` hook** that
implements pause, with `--allowedTools` / `--disallowedTools` as defence in depth. The evidence is
asymmetric: the hook's deny is measured to work, including under `bypassPermissions`, while the
allow-list flags have never been run. Build on the measured mechanism; add the unmeasured one as a
second layer. This also gives one place to deny persistent git-config writes — which the next
consequence needs.

### Concurrency and the git common directory (spec §10)

Worktree isolation holds for everything that constitutes the work: a run confined to a worktree left
`main` at its original commit, and two concurrent runs on sibling worktrees produced independent
branches with no cross-contamination at file or ref level and **no git lock contention** — each
commit locked only its own ref (findings 5.2, 5.4, 5.5, 5.7). **[Observed]**

One seam: **`.git/config` is repo-wide state that worktrees do not isolate, and both concurrent
agents hit the same missing-identity failure there — one of them then wrote git identity into it
persistently.** Both agents' first `git commit` failed with `Author identity unknown`; TASK-001
recovered by running `git config user.name/user.email` with no scoping flag, which lands in the
shared `.git/config` and is visible from every worktree, while TASK-002 recovered with a
per-invocation `git -c user.name=... -c user.email=... commit`, which writes nothing. They did not
collide only because of that difference; two persistent writes with different values would have
silently overwritten each other (findings 5.5). **[Observed]**

The corrected fact strengthens the mitigation below rather than weakening it: **the non-persistent,
supplied-at-invocation form is not merely proposed — it was observed working.** TASK-002's commit
`a152039` is attributed `meren <erenaltan@gmail.com>` and TASK-001's `bd75aa1` is attributed
`spike <spike@local>`, each as its own agent intended, with only TASK-001's identity surviving in
the shared config (findings 5.5). **[Observed]** What that validates is the *family* — identity
supplied per invocation, persisted nowhere. The specific variant recommended below (environment
variables) was not itself exercised; it is the member of that family that requires no cooperation
from the agent. **[Decision]**

**[Decision]** So that N concurrent runs never contend on it, M3 makes the agent's improvisation
both unnecessary and impossible:

1. Set `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` in the
   spawned process's environment. Per-process, writes no file, cannot leak to a sibling worktree —
   and it removes the `Author identity unknown` failure that provoked the config write in the first
   place.
2. Deny persistent git-config writes through the permission hook.
3. Where the orchestrator issues a git command itself, `git -c user.name=... -c user.email=...` is
   the same non-persistent guarantee at the command level — the form TASK-002's agent arrived at on
   its own, with correct attribution confirmed (findings 5.5).
4. If a file-based identity is ever preferred, use `git config extensions.worktreeConfig true` once,
   then `git config --worktree user.*` per worktree.

The general rule: **no run may write to the git common directory.** Identity is only the instance
this spike happened to surface.

### A fresh worktree is not a ready workspace (spec §10)

Neither worktree ever had `node_modules`, and `npm test` succeeded anyway — because the fixture
repo has **zero dependencies** and `npm test` runs Node's built-in test runner (findings 5.6).
**This must not be generalised.** **[Decision]** M3's worktree provisioning includes an explicit,
workspace-configured **setup command list** — the counterpart to §10's verify commands — run after
`git worktree add` and before any verify command. A real target repository would fail its verify
commands without it.

### Degradation path if a provider lacks hooks (spec §7)

`getCapabilities()` is queried, not assumed, and the orchestrator degrades in three named steps.

**Provider has resume but no hooks — `canPauseMidRun: false`.** Pause becomes "stop at the end of
the current run": `requestPause` sets a scheduler-level flag, `run.pause_requested` is emitted
immediately, and `run.paused` is emitted only when the run reaches its own terminal event. The
checkpoint is written from that terminal event (its `session_id`, `num_turns`, final
`permission_denials`, plus the tree state). The UI must say explicitly that the run will stop after
its current step rather than now — the system never pretends to a capability it lacks (spec §7).

**Provider has neither hooks nor resume.** Pause degrades further, to "stop": the run is cancelled
and the worktree preserved (spec §8's stop semantics, which lose no work). The checkpoint degrades
from a resumable handle to a **recap**: the branch, its `HEAD`, the dirty-file list, and the run's
event history. Continuation is a *new* run whose prompt is built from that recap plus any queued
operator instructions. Callers must not treat `resume()` as available; `canResumeSession: false`
means the adapter's `resume` rejects rather than silently starting a fresh session.

**Provider has hooks but the hook cannot deny (advisory hooks only).** Equivalent to no hooks:
`canPauseMidRun: false`. A hook that cannot block a tool call cannot prevent a side effect, and
"pause" that permits side effects is not pause.

In every degraded mode, `cancel()` remains available. It is not a substitute for pause: it discards
the in-flight turn.

---

## Alternatives Rejected

- **Freezing the in-flight LLM request.** Impossible. There is no mechanism to suspend a
  request mid-flight, which is exactly why the checkpoint boundary is the tool-call boundary
  (spec §8).
- **`SIGSTOP` on the process.** Leaves the working tree and any open file handles in an
  indeterminate state, does not survive a daemon restart, and holds an API request open for the
  duration. A stopped process is not a checkpoint: nothing is persisted, so nothing can be resumed
  after a crash.
- **Trusting the model to stop after a deny.** Directly contradicted by measurement: it tried
  another tool first (findings 3.5). The self-stop that followed is not part of any contract.
- **Relying on the interactive permission prompt as the control surface.** There is no TTY in a
  headless run, and the denial is quiet in the run's terminal event, which reports a clean
  completion (findings 1). Unusable for an autonomous
  runtime.
- **A single shared pause-flag path.** Pausing one agent would freeze unrelated concurrent agents,
  and running agents in parallel is the product's premise. The flag is per-run, and an unset path is
  a loud configuration error rather than a silent default (findings 3.10).
- **Treating the terminal `result` event's `permission_denials` array as the pause signal.** It is
  accurate but arrives only at the end of the run — too late to pause anything. Kept for the
  checkpoint, not for detection.
- **Detecting a hook deny from the `is_error: true` tool result alone.** Indistinguishable from an
  ordinary tool failure without matching on the reason string. `--include-hook-events` plus the
  `hook_response` payload is unambiguous, so M3 always passes that flag.
- **Rewriting `Checkpoint.sessionId` after each resume.** Unnecessary: a plain `--resume` reports
  the same id (findings 2.3, 4.3). Rewriting it would add a failure mode for no benefit.

---

## Known Limitations

Two lists, kept separate on purpose. **Known limitations** are things already known to be unmeasured
in work that is finished — nobody is expected to go and close them, but nobody should read past them
either. **Open questions** (next section) are things someone should measure before or during M3.
A reader who conflates the two will either chase settled work or build on an assumption.

- **Hook behaviour during the resume run is inferred, not observed** (findings 4.2, 6.7). The
  resume run omitted `--include-hook-events`; that the hook fired and allowed each call is deduced
  from the absence of denial signals. See §6 above. Not worth a run to close: §3 makes
  `--include-hook-events` mandatory, so M3 will observe this directly from its first run.
- **OS-level exit codes were not captured to a durable file in several runs** (findings 3.10, 6.7).
  Exit codes were observed in-session but not persisted alongside the `.jsonl` captures, so no claim
  in this ADR rests on a process's exit status — and none should. This matters to M3 in one concrete
  way: the adapter must decide run outcome from the terminal `result` event's fields
  (`is_error`, `terminal_reason`, `stop_reason`, `permission_denials`), which *were* captured for
  every run, rather than from the child process's exit code, whose behaviour across the failure
  cases this spike did not systematically record. §3's denied-edit run is the cautionary case: its
  terminal event reports a clean completion and only `permission_denials` reveals that nothing
  happened, so an adapter reading a coarse success/failure signal would misclassify it either way.
- ~~**`pause-gate.sh`'s exit-2 crash path was never exercised by a real `claude` run**
  (findings 3.10). It was verified standalone against `/dev/full`. Whether that path fails closed is
  Q7 — the limitation is recorded here, the measurement that would settle it is there.~~
  **SETTLED** — a real `claude` 2.1.234 run with an always-exit-2 `PreToolUse` hook blocked every
  tool call and created nothing on disk. See Q7. **[Observed]**
- **The `$AITEAMOS_SPIKE` variable form in `settings.json` was never tested** (findings 3.1); only
  the absolute-path form. §3 makes absolute paths mandatory, which is why this stays a limitation
  rather than becoming an open question.
- ~~**A denied `Edit` was never observed** (findings 3.7); both denied calls were read-only. See Q8.
  Not settled by findings §7 either: that task's denied call was a `Bash` invocation, not an
  `Edit`.~~ **SETTLED** — M3 findings §2.4 denied a real, pending `Edit` and confirmed the target
  file byte-identical with an unchanged mtime. See Q8. **[Observed]**
- ~~The paused session had no edits of its own (findings 4.1). See §6.~~ **SETTLED** — findings
  §7.3–§7.6 paused a session with a real, landed `Edit` (a TDD-RED test file change) already applied
  before the flag was armed, killed it mid-tool-call, and confirmed the resumed session both knew
  about that edit without re-reading it and correctly continued the interrupted plan from it. "A
  session resumed and continued its own in-flight editing work" is now demonstrated. **[Observed]**

## Open Questions

These are unresolved and someone should measure them. Each names what would settle it. They are
recorded rather than guessed at, because the point of M0 was to replace guesses with measurements.

- **Q1 — RESOLVED: yes.** `--resume` works with cwd inside a git worktree. One run was started in
  `.aiteamos/worktrees/TASK-003`, killed mid-tool-call (see Q2), and resumed from that same worktree
  directory: terminal `result` event reporting `is_error:false`/`terminal_reason:"completed"`, the
  same session id, and — with no `Read` tool call preceding it — the resumed run's first line of
  text correctly named the exact pre-kill state on disk, evidence the
  worktree-scoped session was read back intact, not reconstructed by inspection. All four subsequent
  commits landed on the worktree's own branch (`aiteamos/TASK-003-kill-resume`); `main` was never
  touched. **[Observed]** (findings §7.3, §7.5, §7.6). No mitigation (`--session-id` pre-assignment)
  was needed.
- **Q2 — RESOLVED: yes, for `SIGTERM`.** A session killed mid-tool-call remains fully resumable.
  Sequence measured: a run was paused via the hook, the first observed deny (`PreToolUse:Bash`) was
  followed immediately by `SIGTERM`; the process exited on its own within a 3-second grace period —
  `SIGKILL` was never needed for this run. The resumed session (Q1) picked up exactly where the kill
  left it, including awareness of an edit that had landed but whose verifying test run never
  happened, and completed the remaining work with commits. **[Observed]** (findings §7.3, §7.6).
  **Narrower than originally scoped:** only `SIGTERM`, and only a case where the process exited
  before a `SIGKILL` grace period elapsed, were exercised. Whether a session survives `SIGKILL`
  specifically (no grace period, no chance for the CLI to flush anything before the OS reclaims the
  process) remains unmeasured and is not settled by this ADR.
- **Q3 — RESOLVED: per-segment, not cumulative.** Run 2's aggregated `usage` fields
  (`cache_read_input_tokens: 126370`, `output_tokens: 1229`) are *larger* than its resume's,
  run 3's (`119721`, `951`), even though run 3 did real, verified additional work. A cumulative,
  whole-session running total cannot decrease across a resume that adds turns; since it decreased,
  each run's reported `usage`/`total_cost_usd` is that run's own segment total, not inherited from
  prior segments. **[Observed]** (findings §7.7). Consequence: the budget guardrail (spec §9.2)
  summing `total_cost_usd` across a task's run segments is the *correct* accounting — each resume's
  figure is additive, not inclusive of what came before. Summing does not double-count.
- **Q4 — Does the CLI accept a custom or appended system prompt in headless mode?** Never
  exercised. `supportsCustomSystemPrompt` is `false` until measured. *Settles it:* one run with the
  flag, checking the instruction is honoured.
- **Q5 — Do `--allowedTools` / `--disallowedTools` enforce an allow-list in headless mode, and do
  they compose with `bypassPermissions` the way the hook does?** Never exercised. *Settles it:* a
  run under `bypassPermissions` with `--disallowedTools Edit`, checking whether the `Edit` is
  refused and which event shape the refusal takes.
- **Q6 — What happens when pause is requested and the run has no further tool calls?** Inferred to
  complete normally. *Settles it:* set the flag after the last tool call of a short run and observe
  the terminal event.
- **Q7 — RESOLVED: it fails CLOSED, for exit code 2.** A hook that exits 2 with empty stdout,
  registered `PreToolUse`/`matcher: "*"` by absolute path, blocked every tool call in a real
  `claude` 2.1.234 run under `--permission-mode bypassPermissions`. The model tried `Bash`
  (`echo hello > probe.txt`), then `Write`, then `Read`; all three were blocked. **The verdict is the
  filesystem, not the stream: `probe.txt` does not exist** — the working directory is as empty after
  the run as before it — and no `PostToolUse` event fired for any of the three calls, so no tool body
  ran. **[Observed]** (M3 findings §1.3–§1.4). `pause-gate.sh`'s exit-2 fallback is therefore backed
  by a measurement of the mechanism it relies on, not only by the documented convention.
  **Narrower than the question asked, in one way that matters:** only **exit code 2** was exercised.
  Exit 1, exit 127 (hook script missing, moved, or not executable), a signal-killed hook, and a hook
  timeout were **not** measured, and on Claude Code's documented convention those are *non-blocking
  warnings* — meaning `pause-gate.sh` would fail **open** if it ever failed in any way other than
  exit 2. `pause-gate.sh` has no exit-1 path, but "the script is missing or is not executable" is
  exit 127 and is a real deployment failure. That residual was carried forward as **Q9 and is now
  resolved there: they fail OPEN.** Read Q7 as bounded to exit code 2 and Q9 as the answer for
  everything else. Also unmeasured: whether a crash blocks
  `Edit`, `Task`, `Skill`, or MCP tools (only `Bash`, `Write`, `Read` were crash-blocked), and
  whether a hook that exits 2 *with* stdout behaves the same.
- **Q8 — RESOLVED: no. It does not partially apply; it does not apply at all.** A run was paused
  with `pause-gate.sh` by arming the flag in the window between a completed `Read` of the target file
  and the `Edit` that followed, so `Edit` was the pending call at the moment of the deny. The `Edit`
  was genuinely issued (`old_string: "line one: alpha"` → `new_string: "line one: omega"`) and was
  denied by the hook. **The target file was recorded before and after:** 49 bytes → 49 bytes, sha256
  `a14dabdc…c48a9f` → the same sha256, and **the mtime was unchanged to the nanosecond**
  (`19:42:18.330237935`) — the file was never opened for writing. No `.bak`/`.tmp`/swap file was left
  in the directory, no `PostToolUse:Edit` fired (`PostToolUse:Read` did), and the CLI marked the call
  `tool_result_meta[0].non_execution_kind == "permission-rule"`. **[Observed]** (M3 findings
  §2.2–§2.5). **Narrower than the question:** one `Edit` tool call with a single hunk. `MultiEdit`,
  `NotebookEdit`, `Write` over an existing file, and a `Bash`-mediated write (`sed -i`, `>>`) were
  **not** exercised — they pass the same `PreToolUse` gate, so the result should generalise, but that
  is **[Inferred]**, not measured. Nor was an `Edit` blocked by a *crashing* hook rather than a clean
  deny; Q7's blocked `Write` is the nearest evidence and it created nothing.
- **Q9 — RESOLVED: yes, they fail OPEN.** Raised by Q7's own limit (which covered exit 2 only) and
  measured in two further `claude` 2.1.234 runs. Three failure modes, all under
  `--permission-mode bypassPermissions`, **all of them let the tool run**, and in each case the
  verdict is the file on disk, not the event stream:
  - **hook path does not exist** — `PreToolUse:Write` reported `exit_code: 127`, `outcome: "error"`,
    `output: "/bin/sh: line 1: .../no-such-hook.sh: No such file or directory"`, and `alpha.txt` was
    **created**;
  - **hook exists but has no execute bit** — `PreToolUse:Bash` reported `exit_code: 126`,
    `outcome: "error"`, `"Permission denied"`, and `beta.txt` was **created**. The hook's body was
    `exit 2` on purpose, so had it run at all the call would have blocked; its stderr never appears
    in the capture, confirming it never started;
  - **hook runs and exits 1** — `PreToolUse:Bash` reported `exit_code: 1`, `outcome: "error"`, the
    hook's own stderr, and `gamma.txt` was **created**.

  In all three, `PostToolUse` fired, the `tool_result` was the tool's ordinary success, and the
  terminal `result` reported `is_error: false`, `terminal_reason: "completed"`, process exit code 0,
  and **`permission_denials: []`** — a fail-open run is indistinguishable from a healthy run on the
  terminal event. **[Observed]** (M3 findings §6.1–§6.3). This is exactly what Claude Code's
  documented convention predicts (2 = blocking, other nonzero = non-blocking warning), so nothing
  here looks version-sensitive; 2.1.234 behaves as documented.

  **The consequence, which is the point of the measurement.** M3 **must not** treat "settings file
  written" as "pause gate armed". A syntactically valid settings file with a wrong or unexecutable
  absolute `command` path produces a run that spawns cleanly, executes every tool call unimpeded,
  ignores the pause flag entirely, and terminates reporting success — `requestPause` would write the
  flag, nothing would deny, no `run.paused` would ever be emitted, and the operator would watch a
  "pausing" run keep working. **A positive check that the hook actually fires is therefore required
  before a run is treated as pausable.** **[Observed basis]** The design of that check is deliberately
  not proposed here (it lands in Task 6); the measurement constrains it in one way only — a *static*
  check (path exists, is `+x`) catches 126 and 127 but **not** exit 1, a hook that is present,
  executable, and broken. Only observing the hook fire distinguishes those. Note also that the live
  `hook_response` does carry `exit_code`/`outcome`, so a fail-open gate is **detectable** mid-stream —
  but it arrives concurrently with the tool it failed to gate, so the stream supports detection
  after the fact, never prevention.

  **What this does not cover:** a **signal-killed** hook and a hook that **exceeds its timeout** were
  not measured — a timeout is a plausible production mode (a slow check on a loaded host) and the
  documented convention says nothing about which side of the line it falls. Exit codes were sampled
  (`1`, `126`, `127`), not enumerated; any other nonzero code is **[Inferred]** to behave the same.
  Only `Write` and `Bash` were left ungated. And Q9 used purpose-built probe hooks, not
  `pause-gate.sh` itself — that a real `pause-gate.sh` failing this way leaves pause disabled is
  **[Inferred]** from the shared mechanism, not separately observed.
