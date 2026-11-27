import { isActiveToolCallStatus } from '@wegent/chat-core'
import i18n from '@/i18n'
import type { ToolCatalogEntry } from '@/kcoder/toolsCatalogContext'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'

export function toolActivityText(block: ToolBlock, catalog: ReadonlyMap<string, ToolCatalogEntry>): string {
  const text = catalog.get(block.toolName)?.displayText ?? block.displayText
  const locale = i18n.resolvedLanguage ?? i18n.language
  return text?.[locale] ?? text?.[locale.split('-')[0]] ?? text?.en ??
    i18n.t('turn_process.tool_activity', { ns: 'chat' })
}

/** Latest unfinished tool wins; completing it reveals an older still-running parallel call. */
export function latestProcessActivity(blocks: readonly ProcessingBlock[],
  catalog: ReadonlyMap<string, ToolCatalogEntry>, describing = false, thinkingActive = true): string | undefined {
  let latest: ToolBlock | undefined
  for (const block of blocks) {
    if (block.type === 'tool' && isActiveToolCallStatus(block.status) &&
      (!latest || block.createdAt >= latest.createdAt)) latest = block
  }
  if (latest) return toolActivityText(latest, catalog)
  if (describing) return i18n.t('turn_process.describing', { ns: 'chat' })
  if (thinkingActive && blocks.some(block => block.type === 'thinking' && isActiveToolCallStatus(block.status)))
    return i18n.t('turn_process.analyzing', { ns: 'chat' })
  return undefined
}
