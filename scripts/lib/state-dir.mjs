// scripts/lib/state-dir.mjs — "where this gate's run directories go, and who removes them"
//
// M52 R4 moved a run's own files OUT of the repository the worker edits and into
// `$SLAVEOFAI_STATE_DIR ?? $XDG_STATE_HOME/slaveofai ?? ~/.local/state/slaveofai`
// (`packages/control/src/paths.ts`). That is the right place for a real deployment and the wrong
// place for a gate: a gate spawns daemons that start runs, nothing in the product removes a run
// directory when the run ends, and no repo-scoped cleanup can reach outside the repository. The
// measured consequence, on the machine this was written on, was **1,645 directories and 14 MB in
// one operator's `$HOME`, every one of them created in a single afternoon** — Task 2's C1 finding,
// reproduced by Task 6's own ladder run.
//
// So every gate gets its own state root under `os.tmpdir()`, created once per process and removed
// when the process exits. ONE PLACE, not twenty-eight copies of the same three lines: this module
// is imported by `scripts/lib/child-env.mjs`, which every gate that spawns a daemon through
// `loopbackChildEnv` already goes through, and directly by the five older gates that build a child
// environment by hand (`gate-m8-plan`, `gate-m8a-estop`, `gate-m8a-merge`, `gate-m10-org`,
// `gate-m12-providers`).
//
// IT SETS `process.env` AND NOT ONLY THE CHILD'S, deliberately. A gate that derives a run
// directory in its own process -- `gate-m52-broker.mjs` reads a run's `permissions.json` and writes
// onto its broker channel -- would otherwise derive one root while its daemon wrote under another,
// and would be measuring an empty directory. One root per gate process, shared by every child it
// spawns, is the only arrangement in which the gate and the daemon agree.
//
// AN OPERATOR'S OWN `SLAVEOFAI_STATE_DIR` WINS and nothing is created: a gate that already chose a
// root (or a person debugging one by hand) is not overruled, and `gate-m52-broker.mjs` -- which
// makes and removes its own, because stage 11 asserts against it by name -- keeps doing exactly
// that.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let created = null

/**
 * This process's `SLAVEOFAI_STATE_DIR`, creating and registering one the first time it is asked.
 *
 * Idempotent: the second call returns the first call's answer. Removal is on `process.exit`, which
 * is synchronous and therefore can only use `rmSync` -- a gate killed with SIGKILL leaves its
 * directory behind, but under `/tmp` rather than under `$HOME`, which is the whole point.
 */
export function gateStateDir() {
  const existing = process.env['SLAVEOFAI_STATE_DIR']
  if (existing !== undefined && existing !== '') return existing
  if (created !== null) return created
  created = mkdtempSync(join(tmpdir(), 'slaveofai-gate-state-'))
  process.env['SLAVEOFAI_STATE_DIR'] = created
  process.on('exit', () => {
    try {
      rmSync(created, { recursive: true, force: true })
    } catch {
      /* a temp directory that outlives its gate is a nuisance, never a failure */
    }
  })
  return created
}
