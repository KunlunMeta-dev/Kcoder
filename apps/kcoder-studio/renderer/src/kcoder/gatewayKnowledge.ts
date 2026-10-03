import i18n from '@/i18n'
import { hookTargetScope } from './gatewayHookConfiguration'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

export const KNOWLEDGE_OPERATIONS = [
  'knowledge/attachment/digest',
  'knowledge/source/directoryStage',
  'knowledge/source/directoryPreview',
  'knowledge/source/original/export',
  'knowledge/page/links',
  'knowledge/job/cancel',
  'knowledge/default/read',
  'knowledge/default/set',
  'knowledge/markdown/export',
  'knowledge/markdown/import',
  'knowledge/job/budget',
  'knowledge/job/budget/extend',
  'knowledge/job/overview',
  'knowledge/source/remove',
  'knowledge/source/removed',
  'knowledge/export',
  'knowledge/export/read',
  'knowledge/importArchive',
  'knowledge/archive',
  'knowledge/reindex',
  'knowledge/inspect',
  'attachment/upload/start',
  'attachment/upload/chunk',
  'attachment/upload/finish',
  'attachment/upload/cancel',
  'attachment/delete',
  'knowledge/source/importAttachment',
  'knowledge/update',
  'knowledge/page/edit',
  'knowledge/page/history',
  'knowledge/page/restore',
  'knowledge/review/read',
  'knowledge/review/page',
  'knowledge/review/decide',
  'knowledge/citation/resolve',
  'knowledge/job/start',
  'knowledge/job/get',
  'knowledge/job/list',
  'knowledge/job/pause',
  'knowledge/job/resume',
  'knowledge/status',
  'knowledge/configure',
  'knowledge/list',
  'knowledge/create',
  'knowledge/read',
  'knowledge/search',
  'knowledge/source/importText',
  'knowledge/source/list',
  'knowledge/source/read',
  'knowledge/page/list',
  'knowledge/page/read',
] as const

export async function requestKnowledge(
  this: GatewayRuntimeCore,
  params: Record<string, unknown>,
  accountValid: (serverId: string) => boolean
): Promise<unknown> {
  const operation = text(params.method)
  if (!KNOWLEDGE_OPERATIONS.some(candidate => candidate === operation))
    throw new Error(i18n.t('knowledge:unsupportedOperation'))
  const targetId = text(params.serverId)
  if (!targetId) throw new Error(i18n.t('knowledge:targetRequired'))
  const assertAccount = () => {
    if (this.disposed || !accountValid(targetId)) throw new Error(i18n.t('knowledge:scopeChanged'))
  }
  assertAccount()
  const target = await this.serverForParams({ deviceId: targetId })
  const scope = hookTargetScope(target)
  assertAccount()
  const client = await this.commandClient(target)
  assertAccount()
  if (hookTargetScope(await this.serverForParams({ deviceId: targetId })) !== scope)
    throw new Error(i18n.t('knowledge:scopeChanged'))
  if (client.supportsExperimental?.('knowledgeCatalogV1') !== true)
    throw new Error(i18n.t('knowledge:upgradeRequired'))
  if (
    operation === 'knowledge/source/importAttachment' &&
    /\.(html|htm)$/i.test(text(record(params.params).title) ?? '') &&
    client.supportsExperimental?.('knowledgeHtmlV1') !== true
  )
    throw new Error(i18n.t('knowledge:upgradeRequired'))
  if (
    (operation === 'knowledge/source/original/export' ||
      operation === 'knowledge/source/directoryPreview' ||
      (operation === 'knowledge/source/directoryStage' &&
        record(params.params).selectedTitles !== undefined)) &&
    client.supportsExperimental?.('knowledgeOriginalFilesV1') !== true
  )
    throw new Error(i18n.t('knowledge:upgradeRequired'))
  if (
    operation?.startsWith('knowledge/job/') &&
    client.supportsExperimental?.('knowledgeIngestV1') !== true
  )
    throw new Error(i18n.t('knowledge:upgradeRequired'))
  assertAccount()
  const result = await client.request(operation!, record(params.params))
  assertAccount()
  if (hookTargetScope(await this.serverForParams({ deviceId: targetId })) !== scope)
    throw new Error(i18n.t('knowledge:scopeChanged'))
  return result
}
