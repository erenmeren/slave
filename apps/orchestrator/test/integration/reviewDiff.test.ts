import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DIFF_CHAR_LIMIT, PER_FILE_CHAR_LIMIT, buildReviewDiff } from '../../src/reviewDiff.js'

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A repository with `main` and a task branch that carries a small text change, a large text
 *  file and a binary -- the shape of the audit branch that broke the review on 2026-09-20. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-diff-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  git(['checkout', '-q', '-b', 'task'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n\nThe small change a reviewer must see.\n')
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'report.json'), `[${Array.from({ length: 120_000 }, (_, i) => `{"row":${String(i)}}`).join(',')}]\n`)
  writeFileSync(join(dir, 'docs', 'shot.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), Buffer.alloc(4096, 0)]))
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'the audit'], dir)
  return dir
}

describe('buildReviewDiff', () => {
  const repos: string[] = []
  afterAll(() => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  })

  it('shows the small change, names the binary with its size, cuts the large file, and says so', async (): Promise<void> => {
    const repo = makeRepo()
    repos.push(repo)
    // The raw diff is far past Node's default 1 MB stdout buffer -- the sanity read itself needs a
    // bigger one, which is exactly the failure the builder exists to avoid.
    const raw = execFileSync('git', ['diff', 'main...task'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    expect(raw.length).toBeGreaterThan(1_000_000)

    const built = await buildReviewDiff(repo, 'main', 'task')

    expect(built.files).toBe(3)
    expect(built.capped).toBe(true)
    expect(built.text.length).toBeLessThan(DIFF_CHAR_LIMIT + 2_000)
    expect(built.text).toContain('+The small change a reviewer must see.')
    expect(built.text).toMatch(/Binary file docs\/shot\.png \(\d+ bytes\) -- not shown\./u)
    expect(built.text).toContain(`[diff for docs/report.json truncated after ${String(PER_FILE_CHAR_LIMIT)} characters]`)
    expect(built.text).toContain('3 file(s) changed')
  })

  it('shows a small diff whole and reports it uncapped', async (): Promise<void> => {
    const repo = mkdtempSync(join(tmpdir(), 'review-diff-small-'))
    repos.push(repo)
    git(['init', '-q', '-b', 'main'], repo)
    git(['config', 'user.name', 'Fixture'], repo)
    git(['config', 'user.email', 'fixture@example.com'], repo)
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(['add', '-A'], repo)
    git(['commit', '-q', '-m', 'initial'], repo)
    git(['checkout', '-q', '-b', 'task'], repo)
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    git(['commit', '-q', '-am', 'two'], repo)

    const built = await buildReviewDiff(repo, 'main', 'task')

    expect(built).toMatchObject({ capped: false, files: 1 })
    expect(built.text).toContain('+two')
    expect(built.text).not.toContain('truncated')
  })

  it('throws when the range itself cannot be diffed, so the dispatch concludes a failed run as before', async (): Promise<void> => {
    const repo = makeRepo()
    repos.push(repo)
    await expect(buildReviewDiff(repo, 'main', 'no-such-branch')).rejects.toThrow()
  })
})
