import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitIn } from '@slave-of-ai/control'

const execFileAsync = promisify(execFile)

/**
 * The diff a reviewer is shown, built so that it can ALWAYS be built (2026-09-20).
 *
 * `dispatchReview` used to read `git diff base...head` in one call through `gitIn`, whose child
 * runs with Node's default 1 MB stdout buffer, and truncated the TEXT afterwards. A worker that
 * committed full-page screenshots and Lighthouse reports (3.5 MB of diff for one audit task) made
 * that read throw `stdout maxBuffer length exceeded` before the reviewer was ever spawned: two
 * review runs failed in 24 ms each, the retry cap tripped, the Supervisor sent the task to rework,
 * the next attempt produced the same branch, and the task ended `blocked` for a human -- over a
 * diff nobody had asked a model to read in full.
 *
 * So the diff is built per file from `--numstat`, which is small however large the change: a
 * binary file is named with its size and never read; a text file's hunks are read with a buffer
 * large enough for any single file and cut at {@link PER_FILE_CHAR_LIMIT}; the whole text is cut
 * at {@link DIFF_CHAR_LIMIT}, after which the remaining files are listed by name only. `capped`
 * says the reviewer saw a subset, exactly as it did before.
 */

/** The whole diff text a reviewer is shown, past which files are listed by name only. */
export const DIFF_CHAR_LIMIT = 60_000
/** One file's hunks, past which they are cut with a marker -- so one generated file cannot use
 *  the whole budget and hide every other change. */
export const PER_FILE_CHAR_LIMIT = 20_000
/** The stdout buffer for ONE file's diff. 64 MB is far past any single file a reviewer could
 *  read; a file whose diff exceeds it is listed as unreadable rather than failing the review. */
const PER_FILE_STDOUT_BYTES = 64 * 1024 * 1024

export interface ReviewDiff {
  readonly text: string
  /** Something was left out: a file cut, a file listed by name only, or a file unreadable. */
  readonly capped: boolean
  /** How many files the range touches, for the event payload. */
  readonly files: number
}

interface NumstatRow {
  readonly path: string
  readonly added: number | null
  readonly deleted: number | null
  readonly binary: boolean
}

function parseNumstat(text: string): readonly NumstatRow[] {
  const rows: NumstatRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const [added, deleted, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (added === undefined || deleted === undefined || path === '') continue
    const binary = added === '-' && deleted === '-'
    rows.push({
      path,
      added: binary ? null : Number(added),
      deleted: binary ? null : Number(deleted),
      binary,
    })
  }
  return rows
}

async function blobSize(repoPath: string, head: string, path: string): Promise<number | null> {
  try {
    const out = await gitIn(repoPath, 'cat-file', '-s', `${head}:${path}`)
    const n = Number(out)
    return Number.isFinite(n) ? n : null
  } catch {
    // A file deleted on the branch has no blob at `head`; its size is not a fact worth failing for.
    return null
  }
}

async function fileDiff(repoPath: string, range: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-color', range, '--', path], {
      cwd: repoPath,
      maxBuffer: PER_FILE_STDOUT_BYTES,
    })
    return stdout
  } catch {
    return null
  }
}

/**
 * Builds the reviewer's diff for `base...head` in `repoPath`. Throws only when the range itself
 * cannot be diffed (a branch gone from git), which is the one failure `dispatchReview` already
 * concludes as a failed run.
 */
export async function buildReviewDiff(repoPath: string, base: string, head: string): Promise<ReviewDiff> {
  const range = `${base}...${head}`
  const rows = parseNumstat(await gitIn(repoPath, 'diff', '--numstat', range))

  const summary: string[] = [`${String(rows.length)} file(s) changed in ${range}:`]
  for (const row of rows) {
    summary.push(
      row.binary
        ? `  ${row.path} (binary)`
        : `  ${row.path} (+${String(row.added ?? 0)} / -${String(row.deleted ?? 0)})`,
    )
  }

  const parts: string[] = [summary.join('\n'), '']
  let used = parts.join('\n').length
  let capped = false
  const unshown: string[] = []

  for (const row of rows) {
    if (used >= DIFF_CHAR_LIMIT) {
      unshown.push(row.path)
      continue
    }
    if (row.binary) {
      const size = await blobSize(repoPath, head, row.path)
      const line = `Binary file ${row.path}${size === null ? '' : ` (${String(size)} bytes)`} -- not shown.`
      parts.push(line, '')
      used += line.length + 2
      continue
    }
    const raw = await fileDiff(repoPath, range, row.path)
    if (raw === null) {
      const line = `diff for ${row.path} could not be read -- not shown.`
      parts.push(line, '')
      used += line.length + 2
      capped = true
      continue
    }
    let hunk = raw
    if (hunk.length > PER_FILE_CHAR_LIMIT) {
      hunk = `${hunk.slice(0, PER_FILE_CHAR_LIMIT)}\n[diff for ${row.path} truncated after ${String(PER_FILE_CHAR_LIMIT)} characters]`
      capped = true
    }
    const room = DIFF_CHAR_LIMIT - used
    if (hunk.length > room) {
      hunk = `${hunk.slice(0, Math.max(0, room))}\n[diff truncated]`
      capped = true
    }
    parts.push(hunk)
    used += hunk.length + 1
  }

  if (unshown.length > 0) {
    capped = true
    parts.push('', `[diff truncated: ${String(unshown.length)} more file(s) not shown: ${unshown.join(', ')}]`)
  }

  return { text: parts.join('\n'), capped, files: rows.length }
}
