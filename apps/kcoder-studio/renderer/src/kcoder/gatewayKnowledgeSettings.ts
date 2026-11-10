import { isContract } from '../../../shared/generated/validator.mjs'
import type { KnowledgeSettingsReadResult } from '../../../shared/generated/contracts'
import { captureAccountContextRevision } from './accountContextEvents'
import { GatewayRpcError } from './gatewayRpc'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

const READ = 'settings/integrations/knowledge/read'
const SAVE = 'settings/integrations/knowledge/save'
export function isKnowledgeSettingsMethod(value: unknown): boolean {
  return value === READ || value === SAVE
}

/** Settings stay target-owned and separately negotiated while the Knowledge feature is disabled. */
export async function requestKnowledgeSettings(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<KnowledgeSettingsReadResult> {
  const method = text(params.method)
  const serverId = text(params.serverId)
  const fields = structuredClone(record(params.params))
  if (
    !isKnowledgeSettingsMethod(method) ||
    !serverId ||
    (method === READ
      ? Object.keys(fields).length > 0
      : !isContract('KnowledgeSettingsSaveParams', fields) ||
        !/^[a-f0-9]{64}$/i.test(String(fields.expectedRevision)))
  )
    throw new Error('KNOWLEDGE_SETTINGS_INVALID_REQUEST')
  const accountCurrent = captureAccountContextRevision()
  const generation = this.configurationEpochByTarget.get(serverId)
  const check = () => {
    options?.signal?.throwIfAborted()
    if (
      this.disposed ||
      this.configurationEpochByTarget.get(serverId) !== generation ||
      !accountCurrent(serverId)
    )
      throw new Error('KNOWLEDGE_SETTINGS_TARGET_CHANGED')
  }
  check()
  const target = await this.serverForParams({ deviceId: serverId })
  check()
  const client = await this.commandClient(target, text(params.workspacePath) ?? undefined)
  check()
  await this.assertCommandTarget(target)
  check()
  if (client.supportsExperimental?.('knowledgeSettingsV1') !== true)
    throw new GatewayRpcError('Target does not support Knowledge settings', -32000, {
      kind: 'knowledge_settings_unsupported',
      capability: 'knowledgeSettingsV1',
    })
  const result = await client.request<unknown>(method!, fields, options)
  check()
  await this.assertCommandTarget(target)
  check()
  if (!isContract('KnowledgeSettingsReadResult', result))
    throw new Error('KNOWLEDGE_SETTINGS_REPLY_INVALID')
  const settings = result as KnowledgeSettingsReadResult
  if (
    !/^[a-f0-9]{64}$/i.test(settings.revision) ||
    settings.restartRequired !==
      Object.keys(settings.effective).some(
        key =>
          settings.effective[key as keyof typeof settings.effective] !==
          settings.connection[key as keyof typeof settings.connection]
      )
  )
    throw new Error('KNOWLEDGE_SETTINGS_REPLY_INVALID')
  return settings
}
