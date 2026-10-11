import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('design-token height overrides', () => {
  it.each(['sm', 'md', 'lg', 'xl'])('lets a caller override control-%s height', size => {
    expect(cn(`h-control-${size}`, 'h-7')).toBe('h-7')
    expect(cn('h-7', `h-control-${size}`)).toBe(`h-control-${size}`)
    expect(cn(`h-control-${size}`, 'h-[30px]')).toBe('h-[30px]')
  })

  it('retains independent responsive and state heights', () => {
    expect(cn('h-control-lg md:h-control-xl', 'h-7 md:h-8')).toBe('h-7 md:h-8')
    expect(cn('h-control-lg hover:h-7')).toBe('h-control-lg hover:h-7')
  })
})
