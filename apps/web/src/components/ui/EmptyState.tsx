import type React from 'react'

/** "There is nothing here", said the same way everywhere (M44 R3). One sentence, optionally one
 *  action -- never an illustration and never an invented next step. */
export function EmptyState({
  message,
  action,
  testId,
}: {
  readonly message: string
  readonly action?: React.ReactNode
  readonly testId: string
}): React.JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-col items-start gap-2 py-2 text-xs text-text-3">
      <span>{message}</span>
      {action}
    </div>
  )
}
