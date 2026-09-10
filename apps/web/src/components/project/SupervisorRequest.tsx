'use client'

import { useState } from 'react'
import { postJson } from '../../lib/postControl'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'

/** What `POST /api/w/:id/goal/request` answers with on success -- the route's own envelope. */
interface RequestAccepted {
  readonly ok: true
  readonly version: number
  readonly sha256: string
  readonly goal: string
}

/**
 * One input, one verb (M45 R3).
 *
 * This does not brief a model, hire anybody or cancel a task. It writes a GOAL VERSION whose text
 * is the standing goal plus a dated line saying what was asked, and M40's trigger re-plans that
 * version as a delta on the next tick. What the re-plan adds becomes tasks; what it wants to
 * cancel becomes proposals a person approves. That whole path is visible on the timeline below,
 * lane by lane, and nothing here pretends to more than it.
 *
 * "Bring in a security specialist" is M47/M50. Until then the request lands in the goal and the
 * re-plan may add a task for it; the copy above promises exactly that and no more.
 *
 * The button goes down the moment a POST leaves, and stays down until it answers: `requestChange`
 * refuses a byte-identical resubmission (`duplicate_request`), but that is the BACKSTOP, not the
 * user experience -- a double click must not be two writes and two armed re-plans.
 */
export function SupervisorRequest({ workspaceId }: { readonly workspaceId: string }): React.JSX.Element {
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{ readonly ok: boolean; readonly message: string } | null>(null)

  const send = async (): Promise<void> => {
    const request = text.trim()
    if (request === '' || pending) return
    setPending(true)
    setResult(null)
    const answer = await postJson<RequestAccepted>(`/api/w/${workspaceId}/goal/request`, { request })
    if (answer.ok) {
      // Cleared only on success: a refusal that emptied the box would delete the words a person
      // has to read to understand why they were refused.
      setText('')
      setResult({ ok: true, message: `goal v${String(answer.data.version)} saved — the next tick re-plans it as a delta` })
    } else {
      setResult({ ok: false, message: answer.error })
    }
    setPending(false)
  }

  return (
    <div data-testid="supervisor-request" className="px-[20px] pt-[16px]">
      <Panel title="tell the Supervisor what changed">
        {/* A textarea, so what a person types is characters in a form control and never elements
          * -- the same reason the Supervisor panel's profile box is one. */}
        <textarea
          data-testid="supervisor-request-input"
          // Named for a screen reader (final wave M2): the Panel's title is a heading, not a
          // label, and the placeholder vanishes as soon as somebody types.
          aria-label="Tell the Supervisor"
          value={text}
          rows={2}
          placeholder="what changed, in your own words — it becomes the next goal version"
          onChange={(event) => setText(event.target.value)}
          className="rounded border border-line bg-bg-0 p-2 text-xs text-text-1"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            data-testid="supervisor-request-send"
            disabled={text.trim() === '' || pending}
            onClick={() => void send()}
          >
            {pending ? 'sending…' : 'send'}
          </Button>
          {result !== null && (
            <span
              data-testid="supervisor-request-result"
              {...(result.ok ? {} : { role: 'alert' })}
              className={`text-xs ${result.ok ? 'text-text-2' : 'text-tone-blocked'}`}
            >
              {result.message}
            </span>
          )}
        </div>
      </Panel>
    </div>
  )
}
