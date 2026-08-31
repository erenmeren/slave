'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { errorMessage } from '../lib/postControl'
import { SECTION_LABEL_CLASS, SectionLabel } from './ui/SectionLabel'
import type { PermissionSection } from '../server/settings'

/**
 * The Settings permission matrix (M14 §5.7): a row per agent, a column per README tool, a cell
 * per pair.
 *
 * Denials ARE enforced at dispatch snapshot through the gate scripts (spec §2): the resolved deny
 * list in the run's permissions.json blocks tool use at pre-tool dispatch, shell-backed capabilities
 * are coarse-grained, `read secrets` is unenforced, and Cursor enforcement is non-shell best-effort.
 * The cell glyph reflects its mode: `allow` shows a check mark `✓` in the working tone, `deny`
 * shows a cross `✕` in the blocked tone, and `null` (unset) shows an en dash `–` in the dim tone,
 * because an undecided permission is distinct from a decision to refuse.
 *
 * One grid PER WORKSPACE (fix round 1, finding 2), because two projects built from the same roster
 * hold different agents with identical names, and a flat list of them is unreadable: the section
 * header is what says whose "Alex · backend" a row governs.
 */
type Mode = 'allow' | 'deny' | null

const TITLE: Record<'allow' | 'deny' | 'unset', string> = {
  allow: 'allowed',
  deny: 'denied',
  unset: 'not set',
}

/**
 * The label column plus one equal column per tool, sized from the ROW's own cells.
 *
 * An inline style rather than `grid-cols-[190px_repeat(6,1fr)]` written twice: Tailwind cannot
 * build a class name at runtime, and the literal hardcoded the count in two places while the
 * headers themselves were data-derived -- so a seventh tool would have been the "single edit"
 * `PERMISSION_TOOLS` promises AND a silently broken layout.
 *
 * Counted from the data rather than imported from `PERMISSION_TOOLS` directly: this is a
 * `'use client'` component, and `@ai-team-os/control`'s barrel re-exports `@ai-team-os/providers`,
 * which imports `node:child_process` at module scope (see `ProviderSelect.tsx`). The server built
 * these cells from `PERMISSION_TOOLS`, so counting them IS reading that one list.
 */
function grid(columns: number): React.CSSProperties {
  return { gridTemplateColumns: `190px repeat(${columns}, 1fr)` }
}

/** The write is always the OPPOSITE of the effective value, and unset is effectively "not
 *  allowed" — so an unset cell asks for `allow`, exactly as a denied one does. */
function flip(mode: Mode): 'allow' | 'deny' {
  return mode === 'allow' ? 'deny' : 'allow'
}

export function PermissionMatrix({ sections }: { readonly sections: readonly PermissionSection[] }): React.JSX.Element {
  const router = useRouter()
  const [errorText, setErrorText] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

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

  return (
    <div className="flex flex-col gap-4">
      {sections.length === 0 && (
        <p data-testid="perm-no-workspace" className="text-xs text-text-3">
          no projects yet
        </p>
      )}

      {sections.map((section) => (
        <div key={section.workspaceId} data-testid={`permission-matrix-${section.workspaceId}`} className="flex flex-col gap-2">
          <SectionLabel>{section.workspaceName}</SectionLabel>
          <p className="text-xs text-text-3">
            Denials are enforced at dispatch snapshot — matrix edits don't affect runs already in flight. The three shell-backed capabilities deny the shell tool as a whole. 'Read secrets' is not yet enforced.
          </p>

          {section.rows.length === 0 ? (
            // The section stays even with nobody in it: a project whose roster is empty is a fact
            // worth showing, and dropping it would make the page look like the project does not
            // exist.
            <p data-testid="perm-empty" className="text-xs text-text-3">
              no agents yet
            </p>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[560px]">
                <div style={grid(section.rows[0]?.cells.length ?? 0)} className="grid items-end gap-y-1 border-b border-line pb-1.5">
                  <span className={SECTION_LABEL_CLASS}>agent</span>
                  {/* The columns come from the row's own cells rather than a second copy of the
                      list: the server built them from `PERMISSION_TOOLS`, so this renders that one
                      list, and `grid()` sizes itself from the same count. */}
                  {(section.rows[0]?.cells ?? []).map((cell) => (
                    <span
                      key={cell.tool}
                      data-testid="perm-column"
                      className={`text-center ${SECTION_LABEL_CLASS}`}
                    >
                      {cell.tool}
                    </span>
                  ))}
                </div>

                {section.rows.map((row) => (
                  <div
                    key={row.agentId}
                    data-testid="perm-row"
                    style={grid(row.cells.length)}
                    className="grid items-center gap-y-1 border-b border-line/60 py-1.5"
                  >
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-xs text-text-1">{row.name}</span>
                      <span className="truncate font-mono text-[10px] text-text-3">{row.role}</span>
                    </span>
                    {row.cells.map((cell) => {
                      const isAllow = cell.mode === 'allow'
                      const isDeny = cell.mode === 'deny'
                      const isUnset = cell.mode === null

                      let glyph: string
                      let colorClass: string
                      let bgBorderClass: string

                      if (isAllow) {
                        glyph = '✓'
                        colorClass = 'text-tone-working'
                        bgBorderClass = 'border-tone-working/24 bg-tone-working/10'
                      } else if (isDeny) {
                        glyph = '✕'
                        colorClass = 'text-tone-blocked'
                        bgBorderClass = 'border-tone-blocked/24 bg-tone-blocked/8'
                      } else {
                        glyph = '–'
                        colorClass = 'text-text-3'
                        bgBorderClass = 'border-text-3/24 bg-text-3/8'
                      }

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
                            className={`h-5 w-5 rounded-chip border text-[11px] leading-none disabled:cursor-not-allowed disabled:opacity-50 ${colorClass} ${bgBorderClass}`}
                          >
                            {glyph}
                          </button>
                        </span>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}

      {errorText !== null && (
        <span role="alert" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}

      <p data-testid="perm-caption" className="font-mono text-[10px] text-text-3">
        not yet enforced at runtime
      </p>
    </div>
  )
}
