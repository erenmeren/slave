'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@ai-team-os/control'
import { Button } from './ui/Button'
import { ProviderSelect } from './ProviderSelect'

/** Pulls a 409 refusal's `{ error }` text, falling back to something nameable for any other
 *  non-2xx or malformed body -- the `errorMessage` idiom `AssignCompanyDialog.tsx`/
 *  `EmergencyStopButton.tsx` already use, copied rather than imported (a small local copy is the
 *  house pattern here, not a shared control-plane module). */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

/**
 * The per-worker model+provider override row (M11 Task 8 brief; the pair, M12 Task 13): a plain
 * inline text input + provider `<select>` + set/clear, not a dialog -- no Escape handling or
 * focus trap (the brief: "a plain inline input row does not need a focus trap"). Truth from
 * snapshot: a 200 triggers `router.refresh()`; the refreshed roster/workers props are what settle
 * the displayed model and provider, not anything written here on success. A 409 (e.g. a model with
 * no provider) renders inline and leaves the inputs as the caller left them.
 *
 * The provider `<select>` defaults to the worker's OWN current provider when one is set, else
 * empty/unselected -- deliberately not defaulted to any other value, so an operator who types a
 * model without touching the select still sends a bare model and gets the server's real
 * `model_without_provider` refusal (controller resolution 1: this is not client-validated away).
 */
export function ModelOverrideEditor({
  agentId,
  model,
  provider,
}: {
  readonly agentId: string
  readonly model: string | null
  readonly provider?: ProviderKind | null | undefined
}): React.JSX.Element {
  const router = useRouter()
  const [value, setValue] = useState(model ?? '')
  const [providerValue, setProviderValue] = useState<ProviderKind | ''>(provider ?? '')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  // This instance survives a `router.refresh()` re-render (its parent keys rows by `agentId`,
  // which doesn't change) -- resync both inputs from the incoming props so a successful set/clear
  // actually shows the refreshed snapshot's truth, not whatever was last typed/selected.
  useEffect(() => {
    setValue(model ?? '')
    setProviderValue(provider ?? '')
  }, [model, provider])

  const post = async (body: { readonly model: string | null; readonly provider?: ProviderKind }): Promise<void> => {
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch(`/api/agents/${agentId}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok) {
        router.refresh()
        return
      }
      const data: unknown = await response.json().catch(() => null)
      setErrorText(errorMessage(data, response.status))
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-testid="model-override-editor" className="flex flex-wrap items-center gap-1">
      <ProviderSelect
        testId="model-override-provider"
        ariaLabel="provider"
        value={providerValue}
        onChange={setProviderValue}
        disabled={pending}
        placeholder="provider"
        className="rounded border border-line bg-bg-2 px-1.5 py-1 text-[11px] text-text-1"
      />
      <input
        data-testid="model-override-input"
        aria-label="model override"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="model"
        className="w-32 rounded border border-line bg-bg-2 px-1.5 py-1 font-mono text-[11px] text-text-1"
      />
      <Button
        variant="ghost"
        data-testid="model-override-set"
        disabled={pending}
        onClick={() => void post(providerValue === '' ? { model: value } : { model: value, provider: providerValue })}
      >
        Set
      </Button>
      <Button variant="ghost" data-testid="model-override-clear" disabled={pending} onClick={() => void post({ model: null })}>
        Clear
      </Button>
      {errorText !== null && (
        <span role="alert" data-testid="model-override-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </div>
  )
}
