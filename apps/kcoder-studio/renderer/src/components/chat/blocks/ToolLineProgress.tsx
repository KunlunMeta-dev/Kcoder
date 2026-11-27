import { useCallback, useContext, useSyncExternalStore } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { toolPathPreviews } from '@/kcoder/toolPathPreview'
import { ToolProgressScopeContext } from '@/kcoder/toolsCatalogContext'
import type { WorkbenchGeneratedLineProgress } from '@wegent/chat-core'

const noSubscribe = () => () => {}
const noProgress = () => null

export function ToolLineProgress({
  id,
  running,
  generatedLineProgress,
}: {
  id: string
  running: boolean
  generatedLineProgress?: WorkbenchGeneratedLineProgress
}) {
  const { t } = useTranslation('chat')
  const { target, task } = useContext(ToolProgressScopeContext)
  const subscribe = useCallback((listener: () => void) =>
    toolPathPreviews.subscribe(listener, target, task, id), [target, task, id])
  const read = useCallback(() => {
    const progress = toolPathPreviews.readToolLines(target, task, id)
    const observed = progress?.observed
    const unavailable =
      observed &&
      ((observed.partial && observed.files === 0) ||
        (observed.files > 0 && observed.binaryFiles === observed.files))
    return (!unavailable ? observed : null) ?? (running ? progress?.generated : null) ?? null
  }, [target, task, id, running])
  const active = Boolean(target && task)
  const scopedProgress = useSyncExternalStore(
    active ? subscribe : noSubscribe,
    active ? read : noProgress,
    noProgress
  )
  const progress =
    scopedProgress && 'additions' in scopedProgress
      ? scopedProgress
      : running && generatedLineProgress
        ? generatedLineProgress
        : scopedProgress
  const observed = progress && 'additions' in progress ? progress : undefined
  const generated = progress && 'generatedLines' in progress ? progress : undefined
  if (!observed && !generated) return null
  const additions = observed?.additions ?? generated!.generatedLines
  const deletions = observed?.deletions ?? generated?.replacedLines
  const partial = observed && (observed.partial || observed.binaryFiles > 0)
  const description = observed
    ? t('tool_input_progress.tool_observed_description')
    : t('tool_input_progress.line_estimate')
  return (
    <span
      className="inline-flex shrink-0 items-center gap-2 text-xs tabular-nums"
      data-testid="tool-line-progress"
      data-tool-id={id}
      title={`${description}${partial ? ` ${t('tool_input_progress.partial')}` : ''}`}
    >
      <span className="text-green-600 dark:text-green-400">+{additions}</span>
      {deletions !== undefined && <span className="text-red-500">-{deletions}</span>}
      {partial && (
        <span className="text-text-muted" aria-label={t('tool_input_progress.partial')}>
          *
        </span>
      )}
    </span>
  )
}
