import { installTestTransport, clearTestTransports } from '@/test/runtime-transport'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const isGatewayMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('@/lib/runtime-commands', () => ({
  invoke: invokeMock,
  isGateway: isGatewayMock,
}))

import { installFrontendRecoveryBridge } from './frontendRecovery'

describe('installFrontendRecoveryBridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isGatewayMock.mockReturnValue(false)
    delete window.__KCODER_STUDIO_NATIVE_RESUME_PROBE__
    clearTestTransports()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0)
      return 1
    })
  })

  test('does nothing outside the Gateway app', () => {
    installFrontendRecoveryBridge()

    expect(window.__KCODER_STUDIO_NATIVE_RESUME_PROBE__).toBeUndefined()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('acknowledges a native resume probe after WebView rendering advances', async () => {
    installTestTransport(() => null)
    isGatewayMock.mockReturnValue(true)
    invokeMock.mockResolvedValue(undefined)

    installFrontendRecoveryBridge()
    window.__KCODER_STUDIO_NATIVE_RESUME_PROBE__?.(42)

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'register_frontend_recovery_bridge')
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'acknowledge_frontend_resume_probe', {
      probeId: 42,
    })
  })
})
