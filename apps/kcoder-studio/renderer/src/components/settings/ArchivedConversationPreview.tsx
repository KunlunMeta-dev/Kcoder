import { useEffect, useState } from 'react'
import type { ArchivedConversationItem, RuntimeTranscriptResponse } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'

type Api = NonNullable<WorkbenchServices['runtimeWorkApi']>

export function ArchivedConversationPreview({
  item,
  api,
  onClose,
}: {
  item: ArchivedConversationItem
  api: Api
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const [page, setPage] = useState<RuntimeTranscriptResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [cursor, setCursor] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void api
      .getRuntimeTranscript({
        deviceId: item.deviceId,
        workspacePath: item.workspacePath,
        taskId: item.taskId,
        ...(item.threadId ? { threadId: item.threadId } : {}),
        ...(item.runtimeHandle ? { runtimeHandle: item.runtimeHandle } : {}),
        limit: 50,
        includeFullContent: true,
        ...(cursor ? { beforeCursor: cursor } : {}),
      })
      .then(result => {
        if (active)
          setPage(previous =>
            cursor && previous && !result.historyReset
              ? {
                  ...result,
                  messages: [
                    ...result.messages,
                    ...previous.messages.filter(
                      message => !result.messages.some(older => older.id === message.id)
                    ),
                  ],
                }
              : result
          )
      })
      .catch(reason => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, item, cursor, attempt])
  return (
    <section
      data-testid="archived-preview"
      className="mb-4 rounded-xl border border-border bg-surface p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{item.title}</h2>
          <p className="text-xs text-text-muted">{t('workbench.archived_preview_readonly')}</p>
        </div>
        <button
          type="button"
          data-testid="archived-preview-close"
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-sm hover:bg-muted"
        >
          {t('common.close')}
        </button>
      </div>
      {error && (
        <div>
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
          <button
            type="button"
            onClick={() => {
              setLoading(true)
              setError(null)
              setAttempt(value => value + 1)
            }}
            className="rounded-lg px-3 py-2 text-sm hover:bg-muted"
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {loading && <p role="status">{t('common.loading')}</p>}
      {page?.parseError && <p role="alert">{page.parseError}</p>}
      {page?.hasMoreBefore && page.beforeCursor && (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true)
            setError(null)
            setCursor(page.beforeCursor ?? null)
          }}
          className="rounded-lg px-3 py-2 text-sm hover:bg-muted"
        >
          {t('workbench.archived_preview_earlier')}
        </button>
      )}
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {page?.messages.map(message => (
          <article key={message.id} className="rounded-lg bg-muted/50 p-3">
            <div className="mb-1 text-xs text-text-muted">
              {message.role === 'user'
                ? t('workbench.archived_preview_user')
                : message.role === 'assistant'
                  ? t('workbench.archived_preview_assistant')
                  : message.role}
            </div>
            <div className="whitespace-pre-wrap break-words text-sm">{message.content}</div>
          </article>
        ))}
      </div>
    </section>
  )
}
