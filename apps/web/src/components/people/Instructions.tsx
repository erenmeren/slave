'use client'

import { useState } from 'react'
import { PencilIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/**
 * Instructions as one text: shown as written, edited in place, cleared on request. `onSave`
 * answers the refusal's sentence, or null when the text was stored (`null` text clears it).
 * `startFrom` offers a text to begin from -- a person's own instructions usually begin as their
 * persona's profile.
 */
export function Instructions({
  text,
  emptyLine,
  writeLabel,
  startFrom,
  onSave,
  testId,
}: {
  readonly text: string | null
  readonly emptyLine: string
  readonly writeLabel: string
  readonly startFrom?: { readonly label: string; readonly text: string } | undefined
  readonly onSave: (text: string | null) => Promise<string | null>
  readonly testId: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const store = async (next: string | null): Promise<void> => {
    setBusy(true)
    const refusal = await onSave(next)
    setBusy(false)
    setProblem(refusal)
    if (refusal === null) setDraft(null)
  }

  if (draft !== null) {
    return (
      <div className="flex flex-col gap-2" data-testid={testId}>
        <Textarea
          autoFocus
          aria-label="Instructions"
          data-testid={`${testId}-editor`}
          className="min-h-64 font-mono text-xs"
          value={draft}
          placeholder="Write in plain words or Markdown: who they are, how they work, what they must never do."
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft(null)
              setProblem(null)
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void store(draft)
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          {startFrom !== undefined && draft.trim() === '' && (
            <Button size="sm" variant="outline" onClick={() => setDraft(startFrom.text)} data-testid={`${testId}-start`}>
              {startFrom.label}
            </Button>
          )}
          <p className="mr-auto text-xs text-muted-foreground">Ctrl+Enter saves, Escape cancels.</p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(null)
              setProblem(null)
            }}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void store(draft)} data-testid={`${testId}-save`}>
            Save
          </Button>
        </div>
        {problem !== null && (
          <p role="alert" className="text-xs text-destructive" data-testid={`${testId}-problem`}>
            {problem}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {text === null || text === '' ? (
        <p className="text-sm text-muted-foreground">{emptyLine}</p>
      ) : (
        <pre className="max-h-72 overflow-y-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap" data-testid={`${testId}-text`}>
          {text}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setDraft(text ?? '')} data-testid={`${testId}-edit`}>
          <PencilIcon />
          {text === null || text === '' ? writeLabel : 'Edit'}
        </Button>
        {text !== null && text !== '' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void store(null)} data-testid={`${testId}-clear`}>
            <Trash2Icon />
            Clear
          </Button>
        )}
      </div>
      {problem !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}
