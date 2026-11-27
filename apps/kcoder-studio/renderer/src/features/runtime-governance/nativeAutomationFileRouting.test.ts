import { expect, test, vi } from 'vitest'
import { executeDeviceCommand } from '@/kcoder/gateway/runtime/resources'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import type { GatewayServer } from '@/kcoder/gatewayRpc'
const server = { id: 'current-target' } as GatewayServer
function runtime(reject = false) {
  const request = reject
    ? vi.fn().mockRejectedValue(new Error('native containment denied'))
    : vi.fn().mockResolvedValue({ success: true })
  const commandClient = vi.fn().mockResolvedValue({ request, supportsExperimental: () => true })
  return {
    core: {
      commandClient,
      compatibility: { fileWorkspace: (params: Record<string, unknown>) => params.path },
    } as unknown as GatewayRuntimeCore,
    commandClient,
    request,
  }
}
test('workspace tree keeps the actual root command client and strips routing-only workspacePath', async () => {
  const fixture = runtime()
  await executeDeviceCommand.call(
    fixture.core,
    { command_key: 'workspace_tree', workspacePath: '/workspace', path: '/workspace/child' },
    server
  )
  expect(fixture.commandClient).toHaveBeenCalledExactlyOnceWith(server, '/workspace')
  expect(fixture.request).toHaveBeenCalledExactlyOnceWith('device/execute', {
    command_key: 'workspace_tree',
    path: '/workspace/child',
  })
})
test('old tree consumers retain the existing compatibility path without a root override', async () => {
  const fixture = runtime()
  await executeDeviceCommand.call(
    fixture.core,
    { command_key: 'workspace_tree', path: '/old-workspace' },
    server
  )
  expect(fixture.commandClient).toHaveBeenCalledExactlyOnceWith(server, '/old-workspace')
})
test('native containment failure never retries on a child directory client', async () => {
  const fixture = runtime(true)
  await expect(
    executeDeviceCommand.call(
      fixture.core,
      { command_key: 'workspace_tree', workspacePath: '/workspace', path: '/outside' },
      server
    )
  ).rejects.toThrow('native containment denied')
  expect(fixture.commandClient).toHaveBeenCalledExactlyOnceWith(server, '/workspace')
  expect(fixture.request).toHaveBeenCalledTimes(1)
})
