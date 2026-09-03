// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The login page itself (M20 spec §3.3, M23 spec §7 F5), not the form inside it. Two things had no consumer
 * before this file: the `login-unconfigured` branch — the whole reason the page is allowed to
 * exist on a loopback-only instance — and the fact that the page runs `next` through `safeNext`
 * before handing it to the form.
 *
 * `LoginPage` is an async server component: call it, await the element it returns, and render
 * THAT. Every case imports the page dynamically after `vi.resetModules()`, because `authEnv`
 * reads `process.env` at call time on a module the earlier case may already have loaded, and
 * because the prop cases swap `LoginForm` for a stub (a prop is not observable in the DOM
 * otherwise).
 */

const SECRET = '0123456789abcdef0123456789abcdef'

async function renderLoginPage(searchParams: { next?: string }): Promise<void> {
  const { default: LoginPage } = await import('../src/app/login/page.js')
  render(await LoginPage({ searchParams: Promise.resolve(searchParams) }))
}

async function renderWithStubbedForm(searchParams: { next?: string }): Promise<void> {
  vi.doMock('../src/components/LoginForm.js', () => ({
    LoginForm: ({ next }: { readonly next: string }) => <div data-testid="login-form-stub" data-next={next} />,
  }))
  await renderLoginPage(searchParams)
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.doUnmock('../src/components/LoginForm.js')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('says there is nothing to log in to on a loopback-only instance, and offers the way back', async () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', '')
    await renderLoginPage({ next: '//evil' })
    const notice = screen.getByTestId('login-unconfigured')
    expect(notice.textContent).toContain('accounts are not configured on this instance')
    expect(screen.queryByTestId('login-form')).toBeNull()
    expect(within(notice).getByRole('link').getAttribute('href')).toBe('/')
  })

  it('renders the form, not the notice, once a secret is configured', async () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)
    await renderLoginPage({})
    expect(screen.getByTestId('login-form')).not.toBeNull()
    expect(screen.getByTestId('login-username')).not.toBeNull()
    expect(screen.getByTestId('login-password')).not.toBeNull()
    expect(screen.queryByTestId('login-unconfigured')).toBeNull()
  })

  it('runs a protocol-relative `next` through safeNext before the form ever sees it', async () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)
    await renderWithStubbedForm({ next: '//evil' })
    expect(screen.getByTestId('login-form-stub').getAttribute('data-next')).toBe('/')
  })

  it('passes an ordinary in-app path through untouched', async () => {
    vi.stubEnv('AITEAMOS_SESSION_SECRET', SECRET)
    await renderWithStubbedForm({ next: '/w/abc' })
    expect(screen.getByTestId('login-form-stub').getAttribute('data-next')).toBe('/w/abc')
  })
})
