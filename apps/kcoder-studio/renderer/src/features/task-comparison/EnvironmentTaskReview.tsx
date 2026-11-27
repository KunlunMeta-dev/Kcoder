import { SettingsSelect } from '@/components/settings/SettingsSelect'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isActiveToolCallStatus } from '@wegent/chat-core'
import { TaskReviewPanel } from '@/components/chat/TaskReviewPanel'
import { createTaskDeliveryDrafts } from './taskDeliveryDrafts'
import { taskReviewFacts } from '@/components/chat/taskReview'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchMessage } from '@/types/workbench'
import type { WorkspaceFileOpenOptions } from '@/types/workspace-files'
import type { TaskReviewOperationsContext } from './TaskReviewOperations'

export interface EnvironmentTaskReviewProps {
  open: boolean
  onClose: () => void
  ownerScope: string
  messages: WorkbenchMessage[]
  taskOperations?: TaskReviewOperationsContext
  onAddToDraft?: (text: string) => void
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onLoadFullTranscript?: () => Promise<void> | void
  loadingFullTranscript?: boolean
  hasMoreBefore?: boolean
  onLoadMoreBefore?: () => Promise<void> | void
  loadingMoreBefore?: boolean
}

function entriesFor(messages: WorkbenchMessage[], taskId?: string) {
  let requirement = ''
  const entries: { key: string; message: WorkbenchMessage; requirement: string }[] = []
  for (const message of messages) {
    if (taskId && message.taskId && message.taskId !== taskId) continue
    if (message.role === 'user') { requirement = message.content; continue }
    if (message.role !== 'assistant') continue
    const terminal = message.status === 'failed' || message.status === 'unknown' || message.runtimeStatus === 'cancelled'
    const running = !terminal && (message.status === 'pending' || message.status === 'streaming'
      || message.blocks?.some(block => isActiveToolCallStatus(block.status)))
    if (running) continue
    entries.push({ key: JSON.stringify([message.id, message.turnId, message.attemptId]), message, requirement })
  }
  return entries
}

type ResponseIdentity = { messageId: string; turnId: string | null; attemptId: string | null }
function responseIdentity(message: WorkbenchMessage): ResponseIdentity {
  return { messageId: message.id, turnId: message.turnId || null, attemptId: message.attemptId || null }
}
function selectedEntry(entries: ReturnType<typeof entriesFor>, identity: ResponseIdentity | null) {
  if (!identity) return undefined
  const exact = entries.filter(entry => entry.message.id === identity.messageId)
  if (exact.length) {
    if (exact.length !== 1) return undefined
    const message = exact[0].message
    if ((identity.turnId && message.turnId !== identity.turnId)
      || (identity.attemptId && message.attemptId !== identity.attemptId)) return undefined
    return exact[0]
  }
  if (!identity.turnId || !identity.attemptId) return undefined
  const native = entries.filter(entry => entry.message.turnId === identity.turnId && entry.message.attemptId === identity.attemptId)
  return native.length === 1 ? native[0] : undefined
}

/** The shell owns visibility; this sibling dialog survives its opener's popover closing. */
export function EnvironmentTaskReview(props: EnvironmentTaskReviewProps) {
  const [drafts] = useState(createTaskDeliveryDrafts)
  if (!props.open) return null
  return <OwnedTaskReview key={props.ownerScope} {...props} retainedDrafts={drafts} />
}

