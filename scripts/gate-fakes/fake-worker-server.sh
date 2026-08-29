#!/usr/bin/env bash
# A stand-in for the DETACHED background process a real vendor CLI leaves behind.
#
# `cursor-agent` spawns a per-repository `worker-server` (plus a `tsserver` family) that outlives
# the run and is on no `AgentRun` row -- documented at
# `packages/providers/src/cursor/adapter.ts:355-360`. Nothing in the orchestrator records its pid,
# so the gate's record-based kill (every `AgentRun.pid`, Decision 12) cannot reach it: the only
# thing that can is the sweep that looks for processes still living inside the gate's own temporary
# repositories.
#
# This exists so that EVERY rehearsal exercises that sweep rather than only a special one. It is
# started by both fakes, inside the run's worktree, and it IGNORES SIGTERM -- so a gate that sweeps
# politely, or sweeps before it has stopped the daemon, leaves it behind and `pgrep` finds it after
# the gate has exited.
#
# Bounded at ten minutes so a rehearsal that crashes before its own `finally` cannot leave this
# running on the operator's machine forever.
trap '' TERM INT HUP
sleep 600
