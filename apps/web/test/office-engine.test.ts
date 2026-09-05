import { describe, expect, it } from 'vitest'
import { DEPT_COLORS, SLAVE_COLORS, STATUS, WorldF, makeDepartments, renderIsoE, setPixelFont, tod } from '../src/lib/office/engine.js'

/** A 2D context that accepts every call the engine makes and answers `measureText`. Any property
 *  read is a chainable no-op function (so `createLinearGradient(...).addColorStop(...)` works),
 *  any write is accepted, and `canvas` reports a size. */
function fakeContext(width = 800, height = 500): CanvasRenderingContext2D {
  const fake: unknown = new Proxy(function noop() {}, {
    get(_target, key) {
      if (key === 'canvas') return { width, height }
      if (key === 'measureText') return () => ({ width: 10 })
      return () => fake
    },
    set() {
      return true
    },
  })
  return fake as CanvasRenderingContext2D
}

const DEPARTMENTS = [
  { name: 'Engineering', color: '#2ee6cf', slaves: [{ name: 'Alex', role: 'backend' }, { name: 'Maya', role: 'qa' }] },
  { name: 'Product', color: '#7b8cff', slaves: [{ name: 'John', role: 'analyst' }] },
]

describe('the vendored office engine', () => {
  it('builds one desk per slave, in department order, and names departments as given', () => {
    const world = new WorldF({ departments: DEPARTMENTS })
    expect(world.departments.map((d) => d.name)).toEqual(['Engineering', 'Product'])
    expect(world.slaves.map((s) => s.name)).toEqual(['Alex', 'Maya', 'John'])
    expect(world.desks).toHaveLength(3)
    expect(world.desks.map((d) => d.slave?.name)).toEqual(['Alex', 'Maya', 'John'])
    expect(world.slaves.every((s) => s.state === 'sit')).toBe(true)
  })

  it('exposes the palettes the server read colours departments and slaves with', () => {
    expect(DEPT_COLORS).toHaveLength(12)
    expect(DEPT_COLORS[1]).toBe('#2ee6cf')
    expect(SLAVE_COLORS).toHaveLength(6)
    expect(STATUS.working).toBe('#2ee6cf')
    expect(tod(12).label).toBeTypeOf('string')
    expect(makeDepartments(2, 3)[0]?.slaves).toHaveLength(3)
  })

  it('ticks and renders one isometric frame against a recording context without throwing', () => {
    const world = new WorldF({ departments: DEPARTMENTS })
    setPixelFont('Silkscreen')
    for (let i = 0; i < 20; i++) world.tick(0.05)
    expect(() => renderIsoE(fakeContext(), world, { viewKey: 'view', tod: true, fun: true, autofit: true, deptSigns: 'banner' })).not.toThrow()
    expect(world.view?.levels).toHaveLength(4)
    expect(world.t).toBeCloseTo(1, 5)
  })

  it('splits tick into the clock and the simulation so an adapter can replace the simulation', () => {
    const world = new WorldF({ departments: DEPARTMENTS })
    let simulated = 0
    world.simulate = () => {
      simulated += 1
    }
    world.tick(0.1)
    expect(simulated).toBe(1)
    expect(world.t).toBeCloseTo(0.1, 5)
  })

  it('draws the empty floor for a project with no departments (R2)', () => {
    const world = new WorldF({ departments: [] })
    for (let i = 0; i < 20; i++) world.tick(0.05)
    expect(() => renderIsoE(fakeContext(), world, { viewKey: 'view', tod: true, fun: true, autofit: true, deptSigns: 'banner' })).not.toThrow()
  })
})
