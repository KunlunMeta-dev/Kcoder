import { beforeEach, expect, test, vi } from 'vitest'
import { localAuthorizationCleanup } from './localAuthorizationCleanup'
import type { ConnectivityClient } from './client'
import type { ConnectionView } from './types'
const connection = { id: 'original-connection', revision: '1' } as ConnectionView
const target = { deviceId: 'original-device' }
beforeEach(() => window.sessionStorage.clear())
test('local clearing has an original Main operation and independently reconciles accepted removal with unknown disablement', async () => {
  const call = vi.fn(), client = { scopeIdentity: () => 'original-account-scope', call } as unknown as ConnectivityClient
  const controller = localAuthorizationCleanup(client, connection, target, () => true, vi.fn(async () => {}))
  call.mockImplementationOnce(async (_port, _method, _payload, options) => {
    expect(controller.pending()?.operationId).toBe(options.operationId)
    return { localAuthorizationCleanup: { operationId: options.operationId, connectionRef: { id: connection.id, revision: '1' }, localRemoval: 'accepted', availability: 'unknown', providerRevocationRequested: false } }
  })
  const first = await controller.clear(); expect(first.localRemoval).toBe('accepted'); expect(controller.pending()?.operationId).toBe(first.operationId)
  call.mockResolvedValue({ localAuthorizationCleanup: { ...first, availability: 'disabled' } })
  expect((await controller.read())?.availability).toBe('disabled'); expect(controller.pending()).toBeUndefined()
  expect(call.mock.calls[1]).toMatchObject(['P-CONNECTION', 'readConnection', { connectionId: connection.id, localCleanupReceipt: { operationId: first.operationId, connectionRef: { id: connection.id, revision: '1' } } }, { expectedScopeKey: 'original-account-scope' }])
  expect(call.mock.calls[0][2]).toEqual({ action: 'disconnect', connectionId: connection.id })
})
test('lost local cleanup ACK does not execute another removal and never becomes a provider revocation receipt', async () => {
  let current = true
  const call = vi.fn().mockRejectedValueOnce(new Error('lost original ACK')), client = { scopeIdentity: () => 'original', call } as unknown as ConnectivityClient
  let controller = localAuthorizationCleanup(client, connection, target, () => current, vi.fn(async () => {}))
  await expect(controller.clear()).rejects.toThrow('lost original ACK'); const id = controller.pending()!.operationId
  controller = localAuthorizationCleanup(client, connection, target, () => current, vi.fn(async () => {})); call.mockResolvedValue({ localAuthorizationCleanup: null })
  expect(await controller.read()).toBeNull(); expect(controller.pending()?.operationId).toBe(id)
  await expect(controller.clear()).rejects.toMatchObject({ code: 'APPLICATION_ORIGINAL_CLEANUP_UNCONFIRMED' }); expect(call).toHaveBeenCalledTimes(2)
  current = false; await expect(controller.read()).rejects.toMatchObject({ code: 'APPLICATION_AUTHORIZATION_OWNER_CHANGED' }); expect(call).toHaveBeenCalledTimes(2)
})
