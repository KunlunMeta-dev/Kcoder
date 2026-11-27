import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgePublication } from '../../../../shared/generated/contracts'
import { formatAutomationTimestamp } from './time'

export function PublicationMetadata({ publication }: { publication: KnowledgePublication }) {
  const { t, i18n } = useTranslation('knowledgeIntegration')
  const format = (value?: number | null) =>
    value == null
      ? t('notSpecified')
      : (formatAutomationTimestamp(value, i18n?.resolvedLanguage || i18n?.language || 'en') ??
        t('unknown'))
  const knownRoles = [
    'personal_owner',
    'authorized_project_publisher',
    'authorized_department_publisher',
    'authorized_organization_publisher',
  ]
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2" data-testid="publication-metadata">
      <div className="sm:col-span-2">
        <dt className="text-text-muted">{t('publicationPurpose')}</dt>
        <dd className="whitespace-pre-wrap">{publication.draft.purpose || t('notSpecified')}</dd>
      </div>
      <div>
        <dt className="text-text-muted">{t('publisherRole')}</dt>
        <dd>
          {publication.publisherRole && knownRoles.includes(publication.publisherRole)
            ? t(`publisherRoles.${publication.publisherRole}`)
            : t('unknown')}
        </dd>
      </div>
      <div>
        <dt className="text-text-muted">{t('publishedAt')}</dt>
        <dd>{format(publication.publishedAtMs)}</dd>
      </div>
      <div>
        <dt className="text-text-muted">{t('validFrom')}</dt>
        <dd>{format(publication.draft.validFromMs)}</dd>
      </div>
      <div>
        <dt className="text-text-muted">{t('validUntil')}</dt>
        <dd>{format(publication.draft.validUntilMs)}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-text-muted">{t('publisherReviewNote')}</dt>
        <dd className="whitespace-pre-wrap">
          {publication.draft.reviewConclusion || t('notSpecified')}
        </dd>
        <p className="mt-1 text-xs text-text-muted">{t('publisherReviewHint')}</p>
      </div>
      {publication.draft.unresolved.length > 0 && (
        <div className="sm:col-span-2">
          <dt className="text-text-muted">{t('unresolvedItems')}</dt>
          <dd>
            <ul className="list-disc pl-5">
              {publication.draft.unresolved.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  )
}
