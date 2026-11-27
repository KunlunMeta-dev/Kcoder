import { createRandomUuid } from '@/lib/random-id'
import { isContract } from '../../../../shared/generated/validator.mjs'
import type { ConnectivityLocalAuthorizationCleanupReceipt, IntegrationRevisionRef } from '../../../../shared/generated/contracts'
import { ConnectivityClientError, type ConnectivityClient } from './client'
import type { ConnectionView } from './types'
interface Original { operationId: string; connectionRef: IntegrationRevisionRef }
export interface LocalAuthorizationCleanupController {
  pending(): Original | undefined
  clear(): Promise<ConnectivityLocalAuthorizationCleanupReceipt>
  read(): Promise<ConnectivityLocalAuthorizationCleanupReceipt | null>
}
/** Local clearing has its own Main intent/receipt and never starts provider HTTP. */
export function localAuthorizationCleanup(client: ConnectivityClient, connection: ConnectionView, target: { deviceId: string; workspacePath?: string }, isCurrent: () => boolean, verify: () => Promise<void>): LocalAuthorizationCleanupController {
  const scope = client.scopeIdentity(), connectionRef = { id: connection.id, revision: connection.revision }
  const key = JSON.stringify(['kcoder-local-authorization-cleanup-v1', { deviceId: target.deviceId, workspacePath: target.workspacePath ?? null }, scope, connection.id])
  const owner = () => { if (!isCurrent() || client.scopeIdentity() !== scope) throw new ConnectivityClientError('APPLICATION_AUTHORIZATION_OWNER_CHANGED', 'reconcile_original') }
  const pending = (): Original | undefined => {
    const raw = window.sessionStorage.getItem(key); if (!raw) return
    try {
      const value = JSON.parse(raw)
      if (!value || Object.keys(value).length !== 2 || !isContract('IntegrationRevisionRef', value.connectionRef) || value.connectionRef.id !== connection.id || typeof value.operationId !== 'string' || !value.operationId || value.operationId.length > 128) throw Error('invalid original operation')
      return { operationId: value.operationId, connectionRef: value.connectionRef }
    } catch { throw new ConnectivityClientError('APPLICATION_ORIGINAL_CLEANUP_UNCONFIRMED', 'reconcile_original') }
  }
  const receipt = (result: unknown, original: Original) => {
    const value = (result as ConnectionView | null)?.localAuthorizationCleanup
    if (value == null) return null
    if (!isContract('ConnectivityLocalAuthorizationCleanupReceipt', value) || value.operationId !== original.operationId || value.connectionRef.id !== original.connectionRef.id || value.connectionRef.revision !== original.connectionRef.revision || value.providerRevocationRequested) throw new ConnectivityClientError('APPLICATION_ORIGINAL_CLEANUP_UNCONFIRMED', 'reconcile_original')
    if (value.localRemoval === 'accepted' && value.availability === 'disabled' && pending()?.operationId === original.operationId) window.sessionStorage.removeItem(key)
    return value
  }
  return {
    pending,
    async clear() {
      owner(); if (pending()) throw new ConnectivityClientError('APPLICATION_ORIGINAL_CLEANUP_UNCONFIRMED', 'reconcile_original')
      await verify(); owner()
      const original = { operationId: createRandomUuid(), connectionRef }; window.sessionStorage.setItem(key, JSON.stringify(original))
      const result = await client.call<ConnectionView>('P-CONNECTION', 'prepareConnectionAction', { action: 'disconnect', connectionId: connection.id }, { operationId: original.operationId, expectedRevision: connection.revision, expectedScopeKey: scope })
      owner(); const observed = receipt(result, original)
      if (!observed) throw new ConnectivityClientError('APPLICATION_ORIGINAL_CLEANUP_UNCONFIRMED', 'reconcile_original')
      return observed
    },
    async read() {
      owner(); const original = pending()
      if (!original) throw new ConnectivityClientError('APPLICATION_ORIGINAL_CLEANUP_UNCONFIRMED', 'reconcile_original')
      const result = await client.call<ConnectionView>('P-CONNECTION', 'readConnection', { connectionId: connection.id, localCleanupReceipt: original }, { expectedScopeKey: scope })
      owner(); return receipt(result, original)
    },
  }
}
