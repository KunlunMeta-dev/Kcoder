import {
  summarizePreview,
  type ExtensionConflictsPreviewResult,
  type ExtensionInventoryItem,
  type ExtensionSourceRef,
  type ExtensionUpstream,
} from './extensionsInventory'

/** Translator bound to the `extensions` namespace. */
export type Translate = (key: string, options?: Record<string, unknown>) => string

/** Localized source label such as "Built-in" or "Plugin lark". */
export function sourceLabel(
  t: Translate,
  ref: Pick<ExtensionSourceRef, 'layer' | 'ownerPluginId'>,
  plugins: Map<string, string>
): string {
  if (ref.layer === 'plugin') {
    const name = ref.ownerPluginId ? (plugins.get(ref.ownerPluginId) ?? ref.ownerPluginId) : ''
    return name ? t('layer.plugin', { name }) : t('layer.pluginUnnamed')
  }
  return t(`layer.${ref.layer}`)
}

export function itemState(item: ExtensionInventoryItem): {
  key: string
  variant: 'neutral' | 'success' | 'destructive'
} {
  if (item.kind === 'binary' && !item.enabled && !item.path)
    return { key: 'state.notFound', variant: 'neutral' }
  if (!item.enabled && item.disabledBy)
    return { key: `state.disabledBy.${item.disabledBy}`, variant: 'neutral' }
  // Neutral: a long list of in-use rows must not read as green (DESIGN.md 4.2).
  if (item.effective) return { key: 'state.effective', variant: 'neutral' }
  if (item.shadowedBy) return { key: 'state.shadowed', variant: 'neutral' }
  return { key: 'state.inactive', variant: 'neutral' }
}

export function upstreamRows(
  t: Translate,
  upstream: ExtensionUpstream | null | undefined
): Array<[string, string | null | undefined]> {
  return [
    [t('detail.repository'), upstream?.repository],
    [t('detail.ref'), upstream?.ref],
    [t('detail.upstreamVersion'), upstream?.version],
  ]
}

/** One-line localized summary, e.g. "Installs 28 skills; 25 will be overridden by built-in lark-*". */
export function previewSummaryText(
  t: Translate,
  result: ExtensionConflictsPreviewResult,
  installed: boolean
): string | null {
  const summary = summarizePreview(result)
  const parts: string[] = []
  if (summary.skills > 0)
    parts.push(t(installed ? 'preview.provides' : 'preview.installs', { count: summary.skills }))
  if (summary.shadowed > 0) {
    const shadowed = result.entries.filter(entry => entry.outcome === 'shadowed_by_existing')
    const builtin = shadowed.every(
      entry => entry.existing?.layer === 'builtin' || entry.existing?.layer === 'bundled'
    )
    let text = t(builtin ? 'preview.shadowedByBuiltin' : 'preview.shadowedByExisting', {
      count: summary.shadowed,
      names: summary.shadowedBy.slice(0, 4).join(', '),
    })
    if (summary.sameUpstream > 0)
      text += t('preview.note', {
        text:
          summary.sameUpstream === summary.shadowed
            ? t('preview.sameUpstreamAll')
            : t('preview.sameUpstreamSome', { count: summary.sameUpstream }),
      })
    parts.push(text)
  }
  if (summary.shadows > 0) parts.push(t('preview.shadows', { count: summary.shadows }))
  if (summary.mcpCoexisting > 0)
    parts.push(t('preview.mcpCoexists', { count: summary.mcpCoexisting }))
  const overlap = summary.shadowed > 0 || summary.shadows > 0 || summary.mcpCoexisting > 0
  if (!overlap && summary.conflicts.length === 0) return null
  return parts.join(t('preview.separator'))
}
