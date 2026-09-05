import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signalPause } from '../src/pause-signal.js'

/**
 * A real process to pause. Nothing here mocks `process.kill`: the whole point of Cursor's pause is
 * that it is a signal to a pid a different process spawned, so a mocked kill would test nothing
 * about the one thing that has to work.
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

describe("signalPause('cursor')", () => {
  let dir: string
  let pauseFlagPath: string
  const spawned: ChildProcess[] = []

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-cursor-pause-'))
    pauseFlagPath = path.join(dir, 'pause.flag')
  })

  afterEach(() => {
    for (const child of spawned) {
      if (child.pid !== undefined && isAlive(child.pid)) child.kill('SIGKILL')
    }
    spawned.length = 0
    rmSync(dir, { recursive: true, force: true })
  })

  it('kills the run process, because cancellation IS the pause for a runtime with no mid-run gate', async () => {
    const child = spawnSleeper()
    spawned.push(child)
    const pid = child.pid as number

    await signalPause('cursor', { pauseFlagPath, pid }, 'meren')

    expect(await waitForDeath(pid)).toBe(true)
  })

  it('writes the pause flag too, so the gate denies anything the child starts before it dies', async () => {
    const child = spawnSleeper()
    spawned.push(child)

    await signalPause('cursor', { pauseFlagPath, pid: child.pid as number }, 'budget guardrail')

    // Byte-for-byte what `scripts/cursor-shell-gate.sh` reads back as the operator's deny message,
    // and identical to what the Claude branch writes -- one concept, one file format.
    expect(readFileSync(pauseFlagPath, 'utf8')).toBe('budget guardrail\n')
  })

  it('refuses a null pid rather than reporting a pause it did not perform', async () => {
    // Nothing to signal is not a pause. The Claude branch can honestly write a flag and return --
    // its gate denies the next tool call whenever the child gets there. Cursor has no such
    // mechanism: without a pid there is no way to stop the run at all, and a silent success here
    // is exactly how an emergency stop comes to report `ok` over a process that is still spending.
    await expect(signalPause('cursor', { pauseFlagPath, pid: null }, 'meren')).rejects.toThrow(/pid/)
  })

  it('tolerates a process that already exited -- losing that race is not a failure', async () => {
    const child = spawnSleeper()
    const pid = child.pid as number
    child.kill('SIGKILL')
    await waitForDeath(pid)

    await expect(signalPause('cursor', { pauseFlagPath, pid }, 'meren')).resolves.toBeUndefined()
    expect(readFileSync(pauseFlagPath, 'utf8')).toBe('meren\n')
  })
})
