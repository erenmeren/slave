import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** The two gate scripts, by the basename each is deployed under. */
export type GateScriptName = 'pause-gate.sh' | 'cursor-shell-gate.sh'

/**
 * Copies one of the repo's real gate scripts into `dir` AND the shared library it sources into
 * `<dir>/lib/`, returning the path of the copied script.
 *
 * Several suites here deploy a gate by copying it into a temp directory and running the pre-flight
 * probe against the copy -- a fresh executable copy per test, because some of them mutate its
 * permissions and the repo's own file has no business being touched by that. M13 §4.2 moved
 * `json_string` and the pause-flag read into `scripts/lib/pause-flag.sh`, which both gates now
 * `source` from a `lib/` directory beside their own resolved location, so copying the script ALONE
 * produces a gate that exits 2 on every invocation ("deployed without its library"). That is the
 * correct fail-closed behaviour -- it is what makes an `AITEAMOS_HOOK_PATH` override pointing at a
 * lone copy refuse loudly instead of silently gating nothing -- but it means a fixture must copy
 * the pair, not the file.
 *
 * This exists once, rather than five times, so the next change to the gates' on-disk layout has one
 * place to be made instead of five places to be missed.
 */
export function copyGateInto(dir: string, script: GateScriptName): string {
  const scriptPath = path.join(dir, script)
  copyFileSync(path.join(repoRoot, 'scripts', script), scriptPath)
  // The executable bit explicitly, not inherited: `preflightGate` spawns this path directly, and a
  // non-executable hook is one of the conditions those suites deliberately assert on elsewhere.
  chmodSync(scriptPath, 0o755)

  const libDir = path.join(dir, 'lib')
  mkdirSync(libDir, { recursive: true })
  const libPath = path.join(libDir, 'pause-flag.sh')
  copyFileSync(path.join(repoRoot, 'scripts/lib/pause-flag.sh'), libPath)
  // Sourced, never executed -- mirroring the repo's own 0644 on it.
  chmodSync(libPath, 0o644)

  return scriptPath
}
