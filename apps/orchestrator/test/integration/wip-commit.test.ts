import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { runId as brandRunId } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { taskKeyFor } from '../../src/tick.js'
import { verifyConcludedRun } from '../../src/verify.js'
import { commitUncommittedWork, wipCommitMessage } from '../../src/wipCommit.js'
import { provisionWorktree } from '../../src/worktree.js'

/**
 * H9 F7 (a): a worker that forgot to commit still hands over its work. Every repository here is
 * REAL -- `git init`, a real linked worktree from `provisionWorktree`, real commits read back with
 * `git log` -- because the claim is about what `git` ends up holding, and nothing short of git
 * can say that.
 */
function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

const repos: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-wip-'))
  repos.push(dir)
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  writeFileSync(join(dir, '.gitignore'), 'build/\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  return dir
}

afterAll(async (): Promise<void> => {
  for (const repo of repos) {
    rmSync(`${repo}-slaveofai-worktrees`, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
  await prisma.$disconnect()
})

const WORKER = { name: 'Alex Worker', email: 'alex-worker@slaveofai.local' }

describe('commitUncommittedWork', () => {
  async function worktree(): Promise<{ path: string; branch: string }> {
    const repoPath = makeRepo()
    const handle = await provisionWorktree({ repoPath, baseBranch: 'main', taskKey: 'T-0000abcd', slug: 'x', setupCommands: [] })
    return { path: handle.path, branch: handle.branch }
  }

  it('does nothing to a clean tree', async (): Promise<void> => {
    const tree = await worktree()
    const before = git(['rev-parse', 'HEAD'], tree.path)
    const outcome = await commitUncommittedWork({ worktreePath: tree.path, branch: tree.branch, taskKey: 'T-0000abcd', identity: WORKER })
    expect(outcome).toEqual({ kind: 'clean' })
    expect(git(['rev-parse', 'HEAD'], tree.path)).toBe(before)
  })

  it("commits modified and new files under the worker's identity, and leaves ignored files alone", async (): Promise<void> => {
    const tree = await worktree()
    writeFileSync(join(tree.path, 'README.md'), '# fixture\n\nedited by the worker\n')
    writeFileSync(join(tree.path, 'feature.ts'), 'export const feature = 1\n')
    execFileSync('mkdir', ['-p', join(tree.path, 'build')])
    writeFileSync(join(tree.path, 'build', 'out.js'), 'ignored\n')

    const outcome = await commitUncommittedWork({ worktreePath: tree.path, branch: tree.branch, taskKey: 'T-0000abcd', identity: WORKER })

    expect(outcome.kind).toBe('committed')
    if (outcome.kind !== 'committed') throw new Error('expected a commit')
    expect(outcome.message).toBe('wip(T-0000abcd): uncommitted work at run end')
    expect(git(['rev-parse', 'HEAD'], tree.path)).toBe(outcome.sha)
    expect(git(['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'], tree.path)).toBe(
      `${WORKER.name} <${WORKER.email}>|${WORKER.name} <${WORKER.email}>|wip(T-0000abcd): uncommitted work at run end`,
    )
    expect(git(['show', '--name-only', '--format=', 'HEAD'], tree.path).split('\n').toSorted()).toEqual(['README.md', 'feature.ts'])
    // On the task's branch, so it is in the diff review reads.
    expect(git(['diff', '--name-only', `main...${tree.branch}`], tree.path).split('\n').toSorted()).toEqual(['README.md', 'feature.ts'])
    // The ignored file is still there and still uncommitted; the tree is otherwise clean.
    expect(git(['status', '--porcelain'], tree.path)).toBe('')
    expect(git(['status', '--porcelain', '--ignored'], tree.path)).toContain('build/')

    // A replayed conclusion finds nothing more to do.
    expect(await commitUncommittedWork({ worktreePath: tree.path, branch: tree.branch, taskKey: 'T-0000abcd', identity: WORKER })).toEqual({ kind: 'clean' })
  })

  it('does not commit on anything but the task branch', async (): Promise<void> => {
    const tree = await worktree()
    git(['checkout', '-q', '--detach'], tree.path)
    writeFileSync(join(tree.path, 'feature.ts'), 'export const feature = 1\n')
    const before = git(['rev-parse', 'HEAD'], tree.path)

    const outcome = await commitUncommittedWork({ worktreePath: tree.path, branch: tree.branch, taskKey: 'T-0000abcd', identity: WORKER })

    expect(outcome.kind).toBe('skipped')
    expect(git(['rev-parse', 'HEAD'], tree.path)).toBe(before)
    expect(git(['status', '--porcelain'], tree.path)).toContain('feature.ts')
  })

  it("does not run the repository's own commit hooks, and never waits on a signing prompt", async (): Promise<void> => {
    const tree = await worktree()
    // A pre-commit hook that refuses everything: the worker's own commits would meet it, this one does not.
    const hooksDir = git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], tree.path)
    execFileSync('mkdir', ['-p', hooksDir])
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    git(['config', 'commit.gpgsign', 'true'], tree.path)
    writeFileSync(join(tree.path, 'feature.ts'), 'export const feature = 1\n')

    const outcome = await commitUncommittedWork({ worktreePath: tree.path, branch: tree.branch, taskKey: 'T-0000abcd', identity: WORKER })
    expect(outcome.kind).toBe('committed')
  })
})

