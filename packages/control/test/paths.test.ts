import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runId } from '@ai-team-os/domain'
import { runFilePaths } from '../src/paths.js'

describe('runFilePaths', () => {
  it('derives both control-file paths from the repo path and run id', (): void => {
    // A real writable directory, not a bare literal like '/repo': `runFilePaths` `mkdirSync`s the
    // target for real (its whole point per the doc comment), and a fixed root-level path is not
    // writable by an unprivileged process in every environment this suite runs in.
    const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-control-paths-'))
    const paths = runFilePaths(repoPath, runId('11111111-1111-4111-8111-111111111111'))
    expect(paths.pauseFlagPath).toContain('11111111-1111-4111-8111-111111111111')
    expect(paths.runDir).toContain('11111111-1111-4111-8111-111111111111')
    expect(paths.pauseFlagPath).not.toBe(paths.runDir)
  })

  it('refuses a repo path that does not exist, naming it, instead of hanging in mkdirSync', () => {
    expect(() => runFilePaths('/nonexistent-root/definitely-not-here', runId('run-x' as any)))
      .toThrow(/\/nonexistent-root\/definitely-not-here/)
  })

  it('refuses a repo path that is a file, not a directory', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'paths-')), 'a-file')
    writeFileSync(file, '')
    expect(() => runFilePaths(file, runId('run-x' as any))).toThrow(/not a directory|a-file/)
  })
})
