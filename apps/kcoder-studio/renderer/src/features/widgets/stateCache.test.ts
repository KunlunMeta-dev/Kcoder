import { describe, expect, it } from 'vitest'
import { WidgetStateCache } from './stateCache'

describe('bounded optional widget UI state', () => {
  it('deduplicates keys and evicts the least recently used old panel', () => {
    const cache = new WidgetStateCache({ maxEntries: 2 })
    cache.set('old-panel:a', { value: 1 }); cache.set('panel:b', { value: 2 })
    cache.get('old-panel:a'); cache.set('panel:c', { value: 3 })
    expect(cache.get('panel:b')).toBeUndefined()
    expect(cache.get('old-panel:a')).toEqual({ value: 1 })
    const bytes = cache.encodedBytes
    cache.set('old-panel:a', { value: 1 })
    expect(cache.size).toBe(2); expect(cache.encodedBytes).toBe(bytes)
  })

  it('enforces total encoded bytes including Unicode keys and rejects oversized entries', () => {
    const cache = new WidgetStateCache({ maxBytes: 40 })
    cache.set('甲', { text: 'first' }); cache.set('乙', { text: 'second' }); cache.set('丙', { text: 'third' })
    expect(cache.encodedBytes).toBeLessThanOrEqual(40)
    expect(cache.get('甲')).toBeUndefined()
    expect(cache.set('huge', { text: 'x'.repeat(16 * 1024) })).toBe(false)
    expect(cache.set('x'.repeat(4097), {})).toBe(false)
    expect(cache.encodedBytes).toBeLessThanOrEqual(40)
  })

  it('expires old mounts without mutating mounted values or external callback objects', () => {
    let now = 0
    const cache = new WidgetStateCache({ idleMs: 100, now: () => now })
    const supplied = { years: 7 }
    cache.set('panel:old', supplied)
    const mounted = cache.get('panel:old') as { years: number }
    supplied.years = 99; mounted.years = 8
    expect(cache.get('panel:old')).toEqual({ years: 7 })
    now = 101
    expect(cache.get('panel:old')).toBeUndefined()
    expect(cache.size).toBe(0); expect(cache.encodedBytes).toBe(0)
    expect(mounted.years).toBe(8)
  })
})
