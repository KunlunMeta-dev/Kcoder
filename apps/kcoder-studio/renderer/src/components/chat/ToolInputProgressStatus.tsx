import { useEffect, useSyncExternalStore } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { toolPathPreviews } from '@/kcoder/toolPathPreview'

export function ToolInputProgressStatus({
  target,
  task,
  embedded = false,
}: {
  target?: string
  task?: string
  embedded?: boolean
}) {
  const { t } = useTranslation()
  useSyncExternalStore(
    toolPathPreviews.subscribe,
    toolPathPreviews.snapshot,
    toolPathPreviews.snapshot
  )
  useEffect(() => {
    if (target && task) return toolPathPreviews.acquire(target, task)
  }, [target, task])
  const items = toolPathPreviews.readInputs(target, task)
  if (!items.length) return null
  return (
    <div
      className={
        embedded
          ? 'min-w-0 py-2 text-sm text-text-secondary'
          : 'mx-auto w-full max-w-3xl px-6 py-3 text-sm text-text-secondary'
      }
      data-testid="tool-input-progress-status"
      role="status"
    >
      {items.slice(0, 3).map(item => (
        <div key={item.id} className="flex min-w-0 items-center gap-2">
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          <span className="truncate">
            {t('chat:tool_input_progress.preparing', { name: item.name })}
          </span>
          <span
            className="shrink-0 text-xs text-text-muted"
            data-testid="tool-input-progress-count"
          >
            {item.lines ? (
              <span title={t('chat:tool_input_progress.line_estimate')}>
                <span className="text-green-600 dark:text-green-400">
                  +{item.lines.generatedLines}
                </span>
                {item.lines.replacedLines !== undefined && (
                  <span className="ml-2 text-red-500">-{item.lines.replacedLines}</span>
                )}
              </span>
            ) : (
              t('chat:tool_input_progress.characters', { count: item.chars })
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
