'use client'

import type { ReactElement } from 'react'
import { EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@ai-team-os/db'
import { ACTIVITY_KINDS, type ActivityKind } from '../../lib/activityFilters'
import type { UrlFilters } from '../../hooks/useUrlFilters'

const KIND_LABEL: Record<ActivityKind, string> = {
  runs: 'Runs',
  tool_calls: 'Tool calls',
  tasks: 'Tasks',
  interventions: 'Interventions',
  guardrails: 'Guardrails',
  workspace: 'Workspace',
}

// The 20 domain event types the "Advanced" popover lists — every key of `EVENT_TYPE_BY_DOMAIN_TYPE`
// (`@ai-team-os/db`), the same exhaustive source `TYPES_BY_KIND`'s completeness test checks against.
const ALL_TYPES = Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE) as DomainEventType[]

function toggleItem<T>(list: readonly T[], value: T): readonly T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

export interface FilterBarProps extends UrlFilters {
  readonly agents: readonly { readonly id: string; readonly name: string }[]
  readonly tasks: readonly { readonly id: string; readonly title: string }[]
}

/** One of the five kind chips. Selected state reuses the existing neutral tokens (no new colour —
 *  the kinds aren't status-coloured) rather than the status palette, which already means
 *  something else (a run/task's own state) on every card these events render into. */
function KindChip({
  kind,
  active,
  onToggle,
}: {
  readonly kind: ActivityKind
  readonly active: boolean
  readonly onToggle: () => void
}): ReactElement {
  return (
    <button
      type="button"
      data-testid={`kind-chip-${kind}`}
      aria-pressed={active}
      onClick={onToggle}
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active ? 'border-text-1 bg-bg-2 text-text-1' : 'border-line bg-bg-1 text-text-3 hover:text-text-2'
      }`}
    >
      {KIND_LABEL[kind]}
    </button>
  )
}

/** `<details>`-based popover (brief: no new dependency) listing all 20 domain event types as
 *  checkboxes — the fine-grained escape hatch below the five coarse kind chips. */
function AdvancedTypesPopover({
  rawTypes,
  setRawTypes,
}: {
  readonly rawTypes: readonly DomainEventType[]
  readonly setRawTypes: (types: readonly DomainEventType[]) => void
}): ReactElement {
  return (
    <details className="group relative" data-testid="advanced-popover">
      <summary className="cursor-pointer list-none rounded border border-line bg-bg-1 px-2.5 py-1 text-xs text-text-2 group-open:text-text-1">
        Advanced{rawTypes.length > 0 ? ` (${rawTypes.length})` : ''}
      </summary>
      <div className="absolute z-10 mt-1 grid max-h-64 w-72 grid-cols-1 gap-0.5 overflow-y-auto rounded border border-line bg-bg-1 p-2 shadow-lg">
        {ALL_TYPES.map((type) => {
          const checked = rawTypes.includes(type)
          return (
            <label key={type} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-text-2 hover:bg-bg-2">
              <input
                type="checkbox"
                data-testid={`type-checkbox-${type}`}
                checked={checked}
                onChange={() => setRawTypes(toggleItem(rawTypes, type))}
                className="accent-text-1"
              />
              <span className="font-mono">{type}</span>
            </label>
          )
        })}
      </div>
    </details>
  )
}

/** A native `<select multiple>` for the agent/task roster — no new dependency, and the roster is
 *  small enough (spec doesn't project it growing beyond a page of options) that a dropdown scan
 *  beats a searchable widget. */
function RosterSelect({
  label,
  options,
  selected,
  onChange,
}: {
  readonly label: string
  readonly options: readonly { readonly id: string; readonly label: string }[]
  readonly selected: readonly string[]
  readonly onChange: (ids: readonly string[]) => void
}): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-text-3">
      {label}
      <select
        multiple
        data-testid={`select-${label.toLowerCase()}`}
        value={[...selected]}
        onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions).map((option) => option.value))}
        className="min-w-32 rounded border border-line bg-bg-1 px-2 py-1 text-xs normal-case tracking-normal text-text-1"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The activity timeline's filter bar: five kind chips, an "Advanced" popover for the full 20
 * types, and two roster multi-selects — all writing through the `useUrlFilters` surface the
 * caller passes down, so this component owns no state of its own.
 */
export function FilterBar(props: FilterBarProps): ReactElement {
  const { agents, tasks, filters, kinds, rawTypes, setKinds, setRawTypes, setAgents, setTasks } = props
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bg-1 p-3" data-testid="filter-bar">
      <div className="flex flex-wrap gap-1.5">
        {ACTIVITY_KINDS.map((kind) => (
          <KindChip key={kind} kind={kind} active={kinds.includes(kind)} onToggle={() => setKinds(toggleItem(kinds, kind))} />
        ))}
      </div>
      <AdvancedTypesPopover rawTypes={rawTypes} setRawTypes={setRawTypes} />
      <RosterSelect
        label="Agents"
        options={agents.map((agent) => ({ id: agent.id, label: agent.name }))}
        selected={filters.agents}
        onChange={setAgents}
      />
      <RosterSelect
        label="Tasks"
        options={tasks.map((task) => ({ id: task.id, label: task.title }))}
        selected={filters.tasks}
        onChange={setTasks}
      />
    </div>
  )
}
