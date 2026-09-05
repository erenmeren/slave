import type { AdapterCard } from '../server/settings'
import { TONE_DOT, type StatusTone } from './ui/StatusPill'

/**
 * The Settings page's provider adapter cards (M14 §5.7, README "3a — Settings").
 *
 * Two of these four are real and two are not, and the card SAYS which: a `later` card carries
 * `not configured · later`, a disabled CTA, no version and no capability line, because there is
 * no adapter behind it to describe (Decision 7 — nothing looks functional that is not). A real
 * adapter whose binary is missing says `not found on PATH` rather than borrowing the calm of a
 * connected one.
 *
 * A server component: it takes the already-built `AdapterCard[]` and renders it. There is nothing
 * to click here except a CTA that is disabled on the only cards that have one.
 */
const STATE_TONE: Record<AdapterCard['state'], StatusTone> = {
  connected: 'working',
  'not found': 'blocked',
  later: 'idle',
}

const STATE_TEXT: Record<AdapterCard['state'], string> = {
  connected: 'connected',
  'not found': 'not found on PATH',
  later: 'not configured · later',
}

const STATE_TEXT_CLASS: Record<AdapterCard['state'], string> = {
  connected: 'text-tone-working',
  'not found': 'text-tone-blocked',
  later: 'text-text-3',
}

/** The capability line: gate, then the two booleans stated as facts rather than as `true`/`false`
 *  — "reports cost" and "no cost reporting" are both readable; `reportsCost: false` is not. */
function capabilityLine(capabilities: NonNullable<AdapterCard['capabilities']>): string {
  return [
    `gate ${capabilities.gate}`,
    capabilities.reportsCost ? 'reports cost' : 'no cost reporting',
    capabilities.canPauseMidRun ? 'pauses mid-run' : 'no mid-run pause',
  ].join(' · ')
}

export function ProviderAdapterCards({ adapters }: { readonly adapters: readonly AdapterCard[] }): React.JSX.Element {
  return (
    <div data-testid="adapter-cards" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {adapters.map((adapter) => (
        <div
          key={adapter.kind}
          data-testid={`adapter-card-${adapter.kind}`}
          className={`flex flex-col gap-2 rounded-card border border-line bg-bg-2 p-3 ${adapter.state === 'later' ? 'opacity-60' : ''}`}
        >
          <div className="flex items-center gap-2">
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[STATE_TONE[adapter.state]]}`} />
            <span className="text-[13px] font-medium text-text-1">{adapter.label}</span>
            <span
              data-testid={`adapter-state-${adapter.kind}`}
              className={`ml-auto font-mono text-[9.5px] uppercase tracking-[.09em] ${STATE_TEXT_CLASS[adapter.state]}`}
            >
              {STATE_TEXT[adapter.state]}
            </span>
          </div>

          <div className="flex flex-wrap items-baseline gap-x-2 font-mono text-[10.5px] text-text-3">
            <span>{adapter.adapter}</span>
            {/* `—`, never a fabricated version string: an unrunnable binary has no version to
                show, and M14 Decision 4 spells `unknown` as a dash. */}
            <span data-testid={`adapter-version-${adapter.kind}`} className="text-text-2">
              {adapter.version ?? '—'}
            </span>
          </div>

          {adapter.capabilities !== null && (
            <div data-testid={`adapter-capabilities-${adapter.kind}`} className="font-mono text-[10px] text-text-3">
              {capabilityLine(adapter.capabilities)}
            </div>
          )}

          <div className="mt-1 flex items-center justify-between gap-2">
            <span data-testid={`adapter-bound-${adapter.kind}`} className="font-mono text-[10px] text-text-3">
              {adapter.slavesBound} {adapter.slavesBound === 1 ? 'run bound' : 'runs bound'}
            </span>
            <button
              type="button"
              data-testid={`adapter-cta-${adapter.kind}`}
              // Every one of these is disabled: there is no adapter configuration surface in this
              // milestone at all. A `later` card's CTA additionally reads `later`, so the two
              // reasons for the same disabled state are distinguishable to a reader.
              disabled
              title={adapter.state === 'later' ? 'no adapter for this provider yet' : 'adapter configuration is not editable yet'}
              className="rounded-chip border border-line bg-transparent px-2 py-1 text-[11px] text-text-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {adapter.state === 'later' ? 'later' : 'configure · later'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
