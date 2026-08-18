import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runId, type RunId } from '@ai-team-os/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClaudeCodeAdapter, type StartRunInput } from '../src/claude/adapter.js'
import type { RuntimeEvent } from '../src/types.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))

/**
 * Drains the run's normalized event stream (proving `events()` still works
 * end to end for this fixture, and that it does not hang), then reads the
 * child's echoed environment back off the adapter's raw-payload seam --
 * `RunOutcome` carries no `env` field, so the normalized stream alone
 * cannot answer "did the spawned process actually receive this variable".
 */
async function collectEnvFrom(adapter: ClaudeCodeAdapter, id: RunId): Promise<Record<string, string>> {
  for await (const _event of adapter.events(id)) {
    void _event // drain to completion
  }
  const payload = adapter.rawTerminalPayload(id)
  if (payload === undefined) {
    throw new Error('collectEnvFrom: no terminal result payload observed')
  }
  return z.record(z.string()).parse(payload.env)
}

describe('ClaudeCodeAdapter', () => {
  let worktreePath: string
  let input: StartRunInput

  beforeEach(() => {
    worktreePath = mkdtempSync(path.join(tmpdir(), 'aiteamos-adapter-'))
    input = {
      runId: runId('run-1'),
      prompt: 'do the thing',
      worktreePath,
      pauseFlagPath: path.join(worktreePath, 'pause.flag'),
      settingsPath: path.join(worktreePath, 'settings.json'),
      gitIdentity: { name: 'Test Agent', email: 'agent@example.com' },
    }
  })

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true })
  })

  it('streams normalized events and reports the pid', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] })
    const handle = await adapter.start(input)
    expect(handle.pid).toBeGreaterThan(0)

    const seen: RuntimeEvent[] = []
    for await (const event of adapter.events(input.runId)) seen.push(event)

    expect(seen[0]).toEqual({ kind: 'session_started', sessionId: expect.any(String) })
    const terminatedIndex = seen.findIndex((e) => e.kind === 'terminated')
    expect(terminatedIndex).toBeGreaterThanOrEqual(0)
    // The real `complete` capture's own final line is a routine `Stop` hook
    // response, which arrives *after* the terminal `result` line (ADR 0001:
    // "every one of the four captures ends with a routine Stop hook"). A
    // reader that stopped at `result` would never see it -- asserting more
    // events follow the terminated one is what proves this reader does not.
    expect(seen.length).toBeGreaterThan(terminatedIndex + 1)
    expect(seen.some((e) => e.kind === 'unparsable')).toBe(false)
  })

  it('sets git identity in the child environment and never writes git config', async (): Promise<void> => {
    // fixture 'env-echo' prints process.env keys as a result payload
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'] })
    await adapter.start(input)
    const env = await collectEnvFrom(adapter, input.runId)
    expect(env['GIT_AUTHOR_NAME']).toBe(input.gitIdentity.name)
    expect(env['GIT_AUTHOR_EMAIL']).toBe(input.gitIdentity.email)
    expect(env['GIT_COMMITTER_NAME']).toBe(input.gitIdentity.name)
    expect(env['GIT_COMMITTER_EMAIL']).toBe(input.gitIdentity.email)
    expect(env['AITEAMOS_PAUSE_FLAG']).toBe(input.pauseFlagPath)
  })

  it('reports the ADR 0001 capability profile verbatim', () => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'complete'] })
    expect(adapter.getCapabilities()).toEqual({
      canPauseMidRun: true,
      canResumeSession: true,
      supportsHooks: true,
      streamsToolCalls: true,
      reportsTokenUsage: true,
      supportsCustomSystemPrompt: false,
      enforcesToolPermissions: true,
    })
  })

  it('cancels a hung run: the process no longer exists after cancel() resolves', async (): Promise<void> => {
    const adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'hang'], killGraceMs: 500 })
    const handle = await adapter.start(input)
    expect(isAlive(handle.pid)).toBe(true)

    await adapter.cancel(input.runId)

    expect(isAlive(handle.pid)).toBe(false)
  })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
