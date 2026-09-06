import { describe, expect, it } from 'vitest'
import { emptyQueue, enqueue, popDue } from '../../src/core/queue.js'

describe('EventQueue', () => {
  it('pops same-day events by priority class then enqueue order, and leaves later days', () => {
    let q = emptyQueue<string>()
    q = enqueue(q, 3, 'close', 'c')
    q = enqueue(q, 3, 'decision', 'd')
    q = enqueue(q, 3, 'external', 'x1')
    q = enqueue(q, 4, 'external', 'later')
    q = enqueue(q, 3, 'scheduled', 's')
    q = enqueue(q, 3, 'external', 'x2')
    const { due, rest } = popDue(q, 3)
    expect(due.map((e) => e.event)).toEqual(['x1', 'x2', 's', 'd', 'c'])
    expect(rest.items.map((e) => e.event)).toEqual(['later'])
  })
  it('also pops anything overdue (time before the asked day), never anything after it', () => {
    let q = emptyQueue<string>()
    q = enqueue(q, 1, 'scheduled', 'old')
    q = enqueue(q, 2, 'scheduled', 'now')
    q = enqueue(q, 3, 'scheduled', 'next')
    const { due } = popDue(q, 2)
    expect(due.map((e) => e.event)).toEqual(['old', 'now'])
  })
  it('never mutates its input', () => {
    const q0 = emptyQueue<string>()
    const q1 = enqueue(q0, 1, 'scheduled', 'a')
    expect(q0.items).toHaveLength(0)
    expect(q1.items).toHaveLength(1)
  })
})
