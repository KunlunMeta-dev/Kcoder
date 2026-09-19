import { describe, expect, test, vi } from 'vitest'
import { createRandomUuid } from './random-id'

describe('createRandomUuid', () => {
  test('uses the native browser implementation when available', () => {
    const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000001' as `${string}-${string}-${string}-${string}-${string}`)
    expect(
      createRandomUuid({ randomUUID, getRandomValues: vi.fn() as Crypto['getRandomValues'] })
    ).toBe('00000000-0000-4000-8000-000000000001')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  test('creates a UUID when randomUUID is unavailable in an insecure HTTP context', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0x11)
      return bytes
    }) as Crypto['getRandomValues']

    expect(createRandomUuid({ getRandomValues })).toBe('11111111-1111-4111-9111-111111111111')
  })
})
