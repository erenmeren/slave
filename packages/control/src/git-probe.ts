import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
/** A probe that hangs (a network-mounted repo, a stuck lock) must fail the verb, not the CLI. */
const PROBE_TIMEOUT_MS = 5_000

/** The two questions `createWorkspace` asks a path (spec §2 A1). Injectable so the verb's own
 *  tests never spawn git; `realGitProbe` is what production and the integration test use. */
export interface GitProbe {
  isRepository(path: string): Promise<boolean>
  branchExists(path: string, branch: string): Promise<boolean>
}

async function git(cwd: string, ...args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: PROBE_TIMEOUT_MS })
    return stdout.trim()
  } catch {
    return null
  }
}

export const realGitProbe: GitProbe = {
  async isRepository(path) {
    // `rev-parse --is-inside-work-tree` prints `true` only from inside a work tree; a bare repo
    // prints `false`, a non-repo exits 128. Both non-`true` answers refuse: the orchestrator
    // provisions worktrees off a checked-out base branch, which a bare repo does not have.
    return (await git(path, 'rev-parse', '--is-inside-work-tree')) === 'true'
  },
  async branchExists(path, branch) {
    return (await git(path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) !== null
  },
}
