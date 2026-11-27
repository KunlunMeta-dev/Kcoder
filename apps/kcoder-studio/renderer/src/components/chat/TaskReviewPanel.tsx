import {
  TaskReviewOperations,
  type TaskReviewOperationsContext,
} from '@/features/task-comparison/TaskReviewOperations'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import { NativeReviewEvidence } from './NativeReviewEvidence'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchMessage } from '@/types/workbench'
import { ToolBlocksDisplay } from './blocks/ToolBlocksDisplay'
import { taskFeedbackContext, taskReviewFacts } from './taskReview'
import { TaskCaptureObservation } from './TaskCaptureObservation'

const PAGE_SIZE = 10

function ReviewPages({
  page,
  lastPage,
  onChange,
  label,
  testIdPrefix,
}: {
  page: number
  lastPage: number
  onChange: (page: number) => void
  label: string
  testIdPrefix: string
}) {
  const { t } = useTranslation('chat')
  if (lastPage === 0) return null
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 md:min-h-8"
        data-testid={`${testIdPrefix}-previous`}
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        {t('taskReview.previous')}
      </Button>
      <span>{t('taskReview.page', { page: page + 1, total: lastPage + 1 })}</span>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 md:min-h-8"
        data-testid={`${testIdPrefix}-next`}
        disabled={page === lastPage}
        onClick={() => onChange(page + 1)}
      >
        {t('taskReview.next')}
      </Button>
    </nav>
  )
}

export function TaskReviewPanel({
  message,
  onAddToDraft,
  onOpenFile,
  onLoadFullTranscript,
  loadingFullTranscript,
  taskOperations,
  requirement = '',
}: {
  message: WorkbenchMessage
  onAddToDraft?: (text: string) => void
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onLoadFullTranscript?: () => Promise<void> | void
  loadingFullTranscript?: boolean
  taskOperations?: TaskReviewOperationsContext
  requirement?: string
}) {
  const { t } = useTranslation('chat')
  const [page, setPage] = useState(0)
  const [filePage, setFilePage] = useState(0)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const facts = taskReviewFacts(message)
  if (!facts.visible)
    return taskOperations ? (
      <TaskReviewOperations context={taskOperations} message={message} requirement={requirement} />
    ) : null
  const lastPage = Math.max(0, Math.ceil(facts.commands.length / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  const commands = facts.commands.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const lastFilePage = Math.max(0, Math.ceil(facts.previewFiles.length / PAGE_SIZE) - 1)
  const currentFilePage = Math.min(filePage, lastFilePage)
  const files = facts.previewFiles.slice(
    currentFilePage * PAGE_SIZE,
    (currentFilePage + 1) * PAGE_SIZE
  )
  const failed = facts.commands.filter(block => block.status === 'error').length
  const unknown = facts.commands.filter(
    block => block.status === 'unknown' || block.toolOutput === undefined
  ).length

  return (
    <section
      aria-label={t('taskReview.title')}
      className="mt-3 min-w-0 space-y-2 text-sm text-text-secondary"
      data-testid="task-review-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{t('taskReview.title')}</span>
        {onAddToDraft && (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-8"
            data-testid="task-review-feedback"
            onClick={() =>
              onAddToDraft(
                `${t('taskReview.feedbackContext')}\n\n${taskFeedbackContext(message)}\n\n${t('taskReview.feedbackPrompt')}`
              )
            }
          >
            {t('taskReview.requestChanges')}
          </Button>
        )}
      </div>
      {onOpenFile && files.length > 0 && (
        <div className="min-w-0 space-y-1" data-testid="task-review-files">
          <p>{t('taskReview.relatedFiles', { count: facts.previewFiles.length })}</p>
          <ul className="min-w-0">
            {files.map(path => (
              <li key={path} className="min-w-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-h-11 max-w-full justify-start md:min-h-8"
                  data-testid="task-review-open-file"
                  title={path}
                  onClick={() => onOpenFile(path)}
                >
                  <span className="truncate">{path}</span>
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-text-muted">{t('taskReview.currentFileScope')}</p>
          <ReviewPages
            page={currentFilePage}
            lastPage={lastFilePage}
            onChange={setFilePage}
            label={t('taskReview.filePages')}
            testIdPrefix="task-review-files"
          />
        </div>
      )}
      {facts.review ? (
        <NativeReviewEvidence
          evidence={facts.review}
          onOpenFile={onOpenFile}
          onAddToDraft={onAddToDraft}
        />
      ) : (
        <p data-testid="task-review-unverified">{t('reviewEvidence.unverified')}</p>
      )}
      {facts.capture && <TaskCaptureObservation capture={facts.capture} />}
      {failed > 0 && (
        <p role="status" data-testid="task-review-failed">
          {t('taskReview.failedCommands', { count: failed })}
        </p>
      )}
      {unknown > 0 && (
        <p role="status" data-testid="task-review-unknown">
          {t('taskReview.unknownCommands', { count: unknown })}
        </p>
      )}
      {facts.commands.length === 0 ? (
        <p data-testid="task-review-no-evidence">{t('taskReview.noCommands')}</p>
      ) : (
        <details
          data-testid="task-review-evidence"
          onToggle={event => setEvidenceOpen(event.currentTarget.open)}
        >
          <summary className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 md:min-h-8 md:py-1">
            {t('taskReview.commands', { count: facts.commands.length })}
          </summary>
          {evidenceOpen && (
            <div className="mt-2 min-w-0 space-y-3">
              <p>{t('taskReview.evidenceScope')}</p>
              <ToolBlocksDisplay
                blocks={commands}
                isStreaming={false}
                forceExpanded
                showSummary={false}
                onLoadFullTranscript={onLoadFullTranscript}
                loadingFullTranscript={loadingFullTranscript}
              />
              <ReviewPages
                page={currentPage}
                lastPage={lastPage}
                onChange={setPage}
                label={t('taskReview.evidencePages')}
                testIdPrefix="task-review"
              />
            </div>
          )}
        </details>
      )}
      {onAddToDraft && <p className="text-xs text-text-muted">{t('taskReview.draftOnly')}</p>}
      {taskOperations && (
        <TaskReviewOperations
          context={taskOperations}
          message={message}
          requirement={requirement}
        />
      )}
    </section>
  )
}
