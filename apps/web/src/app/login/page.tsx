import { LoginForm } from '../../components/LoginForm'
import { Panel } from '../../components/ui/Panel'
import { boundaryMode } from '../../lib/authEnv'
import { safeNext } from '../../lib/safeNext'

export const dynamic = 'force-dynamic'

/** The login page (M20 spec §3.3): a single centred panel on the app's own chrome, no sidebar
 *  (the shell is a logged-in surface — `Sidebar` steps aside on this path). In loopback mode
 *  there is nothing to log in to, and the page says so instead of rendering a form. */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly next?: string }>
}): Promise<React.JSX.Element> {
  const { next } = await searchParams
  const mode = boundaryMode()
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <Panel title="sign in">
          {mode === 'password' ? (
            <LoginForm next={safeNext(next ?? null)} />
          ) : (
            <p data-testid="login-unconfigured" className="font-mono text-[10px] text-text-3">
              password login is not configured on this instance — loopback-only.{' '}
              <a href="/" className="underline">
                open the app
              </a>
            </p>
          )}
        </Panel>
      </div>
    </main>
  )
}
