import { beforeEach, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/host/localExecutor'
import { nativeProviderRevocation } from './nativeProviderRevocation'
import type { ConnectivityClient } from './client'
import type { ConnectionView } from './types'
import type { McpProviderRevocationReceipt } from '../../../../shared/generated/contracts'
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: vi.fn() }))
const connection = { id: 'owned-connection', revision: '1', configuration: { mcpServerName: 'original-source', pluginId: 'original-plugin' } } as ConnectionView
const target = { deviceId: 'original-device', workspacePath: '/owned/workspace' }
const intentRef = { id: 'native-original-intent', revision: 'native-only-revision' }
const clientFor = (scope = 'original-account-target-scope') => ({ scopeIdentity: () => scope }) as ConnectivityClient
const receipt = (requestId: string, phase: McpProviderRevocationReceipt['phase'] = 'prepared'): McpProviderRevocationReceipt => ({ requestId, intentRef, phase, reason: phase === 'prepared' ? 'awaitingConfirmation' : phase === 'accepted' ? 'providerAccepted' : phase === 'rejected' ? 'preparationCancelled' : 'outcomeUnconfirmed', localCredentialsRemoved: false, currentSourceMatches: true, sourceState: 'matches' })
beforeEach(() => { vi.resetAllMocks(); window.sessionStorage.clear() })

test('prepare is metadata only; commit locator precedes dispatch and a lost ACK remount only reads the original request', async () => {
  const client = clientFor(), verify = vi.fn(async () => {}), controller = nativeProviderRevocation(client, connection, target, () => true, verify)
  const execute = vi.mocked(requestLocalExecutor)
  execute.mockImplementationOnce(async (_command, input) => {
    const params = (input as { params: { action: string; requestId: string } }).params
    expect(params.action).toBe('prepare'); expect(controller.pending()?.requestId).toBe(params.requestId)
    return receipt(params.requestId)
  })
  const prepared = await controller.prepare(); expect(execute).toHaveBeenCalledOnce(); expect(controller.pending()?.stage).toBe('prepare')
  execute.mockImplementationOnce(async () => { expect(controller.pending()?.stage).toBe('commit'); throw new Error('lost original ACK') })
  await expect(controller.commit()).rejects.toThrow('lost original ACK')
  const reopened = nativeProviderRevocation(clientFor(), connection, target, () => true, verify)
  execute.mockResolvedValue(receipt(prepared.requestId, 'unknown'))
  await reopened.read()
  expect(execute.mock.calls.at(-1)?.[1]).toMatchObject({ ...target, method: 'mcp/providerRevocation', params: { action: 'read', requestId: prepared.requestId, server: { name: 'original-source', pluginId: 'original-plugin' } } })
  await expect(reopened.commit()).rejects.toMatchObject({ code: 'APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED' })
  await expect(reopened.prepare()).rejects.toMatchObject({ code: 'APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED' })
  expect(execute).toHaveBeenCalledTimes(3)
  const persisted = window.sessionStorage.getItem(window.sessionStorage.key(0)!)!
  expect(persisted).not.toMatch(/accessToken|refreshToken|clientSecret|authorizationUrl|token_endpoint|image|verifyCode/)
  expect(JSON.parse(persisted)).toMatchObject({ requestId: prepared.requestId, stage: 'commit', intentRef })
})

test('cancel cannot turn an unknown provider outcome into local clearing or erase its original locator', async () => {
  const controller = nativeProviderRevocation(clientFor(), connection, target, () => true, vi.fn(async () => {})), execute = vi.mocked(requestLocalExecutor)
  execute.mockImplementation(async (_command, input) => receipt((input as { params: { requestId: string } }).params.requestId, execute.mock.calls.length === 1 ? 'prepared' : 'unknown'))
  const prepared = await controller.prepare(); await controller.commit(); await controller.cancel()
  expect(controller.pending()?.requestId).toBe(prepared.requestId)
  execute.mockResolvedValue({ ...receipt(prepared.requestId, 'accepted'), localCredentialsRemoved: true })
  await expect(controller.read()).rejects.toMatchObject({ code: 'APPLICATION_PROVIDER_REVOCATION_REPLY_INVALID' })
  expect(controller.pending()?.requestId).toBe(prepared.requestId)
})

