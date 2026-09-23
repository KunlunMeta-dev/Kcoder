import { afterEach, describe, expect, test, vi } from 'vitest'
import { gatewayVerificationConfig } from './gateway-verification'

afterEach(() => {
  delete window.__KCODER_AI_VERIFY__
  vi.unstubAllGlobals()
})

describe('session-scoped Gateway automation', () => {
  test('normal renderer has no injected verification mode', () => {
    expect(gatewayVerificationConfig()).toBeNull()
  })

  test('accepts only the current exact loopback session and separate controller', () => {
    vi.stubGlobal('location', new URL('http://127.0.0.1:43210/settings'))
    const config = {
      origin: 'http://127.0.0.1:43210',
      controlUrl: 'http://127.0.0.1:43211',
      token: 'a'.repeat(64),
    }
    window.__KCODER_AI_VERIFY__ = config
    expect(gatewayVerificationConfig()).toEqual(config)
    for (const patch of [
      { origin: 'http://127.0.0.1:43212' },
      { origin: 'https://example.com' },
      { controlUrl: config.origin },
      { controlUrl: 'https://example.com' },
      { token: '' },
    ]) {
      window.__KCODER_AI_VERIFY__ = { ...config, ...patch }
      expect(gatewayVerificationConfig()).toBeNull()
    }
  })
})
