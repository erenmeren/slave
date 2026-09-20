'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { SkillsPage, SkillRow } from '../server/skills'
import { EmptyState } from './ui/EmptyState'
import { Chip } from './ui/Chip'
import { EmptyTile } from './ui/EmptyTile'
import { PanelHeader } from './ui/PanelHeader'
import { ScrollArea } from './ui/ScrollArea'

/** `ready` is the working teal, `missing` the blocked red — the same two tones the rest of the
 *  shell uses for "running normally" and "something is wrong", not a colour local to this page. */
const STATE_TEXT: Record<SkillRow['state'], string> = {
  ready: 'text-tone-working',
  missing: 'text-tone-blocked',
}

/** R5 leak 4: the raw `SkillRow['state']` used to be the label. `missingSince !== null` means the
 *  file the catalog scanned is gone, which is a fact about the disk, not a word a person should
 *  have to decode. */
const SKILL_STATE_LABEL: Record<SkillRow['state'], string> = { ready: 'READY', missing: 'MISSING' }

const STATE_FILL: Record<SkillRow['state'], string> = {
  ready: 'bg-tone-working',
  missing: 'bg-tone-blocked',
}

/**
 * The Skills page (M14 §5.8 / design README "3a — Skills"): the provider list on the left with
 * real run counts and usage bars, the domain-skill grid and the "add skill source" tile on the
 * right. Assignment lives on the person, not here (M58 R26) -- each row lists who has the skill,
 * with a link to grant or revoke it.
 *
 * Every number here is measured. A skill that was never invoked shows `0` because the tally
 * exists on every concluded run and recorded none (Decision 3) — the page never fabricates a
 * plausible-looking count, and never hides a skill whose file vanished (Decision 6).
 */
