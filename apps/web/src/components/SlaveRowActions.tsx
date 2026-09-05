'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendControl } from '../lib/postControl'
import { DangerConfirm } from './ui/DangerConfirm'
import { TextField } from './ui/FormControls'

type Editing = 'name' | 'role' | null

/**
 * The per-worker roster-editing controls (M23 D2): rename, re-role, delete -- mounted beside
 * `ModelOverrideEditor` in `AllSlavesTable.tsx`'s actions cell (M24 Task 7). A project row
 * (`catalog` undefined) renders all three; a catalog row (`catalog: { companySlaveId }` set,
 * `AllSlaveRow.slaveId === null`) renders only the delete -- rename/re-role act on a project
 * `Slave`, which a catalog member is not.
 *
 * Name and role edit the same way: a plain button showing the current value swaps to a
 * `TextField` on click, committing on Enter or blur -- no separate save button, no Escape
 * handling or focus trap, the same "a plain inline input row does not need a focus trap" call
 * `ModelOverrideEditor` already made.
 *
 * Delete is `DangerConfirm` (M27 spec §6): `deleteSlave`/`deleteCompanySlave` no longer refuse on
 * run history, so there is no disabled-with-title treatment to keep -- the confirm just names
 * what goes (`runCount` for a project row's history, "project copies stay" for a catalog row,
 * since `assignCompany` re-materializes from the template) and a live run is the only refusal left.
 */
export function SlaveRowActions({
  slaveId,
  name,
  role,
  runCount,
  catalog,
}: {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly runCount: number
  readonly catalog?: { readonly companySlaveId: string }
}): React.JSX.Element {
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
    const path = `/api/slaves/${slaveId}/${field}`
    const error = await sendControl(path, { method: 'PUT', body: { [field]: draft } })
    setPending(false)
    if (error === null) {
      setEditing(null)
      router.refresh()
    } else {
      setErrorText(error)
    }
  }

  if (catalog !== undefined) {
    return (
      <div data-testid="slave-row-actions" className="flex flex-wrap items-center gap-1">
        <DangerConfirm
          label="delete"
          testId="catalog-slave-delete"
          confirmText={`deletes ${name} from the catalog; project copies stay`}
          onConfirm={async () => {
            const error = await sendControl(`/api/org/slaves/${catalog.companySlaveId}`, { method: 'DELETE' })
            if (error === null) router.refresh()
            return error
          }}
        />
      </div>
    )
  }

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
        confirmText={`deletes ${name} and ${runCount} runs of history`}
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
