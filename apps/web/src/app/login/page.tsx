import { LoginForm } from '../../components/LoginForm'
import { boundaryMode } from '../../lib/authEnv'
import { safeNext } from '../../lib/safeNext'

export const dynamic = 'force-dynamic'

/** The login page (M20 spec §3.3; M61 R12/R13, Task 9): a single glass card on the app's own
 *  chrome, no sidebar (the shell is a logged-in surface — `Sidebar` steps aside on this path).
 *  In loopback mode there is nothing to log in to, and the page says so instead of rendering a
 *  form. The mark above the form is the SAME `S` tile `shell/Rail.tsx` draws for its own
 *  `aria-label="Slave of AI"` mark, copied verbatim rather than pulled into a shared component
 *  neither side needs a second prop surface for. */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly next?: string }>
}): Promise<React.JSX.Element> {
  const { next } = await searchParams
  const mode = boundaryMode()
  return (
    <div className="glass mx-auto mt-[12dvh] w-[380px] rounded-sheet border border-line p-6">
      <div
        aria-hidden
        className="mb-4 grid h-8 w-8 place-items-center rounded-control bg-accent text-accent-ink font-semibold"
      >
        S
      </div>
      {mode === 'accounts' ? (
        <LoginForm next={safeNext(next ?? null)} />
      ) : (
        <p data-testid="login-unconfigured" className="font-mono text-[10px] text-text-3">
          accounts are not configured on this instance — loopback-only.{' '}
          <a href="/" className="underline">
            open the app
          </a>
        </p>
      )}
    </div>
  )
}
