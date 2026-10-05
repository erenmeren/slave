// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DeleteProjectDialog } from '../src/components/app/DeleteProjectDialog'
import { HelpersView, PAGE } from '../src/components/helpers/HelpersView'
import { LoginForm } from '../src/components/login/LoginForm'
import { stubBrowser, stubFetch } from './fixtures/dom'

beforeAll(() => stubBrowser())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** Types into an input the way a person does, so React sees the change. */
async function type(element: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const helper = (n: number, over: Record<string, unknown> = {}): { id: string; name: string; role: string | null; description: string; speciality: string | null; skills: string[]; projects: { id: string; name: string }[] } => ({
  id: `p${String(n)}`,
  name: `Person ${String(n)}`,
  role: 'Backend Architect',
  description: 'Builds APIs.',
  speciality: 'engineering',
  skills: ['sql'],
  projects: [],
  ...over,
})

describe('Helpers (lead UX design section 6.5)', () => {
  it('says the catalogue is empty and how to fill it', () => {
    render(<HelpersView helpers={[]} />)
    expect(screen.getByTestId('helpers-empty').textContent).toContain('import-catalog')
  })

  it('draws a page of cards, then more on request, and filters by a search', async () => {
    const many = Array.from({ length: PAGE + 5 }, (_, n) => helper(n))
    render(<HelpersView helpers={[...many, helper(999, { name: 'Zed', role: 'Designer', skills: ['figma'], speciality: 'design', projects: [{ id: 'ws-1', name: 'Todo app' }] })]} />)
    expect(screen.getAllByTestId('helper-card')).toHaveLength(PAGE)
    await act(async () => screen.getByTestId('helpers-more').click())
    expect(screen.getAllByTestId('helper-card')).toHaveLength(PAGE + 6)
    await type(screen.getByTestId('helpers-search'), 'figma')
    const cards = screen.getAllByTestId('helper-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.textContent).toContain('On the helper list of Todo app')
  })
})

describe('Sign in (lead UX design section 6.7)', () => {
  it('keeps Sign in off until both fields are filled, then posts them', async () => {
    const fetchMock = stubFetch(() => ({ status: 401, body: { error: 'wrong name or password' } }))
    render(<LoginForm next="/" />)
    const submit = screen.getByTestId('login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await type(screen.getByTestId('login-username'), 'meren')
    await type(screen.getByTestId('login-password'), 'secret')
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST', body: JSON.stringify({ username: 'meren', password: 'secret' }) }))
    expect(screen.getByTestId('login-error').textContent).toBe('wrong name or password')
  })

  it('says an installation without accounts has nothing to sign in to', async () => {
    vi.stubEnv('SLAVEOFAI_SESSION_SECRET', '')
    const { default: LoginPage } = await import('../src/app/login/page')
    render(await LoginPage({ searchParams: Promise.resolve({}) }))
    expect(screen.getByTestId('login-unconfigured').textContent).toContain('nothing to sign in to')
    expect(screen.queryByTestId('login-form')).toBeNull()
  })
})

describe('Delete… (lead UX design section 6.3)', () => {
  const project = { id: 'ws-1', name: 'Todo app', repoPath: '/home/x/todo' }

  it('says what goes and what stays, and keeps Delete off until the name is typed', async () => {
    const fetchMock = stubFetch(() => ({ body: { ok: true } }))
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={project} open onOpenChange={() => {}} onDeleted={onDeleted} />)
    expect(screen.getByTestId('delete-dialog').textContent).toContain('/home/x/todo is not touched')
    const submit = screen.getByTestId('delete-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await type(screen.getByTestId('delete-confirm'), 'Todo ap')
    expect(submit.disabled).toBe(true)
    await type(screen.getByTestId('delete-confirm'), 'Todo app')
    await act(async () => submit.click())
    expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1', expect.objectContaining({ method: 'DELETE' }))
    expect(onDeleted).toHaveBeenCalled()
  })

  it('shows a refusal in the dialog and deletes nothing', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'project ws-1 has 1 live run' } }))
    const onDeleted = vi.fn()
    render(<DeleteProjectDialog project={project} open onOpenChange={() => {}} onDeleted={onDeleted} />)
    await type(screen.getByTestId('delete-confirm'), 'Todo app')
    await act(async () => screen.getByTestId('delete-submit').click())
    expect(screen.getByTestId('delete-error').textContent).toContain('Stop the project and wait for its work to end first.')
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