/**
 * Final-review I1 (controller Ruling 5): for a governed package run the leftover-work commit
 * stages only the paths the package owns. Setup and tooling dirty files the package does not own
 * (a lockfile, a generated file); committing them under the worker's name put them in the branch
 * the ownership audit judges, and every rework re-dirtied them.
 */
describe('commitUncommittedWork for a package run commits only what the package owns', () => {
  async function worktree(): Promise<{ path: string; branch: string }> {
    const repoPath = makeRepo()
    writeFileSync(join(repoPath, 'package-lock.json'), '{}\n')
    writeFileSync(join(repoPath, 'gone.txt'), 'foreign, deleted by setup\n')
    writeFileSync(join(repoPath, 'mine-gone.txt'), 'owned, deleted by the worker\n')
    git(['add', '-A'], repoPath)
    git(['commit', '-q', '-m', 'more files'], repoPath)
    const handle = await provisionWorktree({ repoPath, baseBranch: 'main', taskKey: 'T-0000abcd', slug: 'x', setupCommands: [] })
    return { path: handle.path, branch: handle.branch }
  }
  const owns = (path: string): boolean => path.startsWith('src/') || path.startsWith(' src/') || path === 'mine-gone.txt'

  it('commits owned changes, leaves foreign ones uncommitted in the tree, and says which', async (): Promise<void> => {
    const tree = await worktree()
    execFileSync('mkdir', ['-p', join(tree.path, 'src')])
    writeFileSync(join(tree.path, 'src', 'feature.ts'), 'export const feature = 1\n')
    writeFileSync(join(tree.path, ' src'), 'a leading space: not src/\n')
    rmSync(join(tree.path, 'mine-gone.txt'))
    // Foreign: a tracked lockfile setup rewrote, a foreign file it deleted, an untracked foreign
    // file, and one the worker staged but never committed -- the index must not smuggle it in.
    writeFileSync(join(tree.path, 'package-lock.json'), '{"dirty":true}\n')
    rmSync(join(tree.path, 'gone.txt'))
    writeFileSync(join(tree.path, 'notes.txt'), 'scratch\n')
    writeFileSync(join(tree.path, 'README.md'), '# staged foreign\n')
    git(['add', 'README.md'], tree.path)

    const outcome = await commitUncommittedWork({ worktreePath: tree.path, branch: tree.branch, taskKey: 'T-0000abcd', identity: WORKER, owns })

    expect(outcome.kind).toBe('committed')
    if (outcome.kind !== 'committed') throw new Error('expected a commit')
    expect(git(['show', '--name-only', '--format=', 'HEAD'], tree.path).split('\n').toSorted()).toEqual(['mine-gone.txt', 'src/feature.ts'])
    expect(outcome.leftOut).toEqual({ total: 5, paths: [' src', 'README.md', 'gone.txt', 'notes.txt', 'package-lock.json'] })
    // Left in the tree, not discarded.
    const status = git(['status', '--porcelain', '--untracked-files=all'], tree.path)
    for (const path of ['package-lock.json', 'gone.txt', 'notes.txt', 'README.md', ' src']) expect(status).toContain(path)

    // A replayed conclusion commits nothing more and still names what it left out.
    const again = await commitUncommittedWork({ worktreePath: tree.path, branch: tree.branch, taskKey: 'T-0000abcd', identity: WORKER, owns })
    expect(again).toEqual({ kind: 'nothing_owned', leftOut: { total: 5, paths: [' src', 'README.md', 'gone.txt', 'notes.txt', 'package-lock.json'] } })
    expect(git(['rev-parse', 'HEAD'], tree.path)).toBe(outcome.sha)
  })

  it('names at most 20 of the paths it left out, and counts them all', async (): Promise<void> => {
    const tree = await worktree()
    for (let i = 0; i < 25; i += 1) writeFileSync(join(tree.path, `f${String(i).padStart(2, '0')}.txt`), 'x\n')

    const outcome = await commitUncommittedWork({ worktreePath: tree.path, branch: tree.branch, taskKey: 'T-0000abcd', identity: WORKER, owns })

    expect(outcome.kind).toBe('nothing_owned')
    if (outcome.kind !== 'nothing_owned') throw new Error('expected nothing owned')
    expect(outcome.leftOut.total).toBe(25)
    expect(outcome.leftOut.paths).toHaveLength(20)
  })
})

