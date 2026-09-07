import type { AnySectorPlugin, SectorName } from './plugin.js'
import { softwarePlugin } from '../software/plugin.js'
import { tradePlugin } from '../trade/plugin.js'

/** Every sector the platform knows, by name (M31b design §2). Control and web never name a sector
 *  except through this object or `sectorFor`; adding a third is one entry here and one directory
 *  under `src/`, with nothing outside `packages/simulation` to change. */
export const sectors = { trade: tradePlugin, software: softwarePlugin } as const satisfies Readonly<Record<SectorName, AnySectorPlugin>>

/** A plain object lookup, guarded by `Object.hasOwn` so a name like `'__proto__'` or
 *  `'constructor'` -- present on every object via the prototype chain, not as the object's own
 *  property -- reads as unregistered rather than resolving to `Object.prototype` machinery. */
export function sectorFor(name: string): AnySectorPlugin | undefined {
  return Object.hasOwn(sectors, name) ? (sectors as Readonly<Record<string, AnySectorPlugin>>)[name] : undefined
}
