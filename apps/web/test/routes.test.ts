import { describe, expect, it } from 'vitest'
import {
  SECTIONS,
  VIEWS,
  breadcrumbOf,
  isGlobalRoute,
  sectionOf,
  viewOf,
  workspaceIdOf,
} from '../src/lib/routes.js'

describe('SECTIONS', () => {
  it('is the six sections in the sidebar tree, in the README order, keyed by their ROUTE segment', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      'overview', 'tasks', 'organization', 'knowledge', 'activity', 'settings',
    ])
  })

  it('labels the organization route "Team" -- the label changes, the route does not (ia.md rule 2)', () => {
    expect(SECTIONS.find((s) => s.id === 'organization')?.label).toBe('Team')
    expect(SECTIONS.find((s) => s.id === 'organization')?.href('w1')).toBe('/w/w1/organization')
  })

  it('points Overview at the bare project route', () => {
    expect(SECTIONS.find((s) => s.id === 'overview')?.href('w1')).toBe('/w/w1')
  })
})

describe('VIEWS', () => {
  it('is Graph, Office and this project scoped Analytics -- what Advanced was (M44 R2)', () => {
    expect(VIEWS.map((v) => v.id)).toEqual(['graph', 'office', 'analytics'])
    expect(VIEWS.map((v) => v.label)).toEqual(['Graph', 'Office', 'Analytics'])
    expect(VIEWS.find((v) => v.id === 'graph')?.href('w1')).toBe('/w/w1/graph')
    expect(VIEWS.find((v) => v.id === 'office')?.href('w1')).toBe('/w/w1/office')
    expect(VIEWS.find((v) => v.id === 'analytics')?.href('w1')).toBe('/analytics?workspace=w1')
  })
})

describe('sectionOf', () => {
  it('answers the section a project route is on', () => {
    expect(sectionOf('/w/w1')).toBe('overview')
    expect(sectionOf('/w/w1/tasks')).toBe('tasks')
    expect(sectionOf('/w/w1/organization')).toBe('organization')
    expect(sectionOf('/w/w1/knowledge')).toBe('knowledge')
    expect(sectionOf('/w/w1/activity')).toBe('activity')
    expect(sectionOf('/w/w1/settings')).toBe('settings')
  })

  it('answers a deeper path by its first segment, so a sub-route still lights its row', () => {
    expect(sectionOf('/w/w1/tasks/anything')).toBe('tasks')
  })

  it('answers null for a VIEW and for every global route -- a view is not a section', () => {
    expect(sectionOf('/w/w1/graph')).toBeNull()
    expect(sectionOf('/w/w1/office')).toBeNull()
    expect(sectionOf('/')).toBeNull()
    expect(sectionOf('/workforce')).toBeNull()
    expect(sectionOf('/analytics')).toBeNull()
  })

  it('tolerates a trailing slash', () => {
    expect(sectionOf('/w/w1/')).toBe('overview')
    expect(sectionOf('/w/w1/tasks/')).toBe('tasks')
  })
})

describe('viewOf', () => {
  it('answers graph and office by path, and analytics only when it carries this project scope', () => {
    expect(viewOf('/w/w1/graph')).toBe('graph')
    expect(viewOf('/w/w1/office')).toBe('office')
    // `/analytics` has no `/w/:id` prefix, so `viewOf` cannot tell WHICH project it is scoped to;
    // the chip's own `aria-current` is driven by the search string, not by this function.
    expect(viewOf('/analytics')).toBeNull()
    expect(viewOf('/w/w1/tasks')).toBeNull()
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

  it('is false inside a project, including its views', () => {
    for (const path of ['/w/w1', '/w/w1/tasks', '/w/w1/graph', '/w/w1/office']) {
      expect(isGlobalRoute(path), path).toBe(false)
    }
  })
})

describe('breadcrumbOf', () => {
  it('reads Projects / <project> / <section>, with only the last one emphasised', () => {
    expect(breadcrumbOf('/w/w1/tasks', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: false },
      { text: 'Tasks', last: true },
    ])
  })

  it('ends at the project on its Overview -- Overview is the project, not a place inside it', () => {
    expect(breadcrumbOf('/w/w1', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: true },
    ])
  })

  it('names a VIEW where a section would be', () => {
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
      { text: 'Tasks', last: true },
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
