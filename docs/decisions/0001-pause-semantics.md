# ADR 0001 — Pause Semantics

**Status:** Accepted
**Date:** 2026-08-17
**Context:** Spec §7 (provider adapter), §8 (pause/resume/checkpoints), §9.2 (guardrails and
permissions), §10 (git model); spike findings in
`docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md`

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

### 4. Detecting the pause: two denial shapes, never conflated

- **Permission-mode denial:** `{"type":"system","subtype":"permission_denied","tool_name":...,
  "tool_use_id":...,"message":"Claude requested permissions to ..."}` (findings 1). **[Observed]**
- **Hook denial:** produces **no `permission_denied` event whatsoever.** The live signal is
  `{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:<Tool>","output":"<JSON
  string>"}` whose `output` parses to `hookSpecificOutput.permissionDecision == "deny"`, followed by
  a `tool_result` carrying `is_error: true` and the deny reason as its content (findings 3.5).
  **[Observed]**

M3's stream parser must handle both and must not conflate them. The difference is operational, not
cosmetic: a permission-mode denial means the run is misconfigured and will accomplish nothing
(map it to `guardrail.tripped`), while a hook denial means the run is pausing as instructed (map it
to `run.paused`). An orchestrator that read the first as the second would wait forever to resume a
run that was never paused.

Three parser requirements follow from the captures. **[Observed]**

1. `hook_response.output` is a **JSON-encoded string**, not a nested object. It needs a second parse.
2. `hook_response` carries **no `tool_use_id`** — only `hook_name`. Correlate to a specific call via
   the `tool_result` that follows it.
3. The terminal `result` event's `permission_denials` array records both kinds of denial with
   `tool_name`, `tool_use_id`, and `tool_input` — useful for the checkpoint, but it arrives at the
   end of the run and is therefore useless as a live pause signal.

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
- **`pause-gate.sh`'s exit-2 crash path was never exercised by a real `claude` run**
  (findings 3.10). It was verified standalone against `/dev/full`. Whether that path fails closed is
  Q7 — the limitation is recorded here, the measurement that would settle it is there.
- **The `$AITEAMOS_SPIKE` variable form in `settings.json` was never tested** (findings 3.1); only
  the absolute-path form. §3 makes absolute paths mandatory, which is why this stays a limitation
  rather than becoming an open question.
- **A denied `Edit` was never observed** (findings 3.7); both denied calls were read-only. See Q8.
  Not settled by findings §7 either: that task's denied call was a `Bash` invocation, not an `Edit`.
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
  directory: exit code `0`, same session id, and — with no `Read` tool call preceding it — the
  resumed run's first line of text correctly named the exact pre-kill state on disk, evidence the
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
- **Q7 — Does a crashing hook fail closed?** `pause-gate.sh`'s exit-2 path was verified standalone
  against `/dev/full` but never exercised by a real `claude` run; no capture shows a nonzero-exit
  `hook_response` (findings 3.10). If Claude Code's general exit-code convention does not apply
  here, a crashing pause hook could fail **open** — the tool call proceeds and the pause silently
  does not happen. *Settles it:* register a hook that exits 2 and observe whether the tool call
  runs.
- **Q8 — Can a denied `Edit` ever partially apply?** Both denied calls in the spike were read-only.
  `PreToolUse` fires before the tool executes, so a denied `Edit` should never apply at all, but
  this is inferred from the hook's documented timing, not observed (findings 3.7). *Settles it:* a
  pause triggered while an `Edit` is the pending call.
