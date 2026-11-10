import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { KnowledgeIntegrationClient } from './client'
import type { SavedBusinessInputResource } from './BusinessTemplateInputs'
import { listAdoptedPublicationInputs } from './adopted-publication-inputs'
import { OperationError, PageActions } from './shared'
import { useDomainPage } from './useDomainPage'

export function AdoptedPublicationInputs({
  client,
  selected,
  disabled,
  onChange,
  showRevision = true,
}: {
  showRevision?: boolean
  client: KnowledgeIntegrationClient
  selected: Array<{ kind: string; id: string; revision: string }>
  disabled: boolean
  onChange: (values: Array<{ kind: string; id: string; revision: string }>) => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  const page = useDomainPage(client.ownerKey, (after, signal) =>
    listAdoptedPublicationInputs(client, after, signal)
  )
  const same = (
    left: { kind: string; id: string; revision: string },
    right: SavedBusinessInputResource
  ) => left.kind === right.kind && left.id === right.id && left.revision === right.revision
  return (
    <div
      className="studio-card-spacing workbench-card space-y-3"
      data-testid="adopted-template-inputs"
      aria-busy={page.pending}
    >
      <p className="text-sm text-text-secondary">{t('adoptedTemplateInputsHint')}</p>
      {page.pending ? (
        <p role="status" className="text-sm text-text-muted">
          {t('loading')}
        </p>
      ) : (
        page.items.map(({ reference, available }) => (
          <label
            className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm hover:bg-muted"
            key={`${reference.id}@${reference.revision}`}
            data-testid="adopted-template-input-row"
          >
            <Checkbox
              data-testid="subscription-input-source"
              disabled={
                disabled ||
                !available ||
                (selected.length >= 16 && !selected.some(value => same(value, reference)))
              }
              checked={selected.some(value => same(value, reference))}
              onChange={event => {
                const rest = selected.filter(value => !same(value, reference))
                onChange(
                  event.target.checked
                    ? [
                        ...rest,
                        { kind: reference.kind, id: reference.id, revision: reference.revision },
                      ]
                    : rest
                )
              }}
            />
            <span className="min-w-0 break-words">
              {available ? reference.title : t('adoptedTemplateInputUnavailable')}
              {showRevision && <> · {t('sourceRevision', { revision: reference.revision })}</>}
            </span>
          </label>
        ))
      )}
      {!page.pending && !page.error && page.items.length === 0 && (
        <p className="text-sm text-text-muted">{t('noAdoptedTemplateInputs')}</p>
      )}
      <p className="text-sm text-text-muted" data-testid="template-selected-source-count">
        {t('templateSourceCount', { count: selected.length })}
      </p>
      {selected.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          data-testid="template-clear-sources"
          onClick={() => onChange([])}
        >
          {t('clearTemplateSources')}
        </Button>
      )}
      <OperationError error={page.error} />
      <PageActions {...page} />
    </div>
  )
}
