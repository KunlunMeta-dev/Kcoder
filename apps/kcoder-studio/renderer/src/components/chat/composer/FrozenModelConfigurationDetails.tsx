import { useTranslation } from '@/hooks/useTranslation'
import { readModelConfiguration } from '../../../../../shared/modelConfiguration'

/** Show only the safe host-authored frozen projection; old evidence stays unknown. */
export function FrozenModelConfigurationDetails({
  configuration,
  selectionSource,
  layout = 'compact',
}: {
  configuration: unknown
  selectionSource?: string
  layout?: 'compact' | 'table'
}) {
  const { t } = useTranslation('localRuntime')
  const summary = readModelConfiguration(configuration)
  const label = (key: string) => t(`modelConfiguration.${key}`)
  if (!summary) return <p>{label('snapshotUnknown')}</p>
  if (layout === 'table') {
    const tools = summary.toolSet
    const rows = [
      [
        label('session_snapshot'),
        `${summary.providerId ?? label('unknown')} / ${summary.modelId} · ${summary.apiFormat ?? label('unknown')}`,
      ],
      [
        label('context_window_tokens'),
        `${summary.contextWindowTokens?.toLocaleString() ?? label('unknown')} · ${label('max_output_tokens')}: ${summary.maxOutputTokens?.toLocaleString() ?? label('unknown')}`,
      ],
      ...Object.entries(summary.requestOutputLimits).map(([field, value]) => [
        field,
        value?.toLocaleString() ?? label('unknown'),
      ]),
      [label('reasoning_effort'), summary.reasoningEffort ?? label('notSet')],
      [
        label('reasoning_policy'),
        summary.reasoningPolicy
          ? label(`policy_${summary.reasoningPolicy.mode}`)
          : label('unknown'),
      ],
      [label('tools.profile'), tools?.profile ?? label('unknown')],
      [label('registryScope'), tools ? label(`registry_${tools.registryScope}`) : label('unknown')],
      [
        label('registeredToolCount'),
        `${tools?.registeredToolCount ?? label('unknown')} · ${label('exposedToolCount')}: ${tools?.exposedToolCount ?? label('unknown')}`,
      ],
      [
        label('sources'),
        summary.sources['tools.profile']?.map(source => label(`source_${source}`)).join(' · ') ||
          label('unknown'),
      ],
      [label('revision'), summary.revision.slice(0, 12)],
    ]
    return (
      <div className="min-w-0 space-y-3" data-testid="frozen-model-configuration">
        {selectionSource === 'explicit_runtime' && (
          <p className="text-text-secondary">{label('explicitRuntime')}</p>
        )}
        <dl className="space-y-2 text-sm">
          {rows.map(([name, value]) => (
            <div key={name} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
              <dt className="text-text-secondary">{name}</dt>
              <dd className="min-w-0 break-words tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs leading-relaxed text-text-muted">{label('toolCountHelp')}</p>
      </div>
    )
  }
  return (
    <div className="space-y-1" data-testid="frozen-model-configuration">
      <p>
        {label('session_snapshot')}: {summary.providerId ?? label('unknown')} / {summary.modelId} ·{' '}
        {summary.apiFormat ?? label('unknown')}
      </p>
      {selectionSource === 'inherited_session' && <p>{label('inheritedSession')}</p>}
      {selectionSource === 'explicit_runtime' && <p>{label('explicitRuntime')}</p>}
      <p>
        {label('context_window_tokens')}: {summary.contextWindowTokens ?? label('unknown')} ·{' '}
        {label('max_output_tokens')}: {summary.maxOutputTokens ?? label('unknown')}
      </p>
      {Object.entries(summary.requestOutputLimits).map(([field, value]) => (
        <p key={field}>
          {field}: {value ?? label('unknown')}
        </p>
      ))}
      <p>
        {label('reasoning_effort')}: {summary.reasoningEffort ?? label('notSet')} ·{' '}
        {label('reasoning_policy')}:{' '}
        {summary.reasoningPolicy
          ? label(`policy_${summary.reasoningPolicy.mode}`)
          : label('unknown')}
      </p>
      <ModelToolSetDetails configuration={summary} />
      <p>
        {label('revision')}: {summary.revision.slice(0, 12)}
      </p>
    </div>
  )
}

export function ModelToolSetDetails({ configuration }: { configuration: unknown }) {
  const { t } = useTranslation('localRuntime')
  const summary = readModelConfiguration(configuration)
  const label = (key: string) => t(`modelConfiguration.${key}`)
  const tools = summary?.toolSet
  return (
    <div className="space-y-1" data-testid="model-tool-set">
      <p>
        {label('tools.profile')}: {tools?.profile ?? label('unknown')} · {label('registryScope')}:{' '}
        {tools ? label(`registry_${tools.registryScope}`) : label('unknown')}
      </p>
      <p>
        {label('registeredToolCount')}: {tools?.registeredToolCount ?? label('unknown')} ·{' '}
        {label('exposedToolCount')}: {tools?.exposedToolCount ?? label('unknown')}
      </p>
      <p>{label('toolCountHelp')}</p>
      <p>
        {label('sources')}:{' '}
        {summary?.sources['tools.profile']?.map(source => label(`source_${source}`)).join(' · ') ||
          label('unknown')}
      </p>
    </div>
  )
}
