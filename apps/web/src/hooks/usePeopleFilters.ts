'use client'

import { PEOPLE_FILTER_PARAMS, parsePeopleFilters, peopleFilterParams, type PeopleFilters } from '../lib/peopleFilters'
import { useUrlFilterSpec, type UrlFilterSpec } from './useUrlFilterSpec'

const PEOPLE_URL: UrlFilterSpec<PeopleFilters> = {
  keys: PEOPLE_FILTER_PARAMS,
  parse: parsePeopleFilters,
  toParams: peopleFilterParams,
}

/** People's filters, carried in the URL (workforce cards §1) -- the catalog's idiom, People's words. */
export function usePeopleFilters(): {
  readonly filters: PeopleFilters
  readonly setFilters: (next: PeopleFilters) => void
} {
  return useUrlFilterSpec(PEOPLE_URL)
}