export function SkillsClient({ page }: { readonly page: SkillsPage }): React.JSX.Element {
  const [errorText] = useState<string | null>(null)
  const [rootsOpen, setRootsOpen] = useState(false)

  const skills = page.providers.flatMap((provider) => provider.skills.map((skill) => ({ provider, skill })))
  // Normalized to the BUSIEST skill on the page, not to a fixed ceiling: these bars compare
  // skills against each other, and a fixed scale would flatten a quiet catalog into a row of
  // invisible slivers. The same rule (and the same reason) as the Activity rail's volume bars.
  const maxRuns = skills.reduce((most, entry) => Math.max(most, entry.skill.runs), 0)

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[1fr_340px] gap-4 px-5 py-[18px]">
      <div className="flex min-h-0 min-w-0 flex-col">
        {/* M61 Task 10: the provider list is this column's own scrolling body -- the right column
          * below scrolls independently, in its own `ScrollArea`. */}
        <ScrollArea>
          <div className="flex min-w-0 flex-col gap-4">
            {page.providers.length === 0 && (
              <EmptyState testId="skills-empty" message="no skills found — run `orchestrator skills sync` to scan the roots below" />
            )}

            {page.providers.map((provider) => (
              <section key={provider.id} data-testid="skill-provider" className="flex min-w-0 flex-col gap-2">
                <PanelHeader
                  title="skill provider"
                  action={
                    <span className="flex items-center gap-2">
                      <span data-testid={`provider-name-${provider.id}`} className="text-text-2">
                        {provider.name}
                      </span>
                      {/* The handoff's own words. A skill is READ from disk at run time; assigning it
                          records who may reach for it, and copies nothing into the slave. */}
                      <Chip tone="planning">shared · not copied into slaves</Chip>
                    </span>
                  }
                />
                <p data-testid="skills-assign-note" className="text-xs text-text-3">
                  Skills are given to a slave, not the other way round — open a name to grant or revoke
                  one, or give a whole persona its defaults from Workforce → Catalog.
                </p>

                <div className="flex flex-col gap-2">
                  {provider.skills.map((skill) => (
                      <div
                        key={skill.id}
                        data-testid="skill-row"
                        className="flex items-center gap-3.5 rounded-card border border-line bg-bg-2 px-3.5 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="truncate font-mono text-[12.5px] text-text-1">{skill.name}</span>
                            <span
                              data-testid={`skill-state-${skill.id}`}
                              data-state={skill.state}
                              title={skill.state}
                              className={`font-mono text-[9.5px] ${STATE_TEXT[skill.state]}`}
                            >
                              {SKILL_STATE_LABEL[skill.state]}
                            </span>
                          </div>
                          <p className="truncate text-[11px] text-text-3" title={skill.description}>
                            {skill.description}
                          </p>
                          <div className="mt-2 h-[3px] overflow-hidden rounded-hair bg-line2">
                            {/* `ui/ProgressBar` is a fraction of a CEILING and colours itself from the
                                status vocabulary; this is a comparison against the busiest skill, in
                                the skill's own ready/missing colour. Same recipe, different meaning —
                                `ActivityClient`'s volume bars make the identical distinction. */}
                            <div
                              data-testid={`skill-bar-${skill.id}`}
                              className={`h-full motion-safe:[transition:width_.5s_ease] ${STATE_FILL[skill.state]}`}
                              style={{ width: `${maxRuns === 0 ? 0 : Math.round((skill.runs / maxRuns) * 100)}%` }}
                            />
                          </div>
                        </div>

                        <div className="w-[70px] shrink-0 text-right">
                          <div data-testid={`skill-runs-${skill.id}`} className="font-mono text-[14px] font-semibold text-text-1">
                            {skill.runs}
                          </div>
                          {/* "all time", not the mock's "7d": this total is every run ever recorded,
                              and a window the query does not apply must not be printed under it. */}
                          <div className="text-[9.5px] text-text-2">runs · all time</div>
                        </div>

                        <div className="flex w-[240px] shrink-0 flex-col items-end gap-1.5">
                          <span data-testid={`skill-holders-${skill.id}`} className="flex flex-wrap gap-1">
                            {skill.holders.length === 0 ? (
                              <span className="text-xs text-text-3">nobody</span>
                            ) : (
                              skill.holders.map((holder) => (
                                <Link
                                  key={holder.personId}
                                  data-testid={`skill-holder-${skill.id}-${holder.personId}`}
                                  data-skill-origin={holder.origin}
                                  href={`/workforce?tab=slaves&slave=${holder.personId}`}
                                  title={holder.origin}
                                  className="text-xs underline decoration-dotted hover:text-text-1"
                                >
                                  {holder.name}
                                  <span className="ml-1 text-[10.5px] text-text-3">
                                    {holder.origin === 'persona' ? 'from persona' : 'from slave'}
                                  </span>
                                </Link>
                              ))
                            )}
                          </span>
                        </div>
                      </div>
                  ))}
                </div>
              </section>
            ))}

            {errorText !== null && (
              <span role="alert" data-testid="skills-error" className="text-xs text-tone-blocked">
                {errorText}
              </span>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <PanelHeader title="domain skills" />
        {/* M61 Task 10: the header stays fixed; the tile grid and the add-source tile below are
          * this column's own scrolling body. The inner `gap-3` reproduces exactly the gap these
          * three had as direct siblings of the header above, so nothing moves a pixel. */}
        <ScrollArea>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {skills.map(({ provider, skill }) => (
                <div key={skill.id} data-testid="domain-tile" className="min-w-0 rounded-tile border border-line bg-bg-2 px-[11px] py-2.5">
                  <div className="truncate font-mono text-[11.5px] text-text-1" title={skill.name}>
                    {skill.name}
                  </div>
                  <div className="mt-[7px] flex items-baseline justify-between gap-2">
                    {/* The handoff tags each tile by SOURCE (`git`/`local`/`built-in`). The real
                        sources are the catalog's providers, so the tag is the provider's own name —
                        inventing a three-way vocabulary the data does not have would be a label that
                        means nothing. */}
                    <span data-testid="domain-source" className="truncate font-mono text-[9px] text-tone-planning" title={provider.name}>
                      {provider.name}
                    </span>
                    <span className="shrink-0 text-[9.5px] text-text-faint">
                      {skill.holders.length} {skill.holders.length === 1 ? 'slave' : 'slaves'}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <EmptyTile label="add skill source" onClick={() => setRootsOpen((open) => !open)} />
            {rootsOpen && (
              <div data-testid="scanned-roots" className="flex flex-col gap-1 rounded-tile border border-line bg-bg-2 p-3">
                {/* SHOWN, never edited: `syncSkillCatalog` scans exactly these three and there is no
                    write path for a fourth (Decision 7). An input here would be a control that
                    silently discarded what an operator typed, which is worse than no control. */}
                <p className="text-[11px] text-text-2">the daemon scans these three roots:</p>
                {page.scannedRoots.map((root) => (
                  <code key={root} className="block break-all font-mono text-[10px] text-text-3">
                    {root}
                  </code>
                ))}
                <p className="text-[10px] text-text-3">read-only — add a skill on disk, then run `orchestrator skills sync`</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
