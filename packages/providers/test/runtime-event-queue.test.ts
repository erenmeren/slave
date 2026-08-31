import { describe, expect, it } from 'vitest'
import { AsyncEventQueue } from '../src/runtime/event-queue.js'

async function collect<T>(queue: AsyncEventQueue<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of queue) out.push(item)
  return out
}

describe('AsyncEventQueue (characterization — pins M13 behaviour, changes nothing)', () => {
  it('buffers items pushed before iteration starts and yields them in order', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1); queue.push(2); queue.close()
    expect(await collect(queue)).toEqual([1, 2])
  })

  it('wakes a waiting iterator when an item arrives after it started waiting', async () => {
    const queue = new AsyncEventQueue<string>()
    const pending = collect(queue)
    queue.push('late')
    queue.close()
    expect(await pending).toEqual(['late'])
  })

  it('close() with a waiter pending ends iteration cleanly', async () => {
    const queue = new AsyncEventQueue<never>()
    const pending = collect(queue)
    queue.close()
    expect(await pending).toEqual([])
  })

  it('push after close is dropped silently', async () => {
    const queue = new AsyncEventQueue<number>()
    queue.push(1)
    queue.close()
    queue.push(2)
    expect(await collect(queue)).toEqual([1])
  })

  it('a waiter registered before either push receives both, in order, across the wakeup and the drain', async () => {
    // Distinct from the two scenarios above: the collector starts (and registers a waiter) before
    // any push, then two pushes land before close. The first push wakes the registered waiter
    // synchronously; by the time the second push runs, that resumption is still a pending
    // microtask, so the second item lands in `buffered` instead of finding a waiter. This exercises
    // both the waiter-wakeup branch (`push`'s `waiter !== undefined` case) and the buffered-drain
    // branch in the same run, with a live consumer already attached rather than iteration starting
    // after everything is queued.
    const queue = new AsyncEventQueue<number>()
    const pending = collect(queue)
    queue.push(1); queue.push(2)
    queue.close()
    expect(await pending).toEqual([1, 2])
  })
})
