'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { PERMISSION_LABEL, type PermissionKind } from '@slave-of-ai/domain'
import { sendControl } from '../lib/postControl'
import { SECTION_LABEL_CLASS, SectionLabel } from './ui/SectionLabel'
import type { PermissionSection } from '../server/settings'

/**
 * The Settings permission matrix (M14 §5.7, in M52 R1's vocabulary): a row per slave, a column per
 * OPERATION, a cell per pair.
 *
 * What a cell means changed in M52 and the copy below changed with it. Under M18 the file was a
 * DENY list and an absent row allowed, so the grid described a set of exceptions; from M52 the file
 * is an ALLOW list and anything not granted is refused, so the grid describes the whole answer --
 * minus the baseline a run's own kind carries, which is why an untouched row is not an idle worker.
 * The cell glyph reflects its mode: `allow` shows a check mark `✓` in the working tone, `deny`
 * shows a cross `✕` in the blocked tone, and `null` (unset) shows an en dash `–` in the dim tone,
 * because an undecided permission is distinct from a decision to refuse -- and, now, distinct from
 * a grant the run kind makes by itself.
 *
 * One grid PER WORKSPACE (fix round 1, finding 2), because two projects built from the same roster
 * hold different slaves with identical names, and a flat list of them is unreadable: the section
 * header is what says whose "Alex · backend" a row governs.
 */
type Mode = 'allow' | 'deny' | null

const TITLE: Record<'allow' | 'deny' | 'unset', string> = {
  allow: 'allowed',
  deny: 'denied',
  unset: 'not set',
}

/**
 * The label column plus one equal column per operation, sized from the ROW's own cells.
 *
 * An inline style rather than `grid-cols-[190px_repeat(6,1fr)]` written twice: Tailwind cannot
 * build a class name at runtime, and the literal hardcoded the count in two places while the
 * headers themselves were data-derived -- so a seventh column would have been the "single edit"
 * `PERMISSION_KINDS` promises AND a silently broken layout.
 *
 * Unchanged by M52: it already sizes from the row's own cells, which is why six columns of longer
 * WORDS cost nothing here.
 */
function grid(columns: number): React.CSSProperties {
  return { gridTemplateColumns: `190px repeat(${columns}, 1fr)` }
}

/**
 * The three-state cycle one click walks: unset → allow → deny → unset.
 *
 * This was `flip()`, a two-state toggle whose docstring said "unset is effectively not allowed, so
 * an unset cell asks for `allow`". That reading was correct BY ACCIDENT until this milestone -- M18
 * resolved `allow` and unset identically at the gate, so "effectively not allowed" was false of the
 * thing it described -- and is correct ON PURPOSE now that the absence of a row really is a
 * refusal. What it could not express at all was the third step: a person who granted something in
 * error had no way back to "never asked", only a `deny` that reads as a considered refusal.
 * `null` here is that way back, and the route answers it with a DELETE.
 */
function next(mode: Mode): 'allow' | 'deny' | null {
  if (mode === null) return 'allow'
  return mode === 'allow' ? 'deny' : null
}

