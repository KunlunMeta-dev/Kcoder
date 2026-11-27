import i18n from '@/i18n'
import { createRandomUuid } from '@/lib/random-id'
import { hookTargetScope } from './gatewayHookConfiguration'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

const operations = new Set([
  'attachment/upload/start',
  'attachment/upload/chunk',
  'attachment/upload/finish',
  'attachment/upload/cancel',
  'attachment/delete',
  'workspace/file/importAttachment',
])
const clientScopes = new WeakMap<object, string>()
function clientScope(client: object): string {
  let token = clientScopes.get(client)
  if (!token) {
    token = createRandomUuid()
    clientScopes.set(client, token)
  }
  return token
}
export async function requestWorkspaceFiles(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  accountValid: (serverId: string) => boolean
) {
  const operation = text(params.method)
  const targetId = text(params.deviceId)
  const workspace = text(params.workspacePath)
  if (!operation || !operations.has(operation) || !targetId || !workspace)
    throw new Error('Invalid workspace upload request')
  const assertCurrent = () => {
    if (this.disposed || !accountValid(targetId))
      throw new Error(i18n.t('common:workspace_upload_target_changed'))
  }
  assertCurrent()
  const target = await this.serverForParams({ deviceId: targetId })
  const scope = hookTargetScope(target)
  const client = await this.commandClient(target, workspace)
  const token = clientScope(client)
  assertCurrent()
  if (hookTargetScope(await this.serverForParams({ deviceId: targetId })) !== scope)
    throw new Error(i18n.t('common:workspace_upload_target_changed'))
  if (client.supportsExperimental?.('workspaceFileImportV1') !== true)
    throw new Error(i18n.t('common:workspace_upload_upgrade'))
  if (operation !== 'attachment/upload/start' && params.expectedScopeToken !== token)
    throw new Error(i18n.t('common:workspace_upload_target_changed'))
  const result = await client.request(operation, record(params.params))
  assertCurrent()
  const after = await this.serverForParams({ deviceId: targetId })
  if (hookTargetScope(after) !== scope)
    throw new Error(i18n.t('common:workspace_upload_target_changed'))
  if (clientScope(await this.commandClient(after, workspace)) !== token)
    throw new Error(i18n.t('common:workspace_upload_target_changed'))
  assertCurrent()
  return operation === 'attachment/upload/start' ? { ...record(result), scopeToken: token } : result
}
