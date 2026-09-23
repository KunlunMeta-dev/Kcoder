import { expect, test, vi } from 'vitest'
import { executionModeParams, turnModeParams } from './gatewayExecutionModes'
import { startTaskThread } from './gatewayTemporaryThread'
import type { GatewayClient } from './gatewayRuntimeTypes'

test('typed execution modes require explicit capability, without silent fallback', async () => {
  const request = vi.fn().mockResolvedValue({ thread: { id: 'created' } })
  const client = { request, supportsExperimental: () => false } as unknown as GatewayClient
  expect(turnModeParams({}, client)).toEqual({})
  for (const params of [
    { sessionMode: 'orchestrate' },
    { turnMode: 'moa' },
    { turnMode: 'moa-plan' },
  ]) {
    await expect(
      startTaskThread(client, { serverId: 'local', workspacePath: '/work', params })
    ).rejects.toThrow('升级')
  }
  expect(request).not.toHaveBeenCalled()
  client.supportsExperimental = () => true
  await startTaskThread(client, {
    serverId: 'local',
    workspacePath: '/work',
    params: { sessionMode: 'orchestrate', turnMode: 'moa' },
  })
  expect(request).toHaveBeenCalledWith('thread/start', { cwd: '/work', sessionMode: 'orchestrate' })
  expect(turnModeParams({ turnMode: 'moa-plan' }, client)).toEqual({ turnMode: 'moa-plan' })
  expect(() => executionModeParams({ sessionMode: 'moa' }, client)).toThrow('Invalid')
  expect(() => executionModeParams({ turnMode: ['moa'] }, client)).toThrow('Invalid')
})
