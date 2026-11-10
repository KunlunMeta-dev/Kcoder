import { afterEach, describe, expect, test } from 'vitest'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { registerGatewayCommandTransport } from '@/kcoder/gatewayServiceBridge'
import { isExecutionDefaultsUnsupported, readExecutionDefaults } from './executionSettingsApi'

describe('execution defaults Gateway error bridge', () => {
  let unregister: (() => void) | undefined

  afterEach(() => {
    unregister?.()
    unregister = undefined
  })

  test('preserves GatewayRpcError.data through requestLocalExecutor for capability messaging', async () => {
    const marker = document.createElement('meta')
    marker.name = 'kcoder-rpc-token'
    marker.content = 'execution-bridge-test'
    document.head.append(marker)
    const error = new GatewayRpcError(
      'Target requires execution default settings support',
      -32000,
      {
        kind: 'execution_defaults_unsupported',
        capability: 'executionDefaultsV1',
      }
    )
    unregister = registerGatewayCommandTransport((command, args) => {
      expect(command).toBe('local_executor_request')
      expect(args).toMatchObject({
        method: 'runtime.settings.request',
        params: {
          serverId: 'target-a',
          method: 'settings/execution-defaults/read',
          params: {},
        },
      })
      throw error
    })

    try {
      const received = await readExecutionDefaults('target-a').catch(reason => reason)
      expect(received).toBe(error)
      expect((received as GatewayRpcError).data).toEqual({
        kind: 'execution_defaults_unsupported',
        capability: 'executionDefaultsV1',
      })
      expect(isExecutionDefaultsUnsupported(received)).toBe(true)
    } finally {
      marker.remove()
    }
  })
})
