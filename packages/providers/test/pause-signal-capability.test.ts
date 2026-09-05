import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capabilitiesOf } from '../src/capabilities.js'
import { signalPause } from '../src/pause-signal.js'
import { PROVIDER_KINDS } from '../src/types.js'

/**
 * Spec §4's "pause dispatches on capability", asserted as a TABLE over every `ProviderKind` rather
 * than as two vendor-named cases.
 *
 * The point is what this file does NOT name: no branch here says "claude writes a flag" or "cursor
 * gets killed". Each row asks `capabilitiesOf(kind).canPauseMidRun` and asserts the strategy that
 * boolean implies, so a third provider added to `PROVIDER_KINDS` is covered the moment its row
 * exists in the capability table -- and a provider whose declared capability and actual pause
 * strategy disagree fails here, which is the drift `capabilities.ts` exists to make impossible.
 *
 * Nothing is mocked: a real `/bin/sleep` is spawned and a real signal is sent, because the one
 * thing a pause has to do is stop a process this test's own process did not start.
 */
function spawnSleeper(): ChildProcess {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  if (child.pid === undefined) throw new Error('spawnSleeper: no pid')
  return child
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return !isAlive(pid)
}

describe('signalPause chooses its strategy by capability, not by vendor', () => {
  let dir: string
  let pauseFlagPath: string
  const spawned: ChildProcess[] = []

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-pause-capability-'))
    pauseFlagPath = path.join(dir, 'pause.flag')
  })

  afterEach(() => {
    for (const child of spawned) {
      if (child.pid !== undefined && isAlive(child.pid)) child.kill('SIGKILL')
    }
    spawned.length = 0
    rmSync(dir, { recursive: true, force: true })
  })

  for (const kind of PROVIDER_KINDS) {
    const { canPauseMidRun } = capabilitiesOf(kind)

    it(`${kind} (canPauseMidRun: ${canPauseMidRun}) ${canPauseMidRun ? 'leaves the process running for its own gate to stop' : 'ends the process, because that IS its pause'}`, async () => {
      const child = spawnSleeper()
      spawned.push(child)
      const pid = child.pid as number

      await signalPause(kind, { pauseFlagPath, pid }, 'meren')

      // The flag is written by BOTH strategies -- for a mid-run gate it is the whole signal, and
      // for a terminating one it arms the gate for whatever the child starts before it dies.
      expect(readFileSync(pauseFlagPath, 'utf8')).toBe('meren\n')
      if (canPauseMidRun) {
        expect(isAlive(pid)).toBe(true)
      } else {
        expect(await waitForDeath(pid)).toBe(true)
      }
    })

    it(`${kind} with no recorded pid ${canPauseMidRun ? 'still signals, because the flag is the pause' : 'refuses, because there is nothing left to signal'}`, async () => {
      const call = signalPause(kind, { pauseFlagPath, pid: null }, 'budget guardrail')

      if (canPauseMidRun) {
        await call
        expect(readFileSync(pauseFlagPath, 'utf8')).toBe('budget guardrail\n')
      } else {
        // Reporting success here would claim a pause that never happened: with no gate and no pid
        // there is no mechanism left. `pauseActiveRuns` turns this throw into a `refused` entry.
        await expect(call).rejects.toThrow(new RegExp(kind, 'i'))
      }
    })
  }
})
