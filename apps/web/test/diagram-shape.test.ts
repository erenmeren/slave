import { describe, expect, it } from 'vitest'
import { layoutDiagram } from '../src/components/diagram/layout'
import { CARD_SIZE, GROUP_OVER, costOf, diagramShape, layoutKey } from '../src/components/diagram/shape'
import { MAX_WIDTH, barsOf, lanesOf, scaleOf, spanOf, ticksOf, xOf } from '../src/components/diagram/timeline'
import { endOf, formatDuration, toneOfState } from '../src/components/diagram/words'
import { viewHref, viewOf } from '../src/components/project/views'
import { at, call, diagramFixture, manyCallsOf } from './fixtures/diagram'

describe('the team diagram\'s shape', () => {
  it('draws You, the lead, a card per session of a helper called a few times, the checker and the result', () => {
    const shape = diagramShape(diagramFixture())
    expect(shape.cards.map((card) => [card.id, card.data.kind, card.data.badge, card.data.tone])).toEqual([
      ['request', 'request', '', 'muted'],
      ['lead', 'lead', 'Working', 'info'],
      ['session:call-a', 'session', 'Finished', 'success'],
      ['session:call-b', 'session', 'Working', 'info'],
      ['checker', 'checker', 'Finished', 'success'],
      ['result', 'result', 'Not there yet', 'muted'],
    ])
    expect(shape.cards[1]?.data).toMatchObject({ role: '2 turns', sentence: 'Running npm test', steps: '4 steps', failed: '1 failed', cost: '$3.90 so far' })
    expect(shape.cards[2]?.data).toMatchObject({ name: 'Bea', role: 'helper · call 1 of 2', asked: 'fix the delete route', sentence: 'Not working now', cost: "cost in the lead's", nodeId: 'helper:bea', sessionId: 'call-a' })
    expect(shape.cards[3]?.data).toMatchObject({ sentence: 'Editing src/app.ts', working: true })
    expect(shape.cards[4]?.data).toMatchObject({ role: '1 check', cost: '$0.25' })
    expect(shape.cards[0]?.data.sentence).toBe('Build a todo app.')
  })

  it('draws the lines with their words, moving only towards somebody working', () => {
    const shape = diagramShape(diagramFixture())
    expect(shape.lines.map((line) => [line.source, line.target, line.label, line.tone, line.moving])).toEqual([
      ['request', 'lead', 'build 2', 'info', true],
      ['lead', 'session:call-a', 'call 1 of 2', 'success', false],
      ['lead', 'session:call-b', 'call 2 of 2', 'info', true],
      ['lead', 'checker', 'check 1', 'success', false],
      ['checker', 'result', null, 'muted', false],
    ])
  })

  it('draws a helper called often as one card with its count, opened to its sessions on demand', () => {
    const build = manyCallsOf(GROUP_OVER + 2)
    const closed = diagramShape(build)
    expect(closed.cards.filter((card) => card.data.nodeId === 'helper:bea').map((card) => [card.id, card.data.group, card.data.expanded])).toEqual([['helper:bea', 5, false]])
    expect(closed.lines.find((line) => line.target === 'helper:bea')?.label).toBe('called 5 times')

    const open = diagramShape(build, new Set(['helper:bea']))
    expect(open.cards.filter((card) => card.data.nodeId === 'helper:bea').map((card) => card.id)).toEqual(['helper:bea', 'session:call-0', 'session:call-1', 'session:call-2', 'session:call-3', 'session:call-4'])
    expect(open.cards.find((card) => card.id === 'helper:bea')?.data.expanded).toBe(true)
    expect(open.lines.filter((line) => line.source === 'helper:bea').map((line) => [line.target, line.label])).toEqual([
      ['session:call-0', 'call 1'],
      ['session:call-1', 'call 2'],
      ['session:call-2', 'call 3'],
      ['session:call-3', 'call 4'],
      ['session:call-4', 'call 5'],
    ])
  })

  it('colours by state: blue builds, violet checks, amber waits, red failed, and the result by what came of it', () => {
    expect([toneOfState('working', false), toneOfState('working', true), toneOfState('paused', false), toneOfState('failed', true), toneOfState('done', false)]).toEqual(['info', 'checking', 'warning', 'destructive', 'success'])
    expect(diagramShape(diagramFixture({ result: 'merged' })).cards.at(-1)?.data).toMatchObject({ badge: 'Merged', tone: 'success' })
    expect(diagramShape(diagramFixture({ result: 'waiting_for_you' })).cards.at(-1)?.data).toMatchObject({ badge: 'Waiting for you', tone: 'warning' })
    expect(diagramShape(diagramFixture({ result: 'left_unmerged' })).cards.at(-1)?.data.badge).toBe('Left unmerged')
  })

  it('says a cost, or where it is', () => {
    expect([costOf('lead', 2, false), costOf('lead', null, true), costOf('checker', null, false), costOf('helper', null, true), costOf('result', null, false)]).toEqual(['$2', 'cost when it ends', 'cost not reported', "cost in the lead's", null])
  })

  it('keeps the layout key through a re-read that changes only what the cards say, and changes it with the set of cards', () => {
    const before = diagramFixture()
    const after = diagramFixture({ nodes: before.nodes.map((node) => (node.id === 'lead' ? { ...node, doing: 'Editing src/x.ts', toolCalls: 99, state: 'paused' as const } : node)), at: at(1300) })
    expect(layoutKey(diagramShape(after), 'RIGHT')).toBe(layoutKey(diagramShape(before), 'RIGHT'))
    expect(layoutKey(diagramShape(before), 'DOWN')).not.toBe(layoutKey(diagramShape(before), 'RIGHT'))
    const more = diagramFixture({ sessions: [...before.sessions, { ...before.sessions[4]!, id: 'call-c', startedAt: at(1100) }] })
    expect(layoutKey(diagramShape(more), 'RIGHT')).not.toBe(layoutKey(diagramShape(before), 'RIGHT'))
  })

  it('lays the cards out in layers, none on another, the request first and the lead before whom it called', async () => {
    const shape = diagramShape(manyCallsOf(6), new Set(['helper:bea']))
    const positions = await layoutDiagram(shape, 'RIGHT')
    expect(positions.size).toBe(shape.cards.length)
    const boxes = shape.cards.map((card) => ({ id: card.id, ...positions.get(card.id)!, width: card.width, height: card.height }))
    for (const a of boxes) for (const b of boxes) if (a.id < b.id) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} over ${b.id}`).toBe(true)
    const x = (id: string): number => positions.get(id)?.x ?? -1
    expect(x('request')).toBeLessThan(x('lead'))
    expect(x('lead') + CARD_SIZE.person.width).toBeLessThan(x('helper:bea'))
    expect(x('helper:bea') + CARD_SIZE.person.width).toBeLessThan(x('session:call-0'))

    const down = await layoutDiagram(shape, 'DOWN')
    expect(down.get('request')?.y ?? 0).toBeLessThan(down.get('lead')?.y ?? 0)
    expect(await layoutDiagram({ cards: [], lines: [] }, 'RIGHT')).toEqual(new Map())
  })
})

describe('the timeline\'s arithmetic', () => {
  const build = diagramFixture()

  it('fits the whole build in the viewport, with a little air after its end', () => {
    const scale = scaleOf(build, 'fit', 1000)
    expect(scale).toMatchObject({ from: Date.parse(at(0)), width: 1000, cut: false })
    expect(scale.to).toBeGreaterThan(endOf(build))
    expect(xOf(scale, Date.parse(at(0)))).toBe(0)
    expect(xOf(scale, endOf(build))).toBeLessThan(1000)
  })

  it('zooms to fifteen minutes a viewport and scrolls the rest; a build shorter than the zoom just fits', () => {
    const scale = scaleOf(build, '15m', 900)
    // Twenty minutes and its air at one pixel a second.
    expect(scale.width).toBeGreaterThan(1200)
    expect(scale.width).toBeLessThan(1300)
    expect(scaleOf(build, '1h', 900)).toMatchObject({ width: 900, cut: false })
  })

  it('cuts a very long build at its old end instead of drawing it wider than the cap', () => {
    const long = diagramFixture({ to: at(40 * 3600), at: at(40 * 3600) })
    const scale = scaleOf(long, '15m', 1000)
    expect(scale).toMatchObject({ width: MAX_WIDTH, cut: true })
    expect(scale.from).toBeGreaterThan(Date.parse(long.from))
    expect(scaleOf(long, 'fit', 1000)).toMatchObject({ width: 1000, cut: false })
  })

  it('gives each person a lane, and sessions open at once a row each', () => {
    const lanes = lanesOf(build)
    expect(lanes.map((lane) => [lane.node.id, lane.rows])).toEqual([
      ['lead', 1],
      ['helper:bea', 2],
      ['checker', 1],
    ])
    expect([...(lanes[1]?.rowOf ?? [])]).toEqual([
      ['call-a', 0],
      ['call-b', 1],
    ])
    // One after another: one row is enough.
    expect(lanesOf(manyCallsOf(6)).find((lane) => lane.node.id === 'helper:bea')?.rows).toBe(1)
  })

  it('draws a step from its call to its result, an open one to the end, each on its session\'s row', () => {
    const scale = scaleOf(build, 'fit', 1000)
    const lanes = lanesOf(build)
    const lead = barsOf(lanes[0]!, build.calls, scale, endOf(build))
    expect(lead.map((bar) => [bar.calls[0]?.id, bar.tone, bar.open, bar.row])).toEqual([
      ['1', 'ok', false, 0],
      ['2', 'ok', false, 0],
      ['4', 'error', false, 0],
      ['8', 'running', true, 0],
    ])
    expect(lead[1]?.x).toBeCloseTo(xOf(scale, Date.parse(at(100))), 5)
    expect(lead[1]?.width).toBeCloseTo(xOf(scale, Date.parse(at(400))) - xOf(scale, Date.parse(at(100))), 5)
    expect((lead[3]?.x ?? 0) + (lead[3]?.width ?? 0)).toBeCloseTo(xOf(scale, endOf(build)), 5)
    expect(barsOf(lanes[1]!, build.calls, scale, endOf(build)).map((bar) => [bar.calls[0]?.id, bar.row])).toEqual([
      ['5', 0],
      ['6', 0],
      ['7', 1],
    ])
  })

  it('draws thousands of short steps as a few blocks, each saying how many it holds and the worst of them', () => {
    const many = Array.from({ length: 5000 }, (_, index) => call(`m-${String(index)}`, 'lead', 'run-0', index * 0.1, index * 0.1 + 0.05, `Reading file-${String(index)}.ts`, index === 2500 ? 'error' : 'ok'))
    const long = diagramFixture({ calls: many })
    const scale = scaleOf(long, 'fit', 1000)
    const bars = barsOf(lanesOf(long)[0]!, long.calls, scale, endOf(long))
    expect(bars.length).toBeLessThan(200)
    expect(bars.reduce((total, bar) => total + bar.calls.length, 0)).toBe(5000)
    expect(bars.filter((bar) => bar.tone === 'error')).toHaveLength(1)
    // A step called before the drawing starts and ended before it too is left out.
    const cut = { ...scale, from: Date.parse(at(250)) }
    expect(barsOf(lanesOf(long)[0]!, long.calls, cut, endOf(long)).reduce((total, bar) => total + bar.calls.length, 0)).toBeLessThan(5000)
  })

  it('marks the axis at round times, and boxes a stretch of time on the drawing', () => {
    const scale = scaleOf(build, 'fit', 1000)
    const ticks = ticksOf(scale)
    expect(ticks.length).toBeGreaterThan(3)
    expect(ticks.length).toBeLessThan(12)
    expect(ticks.every((tick) => /^\d\d:\d\d$/u.test(tick.label) && tick.x >= 0 && tick.x <= 1000)).toBe(true)
    expect(spanOf(scale, Date.parse(at(450)), Date.parse(at(500)))).toMatchObject({ x: xOf(scale, Date.parse(at(450))) })
    expect(spanOf(scale, Date.parse(at(-100)), Date.parse(at(-50)))).toBeNull()
  })

  it('says how long something took', () => {
    expect([formatDuration(300), formatDuration(4_000), formatDuration(125_000), formatDuration(120_000), formatDuration(3_780_000), formatDuration(7_200_000)]).toEqual(['under a second', '4 s', '2 min 5 s', '2 min', '1 h 3 min', '2 h'])
  })
})

describe('the Project screen\'s views', () => {
  it('reads the view from the URL, anything else being Overview', () => {
    expect([viewOf('diagram'), viewOf('timeline'), viewOf('overview'), viewOf('x'), viewOf(undefined), viewOf(['diagram'])]).toEqual(['diagram', 'timeline', 'overview', 'overview', 'overview', 'overview'])
  })

  it('writes the view into the URL, Overview being the plain address', () => {
    expect([viewHref('/w/1', 'overview'), viewHref('/w/1', 'diagram'), viewHref('/w/1', 'timeline')]).toEqual(['/w/1', '/w/1?view=diagram', '/w/1?view=timeline'])
  })
})
