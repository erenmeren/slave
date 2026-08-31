// scripts/gate-m17-stability.mjs — M17's closing proof, zero spend, CI-runnable.
// (1) the full suite runs five times consecutively — any red is a FAIL to investigate, never
//     retry; per-run wall-clock is printed so drift is visible.
// (2) the duplication census holds (one definition site per consolidated runtime block).
// (3) the equivalence tests that license the M17 query rewrites still exist — the suite runs
//     them, this check stops a silent deletion from passing.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// ---- Daemon check, hardened. -------------------------------------------------------------------
// `pgrep -f 'cli.js daemon'` is not enough on its own: it matches against the FULL command line of
// every process on the host, and this gate is routinely launched from a wrapper shell whose own
// `bash -c '... eval "...cli.js daemon..." ...'` argv contains the literal substring "cli.js
// daemon" (observed repeatedly across this milestone — see the M17 SDD workspace's task-7 and
// task-11 reports, and progress.md's flake ledger). Under that wrapper, `pgrep -f 'cli.js daemon'`
// finds a "hit" that is this gate's OWN ancestry, not an orchestrator daemon, and refuses to run at
// all — a gate that fails on its own shadow is exactly the kind of flake this milestone exists to
// kill.
//
// The fix: use `pgrep -f` only as a cheap CANDIDATE list, then confirm each candidate PID is
// actually a node orchestrator daemon by reading its real argv out of /proc/<pid>/cmdline (null-
// byte separated, unlike the space-joined string `ps`/`pgrep -a` print, which is exactly what let
// the substring match through in the first place). A genuine daemon invocation is always
// `node .../cli.js daemon [...]` — two ADJACENT, EXACT argv entries: one path ending in `cli.js`,
// immediately followed by the literal argv `daemon`. A wrapper shell's `bash -c '<one long string
// containing "cli.js daemon">'` fails this: the whole thing is a SINGLE argv entry, so it can never
// contain "cli.js" and "daemon" as two separate elements. Only a real daemon child process (or a
// deliberately crafted impersonation, which is not a threat model this gate needs to defend
// against) passes.
function isRealDaemonProcess(pid) {
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

const daemonCandidates = spawnSync('pgrep', ['-f', 'cli.js daemon'], { encoding: 'utf8' })
const candidatePids = (daemonCandidates.stdout ?? '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => Number(line))
const realDaemonPids = candidatePids.filter((pid) => isRealDaemonProcess(pid))
if (realDaemonPids.length > 0) {
  console.error(
    `gate:m17-stability REFUSED — an orchestrator daemon is running (pid ${realDaemonPids.join(', ')}); ` +
      'it skews the cluster LISTEN count the events tests measure',
  )
  process.exit(1)
}

const REQUIRED_TESTS = [
  'apps/web/test/integration/skill-call-totals.test.ts',
  'apps/web/test/integration/analytics-aggregates.test.ts',
  'apps/web/test/integration/org-spend-groups.test.ts',
  'packages/domain/test/spend-groups.test.ts',
]
for (const file of REQUIRED_TESTS) {
  if (!existsSync(file)) {
    console.error(`gate:m17-stability FAIL — equivalence test missing: ${file}`)
    process.exit(1)
  }
}

const durations = []
for (let i = 1; i <= 5; i += 1) {
  const start = Date.now()
  const run = spawnSync('npm', ['test'], { stdio: 'inherit' })
  const ms = Date.now() - start
  durations.push(ms)
  if (run.status !== 0) {
    console.error(`gate:m17-stability FAIL — suite run ${i}/5 exited ${run.status} after ${ms} ms. Investigate; do not re-run to green.`)
    process.exit(1)
  }
  console.log(`gate:m17-stability — suite run ${i}/5 GREEN in ${ms} ms`)
}

const census = spawnSync('bash', ['scripts/census-runtime.sh'], { stdio: 'inherit' })
if (census.status !== 0) {
  console.error('gate:m17-stability FAIL — duplication census')
  process.exit(1)
}

console.log('gate:m17-stability PASS')
console.log(durations.map((ms, i) => `  run ${i + 1}: ${ms} ms`).join('\n'))