test('foreign target/account cannot borrow an old locator, and a late owner reply cannot publish it', async () => {
  let current = true, finish!: (value: unknown) => void
  const execute = vi.mocked(requestLocalExecutor); execute.mockImplementation(async () => new Promise(resolve => { finish = resolve }))
  const controller = nativeProviderRevocation(clientFor(), connection, target, () => current, vi.fn(async () => {}))
  const creating = controller.prepare(); await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
  const original = controller.pending()!; current = false; finish(receipt(original.requestId))
  await expect(creating).rejects.toMatchObject({ code: 'APPLICATION_AUTHORIZATION_OWNER_CHANGED' })
  expect(nativeProviderRevocation(clientFor('other-account'), connection, target, () => true, vi.fn(async () => {})).pending()).toBeUndefined()
  expect(nativeProviderRevocation(clientFor(), connection, { ...target, deviceId: 'other-device' }, () => true, vi.fn(async () => {})).pending()).toBeUndefined()
  await expect(controller.read()).rejects.toMatchObject({ code: 'APPLICATION_AUTHORIZATION_OWNER_CHANGED' }); expect(execute).toHaveBeenCalledOnce()
})

test('a changed connection reads the original selector but cannot commit it; explicit switching preserves unresolved history', async () => {
  const execute = vi.mocked(requestLocalExecutor); execute.mockImplementation(async (_command, input) => receipt((input as { params: { requestId: string } }).params.requestId))
  const old = nativeProviderRevocation(clientFor(), connection, target, () => true, vi.fn(async () => {})); const prepared = await old.prepare()
  const verify = vi.fn(async () => {}), changed = nativeProviderRevocation(clientFor(), { ...connection, revision: '2', configuration: { mcpServerName: 'replacement-source', pluginId: null } }, target, () => true, verify)
  expect(changed.pending()?.currentConnectionMatches).toBe(false)
  await expect(changed.commit()).rejects.toMatchObject({ code: 'APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED' })
  execute.mockResolvedValue(receipt(prepared.requestId, 'unknown')); await changed.read()
  expect(execute.mock.calls.at(-1)?.[1]).toMatchObject({ params: { action: 'read', server: { name: 'original-source', pluginId: 'original-plugin' }, requestId: prepared.requestId } })
  await changed.archiveChangedSource(); expect(verify).toHaveBeenCalledOnce(); expect(changed.pending()).toBeUndefined()
  expect(Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index)).some(key => key?.endsWith(`:history:${prepared.requestId}`))).toBe(true)
  expect(execute.mock.calls.every(([, input]) => (input as { params: { action: string } }).params.action !== 'commit')).toBe(true)
})

test('corrupted cache cannot start another operation and mismatched original native references remain unconfirmed', async () => {
  const execute = vi.mocked(requestLocalExecutor); execute.mockImplementation(async (_command, input) => receipt((input as { params: { requestId: string } }).params.requestId))
  const controller = nativeProviderRevocation(clientFor(), connection, target, () => true, vi.fn(async () => {})); const prepared = await controller.prepare()
  execute.mockResolvedValue({ ...receipt(prepared.requestId, 'accepted'), intentRef: { ...intentRef, revision: 'foreign' } })
  await expect(controller.read()).rejects.toMatchObject({ code: 'APPLICATION_PROVIDER_REVOCATION_REPLY_INVALID' })
  const key = window.sessionStorage.key(0)!, value = JSON.parse(window.sessionStorage.getItem(key)!); window.sessionStorage.setItem(key, JSON.stringify({ ...value, token: 'forbidden-cache-field' }))
  expect(() => controller.pending()).toThrow(); await expect(controller.prepare()).rejects.toMatchObject({ code: 'APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED' })
  expect(execute).toHaveBeenCalledTimes(2)
})

test('a known unsupported target before pure preparation is distinct from an unknown dispatched commit', async () => {
  const execute = vi.mocked(requestLocalExecutor), controller = nativeProviderRevocation(clientFor(), connection, target, () => true, vi.fn(async () => {}))
  execute.mockRejectedValueOnce({ code: -32000, data: { kind: 'plugin_update_required' } })
  await expect(controller.prepare()).rejects.toMatchObject({ code: 'APPLICATION_PROVIDER_REVOCATION_UNSUPPORTED_TARGET' })
  expect(controller.pending()).toBeUndefined(); expect(window.sessionStorage.length).toBe(1)
  execute.mockImplementationOnce(async (_command, input) => receipt((input as { params: { requestId: string } }).params.requestId))
  const prepared = await controller.prepare(); execute.mockRejectedValueOnce({ code: -32601 })
  await expect(controller.commit()).rejects.toMatchObject({ code: -32601 }); expect(controller.pending()?.requestId).toBe(prepared.requestId); expect(controller.pending()?.stage).toBe('commit')
})
