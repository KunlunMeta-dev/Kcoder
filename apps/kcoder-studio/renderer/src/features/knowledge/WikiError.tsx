import { useTranslation } from '@/hooks/useTranslation'

/** Keep the first line localized and actionable; diagnostics remain expandable. */
export function WikiError({ error }: { error: string }) {
  const { t } = useTranslation('knowledge')
  const key = /requires.*vision/i.test(error) ? 'errorVision'
    : /dimensions are too small/i.test(error) ? 'errorImageSmall'
    : /unsupported_format|legacy|encrypted/i.test(error) ? 'errorFormat'
    : /retrieval.*disabled/i.test(error)
    ? 'retrievalDisabled'
    : /organization.*disabled/i.test(error)
      ? 'organizationDisabled'
      : /revision conflict|idempotency conflict/i.test(error)
        ? 'errorConflict'
        : /needs_vision|no extractable text/i.test(error)
          ? 'errorNeedsText'
          : /encoding|UTF-16|UTF-8/i.test(error)
            ? 'errorEncoding'
            : /exceeds|too large|size out of range|MiB/i.test(error)
              ? 'errorSize'
              : /disabled/i.test(error)
                ? 'disabled'
                : /not found|removed|archived/i.test(error)
                  ? 'errorUnavailable'
                  : 'errorRequest'
  return (
    <div
      role="alert"
      className="my-3 rounded-lg bg-destructive/5 px-3 py-2 text-sm text-destructive [overflow-wrap:anywhere]"
    >
      <p>{t(key)}</p>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-text-muted">{t('errorDetails')}</summary>
        <pre className="mt-2 whitespace-pre-wrap text-text-secondary">{error}</pre>
      </details>
    </div>
  )
}
