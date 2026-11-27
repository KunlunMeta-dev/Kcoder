import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

/** Keep the first line localized and actionable; diagnostics remain expandable. */
export function WikiError({
  error,
  summary,
  onReload,
  reloading = false,
}: {
  error: string
  summary?: string
  onReload?: () => void
  reloading?: boolean
}) {
  const { t } = useTranslation('knowledge')
  const key = /requires.*vision/i.test(error)
    ? 'errorVision'
    : /dimensions are too small/i.test(error)
      ? 'errorImageSmall'
      : /unsupported_format|legacy|encrypted/i.test(error)
        ? 'errorFormat'
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
  const statusKey = /knowledge service is busy|KNOWLEDGE_RPC_BUSY|Wiki archive service is busy/i.test(error)
    ? 'errorBusy'
    : /ECONNREFUSED|ECONNRESET|ETIMEDOUT|WebSocket.*(?:closed|failed)|连接(?:已断开|失败)|无法连接/i.test(error)
      ? 'errorConnection'
      : key
  return (
    <div
      role="alert"
      className="my-3 rounded-lg bg-destructive/5 px-3 py-2 text-sm text-destructive [overflow-wrap:anywhere]"
    >
      <div className="flex items-start justify-between gap-3">
        <p>{summary ?? t(statusKey)}</p>
        {onReload && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 max-md:min-h-11"
            disabled={reloading}
            onClick={onReload}
          >
            {t('reload')}
          </Button>
        )}
      </div>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-text-muted">{t('errorDetails')}</summary>
        <pre className="mt-2 whitespace-pre-wrap text-text-secondary">{error}</pre>
      </details>
    </div>
  )
}
