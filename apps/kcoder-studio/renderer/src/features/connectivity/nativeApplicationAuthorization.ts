import {localAuthorizationCleanup,type LocalAuthorizationCleanupController} from './localAuthorizationCleanup'
import {nativeProviderRevocation,type ProviderRevocationController} from './nativeProviderRevocation'
import { requestLocalExecutor } from '@/host/localExecutor'
import { ConnectivityClient, ConnectivityClientError } from './client'
import type { ConnectionView } from './types'

export interface ApplicationAuthorizationResult {
  authorizationId: string
  authorizationUrl: string
  state: 'waiting'
  expiresAt: string
}
export interface ApplicationAuthorizationOwner {
  begin(): Promise<ApplicationAuthorizationResult>
  cancel(): Promise<void>
  providerRevocation?: ProviderRevocationController
  localCleanup?: LocalAuthorizationCleanupController
}

/** Uses the existing target plugin RPC and its original native MCP flow owner.
 * The reference below is UI correlation, never another OAuth/token store. */
export function nativeApplicationAuthorization(
  client: ConnectivityClient,
  connection: ConnectionView,
  target: { deviceId: string; workspacePath?: string },
  isCurrent: () => boolean
): ApplicationAuthorizationOwner {
  const source = connection.configuration as { mcpServerName?: unknown; pluginId?: unknown }
  if (typeof source.mcpServerName !== 'string' || !source.mcpServerName.length
      || !(source.pluginId == null || typeof source.pluginId === 'string'))
    throw new ConnectivityClientError('APPLICATION_SOURCE_NOT_CONFIGURED', 'repair_configuration')
  const selector = { name: source.mcpServerName, ...(typeof source.pluginId === 'string' ? { pluginId: source.pluginId } : {}) }
  const expectedScopeKey = client.scopeIdentity()
  const originalTarget = { ...target }
  const request = <T,>(method: string, params: Record<string, unknown>) =>
    requestLocalExecutor<T>('runtime.plugins.request', { ...originalTarget, method, params })
  let cancelled = false
  let flowId: string | null = null
  let pending: Promise<ApplicationAuthorizationResult> | null = null
  let cancellation: Promise<void> | null = null

  const verify = async () => {
    if (!isCurrent() || client.scopeIdentity() !== expectedScopeKey)
      throw new ConnectivityClientError('APPLICATION_AUTHORIZATION_OWNER_CHANGED', 'reconcile_original')
    const current = await client.call<ConnectionView>('P-CONNECTION', 'readConnection',
      { connectionId: connection.id }, { expectedScopeKey })
    const configured = current.configuration as { mcpServerName?: unknown; pluginId?: unknown }
    if (!isCurrent() || current.revision !== connection.revision
        || configured.mcpServerName !== selector.name
        || (configured.pluginId ?? null) !== (selector.pluginId ?? null))
      throw new ConnectivityClientError('APPLICATION_AUTHORIZATION_SOURCE_CHANGED', 'reconcile_original')
  }
  const cancelFlow = () => {
    if (!flowId) return Promise.resolve()
    // Cleanup targets the captured original endpoint, even after the UI target changed.
    cancellation ??= request<unknown>('mcp/cancel', { flowId }).then(() => undefined)
    return cancellation
  }
  return {
    localCleanup: localAuthorizationCleanup(client, connection, originalTarget, isCurrent, verify),
    providerRevocation: nativeProviderRevocation(client, connection, originalTarget, isCurrent, verify),
    begin() {
      if (pending) return pending
      pending = (async () => {
        if (cancelled) throw new ConnectivityClientError('APPLICATION_AUTHORIZATION_CANCELLED', 'none')
        const startedAt = Date.now()
        await verify()
        if (cancelled || !isCurrent()) throw new ConnectivityClientError('APPLICATION_AUTHORIZATION_CANCELLED', 'none')
        const result = await request<{ flowId: string; authorizationUrl: string }>('gateway/mcp/login', { server: selector })
        if (typeof result.flowId !== 'string' || !result.flowId.length || result.flowId.length > 256)
          throw new ConnectivityClientError('APPLICATION_AUTHORIZATION_UNCONFIRMED', 'reconcile_original')
        flowId = result.flowId
        if (cancelled || !isCurrent() || client.scopeIdentity() !== expectedScopeKey) {
          await cancelFlow()
          throw new ConnectivityClientError('APPLICATION_AUTHORIZATION_CANCELLED', 'none')
        }
        try {
          await verify()
          const url = new URL(result.authorizationUrl)
          const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password)
            throw new Error('invalid authorization URI')
          return { authorizationId: flowId, authorizationUrl: url.href, state: 'waiting' as const,
            expiresAt: new Date(startedAt + 600_000).toISOString() }
        } catch (error) {
          await cancelFlow().catch(() => {})
          throw error
        }
      })()
      return pending
    },
    async cancel() {
      cancelled = true
      if (flowId) await cancelFlow()
      // If login is still pending, its original response owns the eventual cancellation.
    },
  }
}
