import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runId, type RunId } from '@slave-of-ai/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClaudeCodeAdapter, type StartRunInput } from '../src/claude/adapter.js'
import { readSpawnExtras, writeSpawnExtras } from '../src/runtime/process.js'
import { copyGateInto } from './helpers/gate-fixture.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const spawned = z.object({ env: z.record(z.string()), argv: z.array(z.string()) })

/** Drains the run and returns what the `env-echo` fixture saw: its own argv and environment. */
async function echoOf(adapter: ClaudeCodeAdapter, id: RunId): Promise<z.infer<typeof spawned>> {
  for await (const event of adapter.events(id)) void event
  return spawned.parse(adapter.rawTerminalPayload(id))
}

const after = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

describe('ClaudeCodeAdapter and a lead turn (lead-flow plan A L4/L6/L16)', () => {
  let dir: string
  let input: StartRunInput
  let adapter: ClaudeCodeAdapter

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-adapter-lead-'))
    adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath: copyGateInto(dir, 'pause-gate.sh') })
    input = {
      runId: runId('run-lead'),
      prompt: 'continue',
      worktreePath: dir,
      pauseFlagPath: path.join(dir, 'pause.flag'),
      runDir: dir,
      permissionsFilePath: path.join(dir, 'permissions.json'),
      gitIdentity: { name: 'Lead', email: 'lead@example.com' },
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('spawns exactly as before with no session to resume and no extras file', async (): Promise<void> => {
    await adapter.start(input)
    const { argv, env } = await echoOf(adapter, input.runId)
    for (const flag of ['--resume', '--agents', '--max-budget-usd']) expect(argv).not.toContain(flag)
    expect(env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']).toBeUndefined()
    expect(readSpawnExtras(dir)).toEqual({})
  })

  it('resumes a named session at a first spawn', async (): Promise<void> => {
    await adapter.start({ ...input, resumeSessionId: 'sess-7' })
    const { argv } = await echoOf(adapter, input.runId)
    expect(after(argv, '--resume')).toBe('sess-7')
    expect(argv).not.toContain('--fork-session')
  })

  it('passes the roster, the budget cap and the keep-alive from the run directory\'s extras file', async (): Promise<void> => {
    const definitions = JSON.stringify({ 'backend-developer': { description: 'builds APIs', prompt: 'You build APIs.' } })
    writeSpawnExtras(dir, { sessionDefinitions: definitions, maxBudgetUsd: 12.5, keepAliveForSubordinates: true })
    await adapter.start(input)
    const { argv, env } = await echoOf(adapter, input.runId)
    expect(after(argv, '--agents')).toBe(definitions)
    expect(after(argv, '--max-budget-usd')).toBe('12.5')
    expect(env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']).toBe('0')
  })

  it('reads an unreadable or wrongly shaped extras file as none', () => {
    writeSpawnExtras(dir, { maxBudgetUsd: -1, sessionDefinitions: '' })
    expect(readSpawnExtras(dir)).toEqual({})
  })

  it('carries the same extras into a resume of a paused turn', async (): Promise<void> => {
    writeSpawnExtras(dir, { maxBudgetUsd: 3, keepAliveForSubordinates: true })
    const hookPath = path.join(dir, 'pause-gate.sh')
    await adapter.resume(
      input.runId,
      {
        sessionId: 'sess-7', worktreePath: dir, pauseFlagPath: input.pauseFlagPath, settingsPath: path.join(dir, 'settings.json'), hookPath,
        gitAuthorName: 'Lead', gitAuthorEmail: 'lead@example.com', lastToolUseId: null, lastToolName: null, numTurns: 0,
        deniedToolUseIds: [], headCommit: '', dirtyFiles: [], cumulativeCostUsd: 0, cumulativeTokens: 0,
      },
      'go on',
    )
    const { argv, env } = await echoOf(adapter, input.runId)
    expect(after(argv, '--resume')).toBe('sess-7')
    expect(after(argv, '--max-budget-usd')).toBe('3')
    expect(env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']).toBe('0')
  })
})
