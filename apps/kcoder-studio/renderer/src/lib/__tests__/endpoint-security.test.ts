import { describe, expect, it } from 'vitest'

import { isPlaintextRemoteEndpoint } from '@/lib/endpoint-security'

describe('isPlaintextRemoteEndpoint', () => {
  it('exempts loopback, HTTPS and non-HTTP endpoints', () => {
    for (const endpoint of [
      'http://127.0.0.1:8000/v1',
      'http://localhost:11434/v1',
      'http://[::1]:8080/v1',
      'https://api.example.com/v1',
      '10.31.6.8',
      undefined,
    ]) {
      expect(isPlaintextRemoteEndpoint(endpoint)).toBe(false)
    }
  })

  it('flags plain HTTP outside loopback', () => {
    for (const endpoint of [
      'http://10.31.6.8/v1',
      'http://192.168.1.5:8080/v1',
      'http://gateway.internal:8080',
      ' http://example.com/v1 ',
    ]) {
      expect(isPlaintextRemoteEndpoint(endpoint)).toBe(true)
    }
  })
})
