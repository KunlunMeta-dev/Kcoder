import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { argumentFields, parseArguments } from './workflowArguments'

export function WorkflowArguments({
  schema,
  value,
  onChange,
}: {
  schema: unknown
  value: string
  onChange: (text: string) => void
}) {
  const { t } = useTranslation('common')
  const [advanced, setAdvanced] = useState(false)
  const fields = argumentFields(schema)
  const parsed = parseArguments(value)
  const showJson = advanced || !fields || !parsed
  const change = (name: string, next: unknown) => {
    if (!parsed) return
    const entries = Object.entries(parsed).filter(([key]) => key !== name)
    if (next !== undefined) entries.push([name, next])
    onChange(JSON.stringify(Object.fromEntries(entries), null, 2))
  }
  const control = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'
  return (
    <div className="space-y-3" data-testid="workflow-arguments">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('workflowReuse.parameters')}</span>
        {fields && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={showJson && !parsed}
            onClick={() => setAdvanced(!advanced)}
          >
            {t(showJson ? 'workflowReuse.formMode' : 'workflowReuse.jsonMode')}
          </Button>
        )}
      </div>
      {showJson ? (
        <label className="block text-sm">
          {t('workflowReuse.args')}
          <textarea
            data-testid="workflow-reuse-args"
            value={value}
            onChange={event => onChange(event.target.value)}
            rows={4}
            maxLength={32768}
            className="mt-2 w-full rounded-lg border border-border bg-background p-3 text-code"
          />
          {!fields && (
            <span className="mt-1 block text-xs text-text-muted">
              {t('workflowReuse.complexSchema')}
            </span>
          )}
        </label>
      ) : (
        fields.map(field => {
          const present = Object.hasOwn(parsed!, field.name)
          const current = parsed![field.name]
          const choices = field.enum ?? (field.type === 'boolean' ? [true, false] : null)
          return (
            <label key={field.name} className="block space-y-1 text-sm">
              <span>
                {field.title}{' '}
                <span className="text-xs text-text-muted">
                  {t(
                    field.required ? 'workflowReuse.requiredLabel' : 'workflowReuse.optionalLabel'
                  )}
                </span>
              </span>
              {choices ? (
                <select
                  className={control}
                  aria-required={field.required}
                  data-testid={`workflow-arg-${field.name}`}
                  value={present ? String(choices.findIndex(item => item === current)) : ''}
                  onChange={event =>
                    change(
                      field.name,
                      event.target.value === '' ? undefined : choices[Number(event.target.value)]
                    )
                  }
                >
                  <option value="">{t('workflowReuse.unset')}</option>
                  {present && !choices.includes(current as never) && (
                    <option value="-1">{String(current)}</option>
                  )}
                  {choices.map((choice, index) => (
                    <option key={index} value={index}>
                      {typeof choice === 'boolean'
                        ? t(choice ? 'workflowReuse.yes' : 'workflowReuse.no')
                        : String(choice)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={control}
                  aria-required={field.required}
                  data-testid={`workflow-arg-${field.name}`}
                  inputMode={field.type === 'string' ? 'text' : 'decimal'}
                  value={present ? String(current) : ''}
                  onChange={event => {
                    const text = event.target.value
                    change(
                      field.name,
                      text === ''
                        ? undefined
                        : field.type === 'string'
                          ? text
                          : text.trim() && Number.isFinite(Number(text))
                            ? Number(text)
                            : text
                    )
                  }}
                />
              )}
              {field.description && (
                <span className="block text-xs text-text-muted">{field.description}</span>
              )}
            </label>
          )
        })
      )}
      {schema != null && (
        <details className="text-xs text-text-muted">
          <summary className="cursor-pointer">{t('workflowReuse.schemaDetails')}</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(schema, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
