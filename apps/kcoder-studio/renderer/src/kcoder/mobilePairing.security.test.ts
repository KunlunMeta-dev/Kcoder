import { afterEach, describe, expect, test, vi } from 'vitest'
import { activateGatewayRelay, isProtectedRelayLoginLocation, switchGatewayRelay } from './mobilePairing'

describe('Relay sign-in transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  test.each([
    { protocol: 'http:', hostname: '192.168.1.20' },
    { protocol: 'http:', hostname: 'studio.example' },
  ])('blocks sign-in before sending data from an insecure browser origin', location => {
    const fetchMock = vi.fn()
    vi.stubGlobal('window', { location })
    vi.stubGlobal('fetch', fetchMock)
    const error = { code: 'RELAY_LOGIN_REQUIRES_SECURE_ORIGIN' }

    expect(() => activateGatewayRelay({ relayUrl: 'https://relay.example', accountCredentials: {
      username: 'fixture.user', password: 'fixture-password-value',
    } })).toThrowError(expect.objectContaining(error))
    expect(() => switchGatewayRelay({ requestId: 'request', expectedRevision: 0, relayUrl: 'https://relay.example',
      activationLink: 'a'.repeat(43) })).toThrowError(expect.objectContaining(error))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('allows HTTPS and actual loopback HTTP for the sign-in client', () => {
    expect(isProtectedRelayLoginLocation({ protocol: 'https:', hostname: 'studio.example' })).toBe(true)
    expect(isProtectedRelayLoginLocation({ protocol: 'http:', hostname: 'localhost' })).toBe(true)
    expect(isProtectedRelayLoginLocation({ protocol: 'http:', hostname: '127.0.0.7' })).toBe(true)
    expect(isProtectedRelayLoginLocation({ protocol: 'http:', hostname: '192.168.1.20' })).toBe(false)
  })
})
