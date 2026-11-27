import { describe, expect, test } from 'vitest'
import { registerRuntimeTransport } from './runtime-transport'
import { isGatewayRuntime } from './runtime-environment'

describe('runtime environment', () => {
  test('requires an installed Gateway transport', () => {
    expect(isGatewayRuntime()).toBe(false)
    const cleanup = registerRuntimeTransport(() => null)
    try { expect(isGatewayRuntime()).toBe(true) }
    finally { cleanup() }
    expect(isGatewayRuntime()).toBe(false)
  })
})
