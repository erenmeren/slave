// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Alert } from '../src/components/ui/Alert.js'
import { AvatarTile, initialsOf } from '../src/components/ui/AvatarTile.js'
import { Button } from '../src/components/ui/Button.js'
import { Card } from '../src/components/ui/Card.js'
import { Chip } from '../src/components/ui/Chip.js'
import { DataTable, Row } from '../src/components/ui/DataTable.js'
import { EmptyState } from '../src/components/ui/EmptyState.js'
import { EmptyTile } from '../src/components/ui/EmptyTile.js'
import { LoadingState } from '../src/components/ui/LoadingState.js'
import { PageShell } from '../src/components/ui/PageShell.js'
import { Panel } from '../src/components/ui/Panel.js'
import { ProgressBar } from '../src/components/ui/ProgressBar.js'
import { SectionLabel } from '../src/components/ui/SectionLabel.js'
import { StatStrip } from '../src/components/ui/StatStrip.js'
import { StatusPill } from '../src/components/ui/StatusPill.js'

describe('Panel', () => {
  it('renders a title and its children', () => {
    render(
      <Panel title="Roster">
        <p>panel body</p>
      </Panel>,
    )
    // M14 Task 2: the title is rendered by `PanelHeader`, which reuses `SectionLabel` rather than
    // carrying a second copy of the 9px/.09em recipe -- so the testid is `section-label`.
    expect(screen.getByTestId('section-label').textContent).toBe('Roster')
    expect(screen.getByText('panel body')).toBeTruthy()
  })

  it('renders the optional right-hand action beside the title', () => {
    render(
      <Panel title="Live events" action={<a href="/activity">all →</a>}>
        <p>panel body</p>
      </Panel>,
    )
    expect(screen.getByTestId('panel-header-action').textContent).toBe('all →')
  })

  it('renders children with no title given', () => {
    render(
      <Panel>
        <p>bare body</p>
      </Panel>,
    )
    // No title, no header at all -- and therefore nowhere for an action to sit either.
    expect(screen.queryByTestId('panel-header')).toBeNull()
    expect(screen.queryByTestId('section-label')).toBeNull()
    expect(screen.getByText('bare body')).toBeTruthy()
  })
})

