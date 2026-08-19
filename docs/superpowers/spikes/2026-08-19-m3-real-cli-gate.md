# M3 milestone gate: the hand-run against the real CLI

**Date:** 2026-08-19
**Claude Code version:** 2.1.235
**Purpose:** Spec §16 requires gate steps 3–4 — a real `claude` run in a provisioned worktree, and
pause/checkpoint/resume of that run — to be exercised once by hand against the real CLI, with the
captures recorded. This document is that record.

## What ran against what

| Gate step | Against the fake (CI, `milestone-gate.test.ts`) | Against the real CLI (this run) |
|---|---|---|
| 1. Ready task picked up by a tick | yes | yes |
| 2. Worktree provisioned, setup ran | yes | yes |
| 3. Real run executes, events land in the log | fake stand-in | **yes** |
| 4. Pause, checkpoint, resume | fake stand-in | **yes** |
| 5. Verify commands run on the result | yes | yes |
| 6. Green → `done` + branch; red → `rework` + failure | yes | green only (red is CI-covered) |

Both live runs were driven through the same commands an operator uses, with no environment
overrides — `AITEAMOS_CLAUDE_BIN` unset, so the adapter spawned the real `claude` from `PATH`
down the same code path the fake exercises in CI.

## Green path (workspace "Live Gate A")

Seeded: one `ready` task ("Create hello.txt", verify `grep -q "hello from the real gate" hello.txt`,
setup `echo setup-ran > setup-marker`), then:

```
node --env-file=.env apps/orchestrator/dist/cli.js tick --workspace 0f0ab830-…
→ { "started": ["ae5c7c00-…"], "halted": null, "skippedNoRole": 0 }, exit 0
```

Result:

- Run `ae5c7c00` concluded `succeeded`: pid recorded, 2 tool calls, cost $0.437, session id captured
  from the child's `system/init` line.
- Worktree at `…/live-gate-a/.aiteamos/worktrees/T-430b9b84` with `setup-marker` present (setup ran
  in it) and `hello.txt` committed by the agent **as `Gate Runner <gate-runner@aiteamos.local>`** —
  the per-run git identity held on a real commit.
- Task reached `done` with branch `aiteamos/T-430b9b84-create-hello-txt`, attempt 0.
- Verify artifact persisted outside the worktree
  (`…/.aiteamos/artifacts/<taskId>/attempt-01/01-grep-….log`, `command exit 0`).
- Event sequence, in order:
  `task.started, run.started, run.output, run.tool_call ×2, run.output, run.succeeded,
  task.verifying, task.verify_passed, task.done` — exactly the §8 order the gate test pins.

## Pause path (workspace "Live Gate B")

Seeded: one `ready` task ("Write six numbered notes", six files one per step, verify
`test -f note6.txt`). The tick was started, then paused mid-run from a second process:

```
tick --workspace 8d43a1b8-…          # run 117d2d60 starts, real claude working
pause --run 117d2d60-… --by meren    # after toolCalls reached 2
→ "pause_requested: the gate will deny 117d2d60-…'s next tool call", status paused ~4s later
resume --run 117d2d60-… --message "continue where you left off"
→ "resumed 117d2d60-… as pid 49849", exit 0
```

Result:

- The gate denied the live run's next tool call; the run reached `paused` with `pauseReason: human`.
- Checkpoint written from the pause: real session id, worktree path, `headCommit` of the agent's own
  mid-task commit, `numTurns: 4`, `lastToolName: Write`, `dirtyFiles: ["?? setup-marker"]`.
- Resume spawned a new pid against the same session and worktree, cleared the pause flag
  (only `settings.json` remains under `.aiteamos/runs/<runId>/`), and the continuation finished the
  remaining notes: 31 tool calls total, cost $1.028, run `succeeded`.
- All six `noteN.txt` files present in the worktree; verify green; task `done` with branch
  `aiteamos/T-c3bc0b40-write-six-numbered-notes`, attempt 0 — a resumed run's completion advances
  the task exactly like a fresh one.
- Event sequence (abridged): `task.started, run.started, …, run.pause_requested, run.tool_call,
  run.paused, (run.output, run.tool_call, run.paused) ×3, run.resumed, … , run.succeeded,
  task.verifying, task.verify_passed, task.done`.

## Findings the fake could not have shown

1. **The real CLI retries a denied tool call.** After the first deny the child attempted three more
   tool calls, each denied, before it settled — so one operator pause produced **four `run.paused`
   events** in the log. The pause protocol still converged (the run did stop, the checkpoint was
   written once, resume worked), but anything replaying the event log through the domain state
   machine will see `paused → paused` transitions. The fake's `hook-deny` fixture emits exactly one
   deny, so CI cannot see this shape. Carried to M4 as a log-consumer concern: either the pump
   should emit `run.paused` only on the transition (the same rule `guardrail.tripped` already
   follows), or replays must tolerate repeats.
2. **`Checkpoint.cumulativeCostUsd` was 0 at the pause point.** The real CLI reports cost on the
   terminal `result` line, which a paused run has not produced yet; mid-run there is nothing to
   sum. Expected from ADR 0001's measurements, now confirmed live. The *final* cost still landed on
   the run row at conclusion.

Raw stdout/stderr captures for both runs live in the session scratchpad
(`live-tick-a.out`, `live-tick-b.out`, `live-pause-b.out`, `live-resume-b.out`); the durable
evidence — worktrees, commits, artifacts, and the event log rows quoted above — is what this
document records.
