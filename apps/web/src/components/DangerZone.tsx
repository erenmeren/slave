'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { EmergencyStopButton } from './EmergencyStopButton'
import { postControl } from '../lib/postControl'
import { Panel } from './ui/Panel'

/**
 * The Settings page's last two panels (M14 §5.7).
 *
 * **Realtime transport** is READ-ONLY on purpose: this app has exactly one transport, SSE, and no
 * WebSocket implementation at all. The row shows what is true and marks the alternative `later`
 * rather than offering a radio that silently does nothing (Decision 7).
 *
 * **Danger zone** holds the existing emergency stop and `reset demo data`. `showReseed` is
 * computed on the SERVER from `NODE_ENV` and handed down — the client never guesses at the
 * environment, and the route itself 404s in production regardless of what this component renders.
 *
 * The stop NAMES its target (fix round 1, finding 1). `/settings` is a global route, so an earlier
 * version offered the stop only when exactly one workspace existed and hid it entirely on every
 * real multi-project install — §5.7 promises the danger zone holds the stop, unqualified. A
 * selector is the precedent §5.7 item 9 already sets for Analytics: the operator picks the project,
 * and the button halts THAT one with THAT one's real halted state. Nothing is ever halted by
 * default-guess.
 */
export function DangerZone({
  workspaces,
  showReseed,
}: {
  /** Every project, in `listProjects()`'s name order. Empty only on an install with no project at
   *  all, which is the one case with nothing for a stop to target. */
  readonly workspaces: readonly { readonly id: string; readonly name: string; readonly halted: boolean }[]
  readonly showReseed: boolean
}): React.JSX.Element {
  const router = useRouter()
  const [reseeding, setReseeding] = useState(false)
  const [reseedError, setReseedError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // The first by name is the default; `listProjects()` already ordered them, so this picks the
  // same project the operator sees at the top of the list rather than an arbitrary row.
  const [selectedId, setSelectedId] = useState<string | null>(workspaces[0]?.id ?? null)
  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? workspaces[0]

  const reseed = async (): Promise<void> => {
    setReseeding(true)
    setReseedError(null)
    const result = await postControl('/api/dev/reseed')
    setReseeding(false)
    setConfirming(false)
    if (!result.ok) {
      setReseedError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <>
      <Panel title="REALTIME TRANSPORT">
        <div className="flex flex-col gap-2">
          <div
            data-testid="transport-sse"
            role="radio"
            aria-checked="true"
            aria-label="server-sent events"
            className="flex items-center gap-2 rounded-card border border-tone-working/24 bg-tone-working/10 px-3 py-2"
          >
            <span aria-hidden className="h-2 w-2 rounded-full bg-tone-working" />
            <span className="text-xs text-text-1">SSE</span>
            <span className="ml-auto font-mono text-[10px] text-text-3">in use</span>
          </div>
          <button
            type="button"
            data-testid="transport-ws"
            disabled
            title="there is no WebSocket transport in this codebase yet"
            className="flex items-center gap-2 rounded-card border border-line bg-transparent px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span aria-hidden className="h-2 w-2 rounded-full bg-tone-idle" />
            <span className="text-xs text-text-2">WebSocket · later</span>
          </button>
        </div>
      </Panel>

      <Panel title="DANGER ZONE">
        <div className="flex flex-col gap-3 rounded-card border border-tone-blocked/22 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-text-2">stop every run in the project</span>
            <span className="ml-auto flex items-center gap-2">
              {selected === undefined ? (
                // Not a disabled button: there is nothing wrong with the control, there is simply
                // no project on this install to aim it at yet.
                <span data-testid="danger-no-workspace" className="font-mono text-[10px] text-text-3">
                  no project yet — the stop has nothing to halt
                </span>
              ) : (
                <>
                  <select
                    data-testid="danger-workspace"
                    aria-label="danger zone workspace"
                    value={selected.id}
                    onChange={(event) => setSelectedId(event.target.value)}
                    className="rounded-chip border border-line bg-bg-2 px-2 py-1 text-xs text-text-1"
                  >
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                  </select>
                  {/* Keyed on the selection so the confirm/error state of one project's stop never
                      carries over onto another's — switching the target starts the two-step
                      confirmation again from the top. */}
                  <EmergencyStopButton key={selected.id} workspaceId={selected.id} halted={selected.halted} />
                </>
              )}
            </span>
          </div>

          {showReseed && (
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <span className="text-xs text-text-2">
                reset demo data
                <span className="ml-2 font-mono text-[10px] text-text-3">runs the seed · development only</span>
              </span>
              <span className="ml-auto flex items-center gap-2">
                {confirming ? (
                  <>
                    <button
                      type="button"
                      data-testid="reseed-confirm"
                      disabled={reseeding}
                      onClick={() => void reseed()}
                      className="rounded-chip border border-status-danger/40 bg-status-danger/10 px-2 py-1 text-xs text-status-danger disabled:opacity-60"
                    >
                      {reseeding ? 'reseeding…' : 'replace the data'}
                    </button>
                    <button
                      type="button"
                      data-testid="reseed-cancel"
                      onClick={() => setConfirming(false)}
                      className="rounded-chip border border-line px-2 py-1 text-xs text-text-2"
                    >
                      cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid="reseed-button"
                    onClick={() => setConfirming(true)}
                    className="rounded-chip border border-status-danger/40 bg-status-danger/10 px-2 py-1 text-xs text-status-danger"
                  >
                    reset demo data
                  </button>
                )}
              </span>
              {reseedError !== null && (
                <span role="alert" className="w-full text-xs text-status-danger">
                  {reseedError}
                </span>
              )}
            </div>
          )}
        </div>
      </Panel>
    </>
  )
}
