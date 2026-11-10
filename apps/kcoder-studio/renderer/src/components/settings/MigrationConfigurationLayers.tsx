import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import type {
  MigrationConfigurationLayersTarget,
  MigrationConfigurationLayersResult,
} from '../../../../shared/generated/contracts'

export function MigrationConfigurationLayers(props: {
  deviceId: string
  workspacePath?: string
  target: MigrationConfigurationLayersTarget
  isCurrent(): boolean
  readSource?: (sourceId: string, pageIndex: number, signal?: AbortSignal) => Promise<MigrationConfigurationLayersResult>
}) {
  const { deviceId, workspacePath, isCurrent, readSource } = props
  const targetJson = JSON.stringify(props.target)
  const target = useMemo(
    () => JSON.parse(targetJson) as MigrationConfigurationLayersTarget,
    [targetJson]
  )
  const { t } = useTranslation('migration')
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const scope = JSON.stringify([deviceId, workspacePath, targetJson])
  const [open, setOpen] = useState<string | null>(null)
  const [page, setPage] = useState({ scope, index: 0 })
  const [snapshot, setSnapshot] = useState<{
    scope: string
    index: number
    value?: MigrationConfigurationLayersResult
    error?: boolean
    updateRequired?: boolean
  } | null>(null)
  const expanded = open === scope
  const index = page.scope === scope ? page.index : 0
  useEffect(() => {
    if (!expanded || !isCurrent()) return
    const abort = new AbortController()
    const request = readSource && target.kind === 'source'
      ? readSource(target.sourceId, index, abort.signal)
      : api.configurationLayers({ target, pageIndex: index }, { signal: abort.signal })
    void request.then(
      value => {
        if (!abort.signal.aborted && isCurrent()) setSnapshot({ scope, index, value })
      },
      failure => {
        const updateRequired = failure && typeof failure === 'object' && 'code' in failure && failure.code === 'source_transfer_configuration_layers_update_required'
        if (!abort.signal.aborted && isCurrent()) setSnapshot({ scope, index, error: true, updateRequired: !!updateRequired })
      }
    )
    return () => abort.abort()
  }, [api, scope, index, expanded, isCurrent, target, readSource])
  const current =
    snapshot?.scope === scope && snapshot.index === index && isCurrent() ? snapshot : null
  const value = current?.value
  const move = (next: number) => {
    if (isCurrent()) {
      setSnapshot(null)
      setPage({ scope, index: next })
    }
  }
  return (
    <section className="mt-2 space-y-2" data-testid="migration-layer-report">
      <Button
        size="sm"
        variant="ghost"
        data-testid="migration-layer-toggle"
        aria-expanded={expanded}
        onClick={() => {
          if (isCurrent()) setOpen(expanded ? null : scope)
        }}
      >
        {t('layers.title')}
      </Button>
      {expanded && (
        <div
          className="space-y-2 rounded-md bg-surface p-3 text-sm"
          data-testid="migration-layer-details"
          aria-busy={!current}
        >
          <p className="text-text-secondary">{t('layers.boundary')}</p>
          {!current && <p role="status">{t('layers.loading')}</p>}
          {current?.error && <p role="alert">{t(current.updateRequired ? 'layers.updateRequired' : 'layers.failed')}</p>}
          {value && value.status !== 'available' && <p>{t(`layers.${value.status}`)}</p>}
          {value?.status === 'available' && (
            <>
              <p>
                {value.layers
                  .map(
                    layer =>
                      `${t(`layers.${layer.scope}`)}: ${t(layer.present ? 'layers.present' : 'layers.absent')}`
                  )
                  .join(' · ')}
              </p>
              <p className="text-text-secondary">{t('layers.precedence')}</p>
              <ul className="divide-y divide-border">
                {value.fields.map(field => (
                  <li
                    key={field.ordinal}
                    className="py-2 break-words"
                    data-testid="migration-layer-field"
                  >
                    <span className="font-medium">
                      {field.field ?? t('layers.unknown', { n: field.ordinal + 1 })}
                    </span>
                    <p>
                      {t(field.supported ? 'layers.supported' : 'layers.unsupported')}
                      {field.private ? ` · ${t('layers.private')}` : ''}
                    </p>
                    <p className="text-text-secondary">
                      {field.scopes.map(scope => t(`layers.${scope}`)).join(' → ')}
                      {field.supported
                        ? ` · ${t('layers.winner')}: ${t(`layers.${field.scopes.at(-1)}`)}`
                        : ''}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="text-text-secondary">
                {t('layers.unobserved')}:{' '}
                {value.unobserved.map(name => t(`layers.${name}`)).join('、')}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{t('layers.page', { page: index + 1, total: value.totalFields })}</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="migration-layer-previous"
                    disabled={index === 0}
                    onClick={() => move(index - 1)}
                  >
                    {t('previous')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="migration-layer-next"
                    disabled={value.nextPage == null}
                    onClick={() => move(value.nextPage!)}
                  >
                    {t('next')}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
