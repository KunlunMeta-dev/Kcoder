import { describe, expect, test, vi } from 'vitest'
import { GatewayRpcError } from './gatewayRpc'
import { startThreadWithReceipt, ThreadCreationUnknownError } from './gatewayThreadReceipt'
import type { GatewayClient } from './gatewayRuntimeTypes'

function client(request: ReturnType<typeof vi.fn>) {
  return { request, close: vi.fn(), supportsExperimental: () => true } as unknown as GatewayClient
}
describe('thread creation acceptance recovery', () => {
  test('looks up then resumes the original creation without a second start', async () => {
    const first = client(vi.fn().mockRejectedValue(new GatewayRpcError('lost', -1)))
    const request = vi.fn().mockResolvedValueOnce({ receipt: {
      threadId: 'created-thread', status: 'ready', thread: { id: 'created-thread' },
    } }).mockResolvedValueOnce({ thread: { id: 'created-thread' } })
    const recovered = client(request)
    const result = await startThreadWithReceipt(first, { clientRequestId: 'create-once' }, async () => recovered)
    expect(result.client).toBe(recovered)
    expect(request.mock.calls).toEqual([
      ['thread/creation/read', { clientRequestId: 'create-once' }],
      ['thread/resume', { threadId: 'created-thread' }],
    ])
    expect(first.request).toHaveBeenCalledTimes(1)
  })
  test.each([null, { threadId: 'a', status: 'unknown' }, {
    threadId: 'a', status: 'ready', thread: { id: 'b' },
  }])('keeps uncertain creation without resending or leaking its connection', async receipt => {
    const first = client(vi.fn().mockRejectedValue(new GatewayRpcError('lost', -1)))
    const request = vi.fn().mockResolvedValue({ receipt })
    const recovered = client(request)
    await expect(startThreadWithReceipt(first, { clientRequestId: 'id' }, async () => recovered))
      .rejects.toBeInstanceOf(ThreadCreationUnknownError)
    expect(request).toHaveBeenCalledTimes(1)
    expect(recovered.close).toHaveBeenCalledTimes(1)
    expect(first.request).toHaveBeenCalledTimes(1)
  })
  test('remote refusal never becomes a creation lookup', async () => {
    const refused = new GatewayRpcError('refused', -32602, undefined, undefined, 'remote')
    const recover = vi.fn()
    await expect(startThreadWithReceipt(client(vi.fn().mockRejectedValue(refused)), {}, recover)).rejects.toBe(refused)
    expect(recover).not.toHaveBeenCalled()
  })
})
