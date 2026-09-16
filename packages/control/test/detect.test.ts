import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DETECT_MAX_PATHS, detectVerify, findPaths, inspectPath } from '../src/detect.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/detect/', import.meta.url))
const commandsOf = async (name: string): Promise<string[]> =>
  (await detectVerify(join(FIXTURES, name))).map((finding) => finding.command)

describe('findPaths', () => {
  it('finds an absolute path in the middle of a sentence', () => {
    expect(findPaths('the repo is at /home/me/api, have a look')).toEqual(['/home/me/api'])
  })

  it('expands ~ against the home directory, because that is what a person types', () => {
    expect(findPaths('~/code/api please')).toEqual([join(homedir(), 'code/api')])
  })

  it('finds a quoted path and drops the quotes', () => {
    expect(findPaths('use "/home/me/api" for this')).toEqual(['/home/me/api'])
  })

  it('does not mistake prose for a path', () => {
    expect(findPaths('build a rate limiter for our public API')).toEqual([])
  })

  it('keeps the draft path the caller already had, without duplicating it', () => {
    expect(findPaths('/home/me/api again', ['/home/me/api', '/home/me/web'])).toEqual([
      '/home/me/api',
      '/home/me/web',
    ])
  })

  it('puts the caller path first so the cap cannot discard the chosen repository', () => {
    const messagePaths = Array.from({ length: DETECT_MAX_PATHS }, (_, index) => `/home/me/message-${String(index)}`).join(' ')
    expect(findPaths(messagePaths, ['/home/me/chosen'])).toEqual([
      '/home/me/chosen',
      '/home/me/message-0',
      '/home/me/message-1',
      '/home/me/message-2',
    ])
  })

  it('never returns more than DETECT_MAX_PATHS, so one message cannot run twenty probes', () => {
    const many = Array.from({ length: 12 }, (_, index) => `/home/me/p${String(index)}`).join(' ')
    expect(findPaths(many)).toHaveLength(DETECT_MAX_PATHS)
  })
})

describe('detectVerify', () => {
  it('reads npm scripts in R6 order -- test, typecheck, lint, build', async () => {
    expect(await commandsOf('node-npm')).toEqual([
      'npm test',
      'npm run typecheck',
      'npm run lint',
      'npm run build',
    ])
  })

  it('names the file and the key each finding came from', async () => {
    const findings = await detectVerify(join(FIXTURES, 'node-npm'))
    expect(findings[0]).toEqual({ command: 'npm test', source: 'package.json scripts.test' })
  })

  it('uses the runner the lockfile names', async () => {
    expect(await commandsOf('node-pnpm')).toEqual(['pnpm test', 'pnpm run typecheck'])
  })

  it('reads a Makefile target', async () => {
    expect(await commandsOf('make')).toEqual(['make test', 'make check'])
  })

  it('reads the three single-command stacks', async () => {
    expect(await commandsOf('python')).toEqual(['pytest'])
    expect(await commandsOf('cargo')).toEqual(['cargo test'])
    expect(await commandsOf('go')).toEqual(['go test ./...'])
  })

  it('finds nothing in an empty directory, and does not throw', async () => {
    expect(await detectVerify(mkdtempSync(join(tmpdir(), 'detect-empty-')))).toEqual([])
  })

  it('finds nothing in a directory that does not exist, and does not throw', async () => {
    expect(await detectVerify(join(tmpdir(), 'detect-nowhere-does-not-exist'))).toEqual([])
  })

  it('survives a package.json that is not JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'detect-broken-'))
    writeFileSync(join(dir, 'package.json'), '{ this is not json')
    expect(await detectVerify(dir)).toEqual([])
  })
})

describe('inspectPath', () => {
  it('reports a real repository, its branches and its default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'detect-repo-'))
    const git = (args: readonly string[]): void => {
      execFileSync('git', [...args], { cwd: dir })
    }
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.name', 'Fixture'])
    git(['config', 'user.email', 'fixture@example.com'])
    writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest run"}}')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'initial'])
    git(['branch', 'develop'])

    const fact = await inspectPath(dir)
    expect(fact.exists).toBe(true)
    expect(fact.isRepository).toBe(true)
    expect(fact.isEmptyDir).toBe(false)
    expect([...fact.branches].sort()).toEqual(['develop', 'main'])
    expect(fact.defaultBranch).toBe('main')
    expect(fact.verify.map((finding) => finding.command)).toEqual(['npm test'])
  })

  it('reports an empty directory as a directory that is empty and not a repository', async () => {
    const fact = await inspectPath(mkdtempSync(join(tmpdir(), 'detect-blank-')))
    expect(fact).toMatchObject({ exists: true, isRepository: false, isEmptyDir: true, branches: [], defaultBranch: null, verify: [] })
  })

  it('reports a path that is not there at all', async () => {
    const fact = await inspectPath(join(tmpdir(), 'detect-absent-does-not-exist'))
    expect(fact).toMatchObject({ exists: false, isRepository: false, isEmptyDir: false })
  })
})
