'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendControl } from '../lib/postControl'
import { CARD_STATE_TONE, cardStateForAgent } from '../lib/tones'
import type { SkillsPage, SkillRow } from '../server/skills'
import { Button } from './ui/Button'
import { Chip } from './ui/Chip'
import { EmptyTile } from './ui/EmptyTile'
import { PanelHeader } from './ui/PanelHeader'

/** `ready` is the working teal, `missing` the blocked red — the same two tones the rest of the
 *  shell uses for "running normally" and "something is wrong", not a colour local to this page. */
const STATE_TEXT: Record<SkillRow['state'], string> = {
  ready: 'text-tone-working',
  missing: 'text-tone-blocked',
}

const STATE_FILL: Record<SkillRow['state'], string> = {
  ready: 'bg-tone-working',
  missing: 'bg-tone-blocked',
}

/**
 * The Skills page (M14 §5.8 / design README "3a — Skills"): the provider list on the left with
 * real run counts and usage bars, the domain-skill grid and the "add skill source" tile on the
 * right, and assign/unassign from each row.
 *
 * Every number here is measured. A skill that was never invoked shows `0` because the tally
 * exists on every concluded run and recorded none (Decision 3) — the page never fabricates a
 * plausible-looking count, and never hides a skill whose file vanished (Decision 6).
 */
export function SkillsClient({ page }: { readonly page: SkillsPage }): React.JSX.Element {
  const router = useRouter()
  const [errorText, setErrorText] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  /** Per-skill selection, keyed by skill id. Absent means "the first agent", which is also what
   *  the `<select>` shows — a select whose value and whose submitted value disagree is a trap. */
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [rootsOpen, setRootsOpen] = useState(false)

  const skills = page.providers.flatMap((provider) => provider.skills.map((skill) => ({ provider, skill })))
  // Normalized to the BUSIEST skill on the page, not to a fixed ceiling: these bars compare
  // skills against each other, and a fixed scale would flatten a quiet catalog into a row of
  // invisible slivers. The same rule (and the same reason) as the Activity rail's volume bars.
  const maxRuns = skills.reduce((most, entry) => Math.max(most, entry.skill.runs), 0)
  const agentsById = new Map(page.agents.map((agent) => [agent.id, agent] as const))

  /**
   * Both writes, through one helper. `postControl` itself is not used because it only speaks POST
   * and unassign is a DELETE (the pair IS the resource; there is no state between assigned and
   * not) — `sendControl` carries both verbs since M18 Task 9, so this dials it directly.
   */
  const send = async (method: 'POST' | 'DELETE', agentId: string, skillId: string): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const error = await sendControl('/api/skills/assign', { method, body: { agentId, skillId } })
    if (error === null) {
      router.refresh()
    } else {
      setErrorText(error)
    }
    setPending(false)
  }

  return (
    <div className="grid grid-cols-[1fr_340px] gap-4 px-5 py-[18px]">
      <div className="flex min-w-0 flex-col gap-4">
        {page.agents.length === 0 && (
          // Said once, at the top, rather than beside every disabled button: the reason no row can
          // be assigned is a fact about the org, not about any one skill.
          <p data-testid="skills-no-agents" className="text-xs text-text-3">
            no agents yet
          </p>
        )}

        {page.providers.length === 0 && (
          <p data-testid="skills-empty" className="text-xs text-text-3">
            no skills found — run `orchestrator skills sync` to scan the roots below
          </p>
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
                      records who may reach for it, and copies nothing into the agent. */}
                  <Chip tone="planning">shared · not copied into agents</Chip>
                </span>
              }
            />

            <div className="flex flex-col gap-2">
              {provider.skills.map((skill) => {
                const chosen = choice[skill.id] ?? page.agents[0]?.id ?? ''
                return (
                  <div
                    key={skill.id}
                    data-testid="skill-row"
                    className="flex items-center gap-3.5 rounded-card border border-line bg-bg-2 px-3.5 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate font-mono text-[12.5px] text-text-1">{skill.name}</span>
                        <span data-testid={`skill-state-${skill.id}`} className={`font-mono text-[9.5px] ${STATE_TEXT[skill.state]}`}>
                          {skill.state}
                        </span>
                      </div>
                      <p className="truncate text-[11px] text-text-3" title={skill.description}>
                        {skill.description}
                      </p>
                      <div className="mt-2 h-[3px] overflow-hidden rounded-[2px] bg-white/[0.07]">
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
                      <span className="flex items-center gap-1.5">
                        <select
                          data-testid={`skill-agent-${skill.id}`}
                          aria-label={`assign ${skill.name} to`}
                          value={chosen}
                          disabled={page.agents.length === 0 || pending}
                          onChange={(event) => setChoice((prev) => ({ ...prev, [skill.id]: event.target.value }))}
                          className="max-w-[130px] rounded border border-line bg-bg-1 px-1.5 py-1 text-[11px] text-text-1"
                        >
                          {page.agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="ghost"
                          data-testid={`skill-assign-${skill.id}`}
                          disabled={page.agents.length === 0 || chosen === '' || pending}
                          onClick={() => void send('POST', chosen, skill.id)}
                        >
                          assign
                        </Button>
                      </span>

                      {skill.agentIds.length > 0 && (
                        <span className="flex flex-wrap justify-end gap-1">
                          {skill.agentIds.map((agentId) => {
                            const agent = agentsById.get(agentId)
                            const state = agent === undefined ? 'idle' : cardStateForAgent(agent.status)
                            return (
                              <Chip key={agentId} tone={CARD_STATE_TONE[state].tone}>
                                {/* The id, not a dash, when the agent is not in the list: an
                                    assignment pointing at somebody this page cannot name is a
                                    fact worth showing rather than blanking. */}
                                {agent?.name ?? agentId}
                                <button
                                  type="button"
                                  data-testid={`skill-unassign-${skill.id}-${agentId}`}
                                  aria-label={`unassign ${skill.name} from ${agent?.name ?? agentId}`}
                                  disabled={pending}
                                  onClick={() => void send('DELETE', agentId, skill.id)}
                                  className="ml-1 leading-none disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  ×
                                </button>
                              </Chip>
                            )
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}

        {errorText !== null && (
          <span role="alert" data-testid="skills-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <PanelHeader title="domain skills" />
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
                  {skill.agentIds.length} {skill.agentIds.length === 1 ? 'agent' : 'agents'}
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
    </div>
  )
}
