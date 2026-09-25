import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runId as makeRunId, type RunId } from '@slave-of-ai/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Checkpoint } from '../src/claude/checkpoint.js'
import type { StartRunInput } from '../src/contract/adapter.js'
import { CursorAdapter } from '../src/cursor/adapter.js'
import { cursorWorkerEnv, cursorWorkerHomeFor, isPluginBearing, prepareCursorWorkerHome } from '../src/cursor/home.js'
import type { RuntimeEvent } from '../src/types.js'
import { copyGateInto } from './helpers/gate-fixture.js'

/**
 * H9 F9: a Cursor worker runs under a home of its own -- the operator's home mirrored, minus every
 * directory a person's own plugins and skills are discovered from.
 *
 * The "real" home here is a FIXTURE: a directory laid out the way a person's home is on the machine
 * the finding was measured on (a Superpowers plugin in the Cursor plugin cache, user skills under
 * `.claude/skills`, a Cursor login under `.config/cursor`, a `.gitconfig`). Nothing reads the
 * machine's own home, and nothing runs the real `cursor-agent`: the child is a shell script that
 * reports what it was given.
 */
describe('the Cursor worker home (H9 F9)', () => {
  let root: string
  let realHome: string
  let worktreePath: string
  let runDir: string
  let gatePath: string
  let input: StartRunInput

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-home-'))
    realHome = path.join(root, 'home')
    mkdirSync(path.join(realHome, '.cursor', 'plugins', 'cache', 'cursor-public', 'superpowers'), { recursive: true })
    mkdirSync(path.join(realHome, '.cursor', 'skills', 'brainstorming'), { recursive: true })
    writeFileSync(path.join(realHome, '.cursor', 'cli-config.json'), '{"authInfo":{}}\n')
    mkdirSync(path.join(realHome, '.claude', 'skills', 'writing-plans'), { recursive: true })
    mkdirSync(path.join(realHome, '.claude', 'plugins'), { recursive: true })
    mkdirSync(path.join(realHome, '.codex', 'skills'), { recursive: true })
    mkdirSync(path.join(realHome, '.grok', 'skills'), { recursive: true })
    // A vendor directory nobody here has heard of: excluded by its SHAPE, not its name.
    mkdirSync(path.join(realHome, '.newvendor', 'plugins'), { recursive: true })
    // A dot-directory with neither is an ordinary one and is mirrored.
    mkdirSync(path.join(realHome, '.npm', '_cacache'), { recursive: true })
    mkdirSync(path.join(realHome, '.config', 'cursor'), { recursive: true })
    writeFileSync(path.join(realHome, '.config', 'cursor', 'auth.json'), '{"token":"fixture"}\n')
    writeFileSync(path.join(realHome, '.gitconfig'), '[user]\n\tname = Fixture\n')
    mkdirSync(path.join(realHome, '.cache', 'ms-playwright'), { recursive: true })

    worktreePath = path.join(root, 'worktree')
    mkdirSync(worktreePath)
    runDir = path.join(root, 'run')
    mkdirSync(runDir)
    gatePath = copyGateInto(root, 'cursor-shell-gate.sh')
    input = {
      runId: makeRunId('run-home'),
      prompt: 'do the thing',
      worktreePath,
      pauseFlagPath: path.join(runDir, 'pause.flag'),
      runDir,
      permissionsFilePath: path.join(runDir, 'permissions.json'),
      gitIdentity: { name: 'Test Slave', email: 'slave@example.com' },
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** A child that writes down the three variables and what its `HOME` holds, then exits. */
  function reportingChild(outPath: string): string {
    const script = path.join(root, 'report.sh')
    writeFileSync(
      script,
      '#!/bin/sh\n' +
        `{ printf '%s\\n' "$HOME" "$CURSOR_CONFIG_DIR" "$CURSOR_DATA_DIR"; ls -A "$HOME" | tr '\\n' ' '; } > ${JSON.stringify(outPath)}\n`,
    )
    chmodSync(script, 0o755)
    return script
  }

  async function drain(adapter: CursorAdapter, id: RunId): Promise<RuntimeEvent[]> {
    const seen: RuntimeEvent[] = []
    for await (const event of adapter.events(id)) seen.push(event)
    return seen
  }

  it("spawns a worker with a HOME that holds none of the person's plugin or skill roots", async () => {
    const out = path.join(root, 'start.txt')
    const adapter = new CursorAdapter({ command: reportingChild(out), gatePath, realHome })
    await adapter.start(input)
    await drain(adapter, input.runId)

    const [home, configDir, dataDir, listing] = readFileSync(out, 'utf8').split('\n')
    expect(home).toBe(cursorWorkerHomeFor(runDir))
    // Never the worktree: the worker commits from there, and a home inside it would be committed.
    expect(home?.startsWith(worktreePath)).toBe(false)
    const entries = (listing ?? '').trim().split(' ')
    for (const dir of ['.claude', '.codex', '.grok', '.newvendor']) expect(entries).not.toContain(dir)
    // The worker's `.cursor` is its OWN, empty one: no plugin cache, no user skills.
    expect(entries).toContain('.cursor')
    expect(readdirSync(path.join(home ?? '', '.cursor'))).toEqual([])
    expect(existsSync(path.join(home ?? '', '.cursor', 'plugins'))).toBe(false)
    // Everything else a worker's tools look for is where it always was.
    expect(entries).toEqual(expect.arrayContaining(['.config', '.gitconfig', '.cache', '.npm']))
    expect(readFileSync(path.join(home ?? '', '.config', 'cursor', 'auth.json'), 'utf8')).toContain('fixture')
    expect(realpathSync(path.join(home ?? '', '.gitconfig'))).toBe(realpathSync(path.join(realHome, '.gitconfig')))
    // The vendor's config (login, chats a `--resume` names) and data stay the person's own.
    expect(configDir).toBe(path.join(realHome, '.cursor'))
    expect(dataDir).toBe(path.join(realHome, '.cursor'))
  })

  it('resumes into the same worker home, derived from the checkpoint', async () => {
    const out = path.join(root, 'resume.txt')
    const adapter = new CursorAdapter({ command: reportingChild(out), gatePath, realHome })
    const checkpoint: Checkpoint = {
      sessionId: 's-1',
      worktreePath,
      pauseFlagPath: input.pauseFlagPath,
      lastToolUseId: null,
      lastToolName: null,
      numTurns: 1,
      deniedToolUseIds: [],
      headCommit: 'abc123',
      dirtyFiles: [],
      cumulativeCostUsd: 0,
      cumulativeTokens: 0,
      settingsPath: path.join(worktreePath, '.cursor', 'hooks.json'),
      hookPath: gatePath,
      gitAuthorName: 'Test Slave',
      gitAuthorEmail: 'slave@example.com',
      provider: 'cursor',
    }
    await adapter.resume(input.runId, checkpoint, null)
    await drain(adapter, input.runId)

    const [home, , , listing] = readFileSync(out, 'utf8').split('\n')
    expect(home).toBe(cursorWorkerHomeFor(runDir))
    expect((listing ?? '').trim().split(' ')).not.toContain('.claude')
  })

  it('is idempotent, and leaves what the CLI wrote into its own .cursor alone', () => {
    const first = prepareCursorWorkerHome({ runDir, realHome })
    writeFileSync(path.join(first, '.cursor', 'written-by-the-cli.json'), '{}')
    const second = prepareCursorWorkerHome({ runDir, realHome })
    expect(second).toBe(first)
    expect(existsSync(path.join(second, '.cursor', 'written-by-the-cli.json'))).toBe(true)
    expect(lstatSync(path.join(second, '.gitconfig')).isSymbolicLink()).toBe(true)
  })

  it('excludes Cursor\'s and Claude\'s directories always, and any dot-directory shaped like a vendor root', () => {
    expect(isPluginBearing(realHome, '.cursor')).toBe(true)
    expect(isPluginBearing(realHome, '.claude')).toBe(true)
    expect(isPluginBearing(realHome, '.codex')).toBe(true)
    expect(isPluginBearing(realHome, '.newvendor')).toBe(true)
    expect(isPluginBearing(realHome, '.npm')).toBe(false)
    expect(isPluginBearing(realHome, '.config')).toBe(false)
    const home = prepareCursorWorkerHome({ runDir, realHome })
    // `.cursor` exists as the worker's own real directory, never a link to the person's.
    expect(lstatSync(path.join(home, '.cursor')).isSymbolicLink()).toBe(false)
    for (const dir of ['.claude', '.codex', '.grok', '.newvendor']) expect(existsSync(path.join(home, dir))).toBe(false)
  })

  it('resolves the vendor directories the way cursor-agent does, honouring an operator who moved them', () => {
    const workerHome = '/w'
    expect(cursorWorkerEnv({ workerHome, realHome: '/h', parentEnv: {} })).toEqual({
      HOME: '/w',
      CURSOR_CONFIG_DIR: '/h/.cursor',
      CURSOR_DATA_DIR: '/h/.cursor',
    })
    expect(cursorWorkerEnv({ workerHome, realHome: '/h', parentEnv: { XDG_CONFIG_HOME: '/x' } }).CURSOR_CONFIG_DIR).toBe('/x/cursor')
    expect(
      cursorWorkerEnv({ workerHome, realHome: '/h', parentEnv: { XDG_CONFIG_HOME: '/x', CURSOR_CONFIG_DIR: '/c', CURSOR_DATA_DIR: '/d' } }),
    ).toEqual({ HOME: '/w', CURSOR_CONFIG_DIR: '/c', CURSOR_DATA_DIR: '/d' })
    // Blank is unset, as the vendor reads it.
    expect(cursorWorkerEnv({ workerHome, realHome: '/h', parentEnv: { CURSOR_CONFIG_DIR: '  ' } }).CURSOR_CONFIG_DIR).toBe('/h/.cursor')
  })
})
