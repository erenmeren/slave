import type React from 'react'

/** "This is on its way" (M44 R3). `role="status"` + `aria-live="polite"`, NOT `role="alert"`: a
 *  screen reader should not be interrupted because a panel is fetching. */
export function LoadingState({
  message = 'loading…',
  testId,
}: {
  readonly message?: string
  readonly testId: string
}): React.JSX.Element {
  return (
    <div role="status" aria-live="polite" data-testid={testId} className="py-2 text-xs text-text-3">
      {message}
    </div>
  )
}
