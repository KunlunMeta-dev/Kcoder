import { useTranslation } from '@/hooks/useTranslation'
import type { UnifiedModel } from '@/types/api'
import {
  readModelConfiguration,
  readModelExecutionScope,
} from '../../../../../shared/modelConfiguration'

export function ModelConfigurationDetails({
  model,
  onLayoutChange,
}: {
  model: UnifiedModel | null | undefined
  onLayoutChange?: () => void
}) {
  const { t } = useTranslation('localRuntime')
  const next = readModelConfiguration(model?.config?.modelConfiguration)
  const active = readModelConfiguration(model?.config?.activeModelConfiguration)
  const scope = readModelExecutionScope(model?.config?.modelExecutionScope)
  if (!next) return null
  const label = (key: string) => t(`modelConfiguration.${key}`)
  return (
    <details
      data-testid="model-configuration-details"
      onToggle={() => window.requestAnimationFrame(() => onLayoutChange?.())}
      className="mx-2 mt-2 border-t border-border pt-2 text-xs"
    >
      <summary className="cursor-pointer rounded-sm px-1 py-1 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {label('title')}
      </summary>
      <div className="space-y-3 px-1 py-2">
        {scope && (
          <p className="break-words text-muted-foreground">
            {scope.targetId} ·{' '}
            {scope.accountMode === 'shared'
              ? label('shared')
              : (scope.username ?? label('signedOut'))}
          </p>
        )}
        {[...(active ? [active] : []), next].map(summary => (
          <section
            key={summary.boundary}
            className="space-y-1"
            data-testid={`model-configuration-${summary.boundary}`}
          >
            <p className="font-medium">{label(summary.boundary)}</p>
            <p className="break-all text-muted-foreground">
              {summary.providerId} / {summary.modelId} · {summary.apiFormat ?? label('unknown')}
            </p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1">
              <dt>{label('context_window_tokens')}</dt>
              <dd>{summary.contextWindowTokens?.toLocaleString() ?? label('unknown')}</dd>
              <dt>{label('max_output_tokens')}</dt>
              <dd>{summary.maxOutputTokens?.toLocaleString() ?? label('unknown')}</dd>
              {Object.entries(summary.requestOutputLimits).map(([field, value]) => (
                <div key={field} className="col-span-2 flex flex-wrap justify-between gap-1">
                  <dt>{field}</dt>
                  <dd>{value?.toLocaleString() ?? label('unknown')}</dd>
                </div>
              ))}
              <dt>{label('reasoning_effort')}</dt>
              <dd>{summary.reasoningEffort ?? label('notSet')}</dd>
              <dt>{label('reasoning_policy')}</dt>
              <dd>{summary.reasoningPolicy ? label(`policy_${summary.reasoningPolicy.mode}`) : label('unknown')}</dd>
              <dt>{label('extra_body')}</dt>
              <dd>{label(summary.extraBodyConfigured ? 'configured' : 'notSet')}</dd>
            </dl>
            <details className="text-muted-foreground" data-testid="model-capability-declarations">
              <summary className="cursor-pointer">{label('capabilities')}</summary>
              <dl className="mt-1 space-y-1">
                {(['text', 'tools', 'vision', 'reasoning', 'structured_output'] as const).map(
                  capability => {
                    const explicit = summary.sources[`capabilities.${capability}`]?.some(
                      source => source !== 'default' && source !== 'session_snapshot'
                    )
                    const enabled =
                      capability === 'structured_output'
                        ? summary.structuredOutput
                        : summary[capability]
                    return (
                      <div key={capability} className="flex justify-between gap-2">
                        <dt>{label(`capability_${capability}`)}</dt>
                        <dd>{label(explicit ? (enabled ? 'allowed' : 'disabled') : 'unknown')}</dd>
                      </div>
                    )
                  }
                )}
              </dl>
              <p className="mt-1">{label('capabilityHelp')}</p>
            </details>
            {summary.requestOverrideFields.length > 0 && (
              <p className="break-words text-muted-foreground">
                {label('requestOverrides')}: {summary.requestOverrideFields.join(', ')}
              </p>
            )}
            <p className="text-muted-foreground">
              {label('revision')}: {summary.revision.slice(0, 12)}
            </p>
            <details className="text-muted-foreground">
              <summary className="cursor-pointer">{label('sources')}</summary>
              <dl className="mt-1 space-y-1">
                {Object.entries(summary.sources)
                  .filter(([field]) => !field.startsWith('capabilities.'))
                  .map(([field, sources]) => (
                    <div key={field} className="flex flex-wrap justify-between gap-x-2">
                      <dt>{label(field)}</dt>
                      <dd>{sources.map(source => label(`source_${source}`)).join(' · ')}</dd>
                    </div>
                  ))}
              </dl>
            </details>
          </section>
        ))}
        <p className="text-muted-foreground">{label('policyHelp')}</p>
        <p className="text-muted-foreground">{label('boundaryHelp')}</p>
      </div>
    </details>
  )
}
