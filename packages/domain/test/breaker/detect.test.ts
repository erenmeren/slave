import { describe, expect, it } from 'vitest'
import {
  BREAKER_LEVELS,
  BREAKER_LEVEL_LABEL,
  BREAKER_TRIP_KINDS,
  BREAKER_TRIP_LABEL,
  type BreakerRow,
  type BreakerWindow,
  detectBehaviour,
} from '../../src/breaker/detect.js'
import { ERROR_STORM_COUNT, REPEAT_TRIP_COUNT } from '../../src/breaker/constants.js'

let seq = 0
const call = (key: string, toolUseId: string): BreakerRow => ({
  kind: 'call',
  seq: (seq += 1),
  toolUseId,
  key,
})
const result = (toolUseId: string, outcome: 'ok' | 'error'): BreakerRow => ({
  kind: 'result',
  seq: (seq += 1),
  toolUseId,
  outcome,
})
const output = (): BreakerRow => ({ kind: 'output', seq: (seq += 1) })

/** A run that has done nothing interesting: healthy level, no trips, every clock live. */
const WINDOW = (rows: readonly BreakerRow[], over: Partial<BreakerWindow> = {}): BreakerWindow => ({
  level: 'none',
  trips: 0,
  steers: 0,
  quietBeats: 0,
  rows,
  progress: { distinctKey: true, worktreeChanged: true, output: true },
  ...over,
})

/** N complete repeats of one key: call, result, call, result... */
const repeats = (n: number, key = 'Bash:aaaa'): readonly BreakerRow[] =>
  Array.from({ length: n }).flatMap((_, i) => [call(key, `t${String(i)}`), result(`t${String(i)}`, 'ok')])

describe('the breaker vocabulary', () => {
  it('is three levels, never four -- `stopped` is a run status, not a breaker level', () => {
    expect(BREAKER_LEVELS).toEqual(['none', 'steered', 'constrained'])
    expect(BREAKER_LEVELS).not.toContain('stopped')
  })

  it('gives every level and every trip a word', () => {
    for (const level of BREAKER_LEVELS) expect(BREAKER_LEVEL_LABEL[level], level).toMatch(/^[A-Z]/u)
    for (const kind of BREAKER_TRIP_KINDS) expect(BREAKER_TRIP_LABEL[kind], kind).toMatch(/^[A-Z]/u)
  })
})

describe('detectBehaviour: a healthy run', () => {
  it('is healthy with nothing in the window at all', () => {
    expect(detectBehaviour(WINDOW([]))).toEqual({ level: 'none', trip: null })
  })

  it('is healthy with seven repeats -- the trip is at eight', () => {
    expect(detectBehaviour(WINDOW(repeats(REPEAT_TRIP_COUNT - 1))).trip).toBeNull()
  })

  it('is healthy when a different key interrupted the run of repeats', () => {
    const rows = [...repeats(REPEAT_TRIP_COUNT), call('Read:bbbb', 'x'), result('x', 'ok'), ...repeats(3)]
    expect(detectBehaviour(WINDOW(rows)).trip).toBeNull()
  })

  it('is healthy when the window is nothing but output', () => {
    expect(detectBehaviour(WINDOW([output(), output()])).trip).toBeNull()
  })
})

describe('detectBehaviour: repeated_call', () => {
  it('trips at the eighth consecutive identical key and names the key in `detail`', () => {
    const verdict = detectBehaviour(WINDOW(repeats(REPEAT_TRIP_COUNT)))
    expect(verdict.level).toBe('steered')
    expect(verdict.trip).toEqual({ kind: 'repeated_call', count: REPEAT_TRIP_COUNT, detail: 'Bash:aaaa' })
  })

  it('counts only the TRAILING run -- a run of eight ended by a distinct key is over', () => {
    const rows = [...repeats(REPEAT_TRIP_COUNT), call('Read:bbbb', 'z'), result('z', 'ok')]
    expect(detectBehaviour(WINDOW(rows)).trip).toBeNull()
  })
})

