import { describe, expect, it } from 'vitest'
import {
  RAIL,
  TABS,
  VIEWS,
  breadcrumbOf,
  isGlobalRoute,
  railFor,
  railIdOf,
  sectionOf,
  tabsFor,
  workspaceIdOf,
} from '../src/lib/routes.js'

describe('TABS', () => {
  it('is the six tabs, team first, keyed by route segment', () => {
    expect(TABS.map((t) => t.id)).toEqual(['team', 'tasks', 'office', 'activity', 'graph', 'knowledge'])
  })

  it('shows four in simple mode and six in developer mode', () => {
    expect(tabsFor('simple').map((t) => t.id)).toEqual(['team', 'tasks', 'office', 'activity'])
    expect(tabsFor('developer').map((t) => t.id)).toEqual([
      'team', 'tasks', 'office', 'activity', 'graph', 'knowledge',
    ])
  })

  it('points Team at the bare project route and Work at /tasks', () => {
    expect(TABS[0]?.href('w1', 'simple')).toBe('/w/w1')
    expect(TABS.find((t) => t.id === 'tasks')?.label).toBe('Work')
  })

  it("gives Activity the digest in simple mode and the river in developer mode (R10)", () => {
    const activity = TABS.find((t) => t.id === 'activity')
    expect(activity?.href('w1', 'simple')).toBe('/w/w1/activity?view=digest')
    expect(activity?.href('w1', 'developer')).toBe('/w/w1/activity')
  })
})

describe('RAIL', () => {
  it('is Home, People, Settings for everybody and Simulations, Analytics for developers', () => {
    expect(railFor('simple').map((r) => r.id)).toEqual(['home', 'people', 'settings'])
    expect(railFor('developer').map((r) => r.id)).toEqual([
      'home', 'people', 'settings', 'simulations', 'analytics',
    ])
    expect(RAIL.find((r) => r.id === 'people')?.href).toBe('/workforce')
  })

  it('answers which rail item a global path lights', () => {
    expect(railIdOf('/')).toBe('home')
    expect(railIdOf('/workforce?tab=catalog')).toBe('people')
    expect(railIdOf('/sim/abc')).toBe('simulations')
    expect(railIdOf('/w/w1')).toBe(null)
  })
})

describe('sectionOf', () => {
  it('answers team for the project root AND for /organization (the redirect target, R7)', () => {
    expect(sectionOf('/w/w1')).toBe('team')
    expect(sectionOf('/w/w1/organization')).toBe('team')
    expect(sectionOf('/w/w1/tasks')).toBe('tasks')
    expect(sectionOf('/w/w1/graph')).toBe('graph')
    expect(sectionOf('/w/w1/settings')).toBe('settings')
    expect(sectionOf('/workforce')).toBe(null)
  })

  it('answers a deeper path by its first segment, so a sub-route still lights its row', () => {
    expect(sectionOf('/w/w1/tasks/anything')).toBe('tasks')
  })

  it('answers null for every global route', () => {
    expect(sectionOf('/')).toBeNull()
    expect(sectionOf('/workforce')).toBeNull()
    expect(sectionOf('/analytics')).toBeNull()
  })

  it('tolerates a trailing slash', () => {
    expect(sectionOf('/w/w1/')).toBe('team')
    expect(sectionOf('/w/w1/tasks/')).toBe('tasks')
  })
})

describe('VIEWS', () => {
  it('is analytics alone now that graph and office are tabs', () => {
    expect(VIEWS.map((v) => v.id)).toEqual(['analytics'])
  })
})

describe('workspaceIdOf', () => {
  it('lifts the id out of any /w/:id route and answers null elsewhere', () => {
    expect(workspaceIdOf('/w/abc123')).toBe('abc123')
    expect(workspaceIdOf('/w/abc123/tasks')).toBe('abc123')
    expect(workspaceIdOf('/w/abc123/graph')).toBe('abc123')
    expect(workspaceIdOf('/')).toBeNull()
    expect(workspaceIdOf('/workforce')).toBeNull()
    expect(workspaceIdOf('/w')).toBeNull()
    expect(workspaceIdOf('/w/')).toBeNull()
  })
})

describe('isGlobalRoute', () => {
  it('is true for everything outside /w/:id -- the routes with no right panel (R8)', () => {
    for (const path of ['/', '/workforce', '/settings', '/sim', '/sim/s1', '/sim/compare', '/analytics', '/login']) {
      expect(isGlobalRoute(path), path).toBe(true)
    }
  })

  it('is false inside a project, including its former views', () => {
    for (const path of ['/w/w1', '/w/w1/tasks', '/w/w1/graph', '/w/w1/office']) {
      expect(isGlobalRoute(path), path).toBe(false)
    }
  })
})

describe('breadcrumbOf', () => {
  it('reads Projects / <project> / <tab>, with only the last one emphasised', () => {
    expect(breadcrumbOf('/w/w1/tasks', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: false },
      { text: 'Work', last: true },
    ])
  })

  it('ends at the project on Team -- Team is the project, not a place inside it', () => {
    expect(breadcrumbOf('/w/w1', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: true },
    ])
  })

  it('ends at the project on /organization too -- the redirect target reads the same as the bare route', () => {
    expect(breadcrumbOf('/w/w1/organization', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: true },
    ])
  })

  it('names a TAB where the section would be', () => {
    expect(breadcrumbOf('/w/w1/graph', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: false },
      { text: 'Graph', last: true },
    ])
  })

  it('says the project id when the name has not arrived yet, never an empty crumb', () => {
    expect(breadcrumbOf('/w/w1/tasks', null)).toEqual([
      { text: 'Projects', last: false },
      { text: 'w1', last: false },
      { text: 'Work', last: true },
    ])
  })

  it('is one crumb on every global route', () => {
    expect(breadcrumbOf('/', null)).toEqual([{ text: 'Projects', last: true }])
    expect(breadcrumbOf('/workforce', null)).toEqual([{ text: 'Workforce', last: true }])
    expect(breadcrumbOf('/sim/s1', null)).toEqual([{ text: 'Simulations', last: true }])
    expect(breadcrumbOf('/settings', null)).toEqual([{ text: 'Settings', last: true }])
    expect(breadcrumbOf('/analytics', null)).toEqual([{ text: 'Analytics', last: true }])
  })
})
