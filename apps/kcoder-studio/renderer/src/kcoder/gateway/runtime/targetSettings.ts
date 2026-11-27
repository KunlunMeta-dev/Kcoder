import i18n from '@/i18n'
import { abortable } from '@/lib/abortable'
import { GatewayRpcError } from '../../gatewayRpc'
import { hookTargetScope } from '../../gatewayHookConfiguration'
import { isKnowledgeSettingsMethod, requestKnowledgeSettings } from '../../gatewayKnowledgeSettings'
import { isConnectivitySettingsMethod, requestConnectivitySettings } from '../../gatewayConnectivitySettings'
import { isOfficeSettingsMethod, requestOfficeSettings } from '../../gatewayOfficeSettings'
import { isEvolutionSettingsMethod, requestEvolution } from '../../gatewayEvolution'
import { record, text } from './contracts'
import type { GatewayRuntimeCore } from './core'

export async function requestTargetSettings(this: GatewayRuntimeCore, params: Record<string, unknown>, options?: { signal?: AbortSignal }) {
  const delegated: ((this: GatewayRuntimeCore, params: Record<string, unknown>,
    options?: { signal?: AbortSignal }) => Promise<unknown>) | null = isKnowledgeSettingsMethod(params.method) ? requestKnowledgeSettings
    : isConnectivitySettingsMethod(params.method) ? requestConnectivitySettings
      : isOfficeSettingsMethod(params.method) ? requestOfficeSettings
        : isEvolutionSettingsMethod(params.method) ? requestEvolution : null
  if (delegated) {
    if (this.restartingAppServers) await this.assertRequestTargetAvailable(params)
    return delegated.call(this, params, options)
  }
  const operation = text(params.method)
  if (
    operation !== 'settings/templates/list' &&
    operation !== 'settings/templates/read' &&
    operation !== 'settings/templates/save' &&
    operation !== 'settings/templates/delete' &&
    operation !== 'settings/templates/default' &&
    operation !== 'settings/turn-file-changes/read' &&
    operation !== 'settings/turn-file-changes/save' &&
    operation !== 'settings/tools/selection/read' &&
    operation !== 'settings/tools/selection/save' &&
    operation !== 'settings/tools/read' &&
    operation !== 'settings/tools/save' &&
    operation !== 'settings/execution-defaults/read' &&
    operation !== 'settings/execution-defaults/save'
  )
    throw new Error('Unsupported settings operation')
  const serverId = text(params.serverId)
  if (!serverId) throw new Error('A settings target is required')
  // Only presentation reads release their wait; accepted writes retain their receipt.
  const signal = operation.endsWith('/read') || operation.endsWith('/list') ? options?.signal : undefined
  const sourceCurrent = this.captureReadSource(serverId)
  const changed = () => new GatewayRpcError('Settings target or account changed', -32049, { kind: 'settings_scope_changed' })
  const assertSource = () => {
    signal?.throwIfAborted()
    if (!sourceCurrent()) throw changed()
  }
  assertSource()
  if (this.restartingAppServers)
    await abortable(this.assertRequestTargetAvailable(params), signal).finally(assertSource)
  const target = await abortable(this.serverForParams({ deviceId: serverId }), signal).finally(assertSource)
  const assertScope = () => {
    assertSource()
    if (target.id !== serverId || params.targetScope !== undefined && params.targetScope !== hookTargetScope(target))
      throw changed()
  }
  assertScope()
  const client = await abortable(this.commandClient(target, text(params.workspacePath) ?? undefined), signal).finally(assertScope)
  const connectionId = client.diagnosticConnection?.connectionId
  const assertCurrent = () => {
    assertScope()
    if (this.appServerDisconnectedClients.has(client) || client.diagnosticConnection?.connectionId !== connectionId)
      throw changed()
  }
  assertCurrent()
  if (
    operation === 'settings/execution-defaults/read' ||
    operation === 'settings/execution-defaults/save'
  ) {
    if (client.supportsExperimental?.('executionDefaultsV1') !== true)
      throw new GatewayRpcError('Target requires execution default settings support', -32000, {
        kind: 'execution_defaults_unsupported',
        capability: 'executionDefaultsV1',
      })
  } else if (
    operation === 'settings/tools/selection/read' ||
    operation === 'settings/tools/selection/save'
  ) {
    if (client.supportsExperimental?.('toolSelectionsV1') !== true)
      throw new Error('TOOL_SELECTION_UNSUPPORTED')
  } else if (operation === 'settings/tools/read' || operation === 'settings/tools/save') {
    if (client.supportsExperimental?.('toolProfilesV1') !== true)
      throw new Error(i18n.t('common:toolProfile.unsupported'))
  } else if (client.supportsExperimental?.('settingsTemplatesV1') !== true) {
    throw new Error('请升级目标 KCoder 以使用会话配置模板')
  }
  const fields = { ...record(params.params) }
  if (operation === 'settings/templates/default' && !('id' in fields)) fields.id = null
  if (
    operation === 'settings/tools/selection/read' &&
    client.supportsExperimental?.('lunaToolSelectionsV1') !== true
  ) {
    // Older strict targets must receive their original request and response shape.
    delete fields.includeLunaBaseline
  }
  if (
    operation === 'settings/tools/selection/read' &&
    client.supportsExperimental?.('toolSelectionResolutionV1') !== true
  ) {
    delete fields.includeResolution
    delete fields.previewExpert
  }
  if (
    operation === 'settings/tools/selection/read' &&
    client.supportsExperimental?.('expertToolSelectionV1') !== true
  ) {
    delete fields.includeExpertToolSelection
  }
  const pending = signal ? client.request(operation, fields, { signal }) : client.request(operation, fields)
  return abortable(pending, signal).finally(assertCurrent)
}
