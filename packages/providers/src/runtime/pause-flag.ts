import { rm, stat } from 'node:fs/promises'
import { isRecord } from './summary.js'

/**
 * Clears `flagPath` and verifies it is actually gone -- the load-bearing half of every runtime's
 * `resume()` contract (ADR 0001 §5/§6, findings 3.10, 4.2).
 *
 * A plain `rm` succeeding is not itself proof the flag is absent: `rm(path, { force: true })`
 * without `recursive: true` throws rather than removing a DIRECTORY sitting at `flagPath` (an
 * anomalous but real way a "flag file" can fail to be a plain file), and `force` only ever
 * suppresses the file-already-missing case. Swallowing whatever `rm` throws and treating the
 * following `stat` as the single source of truth is simpler than classifying every way removal can
 * fail, and just as safe: either the flag is gone, in which case nothing above needed to know why,
 * or it is still there, in which case this throws regardless of the reason.
 *
 * `adapterName` and `gateNoun` keep each runtime's message byte-identical to the one it raised
 * before this function was shared -- Claude says "the hook deny", Cursor says "the gate deny",
 * and both name their own class so an operator reading a stack knows which runtime refused.
 */
export async function clearAndVerifyPauseFlagAbsent(input: {
  readonly flagPath: string
  readonly runId: string
  /** The adapter class name that opens the error, e.g. `'ClaudeCodeAdapter'`. */
  readonly adapterName: string
  /** What denies on this runtime -- `'hook'` for Claude, `'gate'` for Cursor. */
  readonly gateNoun: string
}): Promise<void> {
  try {
    await rm(input.flagPath, { force: true })
  } catch {
    // Deliberately swallowed -- see the function comment. The `stat` below decides.
  }
  try {
    await stat(input.flagPath)
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return // confirmed absent -- safe to resume
    throw error
  }
  throw new Error(
    `${input.adapterName}: refusing to resume run ${input.runId} -- its pause flag at ${input.flagPath} ` +
      'still exists after an attempt to clear it. Resuming with the flag present would have the ' +
      `${input.gateNoun} deny every tool call the resumed run attempts, producing a run that looks ` +
      'like a pause loop rather than a resumed one.',
  )
}
