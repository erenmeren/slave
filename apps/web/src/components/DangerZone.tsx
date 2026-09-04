'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { postControl } from '../lib/postControl'
import { Panel } from './ui/Panel'

/**
 * The global Settings page's danger zone (M24 §4): `reset demo data`, gated behind the same
 * two-step confirm every destructive control in this app uses. `showReseed` is computed on the
 * SERVER from `NODE_ENV` and handed down — the client never guesses at the environment, and the
 * route itself 404s in production regardless of what this component renders. The panel itself
 * always renders (it is one of the page's three fixed titles); its body is `null` when reseeding
 * is unavailable.
 *
 * M24 Errata: this panel used to also hold a read-only realtime-transport chooser
 * (`transport-sse` / `transport-ws`) and a per-workspace emergency stop behind its own project
 * selector. The transport row is gone — it only ever picked between SSE, the one transport this
 * codebase has, and a WebSocket "later" that never came. The stop moved to the project Settings
 * tab (M24 Task 4), where it names its one project directly because the page is already scoped to
 * it — no selector needed.
 */
export function DangerZone({ showReseed }: { readonly showReseed: boolean }): React.JSX.Element {
  const router = useRouter()
  const [reseeding, setReseeding] = useState(false)
  const [reseedError, setReseedError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

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
    <Panel title="danger zone">
      {showReseed ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-tone-blocked/22 p-3">
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
                  className="rounded-chip border border-tone-blocked/40 bg-tone-blocked/10 px-2 py-1 text-xs text-tone-blocked disabled:opacity-60"
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
                className="rounded-chip border border-tone-blocked/40 bg-tone-blocked/10 px-2 py-1 text-xs text-tone-blocked"
              >
                reset demo data
              </button>
            )}
          </span>
          {reseedError !== null && (
            <span role="alert" className="w-full text-xs text-tone-blocked">
              {reseedError}
            </span>
          )}
        </div>
      ) : null}
    </Panel>
  )
}
