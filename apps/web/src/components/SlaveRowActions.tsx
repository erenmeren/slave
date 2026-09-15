'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { plural } from '../lib/plural'
import { sendControl } from '../lib/postControl'
import { DangerConfirm } from './ui/DangerConfirm'
import { TextField } from './ui/FormControls'

type Editing = 'name' | 'role' | null

/**
 * The per-worker roster-editing controls (M23 D2): rename, re-role, delete -- mounted beside
 * `ModelOverrideEditor` in `AllSlavesTable.tsx`'s actions cell (M24 Task 7). A seated row
 * (`ProjectRowProps`) renders all three; a POOL row (`PoolRowProps`, `AllSlaveRow.slaveId ===
 * null`) renders only the roster removal -- rename/re-role act on a seat, which somebody in the
 * pool does not hold (M58 R16).
 *
 * Name and role edit the same way: a plain button showing the current value swaps to a
 * `TextField` on click, committing on Enter or blur -- no separate save button, no Escape
 * handling or focus trap, the same "a plain inline input row does not need a focus trap" call
 * `ModelOverrideEditor` already made.
 *
 * Delete is `DangerConfirm` (M27 spec §6): the verbs no longer refuse on run history, so there is
 * no disabled-with-title treatment to keep -- the confirm just names what goes (`runCount` for a
 * seated row's history; for a pool row, that only the memberships go and the person stays, M58 R5)
 * and a live run is the only refusal left.
 */
/** A project row acts on a project `Slave` (rename, re-role, delete with its run history). */
interface ProjectRowProps {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly runCount: number
  readonly pool?: undefined
}
/** A pool row holds no seat -- only the roster removal, addressed by `personId` (M58 R16). Callers
 *  used to pass the catalog id as a dummy `slaveId` and `runCount: 0` to satisfy one flat shape
 *  (M27 final review, parked); the union says which fields each row really has. */
interface PoolRowProps {
  readonly name: string
  readonly role: string
  readonly pool: { readonly personId: string }
}
export type SlaveRowActionsProps = ProjectRowProps | PoolRowProps

export function SlaveRowActions(props: SlaveRowActionsProps): React.JSX.Element {
  const { name, role } = props
  const router = useRouter()
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const startEdit = (field: 'name' | 'role', current: string): void => {
    setEditing(field)
    setDraft(current)
    setErrorText(null)
  }

  // Guarded by `pending`: Enter and blur each call this independently, and a field that fails to
  // commit stays open for a retry -- without the guard, a real browser's Enter-then-tab-away
  // would fire it twice for the same edit.
  const commit = async (field: 'name' | 'role'): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    if (props.pool !== undefined) return
    const path = `/api/slaves/${props.slaveId}/${field}`
    const error = await sendControl(path, { method: 'PUT', body: { [field]: draft } })
    setPending(false)
    if (error === null) {
      setEditing(null)
      router.refresh()
    } else {
      setErrorText(error)
    }
  }

  if (props.pool !== undefined) {
    const { personId } = props.pool
    return (
      <div data-testid="slave-row-actions" className="flex flex-wrap items-center gap-1">
        <DangerConfirm
          label="delete"
          testId="catalog-slave-delete"
          confirmText={`takes ${name} off every company roster; they keep working and keep every seat`}
          onConfirm={async () => {
            const error = await sendControl(`/api/org/slaves/${personId}`, { method: 'DELETE' })
            if (error === null) router.refresh()
            return error
          }}
        />
      </div>
    )
  }

  const { slaveId, runCount } = props
  return (
    <div data-testid="slave-row-actions" className="flex flex-wrap items-center gap-1">
      {editing === 'name' ? (
        <TextField
          inputProps={
            {
              'aria-label': 'slave name',
              'data-testid': 'slave-name-input',
              value: draft,
              autoFocus: true,
              disabled: pending,
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => void commit('name'),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void commit('name')
              },
              className: 'w-28',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
      ) : (
        <button
          type="button"
          data-testid="slave-name-edit"
          onClick={() => startEdit('name', name)}
          className="truncate text-left text-xs text-text-2 hover:text-text-1"
        >
          {name}
        </button>
      )}
      {editing === 'role' ? (
        <TextField
          inputProps={
            {
              'aria-label': 'slave role',
              'data-testid': 'slave-role-input',
              value: draft,
              autoFocus: true,
              disabled: pending,
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => void commit('role'),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void commit('role')
              },
              className: 'w-24',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
      ) : (
        <button
          type="button"
          data-testid="slave-role-edit"
          onClick={() => startEdit('role', role)}
          className="truncate text-left text-xs text-text-2 hover:text-text-1"
        >
          {role}
        </button>
      )}
      <DangerConfirm
        label="delete"
        testId="slave-delete"
        confirmText={`deletes ${name} and ${plural(runCount, 'run')} of history`}
        onConfirm={async () => {
          const error = await sendControl(`/api/slaves/${slaveId}`, { method: 'DELETE' })
          if (error === null) router.refresh()
          return error
        }}
      />
      {errorText !== null && (
        <span role="alert" data-testid="slave-actions-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </div>
  )
}
