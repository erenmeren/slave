/**
 * A single-producer, single-consumer async queue backing an adapter's `events()`.
 *
 * Buffers pushed items until something iterates; never drops one. Closing it ends the iteration
 * for whoever is currently waiting (or will next call `next()`), without discarding anything
 * already buffered.
 *
 * ONE copy, as of M13 Series B. There were two, byte-identical apart from a comment, and
 * `cursor/adapter.ts` carried a note saying so: M12's Series A froze `claude/` so the class could
 * not be exported from where it already lived, and duplicating it was the honest move at the time.
 * That freeze is lifted here, for exactly this.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T, undefined>) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter({ value: item, done: false })
    } else {
      this.buffered.push(item)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: (): Promise<IteratorResult<T, undefined>> => {
        if (this.buffered.length > 0) {
          // Length just checked above; shift() cannot return undefined here.
          const value = this.buffered.shift() as T
          return Promise.resolve({ value, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}
