'use client'

import type { WorkforceCatalogFilters } from '@slave-of-ai/control'
import { CATALOG_FILTER_PARAMS, catalogFilterParams, parseCatalogFilters } from '../lib/catalogFilters'
import { useUrlFilterSpec, type UrlFilterSpec } from './useUrlFilterSpec'

const CATALOG_URL: UrlFilterSpec<WorkforceCatalogFilters> = {
  keys: CATALOG_FILTER_PARAMS,
  parse: parseCatalogFilters,
  toParams: catalogFilterParams,
}

/** The catalog's nine filters, carried in the URL (M46 R6, widened by M55 R3 and workforce cards)
 *  unless `urlSync` is false. Everything about HOW is `useUrlFilterSpec`'. */
export function useCatalogFilters(urlSync = true): {
  readonly filters: WorkforceCatalogFilters
  readonly setFilters: (next: WorkforceCatalogFilters) => void
} {
  return useUrlFilterSpec(CATALOG_URL, urlSync)
}
