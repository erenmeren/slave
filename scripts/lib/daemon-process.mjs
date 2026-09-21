// scripts/lib/daemon-process.mjs — "is there a real orchestrator daemon running, and which pids?"
//
// Extracted verbatim from `gate-m17-stability.mjs`, which is where the reasoning was first written
// down and which now imports it from here. A second gate (`gate-m36-messaging.mjs`) has to answer
// the same question — it STOPS a daemon and STARTS another one, and "the new process is a real
// daemon, and the old one is gone" is the whole point of that stage — and gate-m17 cannot be
// imported to get it: that file IS its own gate, running the full suite five times as a side
// effect of being loaded.
//
// The reasoning, unchanged from gate-m17's header:
//
// `pgrep -f 'cli.js daemon'` is not enough on its own: it matches against the FULL command line of
// every process on the host, and a gate is routinely launched from a wrapper shell whose own
// `bash -c '... eval "...cli.js daemon..." ...'` argv contains the literal substring "cli.js
// daemon" (observed repeatedly across M17 — see that milestone's task-7 and task-11 reports, and
// progress.md's flake ledger). Under that wrapper, `pgrep -f 'cli.js daemon'` finds a "hit" that is
// the gate's OWN ancestry, not an orchestrator daemon, and the gate refuses to run at all — a gate
// that fails on its own shadow is exactly the kind of flake M17 existed to kill.
//
// The fix: use `pgrep -f` only as a cheap CANDIDATE list, then confirm each candidate PID is
// actually a node orchestrator daemon by reading its real argv out of /proc/<pid>/cmdline (null-
// byte separated, unlike the space-joined string `ps`/`pgrep -a` print, which is exactly what let
// the substring match through in the first place). A genuine daemon invocation is always
// `node .../cli.js daemon [...]` — two ADJACENT, EXACT argv entries: one path ending in `cli.js`,
// immediately followed by the literal argv `daemon`. A wrapper shell's `bash -c '<one long string
// containing "cli.js daemon">'` fails this: the whole thing is a SINGLE argv entry, so it can never
// contain "cli.js" and "daemon" as two separate elements. Only a real daemon child process (or a
// deliberately crafted impersonation, which is not a threat model these gates need to defend
// against) passes.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Whether `pid` is, right now, a real `node .../cli.js daemon ...` process. */
export function isRealDaemonProcess(pid) {
  let cmdline
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'latin1')
  } catch {
    return false // process already gone, or /proc unreadable (e.g. non-Linux) — not a match either way
  }
  const argv = cmdline.split('\0').filter((part) => part !== '')
  for (let i = 0; i < argv.length - 1; i += 1) {
    if ((argv[i] === 'cli.js' || argv[i].endsWith('/cli.js')) && argv[i + 1] === 'daemon') return true
  }
  return false
}

/**
 * The daemon pids a gate is told to look past: `SLAVEOFAI_GATE_IGNORE_DAEMON_PIDS`, comma-separated
 * (H9a).
 *
 * WHEN THIS IS LEGITIMATE, AND ONLY THEN: a daemon known to be serving ANOTHER database and another
 * state directory -- a person's own installation on the dev database while the gate runs on
 * `GATE_DATABASE_URL` with the state root `state-dir.mjs` mints. Such a daemon cannot tick the
 * gate's workspace, cannot hold its global concurrency budget and cannot see its run directories,
 * so the refusal every daemon-driven gate makes ("somebody else's ticks") does not apply to it. A
 * daemon on the SAME database is exactly what the refusal exists for, and naming it here makes the
 * gate measure that daemon's ticks as its own; nothing here can tell the two apart, which is why
 * this is an explicit, per-pid, operator-set list and never a blanket switch.
 *
 * A token that is not a positive integer is ignored rather than refused: the variable is a
 * developer's convenience on one machine, and a typo in it should cost a refusal to run (the
 * daemon is then found as before), not a crash in a preflight.
 */
function ignoredDaemonPids() {
  const raw = process.env['SLAVEOFAI_GATE_IGNORE_DAEMON_PIDS'] ?? ''
  return new Set(
    raw
      .split(',')
      .map((token) => token.trim())
      .filter((token) => /^[0-9]+$/u.test(token))
      .map((token) => Number(token))
      .filter((pid) => pid > 0),
  )
}

/** Every pid on this host that `isRealDaemonProcess` confirms, less the ones
 *  `SLAVEOFAI_GATE_IGNORE_DAEMON_PIDS` names (see {@link ignoredDaemonPids} for when that is
 *  legitimate). Empty when none is running. */
export function findRealDaemonPids() {
  const ignored = ignoredDaemonPids()
  const candidates = spawnSync('pgrep', ['-f', 'cli.js daemon'], { encoding: 'utf8' })
  return (candidates.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => Number(line))
    .filter((pid) => !ignored.has(pid))
    .filter((pid) => isRealDaemonProcess(pid))
}
