import { requestLocalExecutor } from '@/host/localExecutor'
import { createRandomUuid } from '@/lib/random-id'
import { isContract } from '../../../../shared/generated/validator.mjs'
import type { McpProviderRevocationReceipt, IntegrationRevisionRef, McpServerParams } from '../../../../shared/generated/contracts'
import { ConnectivityClientError, type ConnectivityClient } from './client'
import type { ConnectionView } from './types'

export interface ProviderRevocationLocator { requestId: string; intentRef?: IntegrationRevisionRef; stage: 'prepare' | 'commit'; connectionRef: IntegrationRevisionRef; server: McpServerParams; currentConnectionMatches: boolean }
export interface ProviderRevocationController {
  pending(): ProviderRevocationLocator | undefined
  prepare(): Promise<McpProviderRevocationReceipt>
  commit(): Promise<McpProviderRevocationReceipt>
  read(): Promise<McpProviderRevocationReceipt>
  cancel(): Promise<McpProviderRevocationReceipt>
  archiveChangedSource(): Promise<void>
}
const sameRef = (a: IntegrationRevisionRef | null | undefined, b: IntegrationRevisionRef | null | undefined) => !!a && !!b && a.id === b.id && a.revision === b.revision
const exact = (value: object, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))

/** Only operation metadata survives remount. Native owns credentials, HTTP and the authoritative receipt. */
export function nativeProviderRevocation(client: ConnectivityClient, connection: ConnectionView, target: { deviceId: string; workspacePath?: string }, isCurrent: () => boolean, verifyConnection: () => Promise<void>): ProviderRevocationController {
  const scope = client.scopeIdentity(), capturedTarget = { deviceId: target.deviceId, workspacePath: target.workspacePath ?? null }
  const configuration = connection.configuration as { mcpServerName?: unknown; pluginId?: unknown }
  if (typeof configuration.mcpServerName !== 'string' || !configuration.mcpServerName || !(configuration.pluginId == null || typeof configuration.pluginId === 'string')) throw new ConnectivityClientError('APPLICATION_SOURCE_NOT_CONFIGURED', 'repair_configuration')
  const server: McpServerParams = { name: configuration.mcpServerName, pluginId: typeof configuration.pluginId === 'string' ? configuration.pluginId : null }
  const connectionRef = { id: connection.id, revision: connection.revision }
  const cacheKey = JSON.stringify(['kcoder-provider-revocation-v1', capturedTarget, scope, connection.id])
  const owner = () => { if (!isCurrent() || client.scopeIdentity() !== scope) throw new ConnectivityClientError('APPLICATION_AUTHORIZATION_OWNER_CHANGED', 'reconcile_original') }
  const readLocator = (): ProviderRevocationLocator | undefined => {
    const raw = window.sessionStorage.getItem(cacheKey); if (!raw) return
    try {
      const value = JSON.parse(raw)
      if (!value || !exact(value, ['version', 'target', 'scope', 'connectionRef', 'server', 'requestId', 'intentRef', 'stage']) || value.version !== 1
        || JSON.stringify(value.target) !== JSON.stringify(capturedTarget) || value.scope !== scope || value.connectionRef?.id !== connectionRef.id
        || !isContract('IntegrationRevisionRef', value.connectionRef) || !value.server || !exact(value.server, ['name', 'pluginId']) || typeof value.server.name !== 'string' || !value.server.name || value.server.name.length > 256 || !(value.server.pluginId === null || typeof value.server.pluginId === 'string')
        || typeof value.requestId !== 'string' || !value.requestId || value.requestId.length > 128 || !['prepare', 'commit'].includes(value.stage)
        || value.intentRef !== null && !isContract('IntegrationRevisionRef', value.intentRef)) throw Error('invalid original locator')
      return { requestId: value.requestId, ...(value.intentRef ? { intentRef: value.intentRef } : {}), stage: value.stage, connectionRef: value.connectionRef, server: value.server, currentConnectionMatches: sameRef(value.connectionRef, connectionRef) && JSON.stringify(value.server) === JSON.stringify(server) }
    } catch { throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED', 'reconcile_original') }
  }
  const save = (locator: ProviderRevocationLocator) => {
    const original = readLocator()
    if (original && original.requestId !== locator.requestId) throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED', 'reconcile_original')
    window.sessionStorage.setItem(cacheKey, JSON.stringify({ version: 1, target: capturedTarget, scope, connectionRef: locator.connectionRef, server: locator.server, requestId: locator.requestId,
      intentRef: locator.intentRef ? { id: locator.intentRef.id, revision: locator.intentRef.revision } : null, stage: locator.stage }))
  }
  const request = async (action: 'prepare' | 'commit' | 'read' | 'cancel', original: ProviderRevocationLocator) => {
    owner()
    let result: unknown
    try {
      result = await requestLocalExecutor<unknown>('runtime.plugins.request', { ...target, method: 'mcp/providerRevocation', params: {
      action, server: original.server, requestId: original.requestId, ...(['commit', 'cancel'].includes(action) ? { intentRef: original.intentRef } : {}),
    } })
    } catch (error) {
      owner()
      const unsupported = error as { code?: unknown; data?: { kind?: unknown } }
      if (action === 'prepare' && (unsupported.code === -32601 || unsupported.data?.kind === 'plugin_update_required')) {
        const raw = window.sessionStorage.getItem(cacheKey)
        if (raw && readLocator()?.requestId === original.requestId) {
          window.sessionStorage.setItem(`${cacheKey}:not-dispatched:${original.requestId}`, raw)
          window.sessionStorage.removeItem(cacheKey)
        }
        throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_UNSUPPORTED_TARGET', 'repair_configuration')
      }
      throw error
    }
    owner()
    if (!isContract('McpProviderRevocationReceipt', result)) throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_REPLY_INVALID', 'reconcile_original')
    const receipt = result as McpProviderRevocationReceipt
    if (receipt.requestId !== original.requestId || receipt.localCredentialsRemoved || receipt.currentSourceMatches !== (receipt.sourceState === 'matches') || original.intentRef && !sameRef(receipt.intentRef, original.intentRef)
      || receipt.phase === 'prepared' && (!receipt.intentRef || receipt.reason !== 'awaitingConfirmation') || receipt.phase === 'accepted' && receipt.reason !== 'providerAccepted') throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_REPLY_INVALID', 'reconcile_original')
    if (receipt.phase === 'prepared' && receipt.intentRef) save({ ...original, intentRef: receipt.intentRef })
    if (['accepted', 'unsupported', 'rejected'].includes(receipt.phase) && receipt.intentRef) {
      if (readLocator()?.requestId === original.requestId) window.sessionStorage.removeItem(cacheKey)
    }
    return receipt
  }
  return {
    pending: readLocator,
    async prepare() {
      owner(); if (readLocator()) throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED', 'reconcile_original')
      await verifyConnection(); owner()
      const original: ProviderRevocationLocator = { requestId: createRandomUuid(), stage: 'prepare', connectionRef, server, currentConnectionMatches: true }; save(original)
      return request('prepare', original)
    },
    async commit() {
      owner(); const original = readLocator()
      if (!original?.intentRef || original.stage === 'commit' || !original.currentConnectionMatches) throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED', 'reconcile_original')
      await verifyConnection(); owner(); save({ ...original, stage: 'commit' })
      return request('commit', { ...original, stage: 'commit' })
    },
    async archiveChangedSource() {
      owner(); const original = readLocator()
      if (!original) throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED', 'reconcile_original')
      const observed = await request('read', original)
      if (observed.sourceState !== 'changed' && original.currentConnectionMatches) throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED', 'reconcile_original')
      if (!original.currentConnectionMatches) { await verifyConnection(); owner() }
      // Preserve the original unresolved locator. Switching sources is not a
      // completed/rejected provider receipt and never resends its request.
      const raw = window.sessionStorage.getItem(cacheKey)
      if (raw && readLocator()?.requestId === original.requestId) {
        window.sessionStorage.setItem(`${cacheKey}:history:${original.requestId}`, raw)
        window.sessionStorage.removeItem(cacheKey)
      }
    },
    async cancel() {
      owner(); const original = readLocator()
      if (!original?.intentRef) throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED', 'reconcile_original')
      return request('cancel', original)
    },
    async read() {
      owner(); const original = readLocator()
      if (!original) throw new ConnectivityClientError('APPLICATION_PROVIDER_REVOCATION_ORIGINAL_UNCONFIRMED', 'reconcile_original')
      return request('read', original)
    },
  }
}
