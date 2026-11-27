import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import { mcpPrivateFieldKey } from '@/kcoder/migrationMcpFields'
import type { MigrationMcpPrivateField } from '../../../../shared/generated/contracts'

export function MigrationMcpPrivateFieldPicker(props: {
  fields: MigrationMcpPrivateField[]
  selected: MigrationMcpPrivateField[]
  consent: boolean
  disabled: boolean
  onFields: (fields: MigrationMcpPrivateField[]) => void
  onConsent: (consent: boolean) => void
}) {
  const { t } = useTranslation('migration')
  const selected = new Set(props.selected.map(mcpPrivateFieldKey))
  return (
    <>
      <fieldset disabled={props.disabled}>
        <legend className="mb-2 text-sm font-medium">{t('mcp_credential.fields')}</legend>
        {props.fields.length > 1 && (
          <div className="mb-1 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => props.onFields(props.fields)}>
              {t('mcp_credential.select_all')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!props.selected.length}
              onClick={() => props.onFields([])}
            >
              {t('mcp_credential.select_none')}
            </Button>
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          {props.fields.map(field => (
            <label
              key={mcpPrivateFieldKey(field)}
              className="flex min-h-11 items-start gap-2 py-2 text-sm"
            >
              <Checkbox
                className="mt-1"
                checked={selected.has(mcpPrivateFieldKey(field))}
                onChange={event =>
                  props.onFields(
                    props.fields.filter(candidate =>
                      mcpPrivateFieldKey(candidate) === mcpPrivateFieldKey(field)
                        ? event.target.checked
                        : selected.has(mcpPrivateFieldKey(candidate))
                    )
                  )
                }
              />
              <span className="min-w-0 break-words">
                {t(`mcp_credential.${field.kind}`)} ·{' '}
                <span className="font-mono">{field.name}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {!props.fields.length && (
        <p className="text-sm text-text-secondary">{t('mcp_credential.no_fields')}</p>
      )}
      <p className="text-xs text-text-secondary">
        {t('mcp_credential.selected', { count: props.selected.length, total: props.fields.length })}
      </p>
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <Checkbox
          className="mt-1"
          disabled={props.disabled || !props.selected.length}
          checked={props.consent}
          onChange={event => props.onConsent(event.target.checked)}
        />
        {t('mcp_credential.consent')}
      </label>
    </>
  )
}
