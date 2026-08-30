'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { errorMessage } from '../lib/postControl'
import type { PermissionRow } from '../server/settings'

/**
 * The Settings permission matrix (M14 §5.7): a row per agent, a column per README tool, a cell
 * per pair.
 *
 * Editable, and captioned in as many words that nothing reads it yet (Decision 7). The caption is
 * not decoration: an operator who denies `deploy prod` here and believes it took effect is worse
 * off than one who was never offered the control, so the surface states the gap it has.
 *
 * `null` (unset) and `deny` share the `✕` glyph but not the `title`: the tooltip says `not set`
 * or `denied`, because an undecided permission is not a decision to refuse.
 */
type Mode = 'allow' | 'deny' | null

const TITLE: Record<'allow' | 'deny' | 'unset', string> = {
  allow: 'allowed',
  deny: 'denied',
  unset: 'not set',
}

/** The write is always the OPPOSITE of the effective value, and unset is effectively "not
 *  allowed" — so an unset cell asks for `allow`, exactly as a denied one does. */
function flip(mode: Mode): 'allow' | 'deny' {
  return mode === 'allow' ? 'deny' : 'allow'
}

export function PermissionMatrix({ rows }: { readonly rows: readonly PermissionRow[] }): React.JSX.Element {
  const router = useRouter()
  const [errorText, setErrorText] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // The six columns come from the first row rather than from a second copy of the list: the
  // server built every row's `cells` from `PERMISSION_TOOLS`, so this renders that one list.
  const tools = rows[0]?.cells.map((cell) => cell.tool) ?? []

  const write = async (agentId: string, tool: string, mode: 'allow' | 'deny'): Promise<void> => {
    setPending(true)
    setErrorText(null)
    // A local PUT rather than `postControl` (which is POST-only): the same contract — a bare
    // fetch, nothing written from the response but the error text, and the refresh owning truth.
    try {
      const response = await fetch(`/api/agents/${agentId}/permission`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, mode }),
      })
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null)
        setErrorText(errorMessage(data, response.status))
        return
      }
      router.refresh()
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p data-testid="perm-empty" className="text-xs text-text-3">
          no agents yet
        </p>
        <p data-testid="perm-caption" className="font-mono text-[10px] text-text-3">
          not yet enforced at runtime
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[190px_repeat(6,1fr)] items-end gap-y-1 border-b border-line pb-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">agent</span>
            {tools.map((tool) => (
              <span
                key={tool}
                data-testid="perm-column"
                className="text-center font-mono text-[9px] uppercase tracking-[.09em] text-text-3"
              >
                {tool}
              </span>
            ))}
          </div>

          {rows.map((row) => (
            <div
              key={row.agentId}
              data-testid="perm-row"
              className="grid grid-cols-[190px_repeat(6,1fr)] items-center gap-y-1 border-b border-line/60 py-1.5"
            >
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-xs text-text-1">{row.name}</span>
                <span className="truncate font-mono text-[10px] text-text-3">{row.role}</span>
              </span>
              {row.cells.map((cell) => {
                const allowed = cell.mode === 'allow'
                return (
                  <span key={cell.tool} className="flex justify-center">
                    <button
                      type="button"
                      data-testid={`perm-cell-${row.agentId}-${cell.tool}`}
                      data-mode={cell.mode ?? 'unset'}
                      disabled={pending}
                      title={TITLE[cell.mode ?? 'unset']}
                      aria-label={`${row.name} · ${cell.tool} · ${TITLE[cell.mode ?? 'unset']}`}
                      onClick={() => void write(row.agentId, cell.tool, flip(cell.mode))}
                      className={`h-5 w-5 rounded-chip border text-[11px] leading-none disabled:cursor-not-allowed disabled:opacity-50 ${
                        allowed
                          ? 'border-tone-done/24 bg-tone-done/10 text-tone-done'
                          : 'border-tone-blocked/24 bg-tone-blocked/8 text-tone-blocked'
                      }`}
                    >
                      {allowed ? '✓' : '✕'}
                    </button>
                  </span>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {errorText !== null && (
        <span role="alert" className="text-xs text-status-danger">
          {errorText}
        </span>
      )}

      <p data-testid="perm-caption" className="font-mono text-[10px] text-text-3">
        not yet enforced at runtime
      </p>
    </div>
  )
}
