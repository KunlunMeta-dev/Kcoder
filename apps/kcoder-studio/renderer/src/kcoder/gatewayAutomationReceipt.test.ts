import { expect, test, vi } from 'vitest'
import { createAutomationWithReceipt } from './gatewayAutomationReceipt'
import { GatewayRpcError } from './gatewayRpc'
import type { GatewayClient } from './gatewayRuntimeTypes'

const disconnected = () => new GatewayRpcError('connection lost', -1, undefined, 'runtime-session', 'connection')
const client = (request: ReturnType<typeof vi.fn>, supported = true) => ({
  request: (method: string, params: Record<string, unknown>) => params?.creationContext ? Promise.resolve({ epoch: 0 }) : request(method, params), supportsExperimental: () => supported,
}) as unknown as GatewayClient

test('lost creation replies are recovered with the original identity and never create twice', async () => {
  const request = vi.fn().mockRejectedValue(disconnected())
  const read = vi.fn().mockImplementation(async (_method, params) => ({
    clientRequestId: params.clientRequestId, creationReceipt: { id: 'original-job' },
  }))
  const result = await createAutomationWithReceipt(client(request), { prompt: 'review' }, {
    recoverClient: async () => client(read), isCurrent: () => true,
  })
  expect(result).toEqual({ job: { id: 'original-job' } })
  expect(request).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledExactlyOnceWith('cron/list', {
    clientRequestId: request.mock.calls[0][1].clientRequestId,
  })
})

test.each([null, { id: '' }])('missing or invalid receipts remain unknown (%j)', async creationReceipt => {
  const original = disconnected()
  const request = vi.fn().mockRejectedValue(original)
  const read = vi.fn().mockImplementation(async (_method, params) => ({ clientRequestId: params.clientRequestId, creationReceipt }))
  await expect(createAutomationWithReceipt(client(request), {}, {
    recoverClient: async () => client(read), isCurrent: () => true,
  })).rejects.toMatchObject({ clientRequestId: expect.any(String), cause: original })
  expect(request).toHaveBeenCalledTimes(1)
})

test('late receipts cannot settle a replacement account', async () => {
  let current = true
  const original = disconnected()
  const request = vi.fn().mockRejectedValue(original)
  const read = vi.fn().mockImplementation(async (_method, params) => {
    current = false
    return { clientRequestId: params.clientRequestId, creationReceipt: { id: 'old-job' } }
  })
  await expect(createAutomationWithReceipt(client(request), {}, {
    recoverClient: async () => client(read), isCurrent: () => current,
  })).rejects.toMatchObject({ clientRequestId: expect.any(String), cause: original })
  expect(request).toHaveBeenCalledTimes(1)
})

test('explicit remote rejection does not query or replay; old targets receive no new fields', async () => {
  const rejected = new GatewayRpcError('scheduled time must be in the future', -32602, undefined, 'runtime-session', 'remote')
  const request = vi.fn().mockRejectedValue(rejected)
  const recoverClient = vi.fn()
  await expect(createAutomationWithReceipt(client(request), {}, { recoverClient, isCurrent: () => true })).rejects.toBe(rejected)
  expect(recoverClient).not.toHaveBeenCalled()
  const legacy = vi.fn().mockResolvedValue({ job: { id: 'legacy-job' } })
  await createAutomationWithReceipt(client(legacy, false), { prompt: 'review' }, { recoverClient, isCurrent: () => true })
  expect(legacy).toHaveBeenCalledExactlyOnceWith('cron/create', { prompt: 'review' })
})

test('an unresolved creation exposes the exact original identity for subsequent reads', async () => {
  const original = disconnected()
  const request = vi.fn().mockRejectedValue(original)
  const read = vi.fn().mockImplementation(async (_method, params) => ({ clientRequestId: params.clientRequestId, creationReceipt: null, retired: true }))
  const failure = await createAutomationWithReceipt(client(request), {}, {
    recoverClient: async () => client(read), isCurrent: () => true,
  }).catch(error => error)
  expect(failure.clientRequestId).toBe(request.mock.calls[0][1].clientRequestId)
  expect(failure.cause).toBe(original)
  expect(request).toHaveBeenCalledTimes(1)
})
