import { useEffect, useMemo, useState } from 'react'
import { Layers } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { navigateTo } from '@/lib/navigation'
import {
  declaredPluginNames,
  type ExtensionConflictsPreviewResult,
  type ExtensionsApi,
} from '@/kcoder/extensionsInventory'
import { DetailList, Disclosure } from '@/kcoder/extensionsPresentation'
import { previewSummaryText, sourceLabel } from '@/kcoder/extensionsLabels'

function PreviewBody({
  result,
  installed,
  declaredOnly,
}: {
  result: ExtensionConflictsPreviewResult
  installed: boolean
  declaredOnly: boolean
}) {
  const { t } = useTranslation('extensions')
  const text = previewSummaryText(t, result, installed)
  const plugins = useMemo(() => new Map<string, string>(), [])
  if (!text) return null
  const overlaps = result.entries.filter(entry => entry.outcome !== 'none')
  return (
    <section
      data-testid="plugin-extension-conflicts"
      className="studio-card-spacing flex flex-col gap-1 rounded-xl border border-border/60 bg-background"
    >
      <div className="flex flex-wrap items-start gap-3">
        <Layers className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-medium">{t('preview.title')}</h3>
          <p
            className="text-sm text-text-secondary"
            data-testid="plugin-extension-conflicts-summary"
          >
            {text}
          </p>
          {result.conflicts
            .filter(conflict => conflict.reason === 'mixed_family')
            .map(conflict => (
              <p key={conflict.name} className="text-sm text-text-secondary">
                {t('preview.mixedFamily', {
                  name: conflict.name,
                  provided: (conflict.provided ?? []).length,
                  missing: (conflict.missing ?? []).length,
                })}
              </p>
            ))}
          {declaredOnly && <p className="text-xs text-text-muted">{t('preview.declaredOnly')}</p>}
        </div>
        {installed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigateTo('/plugins/manage?view=conflicts')}
          >
            {t('preview.manage')}
          </Button>
        )}
      </div>
      {overlaps.length > 0 && (
        <Disclosure summary={t('details')}>
          <DetailList
            rows={overlaps.map(entry => [
              entry.name,
              `${t(`preview.outcome.${entry.outcome}`, {
                source: entry.existing ? sourceLabel(t, entry.existing, plugins) : '',
              })}${entry.sameUpstream ? ` · ${t('detail.sameUpstream')}` : ''}${
                entry.existing?.path ? ` · ${entry.existing.path}` : ''
              }`,
            ])}
          />
        </Disclosure>
      )}
    </section>
  )
}

/**
 * Same-name overlap of a marketplace plugin with what the target already
 * resolves. Uses the install/read result when present, otherwise a read-only
 * preview. Targets without the capability render nothing.
 */
export function PluginExtensionConflicts({
  api,
  pluginId,
  manifest,
  installed,
  result,
}: {
  api: ExtensionsApi | null
  pluginId: string
  manifest?: Record<string, unknown>
  installed: boolean
  result?: ExtensionConflictsPreviewResult
}) {
  const { t } = useTranslation('extensions')
  const declared = useMemo(() => declaredPluginNames(manifest), [manifest])
  const declaredKey = JSON.stringify(declared)
  const canPreview =
    !result &&
    api !== null &&
    (installed || declared.skillNames.length > 0 || declared.mcpServerNames.length > 0)
  const [preview, setPreview] = useState<{
    key: string
    value: ExtensionConflictsPreviewResult | null
  } | null>(null)
  const key = `${pluginId}:${installed}:${declaredKey}`
  useEffect(() => {
    if (!canPreview || !api) return
    let current = true
    const names = JSON.parse(declaredKey) as typeof declared
    api
      .previewConflicts(installed ? { pluginId } : { pluginId, ...names })
      .then(value => {
        if (current) setPreview({ key, value })
      })
      // Overlap is advisory: an older or unavailable target shows nothing.
      .catch(() => {
        if (current) setPreview({ key, value: null })
      })
    return () => {
      current = false
    }
  }, [api, canPreview, declaredKey, installed, key, pluginId])
  if (result) return <PreviewBody result={result} installed declaredOnly={false} />
  if (!canPreview) return null
  if (!preview || preview.key !== key)
    return (
      <p role="status" className="text-sm text-text-muted">
        {t('preview.checking')}
      </p>
    )
  return preview.value ? (
    <PreviewBody result={preview.value} installed={installed} declaredOnly={!installed} />
  ) : null
}

/** Marketplace list notice after an install whose result reported overlap. */
export function PluginInstallOverlapNotice({
  name,
  result,
  onDismiss,
}: {
  name: string
  result: ExtensionConflictsPreviewResult
  onDismiss: () => void
}) {
  const { t } = useTranslation('extensions')
  if (!previewSummaryText(t, result, true)) return null
  return (
    <div role="status" data-testid="plugin-install-overlap" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary">
        <span>{t('preview.installed', { name })}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {t('dismiss')}
        </Button>
      </div>
      <PreviewBody result={result} installed declaredOnly={false} />
    </div>
  )
}
