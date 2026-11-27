import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { KnowledgeOperationError } from './client'
export const fieldClass =
  'w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 disabled:opacity-40'
export function OperationError({
  error,
  onInspect,
}: {
  error?: KnowledgeOperationError
  onInspect?: () => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  if (!error) return null
  const key = error.uncertain
    ? 'uncertain'
    : error.code === 'INTEGRATION_TARGET_UPGRADE_REQUIRED'
      ? 'targetUnsupported'
      : ['KNOWLEDGE_NATIVE_FEATURE_UNAVAILABLE', 'AUTOMATION_NATIVE_FEATURE_UNAVAILABLE'].includes(
            error.code
          )
        ? 'featureUnavailable'
        : error.code === 'KNOWLEDGE_AUTHENTICATION_REQUIRED'
          ? 'authenticationRequired'
          : error.code === 'KNOWLEDGE_CONNECTION_UNAVAILABLE'
            ? 'connectionUnavailable'
            : error.code === 'KNOWLEDGE_CALLER_SCOPE_MISMATCH'
              ? 'ownerChanged'
              : error.code === 'KNOWLEDGE_POLICY_UNAVAILABLE'
                ? 'permissionUnavailable'
                : error.code === 'KNOWLEDGE_PUBLICATION_REVOKED'
                  ? 'publicationRevoked'
                  : error.code === 'KNOWLEDGE_PUBLICATION_EXPIRED'
                    ? 'publicationExpired'
                    : error.code === 'KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE'
                      ? 'publicationNotEffective'
                      : error.code.includes('DENIED')
                        ? 'permissionDenied'
                        : error.code.includes('TOO_LARGE')
                          ? 'contentTooLarge'
                          : error.code.includes('REVISION')
                            ? 'conflict'
                            : [
                                  'KNOWLEDGE_OWNER_CHANGED',
                                  'INTEGRATION_OWNER_CHANGED',
                                  'INTEGRATION_TARGET_REQUIRED',
                                ].includes(error.code)
                              ? 'ownerChanged'
                              : 'operationFailed'
  return (
    <div
      role="alert"
      className="studio-card-spacing rounded-xl border border-destructive/20 bg-destructive/5 text-sm text-destructive"
      data-testid="knowledge-operation-error"
    >
      {t(key)}
      {error.uncertain && onInspect && (
        <Button
          type="button"
          variant="outline"
          className="ml-2"
          onClick={onInspect}
          data-testid="knowledge-inspect-operation"
        >
          {t('inspectOperation')}
        </Button>
      )}
      {error.operationId && (
        <details className="mt-2 text-text-secondary">
          <summary>{t('source')}</summary>
          <code className="break-all">{error.operationId}</code>
        </details>
      )}
    </div>
  )
}
export function PageActions({
  page,
  pending,
  hasPrevious,
  hasNext,
  previous,
  next,
  refresh,
}: {
  page: number
  pending: boolean
  hasPrevious: boolean
  hasNext: boolean
  previous: () => void
  next: () => void
  refresh: () => void
}) {
  const { t } = useTranslation('knowledgeIntegration')
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="knowledge-pagination">
      <p className="mr-auto text-sm text-text-muted">{t('page', { page })}</p>
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 md:min-h-0"
        disabled={pending}
        onClick={refresh}
        data-testid="knowledge-refresh"
      >
        {t('refresh')}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 md:min-h-0"
        disabled={pending || !hasPrevious}
        onClick={previous}
        data-testid="knowledge-page-previous"
      >
        {t('previous')}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 md:min-h-0"
        disabled={pending || !hasNext}
        onClick={next}
        data-testid="knowledge-page-next"
      >
        {t('next')}
      </Button>
    </div>
  )
}
