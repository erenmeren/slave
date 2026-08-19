import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provisionWorktree } from '../../src/worktree.js'

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8' }).trim()
}

/**
 * A real repository on disk with one commit on `main`. Real git rather than a mock: every
 * behaviour this task has to get right -- that the branch is new, that the base branch does not
 * move, that `.git/config` is untouched -- is a property of git itself, and a mock that answers
 * them is a mock asserting its own script.
 *
 * The fixture writes its identity into its own `.git/config`, which is what makes the
 * common-directory test meaningful: the file is non-empty and already contains exactly the keys
 * the M0 spike saw an agent overwrite.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-worktree-'))
  run('git', ['init', '-q', '-b', 'main'], dir)
  run('git', ['config', 'user.name', 'Fixture'], dir)
  run('git', ['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  run('git', ['add', '-A'], dir)
  run('git', ['commit', '-q', '-m', 'initial'], dir)
  return dir
}

const headOf = (repoPath: string, ref: string): string => run('git', ['rev-parse', ref], repoPath)

describe('provisionWorktree', () => {
  let repoPath: string
  let base: {
    repoPath: string
    baseBranch: string
    taskKey: string
    slug: string
    setupCommands: readonly string[]
  }

  beforeEach((): void => {
    repoPath = makeRepo()
    base = {
      repoPath,
      baseBranch: 'main',
      taskKey: 'TASK-001',
      slug: 'add-thing',
      setupCommands: [],
    }
  })

  afterEach((): void => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('creates a worktree on its own branch from the base branch', async (): Promise<void> => {
    const wt = await provisionWorktree(base)

    expect(wt.branch).toBe('aiteamos/TASK-001-add-thing')
    expect(wt.path).toContain(join('.aiteamos', 'worktrees', 'TASK-001'))
    expect(existsSync(join(wt.path, '.git'))).toBe(true)

    // The branch is not merely *named*: it is the one checked out in the worktree, and it starts
    // at the base branch's commit. Asserting the name alone would pass for a worktree that
    // silently checked out `main` itself, which is the failure that would let two tasks share a
    // branch and overwrite each other's commits.
    expect(run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], wt.path)).toBe(wt.branch)
    expect(wt.headCommit).toBe(headOf(repoPath, 'main'))
  })

  it('runs the setup commands inside the worktree before returning', async (): Promise<void> => {
    // Two commands where the second only succeeds if the first already ran, so this pins the
    // *order* of the list rather than just that both executed.
    const wt = await provisionWorktree({
      ...base,
      setupCommands: ['touch SETUP_RAN', 'test -f SETUP_RAN && touch SETUP_ORDERED'],
    })

    expect(existsSync(join(wt.path, 'SETUP_RAN'))).toBe(true)
    expect(existsSync(join(wt.path, 'SETUP_ORDERED'))).toBe(true)
    // "inside the worktree": had cwd been the repository root, the file would land here instead.
    expect(existsSync(join(repoPath, 'SETUP_RAN'))).toBe(false)
  })

  it('gives setup commands a git identity through the environment', async (): Promise<void> => {
    const wt = await provisionWorktree({
      ...base,
      setupCommands: ['printenv GIT_AUTHOR_NAME > IDENTITY'],
    })

    // Spec §7.3 layer 1. A setup command that commits must not hit git's missing-identity error,
    // because the documented "helpful" recovery from it is an unscoped `git config` write into the
    // common directory that every sibling worktree shares.
    expect(readFileSync(join(wt.path, 'IDENTITY'), 'utf8').trim()).not.toBe('')
  })

  it('fails loudly when a setup command fails, and preserves the worktree', async (): Promise<void> => {
    const expectedPath = join(repoPath, '.aiteamos', 'worktrees', 'TASK-001')

    await expect(
      provisionWorktree({ ...base, setupCommands: ['echo boom >&2; exit 3'] }),
    ).rejects.toThrow(/setup command/)

    // Preserved, per spec §7.4: a half-provisioned worktree is the inspection surface for "how far
    // did setup get", and a removed directory cannot answer that.
    expect(existsSync(expectedPath)).toBe(true)
  })

  it('names the failing command, its exit code, and its output', async (): Promise<void> => {
    // "Loudly" is the requirement, and a bare `/setup command/` match is satisfied by a message
    // carrying none of the three things an operator needs to act on it.
    await expect(
      provisionWorktree({ ...base, setupCommands: ['echo boom >&2; exit 3'] }),
    ).rejects.toThrow(/exit 3[\s\S]*boom/)
  })

  it('leaves the base branch untouched', async (): Promise<void> => {
    const before = headOf(repoPath, 'main')

    await provisionWorktree(base)

    expect(headOf(repoPath, 'main')).toBe(before)
  })

  it('writes nothing to the git common directory', async (): Promise<void> => {
    const configPath = join(repoPath, '.git', 'config')
    const before = readFileSync(configPath, 'utf8')

    await provisionWorktree({ ...base, setupCommands: ['touch SETUP_RAN'] })

    // Spec §7.3, the general rule the M0 spike surfaced through a git-identity collision: worktrees
    // isolate refs and files, but `.git/config` is repo-wide state they do not isolate, so two
    // concurrent agents writing it silently overwrite each other.
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })
})
