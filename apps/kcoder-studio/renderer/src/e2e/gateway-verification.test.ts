import { afterEach, describe, expect, test, vi } from 'vitest'
import { gatewayVerificationConfig } from './gateway-verification'
import { installStudioAutomationBridge } from './automation'
import { registerRuntimeTransport } from '@/lib/runtime-transport'

afterEach(() => {
  delete window.__KCODER_AI_VERIFY__
  delete window.__KCODER_STUDIO_E2E__
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
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

test('only explicit E2E mode exposes command routing through the actual registered transport', async () => {
  vi.stubEnv('MODE', 'production')
  vi.stubEnv('VITE_KCODER_STUDIO_E2E', 'false')
  installStudioAutomationBridge()
  expect(window.__KCODER_STUDIO_E2E__).toBeUndefined()

  vi.stubEnv('MODE', 'e2e')
  installStudioAutomationBridge()
  const handler = vi.fn(() => ({ ready: true }))
  const cleanup = registerRuntimeTransport(handler)
  try {
    await expect(window.__KCODER_STUDIO_E2E__!.invokeRuntimeCommand('local_executor_status')).resolves.toEqual({ ready: true })
    expect(handler).toHaveBeenCalledWith('local_executor_status', undefined)
  } finally { cleanup() }
  await expect(window.__KCODER_STUDIO_E2E__!.invokeRuntimeCommand('local_executor_status')).rejects.toThrow('Gateway service transport is unavailable')
})
