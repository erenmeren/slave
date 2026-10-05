import Link from 'next/link'
import { LoginForm } from '@/components/login/LoginForm'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { boundaryMode } from '../../lib/authEnv'
import { safeNext } from '../../lib/safeNext'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Sign in · Slave of AI' }

/** Sign in (lead UX design section 6.7): one centred card, no sidebar. With no accounts on this
 *  installation there is nothing to sign in to, and the card says so. */
export default async function LoginPage({ searchParams }: { readonly searchParams: Promise<{ readonly next?: string }> }): Promise<React.JSX.Element> {
  const { next } = await searchParams
  const accounts = boundaryMode() === 'accounts'
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="gap-3">
          <span aria-hidden className="grid size-9 place-items-center rounded-md bg-primary font-semibold text-primary-foreground">
            S
          </span>
          <CardTitle className="text-lg">Sign in to Slave of AI</CardTitle>
          {!accounts && <CardDescription data-testid="login-unconfigured">This installation has no accounts: only this machine can open it, and there is nothing to sign in to.</CardDescription>}
        </CardHeader>
        <CardContent>
          {accounts ? (
            <LoginForm next={safeNext(next ?? null)} />
          ) : (
            <Link href="/" className="text-sm underline underline-offset-4">
              Open Slave of AI
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
