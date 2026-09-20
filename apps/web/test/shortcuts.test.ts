import { describe, expect, it } from 'vitest'
import { isModKey, matchesShortcut } from '../src/lib/shortcuts.js'
import { MODE_STORAGE_KEY, MODES, isMode } from '../src/lib/modeStorage.js'

const ev = (over: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ key: 'd', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over }) as KeyboardEvent

describe('modeStorage', () => {
  it('pins the key the boot script interpolates', () => expect(MODE_STORAGE_KEY).toBe('mode'))
  it('has exactly two modes, simple first', () => expect(MODES).toEqual(['simple', 'developer']))
  it('rejects anything else', () => {
    expect(isMode('developer')).toBe(true)
    expect(isMode('dark')).toBe(false)
    expect(isMode(null)).toBe(false)
  })
})

describe('shortcuts', () => {
  it('treats meta OR ctrl as the modifier, never alt', () => {
    expect(isModKey(ev({ metaKey: true }))).toBe(true)
    expect(isModKey(ev({ ctrlKey: true }))).toBe(true)
    expect(isModKey(ev({ altKey: true }))).toBe(false)
  })
  it('matches Mod+Shift+D case-insensitively and refuses without shift', () => {
    expect(matchesShortcut(ev({ metaKey: true, shiftKey: true, key: 'D' }), { key: 'd', shift: true })).toBe(true)
    expect(matchesShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'd' }), { key: 'd', shift: true })).toBe(true)
    expect(matchesShortcut(ev({ metaKey: true, key: 'd' }), { key: 'd', shift: true })).toBe(false)
  })
  it('matches Mod+J with no shift', () => {
    expect(matchesShortcut(ev({ metaKey: true, key: 'j' }), { key: 'j' })).toBe(true)
    expect(matchesShortcut(ev({ metaKey: true, shiftKey: true, key: 'j' }), { key: 'j' })).toBe(false)
  })
})