export function PermissionMatrix({ sections }: { readonly sections: readonly PermissionSection[] }): React.JSX.Element {
  const router = useRouter()
  const [errorText, setErrorText] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  /**
   * One cell, one URL (M52 R7). The KIND is in the path because the path names the resource: a PUT
   * sets this cell and a DELETE takes the decision back, which is exactly the three states drawn
   * above. Workspace-scoped, so a cross-project id reads back as "no such slave" rather than as a
   * permission somebody else's worker now has.
   */
  const write = async (workspaceId: string, slaveId: string, kind: PermissionKind, mode: 'allow' | 'deny' | null): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const url = `/api/w/${workspaceId}/slaves/${slaveId}/permissions/${kind}`
    const error = await sendControl(url, mode === null ? { method: 'DELETE' } : { method: 'PUT', body: { mode } })
    if (error === null) {
      router.refresh()
    } else {
      setErrorText(error)
    }
    setPending(false)
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

          {section.rows.length === 0 ? (
            // The section stays even with nobody in it: a project whose roster is empty is a fact
            // worth showing, and dropping it would make the page look like the project does not
            // exist.
            <p data-testid="perm-empty" className="text-xs text-text-3">
              no slaves yet
            </p>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[560px]">
                <div style={grid(section.rows[0]?.cells.length ?? 0)} className="grid items-end gap-y-1 border-b border-line pb-1.5">
                  <span className={SECTION_LABEL_CLASS}>slave</span>
                  {/* The columns come from the row's own cells rather than a second copy of the
                      list: the server built them from `PERMISSION_KINDS`, so this renders that one
                      list, and `grid()` sizes itself from the same count. The WORD is what a person
                      reads and the key rides `data-kind`/`title` (`docs/ia.md` rule 3) -- until M52
                      this printed `read_secret` at a person. */}
                  {(section.rows[0]?.cells ?? []).map((cell) => (
                    <span
                      key={cell.kind}
                      data-testid="perm-column"
                      data-kind={cell.kind}
                      title={cell.kind}
                      className={`text-center ${SECTION_LABEL_CLASS}`}
                    >
                      {PERMISSION_LABEL[cell.kind]}
                    </span>
                  ))}
                </div>

                {section.rows.map((row) => (
                  <div
                    key={row.slaveId}
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
                        <span key={cell.kind} className="flex justify-center">
                          <button
                            type="button"
                            data-testid={`perm-cell-${row.slaveId}-${cell.kind}`}
                            data-mode={cell.mode ?? 'unset'}
                            disabled={pending}
                            title={TITLE[cell.mode ?? 'unset']}
                            // The WORD in the accessible name too: this button's visible content is
                            // one glyph, so the label is the only text a screen reader gets.
                            aria-label={`${row.name} · ${PERMISSION_LABEL[cell.kind]} · ${TITLE[cell.mode ?? 'unset']}`}
                            onClick={() => void write(section.workspaceId, row.slaveId, cell.kind, next(cell.mode))}
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

      {/* E14: this page carried THREE sentences that disagreed -- one per section saying denials are
        * enforced at dispatch snapshot, one caption saying nothing is enforced at all, and a
        * docstring in `server/settings.ts` saying an unset cell draws a cross. One caption and one
        * note now, both true, both below the grid where the rule belongs rather than repeated over
        * every project. `perm-caption` keeps its testid exactly: three gates read it as a structural
        * marker for this page, and only its text has moved. */}
      <p data-testid="perm-caption" className="text-xs text-text-3">
        Anything not granted is refused. A run&rsquo;s own kind grants the basics &mdash; reading, and for
        implementation runs writing and commands &mdash; and everything else is a decision.
      </p>
      {/* The third sentence is the caveat the pre-M52 copy carried and this milestone nearly
        * dropped (fix round 1). Its old wording — "the three shell-backed capabilities deny the
        * shell tool as a whole" — is obsolete: the six kinds map to distinct tool names now. What
        * it was WARNING about is not, and the caption above makes the warning sharper rather than
        * unnecessary: "anything not granted is refused" is true at TOOL DISPATCH, which is the
        * only place the hook stands. `run_commands` still grants `Bash`, command strings are not
        * inspected (M18's ruling, which M52 §"Out of scope" leaves untouched), and a script run
        * there can do what the rows beside it govern. Saying so is what keeps the caption from
        * reading as a promise about effect. */}
      <p data-testid="perm-note" className="text-[10.5px] text-text-3">
        Edits reach a run the next time it starts or resumes, never one already in flight. On Cursor
        only the shell is enforced, so a mark on any other row is advisory there. &lsquo;Run
        commands&rsquo; is the coarse one: it grants the shell, and what a command does there is not
        inspected, so a script run under it can reach the network or a release whatever the marks
        beside it say. &lsquo;Read a secret&rsquo; and &lsquo;Deploy a release&rsquo; each name a brokered
        operation, not a tool: they let the orchestrator act for this worker, and the worker never
        holds the credential.
      </p>
    </div>
  )
}
