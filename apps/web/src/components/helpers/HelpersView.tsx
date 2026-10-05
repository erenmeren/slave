'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { SearchIcon } from 'lucide-react'
import type { HelperRow } from '@slave-of-ai/control'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

/** A mark per speciality, so a long catalogue scans by what people are good at. Decorative. */
const SPECIALITY_MARK: Readonly<Record<string, string>> = {
  engineering: '💻',
  design: '🎨',
  marketing: '📢',
  product: '📊',
  'project-management': '🗂️',
  testing: '🧪',
  security: '🔒',
  support: '🛟',
  sales: '💼',
  specialized: '🎯',
  finance: '💵',
  'game-development': '🎮',
  'spatial-computing': '🥽',
  academic: '📚',
  research: '🔍',
}

/** "project-management" → "Project management". */
export function specialityWord(speciality: string): string {
  const spaced = speciality.replace(/[-_]+/gu, ' ').trim()
  return spaced === '' ? speciality : `${spaced[0]?.toUpperCase() ?? ''}${spaced.slice(1)}`
}

/** The specialities, busiest first, then by name. */
export function specialitiesOf(helpers: readonly HelperRow[]): readonly { readonly key: string; readonly count: number }[] {
  const counts = new Map<string, number>()
  for (const helper of helpers) if (helper.speciality !== null) counts.set(helper.speciality, (counts.get(helper.speciality) ?? 0) + 1)
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** A helper matches a search when every word of it is in their name, role, line or skills. */
export function matches(helper: HelperRow, query: string): boolean {
  const haystack = [helper.name, helper.role ?? '', helper.description, ...helper.skills].join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/u).filter((word) => word !== '').every((word) => haystack.includes(word))
}

/**
 * Lead UX design section 6.5: who can the lead call on? The catalogue, read-only -- a search, the
 * specialities as chips, and one card per specialist. Choosing a project's helpers is done in that
 * project's Settings sheet.
 */
export function HelpersView({ helpers }: { readonly helpers: readonly HelperRow[] }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [speciality, setSpeciality] = useState<string | null>(null)
  const specialities = useMemo(() => specialitiesOf(helpers), [helpers])
  const shown = helpers.filter((helper) => (speciality === null || helper.speciality === speciality) && matches(helper, query))

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-8 md:px-8" data-testid="helpers">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Helpers</h1>
        <p className="text-sm text-muted-foreground">The specialists a lead may call on. Choose a project&apos;s helpers in its Settings.</p>
      </div>

      {helpers.length === 0 ? (
        <Card className="py-12 text-center" data-testid="helpers-empty">
          <CardHeader>
            <CardTitle className="text-base">No specialists in the catalogue yet.</CardTitle>
            <CardDescription>
              Import a catalogue from the command line: <code className="font-mono">import-catalog</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div className="relative max-w-md">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search specialists" placeholder="Search by name, role or skill…" className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} data-testid="helpers-search" />
            </div>
            {specialities.length > 0 && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Specialities">
                <Button size="sm" variant={speciality === null ? 'secondary' : 'ghost'} className="h-7" onClick={() => setSpeciality(null)}>
                  All ({helpers.length})
                </Button>
                {specialities.map((entry) => (
                  <Button key={entry.key} size="sm" variant={speciality === entry.key ? 'secondary' : 'ghost'} className="h-7" onClick={() => setSpeciality(speciality === entry.key ? null : entry.key)} data-testid="speciality-chip">
                    <span aria-hidden>{SPECIALITY_MARK[entry.key] ?? '✨'}</span>
                    {specialityWord(entry.key)} ({entry.count})
                  </Button>
                ))}
              </div>
            )}
          </div>

          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No specialist matches.</p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((helper) => (
                <li key={helper.id}>
                  <Card className="h-full gap-3" data-testid="helper-card">
                    <CardHeader className="gap-1">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <span aria-hidden>{helper.speciality === null ? '✨' : (SPECIALITY_MARK[helper.speciality] ?? '✨')}</span>
                        <span className="truncate">{helper.name}</span>
                      </CardTitle>
                      {helper.role !== null && <CardDescription>{helper.role}</CardDescription>}
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3 text-sm">
                      {helper.description !== '' && <p className="line-clamp-3 text-muted-foreground">{helper.description}</p>}
                      {helper.skills.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {helper.skills.slice(0, 6).map((skill) => (
                            <Badge key={skill} variant="secondary" className="font-normal">
                              {skill}
                            </Badge>
                          ))}
                          {helper.skills.length > 6 && <Badge variant="outline">+{helper.skills.length - 6}</Badge>}
                        </div>
                      )}
                      {helper.projects.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          On the helper list of{' '}
                          {helper.projects.map((project, index) => (
                            <span key={project.id}>
                              {index > 0 && ', '}
                              <Link href={`/w/${project.id}`} className="underline underline-offset-2">
                                {project.name}
                              </Link>
                            </span>
                          ))}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
