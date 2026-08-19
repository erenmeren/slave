import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETUP_OUTPUT_LIMIT, WorktreeExistsError, provisionWorktree } from '../../src/worktree.js'

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], { cwd, encoding: 'utf8' }).trim()
}

/**
 * A real repository on disk with one commit on `main` and a second branch `develop` carrying a
 * commit of its own. Real git rather than a mock: every behaviour this task has to get right --
 * that the branch is new, that the base branch does not move, that `.git/config` is untouched --
 * is a property of git itself, and a mock that answers them is a mock asserting its own script.
 *
 * `develop` exists so that "from the base branch" is distinguishable from "from HEAD". With a
 * single branch the two are the same commit, and the test named for that property held under a
 * version of the code that dropped the base branch argument entirely.
 *
 * The fixture writes its identity into its own `.git/config`, which is what makes the
 * common-directory test meaningful: the file is non-empty and already contains exactly the keys
 * the M0 spike saw an agent overwrite. It is also what makes the identity test meaningful -- a
 * setup command that commits must come out with the *orchestrator's* name, not this one.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-worktree-'))
  run('git', ['init', '-q', '-b', 'main'], dir)
  run('git', ['config', 'user.name', 'Fixture'], dir)
  run('git', ['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  run('git', ['add', '-A'], dir)
  run('git', ['commit', '-q', '-m', 'initial'], dir)

  run('git', ['checkout', '-q', '-b', 'develop'], dir)
  writeFileSync(join(dir, 'DEVELOP.md'), '# develop\n')
  run('git', ['add', '-A'], dir)
  run('git', ['commit', '-q', '-m', 'develop commit'], dir)
  run('git', ['checkout', '-q', 'main'], dir)

  return dir
}

const headOf = (repoPath: string, ref: string): string => run('git', ['rev-parse', ref], repoPath)
const branches = (repoPath: string): readonly string[] =>
  run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoPath).split('\n')

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

  it('starts from the named base branch, not from wherever the repository happens to be', async (): Promise<void> => {
    // The fixture sits on `main`; provisioning from `develop` must follow the argument. Without a
    // second branch these two commits are the same one, and dropping `baseBranch` from the git
    // argv -- so the worktree forks from HEAD -- passes every other test in this file.
    const wt = await provisionWorktree({ ...base, baseBranch: 'develop' })

    expect(wt.headCommit).toBe(headOf(repoPath, 'develop'))
    expect(wt.headCommit).not.toBe(headOf(repoPath, 'main'))
    expect(existsSync(join(wt.path, 'DEVELOP.md'))).toBe(true)
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

  it('stops at the first failing setup command and runs none after it', async (): Promise<void> => {
    const worktreePath = join(repoPath, '.aiteamos', 'worktrees', 'TASK-001')

    await expect(
      provisionWorktree({ ...base, setupCommands: ['touch FIRST', 'exit 4', 'touch AFTER'] }),
    ).rejects.toThrow(/exit 4/)

    expect(existsSync(join(worktreePath, 'FIRST'))).toBe(true)
    // Running the list concurrently, or collecting failures and continuing, both produce AFTER --
    // and both are indistinguishable from correct behaviour by an ordering test alone. `npm ci`
    // then `npm run build` is the case: the second command's failure would be the one reported.
    expect(existsSync(join(worktreePath, 'AFTER'))).toBe(false)
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

  it('gives a committing setup command all four identity variables, and reads headCommit after it', async (): Promise<void> => {
    const wt = await provisionWorktree({
      ...base,
      setupCommands: ['git commit -q --allow-empty -m "setup commit"'],
    })

    // The behaviour §7.3 layer 1 actually protects, rather than the mechanism: a setup command
    // that commits comes out under the orchestrator's identity and not the repository's own. The
    // fixture's `.git/config` says `Fixture <fixture@example.com>`, so dropping any of the four
    // variables shows up here -- author and committer, name and email, are four distinct answers.
    const trailers = run('git', ['log', '-1', '--format=%an|%ae|%cn|%ce'], wt.path)
    expect(trailers).toBe('AI Team OS|orchestrator@aiteamos.local|AI Team OS|orchestrator@aiteamos.local')

    // And `headCommit` is read *after* setup: it answers "what did the run start from", which is
    // this new commit, not the base branch's tip. Reading it before the setup loop passes every
    // other test in this file.
    expect(wt.headCommit).toBe(run('git', ['rev-parse', 'HEAD'], wt.path))
    expect(wt.headCommit).not.toBe(headOf(repoPath, 'main'))
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
    // The marker is *computed* by the command rather than spelled in it, so this cannot pass on
    // the command string being echoed back into the message. Asserting on a literal the command
    // contains -- `boom` in `echo boom >&2; exit 3` -- passes with the captured output dropped
    // entirely, which is the one thing this test exists to forbid.
    await expect(
      provisionWorktree({ ...base, setupCommands: ['echo $((21 * 2)) >&2; exit 3'] }),
    ).rejects.toThrow(/exit 3[\s\S]*\b42\b/)
  })

  it('bounds a huge failure output and keeps its tail, where the error is', async (): Promise<void> => {
    const error = await provisionWorktree({
      ...base,
      setupCommands: [`seq 1 200000 >&2; echo LAST_LINE_MARKER >&2; exit 3`],
    }).then(
      (): Error => {
        throw new Error('expected provisioning to reject')
      },
      (cause: unknown): Error => cause as Error,
    )

    // Task 13 persists this message as the `run.failed` reason. A failing `npm ci` puts hundreds
    // of kilobytes into that column unless it is bounded here.
    expect(error.message.length).toBeLessThan(SETUP_OUTPUT_LIMIT * 2)
    // Bounded from the front: the last thing a failing command printed is the reason it failed.
    expect(error.message).toContain('LAST_LINE_MARKER')
    expect(error.message).toMatch(/truncated/)
  })

  it('names the signal when a setup command is killed rather than exiting', async (): Promise<void> => {
    // An OOM-killed `npm ci` or `tsc` reports no exit code at all. Reporting it as "exit unknown"
    // discards the single most diagnostic fact an operator has.
    await expect(provisionWorktree({ ...base, setupCommands: ['kill -9 $$'] })).rejects.toThrow(
      /SIGKILL/,
    )
  })

  it('does not mistake a chatty setup command for a failing one', async (): Promise<void> => {
    // `execFile`'s 1 MiB default buffer kills the child and rejects with
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER, which this function would have reported as the command's
    // exit code -- turning a succeeding `npm ci` into a provisioning failure that, per spec §13,
    // counts as an attempt against the task. It never shows up against a fixture repo whose setup
    // prints a few bytes.
    const wt = await provisionWorktree({ ...base, setupCommands: ['seq 1 400000'] })

    expect(wt.headCommit).toBe(headOf(repoPath, 'main'))
  })

  it('times out a hung setup command and takes its whole process group with it', async (): Promise<void> => {
    const marker = join(repoPath, 'GRANDCHILD_RAN')

    await expect(
      provisionWorktree({
        ...base,
        // A background grandchild is what `npm ci` actually is: the shell is not the process
        // holding the work. Killing only the shell unwedges the daemon and leaves the install
        // running, which was measured to happen with a plain `execFile` timeout.
        setupCommands: [`sh -c 'sleep 5; touch ${marker}' & wait`],
        setupTimeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/i)

    await delay(1500)
    expect(existsSync(marker)).toBe(false)
  })

  it('gives a setup command a closed stdin rather than a pipe nobody writes to', async (): Promise<void> => {
    // The tick awaits provisioning inline (spec §3.2), so a setup command blocking on a read it
    // will never be answered freezes every workspace, not just this one. `cat` returns only on
    // EOF; with an open pipe it hangs forever and this test times out.
    const wt = await provisionWorktree({ ...base, setupCommands: ['cat > STDIN_EOF'] })

    expect(readFileSync(join(wt.path, 'STDIN_EOF'), 'utf8')).toBe('')
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

  it('refuses a re-provision with an error the caller can act on, and leaves no debris', async (): Promise<void> => {
    const first = await provisionWorktree({ ...base, setupCommands: ['touch WORK_IN_PROGRESS'] })
    const branchesBefore = branches(repoPath)

    // A task moved to `rework` is startable again (`decide()`'s STARTABLE list), so the second run
    // of the same task arrives here with the same key. Refusing is right -- silently reusing the
    // directory hands the agent someone else's uncommitted state -- but the caller has to be able
    // to tell this apart from git being broken, and it cannot be asked to match on git's stderr.
    const error = await provisionWorktree(base).catch((cause: unknown): unknown => cause)

    expect(error).toBeInstanceOf(WorktreeExistsError)
    expect((error as WorktreeExistsError).path).toBe(first.path)
    expect((error as WorktreeExistsError).branch).toBe(first.branch)

    // `git worktree add -b` creates the branch *before* it fails on the path, so a failed
    // re-provision through git leaves a branch behind with no worktree attached. Refusing before
    // the add is what keeps the repository as it was found.
    expect(branches(repoPath)).toEqual(branchesBefore)
    expect(existsSync(join(first.path, 'WORK_IN_PROGRESS'))).toBe(true)
  })

  it('refuses when the branch exists even if the worktree directory does not', async (): Promise<void> => {
    run('git', ['branch', 'aiteamos/TASK-001-add-thing', 'main'], repoPath)

    const error = await provisionWorktree(base).catch((cause: unknown): unknown => cause)

    // The half-state a crash between `worktree add` and `worktree remove` leaves behind. Checking
    // only the directory would let this one through to git's own refusal.
    expect(error).toBeInstanceOf(WorktreeExistsError)
    expect((error as WorktreeExistsError).branch).toBe('aiteamos/TASK-001-add-thing')
  })

  it('refuses a task key that would place the worktree outside the repository', async (): Promise<void> => {
    // `Task` has no key column, so whatever Task 13 passes is synthesized -- plausibly from a
    // human-written title. `join()` collapses `..`, so this lands the worktree wherever the
    // segments point.
    await expect(provisionWorktree({ ...base, taskKey: '../../../../tmp/pwned' })).rejects.toThrow(
      /taskKey/,
    )
    await expect(provisionWorktree({ ...base, slug: '--detach' })).rejects.toThrow(/slug/)
    expect(existsSync(join(repoPath, '.aiteamos'))).toBe(false)
  })

  it('reports an absolute path even when handed a relative repository path', async (): Promise<void> => {
    // `path` becomes `AgentRun.worktreePath`, and spec §5.7 respawns a resumed run in that
    // directory -- across a daemon restart whose process may have a different cwd entirely.
    const wt = await provisionWorktree({ ...base, repoPath: relative(process.cwd(), repoPath) })

    expect(isAbsolute(wt.path)).toBe(true)
  })
})
