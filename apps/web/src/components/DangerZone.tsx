'use client'

import { useRouter } from 'next/navigation'
import { postControl } from '../lib/postControl'
import { DangerConfirm } from './ui/DangerConfirm'
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

  return (
    <Panel title="danger zone">
      {showReseed ? (
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-tone-blocked/22 p-3">
          <span className="text-xs text-text-2">
            reset demo data
            <span className="ml-2 font-mono text-[10px] text-text-3">runs the seed · development only</span>
          </span>
          <span className="ml-auto flex items-center gap-2">
            {/* M44 R3: the two-step confirm this panel hand-rolled is `ui/DangerConfirm` now, the
              * one destructive recipe. Its testids follow the component's convention, so the
              * trigger is `reseed` rather than `reseed-button`; `reseed-confirm`/`reseed-cancel`
              * and the inline refusal are unchanged, and the refusal now lands in `reseed-error`
              * beside the confirm rather than in a band of this panel's own. */}
            <DangerConfirm
              label="reset demo data"
              testId="reseed"
              confirmText="replace the data"
              onConfirm={async () => {
                const result = await postControl('/api/dev/reseed')
                if (!result.ok) return result.error
                router.refresh()
                return null
              }}
            />
          </span>
        </div>
      ) : null}
    </Panel>
  )
}
