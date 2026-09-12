import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Where a TEST's run directories go, and who removes them (M52 Task 2's C1, placed in Task 6 fix
 * round 1).
 *
 * M52 R4 moved a run's own files -- `permissions.json`, the pause flag, the tool-results tap, the
 * broker channel -- out of the repository the worker edits and into
 * `$SLAVEOFAI_STATE_DIR ?? $XDG_STATE_HOME/slaveofai ?? ~/.local/state/slaveofai`
 * (`packages/control/src/paths.ts`). That is right for a deployment and wrong for a test suite:
 * fourteen test files call `runFilePaths`/`runDirPathFor`, nothing in the product removes a run
 * directory when the run ends, and the per-test TRUNCATE that resets the database cannot reach a
 * directory outside the repository. Measured on the machine this was written on: **1,645
 * directories and 14 MB in one operator's `$HOME`, every one created in a single afternoon.**
 *
 * ONE temp root per worker process, created when the setup file loads and removed when the process
 * exits. Removal is an `exit` handler, which may only do synchronous work, so it is `rmSync`; a
 * worker killed with SIGKILL leaves its directory behind, but under `/tmp` rather than under
 * `$HOME`, which is the whole difference.
 *
 * Loaded by BOTH vitest projects (`vitest.config.ts`), not only the integration one: the files that
 * create run directories are split across them -- `apps/orchestrator/test/integration/tick.test.ts`
 * and seven `packages/control/test/integration/*` files on one side,
 * `packages/providers/test/run-preparation.test.ts` on the other -- and one root per worker is the
 * same answer for both.
 *
 * AN ALREADY-CHOSEN ROOT WINS and nothing is created: a developer debugging with their own
 * `SLAVEOFAI_STATE_DIR` exported is not overruled, and a test that sets its own inside a case keeps
 * doing exactly that.
 */
if ((process.env['SLAVEOFAI_STATE_DIR'] ?? '') === '') {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-test-state-'))
  process.env['SLAVEOFAI_STATE_DIR'] = dir
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a temp directory that outlives its worker is a nuisance, never a failed test */
    }
  })
}
