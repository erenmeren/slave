'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@ai-team-os/control'
import { sendControl } from '../lib/postControl'
import { Button } from './ui/Button'
import { ModelSelect } from './ModelSelect'
import { ProviderSelect } from './ProviderSelect'

/**
 * The per-worker model+provider override row (M11 Task 8 brief; the pair, M12 Task 13): a
 * `ModelSelect` (the provider's list, `other…` for free text) + provider `<select>` + set/clear,
 * not a dialog -- no Escape handling or focus trap (the brief: "a plain inline input row does not
 * need a focus trap"). Truth from
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
    const error = await sendControl(`/api/agents/${agentId}/model`, { method: 'POST', body: { ...body } })
    if (error === null) {
      router.refresh()
    } else {
      setErrorText(error)
    }
    setPending(false)
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
      <ModelSelect
        provider={providerValue}
        value={value}
        onChange={setValue}
        disabled={pending}
        ariaLabel="model override"
        inputTestId="model-override-input"
        className="w-40 py-1 text-[11px]"
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
