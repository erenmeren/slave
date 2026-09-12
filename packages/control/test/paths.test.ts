import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runId } from '@slave-of-ai/domain'
import { runDirPathFor, runFilePaths } from '../src/paths.js'

const RUN = runId('11111111-1111-4111-8111-111111111111')

describe('runFilePaths', () => {
  const previousStateDir = process.env['SLAVEOFAI_STATE_DIR']

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env['SLAVEOFAI_STATE_DIR']
    else process.env['SLAVEOFAI_STATE_DIR'] = previousStateDir
  })

  it('derives both control-file paths from the repo path and run id', (): void => {
    // A real writable directory, not a bare literal like '/repo': `runFilePaths` `mkdirSync`s the
    // target for real (its whole point per the doc comment), and a fixed root-level path is not
    // writable by an unprivileged process in every environment this suite runs in.
    const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-paths-'))
    const paths = runFilePaths(repoPath, runId('11111111-1111-4111-8111-111111111111'))
    expect(paths.pauseFlagPath).toContain('11111111-1111-4111-8111-111111111111')
    expect(paths.runDir).toContain('11111111-1111-4111-8111-111111111111')
    expect(paths.pauseFlagPath).not.toBe(paths.runDir)
  })

  // M52 R4. The three cases the move is FOR: a worker edits the repository, so a verdict that
  // lives inside the repository is a verdict the worker can delete -- which, under default-deny,
  // would stop being a hole and start being a bypass of everything.
  it('puts the run directory OUTSIDE the repository entirely', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-paths-outside-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'slaveofai-state-'))
    process.env['SLAVEOFAI_STATE_DIR'] = stateDir
    const paths = runFilePaths(repoPath, RUN)
    expect(paths.runDir.startsWith(repoPath)).toBe(false)
    expect(paths.pauseFlagPath.startsWith(repoPath)).toBe(false)
  })

  it('honours SLAVEOFAI_STATE_DIR, which is what gives every gate its own isolated state root', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-paths-env-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'slaveofai-state-'))
    process.env['SLAVEOFAI_STATE_DIR'] = stateDir
    expect(runFilePaths(repoPath, RUN).runDir).toBe(join(stateDir, 'runs', RUN))
  })

  // THE TWO MUST NOT DRIFT (final review Minor 4). `runFilePaths` creates the directory and
  // `runDirPathFor` is the pure half the per-tick broker pass calls instead -- so a reader who
  // "tidies" one of the two roots into a different shape breaks the pass silently: the daemon would
  // tail a channel in a directory the adapter never spawned the worker with, which looks exactly
  // like a worker that never asked for anything.
  it('computes the SAME directory as runDirPathFor, which is the pure half of itself', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-paths-pure-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'slaveofai-state-'))
    process.env['SLAVEOFAI_STATE_DIR'] = stateDir
    expect(runDirPathFor(RUN)).toBe(runFilePaths(repoPath, RUN).runDir)
  })

  it('creates the directory 0700 -- the verdict inside it governs a worker', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-paths-mode-'))
    const stateDir = join(mkdtempSync(join(tmpdir(), 'slaveofai-state-')), 'nested')
    process.env['SLAVEOFAI_STATE_DIR'] = stateDir
    const { runDir } = runFilePaths(repoPath, RUN)
    // Masked to the permission bits: `statSync().mode` carries the file type in its high bits.
    expect(statSync(runDir).mode & 0o777).toBe(0o700)
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