describe('verifyConcludedRun commits a succeeded run\'s leftover work before verify (H9 F7 a)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  it("verifies and hands to review a tree whose work the worker never committed, the commit carrying the worker's own identity", async (): Promise<void> => {
    const repoPath = makeRepo()
    // Both commands run against the worktree AFTER the wip commit, which is what they prove: the
    // tree is clean and the newest commit is the wip one. Before H9 F7 (a) the first one failed.
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Checkout Platform',
        repoPath,
        baseBranch: 'main',
        verifyCommands: ['test -z "$(git status --porcelain)"', 'git log -1 --format=%s | grep -q "^wip(T-"'],
        setupCommands: [],
        maxAttempts: 5,
      },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
    const person = await prisma.person.create({ data: { name: 'Alex' } })
    const slave = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['backend'], personId: person.id } })
    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        title: 'Add the thing',
        description: 'make it work',
        status: 'running',
        requiredRole: 'backend',
        maxAttempts: workspace.maxAttempts,
      },
    })
    const handle = await provisionWorktree({ repoPath, baseBranch: 'main', taskKey: taskKeyFor(task.id), slug: 'add-the-thing', setupCommands: [] })
    await prisma.task.update({ where: { id: task.id }, data: { branch: handle.branch } })
    const run = await prisma.slaveRun.create({
      data: {
        taskId: task.id,
        slaveId: slave.id,
        kind: 'implementation',
        status: 'succeeded',
        worktreePath: handle.path,
        terminalAt: new Date(),
        endedAt: new Date(),
      },
    })
    await prisma.task.update({ where: { id: task.id }, data: { activeRunId: run.id } })

    // 170 tool calls of real work, and no commit.
    writeFileSync(join(handle.path, 'feature.ts'), 'export const feature = 1\n')

    await verifyConcludedRun(brandRunId(run.id))

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('reviewing')
    expect(git(['log', '-1', '--format=%an <%ae>|%s', handle.branch], repoPath)).toBe(
      `Alex <alex@slaveofai.local>|${wipCommitMessage(taskKeyFor(task.id))}`,
    )
    // What review reads is no longer empty.
    expect(git(['diff', '--name-only', `main...${handle.branch}`], repoPath)).toBe('feature.ts')
  })
})