describe('Card', () => {
  it('renders children and reflects the selected prop', () => {
    render(<Card selected>card body</Card>)
    expect(screen.getByTestId('card').textContent).toBe('card body')
    expect(screen.getByTestId('card').getAttribute('data-selected')).toBe('true')
  })

  it('fires onClick when interactive', () => {
    const onClick = vi.fn()
    render(<Card onClick={onClick}>click me</Card>)
    fireEvent.click(screen.getByTestId('card'))
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('StatusPill', () => {
  it('renders its label with data-tone', () => {
    render(<StatusPill tone="blocked" label="Blocked" />)
    const pill = screen.getByTestId('status-pill')
    expect(pill.textContent).toBe('Blocked')
    expect(pill.getAttribute('data-tone')).toBe('blocked')
  })
})

describe('initialsOf', () => {
  it('takes the first letters of the first two words', () => {
    expect(initialsOf('Checkout Platform')).toBe('CP')
    expect(initialsOf('atlas software co')).toBe('AS')
  })

  it('takes one letter from a single-word name', () => {
    expect(initialsOf('Alex')).toBe('A')
  })

  it('returns the unknown mark for an empty or whitespace-only name', () => {
    expect(initialsOf('')).toBe('—')
    expect(initialsOf('   ')).toBe('—')
  })
})

describe('AvatarTile', () => {
  it('renders the initials, the tone attribute, and the 28px/radius-7 recipe', () => {
    render(<AvatarTile name="Alex Turner" tone="working" />)
    const tile = screen.getByTestId('avatar-tile')
    expect(tile.textContent).toBe('AT')
    expect(tile.getAttribute('data-tone')).toBe('working')
    // Class-string assertions only -- jsdom loads no CSS here (see the plan's "What jsdom can and
    // cannot verify" table). `getComputedStyle(tile).width` would read `''`, not `28px`; the
    // milestone gate is what checks the rendered box.
    expect(tile.className).toContain('h-7')
    expect(tile.className).toContain('w-7')
    expect(tile.className).toContain('rounded-tile')
    expect(tile.className).toContain('text-[11px]')
  })

  it('carries the name for assistive tech rather than only two letters', () => {
    render(<AvatarTile name="Alex Turner" tone="idle" />)
    expect(screen.getByTestId('avatar-tile').getAttribute('title')).toBe('Alex Turner')
  })
})

describe('StatusPill pulse', () => {
  it('defaults to the tone in-flight rule when no pulse is given', () => {
    const { rerender } = render(<StatusPill tone="working" label="WORKING" />)
    expect(screen.getByTestId('status-pill').querySelector('span')?.className).toContain('animate-[status-pulse')

    rerender(<StatusPill tone="paused" label="PAUSED" />)
    expect(screen.getByTestId('status-pill').querySelector('span')?.className).not.toContain('animate-[status-pulse')
  })

  it('lets an explicit pulse override the tone default in both directions', () => {
    // `pause_requested` rides the `waiting` tone (which does not pulse by default) and MUST pulse.
    const { rerender } = render(<StatusPill tone="waiting" label="PAUSING" pulse />)
    expect(screen.getByTestId('status-pill').querySelector('span')?.className).toContain('animate-[status-pulse')

    rerender(<StatusPill tone="working" label="WORKING" pulse={false} />)
    expect(screen.getByTestId('status-pill').querySelector('span')?.className).not.toContain('animate-[status-pulse')
  })

  it('keeps the 20px pill radius class', () => {
    render(<StatusPill tone="idle" label="IDLE" />)
    expect(screen.getByTestId('status-pill').className).toContain('rounded-pill')
  })
})

describe('StatStrip', () => {
  it('renders n items', () => {
    render(
      <StatStrip
        items={[
          { label: 'slaves', value: '6' },
          { label: 'active', value: '3', tone: 'working' },
          { label: 'blocked', value: '1', tone: 'blocked' },
        ]}
      />,
    )
    const items = screen.getAllByTestId('stat-strip-item')
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain('slaves')
    expect(items[0]?.textContent).toContain('6')
  })
})

describe('DataTable', () => {
  it('renders header cells and row children', () => {
    render(
      <DataTable columns="1fr 1fr" header={['Name', 'Status']}>
        <Row columns="1fr 1fr">
          <span>Alex</span>
          <span>working</span>
        </Row>
      </DataTable>,
    )
    const headerCells = screen.getAllByTestId('data-table-header-cell')
    expect(headerCells.map((cell) => cell.textContent)).toEqual(['Name', 'Status'])
    expect(screen.getByText('Alex')).toBeTruthy()
    expect(screen.getByText('working')).toBeTruthy()
  })
})

describe('ProgressBar', () => {
  it('sets width to the given pct', () => {
    render(<ProgressBar pct={42} />)
    const fill = screen.getByTestId('progress-bar-fill')
    expect(fill.style.width).toBe('42%')
  })

  it('is 6px by default and 3px in the card size', () => {
    // The handoff gives the slave card a 3px bar (README "1a") and every table row the 6px one
    // this component has always drawn; `size` is that one difference, not a second component.
    const { rerender } = render(<ProgressBar pct={42} />)
    expect(screen.getByTestId('progress-bar').className).toContain('h-1.5')

    rerender(<ProgressBar pct={42} size="card" />)
    expect(screen.getByTestId('progress-bar').className).toContain('h-[3px]')
    expect(screen.getByTestId('progress-bar').className).not.toContain('h-1.5')
  })

  it('clamps above 100 down to 100', () => {
    render(<ProgressBar pct={150} />)
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('100%')
  })

  it('clamps below 0 up to 0', () => {
    render(<ProgressBar pct={-10} />)
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('0%')
  })

  it('draws no fill and claims no value when unmeasured', () => {
    render(<ProgressBar pct={null} />)
    const bar = screen.getByTestId('progress-bar')
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    expect(screen.queryByTestId('progress-bar-fill')).toBeNull()
  })

  it('a real zero still measures: fill present, aria-valuenow 0', () => {
    render(<ProgressBar pct={0} />)
    expect(screen.getByTestId('progress-bar').getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByTestId('progress-bar-fill')).toBeTruthy()
  })

  it('is a progressbar to assistive tech, with bounds', () => {
    render(<ProgressBar pct={40} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
  })

  it('unmeasured keeps the role but omits aria-valuenow (ARIA indeterminate)', () => {
    render(<ProgressBar pct={null} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
  })
})

describe('SectionLabel', () => {
  it('renders its children', () => {
    render(<SectionLabel>Roster</SectionLabel>)
    expect(screen.getByTestId('section-label').textContent).toBe('Roster')
  })
})

describe('Chip', () => {
  it('renders its children and an optional tone', () => {
    render(<Chip tone="review">backend</Chip>)
    const chip = screen.getByTestId('chip')
    expect(chip.textContent).toBe('backend')
    expect(chip.getAttribute('data-tone')).toBe('review')
  })

  it('renders with no tone', () => {
    render(<Chip>plain</Chip>)
    expect(screen.getByTestId('chip').textContent).toBe('plain')
  })
})

describe('Button', () => {
  it('renders the ghost variant and fires onClick', () => {
    const onClick = vi.fn()
    render(
      <Button variant="ghost" onClick={onClick}>
        Cancel
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Cancel' })
    expect(button.getAttribute('data-variant')).toBe('ghost')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('renders the primary variant', () => {
    render(<Button variant="primary">Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('data-variant')).toBe('primary')
  })
})

describe('EmptyTile', () => {
  it('fires onClick', () => {
    const onClick = vi.fn()
    render(<EmptyTile label="add source" onClick={onClick} />)
    fireEvent.click(screen.getByTestId('empty-tile'))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByText('add source')).toBeTruthy()
  })
})

describe('Button (M44 R3: one button, three variants, two sizes)', () => {
  it('renders each variant with its own data-variant', () => {
    render(
      <>
        <Button variant="primary">go</Button>
        <Button variant="ghost">maybe</Button>
        <Button variant="danger">stop</Button>
      </>,
    )
    expect(screen.getAllByTestId('button').map((b) => b.getAttribute('data-variant'))).toEqual(['primary', 'ghost', 'danger'])
  })

  it('is md by default and sm on request -- sm IS the FormControls geometry, so nothing moves', () => {
    render(
      <>
        <Button variant="ghost">a</Button>
        <Button variant="ghost" size="sm">b</Button>
      </>,
    )
    const [md, sm] = screen.getAllByTestId('button')
    expect(md?.className).toContain('px-3')
    expect(md?.className).toContain('py-1.5')
    expect(sm?.className).toContain('px-2.5')
    expect(sm?.className).toContain('py-1')
    expect(md?.getAttribute('data-size')).toBe('md')
    expect(sm?.getAttribute('data-size')).toBe('sm')
  })

  it('paints danger on the blocked tone and primary on working, at the handoff alphas', () => {
    render(<><Button variant="danger">x</Button><Button variant="primary">y</Button></>)
    const [danger, primary] = screen.getAllByTestId('button')
    expect(danger?.className).toContain('bg-tone-blocked/10')
    expect(danger?.className).toContain('border-tone-blocked/24')
    expect(primary?.className).toContain('bg-tone-working/10')
  })

  it('lets a caller name its own testid without losing the variant attribute', () => {
    render(<Button variant="ghost" data-testid="my-button">x</Button>)
    expect(screen.getByTestId('my-button').getAttribute('data-variant')).toBe('ghost')
  })
})

describe('Card (M44 R3, erratum E1: additive only)', () => {
  it('appends a caller className and passes data attributes through', () => {
    render(<Card className="w-40" data={{ 'data-status': 'working' }}>x</Card>)
    const card = screen.getByTestId('card')
    expect(card.className).toContain('w-40')
    expect(card.getAttribute('data-status')).toBe('working')
  })

  it('lets a caller name its own testid', () => {
    render(<Card testId="project-surface">x</Card>)
    expect(screen.getByTestId('project-surface')).toBeTruthy()
    expect(screen.queryByTestId('card')).toBeNull()
  })
})

describe('Alert, EmptyState and LoadingState', () => {
  it('Alert is a role=alert band with its variant on the node', () => {
    render(<Alert variant="notice" testId="stale">showing stale data</Alert>)
    const band = screen.getByTestId('stale')
    expect(band.getAttribute('role')).toBe('alert')
    expect(band.getAttribute('data-variant')).toBe('notice')
    expect(band.textContent).toBe('showing stale data')
  })

  it('EmptyState says the sentence and can carry one action', () => {
    render(<EmptyState testId="no-blocked" message="nothing is blocked" action={<Button variant="ghost">refresh</Button>} />)
    expect(screen.getByTestId('no-blocked').textContent).toContain('nothing is blocked')
    expect(screen.getByTestId('button')).toBeTruthy()
  })

  it('LoadingState is a polite status, not an alert', () => {
    render(<LoadingState testId="loading" />)
    const node = screen.getByTestId('loading')
    expect(node.getAttribute('role')).toBe('status')
    expect(node.getAttribute('aria-live')).toBe('polite')
    expect(node.textContent).toBe('loading…')
  })
})

describe('PageShell', () => {
  it('renders the title row, an optional action, an optional tabs slot and its children', () => {
    render(
      <PageShell title="Workforce" action={<Button variant="primary">+ New slave</Button>} tabs={<div data-testid="tabs-slot" />}>
        <p>body</p>
      </PageShell>,
    )
    const shell = screen.getByTestId('page-shell')
    expect(shell.textContent).toContain('Workforce')
    expect(screen.getByTestId('tabs-slot')).toBeTruthy()
    expect(screen.getByTestId('button').textContent).toBe('+ New slave')
    expect(shell.textContent).toContain('body')
  })

  it('renders children alone when nothing else is given', () => {
    render(<PageShell><p>only</p></PageShell>)
    expect(screen.getByTestId('page-shell').textContent).toBe('only')
  })
})
