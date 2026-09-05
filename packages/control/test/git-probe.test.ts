import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { realGitProbe } from '../src/git-probe.js'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-git-probe-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
  return dir
}

describe('realGitProbe', () => {
  it('sees a repository and its branch', async () => {
    const dir = repo()
    expect(await realGitProbe.isRepository(dir)).toBe(true)
    expect(await realGitProbe.branchExists(dir, 'main')).toBe(true)
    expect(await realGitProbe.branchExists(dir, 'develop')).toBe(false)
  })
  it('a plain directory is not a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slaveofai-git-probe-plain-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'x'), '')
    expect(await realGitProbe.isRepository(dir)).toBe(false)
  })
})
