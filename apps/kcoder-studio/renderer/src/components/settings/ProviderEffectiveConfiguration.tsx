import { useId, useState } from 'react'
import { Box, Download, Settings2, X } from 'lucide-react'
import type { ModelConfigurationSummary } from '../../../../shared/modelConfiguration'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProviderProfile, ProviderSettings } from '@/kcoder/providerSettings'
import { downloadLink } from '@/kcoder/downloadLink'
import { Button } from '@/components/ui/button'

export function ProviderEffectiveConfiguration({
  settings,
  profile,
  busy,
  clear,
  onEdit,
}: {
  settings: ProviderSettings
  profile?: ProviderProfile
  busy: boolean
  clear: (field: string) => void
  onEdit?: () => void
}) {
  const { t, i18n } = useTranslation('common')
  const label = (key: string) => t(`providerSettings.${key}`)
  const id = useId()
  const [selected, setSelected] = useState(
    settings.currentTurnConfiguration ? 'effectiveSnapshot' : 'effectiveProfile'
  )
  const value = (item: string | number | null | undefined) =>
    typeof item === 'number'
      ? item.toLocaleString(i18n.resolvedLanguage)
      : (item ?? label('effectiveUnknown'))
  const fieldLabels: Record<string, string> = {
    max_output_tokens: label('maxOutputTokens'),
    context_window_tokens: label('contextWindowTokens'),
    reasoning_effort: label('reasoningEffort'),
    extra_body: label('extraBody'),
  }
  const summaries: [string, ModelConfigurationSummary | undefined][] = [
    ...(settings.currentTurnConfiguration
      ? [
          ['effectiveSnapshot', settings.currentTurnConfiguration] as [
            string,
            ModelConfigurationSummary,
          ],
        ]
      : []),
    ['effectiveProfile', profile?.profileConfiguration],
    ['effectiveNextTurn', profile?.nextTurnConfiguration],
  ]
  const active = summaries.some(([title]) => title === selected) ? selected : 'effectiveProfile'
  const exportConfiguration = () => {
    // Export only the host-authored safe projection, never provider credentials.
    const blob = new Blob([JSON.stringify(Object.fromEntries(summaries), null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'model-configuration.json'
    downloadLink(link)
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div data-testid="provider-effective-configuration" className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label={label('effectiveDetails')}
          className="flex max-w-full flex-wrap gap-1 rounded-xl border border-border/60 bg-background p-1"
        >
          {summaries.map(([title], index) => (
            <button
              key={title}
              type="button"
              role="tab"
              id={`${id}-${title}-tab`}
              aria-controls={`${id}-${title}`}
              aria-selected={active === title}
              tabIndex={active === title ? 0 : -1}
              data-testid={`provider-tab-${title}`}
              onClick={() => setSelected(title)}
              onKeyDown={event => {
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? summaries.length - 1
                      : event.key === 'ArrowRight'
                        ? (index + 1) % summaries.length
                        : event.key === 'ArrowLeft'
                          ? (index + summaries.length - 1) % summaries.length
                          : null
                if (next === null) return
                event.preventDefault()
                setSelected(summaries[next][0])
                document.getElementById(`${id}-${summaries[next][0]}-tab`)?.focus()
              }}
              className="min-h-9 rounded-lg px-3 py-2 text-text-secondary transition-colors hover:bg-surface aria-selected:bg-accent-surface aria-selected:font-medium aria-selected:text-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
            >
              {label(title)}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="provider-export-configuration"
          onClick={exportConfiguration}
        >
          <Download aria-hidden="true" />
          {label('exportConfiguration')}
        </Button>
      </div>
      {summaries.map(([title, summary]) => (
        <div
          key={title}
          id={`${id}-${title}`}
          role="tabpanel"
          aria-labelledby={`${id}-${title}-tab`}
          hidden={active !== title}
          data-testid={`provider-${title}`}
          className="rounded-xl border border-border/60 bg-background p-4"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 font-medium">
              <Box className="size-4" aria-hidden="true" />
              {label('basicConfiguration')}
            </h3>
            {onEdit && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid={`provider-edit-configuration-${title}`}
                onClick={onEdit}
              >
                {label('editConfiguration')}
              </Button>
            )}
          </div>
          {summary ? (
            <>
              <dl className="divide-y divide-border/50 [&>div:nth-child(even)]:bg-surface/40">
                {[
                  [
                    label('model'),
                    `${summary.providerId ?? label('effectiveUnknown')} · ${summary.modelId}`,
                  ],
                  [label('contextWindowTokens'), value(summary.contextWindowTokens)],
                  [label('maxOutputTokens'), value(summary.maxOutputTokens)],
                  [
                    label('effectiveRequestOutput'),
                    Object.entries(summary.requestOutputLimits)
                      .map(([field, limit]) => `${field}: ${value(limit)}`)
                      .join(', ') || label('effectiveUnknown'),
                  ],
                  [label('reasoningEffort'), value(summary.reasoningEffort)],
                ].map(([name, content]) => (
                  <div
                    key={name}
                    className="grid gap-1 px-2 py-2.5 sm:grid-cols-[minmax(10rem,1fr)_2fr] sm:gap-4"
                  >
                    <dt className="text-text-secondary">{name}</dt>
                    <dd className="min-w-0 break-words tabular-nums">{content}</dd>
                  </div>
                ))}
              </dl>
              <details className="mt-3 text-text-secondary">
                <summary
                  data-testid={`provider-sources-${title}`}
                  className="w-fit cursor-pointer rounded-lg py-2 focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {label('sourceTitle')}
                </summary>
                <div className="space-y-2 pb-1">
                  {Object.entries(summary.sources)
                    .filter(([field]) => field in fieldLabels)
                    .map(([field, sources]) => (
                      <p key={field}>
                        {fieldLabels[field]}:{' '}
                        {sources.map(source => label(`sourceLayer_${source}`)).join(', ')}
                      </p>
                    ))}
                </div>
              </details>
            </>
          ) : (
            <p className="text-text-secondary">{label('effectiveUnknown')}</p>
          )}
        </div>
      ))}
      {settings.supportsClearUserOverrides && Boolean(settings.clearableUserOverrides?.length) && (
        <section className="rounded-xl border border-border/60 bg-background p-4">
          <h3 className="mb-3 flex items-center gap-2 font-medium">
            <Settings2 className="size-4" aria-hidden="true" />
            {label('userOverrides')}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {settings.clearableUserOverrides?.map(field => (
              <Button
                key={field}
                type="button"
                variant="outline"
                className="h-auto min-h-10 justify-between gap-3 whitespace-normal break-all text-left max-md:min-h-11"
                disabled={busy || !settings.revision}
                aria-label={t('providerSettings.clearUserOverride', { field })}
                title={t('providerSettings.clearUserOverride', { field })}
                data-testid={`provider-clear-${field}`}
                onClick={() => clear(field)}
              >
                {field}
                <X className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
