'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendControl } from '../lib/postControl'
import { PrimaryButton, TextField } from './ui/FormControls'

type Editing = 'name' | 'role' | null

/**
 * The per-worker roster-editing controls (M23 D2): rename, re-role, delete -- mounted beside
 * `ModelOverrideEditor` in `AllSlavesTable.tsx`'s actions cell (M24 Task 7), and only for a
 * project row (`slaveId !== null`; controller ruling: these rows ARE project `Slave`s,
 * `worker.slaveId`, exactly what `renameSlave`/`setSlaveRole`/`deleteSlave` address).
 *
 * Name and role edit the same way: a plain button showing the current value swaps to a
 * `TextField` on click, committing on Enter or blur -- no separate save button, no Escape
 * handling or focus trap, the same "a plain inline input row does not need a focus trap" call
 * `ModelOverrideEditor` already made. Delete is the one action here with no undo, so it keeps
 * `DangerZone`'s two-step confirm instead.
 */
export function SlaveRowActions({
  slaveId,
  name,
  role,
}: {
  readonly slaveId: string
  readonly name: string
  readonly role: string
}): React.JSX.Element {
  const router = useRouter()
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
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

  const remove = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const error = await sendControl(`/api/slaves/${slaveId}`, { method: 'DELETE' })
    setPending(false)
    setConfirmingDelete(false)
    if (error === null) {
      router.refresh()
    } else {
      setErrorText(error)
    }
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
      {confirmingDelete ? (
        <>
          <PrimaryButton tone="blocked" data-testid="slave-delete-confirm" disabled={pending} onClick={() => void remove()}>
            {pending ? 'deleting…' : 'confirm delete'}
          </PrimaryButton>
          <button
            type="button"
            data-testid="slave-delete-cancel"
            onClick={() => setConfirmingDelete(false)}
            className="text-xs text-text-3"
          >
            cancel
          </button>
        </>
      ) : (
        <PrimaryButton tone="blocked" data-testid="slave-delete" disabled={pending} onClick={() => setConfirmingDelete(true)}>
          delete
        </PrimaryButton>
      )}
      {errorText !== null && (
        <span role="alert" data-testid="slave-actions-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </div>
  )
}
