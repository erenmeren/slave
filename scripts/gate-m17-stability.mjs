// scripts/gate-m17-stability.mjs — M17's closing proof, zero spend, CI-runnable.
// (1) the full suite runs five times consecutively — any red is a FAIL to investigate, never
//     retry; per-run wall-clock is printed so drift is visible.
// (2) the duplication census holds (one definition site per consolidated runtime block).
// (3) the equivalence tests that license the M17 query rewrites still exist — the suite runs
//     them, this check stops a silent deletion from passing.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { findRealDaemonPids } from './lib/daemon-process.mjs'

// ---- Daemon check, hardened. -------------------------------------------------------------------
// The candidate-then-/proc/<pid>/cmdline confirmation, and the reason a naive `pgrep -f 'cli.js
// daemon'` matches this gate's own wrapper shell, now live in `scripts/lib/daemon-process.mjs` --
// `gate-m36-messaging.mjs` needs the same answer and cannot import this file, which runs the whole
// suite five times as a side effect of being loaded.
const realDaemonPids = findRealDaemonPids()
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
