'use client'

import { useEffect } from 'react'
import { publishShellFacts } from '../../hooks/useShellFacts'
import type { ShellFacts } from '../../server/shell'

/**
 * Puts the project layout's server-read facts into the module store the header reads (spec
 * erratum E12).
 *
 * It renders NOTHING. It exists because `useShellFacts` is a module-level `useSyncExternalStore`
 * publisher — the shape M24 was forced into when the header was a sibling of `{children}` — and
 * only five of this segment's eight page clients publish into it. Three pages
 * (`/organization`, `/knowledge`, `/office`) never did, and before this component the header simply
 * had nothing to show on them.
 *
 * A page that DOES stream publishes its own snapshot on mount and on every refetch, which
 * overwrites this seed with something fresher — so this is a floor, never a ceiling, and there is
 * no ordering to get right between the two.
 *
 * The retraction is keyed on the workspace alone, exactly as every page client's is: folding it
 * into the publish effect's cleanup would retract and re-publish on every re-render, and the header
 * would blink through its empty state in between.
 */
export function ShellFactsSeed({ facts }: { readonly facts: ShellFacts }): null {
  useEffect((): void => {
    publishShellFacts(facts.workspace.id, facts)
  }, [facts])
  useEffect((): (() => void) => () => publishShellFacts(facts.workspace.id, null), [facts.workspace.id])
  return null
}
