import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@/components/ui/checkbox'
import { fieldClass } from './shared'
import type { KnowledgeIntegrationClient } from './client'
import { AdoptedPublicationInputs } from './AdoptedPublicationInputs'

export interface SavedBusinessInputResource {
  kind: 'artifact' | 'dataset' | 'publication'
  id: string
  revision: string
  title: string
}
interface TemplateInput {
  period?: string
  asOfDate?: string
  sourceRefs?: Array<{ kind: string; id: string; revision: string }>
  outputLanguage?: string
  requirements?: string
}
const referenceKey = (value: { kind: string; id: string; revision: string }) =>
  JSON.stringify([value.kind, value.id, value.revision])
const isReference = (value: unknown): value is { kind: string; id: string; revision: string } =>
  !!value &&
  typeof value === 'object' &&
  'kind' in value &&
  typeof value.kind === 'string' &&
  'id' in value &&
  typeof value.id === 'string' &&
  'revision' in value &&
  typeof value.revision === 'string'

export function BusinessTemplateInputs({
  value,
  resources,
  disabled,
  onChange,
  client,
  active = true,
}: {
  value: string
  resources: SavedBusinessInputResource[]
  disabled: boolean
  onChange: (next: string) => void
  client?: KnowledgeIntegrationClient
  active?: boolean
}) {
  const { t } = useTranslation('knowledgeIntegration')
  let input: TemplateInput = {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed
  } catch {
    // Keep invalid advanced JSON visible; native preview remains the validation authority.
  }
  const update = (change: Partial<TemplateInput>) =>
    onChange(JSON.stringify({ ...input, ...change }, null, 2))
  const selected = Array.isArray(input.sourceRefs) ? input.sourceRefs.filter(isReference) : []
  const unavailable = selected.some(
    reference => !resources.some(resource => referenceKey(resource) === referenceKey(reference))
  )
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="mb-3 text-sm font-medium">{t('businessInputs')}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t('reportingPeriod')}</span>
          <input
            className={fieldClass}
            value={typeof input.period === 'string' ? input.period : ''}
            onChange={event => update({ period: event.target.value })}
            data-testid="subscription-input-period"
            maxLength={128}
            required
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>{t('asOfDate')}</span>
          <input
            type="date"
            className={fieldClass}
            value={typeof input.asOfDate === 'string' ? input.asOfDate : ''}
            onChange={event => update({ asOfDate: event.target.value })}
            data-testid="subscription-input-date"
            required
          />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm">{t('approvedInputResources')}</legend>
        {client ? (
          active && (
            <AdoptedPublicationInputs
              client={client}
              selected={selected}
              disabled={disabled}
              onChange={sourceRefs => update({ sourceRefs })}
            />
          )
        ) : (
          <>
            {resources.length === 0 && (
              <p className="text-sm text-text-muted">{t('noInputResources')}</p>
            )}
            {resources.map(resource => (
              <label
                key={referenceKey(resource)}
                className="flex min-h-11 items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={selected.some(
                    reference => referenceKey(reference) === referenceKey(resource)
                  )}
                  disabled={
                    selected.length >= 16 &&
                    !selected.some(reference => referenceKey(reference) === referenceKey(resource))
                  }
                  onChange={event => {
                    const remaining = selected.filter(
                      reference => referenceKey(reference) !== referenceKey(resource)
                    )
                    update({
                      sourceRefs: event.target.checked
                        ? [
                            ...remaining,
                            { kind: resource.kind, id: resource.id, revision: resource.revision },
                          ]
                        : remaining,
                    })
                  }}
                  data-testid="subscription-input-source"
                />
                <span className="min-w-0 break-words">
                  {resource.title} · {t('sourceRevision', { revision: resource.revision })}
                </span>
              </label>
            ))}
            {unavailable && (
              <p role="alert" className="text-sm text-text-muted">
                {t('inputResourceUnavailable')}
              </p>
            )}
          </>
        )}
      </fieldset>
      <label className="block space-y-1 text-sm">
        <span>{t('additionalRequirements')}</span>
        <textarea
          className={fieldClass}
          rows={3}
          value={typeof input.requirements === 'string' ? input.requirements : ''}
          onChange={event => update({ requirements: event.target.value })}
          maxLength={4096}
          data-testid="subscription-input-requirements"
        />
      </label>
    </fieldset>
  )
}
