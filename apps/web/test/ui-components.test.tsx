// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../src/components/ui/Button.js'
import { Card } from '../src/components/ui/Card.js'
import { Chip } from '../src/components/ui/Chip.js'
import { DataTable, Row } from '../src/components/ui/DataTable.js'
import { EmptyTile } from '../src/components/ui/EmptyTile.js'
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
    expect(screen.getByTestId('panel-title').textContent).toBe('Roster')
    expect(screen.getByText('panel body')).toBeTruthy()
  })

  it('renders children with no title given', () => {
    render(
      <Panel>
        <p>bare body</p>
      </Panel>,
    )
    expect(screen.queryByTestId('panel-title')).toBeNull()
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

describe('StatStrip', () => {
  it('renders n items', () => {
    render(
      <StatStrip
        items={[
          { label: 'agents', value: '6' },
          { label: 'active', value: '3', tone: 'working' },
          { label: 'blocked', value: '1', tone: 'blocked' },
        ]}
      />,
    )
    const items = screen.getAllByTestId('stat-strip-item')
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain('agents')
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

  it('clamps above 100 down to 100', () => {
    render(<ProgressBar pct={150} />)
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('100%')
  })

  it('clamps below 0 up to 0', () => {
    render(<ProgressBar pct={-10} />)
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('0%')
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
