'use client'

import { useCallback, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import {
  ACTIVITY_KINDS,
  EMPTY_ACTIVITY_FILTERS,
  parseActivityFilters,
  type ActivityFilters,
  type ActivityKind,
} from '../lib/activityFilters'

const KNOWN_KINDS = new Set<string>(ACTIVITY_KINDS)
const KNOWN_TYPES = new Set<string>(Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE))

function splitList(raw: string | null): readonly string[] {
  return (raw ?? '').split(',').filter(Boolean)
}

/**
 * Lenient read of a comma-list query param for *display* state: unknown tokens (a stale link
 * after a kind/type is renamed or removed, or a hand-edited URL) are silently dropped rather than
 * surfacing an error or crashing the popover/chips. This is deliberately looser than
 * `parseActivityFilters`'s `kinds`/`types` schema, which rejects the *entire* request on any one
 * unknown token — right for a fetch that must fail closed, wrong for "render whatever chips still
 * make sense."
 */
function leniently<T extends string>(raw: string | null, known: ReadonlySet<string>): readonly T[] {
  return splitList(raw).filter((token) => known.has(token)) as T[]
}

function buildParams(dimensions: {
  readonly slaves: readonly string[]
  readonly tasks: readonly string[]
  readonly kinds: readonly string[]
  readonly types: readonly string[]
}): URLSearchParams {
  const params = new URLSearchParams()
  if (dimensions.slaves.length > 0) params.set('slaves', [...dimensions.slaves].sort().join(','))
  if (dimensions.tasks.length > 0) params.set('tasks', [...dimensions.tasks].sort().join(','))
  if (dimensions.kinds.length > 0) params.set('kinds', [...dimensions.kinds].sort().join(','))
  if (dimensions.types.length > 0) params.set('types', [...dimensions.types].sort().join(','))
  return params
}

export interface UrlFilters {
  readonly filters: ActivityFilters
  readonly kinds: readonly ActivityKind[]
  readonly rawTypes: readonly DomainEventType[]
  readonly setKinds: (kinds: readonly ActivityKind[]) => void
  readonly setRawTypes: (types: readonly DomainEventType[]) => void
  readonly setSlaves: (ids: readonly string[]) => void
  readonly setTasks: (ids: readonly string[]) => void
}

/**
 * URL-carried state for the activity timeline's four filter dimensions (`?slaves=`, `?tasks=`,
 * `?kinds=`, `?types=`) — the same idiom as `useSelectedId`: each dimension lives in local React
 * state, seeded once from `useSearchParams()`, so a chip toggle re-renders synchronously;
 * `router.replace` is the side effect that keeps a refresh or a shared link able to restore it,
 * not the source of truth for the render.
 *
 * `kinds`/`rawTypes` are read via `leniently` (unknown tokens dropped — see its docblock) so a
 * stale/hand-edited URL never crashes the chip row or the advanced popover. `filters` is then
 * derived by feeding those *already-sanitized* dimensions back through `parseActivityFilters` —
 * the one place that expands kinds into their types and unions them with `?types=` (Task 1's
 * "single source of parsing truth"). Because this hook only ever hands it known-good tokens, the
 * `ok: false` branch below is unreachable in practice; the fallback to `EMPTY_ACTIVITY_FILTERS` is
 * kept only because `parseActivityFilters` returns a result, not a bare value.
 */
export function useUrlFilters(): UrlFilters {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [slaves, setSlavesState] = useState<readonly string[]>(() => splitList(searchParams.get('slaves')))
  const [tasks, setTasksState] = useState<readonly string[]>(() => splitList(searchParams.get('tasks')))
  const [kinds, setKindsState] = useState<readonly ActivityKind[]>(() =>
    leniently<ActivityKind>(searchParams.get('kinds'), KNOWN_KINDS),
  )
  const [rawTypes, setRawTypesState] = useState<readonly DomainEventType[]>(() =>
    leniently<DomainEventType>(searchParams.get('types'), KNOWN_TYPES),
  )

  const replaceUrl = useCallback(
    (next: {
      readonly slaves: readonly string[]
      readonly tasks: readonly string[]
      readonly kinds: readonly ActivityKind[]
      readonly types: readonly DomainEventType[]
    }): void => {
      const query = buildParams(next).toString()
      router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [router, pathname],
  )

  const setSlaves = useCallback(
    (ids: readonly string[]): void => {
      setSlavesState(ids)
      replaceUrl({ slaves: ids, tasks, kinds, types: rawTypes })
    },
    [replaceUrl, tasks, kinds, rawTypes],
  )

  const setTasks = useCallback(
    (ids: readonly string[]): void => {
      setTasksState(ids)
      replaceUrl({ slaves, tasks: ids, kinds, types: rawTypes })
    },
    [replaceUrl, slaves, kinds, rawTypes],
  )

  const setKinds = useCallback(
    (next: readonly ActivityKind[]): void => {
      setKindsState(next)
      replaceUrl({ slaves, tasks, kinds: next, types: rawTypes })
    },
    [replaceUrl, slaves, tasks, rawTypes],
  )

  const setRawTypes = useCallback(
    (next: readonly DomainEventType[]): void => {
      setRawTypesState(next)
      replaceUrl({ slaves, tasks, kinds, types: next })
    },
    [replaceUrl, slaves, tasks, kinds],
  )

  const filters = useMemo((): ActivityFilters => {
    const result = parseActivityFilters(buildParams({ slaves, tasks, kinds, types: rawTypes }))
    return result.ok ? result.filters : EMPTY_ACTIVITY_FILTERS
  }, [slaves, tasks, kinds, rawTypes])

  return { filters, kinds, rawTypes, setKinds, setRawTypes, setSlaves, setTasks }
}
