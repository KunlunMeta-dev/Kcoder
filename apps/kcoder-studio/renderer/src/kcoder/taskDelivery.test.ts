import { describe, expect, it, vi } from 'vitest'
import { registerGatewayCommandTransport } from './gatewayServiceBridge'
import { taskDeliveryApi } from './taskDelivery'

const owner = { taskId: 'view-task-a', threadId: 'view-thread-a', deviceId: 'target-1', scope: 'account/target/view-a' }

describe('delivery bridge preserves the original task address', () => {
  it('forwards only typed source selectors and keeps publication intent separate from normal task send', async () => {
    const handler = vi.fn(async () => ({ prepared: true }))
    const unregister = registerGatewayCommandTransport(handler)
    try {
      const api = taskDeliveryApi(owner)
      await api.prepare('release/base', 'comparison-1')
      expect(handler).toHaveBeenLastCalledWith('local_executor_request', { method: 'runtime.taskDelivery.request', params: { method: 'task/delivery/prepare', deviceId: owner.deviceId,
        taskId: owner.taskId, threadId: owner.threadId, baseBranch: 'release/base', comparisonId: 'comparison-1',
      } })
      await api.request('delivery-1', 'request-1', 'Edited title', 'Edited body')
      expect(handler).toHaveBeenLastCalledWith('local_executor_request', { method: 'runtime.taskDelivery.request', params: { method: 'task/delivery/request', deviceId: owner.deviceId,
        taskId: owner.taskId, threadId: owner.threadId, deliveryId: 'delivery-1', requestId: 'request-1',
        title: 'Edited title', body: 'Edited body',
      } })
      expect(handler.mock.calls.map(([command]) => command)).not.toContain('send_task')
      expect(JSON.stringify(handler.mock.calls)).not.toContain('workspace')
      expect(JSON.stringify(handler.mock.calls)).not.toContain('headCommit')
    } finally { unregister() }
  })

  it('reconciles the original request and requests exactly the selected failed check', async () => {
    const handler = vi.fn(async () => ({ recipient: { taskId: 'source-b', threadId: 'source-thread-b', deviceId: 'target-b' } }))
    const unregister = registerGatewayCommandTransport(handler)
    try {
      const api = taskDeliveryApi(owner)
      await api.read('original-delivery')
      expect(handler).toHaveBeenLastCalledWith('local_executor_request', { method: 'runtime.taskDelivery.request', params: { method: 'task/delivery/read', deviceId: owner.deviceId,
        taskId: owner.taskId, threadId: owner.threadId, deliveryId: 'original-delivery',
      } })
      const result = await api.failure('original-delivery', 'check:42')
      expect(handler).toHaveBeenLastCalledWith('local_executor_request', { method: 'runtime.taskDelivery.request', params: { method: 'task/delivery/failure', deviceId: owner.deviceId,
        taskId: owner.taskId, threadId: owner.threadId, deliveryId: 'original-delivery', checkId: 'check:42',
      } })
      expect(result.recipient.threadId).toBe('source-thread-b')
      expect(handler).toHaveBeenCalledTimes(2)
    } finally { unregister() }
  })
})