describe('detectBehaviour: error_storm', () => {
  it('trips at five consecutive errors whatever the tool was', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((id, i) => [
      call(`Tool${String(i)}:x`, id),
      result(id, 'error'),
    ])
    const verdict = detectBehaviour(WINDOW(rows))
    expect(verdict.level).toBe('steered')
    expect(verdict.trip?.kind).toBe('error_storm')
    expect(verdict.trip?.count).toBe(ERROR_STORM_COUNT)
  })

  it('does not trip when one of the five succeeded', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((id, i) => [
      call(`Tool${String(i)}:x`, id),
      result(id, id === 'c' ? 'ok' : 'error'),
    ])
    expect(detectBehaviour(WINDOW(rows)).trip).toBeNull()
  })
})

describe('detectBehaviour: no_progress', () => {
  const quiet = { distinctKey: false, worktreeChanged: false, output: false }

  it('needs two consecutive quiet beats -- one is a pause, not a loop', () => {
    expect(detectBehaviour(WINDOW([], { progress: quiet, quietBeats: 0 })).trip).toBeNull()
    const verdict = detectBehaviour(WINDOW([], { progress: quiet, quietBeats: 1 }))
    expect(verdict.trip?.kind).toBe('no_progress')
  })

  it('is suppressed by ANY of the three clocks -- progress is a disjunction, not a signal', () => {
    for (const live of ['distinctKey', 'worktreeChanged', 'output'] as const) {
      const progress = { ...quiet, [live]: true }
      expect(detectBehaviour(WINDOW([], { progress, quietBeats: 9 })).trip, live).toBeNull()
    }
  })
})

describe('detectBehaviour: a tool call with no result yet suppresses EVERY arm', () => {
  // The quiet-long-build case, and the reason the whole design persists tool RESULTS.
  const building: readonly BreakerRow[] = [...repeats(REPEAT_TRIP_COUNT), call('Bash:aaaa', 'pending')]

  it('does not trip repeated_call while the last call is still running', () => {
    expect(detectBehaviour(WINDOW(building)).trip).toBeNull()
  })

  it('does not trip error_storm while the last call is still running', () => {
    const rows = [
      ...['a', 'b', 'c', 'd', 'e'].flatMap((id) => [call('Bash:x', id), result(id, 'error')]),
      call('Bash:x', 'pending'),
    ]
    expect(detectBehaviour(WINDOW(rows)).trip).toBeNull()
  })

  it('does not trip no_progress while the last call is still running, however quiet it is', () => {
    expect(
      detectBehaviour(
        WINDOW(building, { progress: { distinctKey: false, worktreeChanged: false, output: false }, quietBeats: 9 }),
      ).trip,
    ).toBeNull()
  })

  it('trips again the moment that call reports', () => {
    expect(detectBehaviour(WINDOW([...building, result('pending', 'ok')])).trip?.kind).toBe('repeated_call')
  })
})

describe('detectBehaviour: the ladder', () => {
  const tripping = repeats(REPEAT_TRIP_COUNT)

  it('asks for one rung above the stored level, never two', () => {
    expect(detectBehaviour(WINDOW(tripping, { level: 'none' })).level).toBe('steered')
    expect(detectBehaviour(WINDOW(tripping, { level: 'steered' })).level).toBe('constrained')
    expect(detectBehaviour(WINDOW(tripping, { level: 'constrained' })).level).toBe('stop')
  })

  it('skips the steer rung once a run has had its two, and never proposes a third', () => {
    expect(detectBehaviour(WINDOW(tripping, { level: 'none', steers: 2 })).level).toBe('constrained')
  })

  it('steps DOWN exactly one rung on a healthy beat, and carries no trip with it', () => {
    expect(detectBehaviour(WINDOW([], { level: 'constrained' }))).toEqual({ level: 'steered', trip: null })
    expect(detectBehaviour(WINDOW([], { level: 'steered' }))).toEqual({ level: 'none', trip: null })
    expect(detectBehaviour(WINDOW([], { level: 'none' }))).toEqual({ level: 'none', trip: null })
  })

  it('prefers repeated_call over error_storm when both fire, so one beat names one trip', () => {
    const rows = [
      ...Array.from({ length: REPEAT_TRIP_COUNT }).flatMap((_, i) => [
        call('Bash:aaaa', `t${String(i)}`),
        result(`t${String(i)}`, 'error'),
      ]),
    ]
    expect(detectBehaviour(WINDOW(rows)).trip?.kind).toBe('repeated_call')
  })
})
