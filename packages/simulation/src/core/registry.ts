import type { AnySectorPlugin } from './plugin.js'
import { tradePlugin } from '../trade/plugin.js'

/** Every sector the platform knows, by name (M31b design §2). Software is added in task 2; this
 *  task registers only trade, wrapping what M29/M30/M31a already built untouched. Control and web
 *  never name a sector except through this object or `sectorFor`. */
export const sectors = { trade: tradePlugin } as const

export type SectorName = keyof typeof sectors

/** A plain object lookup, guarded by `Object.hasOwn` so a name like `'__proto__'` or
 *  `'constructor'` -- present on every object via the prototype chain, not as the object's own
 *  property -- reads as unregistered rather than resolving to `Object.prototype` machinery. */
export function sectorFor(name: string): AnySectorPlugin | undefined {
  return Object.hasOwn(sectors, name) ? (sectors as Readonly<Record<string, AnySectorPlugin>>)[name] : undefined
}
