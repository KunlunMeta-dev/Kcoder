import { describe, expect, test, vi } from 'vitest'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('temporary thread disposal', RuntimeClass => {
  test('retains ownership on failure and completes active waiters before removing the task', async () => {
    const client = new FakeGatewayClient(null)
    const request = vi
      .spyOn(client, 'request')
      .mockRejectedValueOnce(new Error('fixture disconnect'))
      .mockResolvedValue({ disposed: true })
    const close = vi.spyOn(client, 'close')
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()],
      createClient: () => client,
    })
    const internals = runtime as unknown as {
      tasks: Map<string, unknown>
      clientByTask: Map<string, unknown>
      activeTurnByTask: Map<string, unknown>
      disposeTemporaryTask(params: Record<string, unknown>): Promise<unknown>
    }
    const complete = vi.fn(() => expect(internals.tasks.has('temporary')).toBe(true))
    internals.tasks.set('temporary', { ephemeral: true, serverId: 'local', threadId: 'child' })
    internals.clientByTask.set('temporary', client)
    internals.activeTurnByTask.set('temporary', { complete })
    try {
      await expect(internals.disposeTemporaryTask({ taskId: 'temporary' })).rejects.toThrow(
        'fixture disconnect'
      )
      expect(internals.tasks.has('temporary')).toBe(true)
      expect(internals.clientByTask.has('temporary')).toBe(true)
      expect(close).not.toHaveBeenCalled()
      await expect(internals.disposeTemporaryTask({ taskId: 'temporary' })).resolves.toEqual({
        disposed: true,
      })
      expect(request).toHaveBeenLastCalledWith('thread/dispose', { threadId: 'child' })
      expect(complete).toHaveBeenCalledOnce()
      expect(internals.tasks.has('temporary')).toBe(false)
      expect(close).toHaveBeenCalledOnce()
    } finally {
      runtime.dispose()
    }
  })
})
