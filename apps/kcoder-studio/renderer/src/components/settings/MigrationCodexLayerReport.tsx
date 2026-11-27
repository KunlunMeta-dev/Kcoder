import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createMigrationApi } from '@/kcoder/gatewayMigration'
import type {
  MigrationConfigurationLayersTarget,
  MigrationCodexLayersReadResult,
} from '../../../../shared/generated/contracts'
export function MigrationCodexLayerReport({
  deviceId,
  workspacePath,
  target: input,
  isCurrent,
  readSource,
}: {
  deviceId: string
  workspacePath?: string
  target: MigrationConfigurationLayersTarget
  isCurrent(): boolean
  readSource?: (sourceId: string, pageIndex: number, signal?: AbortSignal) => Promise<MigrationCodexLayersReadResult>
}) {
  const { t } = useTranslation('migration')
  const json = JSON.stringify(input),
    target = useMemo(() => JSON.parse(json) as MigrationConfigurationLayersTarget, [json])
  const api = useMemo(() => createMigrationApi(deviceId, workspacePath), [deviceId, workspacePath])
  const scope = JSON.stringify([deviceId, workspacePath, json])
  const [open, setOpen] = useState<string | null>(null),
    [page, setPage] = useState({ scope, index: 0 })
  const [state, setState] = useState<{
    scope: string
    index: number
    value?: MigrationCodexLayersReadResult
    error?: boolean
  } | null>(null)
  const index = page.scope === scope ? page.index : 0,
    expanded = open === scope
  useEffect(() => {
    if (!expanded || !isCurrent()) return
    const abort = new AbortController()
    const request = readSource && target.kind === 'source'
      ? readSource(target.sourceId, index, abort.signal)
      : api.codexLayersRead({ target, pageIndex: index }, { signal: abort.signal })
    void request.then(
      value => {
        if (!abort.signal.aborted && isCurrent()) setState({ scope, index, value })
      },
      () => {
        if (!abort.signal.aborted && isCurrent()) setState({ scope, index, error: true })
      }
    )
    return () => abort.abort()
  }, [api, target, scope, index, expanded, isCurrent, readSource])
  const current = state?.scope === scope && state.index === index && isCurrent() ? state : null,
    value = current?.value
  const label = (layer: number) => {
    const row = value?.layers[layer]
    return row
      ? t(`codex_layers.${row.kind}`, {
          n:
            row.kind === 'project'
              ? value!.layers.slice(0, layer + 1).filter(item => item.kind === 'project').length
              : 0,
        })
      : ''
  }
  const move = (next: number) => {
    if (isCurrent()) {
      setState(null)
      setPage({ scope, index: next })
    }
  }
  return (
    <section data-testid="migration-codex-report" className="mt-2 space-y-2">
      <Button
        size="sm"
        variant="ghost"
        data-testid="migration-codex-report-toggle"
        aria-expanded={expanded}
        onClick={() => {
          if (isCurrent()) setOpen(expanded ? null : scope)
        }}
      >
        {t('codex_layers.title')}
      </Button>
      {expanded && (
        <div
          data-testid="migration-codex-report-details"
          className="space-y-2 rounded-md bg-surface p-3 text-sm"
          aria-busy={!current}
        >
          <p className="text-text-secondary">{t('codex_layers.boundary')}</p>
          {!current && <p role="status">{t('layers.loading')}</p>}
          {current?.error && <p role="alert">{t('layers.failed')}</p>}
          {value && value.status !== 'available' && <p>{t(`layers.${value.status}`)}</p>}
          {value?.status === 'available' && (
            <>
              <p>
                {value.layers
                  .map(
                    layer =>
                      `${label(layer.index)}: ${t(layer.present ? 'layers.present' : 'layers.absent')}`
                  )
                  .join(' · ')}
              </p>
              <p className="text-text-secondary">{t('codex_layers.precedence')}</p>
              <ul className="divide-y divide-border">
                {value.fields.map((field, i) => (
                  <li key={i} className="break-words py-2" data-testid="migration-codex-field">
                    <span className="font-medium">
                      {field.field ?? t('layers.unknown', { n: index * 10 + i + 1 })}
                      {field.providerIndex != null
                        ? ` · ${t('codex_layers.provider', { n: field.providerIndex + 1 })}`
                        : ''}
                    </span>
                    <p>
                      {t(
                        field.ignored
                          ? 'codex_layers.ignored'
                          : field.supported
                            ? 'layers.supported'
                            : 'layers.unsupported'
                      )}
                      {field.private ? ` · ${t('layers.private')}` : ''}
                    </p>
                    <p className="text-text-secondary">
                      {t('codex_layers.origin')}: {label(field.layer)}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="text-text-secondary">
                {t('layers.unobserved')}:{' '}
                {value.unobserved.map(name => t(`codex_layers.${name}`)).join('、')}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{t('layers.page', { page: index + 1, total: value.totalFields })}</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="migration-codex-previous"
                    disabled={index === 0}
                    onClick={() => move(index - 1)}
                  >
                    {t('previous')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="migration-codex-next"
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
