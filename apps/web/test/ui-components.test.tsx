// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Alert } from '../src/components/ui/Alert.js'
import { AvatarTile, initialsOf } from '../src/components/ui/AvatarTile.js'
import { Button } from '../src/components/ui/Button.js'
import { Card } from '../src/components/ui/Card.js'
import { Chip } from '../src/components/ui/Chip.js'
import { DataTable, Row } from '../src/components/ui/DataTable.js'
import { DetailsGroup } from '../src/components/ui/DetailsGroup.js'
import { EmptyState } from '../src/components/ui/EmptyState.js'
import { EmptyTile } from '../src/components/ui/EmptyTile.js'
import { Kbd } from '../src/components/ui/Kbd.js'
import { LiveDot } from '../src/components/ui/LiveDot.js'
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

  // Same contract as `Chip`'s, for the same reason (M44 R5): the Slaves table's pill reads PAUSING
  // and has to keep `pausing` on the node, and every pill that has nothing to keep must not render
  // an empty tooltip.
  it('carries a raw value in title when given one, and no title attribute at all when not', () => {
    render(<><StatusPill tone="paused" label="PAUSING" title="pausing" /><StatusPill tone="idle" label="IDLE" /></>)
    const [titled, plain] = screen.getAllByTestId('status-pill')
    expect(titled?.getAttribute('title')).toBe('pausing')
    expect(plain?.hasAttribute('title')).toBe(false)
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

// M61 R16: the pipeline dot `StatusPill` and `Chip` both now render, factored out on its own.
describe('LiveDot', () => {
  it('sets data-tone, and defaults to `live-dot` when no testId is given', () => {
    render(<LiveDot tone="working" />)
    const dot = screen.getByTestId('live-dot')
    expect(dot.getAttribute('data-tone')).toBe('working')
  })

  it('takes a caller testId', () => {
    render(<LiveDot tone="blocked" testId="my-dot" />)
    expect(screen.getByTestId('my-dot')).toBeTruthy()
    expect(screen.queryByTestId('live-dot')).toBeNull()
  })

  it('adds the pulse class only for the four in-flight tones', () => {
    for (const tone of ['working', 'planning', 'review', 'waiting'] as const) {
      const { unmount } = render(<LiveDot tone={tone} testId="d" />)
      expect(screen.getByTestId('d').className).toContain('animate-[status-pulse')
      unmount()
    }
    for (const tone of ['blocked', 'done', 'paused', 'idle'] as const) {
      const { unmount } = render(<LiveDot tone={tone} testId="d" />)
      expect(screen.getByTestId('d').className).not.toContain('animate-[status-pulse')
      unmount()
    }
  })

  it('lets pulse={false} silence an in-flight tone', () => {
    render(<LiveDot tone="working" pulse={false} testId="d" />)
    expect(screen.getByTestId('d').className).not.toContain('animate-[status-pulse')
  })
})

describe('Kbd', () => {
  it('renders its children inside a real <kbd> element', () => {
    render(<Kbd>⌘K</Kbd>)
    const kbd = screen.getByText('⌘K')
    expect(kbd.tagName).toBe('KBD')
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

  // M44 final review, minor c. The nine-column Slaves table is laid out on ~1030px of FIXED
  // tracks; below that the columns had nowhere to go and `overflow-hidden` simply cut them off,
  // with no way for a person on a narrow window to reach the last three. `overflow-x-auto` scrolls
  // instead, and clips exactly as before at every width where the table fits (CSS: a non-`visible`
  // overflow on one axis computes the other to `auto`, so the rounded card still clips its rows).
  it('scrolls sideways rather than cutting a wide table off', () => {
    render(
      <DataTable columns="1fr 1fr" header={['Name', 'Status']}>
        <Row columns="1fr 1fr">
          <span>Alex</span>
        </Row>
      </DataTable>,
    )
    const table = screen.getByTestId('data-table')
    expect(table.className).toContain('overflow-x-auto')
    expect(table.className).not.toContain('overflow-hidden')
    // The card's own rounding is unchanged -- this is a scroll fix, not a shape change (D8).
    // M61 R16: same radius, new name -- `rounded-card` was always an alias of `--radius-control`.
    expect(table.className).toContain('rounded-control')
  })

  // M46 final wave, I1. `last` has three states, not two. Omitted means "my rows are direct
  // children, keep the `:last-child` rule you always had"; given means "I wrap my rows, so the
  // selector cannot see position -- I say which one is last". The broken middle state was a
  // wrapped non-last row that carried BOTH `border-b` and `last:border-b-0`: it is the only child
  // of its wrapper, so `.last\:border-b-0:last-child` (0,2,0) beat `.border-b` (0,1,0) and the
  // separator vanished from every row of every wrapping table.
  it('drops the :last-child rule as soon as the caller says which row is last', () => {
    render(
      <DataTable columns="1fr" header={['Name']}>
        <div>
          <Row columns="1fr" last={false}>
            <span>first</span>
          </Row>
        </div>
        <div>
          <Row columns="1fr" last={true}>
            <span>second</span>
          </Row>
        </div>
      </DataTable>,
    )
    const [first, second] = screen.getAllByTestId('data-table-row')
    expect(first?.className).toContain('border-b')
    expect(first?.className).not.toContain('last:border-b-0')
    expect(second?.className).not.toContain('border-b')
  })

  it('keeps the :last-child rule for a caller whose rows are direct children', () => {
    render(
      <DataTable columns="1fr" header={['Name']}>
        <Row columns="1fr">
          <span>only</span>
        </Row>
      </DataTable>,
    )
    expect(screen.getByTestId('data-table-row').className).toContain('last:border-b-0')
  })

  // M61 Task 10 review, fix round 1 (Important 2): the first cut of this test only asserted
  // `data-index` was present, which is true whether or not `measureElement` ever actually ran --
  // it proved nothing about MEASUREMENT. Rewritten to prove the thing `dynamic` exists for: once
  // a row's real height is measured, the row AFTER it repositions from that measurement, not from
  // the `rowHeight` estimate.
  it('a dynamic table repositions the next row from a measured height, not the rowHeight estimate', () => {
    // `@tanstack/react-virtual` measures its scroll viewport -- and, once `dynamic` wires
    // `measureElement`, each row -- via `offsetWidth`/`offsetHeight` when no `ResizeObserver` is
    // present; jsdom has neither by default. Same idiom `people-table.test.tsx`'s own
    // `mockElementSizes` uses for the VIEWPORT, restored after so it cannot affect a later test in
    // this file.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 })
    try {
      render(
        <DataTable
          columns="1fr"
          header={['Name']}
          virtualized={{
            rowHeight: 40,
            count: 3,
            dynamic: true,
            render: (index) =>
              index === 0 ? (
                // ROW 0's own measured height (not the mocked viewport's 400, not the 40
                // estimate): an `Object.defineProperty` on this ONE element, set from a ref on a
                // CHILD of the virtualizer's row wrapper -- React attaches a child's ref before
                // its parent's during commit, so by the time the wrapper's own
                // `ref={virtualizer.measureElement}` fires, `wrapper.offsetHeight` already reads
                // 120 rather than the prototype's mocked 400.
                <span
                  ref={(node) => {
                    const wrapper = node?.parentElement ?? null
                    if (wrapper !== null) Object.defineProperty(wrapper, 'offsetHeight', { configurable: true, value: 120 })
                  }}
                >
                  row 0
                </span>
              ) : (
                <Row columns="1fr" last={index === 2}>
                  <span>{`row ${index}`}</span>
                </Row>
              ),
          }}
        />,
      )
      const wrapperFor = (index: number): Element | null | undefined =>
        document.querySelector(`[data-index="${String(index)}"]`)
      // Row 0's OWN wrapper sits at the top (its start is 0 regardless of its size).
      expect((wrapperFor(0) as HTMLElement | null)?.style.transform).toBe('translateY(0px)')
      // Row 1 starts where row 0's MEASURED size (120) ends -- not the 40px estimate every row
      // would have used before `measureElement` ran.
      expect((wrapperFor(1) as HTMLElement | null)?.style.transform).toBe('translateY(120px)')
    } finally {
      if (width !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
      if (height !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
    }
  })

  // M61 Task 10 review, fix round 1 (Important 1): `virtualized.gap` is `useVirtualizer`'s own
  // `gap` option, passed straight through -- it belongs in every item's `start`, not hand-rolled
  // into `rowHeight` (which would also inflate `getTotalSize()` by one extra gap's worth).
  it('gap adds space between virtualized rows, on top of rowHeight', () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 })
    try {
      render(
        <DataTable
          columns="1fr"
          header={['Name']}
          virtualized={{
            rowHeight: 40,
            count: 3,
            gap: 10,
            render: (index) => (
              <Row columns="1fr" last={index === 2}>
                <span>{`row ${index}`}</span>
              </Row>
            ),
          }}
        />,
      )
      const second = document.querySelector('[data-index="1"]') as HTMLElement | null
      // 40 (row 0's height) + 10 (the gap) = 50, not the bare 40 `rowHeight` would give alone.
      expect(second?.style.transform).toBe('translateY(50px)')
    } finally {
      if (width !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width)
      if (height !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
    }
  })

  // M61 Task 10 review, controller Ruling 11: `hideHeader` omits the row entirely -- not an
  // empty one -- for a caller whose grid template has no column HEADINGS in the design
  // (`KnowledgeClient`'s classification/substance/actions rail).
  it('hideHeader renders no header row at all', () => {
    render(
      <DataTable columns="1fr" header={['Name']} hideHeader>
        <Row columns="1fr">
          <span>only</span>
        </Row>
      </DataTable>,
    )
    expect(screen.queryByTestId('data-table-header')).toBeNull()
    expect(screen.queryAllByTestId('data-table-header-cell')).toHaveLength(0)
    // The bordered shell around the body is unaffected.
    expect(screen.getByTestId('data-table').className).toContain('rounded-control')
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

  // M44 R5: a chip that says a projected word has to be able to say what it was projected FROM.
  // `title=""` would be worse than nothing -- an empty tooltip on every untitled chip in the app --
  // so the attribute is spread conditionally and its ABSENCE is what is pinned here.
  it('carries a raw value in title when given one, and no title attribute at all when not', () => {
    render(<><Chip title="finished">Finished</Chip><Chip>SIMULATION</Chip></>)
    const [titled, plain] = screen.getAllByTestId('chip')
    expect(titled?.getAttribute('title')).toBe('finished')
    expect(plain?.hasAttribute('title')).toBe(false)
  })

  // M61 R16: the tone reads off a `LiveDot`, not a tinted fill -- `TONE_FILL` is gone from this
  // component entirely, tone or no tone.
  it('renders a LiveDot for a toned chip, and no bg-tone-* fill class either way', () => {
    render(<Chip tone="blocked">backend</Chip>)
    const chip = screen.getByTestId('chip')
    const dot = screen.getByTestId('live-dot')
    expect(dot.getAttribute('data-tone')).toBe('blocked')
    expect(chip.className).not.toMatch(/bg-tone-/)
  })

  it('renders no dot at all for an untoned chip', () => {
    render(<Chip>plain</Chip>)
    expect(screen.queryByTestId('live-dot')).toBeNull()
  })

  it('is a pill, not the old 5px chip radius', () => {
    render(<Chip>plain</Chip>)
    expect(screen.getByTestId('chip').className).toContain('rounded-pill')
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

  // M61 R16: danger keeps riding the `blocked` tone's alpha fill; primary moves OFF the tone
  // system entirely and onto the accent surface (the handoff's "go" colour is now `--accent`, not
  // a tone).
  it('paints danger on the blocked tone at the handoff alphas, and primary on the accent surface', () => {
    render(<><Button variant="danger">x</Button><Button variant="primary">y</Button></>)
    const [danger, primary] = screen.getAllByTestId('button')
    expect(danger?.className).toContain('bg-tone-blocked/10')
    expect(danger?.className).toContain('border-tone-blocked/24')
    expect(primary?.className).toContain('bg-accent')
    expect(primary?.className).toContain('text-accent-ink')
    expect(primary?.className).not.toContain('bg-tone-working')
  })

  it('scales down on press -- active:scale-[0.97], on every variant', () => {
    render(<Button variant="ghost">press</Button>)
    expect(screen.getByTestId('button').className).toContain('active:scale-[0.97]')
  })

  // Review fix round 1, Important: `transition-colors` and `transition-transform` stacked on one
  // element both set the `transition-property` LONGHAND, so whichever Tailwind emits second wins
  // outright and the other's properties stop transitioning at all -- not a partial-coverage bug, a
  // silent all-or-nothing one. One arbitrary-value utility naming every property sidesteps it.
  it('names every transitioned property in one utility, not two that fight over transition-property', () => {
    render(<Button variant="ghost">press</Button>)
    const className = screen.getByTestId('button').className
    expect(className).toContain('transition-[color,background-color,border-color,transform]')
    expect(className).not.toContain('transition-colors')
    expect(className).not.toContain('transition-transform')
  })

  it('lets a caller name its own testid without losing the variant attribute', () => {
    render(<Button variant="ghost" data-testid="my-button">x</Button>)
    expect(screen.getByTestId('my-button').getAttribute('data-variant')).toBe('ghost')
  })

  // Carried over from `form-controls.test.tsx` when M44 Task 4 deleted `GhostButton`/
  // `PrimaryButton`, whose own cases pinned these two. Both are real regression guards, not
  // restatements: M16's final review I1 found `hover:text-text-0` naming a token Tailwind v4 never
  // generates (there is no `--text-0` in `globals.css`), so the ghost hover brighten was DEAD --
  // only the border moved. And the 5px chip radius is the one geometry the two systems shared, so
  // it has to keep being asserted somewhere now that only one of them is left.
  it('brightens ghost text to a real token on hover, never to a nonexistent text-0', () => {
    render(<Button variant="ghost" size="sm" data-testid="gb-hover">cancel</Button>)
    const button = screen.getByTestId('gb-hover')
    expect(button.className).toContain('hover:text-text-1')
    expect(button.className).not.toContain('text-text-0')
  })

  // M61 R16: same radius, new name -- `rounded-chip` was always an alias of `--radius-control`.
  it('carries the control radius on every variant, and passes disabled through', () => {
    render(<><Button variant="ghost" size="sm" data-testid="gb" disabled>cancel</Button><Button variant="danger" size="sm" data-testid="db">stop</Button></>)
    const ghost = screen.getByTestId('gb') as HTMLButtonElement
    expect(ghost.className).toContain('rounded-control')
    expect(ghost.disabled).toBe(true)
    expect(screen.getByTestId('db').className).toContain('rounded-control')
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

  // Fix round 1: the fourth variant is the one that is NOT an alert. `role="alert"` is assertive --
  // a reader interrupts itself for it -- and standing provenance ("adopted from a simulation") is
  // not something to interrupt anybody for, nor to paint in the amber the three real warnings use.
  it('Alert info is a polite status on a neutral surface, not an alert in amber', () => {
    render(<Alert variant="info" testId="provenance">adopted from a simulation</Alert>)
    const band = screen.getByTestId('provenance')
    expect(band.getAttribute('role')).toBe('status')
    expect(band.getAttribute('data-variant')).toBe('info')
    expect(band.className).toContain('border-line')
    expect(band.className).toContain('bg-bg-1')
    expect(band.className).toContain('text-text-3')
    // Not a tone: none of the three warning surfaces leaked into it.
    expect(band.className).not.toContain('tone-waiting')
    expect(band.className).not.toContain('tone-blocked')
    expect(band.className).not.toContain('tone-done')
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

  it('LoadingState says what is loading when the caller has something better than the default', () => {
    render(<LoadingState testId="loading" message="fetching the run history…" />)
    expect(screen.getByTestId('loading').textContent).toBe('fetching the run history…')
  })

  it('Alert paints each variant on its own tone, not one shared surface', () => {
    render(
      <>
        <Alert variant="error" testId="a-error">no</Alert>
        <Alert variant="notice" testId="a-notice">hm</Alert>
        <Alert variant="success" testId="a-success">yes</Alert>
      </>,
    )
    expect(screen.getByTestId('a-error').className).toContain('tone-blocked')
    expect(screen.getByTestId('a-notice').className).toContain('tone-waiting')
    expect(screen.getByTestId('a-success').className).toContain('tone-done')
    const classNames = ['a-error', 'a-notice', 'a-success'].map((id) => screen.getByTestId(id).className)
    expect(new Set(classNames).size).toBe(3)
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

  it('takes a caller testId, for a page that nests one shell inside another', () => {
    render(<PageShell testId="advanced-shell"><p>only</p></PageShell>)
    expect(screen.getByTestId('advanced-shell')).toBeTruthy()
    expect(screen.queryByTestId('page-shell')).toBeNull()
  })

  // M45 erratum E18: the five `/w/:id/*` pages carry the design handoff's own `px-[20px]
  // pt-[16px]` gutters, and four of them are screenshotted by `gate:m14-fidelity`. `flush` is how
  // they take the shell's landmark and its marker without moving a pixel.
  it('flush drops the frame padding so a page that owns its own gutters is not moved', () => {
    const { getByTestId, rerender } = render(<PageShell><span>x</span></PageShell>)
    expect(getByTestId('page-shell').className).toContain('p-3')
    rerender(<PageShell flush><span>x</span></PageShell>)
    expect(getByTestId('page-shell').className).not.toContain('p-3')
    expect(getByTestId('page-shell').className).not.toContain('gap-4')
  })
})

// M45 R4: the one disclosure both detail panels are built out of. Children render ONLY while the
// group is open, and that is the contract rather than a nicety -- three of the ten groups fetch on
// mount, and a panel that rendered ten collapsed groups would issue every one of those requests to
// show a person nothing.
describe('DetailsGroup', () => {
  it('is closed by default and names itself for a test and a gate', () => {
    render(
      <DetailsGroup group="run" title="Run">
        <span data-testid="inside">x</span>
      </DetailsGroup>,
    )
    const group = screen.getByTestId('details-group')
    expect(group.getAttribute('data-group')).toBe('run')
    expect(group.getAttribute('data-open')).toBe('false')
    expect(screen.queryByTestId('inside')).toBeNull()
  })

  it('renders its children only once opened, so a closed group costs nothing', () => {
    render(
      <DetailsGroup group="cost" title="Cost">
        <span data-testid="inside">x</span>
      </DetailsGroup>,
    )
    fireEvent.click(screen.getByText('Cost'))
    expect(screen.getByTestId('inside')).toBeTruthy()
    expect(screen.getByTestId('details-group').getAttribute('data-open')).toBe('true')
  })

  it('can start open, for the one group a panel leads with', () => {
    render(
      <DetailsGroup group="run" title="Run" defaultOpen>
        <span data-testid="inside">x</span>
      </DetailsGroup>,
    )
    expect(screen.getByTestId('inside')).toBeTruthy()
  })

  // A native `<details>` renders its subtree regardless of `open`, which is exactly what this
  // primitive exists not to do -- so it is a button and a region, and it owes a screen reader the
  // state a `<summary>` would have given for free.
  it('is a real disclosure button: keyboard-reachable, with aria-expanded tracking the state', () => {
    render(
      <DetailsGroup group="events" title="Events">
        <span data-testid="inside">x</span>
      </DetailsGroup>,
    )
    const toggle = screen.getByRole('button', { name: 'Events' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('type')).toBe('button')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // The region the button controls exists once open, and says which button names it.
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(region).not.toBeNull()
    expect(region?.getAttribute('aria-labelledby')).toBe(toggle.id)
  })

  it('closes again on a second press, dropping its children back out of the DOM', () => {
    render(
      <DetailsGroup group="skills" title="Skills">
        <span data-testid="inside">x</span>
      </DetailsGroup>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.getByTestId('inside')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
    expect(screen.queryByTestId('inside')).toBeNull()
  })
})
