import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { promisify } from 'node:util'

/** Room for a diff that touched a very large tree: execFile's 1 MiB default made the audit throw. */
export const DIFF_MAX_BUFFER = 64 * 1024 * 1024
/** Bounded, like every git call made on a run's behalf: a contended repository must not hang a
 *  conclusion, nor hold a merge claim. */
export const DIFF_TIMEOUT_MS = 30_000

const execFileAsync = promisify(execFile)

/**
 * The one door to `execFile` for a name list. An object rather than a bare import so a test can
 * assign a failing wrapper for one call and restore it in `finally` (an ESM binding cannot be
 * reassigned from outside, and `vi.spyOn` on it does not reach the callers).
 */
export const gitNameList = {
  execFile: (file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding): Promise<{ stdout: string }> =>
    execFileAsync(file, args, options),
}

/**
 * The paths a `git diff --name-only -z ...` prints, exactly. `execFile` directly, not `gitIn`
 * (ownership final review I2, Conductor Plan 5 fix round 1): `gitIn` trims its output, which cut
 * the leading space off the first path, and its default buffer is 1 MiB, which dropped a large
 * list. `args` are git's, and must include `-z`: a path with a newline or a quote stays one entry.
 */
export async function gitNameOnlyZ(cwd: string, args: readonly string[]): Promise<readonly string[]> {
  const { stdout } = await gitNameList.execFile('git', args, {
    cwd,
    maxBuffer: DIFF_MAX_BUFFER,
    timeout: DIFF_TIMEOUT_MS,
    encoding: 'utf8',
  })
  return stdout.split('\0').filter((name) => name !== '')
}
