import { describe, expect, it } from 'vitest'
import { formatMinor } from '../src/lib/money.js'
describe('formatMinor', () => {
  it('renders integer minor units as currency, negative included', () => {
    expect(formatMinor(123456, 'USD')).toBe('$1,234.56')
    expect(formatMinor(0, 'USD')).toBe('$0.00')
    expect(formatMinor(-5, 'USD')).toBe('-$0.05')
  })
})
