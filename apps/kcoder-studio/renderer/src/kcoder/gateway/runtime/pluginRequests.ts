import { sameWorkspacePath } from '@/lib/workspace-path-identity'
import { captureAccountContextRevision } from '../../accountContextEvents'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import { GatewayRpcError } from '../../gatewayRpc'
import type { GatewayClient } from '../../gatewayRuntimeTypes'
import { isContract } from '../../../../../shared/generated/validator.mjs'
import { record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

/** Plugin management owns one target source from discovery through its Native receipt. */
export async function requestPlugins(runtime: GatewayRuntimeCore, params: Record<string, unknown>, assertExpectedOwner?: () => void) {
  const accountCurrent = captureAccountContextRevision()
  const sourceCurrent = runtime.captureReadSource(text(params.deviceId) ?? text(params.device_id) ?? undefined)
  const scopeChanged = () => new GatewayRpcError(
    'Plugin target, account or connection changed', -32049, { kind: 'plugin_scope_changed' }, 'plugin-manage', 'remote'
  )
  const assertSource = () => {
    assertExpectedOwner?.()
    if (!sourceCurrent()) throw scopeChanged()
  }
  if (runtime.restartingAppServers) await runtime.assertRequestTargetAvailable(params).finally(assertSource)
  const { PLUGIN_RPC_METHODS, requiredPluginCapabilities } =
    await import('../../gatewayPluginApi').finally(assertSource)
  const pluginMethod = text(params.method)
  if (!pluginMethod || !PLUGIN_RPC_METHODS.has(pluginMethod)) {
    throw new Error('Unsupported KCoder plugin operation')
  }
  if (
    pluginMethod === 'mcp/providerRevocation' &&
    !isContract('McpProviderRevocationParams', params.params)
  )
    throw new GatewayRpcError('MCP provider revocation parameters are invalid', -32602)
  const pluginTarget = await runtime.serverForParams(params).finally(assertSource)
  const pluginTargetScope = hookTargetScope(pluginTarget)
  const assertPluginScope = () => {
    assertSource()
    if (!accountCurrent(pluginTarget.id) || hookTargetScope(pluginTarget) !== pluginTargetScope)
      throw scopeChanged()
  }
  assertPluginScope()
  const proxyManagement = pluginMethod === 'plugin/proxy/status' || pluginMethod === 'plugin/proxy/configure'
  const client = await runtime.commandClient(pluginTarget, text(params.workspacePath) ?? undefined, proxyManagement).finally(assertPluginScope)
  const capabilities = requiredPluginCapabilities(pluginMethod, record(params.params))
  if (capabilities.some(capability => !client.supportsExperimental?.(capability))) {
    throw new GatewayRpcError(
      'Target runtime upgrade required for directory trust, plugin network settings or Git refresh',
      -32000,
      { kind: 'plugin_update_required' }
    )
  }
  if (pluginMethod === 'plugin/activation/conversations')
    return Array.from(runtime.tasks.values())
      .filter(
        task =>
          task.serverId === pluginTarget.id &&
          !task.ephemeral &&
          (!text(params.workspacePath) ||
            sameWorkspacePath(task.workspacePath, text(params.workspacePath)!))
      )
      .slice(-100)
      .map(task => ({ taskId: task.taskId, title: task.title || task.taskId }))
  const requestOwned = async (originalClient: GatewayClient, fields: Record<string, unknown>) => {
    const connectionId = originalClient.diagnosticConnection?.connectionId
    const assertCurrent = () => {
      assertPluginScope()
      if (runtime.appServerDisconnectedClients.has(originalClient) ||
          originalClient.diagnosticConnection?.connectionId !== connectionId) throw scopeChanged()
    }
    assertCurrent()
    try { return await originalClient.request(pluginMethod, fields) }
    finally { assertCurrent() }
  }
  const fields = { ...record(params.params) }
  if (pluginMethod === 'plugin/activation/read') {
    // A thread belongs to this authenticated task connection, never a caller-supplied ID.
    delete fields.threadId
    const taskScope = text(params.taskId)
      ? await runtime.taskConnection({ taskId: params.taskId, deviceId: pluginTarget.id }).finally(assertPluginScope)
      : null
    if (taskScope) {
      if (taskScope.server.id !== pluginTarget.id)
        throw new Error('Plugin task belongs to another target')
      fields.threadId = taskScope.task.threadId
      return requestOwned(taskScope.client, fields)
    }
  }
  const result = await requestOwned(client, fields)
  if (pluginMethod === 'marketplace/list')
    return {
      ...record(result),
      lifecycleCapabilities: {
        revalidation: client.supportsExperimental?.('pluginRevalidationV1') === true,
        privateCredentials: client.supportsExperimental?.('pluginPrivateCredentialsV1') === true,
        activation: client.supportsExperimental?.('pluginActivationV1') === true,
      },
    }
  return result
}
