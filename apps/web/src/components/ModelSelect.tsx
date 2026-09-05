'use client'

import { useEffect, useState } from 'react'
import type { ModelListing, ProviderKind } from '@slave-of-ai/control'
import { INPUT_SHELL } from './ui/FormControls'

const OTHER = '__other__'

// One in-flight/settled request per provider kind, shared by every instance on the page (three
// editors in the Agents table are one `GET`, not three). `clearModelSelectCache` is the test seam.
const listings = new Map<ProviderKind, Promise<ModelListing>>()

export function clearModelSelectCache(): void {
  listings.clear()
}

function listingFor(kind: ProviderKind): Promise<ModelListing> {
  const hit = listings.get(kind)
  if (hit !== undefined) return hit
  const promise = fetch(`/api/providers/${kind}/models`)
    .then(async (response) => (response.ok ? ((await response.json()) as ModelListing) : { models: [], source: 'account' as const, error: `request failed (${response.status})` }))
    .catch((error: unknown) => ({ models: [], source: 'account' as const, error: error instanceof Error ? error.message : 'request failed' }))
  listings.set(kind, promise)
  return promise
}

/**
 * The model field every form shares (M25 §5.3): a `<select>` fed by `GET /api/providers/<kind>/
 * models`, with `— none —` first and `other…` last. `other…` (or a failed listing) reveals a text
 * input that carries the testid the field had before this milestone (`inputTestId`), so the
 * existing tests and gates keep reading the same element. A `value` the list does not know
 * (typed before this milestone) is shown as a selected extra option and never rewritten.
 */
export function ModelSelect({
  provider,
  value,
  onChange,
  disabled = false,
  ariaLabel,
  inputTestId,
  className = '',
}: {
  readonly provider: ProviderKind | ''
  readonly value: string
  readonly onChange: (next: string) => void
  readonly disabled?: boolean
  readonly ariaLabel: string
  readonly inputTestId: string
  readonly className?: string
}): React.JSX.Element {
  const [listing, setListing] = useState<ModelListing | null>(null)
  const [mode, setMode] = useState<'list' | 'other'>('list')

  useEffect(() => {
    if (provider === '') {
      setListing(null)
      return
    }
    let cancelled = false
    setListing(null)
    void listingFor(provider).then((result) => {
      if (!cancelled) setListing(result)
    })
    return () => {
      cancelled = true
    }
  }, [provider])

  const shell = `${INPUT_SHELL} ${className}`.trim()

  if (provider === '') {
    return (
      <span className="flex flex-col gap-1">
        <select data-testid="model-select" aria-label={ariaLabel} disabled value="" className={shell} onChange={() => {}}>
          <option value="">— none —</option>
        </select>
        <span className="text-[10px] text-text-3">choose a provider first</span>
      </span>
    )
  }

  const failed = listing !== null && (listing.error !== undefined || listing.models.length === 0)
  if (mode === 'other' || failed) {
    return (
      <span className="flex flex-col gap-1">
        <input
          data-testid={inputTestId}
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          placeholder="model"
          onChange={(event) => onChange(event.target.value)}
          className={`${shell} font-mono`}
        />
        {failed && listing?.error !== undefined ? (
          <span data-testid="model-select-note" className="text-[10px] text-text-3">model list unavailable: {listing.error}</span>
        ) : failed ? (
          <span data-testid="model-select-note" className="text-[10px] text-text-3">model list unavailable: empty</span>
        ) : (
          <button type="button" data-testid="model-select-back" onClick={() => setMode('list')} className="self-start text-[10px] text-text-3 hover:text-text-1">
            pick from the list
          </button>
        )}
      </span>
    )
  }

  const models = listing?.models ?? []
  const known = models.some((m) => m.id === value)
  return (
    <select
      data-testid="model-select"
      aria-label={ariaLabel}
      value={value}
      disabled={disabled || listing === null}
      className={shell}
      onChange={(event) => {
        if (event.target.value === OTHER) {
          setMode('other')
          return
        }
        onChange(event.target.value)
      }}
    >
      <option value="">— none —</option>
      {!known && value !== '' && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.default === true ? `${m.label} (default)` : m.label}
        </option>
      ))}
      <option value={OTHER}>other…</option>
    </select>
  )
}
