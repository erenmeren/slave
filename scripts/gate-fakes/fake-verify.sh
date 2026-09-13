#!/usr/bin/env bash
# A scripted verify command, for `scripts/gate-m53-evidence.mjs` (M53 §3).
#
# The FIFTH fake in this directory. `fake-claude.sh` and `fake-cursor-agent.sh` pretend to be a
# worker, `fake-deploy.sh` pretends to be the thing a worker may not touch, `fake-worker-server.sh`
# pretends to be a daemon -- and this pretends to be `Workspace.verifyCommands`, so a gate can decide
# which task's FIRST verify fails and which passes, and prove that `verifiedFirstPass` says the
# difference.
#
# It takes its state file from ARGV -- `--state <path>` -- and never from the environment, the
# `fake-deploy.sh` precedent for the same reason spelled out differently: a verify child is spawned
# by `runShellCommand` (`apps/orchestrator/src/shell.ts:105`) with `/bin/sh -c "<the command>"` and
# the DAEMON's environment, which a gate can set, but the command line is `Workspace.verifyCommands`
# -- a row a person wrote -- and that is exactly where a scripted verification's own configuration
# belongs. Putting it in argv also means two workspaces can carry two different scripts without two
# daemons.
#
# THE RULE IS ONE LINE: while the state file exists, this exits 1 AND REMOVES IT; afterwards it
# exits 0. So a gate that touches the file before a dispatch gets "fails once, passes on the rework",
# and a gate that does not gets "passes first time" -- which is the whole difference between the two
# profiles' records in stages 2 and 7.
set -uo pipefail

state=''
prev=''
for arg in "$@"; do
  if [ "$prev" = '--state' ]; then state="$arg"; fi
  prev="$arg"
done

# Exit 3, not 1: `advance()` reads a 1 as "the commands turned this work down" and would charge the
# task an attempt for the fake being misconfigured. 3 says the FAKE is wrong, not the work.
if [ -z "$state" ]; then
  printf 'fake-verify.sh: no state path -- pass `--state <path>` in the workspace verify command.\n' >&2
  exit 3
fi

if [ -f "$state" ]; then
  rm -f "$state"
  printf 'fake-verify.sh: scripted failure (the state file said so, and is now gone)\n' >&2
  exit 1
fi

printf 'fake-verify.sh: ok\n'
exit 0
