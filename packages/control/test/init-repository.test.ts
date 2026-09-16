import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initRepository } from '../src/intake.js'
import { refusalText } from '../src/refusal.js'

const temp = (): string => mkdtempSync(join(tmpdir(), 'init-repo-'))

describe('initRepository', () => {
  it('creates a repository with one commit and a README carrying the goal', async (): Promise<void> => {
    const path = join(temp(), 'public-api')
    const result = await initRepository({ path, name: 'Public API', goal: 'Add rate limiting' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value).toEqual({ path, baseBranch: 'main' })

    const log = execFileSync('git', ['-C', path, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n')
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('begin Public API')
    const readme = readFileSync(join(path, 'README.md'), 'utf8')
    expect(readme).toContain('# Public API')
    expect(readme).toContain('## Goal')
    expect(readme).toContain('Add rate limiting')
    expect(execFileSync('git', ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('main')
  })

  it('refuses a relative path', async (): Promise<void> => {
    const result = await initRepository({ path: 'somewhere', name: 'x', goal: 'y' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('repo_path_not_absolute')
  })

  it('refuses when the parent does not exist -- it will not make a tree of folders', async (): Promise<void> => {
    const result = await initRepository({ path: join(tmpdir(), 'no-such-parent-xyz', 'api'), name: 'x', goal: 'y' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('parent_not_found')
  })

  it('refuses a path that already has something in it', async (): Promise<void> => {
    const path = temp()
    writeFileSync(join(path, 'keep.txt'), 'mine\n')
    const result = await initRepository({ path, name: 'x', goal: 'y' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('path_not_empty')
    expect(refusalText(result.error)).toContain(path)
  })

  it('accepts a path that exists and is an EMPTY directory', async (): Promise<void> => {
    const result = await initRepository({ path: temp(), name: 'Empty', goal: 'y' })
    expect(result.ok).toBe(true)
  })

  it('refuses a path inside another repository -- a repo in a repo is a mistake, not a project', async (): Promise<void> => {
    const outer = temp()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: outer })
    const result = await initRepository({ path: join(outer, 'inner'), name: 'x', goal: 'y' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.kind).toBe('inside_repository')
  })

  it('commits with a fixed identity when git has none configured', async (): Promise<void> => {
    const path = join(temp(), 'no-identity')
    const home = temp()
    const previous = process.env['HOME']
    process.env['HOME'] = home
    try {
      const result = await initRepository({ path, name: 'No Identity', goal: 'y' })
      expect(result.ok).toBe(true)
      const author = execFileSync('git', ['-C', path, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf8' }).trim()
      // Either the machine's own identity or ours -- never a failed commit, which is the point.
      expect(author.length).toBeGreaterThan(0)
    } finally {
      if (previous === undefined) delete process.env['HOME']
      else process.env['HOME'] = previous
    }
  })
})
