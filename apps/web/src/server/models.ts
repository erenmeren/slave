import { listProviderModels, type ModelListing, type ProviderKind } from '@slave-of-ai/control'

const FRESH_MS = 5 * 60_000
const FAILED_MS = 30_000

interface Entry {
  readonly at: number
  readonly listing: Promise<ModelListing>
}

const cache = new Map<ProviderKind, Entry>()

/** Test seam only. */
export function clearModelCache(): void {
  cache.clear()
}

/**
 * The provider's model list, cached in-process (M25 §5.2): five minutes for a good read, thirty
 * seconds for a failed one so a flapping CLI is not hammered by every open form. `refresh`
 * bypasses and replaces the entry. The Cursor binary override is the same env var `versionOf`
 * honours (`settings.ts`), so a test or a pinned install points both probes at one executable.
 * Concurrent callers before the first read settles share one CLI run.
 */
export async function listModelsFor(kind: ProviderKind, options?: { readonly refresh?: true }): Promise<ModelListing> {
  const hit = cache.get(kind)
  if (hit !== undefined && options?.refresh !== true) {
    const settled = await hit.listing
    // Stamped AFTER the await, not before (M25 final review, folded minor): a slow first read
    // would otherwise have every caller that arrived while it was in flight measure the entry's
    // age from ITS OWN call time rather than from when the read actually settled, under-aging the
    // entry by however long that read took.
    const now = Date.now()
    const ttl = settled.error === undefined ? FRESH_MS : FAILED_MS
    if (now - hit.at < ttl) return settled
  }
  const now = Date.now()
  const cursorCommand = process.env['SLAVEOFAI_CURSOR_BIN']
  const listing = listProviderModels(
    kind,
    cursorCommand !== undefined && cursorCommand !== '' ? { cursorCommand } : {},
  )
  cache.set(kind, { at: now, listing })
  return listing
}
