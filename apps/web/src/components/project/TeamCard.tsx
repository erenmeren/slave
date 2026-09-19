'use client'

import { PROVIDER_LABEL } from '@slave-of-ai/domain'
import { useMode } from '../mode/ModeProvider'
import { formatUsd } from '../../lib/realMoney'
import type { TeamLiveRow } from '../../server/teamLive'
import { AvatarTile } from '../ui/AvatarTile'
import { Card } from '../ui/Card'
import { LiveDot } from '../ui/LiveDot'
import { StatusPill, TONE_DOT } from '../ui/StatusPill'

/**
 * One seat on the Team tab (M61 R7/Task 6): who, what they are doing IN ENGLISH, and -- in
 * developer mode only -- the run underneath that sentence. `TeamLiveSnapshot.rows` (Task 5) is
 * already this shape; this component draws one of them.
 *
 * `data-slave`/`data-status`/`data-state` on the card surface, not on a wrapper, so a gate reading
 * `[data-testid="team-card"][data-slave="…"]` finds the row directly -- the same idiom
 * `organization-row-${slaveId}` used before this milestone, moved onto `ui/Card`'s own `data` bag.
 */
export function TeamCard({
  row,
  onOpen,
}: {
  readonly row: TeamLiveRow
  readonly onOpen: (slaveId: string) => void
}): React.JSX.Element {
  const { isDeveloper } = useMode()
  const { technical } = row

  return (
    <Card
      testId="team-card"
      data={{ 'data-slave': row.slaveId, 'data-status': row.status, 'data-state': row.state }}
      onClick={() => onOpen(row.personId)}
    >
      <div className="flex items-center gap-[var(--gap-1)]">
        <AvatarTile name={row.name} tone={row.doingTone} size="md" />
        <span className="min-w-0 flex-1">
          <span className="type-title block truncate text-[14px] font-semibold text-t1">{row.name}</span>
          <span className="type-meta block truncate text-t2">
            {row.role}
            {isDeveloper && technical.provider !== null && ` · ${PROVIDER_LABEL[technical.provider]}`}
          </span>
        </span>
        {/* THE STATE, AS A WORD (M61 Task 11). `TeamLiveRow.stateLabel` is `USER_CARD_LABEL[state]`
          * -- the deleted `SlaveCard` printed it as a `status-pill`, this row has carried it since
          * Task 5, and nothing rendered it: a worker the breaker has CONSTRAINED looked exactly
          * like one that was not, and `gate-m51-breaker.mjs`'s own assertion on that word is what
          * found it. `StatusPill` is `LiveDot` + word since R16, and `title` keeps the raw state
          * one hover away (`docs/ia.md` rule 3). */}
        <span className="shrink-0">
          <StatusPill tone={row.doingTone} label={row.stateLabel} title={row.status} />
        </span>
      </div>
      <p data-testid="team-doing" className="type-meta mt-2 flex items-center gap-2">
        <LiveDot tone={row.doingTone} />
        <span className="min-w-0 truncate">{row.doing}</span>
      </p>
      <div
        data-testid="team-progress"
        data-progress={row.progress ?? ''}
        className="mt-2 h-[3px] rounded-pill bg-line"
      >
        {row.progress !== null && (
          <span
            style={{ width: `${String(row.progress)}%` }}
            className={`block h-full rounded-pill ${TONE_DOT[row.doingTone]} transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]`}
          />
        )}
      </div>
      {isDeveloper && (
        <p data-testid="team-technical" className="mt-1.5 font-mono text-[10.5px] text-t3">
          run {technical.runId?.slice(0, 4) ?? '—'} · {technical.provider === null ? '—' : PROVIDER_LABEL[technical.provider]} ·{' '}
          {technical.toolCalls} tool calls · {technical.costUsd === null ? 'cost unknown' : formatUsd(technical.costUsd)}
        </p>
      )}
    </Card>
  )
}
