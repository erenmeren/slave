'use client'

import { useState } from 'react'
import { SendIcon } from 'lucide-react'
import { toast } from 'sonner'
import { phaseIsActive } from '@slave-of-ai/domain'
import type { ProjectView } from '@slave-of-ai/control'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'

/** Past this many characters the goal is folded to three lines with "Show all". */
const FOLD_AT = 280

/**
 * Lead UX design section 6.3, "What you asked for": the newest build's goal, and the composer that
 * opens the next build -- "Start a build" on a project with none (`POST /goal`), "Ask for a change"
 * after (`POST /goal/request`). An older project's goal is shown read-only.
 */
export function GoalSection({ project, onDone }: { readonly project: ProjectView; readonly onDone: () => Promise<void> }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const empty = project.goal === null || project.goal.trim() === ''
  const readOnly = project.flow === 'packages' || project.archived

  const send = async (): Promise<void> => {
    const words = text.trim()
    if (words === '') return
    setBusy(true)
    setError(null)
    const result = empty
      ? await api<{ version: number }>(`/api/w/${project.id}/goal`, { method: 'POST', body: { goal: words } })
      : await api<{ version: number }>(`/api/w/${project.id}/goal/request`, { method: 'POST', body: { request: words } })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setText('')
    toast.success(empty ? 'Build 1 is starting.' : `Build ${String(result.data.version)} is asked for.`)
    await onDone()
  }

  const goal = project.goal ?? ''
  const folded = !expanded && goal.length > FOLD_AT

  return (
    <Card data-testid="goal-section">
      <CardHeader>
        <CardTitle className="text-base">What you asked for</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {empty ? (
          <p className="text-sm text-muted-foreground">Nothing has been asked for yet.</p>
        ) : (
          <div>
            <p data-testid="goal-text" className={`text-sm whitespace-pre-wrap ${folded ? 'line-clamp-3' : ''}`}>
              {goal}
            </p>
            {goal.length > FOLD_AT && (
              <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setExpanded(!expanded)}>
                {expanded ? 'Show less' : 'Show all'}
              </Button>
            )}
          </div>
        )}
        {!readOnly && (
          <form
            data-testid="goal-composer"
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!busy) void send()
            }}
          >
            <label htmlFor="goal-input" className="text-sm font-medium">
              {empty ? 'Start a build' : 'Ask for a change'}
            </label>
            <Textarea
              id="goal-input"
              data-testid="goal-input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={empty ? 'Describe what you want built…' : 'Describe what should change…'}
              rows={3}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {!empty && phaseIsActive(project.phase) ? 'The current build keeps going; your change becomes the next build.' : ''}
              </span>
              <Button type="submit" size="sm" data-testid="goal-send" disabled={busy || text.trim() === ''}>
                <SendIcon />
                {busy ? 'Sending…' : 'Send'}
              </Button>
            </div>
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  )
}
