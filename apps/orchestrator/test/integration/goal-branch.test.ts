import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ensureIntegrationBranch } from '../../src/goalBranch.js'

const repos: string[] = []

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** `conductor-e2e.test.ts`'s repository, cut to one commit on `main`. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-goal-branch-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

afterAll((): void => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
})

const BRANCH = 'slaveofai/goal-v1-abcdef12'

describe('ensureIntegrationBranch', () => {
  it("cuts the branch at the base branch's tip and returns that commit", async () => {
    const repo = makeRepo()
    const tip = git(['rev-parse', 'main'], repo)
    expect(await ensureIntegrationBranch(repo, 'main', BRANCH)).toEqual({ baseCommit: tip })
    expect(git(['rev-parse', BRANCH], repo)).toBe(tip)
  })

  it('reuses its own branch on a replay (the daemon died before the delivery row committed)', async () => {
    const repo = makeRepo()
    const first = await ensureIntegrationBranch(repo, 'main', BRANCH)
    expect(await ensureIntegrationBranch(repo, 'main', BRANCH)).toEqual(first)
  })

  it('reuses a branch the base branch has since moved past', async () => {
    const repo = makeRepo()
    const first = await ensureIntegrationBranch(repo, 'main', BRANCH)
    writeFileSync(join(repo, 'more.txt'), 'more\n')
    git(['add', '-A'], repo)
    git(['commit', '-q', '-m', 'more'], repo)
    expect(await ensureIntegrationBranch(repo, 'main', BRANCH)).toEqual(first)
  })

  it("refuses a branch of that name that carries a commit not on the base branch's history", async () => {
    const repo = makeRepo()
    git(['checkout', '-q', '-b', BRANCH], repo)
    writeFileSync(join(repo, 'foreign.txt'), 'foreign\n')
    git(['add', '-A'], repo)
    git(['commit', '-q', '-m', 'foreign'], repo)
    git(['checkout', '-q', 'main'], repo)
    await expect(ensureIntegrationBranch(repo, 'main', BRANCH)).rejects.toThrow(/is not on main's history/)
  })
})
