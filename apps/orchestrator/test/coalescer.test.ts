import { describe, expect, it } from 'vitest'
import { createCoalescer } from '../src/daemon.js'

/** A deferred whose resolution the test controls, so "in flight" is a state and not a race. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createCoalescer', () => {
  it('defers wakes that arrive during a run instead of dropping or stacking them', async (): Promise<void> => {
    let runs = 0
    const gates = [deferred(), deferred()]
    const coalescer = createCoalescer(async (): Promise<void> => {
      const gate = gates[runs]
      runs += 1
      await gate?.promise
    })

    coalescer.wake()
    expect(runs).toBe(1)

    // Five wakes during one in-flight run. Dropping them loses a notification; stacking them runs
    // five more ticks, and at the default 1000ms period against a provision that takes minutes that
    // is hundreds of them.
    for (let i = 0; i < 5; i += 1) coalescer.wake()
    expect(runs).toBe(1)

    gates[0]?.resolve()
    await new Promise((res) => setTimeout(res, 0))
    expect(runs).toBe(2)

    gates[1]?.resolve()
    await coalescer.inFlight()
    expect(runs).toBe(2)
  })

  it('runs nothing more once stopped', async (): Promise<void> => {
    let runs = 0
    const gate = deferred()
    const coalescer = createCoalescer(async (): Promise<void> => {
      runs += 1
      await gate.promise
    })

    coalescer.wake()
    coalescer.wake() // deferred
    coalescer.stop()
    gate.resolve()
    await coalescer.inFlight()

    // The deferred wake must not fire after shutdown: a tick that starts while the daemon is
    // draining spawns a slave nothing is left to supervise.
    expect(runs).toBe(1)
  })

  it('waits for the whole chain, not just the current run', async (): Promise<void> => {
    let finished = 0
    const gates = [deferred(), deferred()]
    const coalescer = createCoalescer(async (): Promise<void> => {
      const gate = gates[finished]
      await gate?.promise
      finished += 1
    })

    coalescer.wake()
    coalescer.wake() // deferred, and it must be awaited too
    gates[0]?.resolve()
    // Resolved *after* the wait has begun, so awaiting only the promise that was in flight when
    // `inFlight()` was called returns while the deferred run is still going. Resolving both up
    // front lets the whole chain finish in microtasks, which hides the difference entirely.
    setTimeout(() => gates[1]?.resolve(), 50)

    await coalescer.inFlight()
    expect(finished).toBe(2)
  })

  it('keeps going after a run throws', async (): Promise<void> => {
    let runs = 0
    const coalescer = createCoalescer(async (): Promise<void> => {
      runs += 1
      throw new Error('tick failed')
    })

    coalescer.wake()
    await coalescer.inFlight()
    coalescer.wake()
    await coalescer.inFlight()

    // A failed tick must not take the daemon down: the next one reloads the world from scratch.
    expect(runs).toBe(2)
  })
})
