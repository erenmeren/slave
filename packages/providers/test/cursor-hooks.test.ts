import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCursorHooks, cursorHooksPath, writeCursorHooksFile } from '../src/cursor/hooks.js'

const GATE = '/opt/slaveofai/cursor-shell-gate.sh'

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

describe('writeCursorHooksFile', () => {
  let root: string
  let repo: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-hooks-'))
    // A REAL repository and a REAL linked worktree, not a hand-made `.git` directory: the whole
    // point of the gitdir handling below is that `git worktree add` produces a `.git` FILE, and a
    // fixture that fakes that would be testing my own assumption rather than git's behaviour.
    repo = path.join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '--initial-branch=main'])
    writeFileSync(path.join(repo, 'README.md'), 'hello\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-m', 'first'])
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function addWorktree(name: string): string {
    const worktree = path.join(root, name)
    git(repo, ['worktree', 'add', '-b', name, worktree])
    return worktree
  }

  it('keeps its own file out of the run\'s git status, via the worktree\'s real gitdir', () => {
    const worktree = addWorktree('run-1')

    writeCursorHooksFile({ hooksPath: cursorHooksPath(worktree), gatePath: GATE })

    // The load-bearing assertion: git itself must not see the file. `.git` here is a FILE pointing
    // at `<repo>/.git/worktrees/run-1`, so an exclude written into `<worktree>/.git/info/exclude`
    // would have gone into a path that is not a directory at all.
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
  })

  /**
   * MEASURED, and it is the reason this is asked of git rather than derived: `info/exclude` is
   * redirected to the COMMON directory. Inside a linked worktree, `.git` is a file naming
   * `<repo>/.git/worktrees/<name>`, but an exclude written there is never read -- `git status`
   * still reports the file. Only `<repo>/.git/info/exclude` works.
   */
  function excludePathFor(worktree: string): string {
    return git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']).trim()
  }

  it('appends the exclude exactly once, however many times a run spawns', () => {
    const worktree = addWorktree('run-2')
    const excludePath = excludePathFor(worktree)

    // start(), then resume(), then a second resume -- every spawn rewrites the hooks file.
    writeCursorHooksFile({ hooksPath: cursorHooksPath(worktree), gatePath: GATE })
    writeCursorHooksFile({ hooksPath: cursorHooksPath(worktree), gatePath: GATE })
    writeCursorHooksFile({ hooksPath: cursorHooksPath(worktree), gatePath: GATE })

    const exclude = readFileSync(excludePath, 'utf8')
    const hits = exclude.split('\n').filter((line) => line.trim() === '/.cursor/hooks.json')
    expect(hits).toHaveLength(1)
  })

  it('preserves an exclude file that already had entries', () => {
    const worktree = addWorktree('run-3')
    const excludePath = excludePathFor(worktree)
    mkdirSync(path.dirname(excludePath), { recursive: true })
    writeFileSync(excludePath, '# an operator put this here\n*.local\n')

    writeCursorHooksFile({ hooksPath: cursorHooksPath(worktree), gatePath: GATE })

    const exclude = readFileSync(excludePath, 'utf8')
    expect(exclude).toContain('*.local')
    expect(exclude).toContain('/.cursor/hooks.json')
  })

  it("refuses to clobber a hooks file the checked-out project brought with it", () => {
    const worktree = addWorktree('run-4')
    const hooksPath = cursorHooksPath(worktree)
    mkdirSync(path.dirname(hooksPath), { recursive: true })
    // A project that ships its own Cursor hooks is a configuration, not debris. Overwriting it
    // silently would disarm whatever the user actually configured AND show up as a modified
    // tracked file in the agent's own working tree, which the agent may then commit.
    writeFileSync(hooksPath, '{"version":1,"hooks":{"afterFileEdit":[{"command":"./ours.sh"}]}}')

    expect(() => writeCursorHooksFile({ hooksPath, gatePath: GATE })).toThrow(/already has a .cursor\/hooks.json/)
    expect(readFileSync(hooksPath, 'utf8')).toContain('afterFileEdit')
  })

  it('rewrites its OWN file without complaint, which is what every resume does', () => {
    const worktree = addWorktree('run-5')
    const hooksPath = cursorHooksPath(worktree)

    writeCursorHooksFile({ hooksPath, gatePath: GATE })
    expect(() => writeCursorHooksFile({ hooksPath, gatePath: GATE })).not.toThrow()
    expect(JSON.parse(readFileSync(hooksPath, 'utf8'))).toEqual(buildCursorHooks({ gatePath: GATE }))
  })

  it('works in a plain directory that is not a git worktree at all', () => {
    // Every unit test in `cursor-adapter.test.ts` spawns into a bare temp directory, and so would
    // any operator pointing a run at one. There is no gitdir to exclude into; that is not an error.
    const plain = path.join(root, 'plain')
    mkdirSync(plain)

    expect(() => writeCursorHooksFile({ hooksPath: cursorHooksPath(plain), gatePath: GATE })).not.toThrow()
    expect(existsSync(cursorHooksPath(plain))).toBe(true)
  })
})
