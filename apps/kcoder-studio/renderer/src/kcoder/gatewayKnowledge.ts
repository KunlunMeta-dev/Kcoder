import i18n from '@/i18n'
import { hookTargetScope } from './gatewayHookConfiguration'
import { record, text } from './gateway/runtime/contracts'
import type { GatewayRuntimeCore } from './gateway/runtime/core'

export const KNOWLEDGE_OPERATIONS = [
  'knowledge/imageImport/list',
  'knowledge/imageImport/resume',
  'knowledge/imageImport/cancel',
  'knowledge/fileCapabilities',
  'knowledge/archiveTransfer/capabilities',
  'knowledge/archiveTransfer/exportStart',
  'knowledge/archiveTransfer/importStart',
  'knowledge/archiveTransfer/status',
  'knowledge/archiveTransfer/read',
  'knowledge/archiveTransfer/chunk',
  'knowledge/archiveTransfer/importFinish',
  'knowledge/archiveTransfer/cancel',
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
  accountValid: (serverId: string) => boolean,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const operation = text(params.method)
  if (!KNOWLEDGE_OPERATIONS.some(candidate => candidate === operation))
    throw new Error(i18n.t('knowledge:unsupportedOperation'))
  const targetId = text(params.serverId)
  if (!targetId) throw new Error(i18n.t('knowledge:targetRequired'))
  const assertAccount = () => {
    options?.signal?.throwIfAborted()
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
    operation?.startsWith('knowledge/imageImport/') &&
    client.supportsExperimental?.('knowledgeImageImportV1') !== true
  ) {
    if (operation === 'knowledge/imageImport/list')
      return { supported: false, items: [], nextAfterId: null }
    throw new Error(i18n.t('knowledge:upgradeRequired'))
  }
  if (
    operation?.startsWith('knowledge/archiveTransfer/') &&
    client.supportsExperimental?.('knowledgeArchiveStreamV1') !== true
  ) {
    if (operation === 'knowledge/archiveTransfer/capabilities') return { supported: false }
    throw new Error(i18n.t('knowledge:upgradeRequired'))
  }
  if (
    operation === 'knowledge/fileCapabilities' &&
    client.supportsExperimental?.('knowledgeFileCapabilitiesV1') !== true
  ) {
    return { supported: false, items: [], batchMaxFiles: 10, batchMaxBytes: 128 * 1024 * 1024 }
  }
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
  const result =
    options === undefined
      ? await client.request(operation!, record(params.params))
      : await client.request(operation!, record(params.params), options)
  assertAccount()
  if (hookTargetScope(await this.serverForParams({ deviceId: targetId })) !== scope)
    throw new Error(i18n.t('knowledge:scopeChanged'))
  return result
}