function OwnedTaskReview(props: EnvironmentTaskReviewProps & { retainedDrafts: ReturnType<typeof createTaskDeliveryDrafts> }) {
  const { t } = useTranslation('taskComparison')
  const entries = useMemo(() => entriesFor(props.messages, props.taskOperations?.owner.taskId),
    [props.messages, props.taskOperations?.owner.taskId])
  const [identity, setIdentity] = useState<ResponseIdentity | null>(() => {
    const latest = entries.at(-1)
    return latest ? responseIdentity(latest.message) : null
  })
  const [loadFailed, setLoadFailed] = useState(false)
  const alive = useRef(true)
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const selected = selectedEntry(entries, identity)
  if (!identity && entries.length) {
    setIdentity(responseIdentity(entries[entries.length - 1].message))
  } else if (identity && selected) {
    const resolved = responseIdentity(selected.message)
    // Retain enriched Native identity before another hydration or attempt can
    // change it. This guarded adjustment settles before React commits the view.
    if (identity.messageId !== resolved.messageId || identity.turnId !== resolved.turnId || identity.attemptId !== resolved.attemptId)
      setIdentity(resolved)
  }
  const message = selected?.message
  const nativeUnique = message?.turnId && message.attemptId
    ? entries.filter(entry => entry.message.turnId === message.turnId && entry.message.attemptId === message.attemptId).length === 1 : false
  const messageId = message?.id, turnId = message?.turnId, attemptId = message?.attemptId
  const taskOperations = props.taskOperations && messageId ? {
    ...props.taskOperations,
    deliveryDrafts: props.retainedDrafts.forResponse(props.ownerScope,
      { messageId, turnId: turnId || null, attemptId: attemptId || null }, nativeUnique),
    deliveryResponseKey: 'bound-response',
  } : props.taskOperations

  const current = () => alive.current && (props.taskOperations?.isCurrent() ?? true)
  const load = async (action?: () => Promise<void> | void) => {
    if (!action || !current()) return
    setLoadFailed(false)
    try { await action() }
    catch { if (current()) setLoadFailed(true) }
  }
  return (
    <ModalDialog title={t('reviewDialog.title')} testId="environment-task-review-dialog" wide
      onClose={props.onClose} closeLabel={t('reviewDialog.close')} className="min-h-0 overflow-hidden">
      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
        <div className="shrink-0 space-y-2">
          <label className="block space-y-1 text-sm">
            <span>{t('reviewDialog.response')}</span>
            <SettingsSelect data-testid="environment-task-review-turn-select" aria-label={t('reviewDialog.response')}
              className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-text-primary md:min-h-8"
              value={selected?.key ?? ''} onChange={event => {
                const entry = entries.find(item => item.key === event.target.value)
                if (entry) setIdentity(responseIdentity(entry.message))
              }}>
              {!selected && <option value="">{t(entries.length ? 'reviewDialog.unavailable' : 'reviewDialog.empty')}</option>}
              {entries.map((entry, index) => <option key={entry.key} value={entry.key}
                data-message-id={entry.message.id} data-turn-id={entry.message.turnId ?? undefined}>
                {t('reviewDialog.responseOption', { index: index + 1, requirement: entry.requirement.trim().replace(/\s+/g, ' ').slice(0, 90) || t('reviewDialog.missingRequirement') })}
              </option>)}
            </SettingsSelect>
          </label>
          <div className="flex flex-wrap gap-2">
            {props.hasMoreBefore && props.onLoadMoreBefore && <Button variant="ghost" size="sm"
              className="min-h-11 md:min-h-8" data-testid="environment-task-review-load-more"
              disabled={props.loadingMoreBefore} onClick={() => void load(props.onLoadMoreBefore)}>
              {t(props.loadingMoreBefore ? 'reviewDialog.loading' : 'reviewDialog.earlier')}
            </Button>}
            {props.onLoadFullTranscript && <Button variant="ghost" size="sm"
              className="min-h-11 md:min-h-8" data-testid="environment-task-review-load-full"
              disabled={props.loadingFullTranscript} onClick={() => void load(props.onLoadFullTranscript)}>
              {t(props.loadingFullTranscript ? 'reviewDialog.loading' : 'reviewDialog.fullContent')}
            </Button>}
          </div>
          {loadFailed && <p role="alert" className="text-sm text-text-secondary">{t('reviewDialog.loadFailed')}</p>}
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pr-1"
          data-testid="environment-task-review-scroll">
          {selected ? <div key={selected.message.id} data-testid="environment-task-review-result"
            data-message-id={selected.message.id} data-turn-id={selected.message.turnId ?? undefined}
            data-attempt-id={selected.message.attemptId}>
            <p className="whitespace-pre-wrap break-words text-sm text-text-secondary" data-testid="environment-task-review-requirement">
              {selected.requirement || t('reviewDialog.missingRequirement')}
            </p>
            <TaskReviewPanel message={selected.message} requirement={selected.requirement}
              taskOperations={taskOperations}
              onAddToDraft={props.onAddToDraft ? text => { if (current()) props.onAddToDraft?.(text) } : undefined}
              onOpenFile={props.onOpenFile ? (path, options) => { if (current()) props.onOpenFile?.(path, options) } : undefined}
              onLoadFullTranscript={props.onLoadFullTranscript ? () => load(props.onLoadFullTranscript) : undefined}
              loadingFullTranscript={props.loadingFullTranscript} />
            {!taskReviewFacts(selected.message).visible && !props.taskOperations &&
              <p className="mt-3 text-sm text-text-muted">{t('reviewDialog.noEvidence')}</p>}
          </div> : <p role="status" className="py-3 text-sm text-text-secondary">
            {t(entries.length ? 'reviewDialog.unavailable' : 'reviewDialog.empty')}
          </p>}
        </div>
      </div>
    </ModalDialog>
  )
}
