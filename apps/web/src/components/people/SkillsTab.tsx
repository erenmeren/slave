'use client'

import { useState } from 'react'
import type { SkillUse } from '@slave-of-ai/control'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { plural } from '@/lib/format'
import { SearchBox } from './ListBits'
import { skillSourceWord } from './words'

/** A skill matches a search when every word of it is in its name, where it comes from or what it says. */
export function skillMatches(skill: Pick<SkillUse, 'name' | 'providerName' | 'description'>, query: string): boolean {
  const haystack = `${skill.name} ${skill.providerName} ${skill.description}`.toLowerCase()
  return query.toLowerCase().split(/\s+/u).filter((word) => word !== '').every((word) => haystack.includes(word))
}

/**
 * Every skill of the library with who has it. The count of people opens the People list narrowed
 * to that skill. Skills are given to a person, or to a persona as a default, from their own pages.
 */
export function SkillsTab({ skills, onShowPeople }: { readonly skills: readonly SkillUse[] | null; readonly onShowPeople: (skillId: string) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  if (skills === null) return <Skeleton className="h-64 rounded-xl" />
  if (skills.length === 0) {
    return (
      <Card className="py-12 text-center" data-testid="skills-empty">
        <CardHeader>
          <CardTitle className="text-base">The skill library is empty.</CardTitle>
          <CardDescription>
            Read the skills on this machine in from the command line: <code className="font-mono">skills sync</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }
  const shown = skills.filter((skill) => skillMatches(skill, query))
  return (
    <div className="flex flex-col gap-4" data-testid="skills-tab">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox value={query} onChange={setQuery} placeholder="Search skills…" label="Search skills" testId="skills-search" />
        <p className="text-sm text-muted-foreground tabular-nums">{shown.length === skills.length ? plural(skills.length, 'skill') : `${String(shown.length)} of ${String(skills.length)} skills`}</p>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">No skill matches.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Skill</TableHead>
                <TableHead className="w-28 text-right">People</TableHead>
                <TableHead className="hidden w-28 text-right sm:table-cell">Personas</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((skill) => (
                <TableRow key={skill.id} data-testid="skill-row">
                  <TableCell className="whitespace-normal">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                      {skill.name}
                      <span className="text-xs font-normal text-muted-foreground">{skillSourceWord(skill.providerName)}</span>
                      {skill.missing && (
                        <Badge className="bg-warning-muted text-warning-foreground" title="The skill's files are no longer on disk, so it is not handed to a session.">
                          Files missing
                        </Badge>
                      )}
                    </p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
                  </TableCell>
                  <TableCell className="text-right">
                    {skill.personCount === 0 ? (
                      <span className="text-sm text-muted-foreground">Nobody</span>
                    ) : (
                      <Button size="xs" variant="outline" className="tabular-nums" onClick={() => onShowPeople(skill.id)} title={`Show the ${plural(skill.personCount, 'person', 'people')} with ${skill.name}`} data-testid="skill-people">
                        {plural(skill.personCount, 'person', 'people')}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right text-sm text-muted-foreground tabular-nums sm:table-cell">{skill.personaCount === 0 ? '—' : skill.personaCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
