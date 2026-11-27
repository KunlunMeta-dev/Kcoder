import { isContract } from '../../../shared/generated/validator.mjs'
import type { OfficeSettingsReadResult } from '../../../shared/generated/contracts'
import { captureAccountContextRevision } from './accountContextEvents'
import { hookTargetScope } from './gatewayHookConfiguration'
import { GatewayRpcError } from './gatewayRpc'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

const READ = 'settings/integrations/office/read'
const SAVE = 'settings/integrations/office/save'
export function isOfficeSettingsMethod(value: unknown): boolean {
  return value === READ || value === SAVE
}

/** Settings stay target-owned and separately negotiated while the Office feature is disabled. */
export async function requestOfficeSettings(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<OfficeSettingsReadResult> {
  const method = text(params.method)
  const serverId = text(params.serverId)
  const fields = structuredClone(record(params.params))
  if (
    !isOfficeSettingsMethod(method) ||
    !serverId ||
    (method === READ
      ? Object.keys(fields).length > 0
      : !isContract('OfficeSettingsSaveParams', fields) ||
        !/^[a-f0-9]{64}$/i.test(String(fields.expectedRevision)))
  )
    throw new Error('OFFICE_SETTINGS_INVALID_REQUEST')
  const accountCurrent = captureAccountContextRevision()
  const generation = this.configurationEpochByTarget.get(serverId)
  const check = () => {
    options?.signal?.throwIfAborted()
    if (this.disposed || this.configurationEpochByTarget.get(serverId) !== generation || !accountCurrent(serverId))
      throw new Error('OFFICE_SETTINGS_TARGET_CHANGED')
  }
  check()
  const target = await this.serverForParams({ deviceId: serverId })
  await this.assertCommandTarget(target)
  const identity = hookTargetScope(target)
  check()
  const client = await this.commandClient(target, text(params.workspacePath) ?? undefined)
  check()
  if (hookTargetScope(await this.serverForParams({ deviceId: serverId })) !== identity)
    throw new Error('OFFICE_SETTINGS_TARGET_CHANGED')
  check()
  if (client.supportsExperimental?.('officeSettingsV1') !== true)
    throw new GatewayRpcError('Target does not support Office settings', -32000, {
      kind: 'office_settings_unsupported',
      capability: 'officeSettingsV1',
    })
  const result = await client.request<unknown>(method!, fields, options)
  check()
  if (hookTargetScope(await this.serverForParams({ deviceId: serverId })) !== identity)
    throw new Error('OFFICE_SETTINGS_TARGET_CHANGED')
  check()
  if (!isContract('OfficeSettingsReadResult', result))
    throw new Error('OFFICE_SETTINGS_REPLY_INVALID')
  const settings = result as OfficeSettingsReadResult
  if (
    !(settings.persistedEnabled === null || typeof settings.persistedEnabled === 'boolean') ||
    !/^[a-f0-9]{64}$/i.test(settings.revision) ||
    settings.restartRequired !== (settings.effectiveEnabled !== settings.connectionEnabled)
  )
    throw new Error('OFFICE_SETTINGS_REPLY_INVALID')
  return settings
}
